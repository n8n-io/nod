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
  analyticsModelProvider,
  analyticsTool,
  analyticsVersion,
  type AnalyticsEvent,
} from './analytics-events.ts';
import type { RuntimeObservation } from '../ports/agent.ts';
import { analyticsDomain } from './analytics-connections.ts';

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
export type MemoryChange = Extract<AnalyticsEvent, { event: 'nod_memory_changed' }>['properties'];

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

const hostedProviders = {
  openai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  'amazon-bedrock': 'amazon-bedrock',
  'google-vertex': 'google-vertex',
  azure: 'azure',
  typesafe: 'typesafe',
} as const;

export function analyticsModel(provider: string, model?: string) {
  const hosted = Object.hasOwn(hostedProviders, provider)
    ? hostedProviders[provider as keyof typeof hostedProviders]
    : undefined;
  return {
    provider: hosted ?? (provider === 'compatible' ? ('compatible' as const) : ('other' as const)),
    ...(model
      ? { model: hosted && /^[a-z0-9][a-z0-9._:/-]{0,119}$/.test(model) ? model : 'custom' }
      : {}),
  };
}

export type TurnModel = { model_provider: z.infer<typeof analyticsModelProvider>; model?: string };

function turnModel(provider: TurnModel['model_provider'], model?: string): TurnModel {
  return { model_provider: provider, ...(model ? { model } : {}) };
}

const readVerbs = new Set([
  'get',
  'list',
  'fetch',
  'search',
  'find',
  'read',
  'retrieve',
  'query',
  'lookup',
  'view',
  'describe',
  'download',
]);

function sideEffect(action: string) {
  if (action === 'NOD_vault_allow' || action === 'SEARCH_TOOLS') return;
  if (action === 'NOD_browser') return 'action';
  if (action.startsWith('NOD_')) return 'settings';
  return action
    .split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((word) => readVerbs.has(word.toLowerCase()))
    ? undefined
    : 'action';
}

const workspaceTools = new Set(['read', 'bash', 'edit', 'write', 'find', 'ls', 'grep']);
const webTools = new Set(['web_search', 'fetch_content', 'get_search_content', 'code_search']);

export function toolUsed(event: Extract<RuntimeObservation, { type: 'tool_end' }>): AnalyticsEvent {
  return {
    event: 'nod_tool_used',
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
    model?: TurnModel;
  }>();
  const replaySessions = new Map<string, string>();
  const actedRuns = new Map<string, 'action' | 'settings'>();
  function acted(runId: string, kind: 'action' | 'settings') {
    if (actedRuns.get(runId) === 'action') return;
    if (actedRuns.size >= 1000) actedRuns.delete(actedRuns.keys().next().value!);
    actedRuns.set(runId, kind);
  }
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
    if (delivery.consentRevision !== undefined && delivery.consentRevision !== current.revision)
      return;
    const replaySession = z
      .uuid()
      .safeParse(
        delivery.replaySessionId ?? (run?.turnId ? replaySessions.get(run.turnId) : undefined),
      ).data;
    const parsed = analyticsEvent.safeParse(event);
    if (!parsed.success) return;
    if (
      runId &&
      parsed.data.event === 'nod_secure_entry_changed' &&
      parsed.data.properties.kind === 'payment' &&
      parsed.data.properties.status === 'submitted'
    )
      acted(runId, 'action');
    if (run) {
      const { data } = parsed;
      if (data.event === 'nod_turn_started' && data.properties.model_provider)
        run.model ??= turnModel(data.properties.model_provider, data.properties.model);
      if (data.event === 'nod_model_used' && data.properties.purpose === 'agent')
        run.model = turnModel(data.properties.provider, data.properties.model);
      if (data.event === 'nod_turn_completed' && run.model) {
        const { model_provider: _, model: __, ...properties } = data.properties;
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
            ...(replaySession ? { $session_id: replaySession } : {}),
            ...('properties' in parsed.data ? parsed.data.properties : {}),
          },
        },
        current.signal,
      );
    } catch {}
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
    sideEffect(runId: string) {
      return actedRuns.get(runId);
    },
    actionExecuted(owner: string, action: string) {
      const run = runs.getStore();
      const kind = sideEffect(action);
      if (run?.owner === owner && run.consent.enabled && kind) acted(run.id, kind);
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
  { event: 'nod_settings_updated' }
>['properties']['section'];
type SettingsOperation = Extract<
  AnalyticsEvent,
  { event: 'nod_settings_updated' }
>['properties']['operation'];
const settings = (section: SettingsSection, operation: SettingsOperation): AnalyticsEvent => ({
  event: 'nod_settings_updated',
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
      event: 'nod_settings_updated',
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
  ['POST /api/conversation/reset', { event: 'nod_conversation_reset' }],
  ['POST /api/thread/stop', { event: 'nod_chat_stopped' }],
  ['POST /api/tasks/:id/stop', { event: 'nod_task_stopped' }],
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
  [
    'POST /api/link-preview/opened',
    (request) => {
      const body = request.body as {
        url: string;
        source: 'text' | 'preview' | 'tooltip' | 'player';
        position?: number;
      };
      const domain = analyticsDomain(body.url);
      return domain
        ? {
            event: 'nod_link_opened',
            properties: {
              domain,
              source: body.source,
              ...(body.position && body.position <= 20 ? { position: body.position } : {}),
            },
          }
        : undefined;
    },
  ],
]);

export function registerAnalyticsRoutes(app: FastifyInstance, capture: CaptureAnalytics) {
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const action = analyticsRoutes.get(`${request.method} ${request.routeOptions.url}`);
    const event = typeof action === 'function' ? action(request) : action;
    if (event) capture(event);
  });
}
