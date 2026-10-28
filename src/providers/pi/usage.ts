import { createHash } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ModelUsageObservation } from '../../ports/agent.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import type { Usage } from '@earendil-works/pi-ai';

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function costEstimate(value: unknown, usage?: Usage): number | null {
  if (usage && 'audioPricing' in usage && usage.audioPricing === 'unavailable') return null;
  if (!value || typeof value !== 'object') return null;
  const cost = value as Record<string, unknown>;
  const names = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
  if (
    !names.every(
      (name) =>
        typeof cost[name] === 'number' &&
        Number.isFinite(cost[name]) &&
        cost[name] >= 0 &&
        cost[name] <= Number.MAX_SAFE_INTEGER,
    )
  )
    return null;
  const total = cost.total as number;
  const sum = names.slice(0, -1).reduce((result, name) => result + (cost[name] as number), 0);
  if (Math.abs(sum - total) > 1e-8 * Math.max(1, total)) return null;
  return total;
}

function messageKey(message: AssistantMessage) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.provider,
        message.api,
        message.model,
        message.responseId || [
          message.timestamp,
          message.stopReason,
          message.content,
          message.usage,
        ],
      ]),
    )
    .digest('hex');
}

function identifier(value: string, fallback: string) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)
    ? value
    : fallback;
}

export function usageId(sessionId: string, key: string) {
  const bytes = createHash('sha256')
    .update(sessionId + ':' + key)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function piUsageMetrics(usage?: Usage): Partial<ProviderUsageEvent> {
  if (!usage) return {};
  const estimate = costEstimate(usage.cost, usage);
  const costUsd =
    estimate === 0 &&
    ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].some(
      (value) => tokenCount(value) && value > 0,
    )
      ? null
      : estimate;
  return {
    ...(tokenCount(usage.input) ? { inputTokens: usage.input } : {}),
    ...(tokenCount(usage.output) ? { outputTokens: usage.output } : {}),
    ...(tokenCount(usage.cacheRead) ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(tokenCount(usage.cacheWrite) ? { cacheWriteTokens: usage.cacheWrite } : {}),
    costUsd,
    pricing: costUsd === null ? 'unavailable' : 'sdk_estimate',
  };
}

export function createPiUsageTracker(options: {
  sessionId: string;
  provider: string;
  model: string;
  history: Iterable<AssistantMessage>;
}) {
  const seen = new Set([...options.history].map(messageKey));
  return (message: AssistantMessage): ModelUsageObservation | undefined => {
    if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(message.stopReason)) return;
    const usage = message.usage;
    const key = messageKey(message);
    if (seen.has(key)) return;
    const values = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite];
    const tokens = values.map((value) => (tokenCount(value) ? value : 0));
    const sum = tokens.reduce((result, value) => result + value, 0);
    const costUsd = piUsageMetrics(usage).costUsd ?? null;
    seen.add(key);
    const timestamp =
      typeof message.timestamp === 'number' &&
      Number.isFinite(new Date(message.timestamp).getTime())
        ? message.timestamp
        : Date.now();
    return {
      type: 'model_usage',
      status:
        message.stopReason === 'error'
          ? 'failed'
          : message.stopReason === 'aborted'
            ? 'cancelled'
            : 'succeeded',
      id: usageId(options.sessionId, key),
      provider: identifier(message.provider, options.provider),
      model: identifier(message.model, options.model),
      inputTokens: tokens[0],
      outputTokens: tokens[1],
      cacheReadTokens: tokens[2],
      cacheWriteTokens: tokens[3],
      totalTokens: tokenCount(usage?.totalTokens)
        ? usage.totalTokens
        : Number.isSafeInteger(sum)
          ? sum
          : 0,
      costUsd,
      costSource: costUsd === null ? 'unavailable' : 'sdk_estimate',
      createdAt: new Date(timestamp).toISOString(),
    };
  };
}
