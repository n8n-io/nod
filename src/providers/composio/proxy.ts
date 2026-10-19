import { Composio } from '@composio/core';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { IntegrationFile } from '../../ports/integrations.ts';
import type { IntegrationManagedAccess } from '../../shared/integrations.ts';

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const pendingPrefix = 'pending_';
const accessState = z
  .object({
    state: z.enum(['sign_in_required', 'enabled', 'denied', 'revoked']),
    email: z.email().max(320).optional(),
  })
  .strict();
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
  let identity: { key: KeyObject; publicKey: string; userId: string } | undefined;
  let initializing: Promise<void> | undefined;
  async function initialize() {
    if (identity) return;
    initializing ??= (async () => {
      let key: KeyObject;
      await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
      const dataRoot = await realpath(options.dataRoot);
      const directory = join(dataRoot, 'integration-identity');
      for (const [path, mask] of [
        [dataRoot, 0o022],
        [directory, 0o077],
      ] as const) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        const metadata = await lstat(path);
        if (
          !metadata.isDirectory() ||
          (process.getuid && metadata.uid !== process.getuid()) ||
          (process.platform !== 'win32' && (metadata.mode & mask) !== 0)
        )
          throw new Error('The integration identity directory permissions are unsafe.');
      }
      const path = join(
        directory,
        `${createHash('sha256').update(options.ownerId).digest('hex')}.pem`,
      );
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          const generated = generateKeyPairSync('ed25519');
          await file.writeFile(generated.privateKey.export({ type: 'pkcs8', format: 'pem' }));
          await file.sync();
        } finally {
          await file.close();
        }
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await rm(temporary, { force: true });
      }
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await file.stat();
        const current = await lstat(path);
        if (
          !metadata.isFile() ||
          !current.isFile() ||
          metadata.dev !== current.dev ||
          metadata.ino !== current.ino ||
          (process.getuid && metadata.uid !== process.getuid()) ||
          (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
        )
          throw new Error('The integration identity file permissions are unsafe.');
        key = createPrivateKey(await file.readFile());
      } finally {
        await file.close();
      }
      if (key.asymmetricKeyType !== 'ed25519')
        throw new Error('The integration identity is invalid.');
      const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
      if (!publicKey || Buffer.from(publicKey, 'base64url').length !== 32)
        throw new Error('The integration identity is invalid.');
      identity = {
        key,
        publicKey,
        userId: `otto_${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')}`,
      };
    })().catch((error: unknown) => {
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
    await initialize();
    const value = new Request(input, init);
    const url = new URL(value.url);
    if (url.origin !== origin || !/^\/(?:api\/v3\.1|v1)\//.test(url.pathname))
      throw new Error('The integration request destination is invalid.');
    const body = Buffer.from(await value.arrayBuffer());
    if (body.length > (url.pathname === '/v1/files/upload' ? 21 : 16) * 1024 * 1024)
      throw new Error('The integration request is too large.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const requestId = randomUUID();
    const current = requiredIdentity();
    const canonical = [
      'otto-composio-v1',
      value.method,
      origin,
      `${url.pathname}${url.search}`,
      timestamp,
      requestId,
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');
    const headers = new Headers({
      Accept: 'application/json',
      'x-otto-public-key': current.publicKey,
      'x-otto-timestamp': timestamp,
      'x-otto-request-id': requestId,
      'x-otto-signature': sign(null, Buffer.from(canonical), current.key).toString('base64url'),
    });
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
    apiKey: 'otto-managed-proxy',
    userApiKey: null,
    orgApiKey: null,
    baseURL: origin,
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const transport = client.getClient().withOptions({ fetch: request, maxRetries: 0 });
  client.getClient().request = transport.request.bind(transport);
  client.getClient().withOptions = (options) =>
    transport.withOptions({ ...options, fetch: request, maxRetries: 0 });
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
  return {
    client,
    ownerId: options.ownerId,
    origin,
    initialize,
    async accessStatus(): Promise<IntegrationManagedAccess> {
      const result = accessState.parse(await rpc('/v1/access/status', {}, { timeout: 10_000 }));
      return { state: result.state, email: result.email ?? null };
    },
    async startAccess(
      browserKey: unknown,
      uiOrigin: string,
      challenge: string,
      signal?: AbortSignal,
    ) {
      const ui = new URL(uiOrigin);
      const host =
        ui.hostname === 'localhost'
          ? 'localhost'
          : ui.hostname === '127.0.0.1'
            ? 'ipv4'
            : ui.hostname === '[::1]'
              ? 'ipv6'
              : undefined;
      const loopback = ui.protocol === 'http:' && host !== undefined;
      const hostname = ui.hostname.replace(/\.$/, '');
      const publicHttps =
        ui.protocol === 'https:' &&
        hostname.includes('.') &&
        !hostname.endsWith('.localhost') &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
        !hostname.startsWith('[');
      if (
        ui.origin !== uiOrigin ||
        uiOrigin.length > 1500 ||
        (!loopback && !publicHttps) ||
        (ui.port && Number(ui.port) < 1)
      )
        throw new Error('The sign-in origin is invalid.');
      const result = z
        .object({
          id: stateSchema,
          url: z.url().max(2000),
          expiresAt: z.number().int(),
        })
        .strict()
        .parse(
          await rpc(
            '/v1/access/start',
            {
              browserKey: browserKeySchema.parse(browserKey),
              uiOrigin: loopback
                ? { type: 'loopback', host, port: Number(ui.port || 80) }
                : { type: 'https', url: uiOrigin },
              challenge: stateSchema.parse(challenge),
            },
            { signal, timeout: 10_000 },
          ),
        );
      const redirect = new URL(result.url);
      if (
        redirect.origin !== origin ||
        redirect.pathname !== '/api/auth/enroll' ||
        redirect.searchParams.size !== 1 ||
        redirect.searchParams.get('id') !== result.id ||
        redirect.hash ||
        redirect.username ||
        redirect.password ||
        result.expiresAt <= Date.now() ||
        result.expiresAt > Date.now() + 10 * 60_000
      )
        throw new Error('The sign-in response is invalid.');
      return result;
    },
    async pollAccess(id: string, signal?: AbortSignal) {
      return z
        .object({
          status: z.enum(['pending', 'authorized', 'completed', 'cancelled', 'denied']),
        })
        .strict()
        .parse(
          await rpc('/v1/access/poll', { id: stateSchema.parse(id) }, { signal, timeout: 10_000 }),
        );
    },
    async completeAccess(
      id: string,
      challenge: string,
      signal?: AbortSignal,
    ): Promise<IntegrationManagedAccess> {
      const result = accessState.parse(
        await rpc(
          '/v1/access/complete',
          {
            id: stateSchema.parse(id),
            challenge: stateSchema.parse(challenge),
          },
          { signal, timeout: 10_000 },
        ),
      );
      return { state: result.state, email: result.email ?? null };
    },
    async cancelAccess(id: string) {
      return z
        .object({ cancelled: z.literal(true) })
        .strict()
        .parse(await rpc('/v1/access/cancel', { id: stateSchema.parse(id) }, { timeout: 10_000 }));
    },
    async revokeAccess(): Promise<IntegrationManagedAccess> {
      const result = accessState.parse(await rpc('/v1/access/revoke', {}, { timeout: 10_000 }));
      return { state: result.state, email: result.email ?? null };
    },
    get userId() {
      return requiredIdentity().userId;
    },
    get configurationId() {
      return createHash('sha256')
        .update(JSON.stringify(['proxy-v1', origin, requiredIdentity().userId]))
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
            .regex(/^otto-file\.[A-Za-z0-9._-]+$/),
        })
        .strict()
        .parse(
          await rpc(
            '/v1/files/upload',
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
      const pairing = new URL(url);
      const ticket = pairing.searchParams.get('ticket');
      if (
        pairing.origin !== origin ||
        pairing.pathname !== '/v1/connect/pair' ||
        pairing.username ||
        pairing.password ||
        pairing.hash ||
        pairing.searchParams.size !== 1 ||
        !ticket ||
        ticket.length > 16_000
      )
        throw new Error('The integration connection link is invalid.');
      return z
        .object({ pairingConfirmed: z.boolean(), signInRequired: z.boolean().optional() })
        .strict()
        .parse(await rpc('/v1/connect/status', { ticket }, { signal, timeout: 5_000 }));
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
      const challenge = randomBytes(32).toString('base64url');
      const result = z
        .object({
          redirectUrl: z.url(),
          transactionId: stateSchema,
        })
        .parse(
          await rpc('/v1/connect/start', {
            toolkit,
            callback: local
              ? { type: 'loopback', host, port }
              : { type: 'https', url: callback.href },
            transactionId,
            challenge,
            ...(reconnectAccountId ? { reconnectAccountId } : {}),
          }),
        );
      if (result.transactionId !== transactionId || new URL(result.redirectUrl).origin !== origin)
        throw new Error('The integration sign-in address is invalid.');
      return {
        accountId: `${pendingPrefix}${transactionId}`,
        url: result.redirectUrl,
        verificationSecret: challenge,
      };
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
          await rpc('/v1/connect/complete', {
            completionToken: input.completion_token,
            transactionId: input.state,
            challenge: pending.verificationSecret,
          }),
        );
      if (result.toolkit !== pending.service)
        throw new Error('The connected integration does not match this attempt.');
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
