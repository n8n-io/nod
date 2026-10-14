import { parse } from 'tldts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';

type ConnectionProperties = Extract<
  AnalyticsEvent,
  { event: 'otto_connection_changed' }
>['properties'];
type Connection = {
  app?: string;
  connection_method: ConnectionProperties['connection_method'];
  endpoint?: string;
};

const domains = {
  gmail: 'google.com',
  googlecalendar: 'google.com',
  googledrive: 'google.com',
  googlesheets: 'google.com',
  googledocs: 'google.com',
  slack: 'slack.com',
  notion: 'notion.so',
  linear: 'linear.app',
} as const;

export function analyticsDomain(endpoint: string) {
  try {
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol)) return undefined;
    const parsed = parse(url.hostname, { allowPrivateDomains: false });
    return parsed.isIcann && !parsed.isIp && parsed.domain ? parsed.domain : undefined;
  } catch {
    return undefined;
  }
}

function properties(connection: Connection) {
  const app: ConnectionProperties['app'] =
    connection.app && Object.hasOwn(domains, connection.app)
      ? (connection.app as keyof typeof domains)
      : 'custom';
  const domain =
    connection.connection_method === 'managed_app'
      ? app === 'custom'
        ? undefined
        : domains[app]
      : connection.connection_method !== 'cli' && connection.endpoint
        ? analyticsDomain(connection.endpoint)
        : undefined;
  return {
    app,
    ...(domain ? { domain } : {}),
    connection_method: connection.connection_method,
  };
}

export function captureConnection(
  analytics: CaptureAnalytics | undefined,
  connection: Connection,
  status: ConnectionProperties['status'],
  failure_reason?: ConnectionProperties['failure_reason'],
) {
  analytics?.({
    event: 'otto_connection_changed',
    properties: {
      ...properties(connection),
      status,
      ...(failure_reason ? { failure_reason } : {}),
    },
  });
}

export async function withServiceAnalytics<T>(
  analytics: CaptureAnalytics | undefined,
  connection: Connection,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  succeeded: (result: T) => boolean = () => true,
) {
  const started = performance.now();
  const capture = (outcome: 'succeeded' | 'failed' | 'cancelled') =>
    analytics?.({
      event: 'otto_service_used',
      properties: {
        ...properties(connection),
        outcome,
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
      },
    });
  try {
    const result = await operation();
    capture(succeeded(result) ? 'succeeded' : 'failed');
    return result;
  } catch (error) {
    capture(signal?.aborted ? 'cancelled' : 'failed');
    throw error;
  }
}
