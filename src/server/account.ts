import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { analyticsProfileSchema } from '../shared/analytics-profile.ts';
import { productSurveyEventSchema } from '../shared/product-surveys.ts';
import type { ProductSurveys } from './product-surveys.ts';
import type {
  AccountSettings,
  AccountUpdate,
  AccountUser,
  SessionResponse,
} from '../shared/account.ts';
import type { AccountStore } from './account-store.ts';
import { analyticsModel, type Analytics } from './analytics.ts';

const accountUpdate = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    onboardingCompleted: z.boolean().optional(),
    usageData: z.boolean().optional(),
    traces: z.boolean().optional(),
    analyticsProfile: analyticsProfileSchema.optional(),
  })
  .strict();

export function createAccountSession(options: {
  accounts: AccountStore;
  origin: string;
  localUser: AccountUser;
  developerIds?: ReadonlySet<string>;
  analytics?: Analytics;
  model?(): { provider: string; name: string; configured: boolean };
  start?(): Promise<void>;
  onboardingMissing?(): Promise<'brain' | 'email' | null>;
  traces?: boolean;
  onTraces?(enabled: boolean): void;
  surveys?: ProductSurveys;
  prepare?(signal: AbortSignal): Promise<void>;
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
      options.analytics?.setProfile(owner, account.analyticsProfile ?? {});
      options.onTraces?.(account.traces);
      return { ...account, usageData: consent.enabled };
    }
  }
  async function updateAccount(input: AccountUpdate) {
    const version = ++accountVersion;
    if (input.usageData === false) options.analytics?.setUsageData(owner, false);
    if (input.traces === false) options.onTraces?.(false);
    const update = (pending ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const account = await options.accounts.update(owner, input);
        const consent = await options.accounts.readConsent(owner);
        if (accountVersion === version) {
          options.analytics?.setUsageData(owner, consent.enabled, consent.revision);
          options.analytics?.setProfile(owner, account.analyticsProfile ?? {});
          options.onTraces?.(account.traces);
        }
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
      user,
      settings: {
        theme: account.theme,
        onboardingCompleted: account.onboardingCompleted,
        usageData: account.usageData,
        traces: account.traces,
        analyticsProfile: account.analyticsProfile,
      },
      capabilities: {
        developer: Boolean(options.developerIds?.has(owner)),
        traces: options.traces === true,
      },
      ...(options.analytics ? { analytics: options.analytics.configuration(owner) } : {}),
    };
  }
  function guard(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      reply.code(403).send({ error: 'This origin is not permitted.' });
      return false;
    }
    const expected = request.headers['x-nod-account'];
    if (expected !== undefined && expected !== owner) {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return false;
    }
    return true;
  }
  async function prepare(reply: FastifyReply) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      if (reply.raw.destroyed) controller.abort();
      await options.prepare?.(controller.signal);
    } finally {
      reply.raw.off('close', abort);
    }
  }
  async function start(reply: FastifyReply, complete?: () => Promise<unknown>) {
    try {
      await prepare(reply);
      await options.start?.();
      await complete?.();
      return true;
    } catch {
      reply.code(503).send({ error: 'Setup could not be completed. Try again.' });
      return false;
    }
  }
  function register(app: FastifyInstance) {
    app.get('/api/product-survey', async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      const account = await readAccount();
      if (!account.onboardingCompleted || !options.analytics?.configuration(owner).enabled)
        return { offer: null };
      return { offer: (await options.surveys?.offer(owner)) ?? null };
    });
    app.post('/api/product-survey', async (request, reply) => {
      if (!guard(request, reply)) return;
      const input = productSurveyEventSchema.parse(request.body);
      const account = await readAccount();
      if (!account.onboardingCompleted || !options.analytics?.configuration(owner).enabled)
        return reply.code(409).send({ error: 'This survey is no longer available.' });
      const consent = options.analytics.consent(owner);
      const result = (await options.surveys?.respond(owner, input)) ?? {
        accepted: false,
        changed: false,
      };
      if (
        result.changed &&
        !consent.signal.aborted &&
        consent.version === options.analytics.consent(owner).version
      )
        options.analytics.capture(owner, { event: 'nod_survey_changed', properties: input });
      return { accepted: result.accepted };
    });
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
      await prepare(reply);
      return { ok: true };
    });
    app.patch('/api/account', async (request, reply) => {
      if (!guard(request, reply)) return;
      const input = accountUpdate.parse(request.body);
      const version = accountVersion + 1;
      if (input.traces === true && options.traces !== true)
        return reply.code(400).send({ error: 'Conversation traces are not available here.' });
      let onboardingCompletedNow = false;
      let updated: AccountSettings | undefined;
      if (input.onboardingCompleted) {
        if (
          options.onboardingMissing &&
          !(await options.accounts.read(owner)).onboardingCompleted
        ) {
          try {
            const step = await options.onboardingMissing();
            if (step)
              return reply.code(409).send({
                error:
                  step === 'brain'
                    ? 'Connect an AI provider before finishing setup.'
                    : 'Connect Gmail before finishing setup.',
                step,
              });
          } catch {
            return reply.code(503).send({ error: 'Could not verify setup. Try again.' });
          }
        }
        if (
          !(await start(reply, async () => {
            const account = await updateAccount(input);
            updated = account;
            onboardingCompletedNow = account.onboardingCompletedNow === true;
          }))
        )
          return;
      } else updated = await updateAccount(input);
      const profile = updated?.analyticsProfile;
      if (
        (input.analyticsProfile !== undefined ||
          (input.usageData === true && profile !== undefined)) &&
        accountVersion === version &&
        options.analytics?.consent(owner).enabled
      )
        options.analytics.capture(owner, {
          event: 'nod_profile_updated',
          properties: profile ?? {},
        });
      if (onboardingCompletedNow) {
        const model = options.model?.();
        options.analytics?.capture(owner, {
          event: 'nod_onboarding_completed',
          ...(model?.configured
            ? { properties: { model_provider: analyticsModel(model.provider).provider } }
            : {}),
        });
      }
      if (input.theme !== undefined)
        options.analytics?.capture(owner, {
          event: 'nod_settings_updated',
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
