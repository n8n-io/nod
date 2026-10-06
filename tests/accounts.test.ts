import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AuthenticationProvider } from '../src/ports/authentication.ts';
import {
  createAccountStore,
  type AccountStore,
  type StoredAccount,
} from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import type { SessionResponse } from '../src/shared/account.ts';
import { createSessionStore } from '../src/web/lib/session.ts';
import { googleAvatarUrl, loadGoogleAvatar } from '../src/providers/better-auth/avatar.ts';
import pg from 'pg';
import { makeSignature } from 'better-auth/crypto';
import { createGoogleAuthentication } from '../src/providers/better-auth/index.ts';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import {
  analyticsEnabled,
  analyticsEnvironment,
  createAnalytics,
  registerAnalyticsRoutes,
  type Analytics,
  type AnalyticsEvent,
} from '../src/server/analytics.ts';

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

  test(
    'concurrent onboarding writes preserve account fields and emit one completion across store instances',
    { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
    async (t) => {
      const schema = `test_account_completion_${randomUUID().replaceAll('-', '')}`;
      const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      const database = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
        max: 2,
      });
      t.after(async () => {
        await database.end();
        await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await root.end();
      });
      await root.query(`CREATE SCHEMA ${schema}`);
      const stores = [createAccountStore(database), createAccountStore(database)];
      await stores[0].initialize();
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const analytics = await createAnalytics({
        provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
        deployment: 'hosted',
        environment: 'production',
        dataRoot: '.',
      });
      for (const existing of [false, true]) {
        const ownerId = randomUUID();
        if (existing) await stores[0].update(ownerId, { onboardingCompleted: false });
        let prepared = 0;
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        const apps = stores.map((accounts) => {
          const app = Fastify();
          createAccountSession({
            accounts,
            analytics,
            origin: 'https://otto.example.test',
            localUser: { id: ownerId, name: 'Synthetic', email: null, avatarUrl: null },
            async prepare() {
              if (++prepared === 2) release();
              await pending;
            },
          }).register(app);
          return app;
        });
        try {
          const responses = await Promise.all(
            apps.map((app, index) =>
              app.inject({
                method: 'PATCH',
                url: '/api/account',
                headers: { origin: 'https://otto.example.test' },
                payload: {
                  onboardingCompleted: true,
                  ...(index === 0 ? { name: 'Synthetic Updated' } : { theme: 'dark' }),
                },
              }),
            ),
          );
          for (const response of responses) assert.equal(response.statusCode, 200);
          assert.deepEqual(await stores[1].read(ownerId), {
            displayName: 'Synthetic Updated',
            theme: 'dark',
            onboardingCompleted: true,
          });
          const repeated = await apps[0].inject({
            method: 'PATCH',
            url: '/api/account',
            headers: { origin: 'https://otto.example.test' },
            payload: { onboardingCompleted: true },
          });
          assert.equal(repeated.statusCode, 200);
          assert.equal(
            captured.filter(
              (event) =>
                event.event === 'otto_onboarding_completed' &&
                event.distinctId === `hosted:${ownerId}`,
            ).length,
            1,
          );
        } finally {
          await Promise.all(apps.map((app) => app.close()));
        }
      }
    },
  );

  test('analytics bind account mutations to the authenticated owner and exclude private account data', async (t) => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      deployment: 'hosted',
      environment: 'production',
      dataRoot: '.',
    });
    const f = await fixture(undefined, undefined, analytics);
    t.after(() => f.app.close());
    for (const owner of ['alex', 'sam']) {
      const session = await f.app.inject({
        method: 'GET',
        url: '/api/session?distinctId=attacker',
        headers: { cookie: `fixture=${owner}`, 'x-posthog-distinct-id': 'attacker' },
      });
      assert.equal(session.json().analytics.distinctId, `hosted:${owner}`);
      const result = await f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { origin: 'https://otto.example.test', cookie: `fixture=${owner}` },
        payload: { name: 'Private Person', onboardingCompleted: true },
      });
      assert.equal(result.statusCode, 200);
    }
    assert.equal(captured.filter((event) => event.event === 'otto_onboarding_completed').length, 2);
    assert.deepEqual(
      new Set(captured.map((event) => event.distinctId)),
      new Set(['hosted:alex', 'hosted:sam']),
    );
    assert.ok(!JSON.stringify(captured).includes('Private Person'));
    assert.ok(!JSON.stringify(captured).includes('@example.test'));
    assert.ok(!JSON.stringify(captured).includes('attacker'));
    const repeated = await f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { origin: 'https://otto.example.test', cookie: 'fixture=alex' },
      payload: { onboardingCompleted: true },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(captured.filter((event) => event.event === 'otto_onboarding_completed').length, 2);
    const rejected = await f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: {
        origin: 'https://otto.example.test',
        cookie: 'fixture=alex',
        'x-otto-account': 'sam',
      },
      payload: { name: 'Rejected Name' },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(captured.length, 4);
    f.revoke();
    const anonymous = await f.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: 'fixture=alex' },
    });
    assert.equal(anonymous.json().analytics.distinctId, null);
  });

  test('failed onboarding produces no completion analytics and telemetry failures do not block account writes', async (t) => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    let failCapture = false;
    const analytics = await createAnalytics({
      provider: {
        capture(event) {
          if (failCapture) throw new Error('Telemetry unavailable');
          captured.push(event);
        },
        shutdown: async () => {
          throw new Error('Telemetry unavailable');
        },
      },
      deployment: 'hosted',
      environment: 'production',
      dataRoot: '.',
    });
    const f = await fixture(
      async () => {
        throw new Error('Setup unavailable');
      },
      undefined,
      analytics,
    );
    t.after(() => f.app.close());
    const headers = { origin: 'https://otto.example.test', cookie: 'fixture=alex' };
    const failed = await f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers,
      payload: { onboardingCompleted: true },
    });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(captured, []);
    failCapture = true;
    const saved = await f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers,
      payload: { theme: 'dark' },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(f.records.get('alex')?.theme, 'dark');
    await analytics.shutdown();
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

describe('analytics privacy', () => {
  test('hosted development suppresses collection in production Node mode unless explicitly enabled', async () => {
    for (const mode of ['gateway', 'tenant']) {
      for (const [overrides, enabled, environment] of [
        [{}, false, 'development'],
        [{ OTTO_ENVIRONMENT: '' }, false, 'development'],
        [{ OTTO_ENVIRONMENT: 'staging' }, false, 'development'],
        [{ OTTO_ANALYTICS_ENVIRONMENT: 'production' }, false, 'production'],
        [{ OTTO_ANALYTICS_ENABLED: 'true' }, true, 'development'],
        [
          { OTTO_ANALYTICS_ENABLED: 'true', OTTO_ANALYTICS_ENVIRONMENT: 'production' },
          true,
          'production',
        ],
        [{ OTTO_ENVIRONMENT: 'production' }, true, 'production'],
        [{ OTTO_ENVIRONMENT: 'production', OTTO_ANALYTICS_ENABLED: 'false' }, false, 'production'],
        [
          { OTTO_ENVIRONMENT: 'production', OTTO_ANALYTICS_ENVIRONMENT: 'development' },
          true,
          'development',
        ],
      ] as const) {
        const env = { OTTO_MODE: mode, NODE_ENV: 'production', ...overrides };
        const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
        const analytics = await createAnalytics({
          provider: analyticsEnabled(env)
            ? { capture: (event) => captured.push(event), shutdown: async () => {} }
            : undefined,
          deployment: 'hosted',
          environment: analyticsEnvironment(env),
          dataRoot: '.',
        });
        const configuration = analytics.configuration('owner-fixture');
        assert.equal(configuration.enabled, enabled, JSON.stringify(env));
        assert.equal(configuration.environment, environment, JSON.stringify(env));
        analytics.capture('owner-fixture', { event: 'otto_onboarding_completed' });
        assert.equal(captured.length, enabled ? 1 : 0, JSON.stringify(env));
        if (enabled) assert.equal(captured[0].properties.environment, environment);
      }
    }
  });

  test('local installations retain independent opaque identities and disabled analytics creates no identity', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-analytics-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = { capture() {}, shutdown: async () => {} };
    const input = {
      provider,
      deployment: 'local' as const,
      environment: 'production' as const,
      dataRoot: join(root, 'first'),
    };
    const [first, concurrent] = await Promise.all([createAnalytics(input), createAnalytics(input)]);
    const restarted = await createAnalytics(input);
    const second = await createAnalytics({ ...input, dataRoot: join(root, 'second') });
    const id = first.configuration('local-development').distinctId;
    assert.match(id!, /^local:[0-9a-f-]{36}$/);
    assert.equal(concurrent.configuration('local-development').distinctId, id);
    assert.equal(restarted.configuration('local-development').distinctId, id);
    assert.notEqual(second.configuration('local-development').distinctId, id);
    assert.equal(
      (await readFile(join(input.dataRoot, 'analytics-id'), 'utf8')).trim(),
      id!.slice(6),
    );
    const supplied = await createAnalytics({
      ...input,
      installationId: id!.slice(6),
      dataRoot: join(root, 'desktop'),
    });
    assert.equal(supplied.configuration('local-development').distinctId, id);
    const disabled = await createAnalytics({
      ...input,
      provider: undefined,
      dataRoot: join(root, 'disabled'),
    });
    assert.equal(disabled.configuration('local-development').enabled, false);
    await assert.rejects(readFile(join(root, 'disabled', 'analytics-id')), { code: 'ENOENT' });
    const invalid = await createAnalytics({
      ...input,
      installationId: 'private-email@example.test',
    });
    assert.equal(invalid.configuration('local-development').enabled, false);
  });

  test('analytics reject arbitrary event names, unbounded identifiers and private properties', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      deployment: 'hosted',
      environment: 'production',
      dataRoot: '.',
    });
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
    assert.deepEqual(Object.keys(captured[0].properties).sort(), [
      'analytics_schema',
      'background',
      'capture_source',
      'channel',
      'deployment',
      'environment',
      'source',
    ]);
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
  async function fixture(t: import('node:test').TestContext, request?: typeof fetch) {
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
      fetch:
        request ??
        (async (input, init) => {
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
        }),
    });
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (
      ownerId: string,
      selectedBackend = backend,
      local = true,
      bootstrap?: Parameters<typeof createModelService>[0]['bootstrap'],
      changed?: () => void,
    ) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
        local,
        bootstrap,
        changed,
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
    return { create, database, backend, keyStore };
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

  test('restricted OpenAI keys save and refresh without letting invalid keys replace the saved catalog or selection', async (t) => {
    let revoked = false;
    let requests = 0;
    const f = await fixture(t, async (input, init) => {
      assert.equal(String(input), 'https://api.openai.com/v1/models');
      assert.equal(init?.method ?? 'GET', 'GET');
      requests++;
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer fixture-invalid-api-key' || revoked)
        return Response.json(
          {
            error: {
              message: 'Incorrect API key provided: fixture-invalid-api-key.',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          { status: 401 },
        );
      assert.equal(authorization, 'Bearer fixture-restricted-api-key');
      return Response.json(
        {
          error: {
            message:
              'You have insufficient permissions for this operation. Missing scopes: api.model.read.',
            type: 'invalid_request_error',
            code: null,
          },
        },
        { status: 403 },
      );
    });
    const owner = await f.create('fixture-restricted');
    const captured: AnalyticsEvent[] = [];
    const app = Fastify();
    registerAnalyticsRoutes(app, (event) => captured.push(event));
    owner.register(app);
    t.after(() => app.close());
    const added = await app.inject({
      method: 'POST',
      url: '/api/models/keys',
      payload: { provider: 'openai', key: 'fixture-restricted-api-key' },
    });
    assert.equal(added.statusCode, 200);
    assert.ok(!added.body.includes('fixture-restricted-api-key'));
    const id = owner.view().connections[0].id;
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/models/selection',
      payload: { connectionId: id, modelId: 'gpt-6-luna', effort: 'medium' },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(owner.configured, true);
    const saved = owner.view();
    const beforeRefresh = captured.length;
    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/models/connections/${id}/refresh`,
    });
    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(captured.slice(beforeRefresh), [
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ]);
    assert.equal(requests, 2);
    assert.deepEqual(owner.view(), saved);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/models/keys',
      payload: { provider: 'openai', key: 'fixture-invalid-api-key' },
    });
    assert.equal(rejected.statusCode, 400);
    assert.ok(!rejected.body.includes('fixture-invalid-api-key'));
    assert.deepEqual(owner.view(), saved);
    revoked = true;
    const failed = await app.inject({
      method: 'POST',
      url: `/api/models/connections/${id}/refresh`,
    });
    assert.equal(failed.statusCode, 400);
    assert.ok(!failed.body.includes('fixture-invalid-api-key'));
    assert.deepEqual(owner.view(), saved);
    assert.equal(captured.length, beforeRefresh + 1);
    const restored = await f.create('fixture-restricted');
    assert.deepEqual(restored.view(), saved);
    assert.equal(requests, 4);
    assert.deepEqual(await (await restored.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-restricted-api-key',
    });
    const grants = (await f.database.query('SELECT * FROM vault_app_grants')).rows;
    assert.equal(grants.length, 1);
    assert.ok(!JSON.stringify(grants).includes('fixture-restricted-api-key'));
    assert.ok(!JSON.stringify(grants).includes('fixture-invalid-api-key'));
  });

  test('bootstrap catalog failure preserves the saved choice and recovers only after an explicit refresh', async (t) => {
    const f = await fixture(t);
    let failed = false;
    let requests = 0;
    const backend = {
      ...f.backend,
      catalog: async (...args: Parameters<typeof f.backend.catalog>) => {
        requests++;
        if (failed) throw new Error('fixture-bootstrap-private-key');
        return f.backend.catalog(...args);
      },
    };
    const bootstrap = {
      provider: 'openai' as const,
      keys: { openai: 'fixture-bootstrap-private-key' },
    };
    const first = await f.create('fixture-offline', backend, true, bootstrap);
    const saved = first.view();
    assert.equal(first.configured, true);
    failed = true;
    const restored = await f.create('fixture-offline', backend, true, bootstrap);
    assert.equal(requests, 2);
    assert.deepEqual(restored.view().selection, saved.selection);
    assert.deepEqual(restored.view().connections[0].models, saved.connections[0].models);
    assert.equal(restored.view().connections[0].status, 'reconnect');
    assert.equal(restored.configured, false);
    await assert.rejects(restored.resolve());
    const app = Fastify();
    restored.register(app);
    t.after(() => app.close());
    const response = await app.inject({ url: '/api/models' });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('fixture-bootstrap-private-key'));
    const id = saved.connections[0].id;
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/models/connections/${id}/refresh`,
    });
    assert.equal(rejected.statusCode, 400);
    assert.ok(!rejected.body.includes('fixture-bootstrap-private-key'));
    assert.deepEqual(restored.view().selection, saved.selection);
    failed = false;
    const recovered = await app.inject({
      method: 'POST',
      url: `/api/models/connections/${id}/refresh`,
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(requests, 4);
    assert.equal(restored.configured, true);
    assert.deepEqual(restored.view().selection, saved.selection);
    assert.deepEqual(await (await restored.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-bootstrap-private-key',
    });
  });

  test('a failed bootstrap provider neither selects another provider nor blocks a separately selected connection', async (t) => {
    const f = await fixture(t);
    const requests: string[] = [];
    const backend = {
      ...f.backend,
      catalog: async (...args: Parameters<typeof f.backend.catalog>) => {
        requests.push(args[0]);
        if (args[0] === 'anthropic') throw new Error('fixture-revoked-anthropic-key');
        return f.backend.catalog(...args);
      },
    };
    const bootstrap = {
      provider: 'anthropic' as const,
      keys: {
        openai: 'fixture-available-openai-key',
        anthropic: 'fixture-revoked-anthropic-key',
      },
    };
    const owner = await f.create('fixture-multiple-bootstrap', backend, true, bootstrap);
    assert.deepEqual(requests, ['anthropic', 'openai']);
    assert.equal(owner.view().selection, null);
    assert.equal(owner.configured, false);
    const unavailable = owner.view().connections.find((value) => value.provider === 'anthropic')!;
    assert.equal(unavailable.status, 'reconnect');
    assert.deepEqual(unavailable.models, []);
    const available = owner.view().connections.find((value) => value.provider === 'openai')!;
    await owner.select({ connectionId: available.id, modelId: 'gpt-6.1-sol', effort: 'high' });
    const selection = owner.view().selection;
    const restored = await f.create('fixture-multiple-bootstrap', backend, true, bootstrap);
    assert.deepEqual(requests, ['anthropic', 'openai', 'anthropic', 'openai']);
    assert.deepEqual(restored.view().selection, selection);
    assert.equal(restored.configured, true);
    assert.equal((await restored.resolve()).provider, 'openai');
    assert.equal(restored.view().connections.length, 2);
    assert.ok(!JSON.stringify(restored.view()).includes('fixture-revoked-anthropic-key'));
    await assert.rejects(
      restored.select({
        connectionId: unavailable.id,
        modelId: 'claude-opus-5-5',
        effort: 'high',
      }),
    );
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
    const captured: AnalyticsEvent[] = [];
    const app = Fastify();
    registerAnalyticsRoutes(app, (event) => captured.push(event));
    owner.register(app);
    t.after(() => app.close());
    for (const payload of [
      { provider: 'anthropic' },
      { provider: 'openrouter', connectionId: randomUUID() },
    ]) {
      const rejected = await app.inject({ method: 'POST', url: '/api/models/oauth', payload });
      assert.equal(rejected.statusCode, 400);
    }
    assert.equal(captured.length, 0);
    const initiated = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(initiated.statusCode, 200, initiated.body);
    const signIn = initiated.json();
    const auth = new URL(signIn.url);
    assert.equal(signIn.attempt, auth.searchParams.get('state'));
    assert.deepEqual(captured, [
      {
        event: 'otto_settings_updated',
        properties: { section: 'models', operation: 'connect_started' },
      },
    ]);
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
    assert.deepEqual(captured.slice(1), [
      { event: 'otto_settings_updated', properties: { section: 'models', operation: 'update' } },
    ]);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    assert.equal((await complete()).statusCode, 400);
    assert.equal(captured.length, 2);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const repeated = await app.inject({
      url: `/api/models/oauth/callback?state=${signIn.attempt}&code=fixture-code`,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(captured.length, 2);
    assert.equal(exchanges, 1);
    const openRouter = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openrouter' },
    });
    assert.equal(openRouter.statusCode, 200);
    assert.equal(captured.length, 3);
    assert.deepEqual(captured[2], captured[0]);
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
    const pending = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openrouter' },
    });
    assert.equal(pending.statusCode, 400);
    assert.match(pending.json().error, /pending sign-in/);
    assert.equal(captured.length, 3);
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
  test('new ChatGPT connections select GPT-6 Sol or an offered fallback without replacing an existing choice', async (t) => {
    const f = await fixture(t);
    const offered = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'];
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => subscriptionCredential()),
      async catalog(
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) {
        return (await f.backend.catalog(provider, method)).filter((model) =>
          offered.includes(model.choice.id),
        );
      },
    };
    const connect = async (owner: Awaited<ReturnType<typeof f.create>>, connectionId?: string) => {
      const started = await owner.start('openai', connectionId);
      await owner.complete(
        new URL(`http://localhost:1455/auth/callback?state=${started.attempt}&code=fixture`),
      );
    };
    const owner = await f.create('fixture-owner', backend);
    await connect(owner);
    const original = owner.view().selection!;
    assert.equal(original.modelId, 'gpt-6-sol');
    assert.equal(owner.configured, true);
    await owner.select({ ...original, modelId: 'gpt-6-luna', effort: 'medium' });
    const chosen = owner.view().selection;
    await connect(owner, original.connectionId);
    assert.deepEqual(owner.view().selection, chosen);
    await connect(owner);
    assert.deepEqual(owner.view().selection, chosen);
    await owner.refreshCatalog(original.connectionId);
    assert.deepEqual(owner.view().selection, chosen);
    for (let attempt = 0; attempt < 2; attempt++) {
      const removed = owner.view().selection!.connectionId;
      await owner.remove(removed);
      assert.equal(owner.view().selection, null);
      await connect(owner);
      assert.equal(owner.view().selection?.modelId, 'gpt-6-sol');
      assert.notEqual(owner.view().selection?.connectionId, removed);
      assert.equal(owner.configured, true);
    }
    offered.splice(offered.indexOf('gpt-6-sol'), 1);
    const fallback = await f.create('fixture-fallback', backend);
    await connect(fallback);
    assert.equal(fallback.view().selection?.modelId, 'gpt-6.1-sol');
    offered.splice(offered.indexOf('gpt-6.1-sol'), 1);
    const limited = await f.create('fixture-limited', backend);
    await connect(limited);
    assert.equal(limited.view().selection?.modelId, 'gpt-6-luna');
    assert.equal(limited.configured, true);
    const existing = await f.create('fixture-existing');
    await existing.addKey('openai', 'fixture-api-key');
    const previous = existing.view().selection;
    const restored = await f.create('fixture-existing', backend);
    await connect(restored);
    assert.deepEqual(restored.view().selection, previous);
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
    assert.match(owner.signInStatus(started.attempt).error!, /model list/);
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
    assert.equal((credential as { accountId: string }).accountId, 'fixture-account');
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

  test('a new ChatGPT sign-in waits for cancellation already draining its callback listener', async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    let reloaded = () => {};
    const owner = await f.create(
      'fixture-owner',
      {
        ...f.backend,
        async signIn({ signal }) {
          const first = ++starts === 1;
          const state = randomBytes(16).toString('hex');
          const result = new Promise<import('../src/ports/models.ts').ModelCredential>(
            (_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  void (first ? cleanup : Promise.resolve()).then(() =>
                    reject(new Error('Fixture listener closed.')),
                  );
                },
                { once: true },
              );
            },
          );
          return {
            url: `https://auth.openai.com/authorize?state=${state}`,
            state,
            result,
            complete() {},
          };
        },
      },
      true,
      undefined,
      () => reloaded(),
    );
    const first = await owner.start('openai');
    const cancelling = owner.cancel(first.attempt);
    let cancellationComplete = false;
    const repeated = owner.cancel(first.attempt).then(() => {
      cancellationComplete = true;
    });
    const startedReload = new Promise<void>((resolve) => {
      reloaded = resolve;
    });
    const starting = owner.start('openai');
    try {
      await startedReload;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(starts, 1);
      assert.equal(cancellationComplete, false);
      release();
      await Promise.all([cancelling, repeated]);
      const second = await starting;
      assert.equal(starts, 2);
      assert.equal(owner.signInStatus(second.attempt).status, 'waiting');
      await owner.cancel(second.attempt);
    } finally {
      release();
      await Promise.allSettled([cancelling, repeated, starting]);
    }
  });

  test('failed initiation leaves no attempt and shutdown awaits an aborted starting flow', async (t) => {
    const { ModelAuthError } = await import('../src/ports/models.ts');
    const f = await fixture(t);
    let failed = false;
    let entered!: () => void;
    const enteredFlow = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted!: () => void;
    const abortedFlow = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let ready!: (flow: Awaited<ReturnType<typeof f.backend.signIn>>) => void;
    const pendingFlow = new Promise<Awaited<ReturnType<typeof f.backend.signIn>>>((resolve) => {
      ready = resolve;
    });
    let cleaned!: (error: Error) => void;
    const result = new Promise<import('../src/ports/models.ts').ModelCredential>(
      (_resolve, reject) => {
        cleaned = reject;
      },
    );
    void result.catch(() => {});
    const owner = await f.create('fixture-owner', {
      ...f.backend,
      async signIn({ signal }) {
        if (!failed) {
          failed = true;
          throw new ModelAuthError('Fixture sign-in unavailable.');
        }
        signal.addEventListener('abort', aborted, { once: true });
        entered();
        return pendingFlow;
      },
    });
    await assert.rejects(owner.start('openai'), /unavailable/);
    const starting = owner.start('openai');
    const rejection = assert.rejects(starting);
    await enteredFlow;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await abortedFlow;
    ready({
      url: 'https://auth.openai.com/authorize',
      state: 'a'.repeat(32),
      result,
      complete() {},
    });
    await Promise.resolve();
    assert.equal(closed, false);
    cleaned(new Error('Fixture listener cleanup complete.'));
    await Promise.all([closing, rejection]);
    assert.equal(closed, true);
    assert.equal(owner.view().connections.length, 0);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      0,
    );
  });

  test('temporary refresh failures retain the account while terminal failures require reconnect', async (t) => {
    const { ModelAuthError } = await import('../src/ports/models.ts');
    const f = await fixture(t);
    let failure: 'temporary' | 'terminal' | null = 'temporary';
    let catalogFailure = false;
    let refreshes = 0;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => ({
        ...subscriptionCredential(0),
        email: 'fixture-before@example.test',
      })),
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => {
        if (catalogFailure) throw new Error('fixture-catalog-outage');
        return f.backend.catalog(provider, method);
      },
      async refresh(value: import('../src/ports/models.ts').ModelCredential) {
        refreshes++;
        if (failure)
          throw new ModelAuthError('ChatGPT temporarily unavailable.', failure === 'terminal');
        if (value.type !== 'oauth') throw new Error('Expected OAuth credential.');
        return {
          ...value,
          email: 'fixture-after@example.test',
          refresh: 'fixture-rotated-refresh',
          expires: Date.now() + 3600000,
        };
      },
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    const access = await owner.resolve();
    await assert.rejects(access.read(), /temporarily unavailable/);
    assert.equal(owner.view().connections[0].status, 'connected');
    failure = null;
    catalogFailure = true;
    await assert.rejects(owner.refreshCatalog(owner.view().connections[0].id), /model list/);
    const refreshed = await access.read();
    assert.equal(refreshed?.type, 'oauth');
    assert.equal((refreshed as { refresh: string }).refresh, 'fixture-rotated-refresh');
    assert.equal(refreshes, 2);
    catalogFailure = false;
    await owner.refreshCatalog(owner.view().connections[0].id);
    assert.equal(owner.view().connections[0].label, 'fixture-after@example.test');
    assert.doesNotMatch(
      JSON.stringify(owner.view()),
      /fixture-access|fixture-rotated-refresh|fixture-account/,
    );
    failure = 'terminal';
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3600000 });
    await assert.rejects(access.read(), /Reconnect/);
    t.mock.timers.reset();
    assert.equal(owner.view().connections[0].status, 'reconnect');
    await assert.rejects(access.read(), /Reconnect/);
    assert.equal(refreshes, 3);
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
      /Add connection/,
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

  test('legacy direct credentials and model transports require reconnect without using old tokens', async (t) => {
    const f = await fixture(t);
    let refreshes = 0;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => subscriptionCredential()),
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
      async refresh() {
        refreshes++;
        throw new Error('Old token reached refresh.');
      },
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    const id = owner.view().connections[0].id;
    const access = await owner.resolve();
    await f.database.query(
      "UPDATE model_connections SET models=jsonb_set(models,'{0,spec,api}','\"openai-responses\"') WHERE id=$1",
      [id],
    );
    const restored = await f.create('fixture-owner', backend);
    assert.equal(restored.view().connections[0].status, 'reconnect');
    await assert.rejects(access.read(), /Reconnect/);
    assert.equal(refreshes, 0);
    await f.database.query("UPDATE vault_app_grants SET ciphertext='invalid' WHERE id=$1", [id]);
    const reconnect = await restored.start('openai', id);
    await restored.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${reconnect.attempt}&code=fixture`),
    );
    assert.equal(restored.view().connections[0].status, 'connected');
    assert.equal(restored.view().connections[0].id, id);
    const { createAppGrantVault } = await import('../src/server/vault-app-grants.ts');
    const vault = await createAppGrantVault(f.database, {
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
    });
    await vault.put(
      id,
      JSON.stringify({
        type: 'oauth',
        access: 'fixture-direct-access',
        refresh: 'fixture-direct-refresh',
        expires: 0,
        clientId: 'fixture-direct-client',
        subject: 'fixture-owner',
        idToken: 'fixture-id-token',
        scopes: ['chatgpt.tokens.use.direct'],
      }),
    );
    const migrated = await f.create('fixture-owner', backend);
    assert.equal(migrated.view().connections[0].status, 'reconnect');
    await assert.rejects((await restored.resolve()).read(), /Reconnect/);
    assert.equal(refreshes, 0);
  });
});
