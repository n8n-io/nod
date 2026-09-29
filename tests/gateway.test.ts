import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import type { InjectOptions } from 'fastify';
import type { AuthenticatedSession, AuthenticationProvider } from '../src/ports/authentication.ts';
import type { TenantRuntimeHost } from '../src/ports/tenant-runtime.ts';
import { createGateway } from '../src/server/gateway.ts';
import { deploymentHeader, signDeploymentRequest } from '../src/server/deployment-auth.ts';

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
  const profiles: { owner: string; body: string; developer: boolean; method: string }[] = [];
  let displayName: string | null = null;
  let profileStatus = 200;
  let streamCancelled = 0;
  let lookups = 0;
  let accountReads = 0;
  let beforeAccountRead: () => void | Promise<void> = () => {};
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let reply: (owner: string, request: Request) => Promise<Response> = async (owner) =>
    Response.json({ owner, record: `Synthetic data for ${owner}` });
  const authentication: AuthenticationProvider = {
    configured: true,
    async initialize() {},
    async session(headers) {
      lookups++;
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
      if (new URL(request.url).pathname === '/api/account/profile') {
        profiles.push({
          owner,
          body: await request.text(),
          developer: options.developer,
          method: request.method,
        });
        return Response.json({ ok: profileStatus === 200 }, { status: profileStatus });
      }
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
        accountReads++;
        await beforeAccountRead();
        return { theme: 'system', onboardingCompleted: true, displayName };
      },
      async update(_owner, input) {
        if (input.name) displayName = input.name;
        return { theme: 'system', onboardingCompleted: true, displayName };
      },
    },
  });
  return {
    app,
    runtimes,
    users,
    cookies,
    calls,
    profiles,
    sessions,
    displayName: (value: string | null) => {
      displayName = value;
    },
    profileStatus: (value: number) => {
      profileStatus = value;
    },
    headers: (index = 0) => ({ host, cookie: cookies[index], 'x-otto-account': users[index] }),
    reply: (value: typeof reply) => {
      reply = value;
    },
    eventStream: () => {
      reply = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode('data: synthetic event\n\n'));
            },
            cancel() {
              streamCancelled++;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
    },
    stream: () => stream,
    streamCancelled: () => streamCancelled,
    lookups: () => lookups,
    accountReads: () => accountReads,
    beforeAccountRead: (value: typeof beforeAccountRead) => {
      beforeAccountRead = value;
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

test('onboarding preparation routes only the authenticated owner with a fixed private request', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  f.reply(async () => Response.json({ ok: true }));
  for (const index of [0, 1]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: {
        ...f.headers(index),
        origin,
        'x-otto-owner': f.users[1 - index],
        'x-otto-generation': '999',
      },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    const forwarded = f.calls[index];
    assert.equal(forwarded.owner, f.users[index]);
    assert.equal(forwarded.url, `${origin}/api/account/prepare`);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.body, '{}');
    assert.equal(forwarded.developer, false);
    assert.deepEqual([...forwarded.headers], [['content-type', 'application/json']]);
  }
  f.reply(async () => Response.json({ ok: true, sandboxId: 'private' }));
  const failed = await f.app.inject({
    method: 'POST',
    url: '/api/account/prepare',
    headers: { ...f.headers(), origin },
    payload: {},
  });
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body, /private|sandboxId/);
});

test('completing onboarding starts the welcome in the authenticated owner runtime', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  let start = 200;
  f.reply(async (_owner, request) =>
    new URL(request.url).pathname === '/api/onboarding/start' && start !== 200
      ? Response.json({ error: 'Setup is unavailable.' }, { status: start })
      : Response.json({ ok: true }),
  );
  const direct = await f.app.inject({
    method: 'POST',
    url: '/api/onboarding/start',
    headers: { ...f.headers(1), origin },
    payload: { name: 'Forged' },
  });
  assert.equal(direct.statusCode, 404);
  assert.equal(f.calls.length, 0);
  const complete = () =>
    f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { ...f.headers(1), origin },
      payload: { onboardingCompleted: true },
    });
  assert.equal((await complete()).statusCode, 200);
  assert.deepEqual(
    f.calls.map((call) => [call.owner, call.url, call.method, call.body, call.developer]),
    [
      [f.users[1], `${origin}/api/account/prepare`, 'POST', '{}', false],
      [f.users[1], `${origin}/api/onboarding/start`, 'POST', '{"name":"Synthetic user"}', false],
    ],
  );
  const landed = await f.app.inject({
    method: 'POST',
    url: '/api/account/welcome',
    headers: { ...f.headers(1), origin, 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(landed.statusCode, 200);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    [f.calls.at(-1)!.owner, f.calls.at(-1)!.url, f.calls.at(-1)!.body],
    [f.users[1], `${origin}/api/onboarding/start`, '{"name":"Synthetic user"}'],
  );
  start = 503;
  const failed = await complete();
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body, /unavailable/);
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
      const result = await f.app.inject({ method: 'POST', url, headers: { host }, payload: body });
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

test('hosted artifact responses preserve download sandboxing and byte-range behavior', async () => {
  const f = await fixture();
  f.reply(async (_owner, request) => {
    assert.equal(request.headers.get('range'), 'bytes=2-4');
    return new Response('cde', {
      status: 206,
      headers: {
        'content-type': 'text/html',
        'content-disposition': 'attachment; filename="synthetic.html"',
        'content-range': 'bytes 2-4/10',
        'accept-ranges': 'bytes',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });
  try {
    const result = await f.app.inject({
      url: `/api/artifacts/${randomUUID()}`,
      headers: { ...f.headers(), range: 'bytes=2-4' },
    });
    assert.equal(result.statusCode, 206);
    assert.equal(result.body, 'cde');
    assert.equal(result.headers['content-range'], 'bytes 2-4/10');
    assert.equal(result.headers['accept-ranges'], 'bytes');
    assert.equal(result.headers['content-disposition'], 'attachment; filename="synthetic.html"');
    assert.equal(
      result.headers['content-security-policy'],
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    );
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  } finally {
    await f.app.close();
  }
});

test(
  'event streams require their expected account and stop on revocation',
  { timeout: 2000 },
  async () => {
    const f = await fixture();
    f.eventStream();
    try {
      for (const url of ['/api/events', `/api/events?account=${f.users[1]}`]) {
        assert.equal((await f.app.inject({ url, headers: f.headers() })).statusCode, 401);
      }
      assert.equal(f.calls.length, 0);
      const pending = f.app.inject({
        url: `/api/events?account=${f.users[0]}`,
        headers: f.headers(),
      });
      const started = setInterval(() => {
        if (f.stream()) f.sessions.delete(f.users[0]);
      }, 1);
      let result;
      try {
        result = await pending;
      } finally {
        clearInterval(started);
      }
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, 'data: synthetic event\n\n');
      assert.equal(f.streamCancelled(), 1);
    } finally {
      await f.app.close();
    }
  },
);

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

test('gateway applies narrow body limits before calling service handlers', async () => {
  let calls = 0;
  const handler = async () => {
    calls++;
    return Response.json({ ok: true });
  };
  const f = await fixture({ internal: handler, webhook: handler });
  try {
    for (const [url, limit] of [
      ['/api/internal/channels/claim', 4096],
      ['/api/internal/channels/release', 4096],
      ['/api/webhooks/composio', 262_144],
      [`/api/webhooks/telegram/${'x'.repeat(43)}`, 262_144],
      [`/api/webhooks/whatsapp/${'x'.repeat(43)}`, 262_144],
    ] as const) {
      const response = await f.app.inject({
        method: 'POST',
        url,
        headers: { host, 'content-type': 'application/json' },
        payload: Buffer.alloc(limit + 1),
      });
      assert.equal(response.statusCode, 413, url);
    }
    assert.equal(calls, 0);
  } finally {
    await f.app.close();
  }
});

test('gateway returns the authentication failure when discarded response cancellation fails', async () => {
  const f = await fixture();
  let cancelled = 0;
  f.reply(async (owner) => {
    f.sessions.delete(owner);
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          throw new Error('Synthetic private cancellation detail');
        },
      }),
    );
  });
  try {
    const response = await f.app.inject({
      url: `/api/events?account=${f.users[0]}`,
      headers: f.headers(),
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Sign in to continue.' });
    assert.equal(cancelled, 1);
  } finally {
    await f.app.close();
  }
});

test('gateway sends the signed-in profile to the owner runtime once per change and keeps the route private', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  Object.assign(f.sessions.get(f.users[0])!, { givenName: 'Synthetic' });
  const state = (index = 0) => f.app.inject({ url: '/api/state', headers: f.headers(index) });
  f.profileStatus(503);
  assert.equal((await state()).statusCode, 200);
  assert.equal(f.calls.length, 1);
  f.profileStatus(200);
  assert.equal((await state()).statusCode, 200);
  assert.equal((await state()).statusCode, 200);
  assert.equal((await state(1)).statusCode, 200);
  f.displayName('Syn');
  await f.app.inject({ url: '/api/session', headers: f.headers() });
  assert.equal((await state()).statusCode, 200);
  assert.deepEqual(
    f.profiles.map(({ owner, body, developer, method }) => ({
      owner,
      profile: JSON.parse(body),
      developer,
      method,
    })),
    [
      ...[0, 0].map(() => ({
        owner: f.users[0],
        profile: {
          name: 'Synthetic user',
          givenName: 'Synthetic',
          email: 'synthetic@example.test',
          preferredName: null,
        },
        developer: false,
        method: 'PUT',
      })),
      {
        owner: f.users[1],
        profile: {
          name: 'Synthetic user',
          givenName: null,
          email: 'synthetic@example.test',
          preferredName: null,
        },
        developer: false,
        method: 'PUT',
      },
      {
        owner: f.users[0],
        profile: {
          name: 'Synthetic user',
          givenName: 'Synthetic',
          email: 'synthetic@example.test',
          preferredName: 'Syn',
        },
        developer: false,
        method: 'PUT',
      },
    ],
  );
  assert.equal(f.calls.length, 5);
  const direct = await f.app.inject({
    method: 'PUT',
    url: '/api/account/profile',
    headers: { ...f.headers(), origin },
    payload: { name: 'Forged', givenName: null, email: null, preferredName: null },
  });
  assert.equal(direct.statusCode, 404);
  assert.equal(f.profiles.length, 4);
  assert.equal(f.calls.length, 5);
  await f.app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers: { ...f.headers(), origin },
    payload: { name: 'Sy' },
  });
  const beforeReads = f.accountReads();
  await Promise.all([state(), state(), state()]);
  assert.equal(f.profiles.length, 5);
  assert.equal(JSON.parse(f.profiles[4].body).preferredName, 'Sy');
  assert.equal(f.accountReads(), beforeReads);
});

test('ordinary runtime requests look up the session once', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ url: '/api/apps', headers: f.headers() });
    assert.equal(response.statusCode, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.lookups(), 1);
  } finally {
    await f.app.close();
  }
});

test('a signed-in session read warms only its own runtime without waiting for it', async () => {
  const f = await fixture();
  const warmed: string[] = [];
  f.runtimes.warm = (owner) => {
    warmed.push(owner);
    return warmed.length === 1 ? new Promise(() => {}) : Promise.reject(new Error('Synthetic'));
  };
  try {
    assert.equal((await f.app.inject({ url: '/api/session', headers: { host } })).statusCode, 200);
    assert.deepEqual(warmed, []);
    for (const index of [0, 1]) {
      const response = await f.app.inject({ url: '/api/session', headers: f.headers(index) });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().user.id, f.users[index]);
    }
    assert.deepEqual(warmed, f.users);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.app.close();
  }
});

test('welcome synchronizes the signed-in profile before starting and retries a failed sync', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  f.reply(async (owner, request) => {
    if (new URL(request.url).pathname === '/api/onboarding/start') {
      assert.equal(f.profiles.at(-1)?.owner, owner);
      assert.equal(JSON.parse(f.profiles.at(-1)!.body).email, 'synthetic@example.test');
    }
    return Response.json({ ok: true });
  });
  const welcome = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/account/welcome',
      headers: { ...f.headers(), origin },
      payload: {},
    });
  f.profileStatus(503);
  assert.equal((await welcome()).statusCode, 503);
  assert.equal(f.calls.length, 0);
  f.profileStatus(200);
  assert.equal((await welcome()).statusCode, 200);
  assert.equal(f.profiles.length, 2);
  const completed = await f.app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers: { ...f.headers(1), origin },
    payload: { name: 'Preferred fixture', onboardingCompleted: true },
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(JSON.parse(f.profiles.at(-1)!.body).preferredName, 'Preferred fixture');
});

test('welcome keeps its pending preferred name through concurrent requests and releases it after failure', async (t) => {
  for (const failed of [false, true])
    await t.test(failed ? 'failed start' : 'successful start', async (t) => {
      const f = await fixture();
      t.after(() => f.app.close());
      f.displayName('Saved fixture');
      let started!: () => void;
      let finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      t.after(() => finish());
      f.reply(async (_owner, request) => {
        if (new URL(request.url).pathname === '/api/onboarding/start') {
          started();
          await held;
          if (failed) return Response.json({ ok: false }, { status: 503 });
        }
        return Response.json({ ok: true });
      });
      const completing = f.app
        .inject({
          method: 'PATCH',
          url: '/api/account',
          headers: { ...f.headers(), origin },
          payload: { name: 'Welcome fixture', onboardingCompleted: true },
        })
        .then((response) => response);
      await entered;
      await f.app.inject({ url: '/api/state', headers: f.headers() });
      await f.app.inject({ url: '/api/state', headers: f.headers(1) });
      const profile = (owner: string) =>
        JSON.parse(f.profiles.findLast((profile) => profile.owner === owner)!.body);
      assert.equal(profile(f.users[0]).preferredName, 'Welcome fixture');
      assert.equal(profile(f.users[1]).preferredName, 'Saved fixture');
      finish();
      assert.equal((await completing).statusCode, failed ? 503 : 200);
      const saved = await f.app.inject({ url: '/api/session', headers: f.headers() });
      assert.equal(saved.json().user.name, failed ? 'Saved fixture' : 'Welcome fixture');
      const reads = f.accountReads();
      await f.app.inject({ url: '/api/state', headers: f.headers() });
      assert.equal(profile(f.users[0]).preferredName, failed ? 'Saved fixture' : 'Welcome fixture');
      assert.equal(f.accountReads(), reads);
    });
});

test('overlapping welcome starts retain their own name and recheck the queued session', async (t) => {
  for (const revoked of [false, true])
    await t.test(revoked ? 'revoked session' : 'current session', async (t) => {
      const f = await fixture();
      let finish!: () => void;
      let started!: () => void;
      let prepared!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const secondPrepared = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      t.after(async () => {
        finish();
        await f.app.close();
      });
      let preparations = 0;
      const names: string[] = [];
      f.reply(async (_owner, request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/account/prepare' && ++preparations === 2) prepared();
        if (path === '/api/onboarding/start') {
          names.push((await request.json()).name);
          if (names.length === 1) {
            started();
            await held;
          }
        }
        return Response.json({ ok: true });
      });
      const complete = (name: string) =>
        f.app
          .inject({
            method: 'PATCH',
            url: '/api/account',
            headers: { ...f.headers(), origin },
            payload: { name, onboardingCompleted: true },
          })
          .then((response) => response);
      const first = complete('First fixture');
      await entered;
      const second = complete('Second fixture');
      await secondPrepared;
      await f.app.inject({ url: '/api/state', headers: f.headers() });
      assert.deepEqual(names, ['First fixture']);
      assert.equal(JSON.parse(f.profiles.at(-1)!.body).preferredName, 'First fixture');
      if (revoked) f.sessions.delete(f.users[0]);
      finish();
      assert.equal((await first).statusCode, 200);
      assert.equal((await second).statusCode, revoked ? 401 : 200);
      assert.deepEqual(names, revoked ? ['First fixture'] : ['First fixture', 'Second fixture']);
      assert.equal(
        f.profiles.some((profile) => JSON.parse(profile.body).preferredName === 'Second fixture'),
        !revoked,
      );
    });
});

test('welcome rechecks its principal before profile writes and after synchronization', async (t) => {
  for (const phase of ['account read', 'profile synchronization'])
    await t.test(phase, async (t) => {
      const f = await fixture();
      t.after(() => f.app.close());
      if (phase === 'account read')
        f.beforeAccountRead(() => {
          f.sessions.delete(f.users[0]);
        });
      else {
        const fetch = f.runtimes.fetch;
        f.runtimes.fetch = async (owner, request, options) => {
          const response = await fetch(owner, request, options);
          if (new URL(request.url).pathname === '/api/account/profile') f.sessions.delete(owner);
          return response;
        };
      }
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/account/welcome',
        headers: { ...f.headers(), origin },
        payload: {},
      });
      assert.equal(response.statusCode, 401);
      assert.equal(f.profiles.length, phase === 'account read' ? 0 : 1);
      assert.equal(f.calls.length, 0);
    });
});
