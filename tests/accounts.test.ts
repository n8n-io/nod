import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import { createFilesystemKeyStore } from '../src/providers/filesystem/key-store.ts';
import { openCredential, sealCredential } from '../src/server/vault.ts';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, type Analytics } from '../src/server/analytics.ts';

describe('account routes', () => {
  const origin = 'http://localhost:4399';
  async function fixture(start?: (ownerId: string) => Promise<void>, analytics?: Analytics) {
    let record: StoredAccount = {
      theme: 'system',
      onboardingCompleted: false,
      displayName: null,
      usageData: false,
    };
    const calls = { writes: 0, started: [] as (string | undefined)[] };
    const accounts: AccountStore = {
      async readConsent() {
        return { enabled: record.usageData, revision: '0' };
      },
      async read() {
        return record;
      },
      async update(_owner, input) {
        calls.writes++;
        const saved = record;
        record = {
          theme: input.theme ?? saved.theme,
          onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
          displayName: saved.displayName,
          usageData: input.usageData ?? saved.usageData,
        };
        return {
          ...record,
          onboardingCompletedNow: record.onboardingCompleted && !saved.onboardingCompleted,
        };
      },
    };
    const app = Fastify();
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'Invalid account request.' }),
    );
    createAccountSession({
      analytics,
      accounts,
      origin,
      localUser: { id: 'local-owner', name: 'You', email: null, avatarUrl: null },
      developerIds: new Set(['local-owner']),
      async start(owner, name) {
        calls.started.push(name);
        await start?.(owner);
      },
    }).register(app);
    await app.ready();
    return { app, calls, record: () => record };
  }

  test('usage data stays off until the owner opts in and the environment switch always wins', async (t) => {
    for (const available of [true, false]) {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const installationId = randomUUID();
      const analytics = await createAnalytics({
        provider: available
          ? { capture: (event) => captured.push(event), shutdown: async () => {} }
          : undefined,
        deployment: 'local',
        environment: 'production',
        dataRoot: '.',
        installationId,
      });
      const f = await fixture(undefined, analytics);
      t.after(() => f.app.close());
      const request = (payload?: object) =>
        f.app.inject({
          method: payload ? 'PATCH' : 'GET',
          url: payload ? '/api/account' : '/api/session',
          headers: { origin },
          ...(payload ? { payload } : {}),
        });
      const initial = await request();
      assert.equal(initial.json().settings.usageData, false);
      assert.deepEqual(
        [initial.json().analytics.enabled, initial.json().analytics.distinctId],
        [false, null],
      );
      await request({ onboardingCompleted: true });
      assert.deepEqual(f.calls.started, [undefined]);
      analytics.capture('local-owner', { event: 'otto_conversation_reset' });
      assert.equal(captured.length, 0);
      const opted = await request({ usageData: true });
      assert.equal(opted.statusCode, 200);
      assert.equal(opted.json().user.name, 'You');
      assert.equal(opted.json().settings.usageData, true);
      assert.equal(opted.json().analytics.enabled, available);
      assert.equal(f.record().usageData, true);
      await request({ theme: 'dark' });
      analytics.forOwner('local-owner')({ event: 'otto_chat_stopped' });
      assert.deepEqual(
        captured.map((event) => [event.distinctId, event.event]),
        available
          ? [
              [`local:${installationId}`, 'otto_settings_updated'],
              [`local:${installationId}`, 'otto_chat_stopped'],
            ]
          : [],
      );
      const declined = await request({ usageData: false });
      assert.equal(declined.json().analytics.enabled, false);
      analytics.capture('local-owner', { event: 'otto_chat_stopped' });
      assert.equal(captured.length, available ? 2 : 0);
    }
  });

  test('account changes require the same origin and owner and never accept provider or owner input', async (t) => {
    const f = await fixture();
    t.after(() => f.app.close());
    const headers = { origin };
    for (const input of [
      { headers: { origin: 'https://foreign.example.test' }, payload: {}, status: 403 },
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
      [{ 'x-otto-account': 'sam' }, { theme: 'dark' }, 401],
      [{}, { name: 'Changed' }, 400],
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
    const welcome = await f.app.inject({
      method: 'POST',
      url: '/api/account/welcome',
      headers,
      payload: {},
    });
    assert.equal(welcome.statusCode, 409);
    const prepared = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: { ...headers, 'x-otto-account': 'local-owner' },
      payload: {},
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(f.calls.writes, 0);
    assert.deepEqual(f.calls.started, []);
  });
});

describe('analytics privacy', () => {
  test('analytics reject arbitrary event names, unbounded identifiers and private properties', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const installationId = randomUUID();
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      deployment: 'local',
      environment: 'production',
      dataRoot: '.',
      installationId,
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
    assert.equal(captured[0].distinctId, `local:${installationId}`);
  });
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

describe('filesystem Vault key', { skip: process.platform === 'win32' }, () => {
  test('new nested roots withhold their key until ancestor entries persist across readers and retries', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-vault-ancestors-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dataRoot = join(root, 'new', 'nested', 'profile');
    const ancestor = await lstat(root);
    const handle = await open(root, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const sync = prototype.sync;
    await handle.close();
    let fail = true;
    t.mock.method(prototype, 'sync', async function (this: typeof handle) {
      const metadata = await this.stat();
      if (fail && metadata.dev === ancestor.dev && metadata.ino === ancestor.ino)
        throw Object.assign(new Error('Synthetic ancestor persistence failure'), { code: 'EIO' });
      return sync.call(this);
    });
    const first = createFilesystemKeyStore({ dataRoot, canCreate: async () => true });
    await assert.rejects(first.getKey(), { code: 'EIO' });
    const saved = await readFile(join(dataRoot, 'vault', 'master-key'), 'utf8');
    const second = createFilesystemKeyStore({ dataRoot, canCreate: async () => false });
    await Promise.all([
      assert.rejects(first.getKey(), { code: 'EIO' }),
      assert.rejects(second.getKey(), { code: 'EIO' }),
    ]);
    assert.equal(await readFile(join(dataRoot, 'vault', 'master-key'), 'utf8'), saved);
    fail = false;
    const keys = await Promise.all([first.getKey(), second.getKey()]);
    assert.ok(keys.every((key) => key.toString('base64') === saved));
    const entry = { id: randomUUID(), owner_id: 'synthetic-owner', origin: 'https://example.test' };
    const secret = { username: 'synthetic@example.test', password: 'synthetic-secret' };
    const ciphertext = sealCredential(keys[0], entry, secret);
    const restored = createFilesystemKeyStore({ dataRoot, canCreate: async () => false });
    assert.deepEqual(openCredential(await restored.getKey(), { ...entry, ciphertext }), secret);
  });

  test('directory persistence failures withhold the key and retry retains the published key', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-vault-durability-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = await open(root, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const sync = prototype.sync;
    await handle.close();
    let fail = true;
    t.mock.method(prototype, 'sync', async function (this: typeof handle) {
      if ((await this.stat()).isDirectory() && fail)
        throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' });
      return sync.call(this);
    });
    const store = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => true });
    await assert.rejects(store.getKey(), { code: 'EIO' });
    const saved = await readFile(join(root, 'vault', 'master-key'), 'utf8');
    fail = false;
    const key = await store.getKey();
    assert.equal(key.toString('base64'), saved);
    const restored = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => false });
    fail = true;
    await assert.rejects(restored.getKey(), { code: 'EIO' });
    fail = false;
    assert.deepEqual(await restored.getKey(), key);
  });

  test('concurrent instances publish one private key and decrypt after restart', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-vault-key-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o755);
    const stores = Array.from({ length: 12 }, () =>
      createFilesystemKeyStore({ dataRoot: root, canCreate: async () => true }),
    );
    const keys = await Promise.all(stores.map((store) => store.getKey()));
    const path = join(root, 'vault', 'master-key');
    const saved = await readFile(path, 'utf8');
    assert.equal(Buffer.from(saved, 'base64').length, 32);
    for (const key of keys) assert.equal(key.toString('base64'), saved);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, 'vault'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(root, 'vault')), ['master-key']);
    const entry = { id: randomUUID(), owner_id: 'synthetic-owner', origin: 'https://example.test' };
    const secret = { username: 'synthetic@example.test', password: 'synthetic-secret' };
    const ciphertext = sealCredential(keys[0], entry, secret);
    keys[0].fill(0);
    assert.equal(keys[1].toString('base64'), saved);
    const alias = join(root, 'trusted-alias');
    await symlink(root, alias);
    const restored = createFilesystemKeyStore({
      dataRoot: alias,
      canCreate: async () => {
        throw new Error('An existing key must not need creation permission.');
      },
    });
    assert.deepEqual(openCredential(await restored.getKey(), { ...entry, ciphertext }), secret);
    assert.deepEqual(openCredential(await stores[0].getKey(), { ...entry, ciphertext }), secret);
  });

  test('missing keys cannot replace sealed data and explicit retry preserves the new key', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-vault-missing-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sealed = true;
    const store = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => !sealed });
    const failed = await Promise.allSettled([store.getKey(), store.getKey()]);
    assert.ok(failed.every((result) => result.status === 'rejected'));
    await assert.rejects(lstat(join(root, 'vault', 'master-key')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(root, 'vault')), []);
    sealed = false;
    const key = await store.getKey();
    sealed = true;
    assert.deepEqual(await store.getKey(), key);
    await rm(join(root, 'vault', 'master-key'));
    await assert.rejects(store.getKey(), /missing/);
    assert.deepEqual(await readdir(join(root, 'vault')), []);
  });

  test('unsafe paths and invalid key contents are refused without replacement', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'otto-vault-unsafe-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = join(root, 'original');
    const originalKey = await createFilesystemKeyStore({
      dataRoot: original,
      canCreate: async () => true,
    }).getKey();
    for (const variant of [
      'symbolic directory',
      'symbolic key',
      'permissive directory',
      'permissive key',
      'writable root',
      'nonregular key',
      'invalid key',
    ]) {
      await t.test(variant, async () => {
        const dataRoot = join(root, variant.replaceAll(' ', '-'));
        const directory = join(dataRoot, 'vault');
        const path = join(directory, 'master-key');
        await mkdir(dataRoot, { mode: 0o700 });
        if (variant === 'symbolic directory') await symlink(join(original, 'vault'), directory);
        else {
          await mkdir(directory, { mode: 0o700 });
          if (variant === 'symbolic key')
            await symlink(join(original, 'vault', 'master-key'), path);
          else if (variant === 'nonregular key') await mkdir(path);
          else
            await writeFile(
              path,
              variant === 'invalid key' ? 'invalid' : originalKey.toString('base64'),
              { mode: 0o600 },
            );
          if (variant === 'permissive key') await chmod(path, 0o644);
          if (variant === 'permissive directory') await chmod(directory, 0o755);
        }
        if (variant === 'writable root') await chmod(dataRoot, 0o777);
        const previous = await lstat(path);
        let creationChecks = 0;
        const store = createFilesystemKeyStore({
          dataRoot,
          canCreate: async () => {
            creationChecks++;
            return true;
          },
        });
        await assert.rejects(store.getKey());
        assert.equal(creationChecks, 0);
        const current = await lstat(path);
        assert.equal(current.ino, previous.ino);
        assert.equal(current.mode, previous.mode);
      });
    }
    assert.equal(
      await readFile(join(original, 'vault', 'master-key'), 'utf8'),
      originalKey.toString('base64'),
    );
  });
});

test('server addresses keep host and port, add http and refuse other schemes, sign-ins, queries and fragments', async () => {
  const { endpointAddress } = await import('../src/server/models.ts');
  assert.deepEqual(
    [
      'localhost:11434',
      'localhost:11434/v1/',
      '192.168.1.5:8080',
      '[::1]:1234/v1',
      'ollama.local',
      'https://api.example.test/openai/v1',
      'file:/tmp',
      'ftp://example.test',
      'http://user:secret@localhost:11434',
      'http://localhost:11434?',
      'http://localhost:11434/v1#',
    ].map(endpointAddress),
    [
      'http://localhost:11434',
      'http://localhost:11434/v1',
      'http://192.168.1.5:8080',
      'http://[::1]:1234/v1',
      'http://ollama.local',
      'https://api.example.test/openai/v1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );
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
    const create = async (
      ownerId: string,
      selectedBackend = backend,
      bootstrap?: Parameters<typeof createModelService>[0]['bootstrap'],
    ) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
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

  test('OpenAI-compatible servers connect from Models or server settings, and keep their key out of storage', async (t) => {
    const f = await fixture(t);
    const { createServer } = await import('node:http');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const server = createServer((request, response) => {
      const found = request.url === '/v1/models';
      response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(found ? { data: [{ id: 'fixture-local' }] } : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const owner = await f.create('fixture-owner', createPiModelBackend());
    const id = await owner.addEndpoint(
      `${address.slice('http://'.length)}/`,
      'fixture-endpoint-key',
    );
    await owner.select({ connectionId: id, modelId: 'fixture-local', effort: 'off' });
    const access = await owner.resolve();
    assert.equal(access.definition.spec.baseUrl, `${address}/v1`);
    assert.deepEqual(await access.read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-endpoint-key',
    });
    assert.equal(await owner.addEndpoint(address, 'fixture-rotated-key'), id);
    assert.equal(owner.view().connections.length, 1);
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-rotated-key',
    });
    const bootstrap = {
      provider: 'compatible' as const,
      credentials: {
        compatible: { type: 'endpoint' as const, url: address, key: 'fixture-server-key' },
      },
    };
    const configured = await f.create('fixture-server', createPiModelBackend(), bootstrap);
    const [managed] = configured.view().connections;
    assert.deepEqual(
      [managed.managed, managed.status, configured.view().selection?.modelId],
      [true, 'connected', 'fixture-local'],
    );
    assert.equal((await (await configured.resolve()).read())?.type, 'endpoint');
    await assert.rejects(configured.remove(managed.id));
    const stored = JSON.stringify([
      (await f.database.query('SELECT * FROM vault_app_grants')).rows,
      (await f.database.query('SELECT * FROM model_connections')).rows,
    ]);
    assert.ok(!stored.includes('fixture-endpoint-key'));
    assert.ok(!stored.includes('fixture-server-key'));
    assert.ok(!stored.includes('fixture-rotated-key'));
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
