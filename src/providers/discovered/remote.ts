import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { isPublicAddress, publicUrl } from '../agent-browser/network.ts';
import type { DiscoveredTool, DiscoveredTransport } from '../../ports/discovered.ts';
import { appFile, mcpFiles } from '../app-files.ts';
import { fileBytes } from '../../shared/files.ts';
import { withoutSchemaPatterns } from '../../shared/json-schema.ts';

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
  return (text || JSON.stringify(content ?? null)).slice(0, 40_000);
}

function compact(result: object) {
  const { structuredContent, ...rest } = result as {
    content?: unknown;
    structuredContent?: unknown;
  };
  if (structuredContent === undefined || !Array.isArray(rest.content)) return result;
  const texts = rest.content.filter(
    (block): block is { type: 'text'; text: string } =>
      Boolean(block) && (block as { type?: unknown }).type === 'text',
  );
  if (texts.length !== 1) return result;
  try {
    if (!isDeepStrictEqual(JSON.parse(texts[0].text), structuredContent)) return result;
  } catch {
    return result;
  }
  return {
    ...rest,
    content: rest.content.map((block) =>
      block === texts[0] ? { type: 'text', text: JSON.stringify(structuredContent) } : block,
    ),
  };
}

const responseBytes = Math.ceil(fileBytes / 3) * 4 + 1024 * 1024;

type FetchDependencies = {
  validate: (value: string) => Promise<{ url: URL; address: string }>;
  request: typeof httpsRequest;
  plain?: typeof httpRequest;
};

export async function safeRemoteFetch(
  input: string | URL | Request,
  init?: RequestInit,
  dependencies: FetchDependencies = { validate: publicUrl, request: httpsRequest },
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
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && dependencies.plain))
    throw new Error('The connection must use HTTPS.');
  const body = Buffer.from(await prepared.arrayBuffer());
  signal.throwIfAborted();
  if (body.byteLength > maximumRequestBytes) throw new Error('The request is too large.');
  return new Promise<Response>((resolve, reject) => {
    const send =
      url.protocol === 'http:' && dependencies.plain ? dependencies.plain : dependencies.request;
    const outbound = send(
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
          if (prepared.redirect === 'error' && next.origin !== url.origin) {
            reject(
              new Error(
                'The server redirected the request to another address, which this connection does not allow.',
              ),
            );
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

type PooledClient = { ready: Promise<Client>; active: number; timer?: NodeJS.Timeout };

const idleMs = 60_000;
const requestTimeoutMs = 600_000;
const pools = new WeakMap<typeof safeRemoteFetch, Map<string, PooledClient>>();

function poolFor(request: typeof safeRemoteFetch) {
  let pool = pools.get(request);
  if (!pool) pools.set(request, (pool = new Map()));
  return pool;
}

function release(pool: Map<string, PooledClient>, key: string, entry: PooledClient) {
  if (pool.get(key) !== entry) return;
  pool.delete(key);
  clearTimeout(entry.timer);
  void entry.ready.then((client) => client.close()).catch(() => {});
}

async function withRemoteMcp<T>(
  endpoint: string,
  headers: Record<string, string>,
  operation: (client: Client, options: RequestOptions) => Promise<T>,
  signal?: AbortSignal,
  request: typeof safeRemoteFetch = safeRemoteFetch,
) {
  signal?.throwIfAborted();
  const pool = poolFor(request);
  const key = createHash('sha256')
    .update(JSON.stringify([endpoint, Object.entries(headers).sort()]))
    .digest('hex');
  let entry = pool.get(key);
  if (!entry) {
    const client = new Client({ name: 'nod', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers },
      fetch: (input, init) => request(input, { ...init, redirect: 'error' }),
    });
    entry = {
      ready: client.connect(transport, { timeout: 60_000 }).then(() => client),
      active: 0,
    };
    pool.set(key, entry);
  }
  const current = entry;
  current.active++;
  clearTimeout(current.timer);
  const abort = () => release(pool, key, current);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const client = await (signal
      ? Promise.race([
          current.ready,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        ])
      : current.ready);
    signal?.throwIfAborted();
    const result = await operation(client, {
      ...(signal ? { signal } : {}),
      timeout: requestTimeoutMs,
      resetTimeoutOnProgress: true,
    });
    signal?.throwIfAborted();
    return result;
  } catch (cause) {
    release(pool, key, current);
    throw cause;
  } finally {
    signal?.removeEventListener('abort', abort);
    current.active--;
    if (!current.active && pool.get(key) === current) {
      current.timer = setTimeout(() => release(pool, key, current), idleMs);
      current.timer.unref();
    }
  }
}

const loopback = (host: string) =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

export function ownerAddress(origin: string) {
  const bound = new URL(origin);
  const boundHost = bound.hostname.replace(/^\[|\]$/g, '');
  return async (value: string) => {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      url.origin !== bound.origin &&
      !(
        loopback(host) &&
        loopback(boundHost) &&
        url.protocol === bound.protocol &&
        url.port === bound.port
      )
    )
      throw new Error('The connection must stay on its saved address.');
    if (url.username || url.password) throw new Error('Remove the sign-in from the address.');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, order: 'ipv4first' });
    if (!addresses.length) throw new Error('The address could not be resolved.');
    if (url.protocol !== 'https:' && addresses.some((item) => isPublicAddress(item.address)))
      throw new Error('Use HTTPS for a public address.');
    return { url, address: addresses[0].address };
  };
}

export function ownerFetch(origin: string): typeof safeRemoteFetch {
  const dependencies = {
    validate: ownerAddress(origin),
    request: httpsRequest,
    plain: httpRequest,
  };
  return (input, init) => safeRemoteFetch(input, init, dependencies);
}

async function publicEndpoint(endpoint: string) {
  const checked = await publicUrl(endpoint);
  if (checked.url.protocol !== 'https:' || checked.url.hash || checked.url.search)
    throw new Error('Use a public HTTPS service address without a query or fragment.');
  return checked.url.href;
}

export function createDiscoveredTransport(
  request: typeof safeRemoteFetch = safeRemoteFetch,
  validateEndpoint: (endpoint: string) => Promise<string> = publicEndpoint,
): DiscoveredTransport {
  return {
    validateEndpoint,
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
        async (client, options) => {
          const tools: DiscoveredTool[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const listed = await client.listTools(cursor ? { cursor } : {}, options);
            tools.push(
              ...listed.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: withoutSchemaPatterns(tool.inputSchema),
                ...(tool.annotations ? { annotations: tool.annotations } : {}),
              })),
            );
            cursor = listed.nextCursor;
            if (!cursor) break;
          }
          const instructions = client.getInstructions();
          return { tools, ...(instructions ? { instructions } : {}) };
        },
        signal,
        request,
      ),
    async callTool(endpoint, headers, name, input, signal) {
      const result = await withRemoteMcp(
        endpoint,
        headers,
        (client, options) => client.callTool({ name, arguments: input }, undefined, options),
        signal,
        request,
      );
      if (result.isError)
        throw new Error(`The remote MCP tool failed: ${failureText(result.content)}`);
      return mcpFiles(compact(result));
    },
  };
}
