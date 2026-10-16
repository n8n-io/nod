import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import { googleAvatarUrl, loadGoogleAvatar } from '../src/providers/better-auth/avatar.ts';
import pg from 'pg';
import { makeSignature } from 'better-auth/crypto';
import { createGoogleAuthentication } from '../src/providers/better-auth/index.ts';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, type Analytics } from '../src/server/analytics.ts';

describe('account routes', () => {
  async function fixture(
    prepare?: (ownerId: string) => Promise<void>,
    start?: (ownerId: string) => Promise<void>,
    analytics?: Analytics,
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
      async readConsent(owner) {
        return { enabled: (await this.read(owner)).usageData, revision: '0' };
      },
      async read(owner) {
        return (
          records.get(owner) ?? {
            theme: 'system',
            onboardingCompleted: false,
            displayName: null,
            usageData: false,
          }
        );
      },
      async update(owner, input) {
        calls.writes.push(owner);
        const saved = await accounts.read(owner);
        const next = {
          theme: input.theme ?? saved.theme,
          onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
          displayName: input.name ?? saved.displayName,
          usageData: input.usageData ?? saved.usageData,
        };
        records.set(owner, next);
        return {
          ...next,
          onboardingCompletedNow: next.onboardingCompleted && !saved.onboardingCompleted,
        };
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
      analytics,
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

  test('usage data stays off until each owner opts in and the environment switch always wins', async (t) => {
    for (const available of [true, false]) {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const analytics = await createAnalytics({
        provider: available
          ? { capture: (event) => captured.push(event), shutdown: async () => {} }
          : undefined,
        deployment: 'hosted',
        environment: 'production',
        dataRoot: '.',
      });
      const f = await fixture(undefined, undefined, analytics);
      t.after(() => f.app.close());
      const request = (owner: string, payload?: object) =>
        f.app.inject({
          method: payload ? 'PATCH' : 'GET',
          url: payload ? '/api/account' : '/api/session',
          headers: { origin: 'https://otto.example.test', cookie: `fixture=${owner}` },
          ...(payload ? { payload } : {}),
        });
      const initial = await request('alex');
      assert.equal(initial.json().settings.usageData, false);
      assert.deepEqual(
        [initial.json().analytics.enabled, initial.json().analytics.distinctId],
        [false, null],
      );
      await request('alex', { name: 'Synthetic Alex', onboardingCompleted: true });
      analytics.capture('alex', { event: 'otto_conversation_reset' });
      assert.equal(captured.length, 0);
      const opted = await request('alex', { usageData: true });
      assert.equal(opted.statusCode, 200);
      assert.equal(opted.json().settings.usageData, true);
      assert.equal(opted.json().analytics.enabled, available);
      assert.equal(f.records.get('alex')?.usageData, true);
      const other = await request('sam');
      assert.deepEqual(
        [other.json().settings.usageData, other.json().analytics.enabled],
        [false, false],
      );
      await request('sam', { theme: 'dark' });
      analytics.forOwner('sam')({ event: 'otto_chat_stopped' });
      await request('alex', { theme: 'dark' });
      analytics.forOwner('alex')({ event: 'otto_chat_stopped' });
      assert.deepEqual(
        captured.map((event) => [event.distinctId, event.event]),
        available
          ? [
              ['hosted:alex', 'otto_settings_updated'],
              ['hosted:alex', 'otto_chat_stopped'],
            ]
          : [],
      );
      const declined = await request('alex', { usageData: false });
      assert.equal(declined.json().analytics.enabled, false);
      analytics.capture('alex', { event: 'otto_chat_stopped' });
      assert.equal(captured.length, available ? 2 : 0);
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
    for (const [extra, payload, status] of [
      [{ 'x-otto-account': 'sam' }, { name: 'Changed' }, 401],
      [{ origin: 'https://foreign.example.test' }, { theme: 'light' }, 403],
      [{}, { ownerId: 'sam' }, 400],
      [{}, { email: 'other@example.test' }, 400],
      [{}, { developer: true }, 400],
      [{}, { avatarUrl: 'https://example.test/pixel' }, 400],
    ] as const) {
      const response = await f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { ...headers, ...extra },
        payload,
      });
      assert.equal(response.statusCode, status);
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
    }
    assert.deepEqual(f.calls.prepared, ['alex', 'sam']);
    assert.deepEqual(f.calls.writes, []);
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

describe('analytics privacy', () => {
  test('analytics reject arbitrary event names, unbounded identifiers and private properties', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      deployment: 'hosted',
      environment: 'production',
      dataRoot: '.',
    });
    analytics.setUsageData('owner-fixture', true);
    const capture = analytics.forOwner('owner-fixture');
    for (const event of [
      { event: 'private-chat-text' },
      { event: 'otto_onboarding_completed', distinctId: 'another-owner' },
      {
        event: 'otto_settings_updated',
        properties: { section: 'account', operation: 'update', name: 'Private Person' },
      },
      {
        event: 'otto_turn_started',
        properties: { source: 'user', channel: 'telegram:private-recipient', background: false },
      },
    ])
      capture(event as never);
    assert.equal(captured.length, 0);
    capture({
      event: 'otto_turn_started',
      properties: { source: 'user', channel: 'telegram', background: false },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].distinctId, 'hosted:owner-fixture');
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
        async readConsent(id) {
          return { enabled: (await this.read(id)).usageData, revision: '0' };
        },
        async read(id) {
          return (
            accounts.get(id) ?? {
              theme: 'system',
              onboardingCompleted: false,
              displayName: null,
              usageData: false,
            }
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
      assert.equal(reads, 1);
    } finally {
      await f.app.close();
    }
  });
});

describe('Google avatar', () => {
  const source = 'https://lh3.googleusercontent.com/synthetic-avatar';

  test('Google avatar destinations require HTTPS on the exact Googleusercontent host boundary', async () => {
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
        const tampered = new Headers({
          cookie: `otto-fixture.session_token=${encodeURIComponent(`${token}.invalid`)}`,
          origin,
        });
        assert.equal(await authentication.session(tampered), null);
        await database.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [user]);
        assert.equal(await authentication.session(headers), null);
        await database.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [user]);
        const signedOut = await authentication.signOut(headers);
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
        assert.ok(consent.searchParams.get('state'));
        assert.ok(consent.searchParams.get('code_challenge'));
        const missing = await authentication.callback(
          new Request(`${origin}/api/auth/callback/google?error=access_denied`),
        );
        assert.equal(missing.status, 302);
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
        assert.equal(destination.searchParams.has('error_description'), false);
        await cancelled.body?.cancel();
        const replay = await authentication.callback(
          new Request(callback, { headers: { cookie: cookies } }),
        );
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

  test('never creates a replacement Keychain key while sealed data exists', async () => {
    let adds = 0;
    let sealed = true;
    const store = createKeychainKeyStore({
      platform: 'darwin',
      canCreate: async () => !sealed,
      run: async (_command, args) => {
        if (args[0] === 'find-generic-password')
          throw Object.assign(new Error('not found'), { code: 44 });
        adds++;
        return { stdout: '' };
      },
    });
    await assert.rejects(store.getKey(), /missing/);
    assert.equal(adds, 0);
    sealed = false;
    assert.equal((await store.getKey()).length, 32);
    assert.equal(adds, 1);
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
      fetch: async (input) => {
        assert.equal(String(input), 'https://api.openai.com/v1/models');
        return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({ id })) });
      },
    });
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (ownerId: string, selectedBackend = backend) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
        local: true,
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

  function subscriptionCredential(expires = Date.now() + 3600000) {
    return {
      type: 'oauth' as const,
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires,
      accountId: 'fixture-account',
    };
  }

  function stubSignIn(
    exchange: () => Promise<import('../src/ports/models.ts').ModelCredential>,
    aborted?: () => void,
  ): import('../src/ports/models.ts').ModelBackend['signIn'] {
    return async ({ signal }) => {
      const state = randomBytes(16).toString('hex');
      let resolve!: (value: import('../src/ports/models.ts').ModelCredential) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<import('../src/ports/models.ts').ModelCredential>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      signal.addEventListener(
        'abort',
        () => {
          aborted?.();
          reject(new Error('Sign-in cancelled.'));
        },
        { once: true },
      );
      return {
        url: `https://auth.openai.com/authorize?state=${state}`,
        state,
        result,
        complete(callback) {
          assert.equal(callback.searchParams.get('state'), state);
          void exchange().then(resolve, reject);
        },
      };
    };
  }

  test('saved keys stay encrypted and owner-scoped; a removed connection cannot supply a later turn', async (t) => {
    const f = await fixture(t);
    const owner = await f.create('fixture-owner');
    const other = await f.create('fixture-other');
    const first = await owner.addKey('openai', 'fixture-first-api-key');
    const original = owner.view().selection!;
    const captured = await owner.resolve();
    const second = await owner.addKey('openai', 'fixture-second-api-key');
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
    await owner.remove(second);
    assert.equal(owner.configured, false);
    assert.equal(
      (await f.database.query('SELECT id FROM vault_app_grants WHERE id=$1', [second])).rowCount,
      0,
    );
    await owner.remove(first);
    assert.equal(await captured.read(), undefined);
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
          accountId: 'fixture-account',
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
    backend.signIn = stubSignIn(() => backend.exchange());
    const owner = await f.create('fixture-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const payload of [
      { provider: 'anthropic' },
      { provider: 'openrouter', connectionId: randomUUID() },
    ]) {
      const rejected = await app.inject({ method: 'POST', url: '/api/models/oauth', payload });
      assert.equal(rejected.statusCode, 400);
    }
    const initiated = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(initiated.statusCode, 200, initiated.body);
    const signIn = initiated.json();
    const auth = new URL(signIn.url);
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
    const complete = () =>
      app.inject({
        method: 'POST',
        url: '/api/models/oauth/complete',
        payload: { url: callback.href },
      });
    assert.equal((await complete()).statusCode, 200);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    assert.equal((await complete()).statusCode, 400);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const repeated = await app.inject({
      url: `/api/models/oauth/callback?state=${signIn.attempt}&code=fixture-code`,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(exchanges, 1);
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
    assert.deepEqual((await status()).json(), { status: 'connected' });
    let exchanging!: () => void;
    let finishExchange!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      exchanging = resolve;
    });
    const exchangeGate = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const slow = await f.create('fixture-slow', {
      ...backend,
      async exchange() {
        exchanging();
        await exchangeGate;
        return backend.exchange();
      },
    });
    const slowApp = Fastify();
    slow.register(slowApp);
    t.after(() => slowApp.close());
    const slowSignIn = await slow.start('openrouter');
    const slowCallback = `/api/models/oauth/callback?state=${slowSignIn.attempt}&code=fixture-code`;
    const first = slowApp.inject({ url: slowCallback });
    await exchangeStarted;
    const second = slowApp.inject({ url: slowCallback });
    const exchangesBefore = exchanges;
    finishExchange();
    assert.deepEqual(
      (await Promise.all([first, second])).map((response) => response.statusCode),
      [200, 200],
    );
    assert.equal(exchanges, exchangesBefore + 1);
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
  });

  test('a verified account survives catalog failure and recovers without repeating sign-in', async (t) => {
    const f = await fixture(t);
    let exchanges = 0;
    let unavailable = true;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => {
        exchanges++;
        return subscriptionCredential();
      }),
      async catalog(...args: Parameters<typeof f.backend.catalog>) {
        if (unavailable) throw new Error('fixture-catalog-outage');
        return f.backend.catalog(args[0], args[1]);
      },
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    assert.equal(exchanges, 1);
    assert.equal(owner.signInStatus(started.attempt).status, 'connected');
    assert.equal(owner.view().connections[0].status, 'loading');
    assert.equal(owner.configured, false);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      1,
    );
    const restarted = await f.create('fixture-owner', backend);
    assert.equal(restarted.view().connections[0].status, 'loading');
    unavailable = false;
    await restarted.refreshCatalog(restarted.view().connections[0].id);
    assert.equal(restarted.view().connections[0].status, 'connected');
    assert.equal(restarted.configured, true);
    const credential = await (await restarted.resolve()).read();
    assert.equal(credential?.type, 'oauth');
    assert.equal(exchanges, 1);
  });

  test('cancelling and replacing pending ChatGPT sign-ins releases each flow and fences late completion', async (t) => {
    const f = await fixture(t);
    let aborted = 0;
    let release!: (value: import('../src/ports/models.ts').ModelCredential) => void;
    const pending = new Promise<import('../src/ports/models.ts').ModelCredential>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      signIn: stubSignIn(
        () => pending,
        () => aborted++,
      ),
    };
    const owner = await f.create('fixture-owner', backend);
    const other = await f.create('fixture-other', backend);
    const app = Fastify();
    const otherApp = Fastify();
    owner.register(app);
    other.register(otherApp);
    t.after(() => app.close());
    t.after(() => otherApp.close());
    const first = await owner.start('openai');
    await otherApp.inject({ method: 'DELETE', url: `/api/models/oauth/${first.attempt}` });
    assert.equal(owner.signInStatus(first.attempt).status, 'waiting');
    assert.equal(aborted, 0);
    const completing = owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${first.attempt}&code=fixture`),
    );
    const rejected = assert.rejects(completing);
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/models/oauth/${first.attempt}`,
    });
    assert.equal(cancelled.statusCode, 200);
    await rejected;
    release(subscriptionCredential());
    await Promise.resolve();
    assert.equal(aborted, 1);
    assert.equal(owner.view().connections.length, 0);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      0,
    );
    for (let count = 0; count < 7; count++) await owner.start('openai');
    assert.equal(aborted, 7);
    const parallel = await Promise.all([owner.start('openai'), owner.start('openai')]);
    assert.equal(owner.signInStatus(parallel[0].attempt).status, 'failed');
    assert.equal(owner.signInStatus(parallel[1].attempt).status, 'waiting');
    await owner.cancel(parallel[1].attempt);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const expires = await owner.start('openai');
    t.mock.timers.tick(600001);
    const afterExpiry = await owner.start('openai');
    assert.equal(owner.signInStatus(expires.attempt).status, 'failed');
    t.mock.timers.reset();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'waiting');
    await owner.close();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'failed');
  });

  test('reconnect cannot replace the ChatGPT account behind an existing connection', async (t) => {
    const f = await fixture(t);
    let accountId = 'fixture-original-account';
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => ({ ...subscriptionCredential(), accountId })),
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    const id = owner.view().connections[0].id;
    const selection = owner.view().selection;
    const access = await owner.resolve();
    const before = (
      await f.database.query('SELECT ciphertext FROM vault_app_grants WHERE id=$1', [id])
    ).rows[0].ciphertext;
    accountId = 'fixture-different-account';
    const reconnect = await owner.start('openai', id);
    await assert.rejects(
      owner.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${reconnect.attempt}&code=fixture`),
      ),
    );
    assert.deepEqual(owner.view().selection, selection);
    assert.equal(owner.view().connections[0].status, 'connected');
    assert.equal(
      ((await access.read()) as { accountId: string }).accountId,
      'fixture-original-account',
    );
    assert.equal(
      (await f.database.query('SELECT ciphertext FROM vault_app_grants WHERE id=$1', [id])).rows[0]
        .ciphertext,
      before,
    );
    const added = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${added.attempt}&code=fixture`),
    );
    assert.equal(owner.view().connections.length, 2);
    assert.deepEqual(owner.view().selection, selection);
  });
});
