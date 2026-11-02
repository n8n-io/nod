const areas = [
  'application',
  'onboarding',
  'chat',
  'settings',
  'apps',
  'models',
  'browser',
  'channels',
  'tasks',
  'usage',
  'vault',
  'feedback',
  'other',
];
const actions = ['load', 'save', 'send', 'connect', 'disconnect', 'prepare', 'stop', 'render'];
const failures = [
  'authentication',
  'permission',
  'rate_limited',
  'timeout',
  'unavailable',
  'invalid_request',
  'cancelled',
  'unknown',
  'invalid_configuration',
  'authorization_failed',
  'verification_failed',
];
const providers = [
  'openai',
  'anthropic',
  'openrouter',
  'amazon-bedrock',
  'google-vertex',
  'azure',
  'compatible',
  'other',
];
const methods = ['managed_app', 'browser', 'http', 'mcp', 'cli'];
const statuses = ['started', 'connected', 'failed', 'disconnected'];
const fields: Record<string, Record<string, readonly unknown[] | number>> = {
  screen: {
    screen: [
      '/',
      '/onboarding',
      '/apps',
      '/channels',
      '/tasks',
      '/usage',
      '/vault',
      '/settings',
      '/browser',
      '/credentials',
      '/payments',
      '/not-found',
    ],
  },
  request_failed: {
    area: areas,
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'other'],
    status: 599,
    reason: ['http', 'network', 'timeout', 'invalid_response'],
  },
  ui_error: { area: areas, action: actions },
  connection_changed: {
    app: [...integrationServiceIds, 'custom'],
    connection_method: methods,
    status: statuses,
    failure_reason: failures,
  },
  model_connection_changed: {
    provider: providers,
    method: ['api_key', 'subscription', 'oauth'],
    status: statuses,
  },
  service_used: {
    app: [...integrationServiceIds, 'custom'],
    connection_method: methods,
    outcome: ['succeeded', 'failed', 'cancelled'],
    duration_ms: 86_400_000,
    failure_reason: failures,
  },
};

export interface FeedbackActivity {
  source: 'app' | 'runtime';
  ageMs: number;
  event: string;
  properties: Record<string, string | number>;
}

function properties(event: unknown, value: unknown) {
  if (typeof event !== 'string' || !Object.hasOwn(fields, event)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const output: Record<string, string | number> = {};
  for (const [key, allowed] of Object.entries(fields[event])) {
    const item = input[key];
    if (typeof allowed === 'number') {
      if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= allowed)
        output[key] = item;
    } else if (typeof item === 'string' && allowed.includes(item)) output[key] = item;
    else if (key === 'app' && typeof item === 'string') output[key] = 'custom';
  }
  return Object.keys(output).length ? output : null;
}

export function parseFeedbackActivity(value: unknown): FeedbackActivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const clean = properties(row.event, row.properties);
    if (
      !clean ||
      !['app', 'runtime'].includes(String(row.source)) ||
      typeof row.ageMs !== 'number' ||
      !Number.isFinite(row.ageMs) ||
      row.ageMs < 0 ||
      row.ageMs > 1_800_000
    )
      return [];
    return [
      {
        source: row.source as FeedbackActivity['source'],
        ageMs: Math.floor(row.ageMs / 1000) * 1000,
        event: row.event as string,
        properties: clean,
      },
    ];
  });
}

export function createFeedbackActivity(source: FeedbackActivity['source']) {
  const entries: Array<{ at: number; event: string; properties: Record<string, string | number> }> =
    [];
  let lastScreen: { at: number; value: string | number } | undefined;
  return {
    record(event: string, value: unknown) {
      const clean = properties(event, value);
      if (!clean) return;
      const at = Date.now();
      if (event === 'screen') {
        if (lastScreen?.value === clean.screen && at - lastScreen.at <= 1_800_000) return;
        lastScreen = { at, value: clean.screen };
      }
      entries.push({ at, event, properties: clean });
      if (entries.length > 100) entries.shift();
    },
    snapshot(): FeedbackActivity[] {
      const now = Date.now();
      return parseFeedbackActivity(
        entries.map(({ at, ...entry }) => ({ ...entry, source, ageMs: now - at })),
      );
    },
    clear() {
      entries.length = 0;
      lastScreen = undefined;
    },
  };
}
import { integrationServiceIds } from './integrations.ts';
