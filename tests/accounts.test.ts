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
import { createDecisionModel, type DecisionConnection } from '../src/providers/decisions.ts';
import { createMailCheck } from '../src/server/mail-check.ts';
import type { DecisionBatchRequest, DecisionQuestion } from '../src/ports/decisions.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { createModelTraces } from '../src/server/traces.ts';
import type { ModelTrace } from '../src/ports/traces.ts';
import { setRequestAccount } from '../src/web/lib/api.ts';
import { loadLinkPreview } from '../src/web/lib/link-previews.ts';
import { createOtlpTelemetry } from '../src/providers/otlp/telemetry.ts';

test('unavailable decisions avoid ledger reads and retain dynamic availability and spending limits', async () => {
  let configured = false;
  let availabilityReads = 0;
  let curatorRequests = 0;
  let spent = 0;
  let reads = 0;
  let writes = 0;
  let resolutions = 0;
  let requests = 0;
  const ledger = createLedger({
    pool: {
      async query(sql: string) {
        if (sql.startsWith('SELECT monthly_usd')) {
          reads++;
          return { rows: [{ monthly_usd: 1, task_usd: null, spent }] };
        }
        assert.match(sql, /INSERT INTO model_usage/);
        writes++;
        return { rows: [] };
      },
    } as never,
    ownerId: 'synthetic-decision-owner',
  });
  const model = createDecisionModel({
    configured: () => {
      availabilityReads++;
      return configured;
    },
    resolve: async () => {
      resolutions++;
      return { provider: 'openai', key: 'synthetic-decision-key' };
    },
    fetch: async () => {
      requests++;
      return Response.json({
        answers: [{ type: 'choice', name: 'access', choice: false }],
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    },
  });
  const decision = ledger.decisions(model);
  const checkMail = createMailCheck({
    decisions: decision,
    curator: {
      id: 'synthetic-curator',
      configured: true,
      async curate({ input }) {
        curatorRequests++;
        const { emails } = input as { emails: Array<{ id: number }> };
        return { results: emails.map(({ id }) => ({ id, access: false })) };
      },
    },
  });
  const request = {
    instructions: 'Check this synthetic email.',
    input: { email: { from: 'shop@example.test', subject: 'Receipt', text: 'Order dispatched.' } },
    question: {
      name: 'access',
      choices: [
        { value: false, description: 'Ordinary mail' },
        { value: true, description: 'Account access' },
      ],
    } satisfies DecisionQuestion,
  };
  assert.equal(decision.configured, false);
  assert.deepEqual(
    await Promise.all(Array.from({ length: 100 }, () => decision.check(request))),
    Array.from({ length: 100 }),
  );
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 0, writes: 0, resolutions: 0, requests: 0 },
  );
  await assert.rejects(decision.check(request, AbortSignal.abort()));
  assert.equal(reads, 0);
  const beforeAvailability = availabilityReads;
  const emails = Array.from({ length: 100 }, () => request.input.email);
  assert.deepEqual(await checkMail(emails), Array<boolean>(100).fill(false));
  assert.equal(availabilityReads - beforeAvailability, 1);
  assert.equal(curatorRequests, 10);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 0, writes: 0, resolutions: 0, requests: 0 },
  );
  assert.deepEqual(await checkMail(emails, AbortSignal.abort()), Array.from({ length: 100 }));
  assert.equal(availabilityReads - beforeAvailability, 1);
  assert.equal(curatorRequests, 10);

  configured = true;
  assert.equal(decision.configured, true);
  assert.deepEqual(await checkMail([request.input.email]), [false]);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 1, writes: 1, resolutions: 1, requests: 1 },
  );
  spent = 1;
  assert.deepEqual(await checkMail([request.input.email]), [undefined]);
  assert.equal(curatorRequests, 10);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 2, writes: 1, resolutions: 1, requests: 1 },
  );

  configured = false;
  assert.equal(await decision.check(request), undefined);
  assert.equal(reads, 2);
  spent = 0;
  const unknown = ledger.decisions(
    createDecisionModel({
      resolve: async () => {
        resolutions++;
        throw new Error('Synthetic connection is unreadable.');
      },
    }),
  );
  await assert.rejects(unknown.check(request), /connection is unreadable/);
  assert.equal(reads, 3);
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test('native decision batches preserve identities, caller accounting and scalar provider contracts', async () => {
  let provider: DecisionConnection['provider'] = 'openai';
  let limitChecks = 0;
  let active = 0;
  let maximum = 0;
  const writes: unknown[][] = [];
  const requests: Array<{ provider: string; body: any }> = [];
  const ledger = createLedger({
    pool: {
      async query(sql: string, values: unknown[]) {
        if (sql.startsWith('SELECT monthly_usd')) {
          limitChecks++;
          return { rows: [{ monthly_usd: 10, task_usd: null, spent: 0 }] };
        }
        assert.match(sql, /INSERT INTO model_usage/);
        writes.push(values);
        return { rows: [] };
      },
    } as never,
    ownerId: 'synthetic-native-decisions',
  });
  const decision = ledger.decisions(
    createDecisionModel({
      canBatch: () => provider === 'openai',
      resolve: async () => ({ provider, key: 'synthetic-decision-key' }),
      fetch: async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        requests.push({ provider, body });
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        if (provider !== 'openai') {
          assert.deepEqual(body.questions, {
            access: {
              type: 'choice',
              instructions: 'Synthetic policy',
              criteria: { false: 'Ordinary', true: 'Private' },
            },
          });
          assert.deepEqual(body.state, { fixture: 'scalar' });
          return Response.json({
            answers: { access: { type: 'choice', choice: 'false' } },
            usage: { input_tokens: 5 },
          });
        }
        if (body.questions[0].name === 'answer') {
          assert.equal(body.questions.length, 1);
          assert.equal(body.questions[0].instructions, 'Synthetic priority\nSynthetic policy');
          assert.deepEqual(JSON.parse(body.input), { fixture: 'approval' });
          return Response.json({
            answers: [{ name: 'answer', type: 'choice', choice: 'yes' }],
            usage: { input_tokens: 5 },
          });
        }
        assert.ok(body.questions.length <= 10);
        assert.ok(body.input.length <= 32_000);
        const input = JSON.parse(body.input);
        assert.deepEqual(
          body.questions.map((question: any) => question.name),
          input.emails.map((email: any) => `access_${email.id}`),
        );
        return Response.json({
          answers: body.questions.toReversed().map((question: any) => ({
            name: question.name,
            type: 'choice',
            choice: Number(question.name.slice(7)) % 7 === 0,
          })),
          usage: { input_tokens: 5, output_tokens: 1 },
        });
      },
    }),
  );
  let fallback = 0;
  const check = createMailCheck({
    decisions: decision,
    curator: {
      id: 'synthetic-fallback',
      configured: true,
      async curate() {
        fallback++;
        throw new Error('Unexpected fallback');
      },
    },
  });
  const emails = Array.from({ length: 100 }, (_, id) => ({
    from: 'first@example.test',
    subject: `Receipt ${id}`,
    text: 'Synthetic private-body marker',
  }));
  const firstTurn = randomUUID();
  const secondTurn = randomUUID();
  const [first, second] = await Promise.all([
    ledger.withTurn(firstTurn, () => check(emails)),
    ledger.withTurn(secondTurn, () =>
      check(emails.slice(0, 10).map((email) => ({ ...email, from: 'second@example.test' }))),
    ),
  ]);
  assert.deepEqual(
    first,
    emails.map((_, id) => id % 7 === 0),
  );
  assert.deepEqual(
    second,
    emails.slice(0, 10).map((_, id) => id % 7 === 0),
  );
  assert.equal(
    requests.filter(({ body }) => JSON.parse(body.input).emails[0].from === 'first@example.test')
      .length,
    10,
  );
  assert.equal(requests.length, 11);
  assert.equal(limitChecks, 11);
  assert.equal(writes.length, 11);
  assert.equal(writes.filter((values) => values[2] === firstTurn).length, 10);
  assert.equal(writes.filter((values) => values[2] === secondTurn).length, 1);
  assert.ok(writes.every((values) => JSON.parse(String(values[9])).operation === 'access'));
  assert.ok(!JSON.stringify(writes).includes('private-body marker'));
  assert.equal(maximum, 6);
  assert.equal(active, 0);
  assert.equal(fallback, 0);

  const oversized = [
    ...emails.slice(0, 3).map((email) => ({ ...email, text: '\\'.repeat(8000) })),
    { ...emails[0]!, text: 'x'.repeat(32_001) },
  ];
  assert.deepEqual(await check(oversized), [true, false, false, undefined]);
  assert.equal(requests.length, 14);

  assert.deepEqual(
    await decision.check({
      instructions: 'Synthetic policy',
      input: { fixture: 'approval' },
      question: {
        name: 'answer',
        instructions: 'Synthetic priority',
        choices: [
          { value: 'yes', description: 'Proceed' },
          { value: 'no', description: 'Stop' },
        ],
      },
    }),
    { answer: 'yes' },
  );
  assert.equal(JSON.parse(String(writes.at(-1)![9])).operation, 'approval_reply');
  const captured = decision.checkBatch!;
  const batch: DecisionBatchRequest = {
    instructions: 'Synthetic policy',
    input: { fixture: 'batch' },
    operation: 'access',
    questions: [
      {
        name: 'access_0',
        choices: [
          { value: false, description: 'Ordinary' },
          { value: true, description: 'Private' },
        ],
      },
    ],
  };
  provider = 'typesafe';
  assert.equal(decision.checkBatch, undefined);
  const before = requests.length;
  await assert.rejects(captured(batch), /changed before/);
  assert.equal(requests.length, before);
  for (const selected of ['typesafe', 'openrouter'] as const) {
    provider = selected;
    assert.equal(decision.checkBatch, undefined);
    assert.deepEqual(
      await decision.check({
        instructions: 'Synthetic policy',
        input: { fixture: 'scalar' },
        question: {
          name: 'access',
          choices: [
            { value: false, description: 'Ordinary' },
            { value: true, description: 'Private' },
          ],
        },
      }),
      { access: false },
    );
  }
  assert.equal(fallback, 0);
});

test('native decision batches reject incomplete or malformed answers without curator fallback', async (t) => {
  const valid = [
    { name: 'access_0', type: 'choice', choice: false },
    { name: 'access_1', type: 'choice', choice: true },
  ];
  const malformed = [
    valid.slice(0, 1),
    [valid[0], valid[0]],
    [valid[0], { ...valid[1], name: 'access_9' }],
    [valid[0], { ...valid[1], choice: 'false' }],
    [valid[0], { ...valid[1], type: 'text' }],
    [...valid, { ...valid[1], name: 'access_2' }],
  ];
  for (const [index, answers] of malformed.entries())
    await t.test(`invalid batch ${index + 1}`, async () => {
      let fallback = 0;
      const usage: ProviderUsageEvent[] = [];
      const base = createDecisionModel({
        canBatch: () => true,
        resolve: async () => ({ provider: 'openai', key: 'synthetic-key' }),
        fetch: async () => Response.json({ answers, usage: { input_tokens: 5 } }),
      });
      const check = createMailCheck({
        decisions: {
          check: base.check,
          checkBatch: (request, signal) =>
            base.checkBatch!(request, signal, (event) => usage.push(event)),
        },
        curator: {
          id: 'synthetic',
          configured: true,
          curate: async () => {
            fallback++;
            return { access: false };
          },
        },
      });
      assert.deepEqual(
        await check([
          { from: 'ordinary@example.test', subject: 'Receipt', text: 'Order dispatched.' },
          {
            from: 'security@example.test',
            subject: 'Sign in',
            text: 'Synthetic verification code 381749.',
          },
        ]),
        [undefined, undefined],
      );
      assert.equal(fallback, 0);
      assert.equal(usage.length, 1);
      assert.equal(usage[0]!.status, 'failed');
      assert.equal(usage[0]!.operation, 'access');
      assert.equal(usage[0]!.inputTokens, 5);
    });
});

test('queued native decision batches recheck spending limits, provider changes and cancellation', async (t) => {
  for (const stop of ['limit', 'provider', 'configuration', 'cancel'] as const)
    await t.test(stop, async () => {
      let spent = 0;
      let configured = true;
      let limitChecks = 0;
      let provider: DecisionConnection['provider'] = 'openai';
      let calls = 0;
      let fallback = 0;
      const pending: Array<() => void> = [];
      const ledger = createLedger({
        ownerId: 'synthetic-queued-decisions',
        pool: {
          query: async (sql: string) => {
            if (!sql.startsWith('SELECT monthly_usd')) return { rows: [] };
            limitChecks++;
            return { rows: [{ monthly_usd: 1, spent }] };
          },
        } as never,
      });
      const check = createMailCheck({
        decisions: ledger.decisions(
          createDecisionModel({
            configured: () => configured,
            canBatch: () => provider === 'openai',
            resolve: async () => ({ provider, key: 'synthetic-key' }),
            fetch: async (_url, options) => {
              calls++;
              const body = JSON.parse(String(options?.body));
              return new Promise<Response>((resolve) =>
                pending.push(() =>
                  resolve(
                    Response.json({
                      answers: body.questions.map((question: any) => ({
                        name: question.name,
                        type: 'choice',
                        choice: false,
                      })),
                      usage: { input_tokens: 5 },
                    }),
                  ),
                ),
              );
            },
          }),
        ),
        curator: {
          id: 'synthetic',
          configured: true,
          curate: async () => {
            fallback++;
            return { access: false };
          },
        },
      });
      const controller = new AbortController();
      const result = check(
        Array.from({ length: 70 }, () => ({
          from: 'fixture@example.test',
          subject: 'Receipt',
          text: 'Order dispatched.',
        })),
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 6);
      if (stop === 'limit') spent = 1;
      if (stop === 'provider') provider = 'typesafe';
      if (stop === 'configuration') configured = false;
      if (stop === 'cancel') {
        controller.abort();
        assert.deepEqual(await result, Array.from({ length: 70 }));
      }
      pending.splice(0).forEach((finish) => finish());
      const checked = await result;
      if (stop !== 'cancel')
        assert.deepEqual(checked, [
          ...Array<boolean>(60).fill(false),
          ...Array.from({ length: 10 }),
        ]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 6);
      assert.equal(fallback, 0);
      if (stop === 'configuration') assert.equal(limitChecks, 6);
    });
});

test('decision requests revalidate capability and cancellation after resolving credentials', async (t) => {
  for (const stop of ['provider', 'configuration', 'cancel', 'scalar-cancel'] as const)
    await t.test(stop, async () => {
      let provider: DecisionConnection['provider'] = 'openai';
      let configured = true;
      let calls = 0;
      let fallback = 0;
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resolving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const model = createDecisionModel({
        configured: () => configured,
        canBatch: () => provider === 'openai',
        resolve: async () => {
          const selected = provider;
          entered();
          await pending;
          return { provider: selected, key: 'synthetic-old-connection' };
        },
        fetch: async () => {
          calls++;
          return Response.json({
            answers: [{ name: 'access_0', type: 'choice', choice: false }],
            usage: { input_tokens: 1 },
          });
        },
      });
      const captured = model.checkBatch;
      const check = createMailCheck({
        decisions: {
          check: model.check,
          ...(stop !== 'scalar-cancel' && { checkBatch: captured }),
        },
        curator: {
          id: 'synthetic',
          configured: true,
          curate: async () => {
            fallback++;
            return { access: false };
          },
        },
      });
      const controller = new AbortController();
      const result = check(
        [{ from: 'fixture@example.test', subject: 'Receipt', text: 'Order dispatched.' }],
        controller.signal,
      );
      await resolving;
      if (stop === 'provider') provider = 'typesafe';
      if (stop === 'configuration') configured = false;
      if (stop === 'cancel' || stop === 'scalar-cancel') controller.abort();
      release();
      assert.deepEqual(await result, [undefined]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.equal(fallback, 0);
    });
});

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
      ANTHROPIC_WORKSPACE_ID: '  wrkspc_Managed123  ',
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
              : {
                  type: 'api_key',
                  key,
                  ...(provider === 'anthropic' ? { workspaceId: 'wrkspc_Managed123' } : {}),
                },
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

  test('API key validation refuses provider mismatches before transport or persistence without changing existing connections', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const savedKey = 'fixture-existing-openai-key';
    const requests: string[] = [];
    const owner = await f.create(
      'fixture-owner',
      createPiModelBackend({
        fetch: async (input, init) => {
          requests.push(String(input));
          if (
            String(input) === 'https://api.openai.com/v1/models' &&
            new Headers(init?.headers).get('authorization') === `Bearer ${savedKey}`
          )
            return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
          return Response.json({ error: 'Synthetic credential rejection.' }, { status: 401 });
        },
      }),
    );
    await owner.addKey('openai', savedKey);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    const initial = owner.view();
    const stored = async () =>
      Promise.all(
        ['model_connections', 'model_settings', 'vault_app_grants'].map(
          async (table) => (await f.database.query(`SELECT * FROM ${table}`)).rows,
        ),
      );
    const initialRows = await stored();
    for (const [name, provider, key] of [
      ['Anthropic key in OpenAI', 'openai', 'sk-ant-api03-synthetic-foreign-key'],
      ['OpenRouter key in Anthropic', 'anthropic', 'sk-or-v1-synthetic-foreign-key'],
      ['OpenAI project key in OpenRouter', 'openrouter', 'sk-proj-synthetic-foreign-key'],
      ['long-term Bedrock key in OpenAI', 'openai', 'ABSKsynthetic-foreign-key'],
      ['short-term Bedrock key in Anthropic', 'anthropic', 'bedrock-api-key-synthetic-foreign-key'],
      ['embedded whitespace', 'openai', 'fixture invalid key'],
      ['embedded control character', 'openai', 'fixture-invalid\u0000key'],
      ['first C1 control character', 'openai', 'fixture-invalid\u0080key'],
      ['C1 next-line control character', 'openai', 'fixture-invalid\u0085key'],
      ['last C1 control character', 'openai', 'fixture-invalid\u009fkey'],
      ['incomplete Anthropic key', 'anthropic', 'sk-ant-api'],
      ['incomplete OpenRouter key', 'openrouter', 'sk-or-v1-'],
      ['bundled provider', 'baseten', 'sk-ant-api03-synthetic-bundled-key'],
    ] as const) {
      await t.test(name, async () => {
        const previousRequests = requests.length;
        const response = await app.inject({
          method: 'POST',
          url: '/api/models/keys',
          payload: { provider, key },
        });
        assert.equal(response.statusCode, 400);
        assert.equal(typeof response.json().error, 'string');
        assert.ok(!response.body.includes(key));
        assert.equal(requests.length, previousRequests);
        assert.deepEqual(owner.view(), initial);
        assert.deepEqual(await stored(), initialRows);
        assert.equal(await owner.apiKey('openai'), savedKey);
        assert.deepEqual(await (await owner.resolve()).read(), {
          type: 'api_key',
          key: savedKey,
        });
      });
    }
  });

  test('API key validation leaves unfamiliar formats, matching providers and owner-configured model endpoints usable', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const requests: Array<{ url: string; key: string | null }> = [];
    const bedrockKeys = ['ABSKsynthetic-bedrock-key', 'bedrock-api-key-synthetic-key'];
    const owner = await f.create(
      'fixture-owner',
      createPiModelBackend({
        fetch: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          requests.push({ url, key: headers.get('authorization') ?? headers.get('x-api-key') });
          if (url === 'https://api.openai.com/v1/models')
            return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
          if (url === 'https://api.anthropic.com/v1/models?limit=1000')
            return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
          if (
            url ===
            'https://bedrock.us-east-1.amazonaws.com/foundation-models?byInferenceType=ON_DEMAND&byOutputModality=TEXT'
          )
            return Response.json({ modelSummaries: [{ modelId: 'amazon.nova-pro-v1:0' }] });
          if (
            url ===
            'https://bedrock.us-east-1.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000'
          )
            return Response.json({ inferenceProfileSummaries: [] });
          if (url === 'http://127.0.0.1:11434/v1/models')
            return Response.json({ data: [{ id: 'fixture-local' }] });
          assert.ok(
            ['http://127.0.0.1:11434/api/version', 'http://127.0.0.1:11434/api/v1/models'].includes(
              url,
            ),
          );
          return Response.json({}, { status: 404 });
        },
      }),
    );
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const [provider, key] of [
      ['openai', '  fixture-unfamiliar-openai-key  '],
      ['anthropic', 'sk-synthetic-shared-prefix'],
      ['baseten', 'fixture-unfamiliar-bundled-key'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider, key },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await owner.apiKey(provider), key.trim());
      assert.ok(!response.body.includes(key.trim()));
    }
    for (const key of bedrockKeys) {
      const existing = new Set(owner.view().connections.map((row) => row.id));
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider: 'amazon-bedrock', key, region: 'us-east-1' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes(key));
      const connection = owner.view().connections.find((row) => !existing.has(row.id))!;
      const model = connection.models[0]!;
      await owner.select({
        connectionId: connection.id,
        modelId: model.id,
        effort: model.efforts[0]!,
      });
      assert.deepEqual(await (await owner.resolve()).read(), {
        type: 'bedrock',
        key,
        region: 'us-east-1',
      });
    }
    const proxyKey = 'sk-ant-api03-synthetic-proxy-key';
    const endpoint = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: 'http://127.0.0.1:11434/v1', key: proxyKey },
    });
    assert.equal(endpoint.statusCode, 200, endpoint.body);
    const endpointConnection = owner
      .view()
      .connections.find((row) => row.provider === 'compatible')!;
    await owner.select({
      connectionId: endpointConnection.id,
      modelId: 'fixture-local',
      effort: 'off',
    });
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'endpoint',
      url: 'http://127.0.0.1:11434/v1',
      key: proxyKey,
    });
    assert.deepEqual(requests, [
      { url: 'https://api.openai.com/v1/models', key: 'Bearer fixture-unfamiliar-openai-key' },
      {
        url: 'https://api.anthropic.com/v1/models?limit=1000',
        key: 'sk-synthetic-shared-prefix',
      },
      ...bedrockKeys.flatMap((key) =>
        [
          '/foundation-models?byInferenceType=ON_DEMAND&byOutputModality=TEXT',
          '/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000',
        ].map((path) => ({
          url: `https://bedrock.us-east-1.amazonaws.com${path}`,
          key: `Bearer ${key}`,
        })),
      ),
      ...['/v1/models', '/api/version', '/api/v1/models'].map((path) => ({
        url: `http://127.0.0.1:11434${path}`,
        key: `Bearer ${proxyKey}`,
      })),
    ]);
  });

  test('Anthropic workspace selection survives setup, encrypted reload and model refresh', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const sharedKey = 'fixture-anthropic-unscoped-key';
    const scopedKey = 'fixture-anthropic-scoped-key';
    const discoveredKey = 'fixture-anthropic-discovered-key';
    const deniedKey = 'fixture-anthropic-discovered-denied-key';
    const unavailableKey = 'fixture-anthropic-discovery-unavailable-key';
    const workspaces = ['wrkspc_First123', 'wrkspc_Second-456'];
    const requests: Array<{ key: string | null; workspaceId: string | null }> = [];
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const workspaceId = headers.get('anthropic-workspace-id');
        const key = headers.get('x-api-key') ?? headers.get('authorization');
        requests.push({ key, workspaceId });
        if (
          String(input) ===
          'https://api.anthropic.com/v1/organizations/workspaces?include_default=true&limit=1000'
        ) {
          assert.equal(workspaceId, null);
          if (key === unavailableKey)
            return Response.json({ error: { message: key } }, { status: 503 });
          return Response.json({
            data: (key === sharedKey ? workspaces : [workspaces[0]]).map((id) => ({
              id,
              name: id === workspaces[0] ? 'Development' : 'Production',
              archived_at: null,
            })),
            has_more: false,
          });
        }
        if (String(input) === 'https://api.openai.com/v1/models') {
          assert.equal(workspaceId, null);
          return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
        }
        assert.equal(String(input), 'https://api.anthropic.com/v1/models?limit=1000');
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        const failure: [number, string, string] | undefined =
          key === 'fixture-revoked-key'
            ? [401, 'authentication_error', 'Synthetic expired API key.']
            : key === 'fixture-forbidden-key'
              ? [403, 'permission_error', 'Synthetic resource access denied.']
              : workspaceId && (!workspaces.includes(workspaceId) || key === deniedKey)
                ? [404, 'not_found_error', 'Synthetic workspace not found.']
                : key !== scopedKey && !workspaceId
                  ? [400, 'invalid_request_error', 'Include the anthropic-workspace-id header.']
                  : undefined;
        if (failure)
          return Response.json(
            { type: 'error', error: { type: failure[1], message: failure[2] } },
            { status: failure[0] },
          );
        assert.ok(key === sharedKey || key === scopedKey || key === discoveredKey);
        return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
      },
    });
    const owner = await f.create('fixture-workspace-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    const connect = (key: string, workspaceId?: string, provider = 'anthropic') =>
      app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider, key, ...(workspaceId === undefined ? {} : { workspaceId }) },
      });
    const stored = async () =>
      Promise.all(
        ['model_connections', 'model_settings', 'vault_app_grants'].map(
          async (table) => (await f.database.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
        ),
      );
    assert.equal((await connect(scopedKey, '  ')).statusCode, 200);
    assert.deepEqual(requests.at(-1), { key: scopedKey, workspaceId: null });
    const initial = owner.view();
    const initialRows = await stored();
    for (const [key, workspaceId] of [
      [sharedKey, undefined],
      [deniedKey, undefined],
      [unavailableKey, undefined],
      [sharedKey, 'wrkspc_Inaccessible'],
      [sharedKey, 'org_wrong'],
      ['fixture-revoked-key', workspaces[0]],
      ['fixture-forbidden-key', workspaces[0]],
    ] as const) {
      const response = await connect(key, workspaceId);
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(key));
      assert.deepEqual(
        response.json().workspaces,
        key === sharedKey && !workspaceId
          ? workspaces.map((id, index) => ({
              id,
              name: index === 0 ? 'Development' : 'Production',
            }))
          : undefined,
      );
      assert.deepEqual(owner.view(), initial);
      assert.deepEqual(await stored(), initialRows);
    }
    const previousRequests = requests.length;
    for (const workspaceId of [
      'wrkspc_bad workspace',
      'wrkspc_bad\u0000workspace',
      'wrkspc_bad\r\nheader',
      `wrkspc_${'a'.repeat(100)}`,
    ])
      assert.equal((await connect(sharedKey, workspaceId)).statusCode, 400);
    assert.equal(requests.length, previousRequests);
    assert.deepEqual(await stored(), initialRows);
    const ids: string[] = [];
    for (const workspaceId of workspaces) {
      const response = await connect(sharedKey, `  ${workspaceId}  `);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(requests.at(-1), { key: sharedKey, workspaceId });
      const connection = owner.view().connections.find((row) => row.label === workspaceId)!;
      assert.ok(connection);
      ids.push(connection.id);
      assert.equal(await owner.addKey('anthropic', sharedKey, { workspaceId }), connection.id);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.equal(owner.view().connections.length, 3);
    const reloaded = await f.create('fixture-workspace-owner', backend);
    for (const [index, workspaceId] of workspaces.entries()) {
      const connection = reloaded.view().connections.find((row) => row.id === ids[index])!;
      const choice = connection.models[0];
      await reloaded.select({
        connectionId: connection.id,
        modelId: choice.id,
        effort: choice.efforts[0],
      });
      const access = await reloaded.resolve();
      assert.deepEqual(await access.read(), { type: 'api_key', key: sharedKey, workspaceId });
      assert.ok(!JSON.stringify(access.definition.spec).includes(workspaceId));
      await reloaded.refreshCatalog(connection.id);
      assert.deepEqual(requests.at(-1), { key: sharedKey, workspaceId });
    }
    const discovered = await f.create('fixture-workspace-discovery-owner', backend);
    const discoveredId = await discovered.addKey('anthropic', discoveredKey);
    assert.equal(discovered.view().connections[0].label, workspaces[0]);
    const discoveredReload = await f.create('fixture-workspace-discovery-owner', backend);
    assert.deepEqual(await (await discoveredReload.resolve()).read(), {
      type: 'api_key',
      key: discoveredKey,
      workspaceId: workspaces[0],
    });
    await discoveredReload.refreshCatalog(discoveredId);
    assert.deepEqual(requests.at(-1), { key: discoveredKey, workspaceId: workspaces[0] });
    assert.equal(
      (await connect('fixture-openai-holdout', workspaces[0], 'openai')).statusCode,
      200,
    );
    const openai = owner.view().connections.find((row) => row.provider === 'openai')!;
    await owner.select({ connectionId: openai.id, modelId: 'gpt-6.1-sol', effort: 'medium' });
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-openai-holdout',
    });
    assert.doesNotMatch(
      JSON.stringify(await stored()),
      /fixture-anthropic-(unscoped|scoped|discovered)-key|fixture-openai-holdout/,
    );
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM vault_app_grants')).rows),
      /wrkspc_/,
    );
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

async function notificationPage(t: import('node:test').TestContext) {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/',
    pretendToBeVisual: true,
  });
  let owner = 'notification-owner-one';
  let permission: NotificationPermission = 'default';
  let permissionRequests = 0;
  let permissionResponse = async (): Promise<NotificationPermission> => permission;
  let failConstruction = false;
  let delayedShow = false;
  let focused = false;
  let visible = true;
  let focusCalls = 0;
  const notifications: SyntheticNotification[] = [];
  const preferences = {
    notificationRule: '',
    rules: '',
    timeZone: 'UTC',
    locale: 'en-GB',
    hourCycle: 'h23',
    quietHoursEnabled: false,
    quietStart: '00:00',
    quietEnd: '23:59',
    proactivePaused: false,
  };
  let preferencesResponse = async () => Response.json(preferences);
  class SyntheticNotification {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      permissionRequests++;
      permission = await permissionResponse();
      return permission;
    }
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onshow: (() => void) | null = null;
    closed = 0;
    shown = !delayedShow;
    visible = !delayedShow;
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      if (failConstruction) throw new TypeError('Synthetic browser cannot construct notifications');
      notifications.push(this);
    }
    close() {
      if (!this.shown) return;
      this.closed++;
      this.visible = false;
      this.onclose?.();
    }
    show() {
      this.shown = true;
      this.visible = true;
      this.onshow?.();
    }
  }
  Object.defineProperty(dom.window.navigator, 'locks', {
    configurable: true,
    value: navigator.locks,
  });
  Object.defineProperties(dom.window, {
    Notification: { configurable: true, value: SyntheticNotification },
    isSecureContext: { configurable: true, value: true },
    focus: { configurable: true, value: () => focusCalls++ },
    matchMedia: {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  Object.defineProperties(dom.window.document, {
    visibilityState: { configurable: true, get: () => (visible ? 'visible' : 'hidden') },
    hasFocus: { configurable: true, value: () => focused },
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { sessionStore } = await import('../src/web/lib/session.ts');
  const { pageDataCache } = await import('../src/web/lib/page-data-cache.ts');
  t.mock.method(sessionStore, 'getSnapshot', () => ({
    session: {
      user: { id: owner, name: 'Synthetic owner', email: null, avatarUrl: null },
      settings: { theme: 'system', onboardingCompleted: true, usageData: false, traces: false },
      capabilities: { developer: false, traces: false },
    },
    loading: false,
    mutating: false,
    locked: false,
    error: '',
    epoch: 0,
  }));
  t.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL) => {
    assert.equal(String(path), '/api/preferences');
    return preferencesResponse();
  });
  pageDataCache.clear();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    pageDataCache.clear();
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  return {
    act,
    createElement,
    window: dom.window,
    document: dom.window.document,
    notifications,
    preferences,
    respondPreferences: (response: () => Promise<Response>) => (preferencesResponse = response),
    owner: () => owner,
    setOwner: (value: string) => (owner = value),
    setPermission: (value: NotificationPermission) => (permission = value),
    permissionRequests: () => permissionRequests,
    respondPermission: (response: () => Promise<NotificationPermission>) =>
      (permissionResponse = response),
    failConstruction: (value: boolean) => (failConstruction = value),
    delayShow: (value: boolean) => (delayedShow = value),
    focus: (value: boolean) => (focused = value),
    visible: (value: boolean) => (visible = value),
    focusCalls: () => focusCalls,
    native: (bridge: unknown) => Reflect.set(dom.window, 'nodDesktop', bridge),
    async render(element: import('react').ReactNode) {
      await act(async () => root.render(element));
    },
    async click(index: number) {
      const button = dom.window.document.querySelectorAll('button')[index];
      assert.ok(button);
      await act(async () => button.click());
    },
    async refreshPreferences() {
      await act(async () => pageDataCache.refresh('/api/preferences', true));
    },
  };
}

test('browser notification permission requires an explicit owned choice and rejects denial, unsupported construction and stale consent', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationPrompt } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus } = await import('../src/web/lib/browser-notifications.ts');
  const render = () =>
    f.render(f.createElement(BrowserNotificationPrompt, { key: f.owner(), ownerId: f.owner() }));
  await render();
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 0);
  await f.click(1);
  assert.equal(f.permissionRequests(), 0);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'dismissed');
  await f.render(null);
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 0);
  f.setOwner('notification-owner-two');
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 2);
  f.respondPermission(async () => 'default');
  await f.click(0);
  assert.equal(f.permissionRequests(), 1);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.respondPermission(async () => 'denied');
  await f.click(0);
  assert.equal(f.permissionRequests(), 2);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.setOwner('notification-owner-three');
  f.setPermission('default');
  let answer: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (answer = resolve)));
  await render();
  await f.click(0);
  f.setOwner('notification-owner-four');
  await render();
  await f.act(async () => answer('granted'));
  assert.equal(browserNotificationStatus('notification-owner-three').enabled, false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.failConstruction(true);
  await f.click(0);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  assert.ok(f.document.querySelector('[role="alert"]'));
  f.failConstruction(false);
  await f.click(0);
  assert.equal(f.permissionRequests(), 3);
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.equal(browserNotificationStatus('notification-owner-one').choice, 'dismissed');
});

test('browser notification delivery preserves owner consent, hides reply content and fences duplicate and stale alerts', async (t) => {
  const f = await notificationPage(t);
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  const message = {
    id: 'synthetic-message',
    createdAt: '2035-01-01T12:00:00.000Z',
    text: 'Synthetic private email content that must never appear in a browser notification',
  };
  let current = true;
  const send = () =>
    deliverBrowserNotification(f.owner(), 'synthetic-thread', message, () => current);
  assert.equal(await send(), null);
  assert.equal(f.notifications.length, 0);
  await setBrowserNotifications(f.owner(), true);
  assert.equal(f.notifications.length, 1);
  f.focus(true);
  assert.equal(await send(), null);
  f.focus(false);
  const [first, duplicate] = await Promise.all([send(), send()]);
  assert.ok(first);
  assert.equal(duplicate, null);
  assert.equal(f.notifications.length, 2);
  assert.equal(JSON.stringify(f.notifications.at(-1)).includes(message.text), false);
  assert.equal(new URL(f.notifications.at(-1)!.options.icon!).origin, f.window.location.origin);
  const targets: unknown[] = [];
  f.window.addEventListener('nod:focus-message', (event) =>
    targets.push((event as CustomEvent).detail),
  );
  f.notifications.at(-1)!.onclick?.();
  assert.equal(f.focusCalls(), 1);
  assert.deepEqual(targets, [{ messageId: message.id }]);
  current = false;
  f.notifications.at(-1)!.onclick?.();
  assert.equal(f.focusCalls(), 1);
  assert.equal(targets.length, 1);
  f.setOwner('notification-owner-next');
  current = true;
  assert.equal(await send(), null);
  await setBrowserNotifications(f.owner(), true);
  assert.ok(await send());
  await setBrowserNotifications(f.owner(), false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(await send(), null);
  f.native({ getSettings: async () => ({ notifications: true }) });
  const beforeNative = f.notifications.length;
  await setBrowserNotifications(f.owner(), true);
  assert.equal(await send(), null);
  assert.equal(f.notifications.length, beforeNative);
});

test('browser reply alerts skip initial history, replay, user messages, quiet time and retired thread scopes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2035, 0, 1, 12) });
  const f = await notificationPage(t);
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  let threadId = 'notification-thread-one';
  function Watch() {
    useBrowserNotifications(f.owner(), { threadId, messages: [...messages] } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = (role: 'assistant' | 'user' = 'assistant') => {
    const index = messages.length;
    messages.push({
      id: `message-${String(index).padStart(3, '0')}`,
      role,
      text: 'Synthetic private reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 0, 0, index)).toISOString(),
      attachments: [],
    });
  };
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  let finishPreferences: (response: Response) => void = () => {};
  f.respondPreferences(() => new Promise((resolve) => (finishPreferences = resolve)));
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  await f.act(async () => finishPreferences(Response.json(f.preferences)));
  f.respondPreferences(async () => Response.json(f.preferences));
  assert.equal(f.notifications.length, 2);
  await render();
  add('user');
  await render();
  assert.equal(f.notifications.length, 2);
  f.preferences.quietHoursEnabled = true;
  await f.refreshPreferences();
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  f.preferences.quietHoursEnabled = false;
  await f.refreshPreferences();
  f.focus(true);
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  f.focus(false);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  threadId = 'notification-thread-next';
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.ok(f.notifications.slice(1).every((notification) => notification.closed > 0));
  add();
  await render();
  assert.equal(f.notifications.length, 4);
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.ok(f.notifications.at(-1)!.closed > 0);
  add();
  await render();
  assert.equal(f.notifications.length, 4);
});

test('native notification introduction waits for the owner choice and keeps dismissal scoped', async (t) => {
  const f = await notificationPage(t);
  const { ChatNotifications } = await import('../src/web/components/chat-notifications.tsx');
  let enabled = false;
  const writes: unknown[] = [];
  f.native({
    onPreferences: () => () => {},
    getSettings: async () => ({ notifications: enabled }),
    saveSettings: async (value: { notifications: boolean }) => {
      writes.push(value);
      enabled = value.notifications;
      return { notifications: enabled };
    },
  });
  const render = () =>
    f.render(
      f.createElement(ChatNotifications, {
        ownerId: f.owner(),
        messageId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    );
  await render();
  assert.deepEqual(writes, []);
  assert.equal(f.permissionRequests(), 0);
  await f.click(1);
  await f.render(null);
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 0);
  assert.deepEqual(writes, []);
  f.setOwner('notification-native-owner-next');
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 2);
  await f.click(0);
  assert.deepEqual(writes, [{ notifications: true }]);
  assert.equal(f.document.querySelectorAll('button').length, 0);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notification opt-in cannot replay a reply observed before consent while preferences load', async (t) => {
  const f = await notificationPage(t);
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-consent-delay',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  let finishPreferences: (response: Response) => void = () => {};
  f.respondPreferences(() => new Promise((resolve) => (finishPreferences = resolve)));
  add();
  await f.render(f.createElement(Watch));
  add();
  await f.render(f.createElement(Watch));
  assert.equal(f.notifications.length, 0);
  f.setPermission('granted');
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(f.notifications.length, 1);
  await f.act(async () => finishPreferences(Response.json(f.preferences)));
  assert.equal(f.notifications.length, 1);
  add();
  await f.render(f.createElement(Watch));
  assert.equal(f.notifications.length, 2);
});

test('browser notification re-enablement fails closed when an existing opt-in cannot construct alerts', async (t) => {
  const f = await notificationPage(t);
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  f.setPermission('default');
  f.respondPermission(async () => 'granted');
  f.failConstruction(true);
  await assert.rejects(setBrowserNotifications(f.owner(), true));
  assert.equal(f.permissionRequests(), 1);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.notEqual(browserNotificationStatus(f.owner()).choice, 'enabled');
  assert.equal(f.notifications.length, 1);
});

test('browser notifications close after delayed display when consent or their owning scope ends', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationPrompt } =
    await import('../src/web/components/browser-notifications.tsx');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  let grant: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (grant = resolve)));
  f.delayShow(true);
  const prompt = () =>
    f.render(f.createElement(BrowserNotificationPrompt, { key: f.owner(), ownerId: f.owner() }));
  await prompt();
  await f.click(0);
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  await f.act(async () => grant('granted'));
  assert.equal(f.permissionRequests(), 1);
  const disabledConfirmation = f.notifications.at(-1)!;
  assert.ok(disabledConfirmation);
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.equal(disabledConfirmation.closed, 0);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  const reenabledConfirmation = f.notifications.at(-1)!;
  disabledConfirmation.show();
  reenabledConfirmation.show();
  const confirmationVisibility = [disabledConfirmation.visible, reenabledConfirmation.visible];
  f.setOwner('notification-delayed-owner');
  await prompt();
  await f.click(0);
  const retiredConfirmation = f.notifications.at(-1)!;
  await f.render(null);
  assert.equal(retiredConfirmation.closed, 0);
  retiredConfirmation.show();
  assert.equal(retiredConfirmation.visible, false);
  f.setOwner('notification-active-owner');
  await prompt();
  await f.click(0);
  const activeConfirmation = f.notifications.at(-1)!;
  activeConfirmation.show();
  assert.equal(activeConfirmation.visible, true);
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  let threadId = 'notification-delayed-thread';
  function Watch() {
    useBrowserNotifications(f.owner(), { threadId, messages: [...messages] } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic private reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  add();
  await render();
  add();
  await render();
  const retiredReply = f.notifications.at(-1)!;
  assert.notEqual(retiredReply, retiredConfirmation);
  threadId = 'notification-delayed-thread-next';
  await render();
  assert.equal(retiredReply.closed, 0);
  retiredReply.show();
  assert.equal(retiredReply.visible, false);
  add();
  await render();
  const activeReply = f.notifications.at(-1)!;
  activeReply.show();
  assert.equal(activeReply.visible, true);
  add();
  await render();
  const disabledReply = f.notifications.at(-1)!;
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.equal(disabledReply.closed, 0);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  const beforeReply = f.notifications.length;
  add();
  await render();
  assert.equal(f.notifications.length, beforeReply + 1);
  const reenabledReply = f.notifications.at(-1)!;
  assert.notEqual(reenabledReply, disabledReply);
  disabledReply.show();
  reenabledReply.show();
  assert.deepEqual(
    { confirmationVisibility, replyVisibility: [disabledReply.visible, reenabledReply.visible] },
    { confirmationVisibility: [false, true], replyVisibility: [false, true] },
  );
});

test('browser notification deduplication delivers distinct equal-time replies and rejects either replay', async (t) => {
  const f = await notificationPage(t);
  const { deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  const first = {
    id: 'ffffffff-ffff-4fff-afff-ffffffffffff',
    createdAt: '2035-01-01T12:00:00.000Z',
  };
  const second = { id: '00000000-0000-4000-a000-000000000001', createdAt: first.createdAt };
  const deliver = (message: typeof first) =>
    deliverBrowserNotification(f.owner(), 'notification-timestamp-tie', message, () => true);
  assert.ok(await deliver(first));
  assert.ok(await deliver(second));
  assert.equal(await deliver(first), null);
  assert.equal(await deliver(second), null);
  assert.equal(f.notifications.length, 3);
});

test('browser notification support requires shared locking before asking for permission', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-unavailable-owner');
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  const locks = f.window.navigator.locks;
  f.window.localStorage.setItem(`nod.browser-notifications.${f.owner()}`, 'enabled');
  Object.defineProperty(f.window.navigator, 'locks', { configurable: true, value: undefined });
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  assert.equal(browserNotificationStatus(f.owner()).available, false);
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  await assert.rejects(setBrowserNotifications(f.owner(), true));
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 0);
  f.setPermission('granted');
  assert.equal(
    await deliverBrowserNotification(
      f.owner(),
      'notification-no-locks',
      { id: 'message-no-locks', createdAt: '2035-01-01T12:00:00.000Z' },
      () => true,
    ),
    null,
  );
  assert.equal(f.notifications.length, 0);
  Object.defineProperty(f.window.navigator, 'locks', { configurable: true, value: locks });
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.permissionRequests(), 0);
  await f.act(async () => control.click());
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.permissionRequests(), 0);
  f.native({ getSettings: async () => ({ notifications: true }) });
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.document.querySelector('[role="switch"]'), null);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'enabled');
  assert.equal(f.notifications.length, 1);
  assert.equal(f.permissionRequests(), 0);
});

test('native notification introduction recovers settings-read failures before saving opt-in', async (t) => {
  const f = await notificationPage(t);
  const { ChatNotifications } = await import('../src/web/components/chat-notifications.tsx');
  let reads = 0;
  const writes: unknown[] = [];
  f.native({
    onPreferences: () => () => {},
    getSettings: async () => {
      reads++;
      if (reads === 1) throw new Error('Synthetic settings read failed');
      return { notifications: false };
    },
    saveSettings: async (value: { notifications: boolean }) => {
      writes.push(value);
      return value;
    },
  });
  await f.render(
    f.createElement(ChatNotifications, {
      ownerId: f.owner(),
      messageId: 'notification-retry-introduction',
    }),
  );
  assert.ok(f.document.querySelector('[role="alert"]'));
  assert.equal(reads, 1);
  assert.deepEqual(writes, []);
  await f.click(0);
  assert.equal(reads, 2);
  assert.deepEqual(writes, []);
  assert.equal(f.document.querySelector('[role="alert"]'), null);
  await f.click(0);
  assert.deepEqual(writes, [{ notifications: true }]);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notification settings revoke a saved opt-in after browser permission is denied', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('denied');
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 1);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(
    await deliverBrowserNotification(
      f.owner(),
      'notification-denied-settings',
      { id: 'reply-after-external-grant', createdAt: '2035-01-01T12:00:00.000Z' },
      () => true,
    ),
    null,
  );
  assert.equal(f.notifications.length, 1);
  await f.act(async () => control.click());
  assert.equal(control.getAttribute('aria-checked'), 'true');
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('denied');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
});

test('browser notification settings recover a reset permission only after an explicit choice', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('default');
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(f.permissionRequests(), 0);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  f.setPermission('default');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  let answer: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (answer = resolve)));
  await f.act(async () => control.click());
  assert.equal(f.permissionRequests(), 1);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 1);
  assert.equal(control.disabled, true);
  await f.act(async () => answer('default'));
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.ok(f.document.querySelector('[role="alert"]'));
  await f.act(async () => control.click());
  assert.equal(f.permissionRequests(), 2);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  await f.act(async () => answer('granted'));
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(control.getAttribute('aria-checked'), 'true');
  assert.equal(control.disabled, false);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.document.querySelector('[role="alert"]'), null);
  const testAction = [...f.document.querySelectorAll('button')].find(
    (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
  );
  assert.ok(testAction);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 3);
  assert.equal(f.permissionRequests(), 2);
  await f.act(async () => control.click());
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(
    [...f.document.querySelectorAll('button')].some(
      (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
    ),
    false,
  );
  assert.equal(f.permissionRequests(), 2);
});

test('browser notifications revoke background consent without mounting settings and require a fresh opt-in', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-hook-revocation-owner');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-hook-revocation-thread',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  f.setPermission('default');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  add();
  await render();
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(f.notifications.length, 2);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.equal(f.notifications.at(-1)!.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notifications honor queued cross-tab revocations without cancelling another owner', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-storage-revocation-owner');
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-storage-revocation-thread',
      messages: [...messages],
    } as AppState);
    return f.createElement(BrowserNotificationSettings, { ownerId: f.owner() });
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  const revoke = (owner: string) =>
    f.act(async () =>
      f.window.dispatchEvent(
        new f.window.StorageEvent('storage', {
          key: `nod.browser-notifications.${owner}`,
          oldValue: 'enabled',
          newValue: 'disabled',
          storageArea: f.window.localStorage,
        }),
      ),
    );
  f.setPermission('granted');
  f.delayShow(true);
  add();
  await render();
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  await f.act(async () => control.click());
  assert.equal(f.notifications.length, 1);
  const confirmation = f.notifications[0]!;
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  const shownReply = f.notifications[1]!;
  shownReply.show();
  await revoke('notification-unrelated-owner');
  confirmation.show();
  assert.equal(confirmation.visible, true);
  assert.equal(shownReply.visible, true);
  assert.equal(shownReply.closed, 0);
  const testAction = [...f.document.querySelectorAll('button')].find(
    (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
  );
  assert.ok(testAction);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 3);
  const queuedConfirmation = f.notifications[2]!;
  add();
  await render();
  assert.equal(f.notifications.length, 4);
  const queuedReply = f.notifications[3]!;
  assert.equal(f.window.localStorage.getItem(`nod.browser-notifications.${f.owner()}`), 'enabled');
  await revoke(f.owner());
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(confirmation.visible, false);
  assert.equal(shownReply.visible, false);
  queuedConfirmation.show();
  queuedReply.show();
  assert.equal(queuedConfirmation.visible, false);
  assert.equal(queuedReply.visible, false);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 5);
  const freshConfirmation = f.notifications[4]!;
  add();
  await render();
  assert.equal(f.notifications.length, 6);
  const freshReply = f.notifications[5]!;
  freshConfirmation.show();
  freshReply.show();
  assert.equal(freshConfirmation.visible, true);
  assert.equal(freshReply.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notifications remain revoked when persisting permission reconciliation fails', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-storage-failure-owner');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-storage-failure-thread',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('default');
  const key = `nod.browser-notifications.${f.owner()}`;
  const prototype = Object.getPrototypeOf(f.window.localStorage) as Storage;
  const originalSetItem = prototype.setItem;
  const setItem = t.mock.method(
    prototype,
    'setItem',
    function (this: Storage, name: string, value: string) {
      if (name === key) throw new Error('Synthetic storage write failed');
      return originalSetItem.call(this, name, value);
    },
  );
  add();
  await render();
  assert.equal(f.window.localStorage.getItem(key), 'enabled');
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  setItem.mock.restore();
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  await f.act(async () =>
    f.window.dispatchEvent(
      new f.window.StorageEvent('storage', {
        key,
        oldValue: 'disabled',
        newValue: 'enabled',
        storageArea: f.window.localStorage,
      }),
    ),
  );
  add();
  await render();
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 2);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.equal(f.notifications.at(-1)!.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('feedback capture runs once for a fresh owned draft and skips restored or pending submissions', async (t) => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createFeedbackCapture } = await import('../src/web/lib/feedback-capture.ts');
  const { saveFeedbackDraft, writeFeedbackPending } =
    await import('../src/web/lib/feedback-draft.ts');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDatabase = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const storage = new Map<string, string>();
  let captures = 0;
  let refused = false;
  const bridge = {
    async captureFeedbackScreenshot() {
      captures++;
      return refused ? null : new Uint8Array([255, 216, 255, 217]);
    },
  };
  const window = {
    nodDesktop: bridge as typeof bridge | undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDatabase) Object.defineProperty(globalThis, 'indexedDB', originalDatabase);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  const capture = createFeedbackCapture('capture-owner-one');
  const [first, simultaneous] = await Promise.all([capture.capture(), capture.capture()]);
  assert.equal(captures, 1);
  assert.equal(first?.type, 'image/jpeg');
  assert.equal(first?.name, 'nod-screenshot.jpg');
  assert.deepEqual(
    new Uint8Array(await simultaneous!.arrayBuffer()),
    new Uint8Array([255, 216, 255, 217]),
  );
  await capture.capture();
  assert.equal(captures, 1);
  await saveFeedbackDraft('capture-owner-one', {
    category: 'bug',
    feedback: 'Synthetic saved draft',
    attachments: [{ id: randomUUID(), file: first! }],
    pendingId: null,
    reportChoice: true,
  });
  assert.equal(await createFeedbackCapture('capture-owner-one').capture(), null);
  assert.equal(captures, 1);
  const otherOwner = createFeedbackCapture('capture-owner-two');
  assert.ok(await otherOwner.capture());
  assert.equal(captures, 2);
  writeFeedbackPending('nod.feedback.pending.capture-pending-owner', randomUUID());
  assert.equal(await createFeedbackCapture('capture-pending-owner').capture(), null);
  assert.equal(captures, 2);
  await saveFeedbackDraft('capture-owner-one', null);
  capture.reset();
  assert.ok(await capture.capture());
  assert.equal(captures, 3);
  refused = true;
  capture.reset();
  assert.equal(await capture.capture(), null);
  assert.equal(await capture.capture(), null);
  assert.equal(captures, 4);
  window.nodDesktop = undefined;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      assert.fail('Web feedback must not wait for native screenshot draft storage.');
    },
  });
  assert.equal(await createFeedbackCapture('web-owner').capture(), null);
  assert.equal(captures, 4);
});
