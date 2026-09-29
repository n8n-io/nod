import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';

async function fixture(
  prepare?: (ownerId: string) => Promise<void>,
  start?: (ownerId: string) => Promise<void>,
) {
  const records = new Map<string, StoredAccount>();
  const calls = {
    signIn: 0,
    signOut: 0,
    callback: '',
    writes: [] as string[],
    prepared: [] as string[],
    started: [] as string[],
  };
  let enabled = true;
  const accounts: AccountStore = {
    async read(owner) {
      return (
        records.get(owner) ?? { theme: 'system', onboardingCompleted: false, displayName: null }
      );
    },
    async update(owner, input) {
      calls.writes.push(owner);
      const saved = await accounts.read(owner);
      const next = {
        theme: input.theme ?? saved.theme,
        onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
        displayName: input.name ?? saved.displayName,
      };
      records.set(owner, next);
      return next;
    },
  };
  const authentication: AuthenticationProvider = {
    configured: true,
    async initialize() {},
    async session(headers) {
      const id =
        headers.get('cookie') === 'fixture=alex'
          ? 'alex'
          : headers.get('cookie') === 'fixture=sam'
            ? 'sam'
            : null;
      return enabled && id
        ? {
            id: `session-${id}`,
            expiresAt: new Date('2099-01-01'),
            user: { id, name: `Google ${id}`, email: `${id}@example.test`, avatarUrl: null },
          }
        : null;
    },
    async signIn() {
      calls.signIn++;
      const headers = new Headers();
      headers.append('set-cookie', 'fixture-state=one; HttpOnly; Secure; SameSite=Lax');
      headers.append('set-cookie', 'fixture-verifier=two; HttpOnly; Secure; SameSite=Lax');
      return Response.json({ url: 'https://accounts.example.test/consent' }, { headers });
    },
    async signOut() {
      calls.signOut++;
      return Response.json({ ok: true });
    },
    async callback(request) {
      calls.callback = request.url;
      return Response.redirect('https://otto.example.test/');
    },
  };
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(400).send({ error: 'Invalid account request.' }),
  );
  const account = createAccountSession({
    accounts,
    origin: 'https://otto.example.test',
    authentication,
    developerIds: new Set(['alex']),
    async prepare(owner) {
      calls.prepared.push(owner);
      await prepare?.(owner);
    },
    async start(owner) {
      calls.started.push(owner);
      await start?.(owner);
    },
  });
  account.register(app);
  await app.ready();
  return {
    app,
    calls,
    records,
    revoke: () => {
      enabled = false;
    },
  };
}

test('session response uses the cookie identity and owned settings without exposing provider data', async () => {
  const { app, records, revoke } = await fixture();
  records.set('alex', { theme: 'dark', onboardingCompleted: true, displayName: 'Alex Example' });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'fixture=alex', 'x-otto-account': 'sam' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), {
      auth: { mode: 'google', googleAvailable: true },
      user: { id: 'alex', name: 'Alex Example', email: 'alex@example.test', avatarUrl: null },
      settings: { theme: 'dark', onboardingCompleted: true },
      capabilities: { developer: true },
    });
    revoke();
    const expired = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'fixture=alex' },
    });
    assert.equal(expired.json().user, null);
    assert.equal(expired.json().settings, null);
    assert.equal(expired.json().capabilities.developer, false);
  } finally {
    await app.close();
  }
});

test('account preparation requires a current same-origin principal and never accepts provider or owner input', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const headers = { origin: 'https://otto.example.test', cookie: 'fixture=alex' };
  for (const input of [
    { headers: { origin: headers.origin }, payload: {}, status: 401 },
    { headers: { ...headers, origin: 'https://foreign.example.test' }, payload: {}, status: 403 },
    { headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload: {}, status: 403 },
    { headers: { ...headers, 'x-otto-account': 'sam' }, payload: {}, status: 401 },
    { headers, payload: { ownerId: 'sam' }, status: 400 },
    { headers, payload: { provider: 'e2b' }, status: 400 },
    { headers, payload: { templateId: 'override' }, status: 400 },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: input.headers,
      payload: input.payload,
    });
    assert.equal(response.statusCode, input.status);
  }
  assert.deepEqual(f.calls.prepared, []);
  for (const owner of ['alex', 'sam']) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: { ...headers, cookie: `fixture=${owner}` },
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(f.calls.prepared, ['alex', 'sam']);
  assert.deepEqual(f.calls.writes, []);
});

test('onboarding completion waits for preparation and failure cannot change any account settings', async (t) => {
  let finish!: () => void;
  let fail = false;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(async () => {
    await waiting;
    if (fail) throw new Error('synthetic private provider failure');
  });
  t.after(() => f.app.close());
  const headers = { origin: 'https://otto.example.test', cookie: 'fixture=alex' };
  const pending = f.app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers,
    payload: { name: 'Changed', onboardingCompleted: true },
  });
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false);
  assert.deepEqual(f.calls.writes, []);
  fail = true;
  finish();
  const rejected = await pending;
  assert.equal(rejected.statusCode, 503);
  assert.deepEqual(rejected.json(), { error: 'Setup could not be completed. Try again.' });
  assert.equal(f.records.size, 0);
  fail = false;
  const retry = await f.app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers,
    payload: { onboardingCompleted: true },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(f.records.get('alex')?.onboardingCompleted, true);
  assert.equal(f.records.has('sam'), false);
  assert.deepEqual(f.calls.prepared, ['alex', 'alex']);
});

test('onboarding completion starts the welcome after preparation and a failed start saves nothing', async (t) => {
  let fail = true;
  const writesAtStart: string[][] = [];
  const f = await fixture(undefined, async () => {
    writesAtStart.push([...f.calls.writes]);
    if (fail) throw new Error('synthetic private runtime failure');
  });
  t.after(() => f.app.close());
  const request = (payload: Record<string, unknown>) =>
    f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { origin: 'https://otto.example.test', cookie: 'fixture=alex' },
      payload,
    });
  const rejected = await request({ onboardingCompleted: true });
  assert.equal(rejected.statusCode, 503);
  assert.deepEqual(rejected.json(), { error: 'Setup could not be completed. Try again.' });
  assert.equal(f.records.size, 0);
  fail = false;
  assert.equal((await request({ onboardingCompleted: true })).statusCode, 200);
  assert.equal(f.records.get('alex')?.onboardingCompleted, true);
  assert.equal((await request({ theme: 'dark' })).statusCode, 200);
  assert.deepEqual(f.calls.prepared, ['alex', 'alex']);
  assert.deepEqual(f.calls.started, ['alex', 'alex']);
  assert.deepEqual(writesAtStart, [[], []]);
});

test('a revoked session cannot finish onboarding after a late successful preparation', async (t) => {
  let finish!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async () => {
    started();
    await pending;
  });
  t.after(() => f.app.close());
  const response = f.app.inject({
    method: 'PATCH',
    url: '/api/account',
    headers: { origin: 'https://otto.example.test', cookie: 'fixture=alex' },
    payload: { onboardingCompleted: true },
  });
  void response.then(() => {});
  await entered;
  f.revoke();
  finish();
  assert.equal((await response).statusCode, 401);
  assert.deepEqual(f.calls.writes, []);
});

test('Google identity, session reads and appearance changes do not prepare a computer', async (t) => {
  const f = await fixture(async () => {
    throw new Error('Preparation unavailable');
  });
  t.after(() => f.app.close());
  const headers = { origin: 'https://otto.example.test', cookie: 'fixture=alex' };
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/session', headers })).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/api/auth/callback/google', headers })).statusCode,
    302,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers,
        payload: { theme: 'dark' },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(f.calls.prepared, []);
});

test('account changes require same origin and matching principal and reject identity overrides', async () => {
  const { app, calls, records } = await fixture();
  const headers = {
    origin: 'https://otto.example.test',
    cookie: 'fixture=alex',
    'x-otto-account': 'alex',
  };
  try {
    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { ...headers, 'x-otto-account': 'sam' },
      payload: { name: 'Changed' },
    });
    assert.equal(foreign.statusCode, 401);
    for (const payload of [
      { ownerId: 'sam' },
      { email: 'other@example.test' },
      { developer: true },
      { avatarUrl: 'https://example.test/pixel' },
    ]) {
      const rejected = await app.inject({ method: 'PATCH', url: '/api/account', headers, payload });
      assert.equal(rejected.statusCode, 400);
    }
    const crossOrigin = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { ...headers, origin: 'https://elsewhere.example.test' },
      payload: { theme: 'light' },
    });
    assert.equal(crossOrigin.statusCode, 403);
    assert.deepEqual(calls.writes, []);
    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers,
      payload: { name: ' Alex Example ', theme: 'dark', onboardingCompleted: true },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().user.id, 'alex');
    assert.equal(accepted.json().user.name, 'Alex Example');
    assert.equal(accepted.json().settings.theme, 'dark');
    assert.equal(records.has('sam'), false);
    assert.deepEqual(calls.writes, ['alex']);
  } finally {
    await app.close();
  }
});

test('a stale account cannot log out a newer cookie principal', async () => {
  const { app, calls } = await fixture();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: {
        origin: 'https://otto.example.test',
        cookie: 'fixture=sam',
        'x-otto-account': 'alex',
      },
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(calls.signOut, 0);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: {
        origin: 'https://otto.example.test',
        cookie: 'fixture=sam',
        'x-otto-account': 'sam',
      },
      payload: {},
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(calls.signOut, 1);
  } finally {
    await app.close();
  }
});

test('Google sign-in keeps the fixed flow, both state cookies and configured callback origin', async () => {
  const { app, calls } = await fixture();
  try {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://otto.example.test' },
      payload: { callbackURL: 'https://elsewhere.example.test' },
    });
    assert.equal(rejected.statusCode, 400);
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://elsewhere.example.test' },
      payload: {},
    });
    assert.equal(crossSite.statusCode, 403);
    assert.equal(calls.signIn, 0);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://otto.example.test' },
      payload: {},
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().url, 'https://accounts.example.test/consent');
    assert.equal(accepted.cookies.length, 2);
    await app.inject({
      method: 'GET',
      url: '/api/auth/callback/google?state=synthetic&code=fixture',
      headers: { host: 'untrusted.example.test' },
    });
    assert.equal(
      calls.callback,
      'https://otto.example.test/api/auth/callback/google?state=synthetic&code=fixture',
    );
  } finally {
    await app.close();
  }
});
