import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Service } from './oauth.ts';
import { loadDirectPlugin } from './plugin.ts';

export async function withDirectMcp<T>(
  service: Service,
  accessToken: string,
  request: typeof fetch,
  operation: (client: Client) => Promise<T>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const client = new Client({ name: 'Otto', version: '0.1.0' });
  const endpoint = await loadDirectPlugin(service);
  signal?.throwIfAborted();
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: (input, init) =>
      request(input, {
        ...init,
        ...(signal
          ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }
          : {}),
      }),
  });
  const abort = () => void client.close().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect(transport);
    signal?.throwIfAborted();
    const result = await operation(client);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.close().catch(() => {});
  }
}
