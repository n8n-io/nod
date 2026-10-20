import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AccountStore, StoredAccount } from '../src/server/account-store.ts';
import { createAccountSession } from '../src/server/account.ts';
import { registerLocalAccess } from '../src/server/access.ts';
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
import { createLedger } from '../src/server/ledger.ts';
import { createModelTraces } from '../src/server/traces.ts';
import type { ModelTrace } from '../src/ports/traces.ts';
import { setRequestAccount } from '../src/web/lib/api.ts';
import { loadLinkPreview } from '../src/web/lib/link-previews.ts';

test('queued and cached link previews cannot cross an owner change', async (t) => {
  const calls: Array<{ url: string; account: string | null; respond(): void }> = [];
  const requests: ReturnType<typeof loadLinkPreview>[] = [];
  let automatic = false;
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    const url = JSON.parse(String(options.body)).url as string;
    const account = new Headers(options.headers).get('X-Otto-Account');
    const imageUrl = `/api/link-preview/image/${randomUUID()}`;
    return new Promise<Response>((resolve) => {
      const respond = () => resolve(Response.json({ preview: { url, imageUrl } }));
      calls.push({ url, account, respond });
      if (automatic) respond();
    });
  });
  const load = (url: string) => {
    const pending = loadLinkPreview(url);
    requests.push(pending);
    return pending;
  };
  t.after(async () => {
    automatic = true;
    for (const call of calls) call.respond();
    await Promise.all(requests);
    setRequestAccount(null);
  });
  setRequestAccount('fixture-first-owner');
  const cachedUrl = 'https://example.com/cached';
  const firstCached = load(cachedUrl);
  calls[0].respond();
  const cached = await firstCached;
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.com/queued-${index}`);
  const firstOwner = urls.map(load);
  setRequestAccount('fixture-next-owner');
  const nextOwner = load(urls[0]);
  const nextCached = load(cachedUrl);
  for (const call of calls.slice(1)) call.respond();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.filter((call) => call.account === 'fixture-next-owner').map((call) => call.url),
    [urls[0], cachedUrl],
  );
  assert.deepEqual(
    await Promise.all(firstOwner),
    urls.map(() => null),
  );
  const repeated = load(urls[0]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 7);
  for (const call of calls.filter((call) => call.account === 'fixture-next-owner')) call.respond();
  assert.ok(await nextOwner);
  assert.deepEqual(await repeated, await nextOwner);
  assert.notEqual((await nextCached)?.imageUrl, cached?.imageUrl);
});

describe('account routes', () => {
  const origin = 'http://localhost:4399';
  async function fixture(
    start?: (ownerId: string) => Promise<void>,
    analytics?: Analytics,
    onTraces?: (enabled: boolean) => void,
    key?: string,
  ) {
    let record: StoredAccount = {
      theme: 'system',
      onboardingCompleted: false,
      displayName: null,
      usageData: false,
      traces: false,
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
          traces: input.traces ?? saved.traces,
        };
        return {
          ...record,
          onboardingCompletedNow: record.onboardingCompleted && !saved.onboardingCompleted,
        };
      },
    };
    const app = Fastify();
    if (key) registerLocalAccess(app, 4399, { key });
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
      traces: onTraces !== undefined,
      onTraces,
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
      assert.equal(initial.json().capabilities.traces, false);
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

  test('conversation traces stay off until the owner opts in, stop at once and leave without personal data', async (t) => {
    const delivered: ModelTrace[] = [];
    const traces = createModelTraces(async (trace) => {
      delivered.push(trace);
    });
    traces.configure({
      secrets: ['fixture-model-key-8c41f2'],
      profile: async () => ({ names: ['Marta Vidal'], region: 'ES' }),
    });
    const f = await fixture(undefined, undefined, (enabled) => traces.configure({ enabled }));
    t.after(() => f.app.close());
    const request = (payload?: object) =>
      f.app.inject({
        method: payload ? 'PATCH' : 'GET',
        url: payload ? '/api/account' : '/api/session',
        headers: { origin },
        ...(payload ? { payload } : {}),
      });
    const trace = (content: string): ModelTrace => ({
      id: randomUUID(),
      name: 'fixture-model',
      provider: 'fixture',
      startedAt: '2026-10-19T10:00:00.000Z',
      endedAt: '2026-10-19T10:00:01.000Z',
      messages: [
        { role: 'user', content },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'send_email',
                arguments:
                  '{"first_name":"Jordi","to":"jordi@example.com","address":{"line1":"12 Main St"},"password":"fixture-tool-secret-77","fields":[["password","fixture-pair-secret-88"]]}',
              },
            },
          ],
        },
      ],
      tools: ['send_email'],
      output: { role: 'assistant', content: 'Thanks Marta, sent to +44 20 7946 0958.' },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
      metadata: { session_id: 'fixture-session', turn_id: 'fixture-turn' },
    });
    const settle = async (count: number) => {
      for (let attempt = 0; attempt < 40 && delivered.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const initial = (await request()).json();
    assert.deepEqual([initial.capabilities.traces, initial.settings.traces], [true, false]);
    traces.record(trace('Before opting in'));
    await settle(1);
    assert.equal(traces.active(), false);
    assert.equal(delivered.length, 0);
    assert.equal((await request({ traces: true })).json().settings.traces, true);
    assert.equal(f.record().traces, true);
    traces.record(
      trace(
        'I am Marta Vidal <marta.vidal@example.com>, cc alice smith <alice@example.com>, card 4111 1111 1111 1111, IBAN ES91 2100 0418 4502 0005 1332, call 612 345 678, DNI 12345678Z, server 2001:db8::1 and 203.0.113.42. Host 192.168.1.1.example stays. Key fixture-model-key-8c41f2, order 123456 on 2026-10-19',
      ),
    );
    await settle(1);
    assert.equal(delivered.length, 1);
    const sent = JSON.stringify(delivered[0]);
    for (const value of [
      'Marta',
      'Vidal',
      'marta.vidal@example.com',
      'Jordi',
      'jordi@example.com',
      'alice smith',
      '12 Main St',
      '2001:db8::1',
      '203.0.113.42',
      '4111',
      'ES91',
      '612 345 678',
      '7946',
      '12345678Z',
      'fixture-model-key-8c41f2',
      'fixture-tool-secret-77',
      'fixture-pair-secret-88',
    ])
      assert.ok(!sent.includes(value), value);
    assert.match(sent, /order 123456 on 2026-10-19/);
    assert.match(sent, /192\.168\.1\.1\.example/);
    assert.deepEqual(Object.keys(delivered[0].metadata), ['session_id', 'turn_id']);
    assert.match(delivered[0].metadata.session_id, /^[0-9a-f]{32}$/);
    assert.ok(!sent.includes('fixture-session') && !sent.includes('fixture-turn'));
    traces.record(trace('A second request in the same conversation'));
    await settle(2);
    assert.equal(delivered[1].metadata.session_id, delivered[0].metadata.session_id);
    await request({ traces: false });
    traces.record(trace('After opting out'));
    await settle(3);
    assert.equal(delivered.length, 2);
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
      [{}, { traces: true }, 400],
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

  test('visited websites and secure entries send only the registrable domain of an address', async () => {
    const { createWebsiteVisits } = await import('../src/server/analytics-connections.ts');
    const { captureSecureEntry } = await import('../src/server/vault-use.ts');
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const capture = analytics.forOwner('owner-fixture');
    const addresses = [
      'https://checkout.shop.example.co.uk/orders/private-person?email=person%40example.com#card',
      'https://www.example.co.uk/other',
      'http://192.168.1.20/admin',
      'http://localhost:4310/vault',
      'https://printer.local/status',
    ];
    analytics.withRun('owner-fixture', () => {
      const visited = createWebsiteVisits(analytics, 'owner-fixture');
      for (const address of addresses) {
        visited(address, 'browser', false);
        visited(address, 'fetch', true);
      }
    });
    for (const origin of addresses) {
      captureSecureEntry(capture, { kind: 'password', origin }, 'requested');
      captureSecureEntry(
        capture,
        { kind: 'card', origin, payment: { amount: 1234.5678, currency: 'EUR' } },
        'submitted',
      );
      captureSecureEntry(capture, { kind: 'otp', origin }, 'requested');
    }
    const sent = captured.map(({ event, properties }) => {
      const { analytics_schema, deployment, environment, capture_source, run_id, ...rest } =
        properties;
      return { event, ...rest };
    });
    assert.deepEqual(
      sent.filter(({ event }) => event === 'otto_website_visited'),
      [{ event: 'otto_website_visited', domain: 'example.co.uk', via: 'browser', subagent: false }],
    );
    const entries = sent.filter(({ event }) => event === 'otto_secure_entry_changed');
    assert.equal(entries.length, 15);
    assert.deepEqual(
      new Set(entries.map((entry) => JSON.stringify(entry))),
      new Set(
        [
          { kind: 'sign_in', status: 'requested', domain: 'example.co.uk' },
          { kind: 'sign_in', status: 'requested' },
          {
            kind: 'payment',
            status: 'submitted',
            domain: 'example.co.uk',
            currency: 'EUR',
            amount: 1234.568,
          },
          { kind: 'payment', status: 'submitted', currency: 'EUR', amount: 1234.568 },
          { kind: 'code', status: 'requested' },
        ].map((properties) =>
          JSON.stringify({ event: 'otto_secure_entry_changed', ...properties }),
        ),
      ),
    );
    for (const value of [
      'checkout',
      'shop.',
      'private-person',
      'person%40',
      '192.168',
      'localhost',
    ])
      assert.ok(!JSON.stringify(captured).includes(value), value);
  });

  test('agent model usage analytics carry the request duration and cached input', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
    });
    const agent = ledger.agent({
      open: async (session) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async () =>
          session.onEvent({
            type: 'model_usage',
            id: randomUUID(),
            provider: 'openai',
            model: 'gpt-6-luna',
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 2000,
            cacheWriteTokens: 0,
            totalTokens: 2025,
            costUsd: 0.001,
            costSource: 'sdk_estimate',
            createdAt: new Date(Date.now() - 1_500).toISOString(),
          }),
      }),
      dispose() {},
    });
    const opened = await agent.open({ turnId: randomUUID(), onEvent() {} } as never);
    await opened.prompt('Synthetic', []);
    const used = captured.find((event) => event.event === 'otto_model_used')!;
    assert.equal(used.properties.input_tokens, 2020);
    assert.equal(used.properties.cached_input_tokens, 2000);
    assert.ok(Number(used.properties.duration_ms) >= 1_500);
  });

  test('model usage analytics never send custom endpoint or unbounded model names', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
    });
    const usage = { category: 'review', operation: 'review', status: 'succeeded' } as const;
    await ledger
      .decisions({
        check: async (_request, _signal, report) => {
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'compatible',
            model: 'private-finance-model',
            durationMs: 12.4,
            inputTokens: 10,
            cacheReadTokens: 30,
            outputTokens: 5,
            costUsd: 0.0000123456,
          });
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'openrouter',
            model: 'acme/Private Person',
            durationMs: 0,
          });
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'openai-codex',
            model: 'gpt-5.1-codex',
            durationMs: 0,
            costUsd: null,
            estimateUsd: 0.5,
          });
          return {};
        },
      })
      .check({ instructions: '', input: {}, question: { name: 'answer', choices: [] } });
    const shared = { purpose: 'review', outcome: 'succeeded' };
    assert.deepEqual(
      captured.map(({ properties }) => {
        const { analytics_schema, deployment, environment, capture_source, ...rest } = properties;
        return rest;
      }),
      [
        {
          ...shared,
          provider: 'compatible',
          model: 'custom',
          input_tokens: 40,
          output_tokens: 5,
          cached_input_tokens: 30,
          cost_usd: 0.000012,
          pricing: 'api',
          duration_ms: 12,
        },
        {
          ...shared,
          provider: 'openrouter',
          model: 'custom',
          input_tokens: 0,
          output_tokens: 0,
          pricing: 'unavailable',
        },
        {
          ...shared,
          provider: 'openai',
          model: 'gpt-5.1-codex',
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0.5,
          pricing: 'plan_estimate',
        },
      ],
    );
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

describe('desktop model setup', () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createSetupModels } = await import('../src/server/setup-models.ts');
    const { agentModels } = await import('../src/shared/model-defaults.ts');
    const values = new Map<string, unknown>();
    const journal: import('../src/ports/setup.ts').SetupJournal = {
      async read<T>(section: string) {
        return structuredClone(values.get(section)) as T | undefined;
      },
      async update<T>(section: string, change: (current: T | undefined) => T) {
        const next = change(structuredClone(values.get(section)) as T | undefined);
        values.set(section, structuredClone(next));
        return structuredClone(next);
      },
    };
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 7) };
    let catalogAvailable = true;
    let refreshes = 0;
    const backend: import('../src/ports/models.ts').ModelBackend = {
      async catalog(provider) {
        if (!catalogAvailable) throw new Error('fixture-catalog-unavailable');
        return [
          {
            choice: {
              id: agentModels[provider] ?? 'fixture-local',
              name: 'Fixture model',
              efforts: ['off', 'high'],
              images: false,
              contextWindow: 32000,
            },
            spec: { id: agentModels[provider], provider },
          },
        ];
      },
      authorize({ redirectUri }) {
        const state = randomBytes(24).toString('base64url');
        return {
          url: `https://auth.example.invalid/?state=${state}`,
          state,
          secret: { redirectUri },
        };
      },
      async exchange() {
        return { type: 'api_key', key: 'fixture-router-key' };
      },
      async signIn({ signal }) {
        const state = randomBytes(24).toString('base64url');
        let resolve!: (credential: import('../src/ports/models.ts').ModelCredential) => void;
        let reject!: (error: Error) => void;
        const result = new Promise<import('../src/ports/models.ts').ModelCredential>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        signal.addEventListener('abort', () => reject(new Error('fixture-cancelled')), {
          once: true,
        });
        return {
          url: `https://auth.example.invalid/?state=${state}`,
          state,
          result,
          complete(callback) {
            assert.equal(callback.searchParams.get('state'), state);
            resolve({
              type: 'oauth',
              access: 'fixture-access',
              refresh: 'fixture-refresh',
              expires: Date.now() - 1,
              accountId: 'fixture-account',
            });
          },
        };
      },
      async refresh(current) {
        if (current.type !== 'oauth') throw new Error('Expected OAuth.');
        refreshes++;
        return {
          ...current,
          access: 'fixture-next-access',
          refresh: 'fixture-next-refresh',
          expires: Date.now() + 3600000,
        };
      },
    };
    const services: ReturnType<typeof createSetupModels>[] = [];
    async function create(ownerId = 'fixture-owner', selectedBackend = backend) {
      const service = createSetupModels({
        journal,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
      });
      await service.initialize();
      services.push(service);
      return service;
    }
    t.after(async () => {
      for (const service of services) await service.close();
    });
    return {
      create,
      backend,
      journal,
      keyStore,
      values,
      catalog: (available: boolean) => {
        catalogAvailable = available;
      },
      refreshes: () => refreshes,
    };
  }

  test('a connected model survives setup restart, stays private and freezes before engine handoff', async (t) => {
    const f = await fixture(t);
    const setup = await f.create();
    const app = Fastify();
    setup.register(app);
    t.after(() => app.close());
    const saved = await app.inject({
      method: 'POST',
      url: '/api/models/keys',
      payload: { provider: 'openai', key: 'fixture-api-key' },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(setup.configured, true);
    assert.ok(!saved.body.includes('fixture-api-key'));
    const id = setup.view().connections[0].id;
    const restored = await f.create();
    assert.deepEqual(restored.view(), setup.view());
    await assert.rejects(f.create('fixture-other'), /does not belong/);
    const access = await restored.resolve();
    assert.equal((await access.read())?.type, 'api_key');
    const transfer = await restored.transfer();
    assert.equal(transfer.connections[0].id, id);
    assert.equal(transfer.connections[0].credential.type, 'api_key');
    await assert.rejects(restored.addKey('anthropic', 'fixture-late-key'), /setup has finished/);
    await assert.rejects(access.read(), /setup has finished/);
    assert.equal((await f.journal.read<typeof transfer>('models'))!.revision, transfer.revision);
  });

  test('early OAuth keeps a verified account through model-list failure and fences canceled callbacks', async (t) => {
    const f = await fixture(t);
    f.catalog(false);
    const setup = await f.create();
    const started = await setup.start('openai');
    const callback = new URL(
      `http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`,
    );
    await setup.complete(callback);
    assert.equal(setup.signInStatus(started.attempt).status, 'connected');
    assert.equal(setup.view().connections[0].status, 'loading');
    assert.equal(setup.configured, false);
    await assert.rejects(setup.complete(callback));
    const restored = await f.create();
    const id = restored.view().connections[0].id;
    f.catalog(true);
    await restored.refreshCatalog(id);
    assert.equal(restored.configured, true);
    const [a, b] = await Promise.all([restored.resolve(), restored.resolve()]);
    const results = await Promise.all([a.read(), b.read()]);
    assert.equal(f.refreshes(), 1);
    assert.ok(
      results.every((value) => value?.type === 'oauth' && value.access === 'fixture-next-access'),
    );
    const canceled = await restored.start('openai');
    await restored.cancel(canceled.attempt);
    await assert.rejects(
      restored.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${canceled.attempt}&code=fixture`),
      ),
    );
    assert.equal(restored.view().connections.length, 1);
  });

  test('a key validation completing after handoff cannot replace the transferred setup', async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const setup = await f.create('fixture-owner', {
      ...f.backend,
      async catalog(...args) {
        entered();
        await gate;
        return f.backend.catalog(...args);
      },
    });
    const pending = setup.addKey('openai', 'fixture-pending-key');
    const rejected = assert.rejects(pending, /setup has finished/);
    await started;
    const transfer = await setup.transfer();
    release();
    await rejected;
    assert.deepEqual(transfer.connections, []);
    assert.deepEqual((await f.journal.read<typeof transfer>('models'))!.connections, []);
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

  test('desktop model import is atomic, keeps existing selection and refuses stale credentials', async (t) => {
    const f = await fixture(t);
    const { createSetupModels, importSetupModels } = await import('../src/server/setup-models.ts');
    const { createAppGrantVault } = await import('../src/server/vault-app-grants.ts');
    const owner = await f.create('fixture-owner');
    await owner.addKey('openai', 'fixture-existing-key');
    const selected = owner.view().selection;
    let saved: unknown;
    const journal: import('../src/ports/setup.ts').SetupJournal = {
      async read<T>() {
        return structuredClone(saved) as T | undefined;
      },
      async update<T>(_section: string, change: (value: T | undefined) => T) {
        saved = structuredClone(change(structuredClone(saved) as T | undefined));
        return structuredClone(saved) as T;
      },
    };
    const setup = createSetupModels({
      journal,
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
      backend: f.backend,
      origin: 'http://127.0.0.1:4310',
    });
    await setup.initialize();
    const id = await setup.addKey('openai', 'fixture-setup-key');
    const transfer = await setup.transfer();
    const client = await f.database.connect();
    try {
      await client.query('BEGIN');
      await importSetupModels(client, { ownerId: 'fixture-owner', keyStore: f.keyStore, transfer });
      await client.query('ROLLBACK');
      assert.equal(
        (await client.query('SELECT id FROM model_connections WHERE id=$1', [id])).rowCount,
        0,
      );
      assert.equal(
        (await client.query('SELECT id FROM vault_app_grants WHERE id=$1', [id])).rowCount,
        0,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await client.query('BEGIN');
        await importSetupModels(client, {
          ownerId: 'fixture-owner',
          keyStore: f.keyStore,
          transfer,
        });
        await client.query('COMMIT');
      }
      await owner.reload();
      assert.deepEqual(owner.view().selection, selected);
      assert.equal(owner.view().connections.length, 2);
      const stored = JSON.stringify((await client.query('SELECT * FROM vault_app_grants')).rows);
      assert.ok(!stored.includes('fixture-setup-key'));
      await assert.rejects(
        importSetupModels(client, { ownerId: 'fixture-other', keyStore: f.keyStore, transfer }),
        /does not belong/,
      );
      const vault = await createAppGrantVault(f.database, {
        ownerId: 'fixture-owner',
        keyStore: f.keyStore,
      });
      await vault.put(id, JSON.stringify({ type: 'api_key', key: 'fixture-newer-key' }));
      await client.query('BEGIN');
      await assert.rejects(
        importSetupModels(client, { ownerId: 'fixture-owner', keyStore: f.keyStore, transfer }),
        /changed since setup/,
      );
      await client.query('ROLLBACK');
      assert.equal(JSON.parse((await vault.read(id)).value).key, 'fixture-newer-key');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

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
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('fixture-owner', true);
    owner.register(Fastify(), analytics.forOwner('fixture-owner'));
    const id = await owner.addEndpoint(
      `${address.slice('http://'.length)}/`,
      'fixture-endpoint-key',
    );
    await owner.select({ connectionId: id, modelId: 'fixture-local', effort: 'off' });
    const { captureConnectionInventory } = await import('../src/server/analytics-connections.ts');
    await captureConnectionInventory(
      analytics,
      'fixture-owner',
      async () => [],
      () => owner.analyticsConnections(),
    );
    assert.deepEqual(
      captured.map(({ event, properties }) => {
        const { analytics_schema, deployment, environment, capture_source, ...rest } = properties;
        return { event, ...rest };
      }),
      [
        {
          event: 'otto_model_connection_changed',
          provider: 'compatible',
          method: 'api_key',
          status: 'connected',
        },
        {
          event: 'otto_model_connection_observed',
          provider: 'compatible',
          method: 'api_key',
          selected: true,
          model: 'custom',
          effort: 'off',
        },
      ],
    );
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

describe('desktop setup journal', () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createSetupJournal } = await import('../src/server/setup-journal.ts');
    const root = await mkdtemp(join(tmpdir(), 'otto-setup-journal-'));
    const secret = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.from(secret) };
    t.after(() => rm(root, { recursive: true, force: true }));
    return {
      root,
      keyStore,
      create: (ownerId = 'fixture-owner') => createSetupJournal({ root, ownerId, keyStore }),
    };
  }

  test('encrypted progress is owner-bound, survives restart and is removed only after matching acknowledgement', async (t) => {
    const f = await fixture(t);
    const journal = await f.create();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        journal.update<number>('counter', (value) => (value ?? 0) + 1),
      ),
    );
    await journal.update('private', () => ({
      key: 'fixture-private-key',
      answer: 'fixture-private-answer',
    }));
    assert.equal(await journal.read('counter'), 8);
    const bytes = await readFile(join(f.root, 'onboarding', 'pending'), 'utf8');
    assert.ok(!bytes.includes('fixture-private-key'));
    assert.ok(!bytes.includes('fixture-private-answer'));
    await journal.close();
    await assert.rejects(f.create('other-owner'));
    const restored = await f.create();
    assert.deepEqual(await restored.read('private'), {
      key: 'fixture-private-key',
      answer: 'fixture-private-answer',
    });
    const snapshot = await restored.freeze();
    await assert.rejects(restored.update('counter', () => 0));
    await assert.rejects(restored.discard(randomUUID()));
    assert.equal(await restored.read('counter'), 8);
    await restored.discard(snapshot.id);
    await assert.rejects(lstat(join(f.root, 'onboarding', 'pending')), { code: 'ENOENT' });
    await restored.close();
  });

  test(
    'a failed directory flush cannot lose acknowledged progress or overwrite a published revision',
    { skip: process.platform === 'win32' },
    async (t) => {
      const f = await fixture(t);
      const rootInfo = await lstat(f.root);
      const handle = await open(f.root, 'r');
      const prototype = Object.getPrototypeOf(handle);
      const sync = prototype.sync;
      await handle.close();
      let fail: 'root' | 'journal' | undefined = 'root';
      t.mock.method(prototype, 'sync', async function (this: typeof handle) {
        const info = await this.stat();
        const isRoot = info.dev === rootInfo.dev && info.ino === rootInfo.ino;
        if (info.isDirectory() && ((fail === 'root' && isRoot) || (fail === 'journal' && !isRoot)))
          throw Object.assign(new Error('Synthetic flush failure'), { code: 'EIO' });
        return sync.call(this);
      });
      await assert.rejects(f.create(), { code: 'EIO' });
      await assert.rejects(lstat(join(f.root, 'onboarding', 'pending')), { code: 'ENOENT' });
      fail = undefined;
      const journal = await f.create();
      await journal.update('value', () => 'before');
      fail = 'journal';
      await assert.rejects(
        journal.update('value', () => 'published'),
        { code: 'EIO' },
      );
      fail = undefined;
      await assert.rejects(journal.update('followup', () => 'next'));
      await journal.close();
      const restored = await f.create();
      assert.equal(await restored.read('value'), 'published');
      assert.equal(await restored.read('followup'), undefined);
      const snapshot = await restored.freeze();
      fail = 'root';
      await assert.rejects(restored.discard(snapshot.id), { code: 'EIO' });
      fail = undefined;
      await restored.discard(snapshot.id);
      await restored.close();
    },
  );

  test('failed unpublished writes leave no encrypted temporary files before retry or acknowledgement', async (t) => {
    for (const operation of ['writeFile', 'sync']) {
      await t.test(operation, async (t) => {
        const f = await fixture(t);
        const journal = await f.create();
        t.after(() => journal.close());
        await journal.update('private', () => 'fixture-before');
        const directory = join(f.root, 'onboarding');
        const before = await readFile(join(directory, 'pending'), 'utf8');
        const snapshot = await journal.snapshot();
        const handle = await open(join(directory, 'pending'), 'r');
        const prototype = Object.getPrototypeOf(handle);
        const original = prototype[operation];
        await handle.close();
        let fail = true;
        t.mock.method(
          prototype,
          operation,
          async function (this: typeof handle, ...args: unknown[]) {
            if (fail && (await this.stat()).isFile())
              throw Object.assign(new Error('Synthetic unpublished write failure'), {
                code: 'EIO',
              });
            return original.apply(this, args);
          },
        );
        await assert.rejects(
          journal.update('private', () => 'fixture-interrupted'),
          {
            code: 'EIO',
          },
        );
        assert.equal(await journal.read('private'), 'fixture-before');
        assert.deepEqual(await journal.snapshot(), snapshot);
        assert.equal(await readFile(join(directory, 'pending'), 'utf8'), before);
        assert.deepEqual(await readdir(directory), ['pending']);
        fail = false;
        await journal.update('private', () => 'fixture-retried');
        assert.equal(await journal.read('private'), 'fixture-retried');
        const frozen = await journal.freeze();
        await journal.discard(frozen.id);
        await assert.rejects(lstat(directory), { code: 'ENOENT' });
      });
    }
  });

  test(
    'unsafe journal directory aliases and permissions never redirect a setup write',
    { skip: process.platform === 'win32' },
    async (t) => {
      for (const variant of ['symlink', 'public-directory']) {
        await t.test(variant, async (t) => {
          const f = await fixture(t);
          const target = join(f.root, 'target');
          await mkdir(target, { mode: 0o700 });
          const directory = join(f.root, 'onboarding');
          if (variant === 'symlink') await symlink(target, directory);
          else await mkdir(directory, { mode: 0o755 });
          await assert.rejects(async () => {
            const journal = await f.create();
            try {
              await journal.update('private', () => 'fixture-private');
            } finally {
              await journal.close();
            }
          });
          assert.deepEqual(await readdir(target), []);
        });
      }
    },
  );
});

describe('desktop setup handoff', () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createDesktopSetup } = await import('../src/server/desktop-setup.ts');
    const { createSetupModels } = await import('../src/server/setup-models.ts');
    const { createSetupChannels } = await import('../src/server/setup-channels.ts');
    const { createChatSdkSetupVerifier } = await import('../src/providers/chat-sdk/settings.ts');
    const root = await mkdtemp(join(tmpdir(), 'otto-setup-api-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.from(key) };
    const ownerId = 'fixture-desktop-owner';
    const token = randomBytes(32).toString('base64url');
    const port = 4387;
    let finished = 0;
    let callbacks = 0;
    let interviewCalls = 0;
    let adapterStarts = 0;
    let busyCheck = async () => false;
    let failTransfer = false;
    const resumed: boolean[] = [];
    let model!: ReturnType<typeof createSetupModels>;
    let channels!: Awaited<ReturnType<typeof createSetupChannels>>;
    const channelCalls: string[] = [];
    const telegramToken = '987:fixture-desktop-telegram-token';
    const closed = new Set<Awaited<ReturnType<typeof createDesktopSetup>>>();
    const backend: import('../src/ports/models.ts').ModelBackend = {
      async catalog(provider) {
        return [
          {
            choice: {
              id: 'gpt-6.1-sol',
              name: 'Fixture',
              efforts: ['off'],
              images: false,
              contextWindow: 32000,
            },
            spec: { id: 'gpt-6.1-sol', provider },
          },
        ];
      },
      authorize() {
        throw new Error('Unexpected authorization');
      },
      async signIn() {
        throw new Error('Unexpected sign-in');
      },
      async exchange() {
        throw new Error('Unexpected exchange');
      },
      async refresh(value) {
        return value;
      },
    };
    async function create() {
      const setup = await createDesktopSetup({
        root,
        ownerId,
        port,
        token,
        keyStore,
        complete: () => {
          finished++;
        },
        retry: () => {},
        adapters: async (journal, resuming) => {
          adapterStarts++;
          resumed.push(resuming);
          model = createSetupModels({
            journal,
            ownerId,
            keyStore,
            backend,
            origin: `http://127.0.0.1:${port}`,
          });
          await model.initialize();
          channels = await createSetupChannels({
            journal,
            ownerId,
            keyStore,
            verifier: createChatSdkSetupVerifier({
              fetch: async (input) => {
                const url = String(input);
                if (url === `https://api.telegram.org/bot${telegramToken}/getMe`) {
                  channelCalls.push('getMe');
                  return Response.json({
                    ok: true,
                    result: {
                      id: 987,
                      is_bot: true,
                      first_name: 'Fixture bot',
                      username: 'fixture_bot',
                    },
                  });
                }
                if (url === `https://api.telegram.org/bot${telegramToken}/getWebhookInfo`) {
                  channelCalls.push('getWebhookInfo');
                  return Response.json({ ok: true, result: { url: '' } });
                }
                throw new Error('Unexpected synthetic Telegram request.');
              },
            }),
            apply: async () => {},
          });
          return {
            models: model,
            channels,
            integrations: {
              onSecrets: () => {},
              busy: () => busyCheck(),
              transfer: async () => {
                if (failTransfer) throw new Error('Synthetic transfer failure');
                return { ownerId, mode: 'otto', providerId: 'fixture', connections: [] };
              },
              close: async () => {},
              register(app: import('fastify').FastifyInstance) {
                app.get('/api/apps/callback', async () => {
                  callbacks++;
                  return { ok: true };
                });
              },
            },
            telegram: { close: async () => {}, channels: () => [], apply: async () => {} },
            curator: {
              id: 'fixture',
              configured: true,
              curate: async ({ input }: { input: { talk: Array<{ from: string }> } }) => {
                interviewCalls++;
                return {
                  messages: ['Fixture question?'],
                  done: input.talk.some((message) => message.from === 'owner'),
                };
              },
            },
            traces: createModelTraces(),
            analytics: undefined,
          } as unknown as Awaited<
            ReturnType<typeof import('../src/server/composition.ts').createDesktopSetupAdapters>
          >;
        },
      });
      closed.add(setup);
      await setup.app.ready();
      return setup;
    }
    t.after(async () => {
      for (const setup of closed) await setup.app.close();
    });
    const request = (
      setup: Awaited<ReturnType<typeof createDesktopSetup>>,
      method: 'GET' | 'POST' | 'PATCH' | 'PUT',
      url: string,
      payload?: object,
      extra: Record<string, string> = {},
    ) =>
      setup.app.inject({
        method,
        url,
        payload,
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-otto-desktop-token': token,
          ...extra,
        },
      });
    async function complete(
      setup: Awaited<ReturnType<typeof createDesktopSetup>>,
      submit = true,
      withTelegram = false,
    ) {
      assert.equal(
        (await request(setup, 'PATCH', '/api/account', { usageData: false })).statusCode,
        200,
      );
      assert.equal(
        (await request(setup, 'PATCH', '/api/desktop/setup', { step: 'brain' })).statusCode,
        200,
      );
      assert.equal(
        (
          await request(setup, 'POST', '/api/models/keys', {
            provider: 'openai',
            key: 'fixture-desktop-model-key',
          })
        ).statusCode,
        200,
      );
      for (const step of ['email', 'about'])
        assert.equal(
          (await request(setup, 'PATCH', '/api/desktop/setup', { step })).statusCode,
          200,
        );
      assert.equal(
        (
          await request(setup, 'PUT', '/api/onboarding/interview', {
            answers: ['A fixture project', 'A fixture goal', 'A fixture task'],
          })
        ).statusCode,
        200,
      );
      for (const step of ['telegram', 'open']) {
        assert.equal(
          (await request(setup, 'PATCH', '/api/desktop/setup', { step })).statusCode,
          200,
        );
        if (step === 'telegram' && withTelegram) {
          const saved = await request(setup, 'PUT', '/api/channel-settings/telegram', {
            botToken: telegramToken,
          });
          assert.equal(saved.statusCode, 200, saved.body);
          const code = new URL(saved.json().pairingUrl).searchParams.get('start')!;
          assert.equal(
            await channels.pair({
              channelId: 'telegram',
              accountId: '987',
              messageId: 'fixture-desktop-pairing',
              threadId: 'telegram:123456',
              senderId: '123456',
              senderName: 'Fixture owner',
              code,
              sentAt: new Date(),
            }),
            true,
          );
          assert.equal((await channels.status()).channels[0].pairingCandidate?.id, '123456');
          assert.equal((await channels.environment()).TELEGRAM_ALLOWED_USER_ID, '');
          const confirmed = await request(setup, 'POST', '/api/channel-settings/telegram/confirm');
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          assert.equal(confirmed.json().channel.allowedUserId, '123456');
        }
      }
      if (submit)
        assert.equal((await request(setup, 'POST', '/api/desktop/setup/complete')).statusCode, 202);
    }
    return {
      root,
      ownerId,
      keyStore,
      create,
      request,
      complete,
      backend,
      telegramToken,
      channelCalls,
      model: () => model,
      callbacks: () => callbacks,
      interviewCalls: () => interviewCalls,
      finished: () => finished,
      adapterStarts: () => adapterStarts,
      resumed,
      setBusy: (value: typeof busyCheck) => {
        busyCheck = value;
      },
      failTransfer: (value: boolean) => {
        failTransfer = value;
      },
    };
  }

  test('the host setup API enforces desktop authentication and step prerequisites without database services', async (t) => {
    const f = await fixture(t);
    const setup = await f.create();
    assert.equal(
      (await f.request(setup, 'GET', '/api/session', undefined, { 'x-otto-desktop-token': '' }))
        .statusCode,
      401,
    );
    assert.equal(
      (await f.request(setup, 'GET', '/api/session', undefined, { host: 'attacker.invalid' }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await f.request(
          setup,
          'PATCH',
          '/api/account',
          { usageData: true },
          { origin: 'https://attacker.invalid' },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.request(setup, 'GET', '/api/apps/callback?state=bad', undefined, {
          'x-otto-desktop-token': '',
        })
      ).statusCode,
      401,
    );
    assert.equal(f.callbacks(), 0);
    assert.equal((await f.request(setup, 'GET', '/api/session')).json().desktopSetup, true);
    assert.equal((await f.request(setup, 'POST', '/api/desktop/setup/complete')).statusCode, 409);
    assert.equal(
      (await f.request(setup, 'PATCH', '/api/desktop/setup', { step: 'open' })).statusCode,
      409,
    );
    assert.ok(
      (await f.request(setup, 'PATCH', '/api/account', { onboardingCompleted: true })).statusCode >=
        400,
    );
    assert.equal(
      (await f.request(setup, 'GET', '/api/session')).json().settings.onboardingCompleted,
      false,
    );
    await f.complete(setup);
    assert.equal(f.finished(), 1);
    const journalPath = join(f.root, 'onboarding', 'pending');
    const encrypted = await readFile(journalPath, 'utf8');
    assert.ok(!encrypted.includes('fixture-desktop-model-key'));
    assert.ok(!encrypted.includes('fixture project'));
    assert.equal(
      (
        await f.request(setup, 'POST', '/api/models/keys', {
          provider: 'openai',
          key: 'fixture-replacement-key',
        })
      ).statusCode,
      409,
    );
    await setup.app.close();
    const restored = await f.create();
    assert.equal(f.adapterStarts(), 1);
    await restored.resume();
    assert.equal(f.finished(), 2);
    assert.equal((await f.request(restored, 'GET', '/api/desktop/setup')).json().completing, true);
  });

  test('desktop interview resumes cached conversational replies without repeating model requests', async (t) => {
    const f = await fixture(t);
    let setup = await f.create();
    const opening = await f.request(setup, 'POST', '/api/onboarding/interview', { talk: [] });
    assert.equal(opening.statusCode, 200);
    assert.deepEqual(opening.json(), { messages: ['Fixture question?'], done: false });
    await setup.app.close();
    setup = await f.create();
    assert.deepEqual(
      (await f.request(setup, 'POST', '/api/onboarding/interview', { talk: [] })).json(),
      opening.json(),
    );
    assert.equal(f.interviewCalls(), 1);
    const closing = await f.request(setup, 'POST', '/api/onboarding/interview', {
      talk: [
        { from: 'otto', text: 'Fixture question?' },
        { from: 'owner', text: 'A synthetic project' },
      ],
    });
    assert.equal(closing.json().done, true);
    assert.equal(f.interviewCalls(), 2);
    assert.equal(
      (
        await f.request(setup, 'PUT', '/api/onboarding/interview', {
          answers: ['A synthetic project'],
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.request(setup, 'POST', '/api/onboarding/interview', {
          talk: [{ from: 'tool', text: 'Unowned fixture' }],
        })
      ).statusCode,
      400,
    );
    assert.equal(f.interviewCalls(), 2);
  });

  test('completion fences new writes before waiting for an in-flight status check', async (t) => {
    const f = await fixture(t);
    const setup = await f.create();
    await f.complete(setup, false);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.setBusy(async () => {
      entered();
      await barrier;
      return false;
    });
    const finishing = f.request(setup, 'POST', '/api/desktop/setup/complete');
    await waiting;
    const writing = await f.request(setup, 'PATCH', '/api/preferences', { locale: 'pt-PT' });
    release();
    const completed = await finishing;
    assert.equal(writing.statusCode, 409);
    assert.equal(completed.statusCode, 202);
  });

  test('a partial handoff resumes its saved transfer and rejects edits until completion', async (t) => {
    const f = await fixture(t);
    const setup = await f.create();
    await f.complete(setup, false);
    const selected = f.model().view().selection;
    f.failTransfer(true);
    assert.equal((await f.request(setup, 'POST', '/api/desktop/setup/complete')).statusCode, 503);
    assert.equal(
      (
        await f.request(setup, 'POST', '/api/models/keys', {
          provider: 'openai',
          key: 'fixture-late-key',
        })
      ).statusCode,
      409,
    );
    await setup.app.close();
    f.failTransfer(false);
    const resumed = await f.create();
    assert.deepEqual(f.resumed, [false, true]);
    assert.equal(
      (await f.request(resumed, 'PATCH', '/api/preferences', { locale: 'pt-PT' })).statusCode,
      409,
    );
    await resumed.resume();
    assert.equal(f.finished(), 1);
    assert.deepEqual(f.model().view().selection, selected);
    assert.equal((await f.request(resumed, 'GET', '/api/desktop/setup')).json().completing, true);
  });

  test(
    'a committed setup receipt prevents stale profile data restoring removed connections or calling providers again',
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const f = await fixture(t);
      const setup = await f.create();
      await f.complete(setup, true, true);
      const pendingPath = join(f.root, 'onboarding', 'pending');
      const encrypted = await readFile(pendingPath, 'utf8');
      assert.equal(encrypted.includes(f.telegramToken), false);
      assert.equal(encrypted.includes('123456'), false);
      const verifiedChannelCalls = [...f.channelCalls];
      assert.deepEqual(verifiedChannelCalls, ['getMe', 'getWebhookInfo']);
      await setup.app.close();
      const schema = `test_setup_receipt_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const database = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
        max: 2,
      });
      t.after(async () => {
        await database.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      });
      const { createAccountStore } = await import('../src/server/account-store.ts');
      const { createModelService } = await import('../src/server/models.ts');
      const { createPostgresObjectStore } = await import('../src/server/object-storage.ts');
      const { initializeIntegrationSchema } = await import('../src/server/integrations.ts');
      const { importDesktopSetup } = await import('../src/server/setup-import.ts');
      const { openChannelSettings } = await import('../src/server/channel-settings.ts');
      await createAccountStore(database).initialize();
      const models = createModelService({
        database,
        ownerId: f.ownerId,
        keyStore: f.keyStore,
        backend: f.backend,
        origin: 'http://127.0.0.1:4387',
      });
      await models.initialize();
      t.after(() => models.close());
      await createPostgresObjectStore({ database, ownerId: f.ownerId }).initialize();
      await initializeIntegrationSchema(database);
      await database.query(
        `CREATE TABLE integration_keys(owner_id text PRIMARY KEY,vault_id uuid NOT NULL); CREATE TABLE preferences(owner_id text PRIMARY KEY,notification_rule text,time_zone text,quiet_start text,quiet_end text,quiet_hours_enabled boolean,locale text,hour_cycle text)`,
      );
      let calls = 0;
      const provider = new Proxy(
        { id: 'fixture', configurationId: undefined },
        {
          get(target, key) {
            if (key in target) return target[key as keyof typeof target];
            return () => {
              calls++;
              throw new Error('Unexpected provider call');
            };
          },
        },
      ) as unknown as import('../src/ports/integrations.ts').IntegrationProvider;
      const options = {
        root: f.root,
        ownerId: f.ownerId,
        database,
        keyStore: f.keyStore,
        managedProvider: provider,
        ownProvider: provider,
      };
      await database.query(
        `ALTER TABLE preferences ADD CONSTRAINT fixture_failure CHECK (owner_id <> 'fixture-desktop-owner')`,
      );
      await assert.rejects(importDesktopSetup(options));
      for (const table of [
        'model_connections',
        'channel_settings',
        'vault_app_grants',
        'account_settings',
        'private_objects',
        'desktop_setup_receipts',
      ])
        assert.equal(
          (await database.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count,
          0,
        );
      await database.query('ALTER TABLE preferences DROP CONSTRAINT fixture_failure');
      const id = await importDesktopSetup(options);
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM model_connections')).rows[0]
          .count,
        1,
      );
      assert.equal(
        (
          await database.query(
            'SELECT onboarding_completed FROM account_settings WHERE owner_id=$1',
            [f.ownerId],
          )
        ).rows[0].onboarding_completed,
        true,
      );
      const channel = (
        await database.query(
          'SELECT provider,enabled,ciphertext,summary FROM channel_settings WHERE owner_id=$1',
          [f.ownerId],
        )
      ).rows[0];
      assert.equal(channel.provider, 'telegram');
      assert.equal(channel.summary.allowedUserId, '123456');
      assert.equal(JSON.stringify(channel).includes(f.telegramToken), false);
      const environment = openChannelSettings(await f.keyStore.getKey(), f.ownerId, channel);
      assert.equal(environment.TELEGRAM_BOT_TOKEN, f.telegramToken);
      assert.equal(environment.TELEGRAM_ALLOWED_USER_ID, '123456');
      assert.equal(
        Object.keys(environment).some((key) => key.startsWith('TELEGRAM_PAIRING_')),
        false,
      );
      assert.throws(() => openChannelSettings(randomBytes(32), f.ownerId, channel));
      const vaultKey = await f.keyStore.getKey();
      assert.throws(() => openChannelSettings(vaultKey, 'another-owner', channel));
      await database.query('DELETE FROM model_connections');
      await database.query('DELETE FROM channel_settings');
      await database.query('DELETE FROM vault_app_grants');
      assert.equal(await importDesktopSetup(options), id);
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM model_connections')).rows[0]
          .count,
        0,
      );
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM channel_settings')).rows[0].count,
        0,
      );
      assert.equal(calls, 0);
      assert.deepEqual(f.channelCalls, verifiedChannelCalls);
      const resumed = await f.create();
      assert.equal(f.adapterStarts(), 1);
      await resumed.acknowledge(id);
      await assert.rejects(readFile(pendingPath), { code: 'ENOENT' });
      assert.equal((await f.request(resumed, 'GET', '/api/desktop/setup')).json().completed, true);
      assert.deepEqual(f.channelCalls, verifiedChannelCalls);
    },
  );
});
