import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import test, { describe } from 'node:test';
import Fastify, { type FastifyRequest, type InjectOptions } from 'fastify';
import type { AuthenticatedSession, AuthenticationProvider } from '../src/ports/authentication.ts';
import type { TenantRuntimeHost } from '../src/ports/tenant-runtime.ts';
import { createGateway } from '../src/server/gateway.ts';
import {
  deploymentHeader,
  signDeploymentRequest,
  createDeploymentVerifier,
  deploymentPath,
  deriveDeploymentKey,
} from '../src/server/deployment-auth.ts';
import {
  createRuntimeVerifier,
  deriveRuntimeSecret,
  registerRuntimeAccess,
  signRuntimeRequest,
  runtimeHeader,
} from '../src/server/runtime-auth.ts';
import { createTenantControl } from '../src/server/tenant-control.ts';
import { ChannelAccountRegistryError } from '../src/server/channel-account-registry.ts';
import type { ChannelAccountIdentity } from '../src/ports/channel-settings.ts';
import type { TenantLease } from '../src/server/tenants.ts';
import { channelWebhookToken, createHostedWebhooks } from '../src/server/hosted-webhooks.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import { registerLocalAccess } from '../src/server/access.ts';

describe('gateway', () => {
  const origin = 'http://localhost:4399';
  const host = 'localhost:4399';

  async function fixture(
    services: Pick<Parameters<typeof createGateway>[0], 'internal' | 'webhook' | 'deployment'> = {},
  ) {
    const secret = randomBytes(32);
    const users: string[] = [randomUUID(), randomUUID()];
    const sessions = new Map(
      users.map((id) => [
        id,
        {
          id: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          user: { id, name: 'Synthetic user', email: 'synthetic@example.test', avatarUrl: null },
        } satisfies AuthenticatedSession,
      ]),
    );
    const cookies = users.map(
      (id) => `fixture=${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`,
    );
    const calls: {
      owner: string;
      url: string;
      method: string;
      body: string;
      headers: Headers;
      developer: boolean;
    }[] = [];
    let reply: (owner: string, request: Request) => Promise<Response> = async (owner) =>
      Response.json({ owner, record: `Synthetic data for ${owner}` });
    const authentication: AuthenticationProvider = {
      configured: true,
      async initialize() {},
      async session(headers) {
        const token = headers.get('cookie')?.match(/(?:^|;\s*)fixture=([^;]+)/)?.[1];
        const [id, signature] = token?.split('.') ?? [];
        if (!id || !signature) return null;
        const expected = createHmac('sha256', secret).update(id).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
        const session = sessions.get(id);
        return session && session.expiresAt > new Date() ? session : null;
      },
      async signIn() {
        return Response.json(
          { url: 'https://accounts.example.test/google' },
          { headers: { 'set-cookie': 'oauth=synthetic; HttpOnly' } },
        );
      },
      async signOut() {
        return Response.json({ ok: true });
      },
      async callback() {
        return Response.redirect(`${origin}/onboarding`);
      },
    };
    const runtimes: TenantRuntimeHost = {
      async fetch(owner, request, options) {
        if (new URL(request.url).pathname === '/api/account/profile')
          return Response.json({ ok: true });
        calls.push({
          owner,
          url: request.url,
          method: request.method,
          body: await request.clone().text(),
          headers: request.headers,
          developer: options.developer,
        });
        return reply(owner, request);
      },
      async close() {},
    };
    const app = await createGateway({
      ...services,
      origin,
      authentication,
      runtimes,
      developerIds: new Set([users[0]]),
      sessionCheckIntervalMs: 10,
      accounts: {
        async read() {
          return { theme: 'system', onboardingCompleted: true, displayName: null };
        },
        async update() {
          return { theme: 'system', onboardingCompleted: true, displayName: null };
        },
      },
    });
    return {
      app,
      runtimes,
      users,
      cookies,
      calls,
      sessions,
      headers: (index = 0) => ({ host, cookie: cookies[index], 'x-otto-account': users[index] }),
      reply: (value: typeof reply) => {
        reply = value;
      },
    };
  }

  test('deployment gateway accepts only purpose-signed exact control bodies without using a user session', async (t) => {
    const masterKey = randomBytes(32);
    const release = 'a'.repeat(40);
    const f = await fixture({ deployment: { masterKey, environment: 'production', release } });
    t.after(() => f.app.close());
    const receipt = { ownerId: randomUUID(), generation: '2' };
    let calls = 0;
    f.runtimes.prepareDeployment = async () => {
      calls += 1;
      return [receipt];
    };
    const input = {
      action: 'prepare',
      nonce: randomUUID(),
      previousRelease: release,
      targetRelease: 'b'.repeat(40),
      deadline: Date.now() + 30_000,
    };
    const body = Buffer.from(JSON.stringify(input));
    const token = signDeploymentRequest({ masterKey, environment: 'production', body });
    const rejected = await f.app.inject({
      method: 'POST',
      url: '/api/deployment',
      headers: { ...f.headers(), origin, 'content-type': 'application/json' },
      payload: body,
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(calls, 0);
    const options = {
      method: 'POST' as const,
      url: '/api/deployment',
      headers: { host, 'content-type': 'application/json', [deploymentHeader]: token },
      payload: body,
    };
    const response = await f.app.inject(options);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, receipts: [receipt] });
    assert.equal((await f.app.inject(options)).statusCode, 401);
    assert.equal(calls, 1);
    assert.equal(f.calls.length, 0);
  });

  test('gateway routes two signed users only by their cookie identity and strips client routing credentials', async () => {
    const f = await fixture();
    try {
      assert.equal((await f.app.inject({ url: '/api/state', headers: { host } })).statusCode, 401);
      for (const index of [0, 1]) {
        const result = await f.app.inject({
          method: 'POST',
          url: `/api/messages?ownerId=${f.users[1 - index]}`,
          headers: {
            ...f.headers(index),
            origin,
            'x-otto-owner': f.users[1 - index],
            'x-otto-runtime': 'forged',
            authorization: 'Bearer fixture',
            'x-forwarded-host': 'foreign.example.test',
          },
          payload: { ownerId: f.users[1 - index], text: 'Synthetic message' },
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().owner, f.users[index]);
        const call = f.calls.at(-1)!;
        assert.equal(call.owner, f.users[index]);
        assert.equal(call.developer, index === 0);
        assert.equal(call.headers.get('cookie'), null);
        assert.equal(call.headers.get('x-otto-account'), null);
        assert.equal(call.headers.get('x-otto-owner'), null);
        assert.equal(call.headers.get('x-otto-runtime'), null);
        assert.equal(call.headers.get('authorization'), null);
        assert.equal(call.headers.get('x-forwarded-host'), null);
        assert.equal(JSON.parse(call.body).text, 'Synthetic message');
      }
      const stale = await f.app.inject({
        url: '/api/state',
        headers: { ...f.headers(1), 'x-otto-account': f.users[0] },
      });
      assert.equal(stale.statusCode, 401);
      assert.equal(f.calls.length, 2);
    } finally {
      await f.app.close();
    }
  });

  test('gateway service ingress preserves signed bytes and exposes only exact callback capabilities', async () => {
    const received: { kind: string; request: Request; body: Uint8Array }[] = [];
    const handler = (kind: string) => async (request: Request) => {
      received.push({ kind, request, body: new Uint8Array(await request.arrayBuffer()) });
      return new Response('rejected by signature verification', {
        status: 401,
        headers: { 'set-cookie': 'unsafe=fixture', 'x-otto-owner': 'private' },
      });
    };
    const f = await fixture({ internal: handler('internal'), webhook: handler('webhook') });
    const body = Buffer.from(' { "spacing": [1, 2], "unicode": "é" }\n');
    const token = 'x'.repeat(43);
    try {
      for (const url of [
        '/api/webhooks/composio',
        `/api/webhooks/telegram/${token}`,
        `/api/webhooks/whatsapp/${token}`,
        '/api/internal/channels/claim',
        '/api/internal/channels/release',
      ]) {
        const result = await f.app.inject({
          method: 'POST',
          url,
          headers: {
            host,
            cookie: f.cookies[0],
            authorization: 'Bearer synthetic',
            'content-type': 'application/json',
            'x-otto-owner': f.users[0],
            'x-otto-runtime': 'synthetic-envelope',
            'webhook-signature': 'synthetic-signature',
            'x-telegram-bot-api-secret-token': 'synthetic-provider-secret',
          },
          payload: body,
        });
        assert.equal(result.statusCode, 401, url);
        assert.equal(result.headers['set-cookie'], undefined);
        assert.equal(result.headers['x-otto-owner'], undefined);
        const call = received.at(-1)!;
        assert.deepEqual(Buffer.from(call.body), body);
        assert.equal(call.request.headers.get('cookie'), null);
        assert.equal(call.request.headers.get('authorization'), null);
        if (call.kind === 'internal') {
          assert.equal(call.request.headers.get('x-otto-owner'), f.users[0]);
          assert.equal(call.request.headers.get('x-otto-runtime'), 'synthetic-envelope');
          assert.equal(call.request.headers.get('webhook-signature'), null);
          assert.equal(call.request.headers.get('x-telegram-bot-api-secret-token'), null);
        } else {
          assert.equal(call.request.headers.get('webhook-signature'), 'synthetic-signature');
          assert.equal(call.request.headers.get('x-otto-runtime'), null);
          assert.equal(call.request.headers.get('x-otto-owner'), null);
        }
      }
      const challenge = await f.app.inject({
        url: `/api/webhooks/whatsapp/${token}?hub.challenge=synthetic%2Fchallenge`,
        headers: { host },
      });
      assert.equal(challenge.statusCode, 401);
      assert.equal(
        new URL(received.at(-1)!.request.url).searchParams.get('hub.challenge'),
        'synthetic/challenge',
      );
      assert.equal(received.at(-1)!.body.length, 0);
      const count = received.length;
      for (const url of [
        '/api/webhooks/telegram',
        '/api/webhooks/composio/extra',
        '/api/internal/channels/claim/extra',
        `/api/webhooks/telegram/${token.slice(1)}`,
        '/api/runtime/lease',
        '/api/messages',
      ]) {
        const result = await f.app.inject({
          method: 'POST',
          url,
          headers: { host },
          payload: body,
        });
        assert.equal(result.statusCode, 403, url);
      }
      assert.equal(received.length, count);
      assert.equal(f.calls.length, 0);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/webhooks/composio',
            headers: { host: 'foreign.example.test' },
            payload: body,
          })
        ).statusCode,
        403,
      );
      assert.equal(received.length, count);
    } finally {
      await f.app.close();
    }
  });

  test('gateway rejects foreign hosts, origins, cross-site requests and unsafe methods before runtime dispatch', async () => {
    const f = await fixture();
    try {
      for (const headers of [
        { ...f.headers(), host: 'attacker.example.test', 'x-forwarded-host': host },
        { ...f.headers(), origin: 'https://attacker.example.test' },
        { ...f.headers(), 'sec-fetch-site': 'cross-site' },
      ])
        assert.equal((await f.app.inject({ url: '/api/state', headers })).statusCode, 403);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/messages',
            headers: f.headers(),
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.app.inject({
            method: 'TRACE' as InjectOptions['method'],
            url: '/api/state',
            headers: { ...f.headers(), origin },
          })
        ).statusCode,
        405,
      );
      assert.equal(f.calls.length, 0);
      const signed = await f.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host, origin },
        payload: {},
      });
      assert.equal(signed.statusCode, 200);
      assert.match(String(signed.headers['set-cookie']), /oauth=synthetic/);
      const callback = await f.app.inject({
        url: '/api/auth/callback/google?state=synthetic%2Fvalue&code=fixture',
        headers: { host, 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(callback.statusCode, 302);
      assert.equal(callback.headers.location, `${origin}/onboarding`);
    } finally {
      await f.app.close();
    }
  });

  test('gateway rejects encoded, normalized and internal paths without opening another capability', async () => {
    const f = await fixture();
    try {
      for (const url of [
        '/api/browser/screen',
        '/api/inspector/screen',
        '/api/auth/get-session',
        '/api/runtime/lease',
        '/api/webhooks/telegram',
      ]) {
        assert.equal((await f.app.inject({ url, headers: f.headers(1) })).statusCode, 404, url);
      }
      for (const url of [
        '/api/%62rowser/screen',
        '/api/browser%2Fscreen',
        '/api/%69nspector/screen',
        '/api/%61uth/get-session',
        '/api/%72untime/wake',
        '/api/%77ebhooks/telegram',
        '/api/state/../browser/screen',
        '/api/%252e%252e/browser',
        '/api//browser/screen',
        '/api/browser%5cscreen',
      ]) {
        const result = await f.app.inject({ url, headers: f.headers(1) });
        assert.ok([400, 404].includes(result.statusCode), `${url}: ${result.statusCode}`);
      }
      assert.equal(f.calls.length, 0);
      const developer = await f.app.inject({ url: '/api/browser/screen', headers: f.headers(0) });
      assert.equal(developer.statusCode, 200);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].developer, true);
    } finally {
      await f.app.close();
    }
  });

  test('actor response headers cannot create cookies or replace gateway privacy headers', async () => {
    const f = await fixture();
    f.reply(
      async () =>
        new Response('synthetic', {
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'session=actor-value; HttpOnly',
            'cache-control': 'public,max-age=31536000',
            'content-security-policy': 'frame-ancestors *',
            'referrer-policy': 'unsafe-url',
            'x-content-type-options': 'invalid',
            'x-otto-runtime': 'must-not-be-public',
          },
        }),
    );
    try {
      const result = await f.app.inject({ url: '/api/state', headers: f.headers() });
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, 'synthetic');
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(result.headers['x-otto-runtime'], undefined);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['content-security-policy'], "frame-ancestors 'none'");
      assert.equal(result.headers['referrer-policy'], 'no-referrer');
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
    } finally {
      await f.app.close();
    }
  });

  test('revocation while an actor starts prevents the delayed stream from reaching the client', async () => {
    const f = await fixture();
    let cancelled = 0;
    f.reply(async () => {
      f.sessions.delete(f.users[0]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('private delayed data'));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    try {
      const result = await f.app.inject({
        url: `/api/events?account=${f.users[0]}`,
        headers: f.headers(),
      });
      assert.equal(result.statusCode, 401);
      assert.doesNotMatch(result.body, /private delayed data/);
      assert.equal(cancelled, 1);
    } finally {
      await f.app.close();
    }
  });
});

describe('runtime authentication', () => {
  const ownerId = randomUUID();
  const master = randomBytes(32);
  const secret = deriveRuntimeSecret(master, 'development', ownerId);
  const context = { secret, ownerId, environment: 'development', generation: '1' };
  const signed = (overrides: Partial<Parameters<typeof signRuntimeRequest>[0]> = {}) =>
    signRuntimeRequest({
      ...context,
      method: 'GET',
      target: '/api/state',
      body: new Uint8Array(),
      developer: false,
      ...overrides,
    });

  test('runtime signatures bind owner, deployment, generation, method and full target', () => {
    const token = signed();
    for (const changed of [
      { ownerId: randomUUID() },
      { environment: 'production' },
      { generation: '2' },
      { secret: deriveRuntimeSecret(master, 'development', randomUUID()) },
    ])
      assert.equal(
        createRuntimeVerifier({ ...context, ...changed }).verify(token, 'GET', '/api/state'),
        null,
      );
    assert.equal(createRuntimeVerifier(context).verify(token, 'POST', '/api/state'), null);
    assert.equal(
      createRuntimeVerifier(context).verify(token, 'GET', '/api/state?owner=other'),
      null,
    );
    assert.equal(
      createRuntimeVerifier(context).verify(token, 'GET', '/api/state')?.ownerId,
      ownerId,
    );
  });

  test('runtime authentication rejects replay, expiration, malformed and future envelopes', () => {
    const now = Date.now();
    const verifier = createRuntimeVerifier({ ...context, now: () => now });
    const token = signed({ now });
    assert.ok(verifier.verify(token, 'GET', '/api/state'));
    assert.equal(verifier.verify(token, 'GET', '/api/state'), null);
    assert.equal(verifier.verify(signed({ now: now - 30_001 }), 'GET', '/api/state'), null);
    assert.ok(verifier.verify(signed({ now: now + 4999 }), 'GET', '/api/state'));
    assert.equal(verifier.verify(signed({ now: now + 5001 }), 'GET', '/api/state'), null);
    for (const invalid of ['', 'a.b', 'a.b.c', token.replace(/.$/, '!'), ['a'], undefined])
      assert.equal(verifier.verify(invalid, 'GET', '/api/state'), null);
  });

  test('private processor rejects spoofed identity, changed bodies and ordinary computer access', async () => {
    const app = Fastify();
    registerRuntimeAccess(app, context);
    let calls = 0;
    app.post('/api/messages', async (request) => {
      calls++;
      return request.body;
    });
    app.get('/api/browser/screen', async () => ({ image: 'private' }));
    try {
      const payload = JSON.stringify({ text: 'hello' });
      const token = signed({ method: 'POST', target: '/api/messages', body: Buffer.from(payload) });
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/messages',
            headers: { 'x-otto-owner': ownerId },
            payload: { text: 'hello' },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/messages',
            headers: { 'content-type': 'application/json', 'x-otto-runtime': token },
            payload: JSON.stringify({ text: 'changed' }),
          })
        ).statusCode,
        401,
      );
      assert.equal(calls, 0);
      const success = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: {
          'content-type': 'application/json',
          'x-otto-runtime': signed({
            method: 'POST',
            target: '/api/messages',
            body: Buffer.from(payload),
          }),
        },
        payload,
      });
      assert.equal(success.statusCode, 200);
      assert.equal(calls, 1);
      assert.equal(
        (
          await app.inject({
            url: '/api/browser/screen',
            headers: { 'x-otto-runtime': signed({ target: '/api/browser/screen' }) },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/browser/screen',
            headers: {
              'x-otto-runtime': signed({ target: '/api/browser/screen', developer: true }),
            },
          })
        ).statusCode,
        200,
      );
    } finally {
      await app.close();
    }
  });

  test('webhook and wake envelopes cannot authorize ordinary API calls', async () => {
    const app = Fastify();
    registerRuntimeAccess(app, context);
    app.post('/api/webhooks/telegram', async () => ({ ok: true }));
    app.get('/api/state', async () => ({ ok: true }));
    try {
      for (const kind of ['webhook', 'wake'] as const)
        assert.equal(
          (
            await app.inject({
              url: '/api/state',
              headers: { 'x-otto-runtime': signed({ kind }) },
            })
          ).statusCode,
          403,
        );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/webhooks/telegram',
            headers: {
              'x-otto-runtime': signed({ method: 'POST', target: '/api/webhooks/telegram' }),
            },
          })
        ).statusCode,
        403,
      );
    } finally {
      await app.close();
    }
  });

  test('runtime policy rejects encoded and normalized capability paths even with a valid signature', async () => {
    const app = Fastify();
    registerRuntimeAccess(app, context);
    let calls = 0;
    app.all('/api/*', async () => {
      calls++;
      return { ok: true };
    });
    try {
      for (const path of [
        '/api/%62rowser/screen',
        '/api/%69nspector/screen',
        '/api/%72untime/lease',
        '/api/%77ebhooks/telegram',
        '/api/state/../browser/screen',
        '/api//browser/screen',
        '/api/browser%2fscreen',
      ]) {
        const result = await app.inject({
          url: path,
          headers: { 'x-otto-runtime': signed({ target: path }) },
        });
        assert.ok([400, 401].includes(result.statusCode), `${path}: ${result.statusCode}`);
      }
      assert.equal(calls, 0);
      const safe = await app.inject({
        url: '/api/state?cursor=synthetic%2Fvalue',
        headers: { 'x-otto-runtime': signed({ target: '/api/state?cursor=synthetic%2Fvalue' }) },
      });
      assert.equal(safe.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('only wake signatures can call the exact POST wake and lease routes', async () => {
    const app = Fastify();
    registerRuntimeAccess(app, context);
    let calls = 0;
    app.all('/api/*', async () => {
      calls++;
      return { ok: true };
    });
    try {
      for (const path of ['/api/runtime/wake', '/api/runtime/lease']) {
        for (const kind of ['user', 'webhook'] as const) {
          const result = await app.inject({
            method: 'POST',
            url: path,
            headers: { 'x-otto-runtime': signed({ target: path, method: 'POST', kind }) },
          });
          assert.equal(result.statusCode, 403);
        }
        assert.equal(
          (
            await app.inject({
              url: path,
              headers: { 'x-otto-runtime': signed({ target: path, kind: 'wake' }) },
            })
          ).statusCode,
          403,
        );
      }
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runtime/other',
            headers: {
              'x-otto-runtime': signed({
                target: '/api/runtime/other',
                method: 'POST',
                kind: 'wake',
              }),
            },
          })
        ).statusCode,
        403,
      );
      assert.equal(calls, 0);
      for (const path of ['/api/runtime/wake', '/api/runtime/lease']) {
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: path,
              headers: {
                'x-otto-runtime': signed({ target: path, method: 'POST', kind: 'wake' }),
              },
            })
          ).statusCode,
          200,
        );
      }
      assert.equal(calls, 2);
    } finally {
      await app.close();
    }
  });
});

describe('deployment authentication', () => {
  function fixture() {
    const masterKey = randomBytes(32);
    const environment = 'production';
    let time = 1_000_000;
    const input = {
      action: 'prepare',
      nonce: randomUUID(),
      previousRelease: 'a'.repeat(40),
      targetRelease: 'b'.repeat(40),
      deadline: time + 300_000,
    };
    const body = Buffer.from(JSON.stringify(input));
    const token = signDeploymentRequest({ masterKey, environment, body, now: time });
    return {
      masterKey,
      environment,
      input,
      body,
      token,
      now: () => time,
      advance: (ms: number) => (time += ms),
    };
  }

  test('deployment capability binds the exact body, method, path and environment', async () => {
    const f = fixture();
    const verify = () => createDeploymentVerifier(f);
    assert.deepEqual(await verify()(f.token, 'POST', deploymentPath, f.body), f.input);
    for (const [method, path, body] of [
      ['GET', deploymentPath, f.body],
      ['POST', `${deploymentPath}?ignored=true`, f.body],
      ['POST', '/api/runtime/drain', f.body],
      ['POST', deploymentPath, Buffer.from(JSON.stringify({ ...f.input, action: 'complete' }))],
      ['POST', deploymentPath, Buffer.concat([f.body, Buffer.from(' ')])],
    ] as const)
      await assert.rejects(verify()(f.token, method, path, body), { status: 401 });
    await assert.rejects(
      createDeploymentVerifier({ ...f, environment: 'development' })(
        f.token,
        'POST',
        deploymentPath,
        f.body,
      ),
      { status: 401 },
    );
  });

  test('deployment verification rejects replay and uses the durable nonce callback after verification', async () => {
    const f = fixture();
    const accepted = new Map<string, number>();
    let calls = 0;
    const options = {
      ...f,
      async claimNonce(id: string, expiry: number) {
        calls += 1;
        if (accepted.has(id)) return false;
        accepted.set(id, expiry);
        return true;
      },
    };
    await assert.rejects(
      createDeploymentVerifier(options)('invalid', 'POST', deploymentPath, f.body),
    );
    assert.equal(calls, 0);
    await createDeploymentVerifier(options)(f.token, 'POST', deploymentPath, f.body);
    await assert.rejects(
      createDeploymentVerifier(options)(f.token, 'POST', deploymentPath, f.body),
    );
    assert.equal(calls, 2);
    const inMemory = createDeploymentVerifier(f);
    await inMemory(f.token, 'POST', deploymentPath, f.body);
    await assert.rejects(inMemory(f.token, 'POST', deploymentPath, f.body));
  });

  test('expired, excessively future, oversized and malformed signed deployment requests fail closed', async () => {
    const f = fixture();
    f.advance(30_000);
    await assert.rejects(createDeploymentVerifier(f)(f.token, 'POST', deploymentPath, f.body));
    const future = signDeploymentRequest({ ...f, now: f.now() + 6_000 });
    await assert.rejects(createDeploymentVerifier(f)(future, 'POST', deploymentPath, f.body));
    for (const body of [
      Buffer.from(JSON.stringify({ ...f.input, ownerId: randomUUID() })),
      Buffer.from(JSON.stringify({ ...f.input, action: 'exec' })),
      Buffer.from([0xff]),
    ]) {
      const signed = signDeploymentRequest({ ...f, body, now: f.now() });
      await assert.rejects(createDeploymentVerifier(f)(signed, 'POST', deploymentPath, body), {
        status: 401,
        message: 'The deployment operation could not be completed.',
      });
    }
    await assert.rejects(
      createDeploymentVerifier(f)(f.token, 'POST', deploymentPath, Buffer.alloc(2049)),
    );
  });

  test('tenant signing authority cannot authorize deployment control', async () => {
    const f = fixture();
    const ownerId = randomUUID();
    const secret = deriveRuntimeSecret(f.masterKey, f.environment, ownerId);
    assert.notDeepEqual(
      deriveDeploymentKey(f.masterKey, f.environment),
      Buffer.from(secret, 'base64url'),
    );
    const token = signRuntimeRequest({
      secret,
      ownerId,
      environment: f.environment,
      generation: '1',
      method: 'POST',
      target: deploymentPath,
      body: f.body,
      developer: true,
      now: f.now(),
    });
    await assert.rejects(createDeploymentVerifier(f)(token, 'POST', deploymentPath, f.body), {
      status: 401,
    });
  });
});

describe('tenant control', () => {
  function fixture() {
    const masterKey = randomBytes(32);
    const environment = 'development';
    const leases = new Map<string, TenantLease>();
    let leaseReads = 0;
    const writes: { action: string; input: ChannelAccountIdentity; lease: TenantLease }[] = [];
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    for (const ownerId of [ownerA, ownerB])
      leases.set(ownerId, {
        ownerId,
        environment,
        holderId: randomUUID(),
        generation: '1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    function guard(lease: TenantLease) {
      const current = leases.get(lease.ownerId);
      if (
        !current ||
        current.generation !== lease.generation ||
        current.holderId !== lease.holderId ||
        Date.parse(current.expiresAt) <= Date.now()
      )
        throw new ChannelAccountRegistryError('invalid_lease');
    }
    const handle = createTenantControl({
      masterKey,
      environment,
      currentLease: async (owner) => {
        leaseReads++;
        return leases.get(owner);
      },
      accounts: {
        async claimWithLease(input, lease) {
          guard(lease);
          writes.push({ action: 'claim', input, lease });
          return true;
        },
        async releaseWithLease(input, lease) {
          guard(lease);
          writes.push({ action: 'release', input, lease });
        },
      },
    });
    function request(
      ownerId = ownerA,
      options: {
        path?: string;
        method?: string;
        payload?: unknown;
        body?: string;
        headerOwner?: string;
        generation?: string;
        kind?: 'user' | 'wake' | 'webhook';
        developer?: boolean;
      } = {},
    ) {
      const method = options.method ?? 'POST';
      const path = options.path ?? '/api/internal/channels/claim';
      const bytes = Buffer.from(
        JSON.stringify(
          options.payload ?? { provider: 'telegram', accountId: '12345', revision: '1' },
        ),
      );
      const token = signRuntimeRequest({
        secret: deriveRuntimeSecret(masterKey, environment, ownerId),
        ownerId,
        environment,
        generation: options.generation ?? leases.get(ownerId)!.generation,
        method,
        target: path,
        body: bytes,
        developer: options.developer ?? false,
        kind: options.kind ?? 'wake',
      });
      return new Request(`http://otto.control${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-otto-owner': options.headerOwner ?? ownerId,
          [runtimeHeader]: token,
        },
        ...(!['GET', 'HEAD'].includes(method) ? { body: options.body ?? bytes } : {}),
      });
    }
    return {
      handle,
      request,
      leases,
      writes,
      ownerA,
      ownerB,
      masterKey,
      environment,
      leaseReads: () => leaseReads,
    };
  }

  test('control signatures bind the owner and lease while account bodies cannot select an owner', async () => {
    const f = fixture();
    const first = await f.handle(f.request());
    const second = await f.handle(f.request(f.ownerB, { path: '/api/internal/channels/release' }));
    assert.deepEqual(await first.json(), { claimed: true });
    assert.deepEqual(await second.json(), { ok: true });
    assert.deepEqual(
      f.writes.map((write) => [write.action, write.input.ownerId, write.lease.ownerId]),
      [
        ['claim', f.ownerA, f.ownerA],
        ['release', f.ownerB, f.ownerB],
      ],
    );
    assert.equal((await f.handle(f.request(f.ownerA, { headerOwner: f.ownerB }))).status, 401);
    assert.equal(
      (
        await f.handle(
          f.request(f.ownerA, {
            payload: { provider: 'telegram', accountId: '12345', ownerId: f.ownerB },
          }),
        )
      ).status,
      400,
    );
    assert.equal(f.writes.length, 2);
  });

  test('control denies changed bodies, replay, wrong capabilities and nonexact routes', async () => {
    const f = fixture();
    const request = f.request();
    assert.equal((await f.handle(request.clone())).status, 200);
    assert.equal((await f.handle(request.clone())).status, 401);
    for (const options of [
      { body: '{"provider":"telegram","accountId":"changed"}' },
      { kind: 'user' as const },
      { kind: 'webhook' as const },
      { developer: true },
      { method: 'GET' },
      { path: '/api/internal/channels/claim?owner=other' },
      { path: '/api/internal/channels/%63laim' },
      { path: '/api/internal/channels/claim/' },
      { path: '/api/internal/channels//claim' },
      { path: '/api/internal/channels/unknown' },
      { payload: { provider: 'telegram', accountId: 'x'.repeat(5000) } },
    ])
      assert.equal((await f.handle(f.request(f.ownerA, options))).status, 401);
    const unsigned = f.request();
    unsigned.headers.delete(runtimeHeader);
    assert.equal((await f.handle(unsigned)).status, 401);
    assert.equal(f.writes.length, 1);
  });

  test('control rejects old generations and passes the exact lease to the atomic mutation guard', async () => {
    const f = fixture();
    const old = f.request();
    f.leases.set(f.ownerA, { ...f.leases.get(f.ownerA)!, holderId: randomUUID(), generation: '2' });
    assert.equal((await f.handle(old)).status, 401);
    assert.equal((await f.handle(f.request())).status, 200);
    assert.equal(f.writes[0].lease.generation, '2');
    const signed = f.request();
    const bytes = new Uint8Array(await signed.arrayBuffer());
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const slow = new Request(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: new ReadableStream(
        {
          async pull(controller) {
            entered();
            await ready;
            controller.enqueue(bytes);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: 'half',
    } as RequestInit);
    const rejected = assert.rejects(f.handle(slow), { code: 'invalid_lease', statusCode: 401 });
    try {
      await Promise.race([
        reading,
        rejected.then(() => assert.fail('Control did not read the body.')),
      ]);
      f.leases.set(f.ownerA, {
        ...f.leases.get(f.ownerA)!,
        holderId: randomUUID(),
        generation: '3',
      });
    } finally {
      complete();
    }
    await rejected;
    assert.equal(f.writes.length, 1);
    f.leases.get(f.ownerA)!.expiresAt = new Date(0).toISOString();
    assert.equal((await f.handle(f.request())).status, 401);
    f.leases.delete(f.ownerB);
    assert.equal((await f.handle(f.request(f.ownerB, { generation: '1' }))).status, 401);
  });
});

describe('hosted webhooks', () => {
  function fixture() {
    const masterKey = randomBytes(32);
    const environment = 'development';
    const owners = [randomUUID(), randomUUID()];
    const calls: {
      ownerId: string;
      request: Request;
      access: Parameters<TenantRuntimeHost['fetch']>[2];
    }[] = [];
    const verified: { body: unknown; headers: Record<string, string | string[] | undefined> }[] =
      [];
    let eventOwner: string = owners[0];
    const integrations: Pick<IntegrationProvider, 'verifyWebhook' | 'webhooksConfigured'> = {
      webhooksConfigured: true,
      async verifyWebhook(body, headers) {
        verified.push({ body, headers });
        if (headers['webhook-signature'] !== 'synthetic-valid-signature')
          throw new Error('Synthetic private provider detail');
        return {
          id: 'fixture-event',
          ownerId: eventOwner,
          service: 'gmail',
          accountId: 'fixture-account',
          subscriptionId: 'fixture-subscription',
          trigger: 'fixture-trigger',
          data: {},
        };
      },
    };
    const handle = createHostedWebhooks({
      masterKey,
      environment,
      integrations,
      listOwners: async () => owners,
      hasOwner: async (owner) => owners.includes(owner as (typeof owners)[number]),
      runtimes: {
        async fetch(ownerId, request, access) {
          calls.push({ ownerId, request, access });
          return Response.json({ ok: true });
        },
        async close() {},
      },
    });
    const path = (
      ownerId = owners[0],
      provider: 'telegram' | 'whatsapp' = 'telegram',
      env = environment,
    ) => `/api/webhooks/${provider}/${channelWebhookToken(masterKey, env, ownerId, provider)}`;
    const request = (path: string, body = '{"synthetic":"event"}', headers: HeadersInit = {}) =>
      new Request(`https://otto.example.test${path}`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...headers },
      });
    return {
      handle,
      integrations,
      owners,
      calls,
      verified,
      request,
      path,
      eventOwner: (owner: string) => {
        eventOwner = owner;
      },
    };
  }

  test('hosted integration routing accepts only the verified owner and preserves raw signed bytes', async () => {
    const f = fixture();
    const body = ' { "ownerId" : "untrusted", "data": [1, 2] } ';
    const response = await f.handle(
      f.request(`/api/webhooks/composio?ownerId=${f.owners[1]}`, body, {
        'webhook-signature': 'synthetic-valid-signature',
        'webhook-id': 'fixture-id',
        'webhook-timestamp': '123456',
        'x-otto-owner': f.owners[1],
        'x-otto-runtime': 'forged',
        cookie: 'private-cookie',
        authorization: 'Bearer private',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].ownerId, f.owners[0]);
    assert.deepEqual(f.calls[0].access, { developer: false, kind: 'webhook' });
    assert.equal(f.verified[0].body, body);
    assert.equal(await f.calls[0].request.text(), body);
    for (const header of ['cookie', 'authorization', 'x-otto-owner', 'x-otto-runtime']) {
      assert.equal(f.verified[0].headers[header], undefined);
      assert.equal(f.calls[0].request.headers.get(header), null);
    }
    assert.equal(f.calls[0].request.headers.get('webhook-signature'), 'synthetic-valid-signature');
  });

  test('hosted webhook failures and unknown owners never start a runtime', async () => {
    const f = fixture();
    const invalid = await f.handle(f.request('/api/webhooks/composio'));
    assert.equal(invalid.status, 401);
    assert.deepEqual(await invalid.json(), { error: 'Invalid webhook signature or payload.' });
    f.integrations.webhooksConfigured = false;
    assert.equal((await f.handle(f.request('/api/webhooks/composio'))).status, 503);
    f.integrations.webhooksConfigured = true;
    f.eventOwner(randomUUID());
    assert.equal(
      (
        await f.handle(
          f.request('/api/webhooks/composio', '{}', {
            'webhook-signature': 'synthetic-valid-signature',
          }),
        )
      ).status,
      202,
    );
    f.eventOwner('untrusted-owner');
    assert.equal(
      (
        await f.handle(
          f.request('/api/webhooks/composio', '{}', {
            'webhook-signature': 'synthetic-valid-signature',
          }),
        )
      ).status,
      401,
    );
    const verifications = f.verified.length;
    assert.equal(
      (await f.handle(f.request('/api/webhooks/composio', 'x'.repeat(262_145)))).status,
      413,
    );
    assert.equal(f.verified.length, verifications);
    assert.equal(f.calls.length, 0);
  });

  test('channel webhook capabilities bind provider, deployment and owner before actor dispatch', async () => {
    const f = fixture();
    for (const owner of f.owners) {
      const body = JSON.stringify({ accountId: 'untrusted', ownerId: f.owners[0] });
      assert.equal(
        (
          await f.handle(
            f.request(`${f.path(owner)}?ownerId=${f.owners[1]}`, body, {
              'x-telegram-bot-api-secret-token': 'synthetic-telegram-secret',
            }),
          )
        ).status,
        200,
      );
      const call = f.calls.at(-1)!;
      assert.equal(call.ownerId, owner);
      assert.equal(new URL(call.request.url).pathname, '/api/webhooks/telegram');
      assert.equal(
        call.request.headers.get('x-telegram-bot-api-secret-token'),
        'synthetic-telegram-secret',
      );
      assert.equal(await call.request.text(), body);
    }
    for (const path of [
      f.path(f.owners[0], 'telegram', 'production'),
      f.path().replace('/telegram/', '/whatsapp/'),
      f.path(randomUUID()),
    ])
      assert.equal((await f.handle(f.request(path))).status, 202);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.handle(f.request('/api/webhooks/telegram/not-a-token'))).status, 404);
    assert.equal((await f.handle(new Request(`https://otto.example.test${f.path()}`))).status, 404);
  });
});

describe('local access', () => {
  test('desktop APIs require the private launch token including streams, files and webhook routes', async () => {
    const app = Fastify();
    const token = randomBytes(32).toString('base64url');
    registerLocalAccess(app, 4310, { token });
    let handled = 0;
    const routes = [
      { method: 'GET' as const, url: '/api/health' },
      { method: 'GET' as const, url: '/api/events' },
      { method: 'GET' as const, url: '/api/artifacts/synthetic-download' },
      { method: 'GET' as const, url: '/api/desktop/status' },
      { method: 'POST' as const, url: '/api/messages' },
      { method: 'POST' as const, url: '/api/runtime/drain' },
      { method: 'POST' as const, url: '/api/webhooks/composio' },
      { method: 'POST' as const, url: '/api/webhooks/telegram' },
      { method: 'POST' as const, url: '/api/webhooks/whatsapp' },
      { method: 'GET' as const, url: '/api/webhooks/whatsapp' },
    ];
    for (const route of routes)
      app.route({
        ...route,
        async handler() {
          handled++;
          return { ok: true };
        },
      });
    const headers = { host: '127.0.0.1:4310' };
    try {
      for (const route of routes) {
        for (const candidate of [
          undefined,
          token.slice(1),
          randomBytes(32).toString('base64url'),
        ]) {
          const response = await app.inject({
            ...route,
            headers: {
              ...headers,
              ...(candidate ? { 'x-otto-desktop-token': candidate } : {}),
            },
          });
          assert.equal(response.statusCode, 401, route.url);
          assert.ok(!response.body.includes(token));
        }
        assert.equal(
          (
            await app.inject({
              ...route,
              url: `${route.url}?token=${token}`,
              headers: { ...headers, cookie: `x-otto-desktop-token=${token}` },
            })
          ).statusCode,
          401,
        );
      }
      assert.equal(handled, 0);
      for (const route of routes)
        assert.equal(
          (
            await app.inject({
              ...route,
              headers: { ...headers, 'x-otto-desktop-token': token },
            })
          ).statusCode,
          200,
        );
      assert.equal(handled, routes.length);
    } finally {
      await app.close();
    }
  });

  test('desktop tokens cannot authorize foreign origins, alternate hosts or cross-site API calls', async () => {
    const app = Fastify();
    const token = randomBytes(32).toString('base64url');
    registerLocalAccess(app, 4310, { token });
    let handled = 0;
    app.get('/api/state', async () => {
      handled++;
      return { ok: true };
    });
    const headers = { host: '127.0.0.1:4310', 'x-otto-desktop-token': token };
    try {
      for (const rejected of [
        { ...headers, host: 'localhost:4310' },
        { ...headers, host: '[::1]:4310' },
        { ...headers, host: '127.0.0.1:4311' },
        { ...headers, host: 'attacker.example:4310' },
        { ...headers, origin: 'http://localhost:4310' },
        { ...headers, origin: 'http://127.0.0.1:4311' },
        { ...headers, origin: 'https://127.0.0.1:4310' },
        { ...headers, origin: 'https://attacker.example' },
        { ...headers, origin: 'null' },
        { ...headers, 'sec-fetch-site': 'cross-site' },
      ])
        assert.equal((await app.inject({ url: '/api/state', headers: rejected })).statusCode, 403);
      assert.equal(handled, 0);
      assert.equal(
        (
          await app.inject({
            url: '/api/state',
            headers: { ...headers, origin: 'http://127.0.0.1:4310' },
          })
        ).statusCode,
        200,
      );
      assert.equal(handled, 1);
    } finally {
      await app.close();
    }
  });

  test('desktop OAuth exemption is limited to the exact GET callback and one bounded state', async () => {
    const app = Fastify();
    const token = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    registerLocalAccess(app, 4310, { token });
    const callbacks: string[] = [];
    app.get<{ Querystring: { state: string } }>('/api/apps/callback', async (request) => {
      callbacks.push(request.query.state);
      return { ok: true };
    });
    app.get('/api/models/oauth/callback', async () => ({ ok: true }));
    app.post('/api/models/oauth/callback', async () => ({ ok: true }));
    app.post('/api/apps/callback', async () => ({ ok: true }));
    const headers = {
      host: '127.0.0.1:4310',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    try {
      for (const url of [
        '/api/models/oauth/callback',
        '/api/models/oauth/callback?state=short',
        `/api/models/oauth/callback?state=${state}&state=${state}`,
        `/api/models/oauth/callback/extra?state=${state}`,
        '/api/apps/callback',
        '/api/apps/callback?state=short',
        `/api/apps/callback?state=${state}&state=${state}`,
        `/api/apps/callback/?state=${state}`,
        `/api/apps/callback/extra?state=${state}`,
        `/api/apps?state=${state}`,
        `/api/apps/callback?state=${'!'.repeat(43)}`,
      ])
        assert.equal((await app.inject({ url, headers })).statusCode, 401, url);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/apps/callback?state=${state}`,
            headers,
          })
        ).statusCode,
        401,
      );
      assert.equal(callbacks.length, 0);
      assert.equal(
        (await app.inject({ url: `/api/apps/callback?state=${state}`, headers })).statusCode,
        200,
      );
      assert.deepEqual(callbacks, [state]);
      assert.equal(
        (await app.inject({ url: `/api/models/oauth/callback?state=${state}`, headers }))
          .statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/models/oauth/callback?state=${state}`,
            headers,
          })
        ).statusCode,
        401,
      );
      for (const rejected of [
        { ...headers, host: 'attacker.example:4310' },
        { ...headers, origin: 'https://attacker.example' },
      ])
        assert.equal(
          (
            await app.inject({
              url: `/api/apps/callback?state=${state}`,
              headers: rejected,
            })
          ).statusCode,
          403,
        );
      assert.equal(callbacks.length, 1);
    } finally {
      await app.close();
    }
  });

  test('OAuth return permits top-level Apps and onboarding navigation and keeps cross-site APIs blocked', async () => {
    const app = Fastify();
    registerLocalAccess(app, 4310);
    app.get('/apps', async () => 'Application shell');
    app.get('/onboarding', async () => 'Application shell');
    app.get('/goals', async () => 'Application shell');
    app.get('/schedule', async () => 'Application shell');
    app.get('/browser', async () => 'Application shell');
    app.get('/connected.html', async () => 'Window return page');
    app.get('/vault/:id', async () => 'Application shell');
    app.post('/api/credential-requests/:id/refresh', async () => ({ ok: true }));
    app.post('/apps', async () => ({ ok: true }));
    app.get('/api/apps', async () => []);
    app.post('/api/apps/gmail/connect', async () => ({ ok: true }));
    app.get('/api/apps/callback', async (_request, reply) =>
      reply.redirect('/onboarding?connection=connected'),
    );
    const headers = {
      host: 'localhost:4310',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/credential-requests/test-link/refresh',
            headers,
          })
        ).statusCode,
        403,
      );
      const callback = await app.inject({ url: '/api/apps/callback', headers });
      assert.equal(callback.statusCode, 302);
      assert.equal(
        (await app.inject({ url: callback.headers.location!, headers })).statusCode,
        200,
      );
      for (const url of [
        '/onboarding?connection=connected',
        '/apps?connection=connected',
        '/goals',
        '/schedule',
        '/browser',
        '/vault/test-link',
        '/onboarding',
        '/connected.html',
      ]) {
        assert.equal((await app.inject({ url, headers })).statusCode, 200);
        assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
        assert.equal(
          (await app.inject({ url, headers: { ...headers, 'sec-fetch-dest': 'iframe' } }))
            .statusCode,
          403,
        );
      }
      for (const url of ['/api/apps', '/api/apps/gmail/connect']) {
        assert.equal((await app.inject({ url, headers })).statusCode, 403);
        assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 403);
      }
      for (const rejected of [
        { ...headers, 'sec-fetch-mode': 'cors' },
        { ...headers, 'sec-fetch-dest': 'iframe' },
        { ...headers, origin: 'https://attacker.example' },
        { ...headers, host: 'attacker.example:4310' },
      ]) {
        assert.equal((await app.inject({ url: '/apps', headers: rejected })).statusCode, 403);
      }
      assert.equal((await app.inject({ method: 'POST', url: '/apps', headers })).statusCode, 403);
    } finally {
      await app.close();
    }
  });
});

describe('signed multipart', () => {
  const boundary = 'otto-synthetic-multipart-boundary';
  const contentType = `multipart/form-data; boundary=${boundary}`;
  type Part = { name: string; bytes: Buffer; filename?: string; mimeType?: string };
  function form(parts: Part[], close = true) {
    const chunks: Buffer[] = [];
    for (const part of parts) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.mimeType ? `Content-Type: ${part.mimeType}\r\n` : ''}\r\n`,
        ),
      );
      chunks.push(part.bytes, Buffer.from('\r\n'));
    }
    if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }
  const upload = {
    name: 'file',
    filename: 'synthetic.bin',
    mimeType: 'application/octet-stream',
    bytes: Buffer.from([0, 1, 127, 128, 255]),
  };

  test(
    'signed tenant uploads parse only complete authenticated multipart bytes over HTTP',
    { timeout: 20_000 },
    async (t) => {
      const ownerId = randomUUID();
      const secret = deriveRuntimeSecret(randomBytes(32), 'development', ownerId);
      const context = { ownerId, secret, environment: 'development', generation: '1' };
      const environment = {
        DOTENV_CONFIG_PATH: '/nonexistent-otto-fixture-env',
        DATABASE_URL: 'postgresql://fixture:unused@127.0.0.1:1/unavailable',
        OTTO_MODE: 'tenant',
        OTTO_OWNER_ID: ownerId,
        OTTO_RUNTIME_SECRET: secret,
        OTTO_RUNTIME_GENERATION: '1',
        OTTO_ENVIRONMENT: 'development',
        PGBOSS_SCHEMA: 'sk_jobs_' + 'a'.repeat(32),
      };
      const previous = Object.fromEntries(
        Object.keys(environment).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, environment);
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const { createApp } = await import('../src/server/app.ts');
      const { localArtifacts, maxFileSize } = await import('../src/server/artifacts.ts');
      const { pool } = await import('../src/server/db.ts');
      const writes: { bytes: Buffer; name: string; mimeType: string }[] = [];
      const app = await createApp({
        artifacts: {
          ...localArtifacts,
          async storeArtifact(bytes, name, mimeType) {
            writes.push({ bytes, name, mimeType });
            const id = randomUUID();
            return { id, name, mimeType, size: bytes.length, url: `/api/artifacts/${id}` };
          },
        },
      });
      const rawRequests = new WeakMap<FastifyRequest, FastifyRequest['raw']>();
      app.addHook('onRequest', async (request) => {
        rawRequests.set(request, request.raw);
      });
      app.addHook('preHandler', async (request) => {
        assert.equal(request.raw, rawRequests.get(request));
      });
      t.after(async () => {
        await app.close();
        await pool.end();
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      function token(target: string, body: Buffer) {
        return signRuntimeRequest({ ...context, method: 'POST', target, body, developer: false });
      }
      const send = (
        target: string,
        body: Buffer,
        signature = token(target, body),
        type = contentType,
      ) =>
        fetch(origin + target, {
          method: 'POST',
          headers: { 'content-type': type, [runtimeHeader]: signature },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(5000),
        });
      await t.test('hosted users and developers cannot reset conversations', async () => {
        const target = '/api/conversation/reset';
        const body = Buffer.from(JSON.stringify({ threadId: randomUUID() }));
        for (const developer of [false, true]) {
          const signature = signRuntimeRequest({
            ...context,
            method: 'POST',
            target,
            body,
            developer,
          });
          const result = await send(target, body, signature, 'application/json');
          assert.equal(result.status, 404, await result.text());
        }
      });
      await t.test(
        'valid files preserve bytes and metadata; replay and tampering have no effects',
        async () => {
          const bytes = form([{ name: 'context', bytes: Buffer.from('synthetic') }, upload]);
          const signature = token('/api/uploads', bytes);
          const result = await send('/api/uploads', bytes, signature);
          assert.equal(result.status, 200);
          assert.equal((await result.json()).name, upload.filename);
          assert.deepEqual(writes, [
            { bytes: upload.bytes, name: upload.filename, mimeType: upload.mimeType },
          ]);
          assert.equal((await send('/api/uploads', bytes, signature)).status, 401);
          const changed = Buffer.from(bytes);
          changed[changed.length - 1] ^= 1;
          assert.equal(
            (await send('/api/uploads', changed, token('/api/uploads', bytes))).status,
            401,
          );
          assert.equal(writes.length, 1);
        },
      );
      await t.test(
        'extra files, extra fields, and oversized files cannot partially publish the first file',
        async () => {
          const before = writes.length;
          for (const body of [
            form([upload, { ...upload, filename: 'extra.bin' }]),
            form([
              upload,
              ...Array.from({ length: 6 }, (_, index) => ({
                name: `field${index}`,
                bytes: Buffer.from('value'),
              })),
            ]),
            form([{ ...upload, bytes: Buffer.alloc(maxFileSize + 1) }]),
            Buffer.alloc(16 * 1024 * 1024 + 1),
          ]) {
            assert.equal((await send('/api/uploads', body)).status, 413);
            assert.equal(writes.length, before);
          }
          const accepted = await send(
            '/api/uploads',
            form([{ ...upload, bytes: Buffer.alloc(maxFileSize) }]),
          );
          assert.equal(accepted.status, 200);
          assert.equal(writes.at(-1)!.bytes.length, maxFileSize);
        },
      );
    },
  );
});
