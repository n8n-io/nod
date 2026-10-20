import Fastify from 'fastify';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { DesktopSetupState } from '../shared/onboarding.ts';
import { onboardingSteps, onboardingVersion } from '../shared/onboarding.ts';
import { registerLocalAccess } from './access.ts';
import { createAccountSession } from './account.ts';
import {
  createSetupAccount,
  initialSetupProgress,
  setupProgressSchema,
  setupAccountSchema,
} from './setup-state.ts';
import { createSetupJournal } from './setup-journal.ts';
import { createOnboardingInterview } from './onboarding-interview.ts';
import { createAnalytics, analyticsEnvironment, registerAnalyticsRoutes } from './analytics.ts';
import { defaultPreferences, preferencesSchema, validatePreferences } from './preferences.ts';
import { createErrorRedactor } from './redaction.ts';
import type { createDesktopSetupAdapters } from './composition.ts';

export async function createDesktopSetup(options: {
  root: string;
  ownerId: string;
  port: number;
  token: string;
  keyStore: CredentialKeyStore;
  adapters(
    journal: Awaited<ReturnType<typeof createSetupJournal>>,
    resuming: boolean,
  ): Promise<Awaited<ReturnType<typeof createDesktopSetupAdapters>>>;
  complete(): void;
  retry(): void;
}) {
  const origin = `http://127.0.0.1:${options.port}`;
  const journal = await createSetupJournal({
    root: options.root,
    ownerId: options.ownerId,
    keyStore: options.keyStore,
  });
  const snapshot = await journal.snapshot();
  let frozen = snapshot.frozen;
  let transferring =
    frozen ||
    setupProgressSchema.parse(snapshot.sections.progress ?? initialSetupProgress()).completing;
  let completed = false;
  let closing = false;
  let finishing: Promise<void> | undefined;
  let runtime: DesktopSetupState['runtime'] = {
    phase: 'preparing',
    message: 'Preparing your computer…',
  };
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 256 * 1024,
    forceCloseConnections: true,
  });
  await registerLocalAccess(app, options.port, { key: options.token, desktop: true });
  const secrets = [options.token];
  const adapters = frozen ? undefined : await options.adapters(journal, transferring);
  adapters?.models.onSecrets((values) => secrets.push(...values));
  adapters?.integrations.onSecrets((values) => secrets.push(...values));
  adapters?.traces.configure({ secrets });
  const redact = createErrorRedactor(secrets);
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Check the values and try again.' });
    reply
      .code(
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 503,
      )
      .send({ error: redact(error.message) });
  });
  let writes = 0;
  const requests = new WeakSet<object>();
  app.addHook('onRequest', async (request, reply) => {
    if (
      transferring &&
      request.url.startsWith('/api/') &&
      !(
        (request.method === 'GET' &&
          ['/api/session', '/api/health', '/api/desktop/setup'].includes(request.url)) ||
        (request.method === 'POST' &&
          ['/api/desktop/setup/complete', '/api/desktop/setup/retry'].includes(request.url))
      )
    )
      return reply.code(409).send({ error: 'Otto is finishing setup.' });
    if (
      !request.url.startsWith('/api/desktop/setup/complete') &&
      !request.url.startsWith('/api/desktop/setup/retry') &&
      (request.method !== 'GET' ||
        request.url.startsWith('/api/apps/callback') ||
        request.url.startsWith('/api/models/oauth/callback'))
    ) {
      requests.add(request);
      writes++;
    }
  });
  app.addHook('onResponse', async (request) => {
    if (requests.delete(request)) writes--;
  });
  const analytics = await createAnalytics({
    provider: adapters?.analytics,
    environment: analyticsEnvironment(process.env),
    dataRoot: options.root,
    installationId: process.env.OTTO_ANALYTICS_ID,
    appVersion: process.env.OTTO_APP_VERSION,
  });
  const accounts = createSetupAccount(journal, options.ownerId);
  createAccountSession({
    accounts,
    origin,
    localUser: { id: options.ownerId, name: 'You', email: null, avatarUrl: null },
    analytics,
    desktopSetup: true,
    traces: adapters?.traces.available ?? false,
    onTraces: (enabled) => adapters?.traces.configure({ enabled }),
  }).register(app);
  registerAnalyticsRoutes(app, analytics.forOwner(options.ownerId));
  const progress = async () =>
    setupProgressSchema.parse((await journal.read('progress')) ?? initialSetupProgress());
  async function state(): Promise<DesktopSetupState> {
    const value = await progress();
    return {
      version: onboardingVersion,
      step: value.step,
      about: value.about,
      runtime,
      completed,
      completing: frozen || value.completing,
    };
  }
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/desktop/setup', state);
  app.patch('/api/desktop/setup', async (request) => {
    const input = setupProgressSchema
      .pick({ step: true, about: true })
      .partial()
      .parse(request.body);
    const current = await progress();
    if (current.completing)
      throw Object.assign(new Error('Otto is finishing setup.'), { statusCode: 409 });
    if (input.step) {
      const from = onboardingSteps.indexOf(current.step);
      const to = onboardingSteps.indexOf(input.step);
      if (Math.abs(to - from) > 1)
        throw Object.assign(new Error('Complete each setup step first.'), { statusCode: 409 });
      if (to > from) {
        if (
          current.step === 'welcome' &&
          !setupAccountSchema.parse(await journal.read('account')).consentAnswered
        )
          throw Object.assign(new Error('Choose whether to share usage data first.'), {
            statusCode: 409,
          });
        if (current.step === 'brain' && !adapters?.models.configured)
          throw Object.assign(new Error('Connect a model before continuing.'), { statusCode: 409 });
        if (current.step === 'email' && (await adapters?.integrations.busy()))
          throw Object.assign(new Error('Finish or cancel sign-in before continuing.'), {
            statusCode: 409,
          });
        if (current.step === 'about' && !(await journal.read('interview-saved')))
          throw Object.assign(new Error('Finish the introduction before continuing.'), {
            statusCode: 409,
          });
      }
    }
    await journal.update('progress', (saved) => {
      const value = setupProgressSchema.parse(saved ?? initialSetupProgress());
      if (value.step !== current.step || value.completing)
        throw new Error('Setup changed. Try again.');
      return setupProgressSchema.parse({
        ...value,
        ...input,
        visited: [...new Set([...value.visited, ...(input.step ? [input.step] : [])])],
      });
    });
    return state();
  });
  app.get(
    '/api/preferences',
    async () => (await journal.read('preferences')) ?? defaultPreferences,
  );
  app.patch('/api/preferences', async (request) => {
    const patch = validatePreferences(request.body);
    return journal.update('preferences', (value) =>
      preferencesSchema.parse({ ...defaultPreferences, ...((value as object) ?? {}), ...patch }),
    );
  });
  if (adapters) {
    adapters.models.register(app);
    adapters.integrations.register(app);
    adapters.channels.registerRoutes(app);
    app.get('/api/channels', async () => ({
      channels: adapters.telegram.channels(),
      error: null,
      inbox: [],
      deliveries: [],
    }));
    app.get('/api/configuration', async () => ({
      provider: adapters.models.current.provider,
      model: adapters.models.current.name,
      llmReady: adapters.models.configured,
      integrationsReady: true,
      conversationResetEnabled: false,
    }));
    const interview = createOnboardingInterview({
      curator: adapters.curator,
      memory: {
        restate: async (notes) => {
          await journal.update('interview-notes', () => notes);
        },
      },
    });
    app.post('/api/onboarding/interview', async (request, reply) => {
      const input = z
        .object({ answers: z.array(z.string()).min(1).max(2) })
        .strict()
        .parse(request.body);
      const cache = await journal.read<{ answers: string[]; reply: unknown }>('interview-reply');
      if (cache && JSON.stringify(cache.answers) === JSON.stringify(input.answers))
        return cache.reply;
      const result = await interview.next(input);
      if (!result) return reply.code(503).send({ error: 'Otto could not write a reply.' });
      await journal.update('interview-reply', () => ({ answers: input.answers, reply: result }));
      return result;
    });
    app.put('/api/onboarding/interview', async (request) => {
      await interview.remember(request.body);
      await journal.update('interview-saved', () => true);
      return { ok: true };
    });
    app.post('/api/onboarding/suggestions', async () => {
      await journal.update('suggestions', () => true);
      return { ok: true };
    });
  }
  async function finish() {
    if (frozen) {
      options.complete();
      return;
    }
    if (!adapters) throw new Error('Setup is unavailable.');
    const wasTransferring = transferring;
    transferring = true;
    let intentSaved = false;
    try {
      const current = await progress();
      if (
        current.step !== 'open' ||
        onboardingSteps.some((step) => !current.visited.includes(step)) ||
        !adapters.models.configured
      )
        throw Object.assign(new Error('Complete each setup step first.'), { statusCode: 409 });
      if (
        writes ||
        adapters.models.busy() ||
        adapters.channels.busy() ||
        (await adapters.integrations.busy())
      )
        throw Object.assign(new Error('Finish or cancel sign-in first.'), { statusCode: 409 });
      await journal.update('progress', () => ({ ...current, completing: true }));
      intentSaved = true;
      await adapters.telegram.close();
      const channels =
        (await journal.read('channel-transfer')) ?? (await adapters.channels.transfer());
      await journal.update('channel-transfer', () => channels);
      const models = (await journal.read('model-transfer')) ?? (await adapters.models.transfer());
      await journal.update('model-transfer', () => models);
      const integrations =
        (await journal.read('integration-transfer')) ?? (await adapters.integrations.transfer());
      await journal.update('integration-transfer', () => integrations);
      await adapters.integrations.close();
      await journal.freeze();
      frozen = true;
      options.complete();
    } catch (error) {
      transferring = wasTransferring || intentSaved;
      runtime = { phase: 'error', message: 'Setup needs another try. Your progress is saved.' };
      throw error;
    }
  }
  function finishOnce() {
    if (!finishing)
      finishing = finish().finally(() => {
        finishing = undefined;
      });
    return finishing;
  }
  app.post('/api/desktop/setup/complete', async (_request, reply) => {
    if (completed) return { ok: true };
    await finishOnce();
    return reply.code(202).send({ ok: false, pending: true });
  });
  app.post('/api/desktop/setup/retry', async () => {
    runtime = { phase: 'preparing', message: 'Preparing your computer…' };
    if (!frozen && (await progress()).completing) await finishOnce();
    else options.retry();
    return { ok: true };
  });
  app.addHook('onClose', async () => {
    closing = true;
    await adapters?.telegram.close();
    await adapters?.models.close();
    await adapters?.integrations.close();
    await analytics.shutdown();
    await journal.close();
  });
  return {
    app,
    resume: async () => {
      if (!closing && (frozen || (await progress()).completing))
        await finishOnce().catch(() => {
          runtime = { phase: 'error', message: 'Setup needs another try. Your progress is saved.' };
        });
    },
    status(value: DesktopSetupState['runtime']) {
      runtime = value;
    },
    async acknowledge(id: string) {
      await journal.discard(id);
      completed = true;
    },
  };
}
