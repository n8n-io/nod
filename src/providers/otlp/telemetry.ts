import { createHmac, randomBytes } from 'node:crypto';
import type { UsageTelemetry } from '../../ports/provider-usage.ts';

function attribute(key: string, value: string | number | undefined, integer = false) {
  if (value === undefined || (typeof value === 'number' && (!Number.isFinite(value) || value < 0)))
    return [];
  return [
    {
      key,
      value:
        typeof value === 'string'
          ? { stringValue: value.slice(0, 256) }
          : integer
            ? { intValue: String(Math.floor(value)) }
            : { doubleValue: value },
    },
  ];
}

export function createOtlpTelemetry(endpoint?: string): UsageTelemetry | undefined {
  if (!endpoint?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new Error(
      'The OTLP endpoint must use HTTP or HTTPS without credentials, queries or fragments.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/traces`;
  const salt = randomBytes(32);
  const queue: unknown[] = [];
  let pending: Promise<void> | undefined;
  let closed = false;

  function flush(): Promise<void> {
    if (pending) return pending;
    if (!queue.length) return Promise.resolve();
    const spans = queue.splice(0);
    pending = (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resourceSpans: [
              {
                resource: { attributes: attribute('service.name', 'nod') },
                scopeSpans: [{ scope: { name: 'nod.model' }, spans }],
              },
            ],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
      } catch {
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  const timer = setInterval(() => void flush(), 5_000);
  timer.unref();
  return {
    record(usage) {
      if (closed || queue.length >= 256) return;
      const end = Date.now();
      const duration = Math.max(0, Math.min(end, Math.round(usage.durationMs) || 0));
      queue.push({
        traceId: createHmac('sha256', salt)
          .update(usage.turnId ?? usage.id)
          .digest('hex')
          .slice(0, 32),
        spanId: randomBytes(8).toString('hex'),
        name: 'chat',
        kind: 3,
        startTimeUnixNano: String(BigInt(end - duration) * 1_000_000n),
        endTimeUnixNano: String(BigInt(end) * 1_000_000n),
        status: { code: usage.status === 'failed' ? 2 : 0 },
        attributes: [
          ...attribute('gen_ai.operation.name', 'chat'),
          ...attribute('gen_ai.provider.name', usage.provider),
          ...attribute('gen_ai.request.model', usage.model),
          ...attribute('nod.category', usage.category),
          ...attribute('nod.operation', usage.operation),
          ...attribute('nod.status', usage.status),
          ...attribute('nod.usage.pricing', usage.pricing),
          ...attribute(
            'gen_ai.usage.input_tokens',
            usage.inputTokens === undefined &&
              usage.cacheReadTokens === undefined &&
              usage.cacheWriteTokens === undefined
              ? undefined
              : (usage.inputTokens ?? 0) +
                  (usage.cacheReadTokens ?? 0) +
                  (usage.cacheWriteTokens ?? 0),
            true,
          ),
          ...attribute('gen_ai.usage.output_tokens', usage.outputTokens, true),
          ...attribute('gen_ai.usage.cache_read.input_tokens', usage.cacheReadTokens, true),
          ...attribute('gen_ai.usage.cache_creation.input_tokens', usage.cacheWriteTokens, true),
          ...attribute('nod.usage.cost_usd', usage.costUsd ?? undefined),
          ...attribute('nod.usage.estimated_cost_usd', usage.estimateUsd ?? undefined),
        ],
      });
    },
    async shutdown() {
      closed = true;
      clearInterval(timer);
      await pending;
      await flush();
    },
  };
}
