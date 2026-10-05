import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import type { SessionResponse } from '../src/shared/account.ts';
import { createSessionStore } from '../src/web/lib/session.ts';
import { googleAvatarUrl, loadGoogleAvatar } from '../src/providers/better-auth/avatar.ts';
import pg from 'pg';
import { makeSignature } from 'better-auth/crypto';
import { createGoogleAuthentication } from '../src/providers/better-auth/index.ts';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';

describe('account routes', () => {
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

  test(
    'a revoked session cannot finish onboarding after a late successful preparation',
    { timeout: 10_000 },
    async (t) => {
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
      await entered;
      f.revoke();
      finish();
      assert.equal((await response).statusCode, 401);
      assert.deepEqual(f.calls.writes, []);
    },
  );

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
        const rejected = await app.inject({
          method: 'PATCH',
          url: '/api/account',
          headers,
          payload,
        });
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
});

describe('account avatar', () => {
  async function fixture(avatar?: AuthenticationProvider['avatar']) {
    const owners = [randomUUID(), randomUUID()];
    const accounts = new Map<string, StoredAccount>();
    let signIns = 0;
    let active = true;
    const auth: AuthenticationProvider = {
      configured: true,
      async initialize() {},
      async session(headers) {
        const index =
          headers.get('cookie') === 'session=a'
            ? 0
            : headers.get('cookie') === 'session=b'
              ? 1
              : -1;
        return index < 0 || !active
          ? null
          : {
              id: `session-${index}`,
              expiresAt: new Date(Date.now() + 60_000),
              ...(avatar
                ? { avatarSource: 'https://lh3.googleusercontent.com/synthetic-private-avatar' }
                : {}),
              user: {
                id: owners[index],
                name: index ? 'Blair' : 'Alex',
                email: `user${index}@example.test`,
                avatarUrl: null,
              },
            };
      },
      async signIn() {
        signIns++;
        return Response.json(
          { url: 'https://accounts.google.com/authorize' },
          { headers: { 'set-cookie': 'oauth=state; HttpOnly; SameSite=Lax' } },
        );
      },
      async signOut() {
        return Response.json(
          { success: true },
          { headers: { 'set-cookie': 'session=; Max-Age=0; HttpOnly' } },
        );
      },
      async callback() {
        return new Response(null, { status: 302, headers: { location: 'http://localhost:4399/' } });
      },
      avatar,
    };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply
        .code(error instanceof Error && error.name === 'ZodError' ? 400 : 500)
        .send({ error: 'Account request failed.' }),
    );
    const session = createAccountSession({
      origin: 'http://localhost:4399',
      authentication: auth,
      developerIds: new Set([owners[0]]),
      accounts: {
        async read(id) {
          return (
            accounts.get(id) ?? { theme: 'system', onboardingCompleted: false, displayName: null }
          );
        },
        async update(id, input) {
          const before = await this.read(id);
          const next = {
            ...before,
            ...(input.theme ? { theme: input.theme } : {}),
            ...(input.onboardingCompleted !== undefined
              ? { onboardingCompleted: input.onboardingCompleted }
              : {}),
            ...(input.name ? { displayName: input.name } : {}),
          };
          accounts.set(id, next);
          return next;
        },
      },
    });
    session.register(app);
    return {
      app,
      owners,
      accounts,
      signIns: () => signIns,
      revoke: () => {
        active = false;
      },
    };
  }

  test('avatars stay behind the cookie account and never expose the provider image URL', async () => {
    let reads = 0;
    const f = await fixture(async () => {
      reads++;
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
    });
    try {
      const session = await f.app.inject({ url: '/api/session', headers: { cookie: 'session=a' } });
      const path = session.json().user.avatarUrl;
      assert.equal(path, `/api/account/avatar?account=${f.owners[0]}`);
      assert.doesNotMatch(session.body, /googleusercontent|synthetic-private-avatar/);
      assert.equal((await f.app.inject(path)).statusCode, 401);
      assert.equal(
        (await f.app.inject({ url: path, headers: { cookie: 'session=b' } })).statusCode,
        401,
      );
      assert.equal(
        (await f.app.inject({ url: '/api/account/avatar', headers: { cookie: 'session=a' } }))
          .statusCode,
        400,
      );
      assert.equal(reads, 0);
      const image = await f.app.inject({ url: path, headers: { cookie: 'session=a' } });
      assert.equal(image.statusCode, 200);
      assert.equal(image.headers['content-type'], 'image/png');
      assert.equal(image.headers['x-content-type-options'], 'nosniff');
      assert.match(String(image.headers['cache-control']), /^private, max-age=60/);
      assert.deepEqual(image.rawPayload, Buffer.from([1, 2, 3]));
      assert.equal(reads, 1);
    } finally {
      await f.app.close();
    }
  });
});

describe('account session store', () => {
  function session(id: string, theme: 'light' | 'dark' | 'system' = 'system'): SessionResponse {
    return {
      auth: { mode: 'google', googleAvailable: true },
      user: { id, name: id, email: `${id}@example.test`, avatarUrl: null },
      settings: { theme, onboardingCompleted: true },
      capabilities: { developer: false },
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  test('obsolete session and account responses cannot restore a signed-out or different account', async () => {
    const read = deferred<SessionResponse>();
    const mutation = deferred<SessionResponse>();
    let next = session('alex');
    let delayRead = false;
    const store = createSessionStore(
      async <T>(path: string) =>
        (path === '/api/account'
          ? mutation.promise
          : delayRead
            ? read.promise
            : next) as Promise<T>,
      () => {},
    );
    await store.refresh();
    const editing = store.update({ name: 'Changed' });
    delayRead = true;
    const refreshing = store.refresh();
    store.invalidate();
    delayRead = false;
    next = session('sam', 'light');
    await store.refresh();
    mutation.resolve({
      ...session('alex', 'dark'),
      user: { ...session('alex').user!, name: 'Changed' },
    });
    read.resolve(session('alex', 'dark'));
    await Promise.all([editing, refreshing]);
    assert.equal(store.getSnapshot().session?.user?.id, 'sam');
    assert.equal(store.getSnapshot().session?.settings?.theme, 'light');
  });
});

describe('Google avatar', () => {
  const source = 'https://lh3.googleusercontent.com/synthetic-avatar';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8w4AALAxEcQAz1AEKG5dMywAAAABJRU5ErkJggg==',
    'base64',
  );

  test('Google avatar destinations require HTTPS on the exact Googleusercontent host boundary', () => {
    assert.equal(googleAvatarUrl(source), source);
    for (const value of [
      null,
      undefined,
      'http://lh3.googleusercontent.com/image',
      'https://googleusercontent.com.attacker.test/image',
      'https://attacker.test/image',
      'https://127.0.0.1/image',
      'https://user:secret@lh3.googleusercontent.com/image',
      'https://lh3.googleusercontent.com:8443/image',
    ]) {
      assert.equal(googleAvatarUrl(value), null);
    }
  });

  test('avatar reads follow only checked redirects and forward no cookies or authentication headers', async () => {
    const urls: string[] = [];
    const image = await loadGoogleAvatar(source, async (url, options) => {
      urls.push(String(url));
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'manual');
      assert.equal(options?.referrerPolicy, 'no-referrer');
      assert.ok(options?.signal instanceof AbortSignal);
      assert.deepEqual([...new Headers(options.headers).keys()], ['accept']);
      return urls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://lh4.googleusercontent.com/synthetic-next' },
          })
        : new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    assert.equal(urls.length, 2);
    assert.equal(image?.mimeType, 'image/png');
    assert.deepEqual(image?.bytes, png);
    for (const location of [
      'https://attacker.test/image',
      'http://lh3.googleusercontent.com/image',
      'https://127.0.0.1/image',
    ]) {
      let calls = 0;
      assert.equal(
        await loadGoogleAvatar(source, async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location } });
        }),
        null,
      );
      assert.equal(calls, 1);
    }
  });
});

describe('Better Auth session', () => {
  const origin = 'http://localhost:4399';

  test(
    'real Better Auth migrations, signed session reads, revocation and rejected callbacks use a disposable schema',
    { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
    async (t) => {
      const schema = `test_better_auth_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.pathname = `/${schema}`;
      url.searchParams.delete('options');
      const admin = new pg.Pool({ connectionString: url.href, max: 1 });
      const database = new pg.Pool({
        connectionString: url.href,
        options: `-c search_path=${schema}`,
        max: 2,
      });
      let created = false;
      t.after(async () => {
        await database.end();
        await admin.end();
        if (created) await root.query(`DROP DATABASE "${schema}"`);
        await root.end();
      });
      await root.query(`CREATE DATABASE "${schema}"`);
      created = true;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const secret = randomBytes(48).toString('hex');
      const authentication = createGoogleAuthentication({
        database,
        origin,
        secret,
        environment: 'fixture',
        clientId: 'synthetic.apps.googleusercontent.com',
        clientSecret: 'synthetic-google-client-secret',
      });
      const previousFetch = globalThis.fetch;
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        throw new Error('Network access is disabled in this fixture.');
      };
      try {
        await authentication.initialize();
        await authentication.initialize();
        const tables = (
          await database.query(
            'SELECT table_name FROM information_schema.tables WHERE table_schema=$1',
            [schema],
          )
        ).rows.map((row) => row.table_name);
        for (const table of ['user', 'session', 'account', 'verification'])
          assert.ok(tables.includes(table));
        const user = randomUUID();
        const session = randomUUID();
        const token = randomBytes(32).toString('base64url');
        await database.query(
          'INSERT INTO "user" (id,name,email,"emailVerified",image,"givenName","createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$5,now(),now())',
          [
            user,
            'Synthetic Example',
            'synthetic@example.test',
            'https://lh3.googleusercontent.com/synthetic-avatar',
            'Synthetic',
          ],
        );
        await database.query(
          'INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now())',
          [session, token, user],
        );
        const signature = await makeSignature(token, secret);
        const headers = new Headers({
          cookie: `otto-fixture.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
          origin,
        });
        const accepted = await authentication.session(headers);
        assert.equal(accepted?.user.id, user);
        assert.equal(accepted?.id, session);
        assert.equal(accepted?.user.avatarUrl, null);
        assert.equal(accepted?.avatarSource, 'https://lh3.googleusercontent.com/synthetic-avatar');
        assert.equal(accepted?.givenName, 'Synthetic');
        assert.equal(accepted?.user.name, 'Synthetic Example');
        const tampered = new Headers({
          cookie: `otto-fixture.session_token=${encodeURIComponent(`${token}.invalid`)}`,
          origin,
        });
        assert.equal(await authentication.session(tampered), null);
        await database.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [user]);
        assert.equal(await authentication.session(headers), null);
        await database.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [user]);
        const signedOut = await authentication.signOut(headers);
        assert.equal(signedOut.status, 200);
        assert.ok(signedOut.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0')));
        await signedOut.body?.cancel();
        assert.equal(await authentication.session(headers), null);
        const signIn = await authentication.signIn(new Headers({ origin }));
        assert.equal(signIn.status, 200);
        const consent = new URL(((await signIn.json()) as { url: string }).url);
        assert.equal(consent.hostname, 'accounts.google.com');
        assert.equal(
          consent.searchParams.get('redirect_uri'),
          `${origin}/api/auth/callback/google`,
        );
        assert.equal(consent.searchParams.get('client_id'), 'synthetic.apps.googleusercontent.com');
        assert.ok(consent.searchParams.get('state'));
        assert.ok(consent.searchParams.get('code_challenge'));
        const missing = await authentication.callback(
          new Request(`${origin}/api/auth/callback/google?error=access_denied`),
        );
        assert.equal(missing.status, 302);
        assert.equal(new URL(missing.headers.get('location')!, origin).pathname, '/login');
        await missing.body?.cancel();
        const cookies = signIn.headers
          .getSetCookie()
          .map((cookie) => cookie.split(';')[0])
          .join('; ');
        const callback = new URL(`${origin}/api/auth/callback/google`);
        callback.searchParams.set('state', consent.searchParams.get('state')!);
        callback.searchParams.set('error', 'access_denied');
        callback.searchParams.set('error_description', 'Synthetic private provider detail');
        const cancelled = await authentication.callback(
          new Request(callback, { headers: { cookie: cookies } }),
        );
        assert.equal(cancelled.status, 302);
        const destination = new URL(cancelled.headers.get('location')!, origin);
        assert.equal(destination.origin, origin);
        assert.equal(destination.pathname, '/login');
        assert.equal(destination.searchParams.has('error_description'), false);
        assert.equal(destination.searchParams.get('error'), 'sign-in');
        await cancelled.body?.cancel();
        const replay = await authentication.callback(
          new Request(callback, { headers: { cookie: cookies } }),
        );
        assert.equal(replay.headers.get('location'), `${origin}/login?error=sign-in`);
        await replay.body?.cancel();
        assert.equal(networkCalls, 0);
        assert.equal(
          (await database.query('SELECT count(*)::int AS count FROM "session"')).rows[0].count,
          0,
        );
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  );
});

describe('keychain', () => {
  test('concurrent first key requests create one key and return independent buffers', async () => {
    let saved: string | undefined;
    let adds = 0;
    const store = createKeychainKeyStore({
      platform: 'darwin',
      run: async (_command, args) => {
        await Promise.resolve();
        if (args[0] === 'find-generic-password') {
          if (!saved) throw Object.assign(new Error('not found'), { code: 44 });
          return { stdout: saved };
        }
        adds++;
        if (saved) throw Object.assign(new Error('duplicate'), { code: 45 });
        saved = args.at(-1)!;
        return { stdout: '' };
      },
    });
    const keys = await Promise.all(Array.from({ length: 10 }, () => store.getKey()));
    assert.equal(adds, 1);
    for (const key of keys) assert.equal(key.toString('base64'), saved);
    keys[0].fill(0);
    assert.equal(keys[1].toString('base64'), saved);
    assert.equal((await store.getKey()).toString('base64'), saved);
  });
});

describe('model connections', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const schema = `test_models_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await root.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        const url = String(input);
        assert.equal(url, 'https://api.openai.com/v1/models');
        const key = new Headers(init?.headers).get('authorization');
        const ids =
          key === 'Bearer fixture-managed-key'
            ? ['gpt-6-luna']
            : key === 'Bearer fixture-no-memory-key'
              ? ['gpt-6.1-sol']
              : ['gpt-6.1-sol', 'gpt-6-luna'];
        return Response.json({ data: ids.map((id) => ({ id })) });
      },
    });
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (
      ownerId: string,
      selectedBackend = backend,
      local = true,
      bootstrap?: Parameters<typeof createModelService>[0]['bootstrap'],
    ) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
        local,
        bootstrap,
      });
      await service.initialize();
      services.push(service);
      return service;
    };
    t.after(async () => {
      for (const service of services) await service.close();
      await database.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    return { create, database, backend };
  }

  test('saved keys stay encrypted and owner-scoped; a removed connection cannot supply a later turn', async (t) => {
    const f = await fixture(t);
    const owner = await f.create('fixture-owner');
    const other = await f.create('fixture-other');
    const first = await owner.addKey('openai', 'fixture-first-api-key');
    const original = owner.view().selection!;
    const captured = await owner.resolve();
    const second = await owner.addKey('openai', 'fixture-second-api-key');
    assert.deepEqual(owner.view().selection, original);
    await assert.rejects(other.select(original));
    await other.remove(first);
    assert.equal((await captured.read())?.type, 'api_key');
    const ciphertext = JSON.stringify(
      (await f.database.query('SELECT * FROM vault_app_grants')).rows,
    );
    assert.ok(!ciphertext.includes('fixture-first-api-key'));
    assert.ok(!ciphertext.includes('fixture-second-api-key'));
    assert.ok(!JSON.stringify(owner.view()).includes('fixture-first-api-key'));
    assert.deepEqual(other.view().connections, []);
    await owner.select({ connectionId: second, modelId: 'gpt-6.1-sol', effort: 'medium' });
    assert.equal(((await captured.read()) as { key: string }).key, 'fixture-first-api-key');
    assert.equal((await owner.resolve()).effort, 'medium');
    await owner.remove(second);
    assert.equal(owner.configured, false);
    assert.equal(
      (await f.database.query('SELECT id FROM vault_app_grants WHERE id=$1', [second])).rowCount,
      0,
    );
    const restored = await f.create('fixture-owner');
    await restored.addKey('openai', 'fixture-third-api-key');
    assert.equal(restored.view().selection, null);
    await owner.remove(first);
    assert.equal(await captured.read(), undefined);
    const limited = await f.create('fixture-limited', {
      ...f.backend,
      catalog: async (...args) =>
        (await f.backend.catalog(...args)).filter((model) => model.choice.id !== 'gpt-6.1-sol'),
    });
    const limitedId = await limited.addKey('openai', 'fixture-limited-api-key');
    assert.equal(limited.view().selection, null);
    await limited.select({ connectionId: limitedId, modelId: 'gpt-6-luna', effort: 'medium' });
    assert.equal(limited.configured, true);
    const managed = await f.create('fixture-managed', f.backend, true, {
      provider: 'openai',
      keys: { openai: 'fixture-managed-key' },
    });
    assert.deepEqual(
      managed.view().connections[0].models.map((model) => model.id),
      ['gpt-6-luna'],
    );
    assert.equal(managed.view().selection, null);
    const memory = await f.create('fixture-memory');
    await memory.addKey('openai', 'fixture-no-memory-key');
    const auxiliary = await memory.resolve(true);
    assert.equal(auxiliary.definition.choice.id, 'gpt-6.1-sol');
    assert.ok(auxiliary.definition.choice.efforts.includes(auxiliary.effort));
  });

  test('sign-in is single-use; refresh and removal serialize across service instances without restoring a removed key', async (t) => {
    const f = await fixture(t);
    let exchanges = 0;
    let refreshes = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
      async exchange() {
        exchanges++;
        return {
          type: 'oauth' as const,
          access: 'fixture-old-access',
          refresh: 'fixture-old-refresh',
          expires: 0,
          clientId: 'fixture-client',
          subject: 'fixture-owner',
          idToken: 'fixture-id-token',
          scopes: ['chatgpt.tokens.use.direct'],
        };
      },
      async refresh(value: import('../src/ports/models.ts').ModelCredential) {
        if (value.type !== 'oauth') throw new Error('Expected an account credential.');
        refreshes++;
        entered();
        await gate;
        return {
          ...value,
          access: 'fixture-rotated-access',
          refresh: 'fixture-rotated-refresh',
          expires: Date.now() + 3600000,
        };
      },
    };
    const owner = await f.create('fixture-owner', backend);
    const signIn = await owner.start('openai');
    const auth = new URL(signIn.url);
    assert.equal(signIn.attempt, auth.searchParams.get('state'));
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    const status = () => app.inject({ url: `/api/models/oauth/status/${signIn.attempt}` });
    assert.deepEqual((await status()).json(), { status: 'waiting' });
    const other = await f.create('fixture-other', backend);
    const otherApp = Fastify();
    other.register(otherApp);
    t.after(() => otherApp.close());
    assert.equal(
      (await otherApp.inject({ url: `/api/models/oauth/status/${signIn.attempt}` })).json().status,
      'failed',
    );
    const callback = new URL(
      `http://127.0.0.1:1455/auth/callback?state=${auth.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
    );
    await owner.complete(callback);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    await assert.rejects(owner.complete(callback));
    assert.deepEqual((await status()).json(), { status: 'connected' });
    assert.equal(exchanges, 1);
    await owner.start('openrouter');
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const restored = await f.create('fixture-owner', backend);
    const a = await owner.resolve();
    const b = await restored.resolve();
    const firstRead = a.read();
    await started;
    const secondRead = b.read();
    release();
    assert.equal(((await firstRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(((await secondRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(refreshes, 1);
    const id = owner.view().connections[0].id;
    const reconnectSignIn = await owner.start('openai', id);
    const reconnect = new URL(reconnectSignIn.url);
    await restored.remove(id);
    await assert.rejects(
      owner.complete(
        new URL(
          `http://127.0.0.1:1455/auth/callback?state=${reconnect.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
        ),
      ),
    );
    assert.equal(owner.signInStatus(reconnectSignIn.attempt).status, 'failed');
    assert.equal(await a.read(), undefined);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    for (let count = 0; count < 4; count++) await owner.start('openrouter');
    await assert.rejects(owner.start('openrouter'), /pending sign-in/);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const hosted = await f.create('fixture-hosted', backend, false);
    await assert.rejects(hosted.start('openai'));
    const failed = await f.create('fixture-failed', {
      ...backend,
      exchange: async () => {
        throw new Error('fixture-secret-must-stay-private');
      },
    });
    const rejected = await failed.start('openrouter');
    const rejectedCallback = new URL(
      `http://127.0.0.1:4310/api/models/oauth/callback?state=${rejected.attempt}&code=fixture-code`,
    );
    await assert.rejects(failed.complete(rejectedCallback));
    assert.equal(failed.signInStatus(rejected.attempt).status, 'failed');
    assert.ok(!JSON.stringify(failed.signInStatus(rejected.attempt)).includes('fixture-secret'));
    await assert.rejects(failed.complete(rejectedCallback));
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const expiring = await failed.start('openrouter');
    assert.equal(failed.signInStatus(expiring.attempt).status, 'waiting');
    t.mock.timers.tick(600001);
    assert.equal(owner.signInStatus(signIn.attempt).status, 'failed');
    t.mock.timers.reset();
    assert.equal(failed.signInStatus(expiring.attempt).status, 'failed');
  });
});
