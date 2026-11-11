import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountUpdate, AccountUser, SessionResponse } from '../shared/account.ts';
import type { AccountStore } from './account-store.ts';
import { analyticsModel, snapshotAnalytics, type Analytics } from './analytics.ts';
import { captureSettingChanges } from './analytics-settings.ts';

const surveyActiveDays = 3;

const accountUpdate = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    onboardingCompleted: z.literal(true).optional(),
    usageData: z.boolean().optional(),
    traces: z.boolean().optional(),
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
  updatesEmail?: boolean;
  prepare?(signal: AbortSignal): Promise<void>;
}) {
  const origin = new URL(options.origin).origin;
  const user = options.localUser;
  const owner = user.id;
  let accountVersion = 0;
  let pending: Promise<unknown> | undefined;
  let usageVersion = 0;
  let usagePublication: { version: number; revision: string; usageVersion: number } | undefined;
  function applyConsent(consent: { enabled: boolean; revision: string }) {
    const current = options.analytics?.consent(owner);
    options.analytics?.setUsageData(owner, consent.enabled, consent.revision);
    const publication = usagePublication;
    usagePublication = undefined;
    if (
      publication &&
      consent.enabled &&
      publication.version === current?.version &&
      publication.revision === consent.revision &&
      publication.usageVersion === usageVersion
    )
      options.analytics?.capture(owner, {
        event: 'setting_changed',
        properties: { setting: 'usage_data', actor: 'owner', state: 'on' },
      });
  }
  async function readAccount() {
    for (;;) {
      await pending?.catch(() => {});
      const version = accountVersion;
      const account = await options.accounts.read(owner);
      const consent = await options.accounts.readConsent(owner);
      if (accountVersion !== version || pending) continue;
      applyConsent(consent);
      options.onTraces?.(account.traces);
      return { ...account, usageData: consent.enabled, usageDataRevision: consent.revision };
    }
  }
  async function updateAccount(input: AccountUpdate) {
    const version = ++accountVersion;
    const initialConsent = options.analytics?.consent(owner);
    const capture = snapshotAnalytics(options.analytics?.forOwner(owner));
    if (input.usageData === false) {
      usageVersion++;
      usagePublication = undefined;
    }
    const currentUsageVersion = usageVersion;
    if (input.usageData === false) options.analytics?.setUsageData(owner, false);
    if (input.traces === false) options.onTraces?.(false);
    const update = (pending ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const before = await options.accounts.read(owner);
        const account = await options.accounts.update(owner, input);
        const consent = await options.accounts.readConsent(owner);
        if (
          input.usageData === true &&
          !before.usageData &&
          initialConsent &&
          currentUsageVersion === usageVersion
        )
          usagePublication = {
            version: initialConsent.version,
            revision: consent.revision,
            usageVersion: currentUsageVersion,
          };
        if (accountVersion === version) {
          applyConsent(consent);
          options.onTraces?.(account.traces);
        }
        captureSettingChanges(capture, 'owner', before, account, {
          theme: 'theme',
          traces: 'conversation_traces',
        });
        return { ...account, usageData: consent.enabled };
      });
    pending = update;
    return update.finally(() => {
      if (pending === update) pending = undefined;
    });
  }
  async function response(): Promise<SessionResponse> {
    for (;;) {
      const version = accountVersion;
      const account = await readAccount();
      const analytics = options.analytics?.configuration(owner);
      const surveys =
        analytics?.enabled &&
        (await options.accounts.activeDays(owner, surveyActiveDays)) >= surveyActiveDays;
      if (accountVersion !== version || pending) continue;
      return {
        user,
        settings: {
          theme: account.theme,
          onboardingCompleted: account.onboardingCompleted,
          usageData: account.usageData,
          usageDataRevision: account.usageDataRevision,
          traces: account.traces,
        },
        capabilities: {
          developer: Boolean(options.developerIds?.has(owner)),
          traces: options.traces === true,
          updatesEmail: options.updatesEmail === true,
        },
        ...(analytics && {
          analytics: analytics.enabled ? { ...analytics, surveys } : analytics,
        }),
      };
    }
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
    app.post('/api/account/model-setup', async (request, reply) => {
      if (!guard(request, reply)) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if ((await readAccount()).onboardingCompleted)
        return reply.code(409).send({ error: 'Setup is already complete.' });
      const model = options.model?.();
      if (!model?.configured)
        return reply.code(409).send({ error: 'Connect an AI provider before continuing.' });
      const selected = analyticsModel(model.provider, model.name);
      if (!selected.model)
        return reply.code(409).send({ error: 'Choose an AI model before continuing.' });
      snapshotAnalytics(options.analytics?.forOwner(owner))?.({
        event: 'model_setup_completed',
        properties: { provider: selected.provider, model: selected.model },
      });
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
    app.patch('/api/account', async (request, reply) => {
      if (!guard(request, reply)) return;
      const input = accountUpdate.parse(request.body);
      const capture = snapshotAnalytics(options.analytics?.forOwner(owner));
      if (input.traces === true && options.traces !== true)
        return reply.code(400).send({ error: 'Conversation traces are not available here.' });
      let onboardingCompletedNow = false;
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
            onboardingCompletedNow = account.onboardingCompletedNow === true;
          }))
        )
          return;
      } else await updateAccount(input);
      if (onboardingCompletedNow) {
        const model = options.model?.();
        const selected = model?.configured ? analyticsModel(model.provider, model.name) : undefined;
        const completed = snapshotAnalytics(options.analytics?.forOwner(owner));
        if (selected?.model)
          completed?.({
            event: 'model_setup_completed',
            properties: { provider: selected.provider, model: selected.model },
          });
        completed?.({
          event: 'onboarding_completed',
          ...(selected ? { properties: { provider: selected.provider } } : {}),
        });
      }
      if (input.theme !== undefined)
        capture?.({
          event: 'settings_updated',
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
