import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { publicUrl } from '../agent-browser/network.ts';
import type { DiscoveredTransport } from '../../ports/discovered.ts';
import { appFile, mcpFiles } from '../app-files.ts';
import { fileBytes } from '../../shared/files.ts';

const textType =
  /^$|^text\/|[/+]json\b|[/+]xml\b|^application\/(x-www-form-urlencoded|javascript)\b/i;

function decoded(name: string) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function failureText(content: unknown) {
  const blocks = Array.isArray(content) ? (content as Array<{ text?: string }>) : [];
  const text = blocks
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  return (text || JSON.stringify(content ?? null)).slice(0, 4000);
}

const responseBytes = Math.ceil(fileBytes / 3) * 4 + 1024 * 1024;

export async function safeRemoteFetch(
  input: string | URL | Request,
  init?: RequestInit,
  dependencies = { validate: publicUrl, request: httpsRequest },
  maximumRequestBytes = fileBytes,
  redirects = 5,
): Promise<Response> {
  const prepared = new Request(input, init);
  const signal = AbortSignal.any([prepared.signal, AbortSignal.timeout(600_000)]);
  signal.throwIfAborted();
  const { url, address } = await new Promise<Awaited<ReturnType<typeof publicUrl>>>(
    (resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        operation();
      };
      const abort = () => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      dependencies.validate(prepared.url).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) abort();
    },
  );
  signal.throwIfAborted();
  if (url.protocol !== 'https:') throw new Error('The connection must use HTTPS.');
  const body = Buffer.from(await prepared.arrayBuffer());
  signal.throwIfAborted();
  if (body.byteLength > maximumRequestBytes) throw new Error('The request is too large.');
  return new Promise<Response>((resolve, reject) => {
    const outbound = dependencies.request(
      url,
      {
        method: prepared.method,
        headers: Object.fromEntries(prepared.headers),
        signal,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address, family: isIP(address) }]);
          else callback(null, address, isIP(address));
        },
      },
      (incoming) => {
        if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) {
          incoming.destroy();
          const location = incoming.headers.location;
          if (!location || redirects <= 0) {
            reject(new Error('The connection redirected too many times or without a location.'));
            return;
          }
          const next = URL.parse(location, url);
          if (!next) {
            reject(new Error('The connection redirected to an invalid address.'));
            return;
          }
          const headers = new Headers(prepared.headers);
          if (next.origin !== url.origin)
            for (const name of [...headers.keys()])
              if (!['accept', 'content-type', 'user-agent'].includes(name)) headers.delete(name);
          const keep = !(
            (incoming.statusCode === 303 && !['GET', 'HEAD'].includes(prepared.method)) ||
            ([301, 302].includes(incoming.statusCode) && prepared.method === 'POST')
          );
          resolve(
            safeRemoteFetch(
              next,
              {
                method: keep ? prepared.method : 'GET',
                headers,
                ...(keep && body.byteLength ? { body } : {}),
                signal,
              },
              dependencies,
              maximumRequestBytes,
              redirects - 1,
            ),
          );
          return;
        }
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > responseBytes)
            incoming.destroy(new Error('The connection response is too large.'));
        });
        incoming.on('error', reject);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') responseHeaders.set(name, value);
          else if (Array.isArray(value))
            for (const item of value) responseHeaders.append(name, item);
        }
        resolve(
          new Response(
            [204, 205, 304].includes(incoming.statusCode ?? 0)
              ? null
              : (Readable.toWeb(incoming) as ReadableStream),
            {
              status: incoming.statusCode ?? 502,
              headers: responseHeaders,
            },
          ),
        );
      },
    );
    outbound.on('error', reject);
    outbound.end(body);
  });
}

export async function withRemoteMcp<T>(
  endpoint: string,
  headers: Record<string, string>,
  operation: (client: Client) => Promise<T>,
  signal?: AbortSignal,
  request: typeof safeRemoteFetch = safeRemoteFetch,
) {
  signal?.throwIfAborted();
  const client = new Client({ name: 'nod', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers },
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

export function createDiscoveredTransport(
  request: typeof safeRemoteFetch = safeRemoteFetch,
): DiscoveredTransport {
  return {
    async validateEndpoint(endpoint) {
      const checked = await publicUrl(endpoint);
      if (checked.url.protocol !== 'https:' || checked.url.hash || checked.url.search)
        throw new Error('Use a public HTTPS service address without a query or fragment.');
      return checked.url.href;
    },
    async http(endpoint, headers, method, body, signal) {
      const response = await request(endpoint, {
        method,
        signal,
        headers: {
          ...headers,
          'User-Agent': 'nod/0.1.0',
          Accept: 'application/json, */*;q=0.1',
          ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = response.headers.get('content-type') ?? '';
      const disposition = response.headers.get('content-disposition') ?? '';
      const content = new TextDecoder().decode(bytes);
      if (!response.ok)
        throw Object.assign(
          new Error(
            `The remote API request failed (${response.status}): ${content.slice(0, 4000)}`,
          ),
          { status: response.status },
        );
      let parsed: unknown;
      try {
        parsed = content ? JSON.parse(content) : null;
      } catch {}
      if (
        bytes.byteLength &&
        (!textType.test(type) ||
          /^\s*attachment/i.test(disposition) ||
          (parsed === undefined && content.length > 18_000))
      ) {
        const name =
          /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1] ??
          new URL(endpoint).pathname;
        return { status: response.status, file: appFile(decoded(name), type, bytes) };
      }
      return { status: response.status, body: parsed === undefined ? content : parsed };
    },
    listTools: (endpoint, headers, signal) =>
      withRemoteMcp(
        endpoint,
        headers,
        async (client) => (await client.listTools()).tools,
        signal,
        request,
      ),
    callTool: (endpoint, headers, name, input, signal) =>
      withRemoteMcp(
        endpoint,
        headers,
        async (client) => {
          const result = await client.callTool({ name, arguments: input });
          if (result.isError)
            throw new Error(`The remote MCP tool failed: ${failureText(result.content)}`);
          return mcpFiles(result);
        },
        signal,
        request,
      ),
  };
}
