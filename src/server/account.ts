import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountUpdate, AccountUser, SessionResponse } from '../shared/account.ts';
import type { AccountStore } from './account-store.ts';
import type { Analytics } from './analytics.ts';

const accountUpdate = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    onboardingCompleted: z.boolean().optional(),
    usageData: z.boolean().optional(),
  })
  .strict();

export function createAccountSession(options: {
  accounts: AccountStore;
  origin: string;
  localUser: AccountUser;
  developerIds?: ReadonlySet<string>;
  analytics?: Analytics;
  start?(ownerId: string, name?: string): Promise<void>;
}) {
  const origin = new URL(options.origin).origin;
  const user = options.localUser;
  const owner = user.id;
  let accountVersion = 0;
  let pending: Promise<unknown> | undefined;
  async function readAccount() {
    for (;;) {
      await pending?.catch(() => {});
      const version = accountVersion;
      const account = await options.accounts.read(owner);
      const consent = await options.accounts.readConsent(owner);
      if (accountVersion !== version || pending) continue;
      options.analytics?.setUsageData(owner, consent.enabled, consent.revision);
      return { ...account, usageData: consent.enabled };
    }
  }
  async function updateAccount(input: AccountUpdate) {
    const version = ++accountVersion;
    if (input.usageData === false) options.analytics?.setUsageData(owner, false);
    const update = (pending ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const account = await options.accounts.update(owner, input);
        const consent = await options.accounts.readConsent(owner);
        if (accountVersion === version)
          options.analytics?.setUsageData(owner, consent.enabled, consent.revision);
        return { ...account, usageData: consent.enabled };
      });
    pending = update;
    return update.finally(() => {
      if (pending === update) pending = undefined;
    });
  }
  async function response(): Promise<SessionResponse> {
    const account = await readAccount();
    return {
      user: { ...user, name: account.displayName ?? user.name },
      settings: {
        theme: account.theme,
        onboardingCompleted: account.onboardingCompleted,
        usageData: account.usageData,
      },
      capabilities: { developer: Boolean(options.developerIds?.has(owner)) },
      ...(options.analytics ? { analytics: options.analytics.configuration(owner) } : {}),
    };
  }
  function guard(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      reply.code(403).send({ error: 'This origin is not permitted.' });
      return false;
    }
    const expected = request.headers['x-otto-account'];
    if (expected !== undefined && expected !== owner) {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return false;
    }
    return true;
  }
  async function start(reply: FastifyReply, complete?: () => Promise<unknown>) {
    try {
      await options.start?.(owner, (await options.accounts.read(owner)).displayName?.slice(0, 100));
      await complete?.();
      return true;
    } catch {
      reply.code(503).send({ error: 'Setup could not be completed. Try again.' });
      return false;
    }
  }
  function register(app: FastifyInstance) {
    app.get('/api/session', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return response();
    });
    app.post('/api/account/prepare', async (request, reply) => {
      if (!guard(request, reply)) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
    app.patch('/api/account', async (request, reply) => {
      if (!guard(request, reply)) return;
      const input = accountUpdate.parse(request.body);
      let onboardingCompletedNow = false;
      if (input.onboardingCompleted) {
        if (
          !(await start(reply, async () => {
            const account = await updateAccount(input);
            onboardingCompletedNow = account.onboardingCompletedNow === true;
          }))
        )
          return;
      } else await updateAccount(input);
      if (onboardingCompletedNow)
        options.analytics?.capture(owner, { event: 'otto_onboarding_completed' });
      if (input.theme !== undefined)
        options.analytics?.capture(owner, {
          event: 'otto_settings_updated',
          properties: { section: 'account', operation: 'update' },
        });
      reply.header('cache-control', 'no-store');
      return response();
    });
    app.post('/api/account/welcome', async (request, reply) => {
      if (!guard(request, reply)) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!(await options.accounts.read(owner)).onboardingCompleted)
        return reply.code(409).send({ error: 'Finish setup first.' });
      if (!(await start(reply))) return;
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
  }
  return { register };
}
