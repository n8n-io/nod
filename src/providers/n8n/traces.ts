import type { ModelTrace, ModelTraceDelivery } from '../../ports/traces.ts';

const traceBytes = 8 * 1024 * 1024;

export function createN8nTraces(options: {
  url?: string;
  token?: string;
  request?: typeof fetch;
}): ModelTraceDelivery | undefined {
  if (!options.url || !options.token) return undefined;
  const token = options.token;
  const endpoint = new URL(options.url);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('The traces URL must use HTTPS without credentials, queries or fragments.');
  const request = options.request ?? fetch;
  return async (trace: ModelTrace, signal: AbortSignal) => {
    const body = JSON.stringify({
      version: 1,
      run: {
        id: trace.id,
        name: trace.name,
        provider: trace.provider,
        start_time: trace.startedAt,
        end_time: trace.endedAt,
        inputs: { messages: trace.messages, tools: trace.tools },
        outputs: trace.output,
        ...(trace.error ? { error: trace.error } : {}),
        usage: {
          input_tokens: trace.usage.inputTokens,
          output_tokens: trace.usage.outputTokens,
          total_tokens: trace.usage.totalTokens,
          input_token_details: {
            cache_read: trace.usage.cacheReadTokens,
            cache_creation: trace.usage.cacheWriteTokens,
          },
          ...(trace.usage.costUsd === null ? {} : { total_cost: trace.usage.costUsd }),
        },
        metadata: trace.metadata,
      },
    });
    if (Buffer.byteLength(body) > traceBytes) return;
    const response = await request(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-nod-traces-token': token },
      body,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), signal]),
    });
    await response.body?.cancel();
  };
}
