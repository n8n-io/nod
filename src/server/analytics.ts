import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { posthogConfig, type AnalyticsConfiguration } from '../shared/analytics.ts';
import { apiKeyModelProviders } from '../shared/models.ts';
import {
  legacyOnboardingChoiceProperties,
  onboardingPersonProperties,
} from '../shared/onboarding-analytics.ts';
import { updatesEmailConsent, type OnboardingProfile } from '../shared/onboarding.ts';

import {
  analyticsEvent,
  analyticsTool,
  analyticsVersion,
  type AnalyticsEvent,
} from './analytics-events.ts';
import type { RuntimeObservation } from '../ports/agent.ts';

export type { AnalyticsEvent } from './analytics-events.ts';
export interface AnalyticsDelivery {
  uuid?: string;
  timestamp?: Date;
  appVersion?: string;
  consentRevision?: string;
  runId?: string;
}
export type CaptureAnalytics = {
  (event: AnalyticsEvent, delivery?: AnalyticsDelivery): void;
  snapshot?: () => CaptureAnalytics;
};
export const snapshotAnalytics = (capture?: CaptureAnalytics) => capture?.snapshot?.() ?? capture;
export type MemoryChange = Extract<AnalyticsEvent, { event: 'memory_changed' }>['properties'];

export function analyticsEnabled(env: Record<string, string | undefined>) {
  const production = env.NODE_ENV === 'production';
  return (
    env.NOD_ANALYTICS_ENABLED === 'true' || (env.NOD_ANALYTICS_ENABLED !== 'false' && production)
  );
}

export function analyticsEnvironment(
  env: Record<string, string | undefined>,
): AnalyticsConfiguration['environment'] {
  const explicit = z.enum(['development', 'production']).safeParse(env.NOD_ANALYTICS_ENVIRONMENT);
  if (explicit.success) return explicit.data;
  return env.NODE_ENV === 'production' && !/^\d+\.\d+\.\d+-/.test(env.NOD_APP_VERSION ?? '')
    ? 'production'
    : 'development';
}

async function installationId(root: string, supplied?: string) {
  if (supplied !== undefined) return z.uuid().parse(supplied).toLowerCase();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = join(root, 'analytics-id');
  try {
    return z
      .uuid()
      .parse((await readFile(destination, 'utf8')).trim())
      .toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const id = randomUUID();
  const temporary = join(root, `.analytics-${id}`);
  try {
    await writeFile(temporary, id, { flag: 'wx', mode: 0o600 });
    await link(temporary, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
  return z
    .uuid()
    .parse((await readFile(destination, 'utf8')).trim())
    .toLowerCase();
}

const hostedProvider = z.enum([...apiKeyModelProviders, 'typesafe']);
const systemActivity = z.enum(['memory_learning', 'onboarding', 'writing_style']);

export function analyticsModel(provider: string, model?: string) {
  const hosted = hostedProvider.safeParse(provider).data;
  return {
    provider: hosted ?? (provider === 'compatible' ? ('compatible' as const) : ('other' as const)),
    ...(model
      ? {
          model:
            hosted && hosted !== 'radius' && /^[a-z0-9][a-z0-9._:/-]{0,119}$/.test(model)
              ? model
              : 'custom',
        }
      : {}),
  };
}

const workspaceTools = new Set(['read', 'bash', 'edit', 'write', 'find', 'ls', 'grep']);
const webTools = new Set(['web_search', 'fetch_content', 'get_search_content', 'code_search']);

export function toolUsed(event: Extract<RuntimeObservation, { type: 'tool_end' }>): AnalyticsEvent {
  return {
    event: 'tool_used',
    properties: {
      tool: workspaceTools.has(event.name)
        ? 'workspace'
        : webTools.has(event.name)
          ? 'web'
          : (analyticsTool.safeParse(event.name).data ?? 'other'),
      outcome: event.status,
      duration_ms: Number.isFinite(event.durationMs)
        ? Math.max(0, Math.round(event.durationMs))
        : 0,
      subagent: Boolean(event.execution?.parentRunId),
    },
  };
}

export async function createAnalytics(options: {
  provider?: ProductAnalytics;
  environment: AnalyticsConfiguration['environment'];
  dataRoot: string;
  installationId?: string;
  appVersion?: string;
}) {
  const appVersion = analyticsVersion.safeParse(options.appVersion).data;
  const localId = options.provider
    ? await installationId(options.dataRoot, options.installationId).catch(() => null)
    : null;
  const available = Boolean(options.provider && localId);
  const personProfileAvailable = Boolean(options.provider?.setPersonProperties && localId);
  const states = new Map<
    string,
    { enabled: boolean; version: number; revision?: string; controller: AbortController }
  >();
  const listeners = new Map<string, Set<(enabled: boolean) => void>>();
  const runs = new AsyncLocalStorage<{
    owner: string;
    id: string;
    consent: ReturnType<typeof consent>;
    model?: ReturnType<typeof analyticsModel>;
    work?: { work_type: 'immediate' | 'scheduled' | 'background'; owner_requested: boolean };
  }>();
  const systems = new AsyncLocalStorage<{
    owner: string;
    activity: z.infer<typeof systemActivity>;
    consent: ReturnType<typeof consent>;
  }>();
  let closed = false;
  function state(owner: string) {
    let value = states.get(owner);
    if (!value) {
      const controller = new AbortController();
      controller.abort();
      value = { enabled: false, version: 0, controller };
      states.set(owner, value);
    }
    return value;
  }
  function consent(owner: string) {
    const current = state(owner);
    return {
      enabled: available && current.enabled && !closed,
      version: current.version,
      revision: current.revision,
      signal: current.controller.signal,
    };
  }
  function configuration(owner: string | null): AnalyticsConfiguration {
    const enabled = !!owner && consent(owner).enabled;
    return {
      enabled,
      distinctId: enabled ? `local:${localId}` : null,
      environment: options.environment,
      ...(appVersion ? { appVersion } : {}),
    };
  }
  function capture(owner: string, event: AnalyticsEvent, delivery: AnalyticsDelivery = {}) {
    const config = configuration(owner);
    if (!config.enabled || !config.distinctId) return;
    const current = consent(owner);
    const independent = event.event === 'owner_message_accepted';
    const run = independent ? undefined : runs.getStore();
    const system = independent ? undefined : systems.getStore();
    const context = run ?? system;
    if (
      context &&
      (context.owner !== owner ||
        !context.consent.enabled ||
        context.consent.signal.aborted ||
        context.consent.version !== current.version)
    )
      return;
    const runId = independent ? undefined : (delivery.runId ?? run?.id);
    if (runId !== undefined && !z.uuid().safeParse(runId).success) return;
    if (run && delivery.runId !== undefined && delivery.runId !== run.id) return;
    if (delivery.consentRevision !== undefined && delivery.consentRevision !== current.revision)
      return;
    const parsed = analyticsEvent.safeParse(event);
    if (!parsed.success) return;
    if (run) {
      const { data } = parsed;
      if (data.event === 'turn_started') {
        run.work = {
          work_type: data.properties.work_type,
          owner_requested: data.properties.owner_requested,
        };
        if (data.properties.provider)
          run.model ??= analyticsModel(data.properties.provider, data.properties.model);
      }
      if (data.event === 'model_used' && data.properties.purpose === 'agent')
        run.model = analyticsModel(data.properties.provider, data.properties.model);
      if (data.event === 'turn_completed' && run.model) {
        const { provider: _, model: __, ...properties } = data.properties;
        data.properties = { ...properties, ...run.model };
      }
    }
    const version = analyticsVersion.safeParse(delivery.appVersion ?? appVersion).data;
    try {
      options.provider?.capture(
        {
          ...(delivery.uuid ? { uuid: delivery.uuid } : {}),
          ...(delivery.timestamp ? { timestamp: delivery.timestamp } : {}),
          ...(current.revision !== undefined ? { consentRevision: current.revision } : {}),
          distinctId: config.distinctId,
          event: parsed.data.event,
          properties: {
            analytics_schema: posthogConfig.schemaVersion,
            environment: options.environment,
            capture_source: 'server',
            ...(version ? { app_version: version } : {}),
            ...(runId ? { run_id: runId } : {}),
            ...(run?.work ??
              (system
                ? {
                    work_type: 'background',
                    owner_requested: false,
                    system_activity: system.activity,
                  }
                : parsed.data.event === 'model_used'
                  ? { work_type: 'unclassified', owner_requested: false }
                  : {})),
            ...('properties' in parsed.data ? parsed.data.properties : {}),
          },
        },
        current.signal,
      );
    } catch {}
  }
  async function setOwnerPersonProperties(
    owner: string,
    properties: Record<string, string | number | boolean | string[]>,
    unset?: readonly string[],
    expected?: ReturnType<typeof consent>,
  ) {
    const current = consent(owner);
    const distinctId = configuration(owner).distinctId;
    if (
      !personProfileAvailable ||
      !current.enabled ||
      !distinctId ||
      (expected &&
        (expected.signal.aborted ||
          current.signal !== expected.signal ||
          current.version !== expected.version ||
          current.revision !== expected.revision))
    )
      return false;
    try {
      const sent = await options.provider?.setPersonProperties?.(
        { distinctId, properties, ...(unset?.length ? { unset } : {}) },
        current.signal,
      );
      return Boolean(sent && !current.signal.aborted && current.version === consent(owner).version);
    } catch {
      return false;
    }
  }
  function setOnboardingProfileAnswers(owner: string, profile: OnboardingProfile) {
    return setOnboardingProfileProperties(owner, onboardingPersonProperties(profile));
  }
  function setOnboardingProfileProperties(
    owner: string,
    properties: ReturnType<typeof onboardingPersonProperties>,
    expected?: ReturnType<typeof consent>,
  ) {
    return setOwnerPersonProperties(owner, properties, legacyOnboardingChoiceProperties, expected);
  }
  function setUpdatesEmail(
    owner: string,
    email: string,
    consentAt = new Date().toISOString(),
    expected?: ReturnType<typeof consent>,
  ) {
    return setOwnerPersonProperties(
      owner,
      {
        email,
        nod_updates_email_consent: true,
        nod_updates_email_consent_at: consentAt,
        nod_updates_email_consent_version: updatesEmailConsent.version,
        nod_updates_email_consent_text: updatesEmailConsent.text,
        nod_updates_email_consent_privacy_url: updatesEmailConsent.privacyUrl,
      },
      undefined,
      expected,
    );
  }
  function setUsageData(owner: string, enabled: boolean, revision = state(owner).revision) {
    const current = state(owner);
    if (current.enabled === enabled && current.revision === revision) return;
    current.controller.abort();
    const controller = new AbortController();
    if (!enabled) controller.abort();
    states.set(owner, { enabled, version: current.version + 1, revision, controller });
    for (const listener of listeners.get(owner) ?? []) {
      try {
        listener(enabled);
      } catch {}
    }
  }
  return {
    configuration,
    consent,
    personProfileAvailable,
    setOnboardingProfileAnswers,
    setOnboardingProfileProperties,
    setUpdatesEmail,
    withRun<T>(owner: string, operation: () => T): T {
      return runs.run({ owner, id: randomUUID(), consent: consent(owner) }, operation);
    },
    withSystemWork<T>(
      owner: string,
      activity: z.infer<typeof systemActivity>,
      operation: () => T,
    ): T {
      const parsed = systemActivity.safeParse(activity);
      if (runs.getStore() || systems.getStore() || !parsed.success) return operation();
      return systems.run({ owner, activity: parsed.data, consent: consent(owner) }, operation);
    },
    currentRun(owner: string) {
      const run = runs.getStore();
      return run?.owner === owner ? run : undefined;
    },
    async permitted(owner: string) {
      return consent(owner).enabled;
    },
    capture,
    subscribe(owner: string, listener: (enabled: boolean) => void) {
      let callbacks = listeners.get(owner);
      if (!callbacks) listeners.set(owner, (callbacks = new Set()));
      callbacks.add(listener);
      return () => {
        callbacks.delete(listener);
        if (!callbacks.size) listeners.delete(owner);
      };
    },
    setUsageData,
    forOwner(owner: string): CaptureAnalytics {
      const scoped: CaptureAnalytics = (event, delivery) => capture(owner, event, delivery);
      scoped.snapshot = () => {
        const initial = consent(owner);
        return (event, delivery) => {
          if (
            initial.enabled &&
            !initial.signal.aborted &&
            initial.version === consent(owner).version
          )
            scoped(event, delivery);
        };
      };
      return scoped;
    },
    shutdown: async () => {
      closed = true;
      try {
        await options.provider?.shutdown();
      } catch {}
    },
  };
}

export type Analytics = Awaited<ReturnType<typeof createAnalytics>>;

type SettingsSection = Extract<
  AnalyticsEvent,
  { event: 'settings_updated' }
>['properties']['section'];
type SettingsOperation = Extract<
  AnalyticsEvent,
  { event: 'settings_updated' }
>['properties']['operation'];
const settings = (section: SettingsSection, operation: SettingsOperation): AnalyticsEvent => ({
  event: 'settings_updated',
  properties: { section, operation },
});
const channel =
  (operation: SettingsOperation | ((provider: 'telegram' | 'whatsapp') => SettingsOperation)) =>
  (request: FastifyRequest): AnalyticsEvent | undefined => {
    const provider = z
      .enum(['telegram', 'whatsapp'])
      .safeParse(
        (request.params as { provider?: string }).provider ??
          (request.routeOptions.url?.includes('/telegram/')
            ? 'telegram'
            : request.routeOptions.url?.includes('/whatsapp/')
              ? 'whatsapp'
              : undefined),
      ).data;
    if (!provider) return;
    return {
      event: 'settings_updated',
      properties: {
        section: 'channels',
        operation: typeof operation === 'function' ? operation(provider) : operation,
        channel: provider,
      },
    };
  };

export const analyticsRoutes = new Map<
  string,
  AnalyticsEvent | ((request: FastifyRequest) => AnalyticsEvent | undefined)
>([
  ['POST /api/conversation/reset', { event: 'conversation_reset' }],
  ['POST /api/thread/stop', { event: 'chat_stopped' }],
  ['POST /api/tasks/:id/stop', { event: 'task_stopped' }],
  ['PATCH /api/preferences', settings('preferences', 'update')],
  [
    'PUT /api/channel-settings/:provider',
    channel((provider) => (provider === 'telegram' ? 'connect_started' : 'update')),
  ],
  ['POST /api/channel-settings/telegram/pairing', channel('connect_started')],
  ['POST /api/channel-settings/telegram/confirm', channel('update')],
  ['POST /api/channel-settings/telegram/user', channel('update')],
  ['POST /api/channel-settings/whatsapp/pairing', channel('connect_started')],
  ['DELETE /api/channel-settings/whatsapp/pairing', channel('disconnect')],
  ['DELETE /api/channel-settings/:provider', channel('disconnect')],
  ['POST /api/models/keys', settings('models', 'update')],
  ['POST /api/models/endpoints', settings('models', 'update')],
  ['POST /api/models/oauth', settings('models', 'connect_started')],
  ['POST /api/models/oauth/complete', settings('models', 'update')],
  ['POST /api/models/connections/:id/refresh', settings('models', 'update')],
  ['PUT /api/models/selection', settings('models', 'update')],
  ['DELETE /api/models/connections/:id', settings('models', 'disconnect')],
  ['PUT /api/trust/limit', settings('trust', 'update')],
  ['PATCH /api/memory', settings('memory', 'update')],
  [
    'POST /api/link-preview/opened',
    (request) => {
      const body = request.body as { source: string; position?: number };
      const source = z.enum(['text', 'tooltip']).safeParse(body.source).data;
      return source
        ? {
            event: 'link_opened',
            properties: {
              source,
              ...(body.position && body.position <= 20 ? { position: body.position } : {}),
            },
          }
        : undefined;
    },
  ],
]);

export function registerAnalyticsRoutes(app: FastifyInstance, capture: CaptureAnalytics) {
  const captures = new WeakMap<FastifyRequest, CaptureAnalytics>();
  app.addHook('onRequest', async (request) => {
    if (analyticsRoutes.has(`${request.method} ${request.routeOptions.url}`))
      captures.set(request, snapshotAnalytics(capture)!);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const action = analyticsRoutes.get(`${request.method} ${request.routeOptions.url}`);
    const event = typeof action === 'function' ? action(request) : action;
    if (event) captures.get(request)?.(event);
  });
}
