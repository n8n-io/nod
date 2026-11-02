import type { Analytics, AnalyticsEvent, CaptureAnalytics } from './analytics.ts';

type ConnectionProperties = Extract<AnalyticsEvent, { event: 'connection_changed' }>['properties'];
type ServiceFailureReason = NonNullable<
  Extract<AnalyticsEvent, { event: 'service_used' }>['properties']['failure_reason']
>;
export type AnalyticsConnection = {
  app?: string;
  publicApp?: boolean;
  operation_phase?: 'preparation';
  connection_method: ConnectionProperties['connection_method'];
  endpoint?: string;
  consentRevision?: string;
};

function properties(connection: AnalyticsConnection) {
  const app =
    connection.connection_method === 'managed_app' &&
    connection.publicApp &&
    connection.app &&
    /^[a-z][a-z0-9_-]{0,79}$/.test(connection.app)
      ? connection.app
      : 'custom';
  return { app, connection_method: connection.connection_method };
}

export function captureConnection(
  analytics: CaptureAnalytics | undefined,
  connection: AnalyticsConnection,
  status: ConnectionProperties['status'],
  failure_reason?: ConnectionProperties['failure_reason'],
) {
  analytics?.(
    {
      event: 'connection_changed',
      properties: {
        ...properties(connection),
        status,
        ...(failure_reason ? { failure_reason } : {}),
      },
    },
    { consentRevision: connection.consentRevision },
  );
}

export function serviceFailureReason(error: unknown): ServiceFailureReason {
  if (!error || typeof error !== 'object') return 'unknown';
  const value = error as {
    reason?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    cause?: unknown;
  };
  const reasons: Record<string, ServiceFailureReason> = {
    authorization: 'authentication',
    authentication: 'authentication',
    permission: 'permission',
    rate_limit: 'rate_limited',
    rate_limited: 'rate_limited',
    timeout: 'timeout',
    unavailable: 'unavailable',
    invalid_request: 'invalid_request',
    cancelled: 'cancelled',
    unknown: 'unknown',
  };
  if (typeof value.reason === 'string' && Object.hasOwn(reasons, value.reason))
    return reasons[value.reason]!;
  const status = value.status ?? value.statusCode;
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 429) return 'rate_limited';
  if (
    status === 408 ||
    status === 504 ||
    value.name === 'TimeoutError' ||
    value.code === 'ETIMEDOUT'
  )
    return 'timeout';
  if (status === 400 || status === 404 || status === 409 || status === 422)
    return 'invalid_request';
  if (
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(value.code))
  )
    return 'unavailable';
  if (value.name === 'AbortError') return 'cancelled';
  return 'unknown';
}

export function captureServiceFailure(
  analytics: CaptureAnalytics | undefined,
  connection: AnalyticsConnection,
  error: unknown,
  started: number,
  signal?: AbortSignal,
) {
  analytics?.(
    {
      event: 'service_used',
      properties: {
        ...properties(connection),
        ...(connection.operation_phase ? { operation_phase: connection.operation_phase } : {}),
        outcome: signal?.aborted ? 'cancelled' : 'failed',
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        failure_reason: signal?.aborted ? 'cancelled' : serviceFailureReason(error),
      },
    },
    { consentRevision: connection.consentRevision },
  );
}

export async function withServiceAnalytics<T>(
  analytics: CaptureAnalytics | undefined,
  connection: AnalyticsConnection,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  succeeded: (result: T) => boolean = () => true,
  classify: (value: unknown) => ServiceFailureReason = serviceFailureReason,
) {
  const started = performance.now();
  const capture = (outcome: 'succeeded' | 'failed' | 'cancelled', error?: unknown) =>
    analytics?.(
      {
        event: 'service_used',
        properties: {
          ...properties(connection),
          outcome,
          ...(connection.operation_phase ? { operation_phase: connection.operation_phase } : {}),
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          ...(outcome !== 'succeeded'
            ? { failure_reason: outcome === 'cancelled' ? 'cancelled' : classify(error) }
            : {}),
        },
      },
      { consentRevision: connection.consentRevision },
    );
  try {
    const result = await operation();
    capture(succeeded(result) ? 'succeeded' : 'failed', result);
    return result;
  } catch (error) {
    capture(signal?.aborted ? 'cancelled' : 'failed', error);
    throw error;
  }
}

export async function captureConnectionInventory(
  analytics: Analytics,
  ownerId: string,
  read: () => Promise<AnalyticsConnection[]>,
  models: () => Extract<
    AnalyticsEvent,
    { event: 'model_connection_observed' }
  >['properties'][] = () => [],
) {
  const consent = analytics.consent(ownerId);
  if (!consent.enabled || !(await analytics.permitted(ownerId))) return;
  const connections = await read();
  if (consent.signal.aborted || analytics.consent(ownerId).version !== consent.version) return;
  const seen = new Set<string>();
  for (const connection of connections) {
    const value = properties(connection);
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    analytics.capture(
      ownerId,
      {
        event: 'connection_observed',
        properties: value,
      },
      { consentRevision: consent.revision },
    );
  }
  for (const properties of models())
    analytics.capture(
      ownerId,
      { event: 'model_connection_observed', properties },
      { consentRevision: consent.revision },
    );
}
