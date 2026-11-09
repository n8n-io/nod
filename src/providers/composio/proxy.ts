import {
  APIPromise,
  APIConnectionTimeoutError,
  APIUserAbortError,
  type Composio as ComposioClient,
} from '@composio/client';
import { Composio } from '@composio/core';
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationFile, IntegrationConnectionBrowser } from '../../ports/integrations.ts';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import type { IntegrationIdentityCheckpoint } from '../../ports/integration-identity.ts';
import { loadIntegrationIdentity } from './identity.ts';

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pendingPrefix = 'pending_';
const browserKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: stateSchema,
    y: stateSchema,
    ext: z.literal(true).optional(),
    key_ops: z.array(z.literal('verify')).max(1).optional(),
  })
  .strict();

export function createComposioProxy(options: {
  dataRoot: string;
  ownerId: string;
  keyStore: CredentialKeyStore;
  checkpoint: IntegrationIdentityCheckpoint;
  browser?: IntegrationConnectionBrowser;
  url?: string;
  request?: typeof fetch;
}) {
  const endpoint = new URL(options.url || 'https://composio.n8n.cloud');
  if (
    (endpoint.protocol !== 'https:' &&
      !(
        endpoint.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      )) ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error('The integration proxy address must be an HTTPS origin or local test server.');
  const origin = endpoint.origin;
  let identity: Awaited<ReturnType<typeof loadIntegrationIdentity>> | undefined;
  let initializing: Promise<void> | undefined;
  async function initialize() {
    if (identity) return;
    initializing ??= loadIntegrationIdentity(options)
      .then((value) => {
        identity = value;
      })
      .catch((error: unknown) => {
        initializing = undefined;
        throw error;
      });
    await initializing;
  }
  function requiredIdentity() {
    if (!identity) throw new Error('The integration identity has not been initialized.');
    return identity;
  }
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    value.signal.throwIfAborted();
    await initialize();
    value.signal.throwIfAborted();
    const url = new URL(value.url);
    if (url.pathname.startsWith('/api/v3.1/')) url.pathname = `/v2${url.pathname}`;
    if (url.origin !== origin || !/^\/v2\/(?:api\/v3\.1|connect|files|access)\//.test(url.pathname))
      throw new Error('The integration request destination is invalid.');
    if (!url.pathname.startsWith('/v2/access/')) await enroll(value.signal);
    const body = Buffer.from(await value.arrayBuffer());
    value.signal.throwIfAborted();
    if (body.length > (url.pathname === '/v2/files/upload' ? 21 : 16) * 1024 * 1024)
      throw new Error('The integration request is too large.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const current = requiredIdentity();
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonical = [
      'nod-composio-v1',
      value.method,
      origin,
      `${url.pathname}${url.search}`,
      timestamp,
      requestId,
      bodyHash,
    ].join('\n');
    const headers = new Headers({
      Accept: 'application/json',
      'x-nod-public-key': current.publicKey,
      'x-nod-timestamp': timestamp,
      'x-nod-request-id': requestId,
      'x-nod-signature': sign(null, Buffer.from(canonical), current.key).toString('base64url'),
    });
    if (url.pathname === '/v2/files/upload') headers.set('x-nod-content-sha256', bodyHash);
    if (value.headers.has('content-type'))
      headers.set('content-type', value.headers.get('content-type')!);
    return (options.request ?? fetch)(url, {
      method: value.method,
      headers,
      ...(body.length ? { body } : {}),
      signal: value.signal,
      redirect: 'error',
    });
  };
  const client = new Composio({
    apiKey: 'nod-managed-proxy',
    userApiKey: null,
    orgApiKey: null,
    baseURL: origin,
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  function signedClient<TClient extends ComposioClient>(raw: TClient): TClient {
    const derive = raw.withOptions.bind(raw);
    raw.withOptions = (value) => signedClient(derive({ ...value, maxRetries: 0 }));
    raw.request = <T>(value: Parameters<ComposioClient['request']>[0]) => {
      const signal = value.signal;
      const controller = new AbortController();
      const abort = () => controller.abort(new APIUserAbortError());
      const timer = setTimeout(
        () => controller.abort(new APIConnectionTimeoutError()),
        value.timeout ?? raw.timeout,
      );
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cleanup);
      };
      controller.signal.addEventListener('abort', cleanup, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const active = async <TResult>(work: PromiseLike<TResult>): Promise<TResult> => {
        let stop = () => {};
        try {
          return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
              stop = () => reject(controller.signal.reason);
              controller.signal.addEventListener('abort', stop, { once: true });
              if (controller.signal.aborted) stop();
            }),
          ]);
        } finally {
          controller.signal.removeEventListener('abort', stop);
        }
      };
      const failure = (error: unknown) => {
        throw controller.signal.aborted ? controller.signal.reason : error;
      };
      let operation!: APIPromise<T>;
      const exchange = active(
        new Promise<Response>((resolve, reject) => {
          try {
            controller.signal.throwIfAborted();
            operation = derive({
              maxRetries: 0,
              transport: {
                send: (input) =>
                  request(input, {
                    signal: AbortSignal.any([input.signal, controller.signal]),
                  }),
              },
            }).request<T>({ ...value, signal: controller.signal, maxRetries: 0 });
            resolve(operation.asResponse());
          } catch (error) {
            reject(error);
          }
        }),
      ).then(
        (response) => {
          if (!response.body) cleanup();
          return response;
        },
        (error: unknown) => {
          cleanup();
          return failure(error);
        },
      );
      return new APIPromise<T>(exchange, async () => {
        try {
          controller.signal.throwIfAborted();
          return await active(operation);
        } catch (error) {
          return failure(error);
        } finally {
          cleanup();
        }
      });
    };
    return raw;
  }
  signedClient(client.getClient());
  async function rpc(
    path: string,
    body: unknown,
    options: { signal?: AbortSignal; timeout?: number; failure?: string } = {},
  ) {
    const timeout = AbortSignal.timeout(options.timeout ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        options.failure ?? 'The integration connection could not be completed. Try again.',
      );
    }
    if (!response.body || Number(response.headers.get('content-length')) > 32_768) {
      await response.body?.cancel();
      throw new Error('The integration response is invalid.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 32_768) throw new Error('The integration response is invalid.');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    signal.throwIfAborted();
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)),
    ) as unknown;
  }
  let enrolling: Promise<void> | undefined;
  async function enroll(signal: AbortSignal) {
    signal.throwIfAborted();
    enrolling ??= (async () => {
      const result = z
        .object({ state: z.literal('enabled'), userId: z.string() })
        .strict()
        .parse(await rpc('/v2/access/enroll', {}, { timeout: 15_000 }));
      if (result.userId !== requiredIdentity().userId)
        throw new Error('The app connection identity could not be verified.');
    })().catch((error: unknown) => {
      enrolling = undefined;
      throw error;
    });
    let abort = () => {};
    try {
      await Promise.race([
        enrolling,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    client,
    ownerId: options.ownerId,
    origin,
    initialize,
    ownsConnectionUrl: (url: string) => options.browser?.owns(url) ?? false,
    get userId() {
      return requiredIdentity().userId;
    },
    get configurationId() {
      return createHash('sha256')
        .update(JSON.stringify(['proxy-v2', origin, requiredIdentity().userId]))
        .digest('hex');
    },
    async upload(
      sessionId: string,
      action: string,
      file: IntegrationFile,
      accountId: string,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (!file.bytes.byteLength || file.bytes.byteLength > 15 * 1024 * 1024)
        throw new Error('The file size is unsupported.');
      const result = z
        .object({
          name: z.literal(file.name),
          mimetype: z.literal(file.mimeType),
          s3key: z
            .string()
            .min(20)
            .max(24_000)
            .regex(/^nod-file\.[A-Za-z0-9._-]+$/),
        })
        .strict()
        .parse(
          await rpc(
            '/v2/files/upload',
            {
              sessionId,
              action,
              accountId,
              name: file.name,
              mimeType: file.mimeType,
              data: Buffer.from(file.bytes).toString('base64'),
            },
            {
              signal,
              timeout: 210_000,
              failure: 'The file could not be uploaded for this app.',
            },
          ),
        );
      signal?.throwIfAborted();
      return result;
    },
    async connectionStatus(url: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!options.browser?.owns(url))
        throw new Error('The integration connection link is invalid.');
      const remote = options.browser.remote(url);
      if (!remote) return { pairingConfirmed: false };
      const pairing = new URL(remote);
      const ticket = pairing.searchParams.get('ticket');
      if (
        pairing.origin !== origin ||
        pairing.pathname !== '/v2/connect/pair' ||
        pairing.username ||
        pairing.password ||
        pairing.hash ||
        pairing.searchParams.size !== 1 ||
        !ticket ||
        ticket.length > 16_000
      )
        throw new Error('The integration connection link is invalid.');
      return z
        .object({ pairingConfirmed: z.boolean() })
        .strict()
        .parse(await rpc('/v2/connect/status', { ticket }, { signal, timeout: 5_000 }));
    },
    async authorize(toolkit: string, callbackUrl: string, reconnectAccountId?: string) {
      const callback = new URL(callbackUrl);
      const transactionId = stateSchema.parse(callback.searchParams.get('state'));
      const host =
        callback.hostname === 'localhost'
          ? 'localhost'
          : callback.hostname === '127.0.0.1'
            ? 'ipv4'
            : callback.hostname === '[::1]'
              ? 'ipv6'
              : undefined;
      const port = Number(callback.port || 80);
      const local = callback.protocol === 'http:' && host !== undefined && port >= 1;
      const hostname = callback.hostname.replace(/\.$/, '');
      const publicHttps =
        callback.protocol === 'https:' &&
        hostname !== 'localhost' &&
        !hostname.endsWith('.localhost') &&
        hostname.includes('.') &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
        !hostname.startsWith('[');
      if (
        (!local && !publicHttps) ||
        callback.pathname !== '/api/apps/callback' ||
        callback.username ||
        callback.password ||
        callback.hash ||
        callback.href.length > 1500 ||
        callback.searchParams.size !== 1
      )
        throw new Error('The integration callback address is invalid.');
      if (!options.browser) throw new Error('Open Nod on this computer to connect an app.');
      const challenge = randomBytes(32).toString('base64url');
      const url = await options.browser.open(
        transactionId,
        origin,
        async (browserKey, uiOrigin, native) => {
          const browser = new URL(uiOrigin);
          const result = z
            .object({ redirectUrl: z.url(), transactionId: stateSchema })
            .strict()
            .parse(
              await rpc('/v2/connect/start', {
                toolkit,
                callback: local
                  ? { type: 'loopback', host, port }
                  : { type: 'https', url: callback.href },
                transactionId,
                challenge,
                browserKey: browserKeySchema.parse(browserKey),
                uiOrigin:
                  browser.protocol === 'https:'
                    ? { type: 'https', url: browser.origin }
                    : {
                        type: 'loopback',
                        host:
                          browser.hostname === 'localhost'
                            ? 'localhost'
                            : browser.hostname === '[::1]'
                              ? 'ipv6'
                              : 'ipv4',
                        port: Number(browser.port || 80),
                      },
                ...(native ? { native } : {}),
                ...(reconnectAccountId ? { reconnectAccountId } : {}),
              }),
            );
          const redirect = new URL(result.redirectUrl);
          if (
            result.transactionId !== transactionId ||
            redirect.origin !== origin ||
            redirect.pathname !== '/v2/connect/pair' ||
            redirect.searchParams.size !== 1 ||
            !redirect.searchParams.get('ticket') ||
            redirect.username ||
            redirect.password ||
            redirect.hash
          )
            throw new Error('The app sign-in address could not be verified.');
          return redirect.href;
        },
      );
      return { accountId: `${pendingPrefix}${transactionId}`, url, verificationSecret: challenge };
    },
    async parseCallback(
      query: unknown,
      pending?: { accountId: string; verificationSecret?: string | null; service: string },
    ) {
      const input = z
        .object({ state: stateSchema, completion_token: z.string().min(1).max(24_000) })
        .parse(query);
      if (!pending?.verificationSecret || pending.accountId !== `${pendingPrefix}${input.state}`)
        throw new Error('This integration connection attempt is unavailable.');
      const result = z
        .object({
          connectedAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
          toolkit: z.string(),
          status: z.literal('ACTIVE'),
        })
        .parse(
          await rpc('/v2/connect/complete', {
            completionToken: input.completion_token,
            transactionId: input.state,
            challenge: pending.verificationSecret,
          }),
        );
      if (result.toolkit !== pending.service)
        throw new Error('The connected integration does not match this attempt.');
      options.browser?.finish(input.state);
      return {
        state: input.state,
        accountId: result.connectedAccountId,
        pendingAccountId: pending.accountId,
        success: true,
      };
    },
    isPendingAccount: (id: string) => id.startsWith(pendingPrefix),
  };
}
