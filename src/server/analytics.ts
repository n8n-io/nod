import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProductAnalytics } from '../ports/analytics.ts';
import { posthogConfig, type AnalyticsConfiguration } from '../shared/analytics.ts';

const turnProperties = z.object({
  source: z.enum(['user', 'schedule', 'event', 'resume']),
  channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
  background: z.boolean(),
});
const analyticsEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('otto_onboarding_completed') }).strict(),
  z.object({ event: z.literal('otto_conversation_reset') }).strict(),
  z.object({ event: z.literal('otto_chat_stopped') }).strict(),
  z.object({ event: z.literal('otto_turn_started'), properties: turnProperties.strict() }).strict(),
  z
    .object({
      event: z.literal('otto_turn_completed'),
      properties: turnProperties
        .extend({
          outcome: z.enum([
            'succeeded',
            'waiting_credentials',
            'waiting_user',
            'failed',
            'cancelled',
            'interrupted',
          ]),
          duration_ms: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_settings_updated'),
      properties: z
        .object({
          section: z.enum(['account', 'preferences', 'connections', 'channels', 'models']),
          operation: z.enum(['update', 'connect_started', 'disconnect']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_schedule_changed'),
      properties: z.object({ operation: z.enum(['create', 'update', 'delete']) }).strict(),
    })
    .strict(),
]);

export type AnalyticsEvent = z.infer<typeof analyticsEvent>;
export type CaptureAnalytics = (event: AnalyticsEvent) => void;

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
}) {
  const localId =
    options.provider && options.deployment === 'local'
      ? await installationId(options.dataRoot, options.installationId).catch(() => null)
      : null;
  const available = Boolean(options.provider && (options.deployment === 'hosted' || localId));
  const usageData = new Map<string, boolean>();
  function configuration(owner: string | null): AnalyticsConfiguration {
    const enabled = available && !!owner && usageData.get(owner) === true;
    return {
      enabled,
      distinctId: enabled
        ? options.deployment === 'hosted'
          ? `hosted:${owner}`
          : `local:${localId}`
        : null,
      deployment: options.deployment,
      environment: options.environment,
    };
  }
  function capture(owner: string, event: AnalyticsEvent) {
    const config = configuration(owner);
    if (!config.enabled || !config.distinctId) return;
    const parsed = analyticsEvent.safeParse(event);
    if (!parsed.success) return;
    try {
      options.provider?.capture({
        distinctId: config.distinctId,
        event: parsed.data.event,
        properties: {
          analytics_schema: posthogConfig.schemaVersion,
          deployment: options.deployment,
          environment: options.environment,
          capture_source: 'server',
          ...('properties' in parsed.data ? parsed.data.properties : {}),
        },
      });
    } catch {}
  }
  return {
    configuration,
    capture,
    setUsageData(owner: string, enabled: boolean) {
      usageData.set(owner, enabled);
    },
    forOwner:
      (owner: string): CaptureAnalytics =>
      (event) =>
        capture(owner, event),
    shutdown: async () => {
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
      'POST /api/apps/:slug/connect',
      {
        event: 'otto_settings_updated',
        properties: { section: 'connections', operation: 'connect_started' },
      },
    ],
    [
      'POST /api/apps/discovery/:id/authorize',
      {
        event: 'otto_settings_updated',
        properties: { section: 'connections', operation: 'connect_started' },
      },
    ],
    [
      'POST /api/apps/discovery/:id/complete',
      {
        event: 'otto_settings_updated',
        properties: { section: 'connections', operation: 'update' },
      },
    ],
    [
      'POST /api/apps/:slug/accounts/:connectionId/disconnect',
      {
        event: 'otto_settings_updated',
        properties: { section: 'connections', operation: 'disconnect' },
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
