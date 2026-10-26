import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AccountStore } from '../src/server/account-store.ts';
import type { AccountSettings } from '../src/shared/account.ts';
import { createAccountSession } from '../src/server/account.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import { createFilesystemKeyStore } from '../src/providers/filesystem/key-store.ts';
import { openCredential, sealCredential } from '../src/server/vault.ts';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, type Analytics, type CaptureAnalytics } from '../src/server/analytics.ts';
import { createLedger } from '../src/server/ledger.ts';
import { createModelTraces } from '../src/server/traces.ts';
import type { ModelTrace } from '../src/ports/traces.ts';
import { setRequestAccount } from '../src/web/lib/api.ts';
import { loadLinkPreview } from '../src/web/lib/link-previews.ts';
import { createOtlpTelemetry } from '../src/providers/otlp/telemetry.ts';

test('queued and cached link previews cannot cross an owner change', async (t) => {
  const calls: Array<{ url: string; account: string | null; respond(): void }> = [];
  const requests: ReturnType<typeof loadLinkPreview>[] = [];
  let automatic = false;
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    const url = JSON.parse(String(options.body)).url as string;
    const account = new Headers(options.headers).get('X-nod-Account');
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
    analytics?: Analytics,
    onTraces?: (enabled: boolean) => void,
    key?: string,
    onboardingMissing?: () => Promise<'brain' | 'email' | null>,
  ) {
    let record: AccountSettings = {
      theme: 'system',
      onboardingCompleted: false,
      usageData: false,
      traces: false,
    };
    const calls = { writes: 0, started: 0 };
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
      async start() {
        calls.started++;
      },
      traces: onTraces !== undefined,
      onTraces,
      onboardingMissing,
    }).register(app);
    await app.ready();
    return { app, calls, record: () => record };
  }

  test('first completion requires setup readiness without rechecking a completed profile', async (t) => {
    let ready = false;
    let failed = false;
    let checked = 0;
    const f = await fixture(undefined, undefined, undefined, async () => {
      checked++;
      if (failed) throw new Error('Synthetic provider outage');
      return ready ? null : 'email';
    });
    t.after(() => f.app.close());
    const complete = () =>
      f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { origin },
        payload: { onboardingCompleted: true },
      });
    const refused = await complete();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().step, 'email');
    assert.equal(f.record().onboardingCompleted, false);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
    failed = true;
    assert.equal((await complete()).statusCode, 503);
    assert.equal(f.record().onboardingCompleted, false);
    failed = false;
    ready = true;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(f.record().onboardingCompleted, true);
    const checks = checked;
    ready = false;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(checked, checks);
  });

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
      const f = await fixture(analytics);
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
      assert.equal(f.calls.started, 1);
      analytics.capture('local-owner', { event: 'nod_conversation_reset' });
      assert.equal(captured.length, 0);
      const opted = await request({ usageData: true });
      assert.equal(opted.statusCode, 200);
      assert.equal(opted.json().user.name, 'You');
      assert.equal(opted.json().settings.usageData, true);
      assert.equal(opted.json().analytics.enabled, available);
      assert.equal(f.record().usageData, true);
      await request({ theme: 'dark' });
      analytics.forOwner('local-owner')({ event: 'nod_chat_stopped' });
      assert.deepEqual(
        captured.map((event) => [event.distinctId, event.event]),
        available
          ? [
              [`local:${installationId}`, 'nod_settings_updated'],
              [`local:${installationId}`, 'nod_chat_stopped'],
            ]
          : [],
      );
      const declined = await request({ usageData: false });
      assert.equal(declined.json().analytics.enabled, false);
      analytics.capture('local-owner', { event: 'nod_chat_stopped' });
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
    const f = await fixture(undefined, (enabled) => traces.configure({ enabled }));
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
      { headers: { ...headers, 'x-nod-account': 'sam' }, payload: {}, status: 401 },
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
      [{ 'x-nod-account': 'sam' }, { theme: 'dark' }, 401],
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
      headers: { ...headers, 'x-nod-account': 'local-owner' },
      payload: {},
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
  });
});

describe('analytics privacy', () => {
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
      sent.filter(({ event }) => event === 'nod_website_visited'),
      [{ event: 'nod_website_visited', domain: 'example.co.uk', via: 'browser', subagent: false }],
    );
    const entries = sent.filter(({ event }) => event === 'nod_secure_entry_changed');
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
        ].map((properties) => JSON.stringify({ event: 'nod_secure_entry_changed', ...properties })),
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

  test('agent model usage analytics carry the request duration and cached input', async (t) => {
    const collector = Fastify();
    const spans: any[] = [];
    collector.post('/v1/traces', (request) => {
      spans.push(...(request.body as any).resourceSpans[0].scopeSpans[0].spans);
      return {};
    });
    const telemetry = createOtlpTelemetry(await collector.listen({ host: '127.0.0.1', port: 0 }))!;
    t.after(() => collector.close());
    t.after(() => telemetry.shutdown());
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
      telemetry,
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
    const used = captured.find((event) => event.event === 'nod_model_used')!;
    assert.equal(used.properties.input_tokens, 2020);
    assert.equal(used.properties.cached_input_tokens, 2000);
    assert.ok(Number(used.properties.duration_ms) >= 1_500);
    analytics.setUsageData('owner-fixture', false);
    await opened.prompt('Synthetic private content', []);
    await telemetry.shutdown();
    assert.equal(spans.length, 2);
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.equal(captured.filter((event) => event.event === 'nod_model_used').length, 1);
  });
});

describe('keychain', () => {
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
  test('concurrent instances publish one private key and decrypt after restart', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-key-'));
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
});

test('server model credentials reject invalid destinations and cloud accounts before startup', async () => {
  const { modelEnvironment } = await import('../src/server/composition.ts');
  const key = 'fixture-environment-key';
  const invalid: Record<string, string>[] = [
    { AWS_BEARER_TOKEN_BEDROCK: key },
    { AWS_BEARER_TOKEN_BEDROCK: key, AWS_REGION: 'eu-west-1.example.test/path' },
    { AZURE_OPENAI_API_KEY: key },
    { AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test' },
    ...[
      'http://fixture.example.test',
      'https://user:secret@fixture.example.test',
      'https://fixture.example.test?key=other',
    ].map((endpoint) => ({
      AZURE_OPENAI_API_KEY: key,
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
    })),
    {
      AZURE_OPENAI_API_KEY: key,
      AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test',
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
      AZURE_OPENAI_DEPLOYMENT: '../other-deployment',
    },
    { CLOUDFLARE_WORKERS_AI_API_KEY: key },
    { CLOUDFLARE_WORKERS_AI_API_KEY: key, CLOUDFLARE_ACCOUNT_ID: '../other-account' },
    { CLOUDFLARE_AI_GATEWAY_API_KEY: key, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) },
    {
      CLOUDFLARE_AI_GATEWAY_API_KEY: key,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_GATEWAY_ID: '../other-gateway',
    },
    { OPENAI_COMPATIBLE_BASE_URL: 'https://user:secret@fixture.example.test/v1' },
    { OPENAI_COMPATIBLE_BASE_URL: 'https://fixture.example.test/v1?key=other' },
  ];
  for (const environment of invalid)
    assert.throws(
      () => modelEnvironment(environment),
      (error: unknown) => error instanceof Error && !error.message.includes(key),
    );
  assert.deepEqual(
    modelEnvironment({
      OPENAI_API_KEY: ' ',
      HF_TOKEN: '\t',
      AWS_BEARER_TOKEN_BEDROCK: '',
      AWS_REGION: '../unused',
      OPENAI_COMPATIBLE_API_KEY: key,
    }).credentials,
    {},
  );
  assert.deepEqual(
    modelEnvironment({
      LLM_PROVIDER: 'compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.5:8080/v1/',
      OPENAI_COMPATIBLE_API_KEY: key,
    }).credentials.compatible,
    { type: 'endpoint', url: 'http://192.168.1.5:8080/v1', key },
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
    return { create, database, backend, keyStore };
  }

  function subscriptionCredential(expires = Date.now() + 3600000) {
    return {
      type: 'oauth' as const,
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires,
      accountId: 'fixture-account',
      clientId: 'fixture-client',
      idToken: 'fixture-id-token',
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

  test('ElevenLabs keys stay encrypted and owned without becoming a selectable chat model', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const { modelEnvironment } = await import('../src/server/composition.ts');
    const secret = 'fixture-elevenlabs-owned-secret';
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.elevenlabs.io') {
          assert.equal(new Headers(init?.headers).get('xi-api-key'), secret);
          return Response.json({
            voices: [{ voice_id: 'fixture_custom_voice', name: 'Synthetic custom voice' }],
            has_more: false,
          });
        }
        assert.equal(url.href, 'https://api.openai.com/v1/models');
        return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
      },
    });
    const owner = await f.create('fixture-speech-owner', backend);
    const speechId = await owner.addKey('elevenlabs', secret);
    assert.equal(owner.hasApiKey('elevenlabs'), true);
    assert.equal(await owner.apiKey('elevenlabs'), secret);
    assert.equal(owner.configured, false);
    assert.equal(owner.current.configured, false);
    assert.equal(owner.view().selection, null);
    assert.deepEqual(owner.view().connections[0].models, []);
    assert.deepEqual(owner.analyticsConnections(), []);
    await assert.rejects(owner.resolve());
    await assert.rejects(
      owner.select({ connectionId: speechId, modelId: 'eleven_v4', effort: 'off' }),
    );
    assert.doesNotMatch(JSON.stringify(owner.view()), /fixture-elevenlabs-owned-secret/);
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM model_connections')).rows),
      /fixture-elevenlabs-owned-secret/,
    );
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM vault_app_grants')).rows),
      /fixture-elevenlabs-owned-secret/,
    );
    const other = await f.create('fixture-other-speech-owner', backend);
    assert.equal(await other.apiKey('elevenlabs'), undefined);
    await other.remove(speechId);
    assert.equal(await owner.apiKey('elevenlabs'), secret);
    const chatId = await owner.addKey('openai', 'fixture-openai-key');
    const selected = owner.view().selection;
    assert.equal(selected?.connectionId, chatId);
    await owner.refreshCatalog(speechId);
    assert.deepEqual(owner.view().selection, selected);
    assert.equal(owner.configured, true);
    const reloaded = await f.create('fixture-speech-owner', backend);
    assert.equal(await reloaded.apiKey('elevenlabs'), secret);
    assert.deepEqual(reloaded.view().selection, selected);
    await reloaded.remove(speechId);
    assert.equal(await reloaded.apiKey('elevenlabs'), undefined);
    assert.deepEqual(reloaded.view().selection, selected);
    assert.throws(() => modelEnvironment({ LLM_PROVIDER: 'elevenlabs' }));
    const managed = await f.create(
      'fixture-managed-speech-owner',
      backend,
      modelEnvironment({ ELEVENLABS_API_KEY: secret }),
    );
    assert.equal(managed.hasApiKey('elevenlabs'), true);
    assert.equal(managed.view().connections[0].managed, true);
    assert.equal(managed.configured, false);
    assert.equal(managed.view().selection, null);
  });

  test('every environment model connection resolves only its managed credential and loses access after removal', async (t) => {
    const f = await fixture(t);
    const { modelEnvironment } = await import('../src/server/composition.ts');
    const { apiKeyModelProviders, modelProviderInfo } = await import('../src/shared/models.ts');
    const environment = {
      ...Object.fromEntries(
        apiKeyModelProviders.map((provider) => [
          modelProviderInfo[provider].env,
          `  fixture-environment-${provider}-key  `,
        ]),
      ),
      AWS_REGION: 'eu-west-1',
      AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test',
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
      AZURE_OPENAI_DEPLOYMENT: 'fixture-deployment',
      CLOUDFLARE_ACCOUNT_ID: 'ABCDEF0123456789ABCDEF0123456789',
      CLOUDFLARE_GATEWAY_ID: 'fixture-gateway',
    };
    const backend = {
      ...f.backend,
      catalog: (provider: import('../src/shared/models.ts').ModelProvider) =>
        f.backend.catalog(provider, 'api_key'),
    };
    const owner = await f.create(
      'fixture-environment-owner',
      backend,
      modelEnvironment(environment),
    );
    const captured: import('../src/ports/models.ts').ModelAccess[] = [];
    assert.equal(owner.view().connections.length, apiKeyModelProviders.length);
    assert.equal((await owner.resolve()).provider, 'openai');
    for (const provider of apiKeyModelProviders) {
      const row = owner.view().connections.find((item) => item.provider === provider)!;
      assert.equal(row.managed, true, provider);
      assert.equal(row.status, 'connected', provider);
      const choice = row.models[0];
      await owner.select({ connectionId: row.id, modelId: choice.id, effort: choice.efforts[0] });
      const access = await owner.resolve();
      captured.push(access);
      const credential = await access.read();
      const key = `fixture-environment-${provider}-key`;
      assert.equal(access.provider, provider);
      assert.deepEqual(
        credential,
        provider === 'amazon-bedrock'
          ? { type: 'bedrock', key, region: 'eu-west-1' }
          : provider === 'azure'
            ? {
                type: 'azure',
                key,
                url: 'https://fixture.example.test/openai/v1',
                model: 'gpt-6.1-sol',
                deployment: 'fixture-deployment',
              }
            : provider.startsWith('cloudflare-')
              ? {
                  type: 'cloudflare',
                  key,
                  accountId: 'abcdef0123456789abcdef0123456789',
                  ...(provider === 'cloudflare-ai-gateway' ? { gatewayId: 'fixture-gateway' } : {}),
                }
              : { type: 'api_key', key },
      );
    }
    assert.doesNotMatch(JSON.stringify(owner.view()), /fixture-environment-/);
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM model_connections')).rows),
      /fixture-environment-.*-key/,
    );
    assert.equal((await f.database.query('SELECT * FROM vault_app_grants')).rowCount, 0);
    const removed = await f.create('fixture-environment-owner', backend, modelEnvironment({}));
    assert.deepEqual(removed.view(), { connections: [], selection: null });
    await assert.rejects(removed.resolve());
    for (const access of captured) assert.equal(await access.read(), undefined);
  });

  test('model setup chooses capable defaults, preserves explicit choices and requires valid cloud accounts', async (t) => {
    const f = await fixture(t);
    const backend = {
      ...f.backend,
      catalog: (provider: import('../src/shared/models.ts').ModelProvider) =>
        f.backend.catalog(provider, 'api_key'),
    };
    const google = await f.create('fixture-google-default', backend);
    await google.addKey('google', 'fixture-google-key');
    assert.equal(google.view().selection?.modelId, 'gemini-3.8-flash');
    assert.equal(google.view().selection?.effort, 'medium');
    const chosen = google.view().selection!;
    await google.addKey('mistral', 'fixture-mistral-key');
    assert.deepEqual(google.view().selection, chosen);
    const paidGoogle = await f.create('fixture-google-paid-choice', {
      ...backend,
      catalog: async () =>
        (await backend.catalog('google')).filter(
          (definition) => definition.choice.id === 'gemini-4-argon',
        ),
    });
    const paidConnection = await paidGoogle.addKey('google', 'fixture-google-paid-key');
    assert.equal(paidGoogle.view().selection, null);
    assert.equal(paidGoogle.configured, false);
    await paidGoogle.select({
      connectionId: paidConnection,
      modelId: 'gemini-4-argon',
      effort: 'medium',
    });
    assert.equal(paidGoogle.configured, true);
    assert.equal((await paidGoogle.resolve()).definition.choice.id, 'gemini-4-argon');
    const bedrock = await f.create('fixture-bedrock-default', backend);
    await bedrock.addKey('amazon-bedrock', 'fixture-bedrock-key', { region: 'eu-west-1' });
    assert.equal(bedrock.view().selection, null);
    const explicit = await f.create('fixture-explicit-default', backend, {
      provider: 'google',
      model: 'fixture-unavailable-model',
      credentials: { google: { type: 'api_key', key: 'fixture-managed-key' } },
    });
    assert.equal(explicit.configured, false);
    assert.equal(explicit.view().selection, null);
    const fallbackBackend = {
      ...backend,
      catalog: async () =>
        [
          {
            choice: {
              id: 'fixture-small',
              name: 'Small',
              efforts: ['off'] as const,
              images: false,
              contextWindow: 8000,
            },
            spec: {},
          },
          {
            choice: {
              id: 'fixture-capable',
              name: 'Capable',
              efforts: ['low', 'high'] as const,
              images: true,
              contextWindow: 262144,
            },
            spec: {},
          },
        ].map((definition) => ({
          ...definition,
          choice: { ...definition.choice, efforts: [...definition.choice.efforts] },
        })),
    };
    const fallback = await f.create('fixture-fallback-default', fallbackBackend);
    await fallback.addKey('deepseek', 'fixture-fallback-key');
    assert.equal(fallback.view().selection?.modelId, 'fixture-small');
    assert.equal(fallback.view().selection?.effort, 'off');
    const subscription = await f.create('fixture-subscription-default', {
      ...backend,
      signIn: stubSignIn(async () => subscriptionCredential()),
    });
    const signIn = await subscription.start('openai');
    await subscription.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${signIn.attempt}&code=fixture`),
    );
    assert.equal(subscription.view().selection?.modelId, 'gpt-6-sol');
    const count = google.view().connections.length;
    for (const settings of [
      {},
      { accountId: 'not-an-account', gatewayId: 'fixture-gateway' },
      { accountId: '0123456789abcdef0123456789abcdef' },
      { accountId: '0123456789abcdef0123456789abcdef', gatewayId: '../other-gateway' },
    ])
      await assert.rejects(
        google.addKey('cloudflare-ai-gateway', 'fixture-rejected-key', settings),
      );
    assert.equal(google.view().connections.length, count);
  });

  test('image fallback uses owned connected models without changing the chat selection and reads current credentials', async (t) => {
    const f = await fixture(t);
    const backend = {
      ...f.backend,
      catalog: async (
        provider: import('../src/shared/models.ts').ModelProvider,
        method: import('../src/shared/models.ts').ModelMethod,
        credential?: import('../src/ports/models.ts').ModelCredential,
      ) => {
        const definitions = await f.backend.catalog('openai', method, credential);
        return definitions.map((definition) => ({
          ...definition,
          choice: {
            ...definition.choice,
            images: credential?.type === 'api_key' && credential.key === 'fixture-vision',
          },
        }));
      },
    };
    const owner = await f.create('fixture-images', backend);
    const other = await f.create('fixture-images-other', backend);
    await other.addKey('openai', 'fixture-vision');
    const textId = await owner.addKey('openai', 'fixture-text');
    const selection = owner.view().selection!;
    assert.equal(owner.hasImageModel(), false);
    await assert.rejects(owner.resolveImage(), /Connect a model that accepts images/);
    const visionId = await owner.addKey('openai', 'fixture-vision');
    await owner.select({ ...selection, connectionId: textId });
    assert.equal(owner.hasImageModel(), true);
    const access = await owner.resolveImage();
    assert.equal(access.definition.choice.images, true);
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-vision' });
    assert.deepEqual(owner.view().selection, { ...selection, connectionId: textId });
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-images',
      keyStore: f.keyStore,
    });
    await store.initialize();
    await store.change((state) => {
      state.connections.find((row) => row.id === visionId)!.credential = {
        type: 'api_key',
        key: 'fixture-updated',
      };
    });
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-updated' });
    await owner.remove(visionId);
    assert.equal(await access.read(), undefined);
    assert.equal(owner.hasImageModel(), false);
    assert.equal((await owner.resolve()).definition.choice.images, false);
  });

  test('audio models pair with text support from the same owned connection without changing selection', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    let pairedModels = ['gpt-audio-1.5', 'gpt-6-luna', 'gpt-6.1-sol'];
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.openai.com/v1/models');
        const key = new Headers(init?.headers).get('authorization');
        const ids = key === 'Bearer fixture-audio-only' ? ['gpt-audio-1.5'] : pairedModels;
        return Response.json({ data: ids.map((id) => ({ id })) });
      },
    });
    const owner = await f.create('fixture-audio-pair', backend);
    const other = await f.create('fixture-audio-pair-other', backend);
    await other.addKey('openai', 'fixture-other-text');
    const audioOnly = await owner.addKey('openai', 'fixture-audio-only');
    const unavailable = {
      connectionId: audioOnly,
      modelId: 'gpt-audio-1.5',
      effort: 'off' as const,
    };
    assert.equal(owner.configured, false);
    await assert.rejects(owner.select(unavailable), /text model/i);
    await assert.rejects(owner.resolve(), /text model/i);
    assert.equal(owner.view().connections[0].models[0].textModelName, undefined);
    const paired = await owner.addKey('openai', 'fixture-paired-text');
    const selected = { ...unavailable, connectionId: paired };
    await owner.select(selected);
    assert.equal(owner.configured, true);
    const access = await owner.resolve();
    assert.equal(access.definition.choice.id, 'gpt-audio-1.5');
    assert.equal(access.textModel?.definition.choice.id, 'gpt-6.1-sol');
    assert.ok(access.textModel);
    assert.ok(access.textModel.definition.choice.efforts.includes(access.textModel.effort));
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-paired-text' });
    const listed = owner.view().connections.find((row) => row.id === paired)!;
    assert.equal(
      listed.models.find((model) => model.audio)?.textModelName,
      access.textModel.definition.choice.name,
    );
    assert.equal(JSON.stringify(owner.view()).includes('fixture-paired-text'), false);
    assert.equal((await owner.resolve(true)).definition.choice.id, 'gpt-6-luna');
    assert.deepEqual(owner.view().selection, selected);
    pairedModels = ['gpt-audio-1.5', 'gpt-6.1-sol'];
    await owner.refreshCatalog(paired);
    const auxiliary = await owner.resolve(true);
    assert.equal(auxiliary.definition.choice.id, 'gpt-audio-1.5');
    assert.equal(auxiliary.textModel?.definition.choice.id, 'gpt-6.1-sol');
    pairedModels = ['gpt-audio-1.5', 'gpt-6-luna'];
    await owner.refreshCatalog(paired);
    assert.equal((await owner.resolve()).textModel?.definition.choice.id, 'gpt-6-luna');
    pairedModels = ['gpt-audio-1.5', 'gpt-4.1', 'gpt-6-luna'];
    await owner.refreshCatalog(paired);
    assert.equal((await owner.resolve()).textModel?.definition.choice.id, 'gpt-4.1');
    pairedModels = ['gpt-audio-1.5'];
    await owner.refreshCatalog(paired);
    assert.equal(owner.configured, false);
    await assert.rejects(owner.resolve(), /text model/i);
    await assert.rejects(owner.resolve(true), /text model/i);
    await assert.rejects(owner.select(unavailable), /text model/i);
    assert.deepEqual(owner.view().selection, selected);
  });

  test('model connections verify credential storage before opening sign-in or calling a provider', async (t) => {
    const f = await fixture(t);
    const { createEnvironmentKeyStore } = await import('../src/providers/environment/key-store.ts');
    const invalidKey = 'a'.repeat(64);
    Object.assign(f.keyStore, createEnvironmentKeyStore(invalidKey));
    const calls = { signIn: 0, authorize: 0, catalog: 0 };
    let rejectSignIn = false;
    const signIn = stubSignIn(async () => {
      if (rejectSignIn) throw new Error('Synthetic sign-in failure');
      return subscriptionCredential();
    });
    const owner = await f.create('fixture-owner', {
      ...f.backend,
      signIn(input) {
        calls.signIn++;
        return signIn(input);
      },
      authorize(input) {
        calls.authorize++;
        return f.backend.authorize(input);
      },
      catalog(provider, method) {
        calls.catalog++;
        return f.backend.catalog(provider, method);
      },
    });
    const app = Fastify();
    const captured: Parameters<CaptureAnalytics>[0][] = [];
    owner.register(app, (event) => captured.push(event));
    t.after(() => app.close());
    for (const [url, payload] of [
      ['/api/models/oauth', { provider: 'openai' }],
      ['/api/models/oauth', { provider: 'openrouter' }],
      ['/api/models/keys', { provider: 'openai', key: 'fixture-provider-key' }],
      ['/api/models/endpoints', { url: 'http://localhost:11434/v1' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(invalidKey));
      assert.deepEqual(calls, { signIn: 0, authorize: 0, catalog: 0 });
    }
    const failures = [
      { provider: 'openai', method: 'subscription' },
      { provider: 'openrouter', method: 'oauth' },
      { provider: 'openai', method: 'api_key' },
      { provider: 'compatible', method: 'api_key' },
    ].map((properties) => ({
      event: 'nod_model_connection_changed',
      properties: { ...properties, status: 'failed' },
    }));
    assert.deepEqual(captured, failures);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    Object.assign(f.keyStore, createEnvironmentKeyStore(Buffer.alloc(32, 77).toString('base64')));
    const started = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(started.statusCode, 200);
    const { attempt } = started.json();
    const completed = await app.inject({
      method: 'POST',
      url: '/api/models/oauth/complete',
      payload: {
        url: `http://127.0.0.1:1455/auth/callback?state=${attempt}&code=fixture`,
      },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(owner.signInStatus(attempt), { status: 'connected' });
    assert.deepEqual(calls, { signIn: 1, authorize: 0, catalog: 1 });
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 1);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 1);
    assert.equal((await (await owner.resolve()).read())?.type, 'oauth');
    assert.ok(!JSON.stringify(owner.view()).includes('fixture-access'));
    assert.deepEqual(captured, [
      ...failures,
      {
        event: 'nod_model_connection_changed',
        properties: { provider: 'openai', method: 'subscription', status: 'connected' },
      },
    ]);
    rejectSignIn = true;
    const next = await owner.start('openai');
    await assert.rejects(
      owner.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${next.attempt}&code=fixture`),
      ),
    );
    assert.deepEqual(captured.slice(failures.length + 1), [failures[0]]);
    assert.deepEqual(calls, { signIn: 2, authorize: 0, catalog: 1 });
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
          event: 'nod_model_connection_changed',
          provider: 'compatible',
          method: 'api_key',
          status: 'connected',
        },
        {
          event: 'nod_model_connection_observed',
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
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
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

  test('server-managed model keys rotate privately and disappear when removed without changing other connections', async (t) => {
    for (const selected of ['managed', 'saved'] as const) {
      await t.test(selected, async (t) => {
        const f = await fixture(t);
        const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
        const backend = createPiModelBackend({
          fetch: async (input) => {
            if (String(input) === 'https://api.anthropic.com/v1/models?limit=1000')
              return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
            assert.equal(String(input), 'https://api.openai.com/v1/models');
            return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({ id })) });
          },
        });
        const originalKey = 'fixture-managed-original-key';
        const rotatedKey = 'fixture-managed-rotated-key';
        const savedKey = 'fixture-saved-key';
        const otherKey = 'fixture-other-owner-key';
        const replacementKey = 'fixture-anthropic-key';
        const bootstrap = (key: string) => ({
          provider: 'openai' as const,
          credentials: { openai: { type: 'api_key' as const, key } },
        });
        const original = await f.create('fixture-owner', backend, bootstrap(originalKey));
        const managed = original.view().connections[0];
        const initialSelection = original.view().selection;
        assert.equal(managed.managed, true);
        assert.equal(initialSelection?.connectionId, managed.id);
        const savedId = await original.addKey('openai', savedKey);
        const other = await f.create('fixture-other', backend);
        await other.addKey('openai', otherKey);
        const otherView = other.view();
        await other.close();
        await original.close();

        const rotated = await f.create('fixture-owner', backend, bootstrap(rotatedKey));
        assert.equal(rotated.view().connections.find((row) => row.managed)?.id, managed.id);
        assert.deepEqual(rotated.view().selection, initialSelection);
        assert.deepEqual(await (await rotated.resolve()).read(), {
          type: 'api_key',
          key: rotatedKey,
        });
        const saved = rotated.view().connections.find((row) => row.id === savedId)!;
        const choice = saved.models.find((model) => model.id === 'gpt-6-luna')!;
        const savedSelection = {
          connectionId: savedId,
          modelId: choice.id,
          effort: choice.efforts[0],
        };
        if (selected === 'saved') await rotated.select(savedSelection);
        const visible = JSON.stringify([original.view(), rotated.view(), otherView]);
        const stored = JSON.stringify([
          (await f.database.query('SELECT * FROM model_connections')).rows,
          (await f.database.query('SELECT * FROM vault_app_grants')).rows,
        ]);
        for (const key of [originalKey, rotatedKey, savedKey, otherKey]) {
          assert.ok(!visible.includes(key));
          assert.ok(!stored.includes(key));
        }
        assert.equal(
          (await f.database.query('SELECT id FROM vault_app_grants WHERE id=$1', [managed.id]))
            .rowCount,
          0,
        );
        await rotated.close();

        const removed = await f.create('fixture-owner', backend, {
          provider: 'anthropic',
          credentials: { anthropic: { type: 'api_key', key: replacementKey } },
        });
        assert.equal(
          removed.view().connections.some((row) => row.id === managed.id),
          false,
        );
        assert.equal(
          (await f.database.query('SELECT id FROM model_connections WHERE id=$1', [managed.id]))
            .rowCount,
          0,
        );
        assert.deepEqual(
          removed.view().connections.find((row) => row.id === savedId),
          saved,
        );
        assert.ok(removed.view().connections.some((row) => row.provider === 'anthropic'));
        if (selected === 'saved') {
          assert.deepEqual(removed.view().selection, savedSelection);
          assert.deepEqual(await (await removed.resolve()).read(), {
            type: 'api_key',
            key: savedKey,
          });
        } else {
          assert.equal(removed.view().selection, null);
          assert.equal(removed.configured, false);
          await assert.rejects(removed.resolve());
        }
        const unchanged = await f.create('fixture-other', backend);
        assert.deepEqual(unchanged.view(), otherView);
        assert.deepEqual(await (await unchanged.resolve()).read(), {
          type: 'api_key',
          key: otherKey,
        });
      });
    }
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
          clientId: 'fixture-client',
          idToken: 'fixture-id-token',
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
    assert.equal(restored.hasApiKey('openai'), false);
    assert.equal(await restored.apiKey('openai'), undefined);
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
        exchanges++;
        return { type: 'api_key' as const, key: 'fixture-openrouter-key' };
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
    assert.equal(slow.hasApiKey('openrouter'), true);
    assert.equal(await slow.apiKey('openrouter'), 'fixture-openrouter-key');
    assert.equal(slow.hasApiKey('openai'), false);
    const routerId = slow.view().connections[0].id;
    await slow.remove(routerId);
    assert.equal(slow.hasApiKey('openrouter'), false);
    assert.equal(await slow.apiKey('openrouter'), undefined);
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

  test('each account is one connection: an unusable one shows on its row, signing in again repairs it, and what the owner adds next takes over', async (t) => {
    const f = await fixture(t);
    const { createPiModelRuntime } = await import('../src/providers/pi/models.ts');
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const { ModelAuthError } = await import('../src/ports/models.ts');
    let account = 'fixture-account';
    let down = false;
    let revoked = false;
    let hidden: string | undefined;
    let held: { access: string; entered(): void; release: Promise<void> } | undefined;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => ({
        ...subscriptionCredential(),
        access: `fixture-access-${randomUUID()}`,
        accountId: account,
        email: `${account}@example.test`,
      })),
      catalog: async (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
        credential?: Parameters<typeof f.backend.catalog>[2],
      ) => {
        if (credential?.type === 'oauth' && credential.access === held?.access) {
          held.entered();
          await held.release;
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        }
        if (down) throw new Error('fixture-catalog-outage');
        if (revoked && method === 'subscription')
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        return f.backend
          .catalog(provider, method, method === 'api_key' ? credential : undefined)
          .then((definitions) => definitions.filter(({ choice }) => choice.id !== hidden));
      },
    };
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
    });
    await store.initialize();
    const grants = async () =>
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count;
    async function signIn(service: Awaited<ReturnType<typeof f.create>>) {
      const started = await service.start('openai');
      await service.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
      );
    }
    const owner = await f.create('fixture-owner', backend);
    await signIn(owner);
    const [chatgpt] = owner.view().connections;
    const selection = owner.view().selection!;
    assert.equal(selection.connectionId, chatgpt.id);
    await signIn(owner);
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(owner.view().selection, selection);
    down = true;
    await signIn(owner);
    down = false;
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.equal(owner.configured, true);
    assert.equal(await grants(), 1);

    await store.change((state) => {
      for (const model of state.connections[0].models)
        model.spec.baseUrl = 'https://chatgpt.com/backend-api';
    });
    const restarted = await f.create('fixture-owner', backend);
    const stale = await restarted.resolve();
    await assert.rejects(
      createPiModelRuntime(stale),
      /Reconnect your ChatGPT account in Settings > Models/,
    );
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    assert.equal(restarted.configured, false);
    await assert.rejects(
      restarted.resolve(),
      /Reconnect the ChatGPT plan connection in Settings > Models/,
    );

    await signIn(restarted);
    assert.deepEqual(
      restarted.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(restarted.view().selection, selection);
    await createPiModelRuntime(await restarted.resolve());
    await stale.needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'connected');

    await (
      await restarted.resolve()
    ).needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    const key = await restarted.addKey('openai', 'fixture-api-1111');
    assert.equal(restarted.view().selection?.connectionId, key);
    assert.equal(restarted.configured, true);
    assert.equal(await restarted.addKey('openai', 'fixture-api-1111'), key);
    assert.equal(restarted.view().connections.length, 2);
    const chosen = restarted.view().selection!;
    hidden = chosen.modelId;
    await restarted.refreshCatalog(key);
    hidden = undefined;
    assert.deepEqual(restarted.view().selection, chosen);
    assert.equal(restarted.configured, false);
    await assert.rejects(restarted.resolve(), /selected model is unavailable/);
    await restarted.refreshCatalog(key);
    assert.equal(restarted.configured, true);

    await store.change((state) => {
      const [original] = state.connections;
      const copies = [randomUUID(), randomUUID()].map((id) => ({
        ...structuredClone(original),
        id,
        status: 'connected' as const,
      }));
      state.connections.push(...copies);
      state.selection = { ...selection, connectionId: copies[1].id };
    });
    const duplicated = await f.create('fixture-owner', backend);
    assert.equal(duplicated.view().connections.length, 4);
    await signIn(duplicated);
    assert.deepEqual(
      duplicated.view().connections.map(({ id, status }) => ({ id, status })),
      [
        { id: chatgpt.id, status: 'connected' },
        { id: key, status: 'connected' },
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(duplicated.configured, true);
    assert.equal(await grants(), 2);

    account = 'fixture-second-account';
    await signIn(duplicated);
    await signIn(duplicated);
    const work = await duplicated.addKey('openai', 'fixture-api-2222');
    assert.deepEqual(
      duplicated.view().connections.map(({ label, keyEnding }) => [label, keyEnding]),
      [
        ['fixture-account@example.test', undefined],
        ['OpenAI API', '1111'],
        ['fixture-second-account@example.test', undefined],
        ['OpenAI API', '2222'],
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    await duplicated.remove(work);
    assert.equal(duplicated.view().connections.length, 3);
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(await grants(), 3);

    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    held = {
      access: ((await (await duplicated.resolve()).read()) as { access: string }).access,
      entered,
      release: new Promise((resolve) => (release = resolve)),
    };
    const racing = duplicated.refreshCatalog(chatgpt.id);
    await reached;
    account = 'fixture-account';
    await signIn(duplicated);
    release();
    await assert.rejects(racing, /Reconnect/);
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'connected',
    );

    revoked = true;
    await assert.rejects(duplicated.refreshCatalog(chatgpt.id), /Reconnect/);
    revoked = false;
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'reconnect',
    );
    assert.equal(duplicated.configured, false);
  });
});

test('feedback activity keeps only bounded technical facts, expires locally and clears on owner changes', async (t) => {
  const { createFeedbackActivity, parseFeedbackActivity } =
    await import('../src/shared/feedback-activity.ts');
  const { feedbackActivity, feedbackActivitySnapshot } =
    await import('../src/web/lib/feedback-activity.ts');
  const { api } = await import('../src/web/lib/api.ts');
  const { captureAnalytics, capturePageview } = await import('../src/web/lib/analytics.ts');
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const history = createFeedbackActivity('runtime');
  const privateValue = 'A private person and their confidential project';
  history.record('nod_connection_changed', {
    app: 'gmail',
    connection_method: 'managed_app',
    status: 'failed',
    failure_reason: 'authentication',
    domain: privateValue,
    account: privateValue,
  });
  history.record('nod_service_used', {
    app: privateValue,
    connection_method: 'mcp',
    outcome: 'failed',
    duration_ms: 12,
    error: privateValue,
  });
  history.record(privateValue, { status: 'failed' });
  assert.deepEqual(
    history.snapshot().map((row) => row.properties),
    [
      {
        app: 'gmail',
        connection_method: 'managed_app',
        status: 'failed',
        failure_reason: 'authentication',
      },
      { app: 'custom', connection_method: 'mcp', outcome: 'failed', duration_ms: 12 },
    ],
  );
  assert.ok(!JSON.stringify(history.snapshot()).includes(privateValue));
  assert.deepEqual(
    parseFeedbackActivity([
      { source: 'app', ageMs: 0, event: '__proto__', properties: { status: privateValue } },
    ]),
    [],
  );
  t.mock.timers.tick(1_800_001);
  assert.deepEqual(history.snapshot(), []);
  for (let index = 0; index < 110; index++)
    history.record('request_failed', {
      area: 'chat',
      method: 'POST',
      status: 500,
      reason: 'http',
      path: privateValue,
    });
  assert.equal(history.snapshot().length, 100);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ error: privateValue }, { status: 503 });
  });
  setRequestAccount('diagnostic-owner-one');
  t.after(() => setRequestAccount(null));
  capturePageview('/vault/private-person?secret=private');
  captureAnalytics('nod_ui_error', { area: 'chat', action: 'send' });
  assert.equal(requests, 0);
  await assert.rejects(api('/api/apps/private-account?secret=private'), /private person/);
  for (let index = 0; index < 110; index++)
    capturePageview(`/vault/private-person-${index}?secret=private`);
  assert.deepEqual(
    feedbackActivitySnapshot().map((row) => row.properties),
    [
      { screen: '/credentials' },
      { area: 'chat', action: 'send' },
      { area: 'apps', method: 'GET', status: 503, reason: 'http' },
    ],
  );
  assert.ok(!JSON.stringify(feedbackActivitySnapshot()).includes('private'));
  capturePageview('/apps');
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().filter((row) => row.event === 'screen').length, 3);
  t.mock.timers.tick(1_800_001);
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().filter((row) => row.event === 'screen').length, 1);
  setRequestAccount('diagnostic-owner-two');
  assert.deepEqual(feedbackActivitySnapshot(), []);
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().length, 1);
  feedbackActivity.clear();
  for (const [path, area] of [
    ['/api/thread/stop', 'chat'],
    ['/api/browser-handoff/private-session/complete', 'browser'],
    ['/api/channel-settings/private-channel', 'channels'],
    ['/api/schedule-runs?limit=20', 'tasks'],
    ['/api/credential-requests/private-request', 'vault'],
    ['/api/payment-requests/private-request', 'vault'],
  ]) {
    await assert.rejects(api(path, { method: 'POST' }), /private person/);
    assert.deepEqual(feedbackActivitySnapshot().at(-1)?.properties, {
      area,
      method: 'POST',
      status: 503,
      reason: 'http',
    });
  }
  assert.ok(!JSON.stringify(feedbackActivitySnapshot()).includes('private'));
  feedbackActivity.clear();
  t.mock.method(
    globalThis,
    'fetch',
    async (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
          once: true,
        }),
      ),
  );
  const timeout = new AbortController();
  const timedRequest = api('/api/channels/private-recipient', { signal: timeout.signal });
  timeout.abort(new DOMException(privateValue, 'TimeoutError'));
  await assert.rejects(timedRequest, { name: 'TimeoutError' });
  assert.deepEqual(
    feedbackActivitySnapshot().map((row) => row.properties),
    [{ area: 'channels', method: 'GET', status: 0, reason: 'timeout' }],
  );
  for (const changedOwner of [false, true]) {
    const cancellation = new AbortController();
    const cancelledRequest = api('/api/channels/private-recipient', {
      signal: cancellation.signal,
    });
    if (changedOwner) setRequestAccount('diagnostic-owner-three');
    else cancellation.abort();
    await assert.rejects(cancelledRequest, { name: 'AbortError' });
    assert.equal(feedbackActivitySnapshot().length, changedOwner ? 0 : 1);
  }
  feedbackActivity.record('nod_ui_error', { area: 'settings', action: 'load' });
  setRequestAccount(null);
  assert.deepEqual(feedbackActivitySnapshot(), []);
  for (const path of ['/api/session', '/api/access']) {
    let respond: (response: Response) => void = () => {};
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Promise<Response>((resolve) => (respond = resolve)),
    );
    setRequestAccount('diagnostic-owner-one');
    const staleRequest = api(path);
    setRequestAccount('diagnostic-owner-two');
    respond(Response.json({ error: privateValue }, { status: 503 }));
    await assert.rejects(staleRequest, /private person/);
    assert.deepEqual(feedbackActivitySnapshot(), []);
  }
});
