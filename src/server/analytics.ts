import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { posthogConfig, type AnalyticsConfiguration } from '../shared/analytics.ts';

import { analyticsEvent, analyticsVersion, type AnalyticsEvent } from './analytics-events.ts';

export type { AnalyticsEvent } from './analytics-events.ts';
export interface AnalyticsDelivery {
  uuid?: string;
  timestamp?: Date;
  appVersion?: string;
  consentRevision?: string;
  runId?: string;
}
export type CaptureAnalytics = (event: AnalyticsEvent, delivery?: AnalyticsDelivery) => void;

export function analyticsEnabled(env: Record<string, string | undefined>) {
  const production = ['gateway', 'tenant'].includes(env.OTTO_MODE ?? '')
    ? env.OTTO_ENVIRONMENT === 'production'
    : env.NODE_ENV === 'production';
  return (
    env.OTTO_ANALYTICS_ENABLED === 'true' || (env.OTTO_ANALYTICS_ENABLED !== 'false' && production)
  );
}

export function analyticsEnvironment(
  env: Record<string, string | undefined>,
): AnalyticsConfiguration['environment'] {
  const explicit = z.enum(['development', 'production']).safeParse(env.OTTO_ANALYTICS_ENVIRONMENT);
  if (explicit.success) return explicit.data;
  if (['gateway', 'tenant'].includes(env.OTTO_MODE ?? ''))
    return env.OTTO_ENVIRONMENT === 'production' ? 'production' : 'development';
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

export async function createAnalytics(options: {
  provider?: ProductAnalytics;
  deployment: AnalyticsConfiguration['deployment'];
  environment: AnalyticsConfiguration['environment'];
  dataRoot: string;
  installationId?: string;
  appVersion?: string;
}) {
  const appVersion = analyticsVersion.safeParse(options.appVersion).data;
  const localId =
    options.provider && options.deployment === 'local'
      ? await installationId(options.dataRoot, options.installationId).catch(() => null)
      : null;
  const available = Boolean(options.provider && (options.deployment === 'hosted' || localId));
  const states = new Map<
    string,
    { enabled: boolean; version: number; revision?: string; controller: AbortController }
  >();
  const listeners = new Map<string, Set<(enabled: boolean) => void>>();
  const runs = new AsyncLocalStorage<{
    owner: string;
    id: string;
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
      distinctId: enabled
        ? options.deployment === 'hosted'
          ? `hosted:${owner}`
          : `local:${localId}`
        : null,
      deployment: options.deployment,
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
            deployment: options.deployment,
            environment: options.environment,
            capture_source: 'server',
            ...(version ? { app_version: version } : {}),
            ...(runId ? { run_id: runId } : {}),
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
    withRun<T>(owner: string, operation: () => T): T {
      return runs.run({ owner, id: randomUUID(), consent: consent(owner) }, operation);
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

export function registerAnalyticsRoutes(app: FastifyInstance, capture: CaptureAnalytics) {
  const actions = new Map<string, AnalyticsEvent>([
    ['POST /api/conversation/reset', { event: 'otto_conversation_reset' }],
    ['POST /api/thread/stop', { event: 'otto_chat_stopped' }],
    [
      'PATCH /api/preferences',
      {
        event: 'otto_settings_updated',
        properties: { section: 'preferences', operation: 'update' },
      },
    ],
    [
      'PUT /api/channel-settings/:provider',
      { event: 'otto_settings_updated', properties: { section: 'channels', operation: 'update' } },
    ],
    [
      'POST /api/channel-settings/telegram/pairing',
      { event: 'otto_settings_updated', properties: { section: 'channels', operation: 'update' } },
    ],
    [
      'POST /api/channel-settings/telegram/confirm',
      { event: 'otto_settings_updated', properties: { section: 'channels', operation: 'update' } },
    ],
    [
      'POST /api/channel-settings/telegram/user',
      { event: 'otto_settings_updated', properties: { section: 'channels', operation: 'update' } },
    ],
    [
      'DELETE /api/channel-settings/:provider',
      {
        event: 'otto_settings_updated',
        properties: { section: 'channels', operation: 'disconnect' },
      },
    ],
    [
      'POST /api/models/keys',
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ],
    [
      'POST /api/models/endpoints',
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ],
    [
      'POST /api/models/oauth',
      {
        event: 'otto_settings_updated',
        properties: { section: 'models', operation: 'connect_started' },
      },
    ],
    [
      'POST /api/models/oauth/complete',
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ],
    [
      'POST /api/models/connections/:id/refresh',
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ],
    [
      'PUT /api/models/selection',
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ],
    [
      'DELETE /api/models/connections/:id',
      {
        event: 'otto_settings_updated',
        properties: { section: 'models', operation: 'disconnect' },
      },
    ],
  ]);
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const event = actions.get(`${request.method} ${request.routeOptions.url}`);
    if (event) capture(event);
  });
}
