import Fastify from 'fastify';
import { z } from 'zod';
import type { AuthenticatedSession, AuthenticationProvider } from '../ports/authentication.ts';
import type { TenantRuntimeHost } from '../ports/tenant-runtime.ts';
import type { AccountStore, StoredAccount } from './account-store.ts';
import { authenticationHeaders, createAccountSession, sendFetchResponse } from './account.ts';
import { canonicalRequestPath } from './runtime-auth.ts';
import { parsePrivacyNotice, registerPrivacyNotice } from './privacy.ts';
import { createDeploymentControl, deploymentHeader } from './deployment-control.ts';
import { deploymentBodyLimit, deploymentPath } from './deployment-auth.ts';
import type { Analytics } from './analytics.ts';
import { loopbackHost } from '../shared/loopback.ts';

function privateRuntimeResponse(response: Response, artifact = false) {
  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-disposition',
    'location',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (artifact)
    headers.set('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, headers });
}

function guardedStream(
  response: Response,
  options: {
    authentication: AuthenticationProvider;
    session: AuthenticatedSession;
    headers: Headers;
    intervalMs: number;
  },
) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let closed = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval>;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    void reader.cancel().catch(() => {});
    controller.close();
  }
  const body = new ReadableStream<Uint8Array>({
    start(current) {
      controller = current;
      timer = setInterval(async () => {
        if (closed || checking) return;
        checking = true;
        try {
          const current = await options.authentication.session(options.headers);
          if (
            !current ||
            current.id !== options.session.id ||
            current.user.id !== options.session.user.id ||
            current.expiresAt <= new Date()
          )
            finish();
        } catch {
          finish();
        } finally {
          checking = false;
        }
      }, options.intervalMs);
      timer.unref();
    },
    async pull(current) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) finish();
        else current.enqueue(next.value);
      } catch {
        if (!closed) {
          closed = true;
          clearInterval(timer);
          current.error(new Error('Session stream ended.'));
        }
      }
    },
    async cancel() {
      closed = true;
      clearInterval(timer);
      await reader.cancel();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

export async function createGateway(options: {
  origin: string;
  authentication: AuthenticationProvider;
  accounts: AccountStore;
  analytics?: Analytics;
  runtimes: TenantRuntimeHost;
  developerIds?: ReadonlySet<string>;
  sessionCheckIntervalMs?: number;
  release?: string;
  privacyNotice?: string;
  deployment?: { masterKey: Uint8Array; environment: string; release?: string };
  internal?(request: Request): Promise<Response>;
  webhook?(request: Request): Promise<Response>;
}) {
  const privacyNotice = parsePrivacyNotice(options.privacyNotice);
  const origin = new URL(options.origin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('Configure a canonical application origin.');
  if (
    origin.protocol !== 'https:' &&
    !(loopbackHost(origin.hostname) && origin.protocol === 'http:')
  )
    throw new Error('Public application origins require HTTPS.');
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: false,
    forceCloseConnections: true,
  });
  async function setup(
    ownerId: string,
    path: string,
    body: Record<string, string | undefined> = {},
  ) {
    const response = await options.runtimes.fetch(
      ownerId,
      new Request(new URL(path, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { developer: false },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Account setup failed.');
    }
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await response.json());
  }
  const profileAccounts = new Map<string, StoredAccount>();
  const accountVersions = new Map<string, number>();
  const accountStore: AccountStore = {
    async read(ownerId) {
      const version = accountVersions.get(ownerId);
      const account = await options.accounts.read(ownerId);
      if (accountVersions.get(ownerId) === version) profileAccounts.set(ownerId, account);
      return account;
    },
    async update(ownerId, input) {
      const version = (accountVersions.get(ownerId) ?? 0) + 1;
      accountVersions.set(ownerId, version);
      profileAccounts.delete(ownerId);
      const account = await options.accounts.update(ownerId, input);
      if (accountVersions.get(ownerId) === version) {
        accountVersions.set(ownerId, version + 1);
        profileAccounts.set(ownerId, account);
      }
      return account;
    },
  };
  const accounts = createAccountSession({
    ...options,
    accounts: accountStore,
    withProfile,
    origin: origin.origin,
    prepare: (ownerId) => setup(ownerId, '/api/account/prepare'),
    start: (ownerId, name) => setup(ownerId, '/api/onboarding/start', { name }),
    warm(ownerId) {
      options.runtimes.warm?.(ownerId).catch(() => {});
    },
  });
  const syncedProfiles = new Map<string, string>();
  const profileSyncs = new Map<string, Promise<void>>();
  const welcomeProfiles = new Map<string, string>();
  const welcomeSyncs = new Map<string, Promise<void>>();
  function withProfile(
    session: AuthenticatedSession,
    name: string | undefined,
    operation: () => Promise<void>,
    current: () => Promise<boolean>,
  ) {
    const owner = session.user.id;
    const next = (welcomeSyncs.get(owner) ?? Promise.resolve()).then(async () => {
      if (!(await current())) return;
      if (name !== undefined) welcomeProfiles.set(owner, name);
      try {
        await syncProfile(session);
        await operation();
      } finally {
        welcomeProfiles.delete(owner);
      }
    });
    const settled = next.catch(() => {});
    welcomeSyncs.set(owner, settled);
    void settled.then(() => {
      if (welcomeSyncs.get(owner) === settled) welcomeSyncs.delete(owner);
    });
    return next;
  }
  function syncProfile(session: AuthenticatedSession) {
    const owner = session.user.id;
    const next = (profileSyncs.get(owner) ?? Promise.resolve()).then(() => sendProfile(session));
    const settled = next.catch(() => {});
    profileSyncs.set(owner, settled);
    void settled.then(() => {
      if (profileSyncs.get(owner) === settled) profileSyncs.delete(owner);
    });
    return next;
  }
  async function sendProfile(session: AuthenticatedSession) {
    const account =
      profileAccounts.get(session.user.id) ?? (await accountStore.read(session.user.id));
    const body = JSON.stringify({
      name: session.user.name.trim().slice(0, 200) || null,
      givenName: session.givenName?.slice(0, 100) || null,
      email: session.user.email?.slice(0, 320) || null,
      preferredName:
        (welcomeProfiles.get(session.user.id) ?? account.displayName)?.slice(0, 100) || null,
      usageData: account.usageData,
    });
    if (syncedProfiles.get(session.user.id) === body) return;
    const response = await options.runtimes.fetch(
      session.user.id,
      new Request(new URL('/api/account/profile', origin), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      { developer: false },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error('Account profile could not be synchronized.');
    syncedProfiles.set(session.user.id, body);
  }
  const deployment = options.deployment
    ? createDeploymentControl({ ...options.deployment, runtimes: options.runtimes })
    : undefined;
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('content-security-policy', "frame-ancestors 'none'");
    const path = canonicalRequestPath(request.url);
    if (!path) return reply.code(400).send({ error: 'This request is not permitted.' });
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method))
      return reply.code(405).send({ error: 'This method is not permitted.' });
    if (request.headers.host !== origin.host)
      return reply.code(403).send({ error: 'This host is not permitted.' });
    const serviceRequest =
      (Boolean(deployment) && request.method === 'POST' && path === deploymentPath) ||
      (Boolean(options.internal) &&
        request.method === 'POST' &&
        /^\/api\/internal\/channels\/(claim|release)$/.test(path)) ||
      (Boolean(options.webhook) &&
        ((request.method === 'POST' &&
          (path === '/api/webhooks/composio' ||
            /^\/api\/webhooks\/(telegram|whatsapp)\/[A-Za-z0-9_-]{43}$/.test(path))) ||
          (request.method === 'GET' &&
            /^\/api\/webhooks\/whatsapp\/[A-Za-z0-9_-]{43}$/.test(path))));
    if (serviceRequest) return;
    if (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
      return reply.code(403).send({ error: 'This origin is not permitted.' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== origin.origin
    )
      return reply.code(403).send({ error: 'This origin is not permitted.' });
    if (
      request.headers['sec-fetch-site'] === 'cross-site' &&
      path.startsWith('/api/') &&
      path !== '/api/auth/callback/google' &&
      path !== '/api/apps/callback'
    )
      return reply.code(403).send({ error: 'Cross-site requests are not permitted.' });
  });
  app.addHook('preValidation', async (request) => {
    if (
      [
        '/api/login',
        '/api/logout',
        '/api/account',
        '/api/account/prepare',
        '/api/account/welcome',
      ].includes(request.url.split('?')[0]) &&
      Buffer.isBuffer(request.body)
    ) {
      try {
        request.body = JSON.parse(request.body.toString('utf8'));
      } catch {
        throw Object.assign(new Error('Check the supplied values.'), { statusCode: 400 });
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error &&
            typeof error === 'object' &&
            'statusCode' in error &&
            typeof error.statusCode === 'number' &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? error.statusCode
          : 503;
    reply.code(status).send({
      error:
        status === 400
          ? 'Check the supplied values.'
          : 'This request could not be completed. Try again.',
    });
  });
  accounts.register(app);
  registerPrivacyNotice(app, privacyNotice);
  app.get('/api/health', async () => ({
    ok: true,
    ...(options.release ? { release: options.release } : {}),
  }));
  app.post(deploymentPath, { bodyLimit: deploymentBodyLimit }, async (request, reply) => {
    if (!deployment) return reply.code(404).send({ error: 'Route not found.' });
    try {
      return await deployment(
        request.headers[deploymentHeader],
        request.method,
        request.url,
        Buffer.isBuffer(request.body) ? request.body : new Uint8Array(),
      );
    } catch (error) {
      const status =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number' &&
        [400, 401, 409].includes(error.status)
          ? error.status
          : 503;
      return reply.code(status).send({ error: 'The deployment operation could not be completed.' });
    }
  });
  if (options.internal || options.webhook) {
    const service = async (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => {
      const path = canonicalRequestPath(request.url)!;
      const internal = path.startsWith('/api/internal/');
      const handler = internal ? options.internal : options.webhook;
      if (!handler) return reply.code(404).send({ error: 'Route not found.' });
      const headers = new Headers();
      for (const key of internal
        ? ['content-type', 'x-otto-runtime', 'x-otto-owner']
        : [
            'content-type',
            'webhook-id',
            'webhook-timestamp',
            'webhook-signature',
            'x-telegram-bot-api-secret-token',
            'x-hub-signature-256',
          ]) {
        const value = request.headers[key];
        if (typeof value === 'string') headers.set(key, value);
      }
      const input = new Request(new URL(request.url, origin), {
        method: request.method,
        headers,
        ...(request.method === 'POST'
          ? {
              body: Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(),
            }
          : {}),
      });
      return sendFetchResponse(reply, privateRuntimeResponse(await handler(input)));
    };
    if (options.internal)
      for (const path of ['claim', 'release'])
        app.post(`/api/internal/channels/${path}`, { bodyLimit: 4096 }, service);
    if (options.webhook) {
      app.post('/api/webhooks/composio', { bodyLimit: 262_144 }, service);
      app.post('/api/webhooks/telegram/:token', { bodyLimit: 262_144 }, service);
      app.route({
        method: ['GET', 'POST'],
        url: '/api/webhooks/whatsapp/:token',
        bodyLimit: 262_144,
        handler: service,
      });
    }
  }
  app.all('/api/*', async (request, reply) => {
    const session = await accounts.requirePrincipal(request, reply);
    if (!session) return;
    const url = new URL(request.url, origin);
    if (
      url.pathname.startsWith('/api/auth/') ||
      url.pathname.startsWith('/api/webhooks/') ||
      url.pathname.startsWith('/api/internal/') ||
      url.pathname.startsWith('/api/runtime/') ||
      url.pathname === '/api/onboarding/start' ||
      url.pathname === '/api/account/profile'
    )
      return reply.code(404).send({ error: 'Route not found.' });
    if (url.pathname === '/api/events' && url.searchParams.get('account') !== session.user.id)
      return reply.code(401).send({ error: 'Sign in to continue.' });
    const developer = options.developerIds?.has(session.user.id) ?? false;
    if (!developer && (url.pathname === '/api/browser' || url.pathname.startsWith('/api/browser/')))
      return reply.code(404).send({ error: 'Route not found.' });
    const headers = new Headers();
    for (const name of ['content-type', 'accept', 'range']) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());
    const forwarded = new Request(url, {
      method: request.method,
      headers,
      signal: abort.signal,
      ...(!['GET', 'HEAD'].includes(request.method)
        ? { body: Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array() }
        : {}),
    });
    await syncProfile(session).catch(() => {});
    let result = await options.runtimes.fetch(session.user.id, forwarded, { developer });
    const streamed = ['/api/events', '/api/browser-handoff/stream'].includes(url.pathname);
    if (streamed)
      try {
        const current = await options.authentication.session(authenticationHeaders(request));
        if (
          !current ||
          current.id !== session.id ||
          current.user.id !== session.user.id ||
          current.expiresAt <= new Date()
        ) {
          await result.body?.cancel().catch(() => {});
          return reply.code(401).send({ error: 'Sign in to continue.' });
        }
      } catch {
        await result.body?.cancel().catch(() => {});
        return reply.code(503).send({ error: 'This request could not be completed. Try again.' });
      }
    result = privateRuntimeResponse(result, url.pathname.startsWith('/api/artifacts/'));
    if (streamed && result.ok)
      result = guardedStream(result, {
        authentication: options.authentication,
        session,
        headers: authenticationHeaders(request),
        intervalMs: options.sessionCheckIntervalMs ?? 5_000,
      });
    return sendFetchResponse(reply, result);
  });
  app.addHook('onClose', async () => options.runtimes.close());
  return app;
}
