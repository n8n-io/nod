import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { posthogConfig, type AnalyticsConfiguration } from '../shared/analytics.ts';

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
  replaySessionId?: string;
}
export type CaptureAnalytics = (event: AnalyticsEvent, delivery?: AnalyticsDelivery) => void;
export type MemoryChange = Extract<AnalyticsEvent, { event: 'otto_memory_changed' }>['properties'];

export function analyticsEnabled(env: Record<string, string | undefined>) {
  const production = env.NODE_ENV === 'production';
  return (
    env.OTTO_ANALYTICS_ENABLED === 'true' || (env.OTTO_ANALYTICS_ENABLED !== 'false' && production)
  );
}

export function analyticsEnvironment(
  env: Record<string, string | undefined>,
): AnalyticsConfiguration['environment'] {
  const explicit = z.enum(['development', 'production']).safeParse(env.OTTO_ANALYTICS_ENVIRONMENT);
  if (explicit.success) return explicit.data;
  return env.NODE_ENV === 'production' ? 'production' : 'development';
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

const hostedProviders: Record<string, 'openai' | 'anthropic' | 'openrouter' | 'typesafe'> = {
  openai: 'openai',
  'openai-codex': 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  typesafe: 'typesafe',
};

export function analyticsModel(provider: string, model?: string) {
  const hosted = Object.hasOwn(hostedProviders, provider) ? hostedProviders[provider] : undefined;
  return {
    provider: hosted ?? (provider === 'compatible' ? ('compatible' as const) : ('other' as const)),
    ...(model
      ? { model: hosted && /^[a-z0-9][a-z0-9._:/-]{0,119}$/.test(model) ? model : 'custom' }
      : {}),
  };
}

const workspaceTools = new Set(['read', 'bash', 'edit', 'write', 'find', 'ls', 'grep']);
const webTools = new Set(['web_search', 'fetch_content', 'get_search_content', 'code_search']);

export function toolUsed(event: Extract<RuntimeObservation, { type: 'tool_end' }>): AnalyticsEvent {
  return {
    event: 'otto_tool_used',
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
  const states = new Map<
    string,
    { enabled: boolean; version: number; revision?: string; controller: AbortController }
  >();
  const listeners = new Map<string, Set<(enabled: boolean) => void>>();
  const runs = new AsyncLocalStorage<{
    owner: string;
    id: string;
    turnId?: string;
    consent: ReturnType<typeof consent>;
  }>();
  const replaySessions = new Map<string, string>();
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
      deployment: 'local',
      environment: options.environment,
      ...(appVersion ? { appVersion } : {}),
    };
  }
  function capture(owner: string, event: AnalyticsEvent, delivery: AnalyticsDelivery = {}) {
    const config = configuration(owner);
    if (!config.enabled || !config.distinctId) return;
    const current = consent(owner);
    const run = runs.getStore();
    if (
      run &&
      (run.owner !== owner ||
        !run.consent.enabled ||
        run.consent.signal.aborted ||
        run.consent.version !== current.version)
    )
      return;
    const runId = delivery.runId ?? run?.id;
    if (runId !== undefined && !z.uuid().safeParse(runId).success) return;
    if (run && delivery.runId !== undefined && delivery.runId !== run.id) return;
    if (
      (delivery.consentRevision !== undefined && delivery.consentRevision !== current.revision) ||
      (options.provider?.consentRevision !== undefined &&
        options.provider.consentRevision !== current.revision)
    )
      return;
    const replaySession = z
      .uuid()
      .safeParse(
        delivery.replaySessionId ?? (run?.turnId ? replaySessions.get(run.turnId) : undefined),
      ).data;
    const parsed = analyticsEvent.safeParse(event);
    if (!parsed.success) return;
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
            deployment: 'local',
            environment: options.environment,
            capture_source: 'server',
            ...(version ? { app_version: version } : {}),
            ...(runId ? { run_id: runId } : {}),
            ...(replaySession ? { $session_id: replaySession } : {}),
            ...('properties' in parsed.data ? parsed.data.properties : {}),
          },
        },
        current.signal,
      );
    } catch {}
  }
  function setUsageData(
    owner: string,
    enabled: boolean,
    revision = options.provider?.consentRevision ?? state(owner).revision,
  ) {
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
    withRun<T>(owner: string, operation: () => T, turnId?: string): T {
      return runs.run({ owner, id: randomUUID(), turnId, consent: consent(owner) }, operation);
    },
    linkReplay(turnId: string, sessionId: string) {
      if (!z.uuid().safeParse(sessionId).success) return;
      if (replaySessions.size >= 1000) replaySessions.delete(replaySessions.keys().next().value!);
      replaySessions.set(turnId, sessionId.toLowerCase());
    },
    replaySession(turnId: string) {
      return replaySessions.get(turnId);
    },
    currentRun(owner: string) {
      const run = runs.getStore();
      return run?.owner === owner ? run : undefined;
    },
    async permitted(owner: string) {
      const current = consent(owner);
      if (!current.enabled) return false;
      const permitted = options.provider?.permitted
        ? await options.provider.permitted().catch(() => false)
        : true;
      if (current.signal.aborted || consent(owner).version !== current.version) return false;
      if (
        options.provider?.consentRevision !== undefined &&
        options.provider.consentRevision !== current.revision
      )
        setUsageData(owner, current.enabled && permitted, options.provider?.consentRevision);
      const latest = consent(owner);
      return (
        permitted && !current.signal.aborted && latest.enabled && latest.version === current.version
      );
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
    forOwner:
      (owner: string): CaptureAnalytics =>
      (event, delivery) =>
        capture(owner, event, delivery),
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
  { event: 'otto_settings_updated' }
>['properties']['section'];
type SettingsOperation = Extract<
  AnalyticsEvent,
  { event: 'otto_settings_updated' }
>['properties']['operation'];
const settings = (section: SettingsSection, operation: SettingsOperation): AnalyticsEvent => ({
  event: 'otto_settings_updated',
  properties: { section, operation },
});
const channel =
  (operation: SettingsOperation | ((provider: 'telegram' | 'whatsapp') => SettingsOperation)) =>
  (request: FastifyRequest): AnalyticsEvent | undefined => {
    const provider = z
      .enum(['telegram', 'whatsapp'])
      .safeParse(
        (request.params as { provider?: string }).provider ??
          (request.routeOptions.url?.includes('/telegram/') ? 'telegram' : undefined),
      ).data;
    if (!provider) return;
    return {
      event: 'otto_settings_updated',
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
  ['POST /api/conversation/reset', { event: 'otto_conversation_reset' }],
  ['POST /api/thread/stop', { event: 'otto_chat_stopped' }],
  ['POST /api/tasks/:id/stop', { event: 'otto_task_stopped' }],
  ['PATCH /api/preferences', settings('preferences', 'update')],
  [
    'PUT /api/channel-settings/:provider',
    channel((provider) => (provider === 'telegram' ? 'connect_started' : 'update')),
  ],
  ['POST /api/channel-settings/telegram/pairing', channel('connect_started')],
  ['POST /api/channel-settings/telegram/confirm', channel('update')],
  ['POST /api/channel-settings/telegram/user', channel('update')],
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
  ['PUT /api/integrations/key', settings('apps', 'update')],
  ['DELETE /api/integrations/key', settings('apps', 'disconnect')],
]);

export function registerAnalyticsRoutes(app: FastifyInstance, capture: CaptureAnalytics) {
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const action = analyticsRoutes.get(`${request.method} ${request.routeOptions.url}`);
    const event = typeof action === 'function' ? action(request) : action;
    if (event) capture(event);
  });
}
