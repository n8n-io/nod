import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';
import { createProviderUsageStore } from '../src/server/provider-usage.ts';
import {
  meterAgent,
  meterComputer,
  meterIntegrations,
  meterRelevance,
  meterSpeech,
  meterWorkspace,
} from '../src/server/provider-metering.ts';
import type { AgentEvent } from '../src/ports/agent.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { conversationRoutingFailureCodes } from '../src/ports/conversation.ts';

test(
  'routing failures remain owned and retained with Inspector disabled without enabling ordinary capture',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_routing_usage_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const firstOwner = randomUUID();
    const secondOwner = randomUUID();
    const create = (ownerId: string) =>
      createProviderUsageStore(pool, { ownerId, enabled: () => false, coverage: [] });
    const first = create(firstOwner);
    const second = create(secondOwner);
    const app = Fastify();
    let restored: ReturnType<typeof create> | undefined;
    const base: ProviderUsageEvent = {
      provider: 'openai',
      category: 'relevance',
      operation: 'conversation_route',
      model: 'fixture',
      status: 'failed',
      durationMs: 21,
    };
    const ids = conversationRoutingFailureCodes.map(() => randomUUID());
    const secondId = randomUUID();
    try {
      await pool.query('CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL)');
      await first.initialize();
      await second.initialize();
      first.registerRoutes(app);
      for (const [index, code] of conversationRoutingFailureCodes.entries()) {
        const event: ProviderUsageEvent = {
          ...base,
          id: ids[index],
          status: index % 2 ? 'cancelled' : 'failed',
          inputTokens: 12,
          routingFailure: {
            code,
            ...(index === 0 ? { httpStatus: 100 } : index === 1 ? { httpStatus: 599 } : {}),
          },
        };
        first.record(event);
        first.record(event);
      }
      first.record(base);
      first.record({ ...base, status: 'succeeded' });
      first.record({ ...base, category: 'agent', operation: 'response' });
      first.record({ ...base, operation: 'classify' });
      second.record({
        ...base,
        id: secondId,
        routingFailure: { code: 'response_processing', httpStatus: 429 },
      });
      await Promise.all([first.flush(), second.flush()]);
      const rows = (
        await pool.query(
          'SELECT id,owner_id,task_id,tool_call_id,tool_name,metrics FROM provider_usage ORDER BY id',
        )
      ).rows;
      assert.equal(rows.length, conversationRoutingFailureCodes.length + 1);
      for (const [index, code] of conversationRoutingFailureCodes.entries()) {
        const row = rows.find((row) => row.id === ids[index])!;
        assert.equal(row.owner_id, firstOwner);
        assert.equal(row.task_id, null);
        assert.equal(row.tool_call_id, null);
        assert.equal(row.tool_name, null);
        assert.deepEqual(row.metrics, {
          inputTokens: 12,
          routingFailure: {
            code,
            ...(index === 0 ? { httpStatus: 100 } : index === 1 ? { httpStatus: 599 } : {}),
          },
        });
      }
      assert.equal(rows.find((row) => row.id === secondId)?.owner_id, secondOwner);
      const owned = await first.read();
      assert.equal(owned.captureEnabled, false);
      assert.equal(owned.providers.length, 1);
      assert.equal(owned.providers[0].requests, conversationRoutingFailureCodes.length);
      assert.equal((await second.read()).providers[0].requests, 1);
      assert.equal((await app.inject('/api/inspector/providers')).statusCode, 404);
      await first.close();
      await second.close();
      await pool.query(
        "UPDATE provider_usage SET recorded_at=now()-interval '8 days' WHERE id=ANY($1::uuid[])",
        [[ids[0], secondId]],
      );
      restored = create(firstOwner);
      await restored.initialize();
      const retained = (await pool.query('SELECT id FROM provider_usage ORDER BY id')).rows;
      assert.equal(
        retained.some((row) => row.id === ids[0]),
        false,
      );
      assert.equal(
        retained.some((row) => row.id === secondId),
        true,
      );
      assert.equal(retained.length, conversationRoutingFailureCodes.length);
      assert.equal(
        (await restored.read()).providers[0].requests,
        conversationRoutingFailureCodes.length - 1,
      );
    } finally {
      await app.close();
      await Promise.all([first.close(), second.close(), restored?.close()]);
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('routing failure validation rejects extra data, wrong event scope and task or tool references', async () => {
  for (const enabled of [false, true]) {
    const writes: unknown[][] = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO provider_usage')) writes.push(values!);
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const usage = createProviderUsageStore(pool, {
      ownerId: 'fixture-owner',
      enabled: () => enabled,
      coverage: [],
    });
    const base: ProviderUsageEvent = {
      provider: 'openai',
      category: 'relevance',
      operation: 'conversation_route',
      status: 'failed',
      durationMs: 1,
      routingFailure: { code: 'invalid_json' },
    };
    const malformed = [
      { ...base, routingFailure: {} },
      { ...base, routingFailure: { code: 'private-provider-error' } },
      { ...base, routingFailure: { code: 'invalid_json', error: 'private-error' } },
      { ...base, rawError: 'private-error' },
      { ...base, headers: { authorization: 'private-secret' } },
      { ...base, category: 'agent' },
      { ...base, operation: 'classify' },
      { ...base, status: 'succeeded' },
      { ...base, taskId: randomUUID() },
      { ...base, toolCallId: randomUUID(), toolName: 'apps' },
      ...[99, 600, 401.5, Number.NaN, '429', null].map((httpStatus) => ({
        ...base,
        routingFailure: { code: 'response_processing', httpStatus },
      })),
    ];
    try {
      for (const event of malformed) usage.record(event as ProviderUsageEvent);
      usage.withTask(randomUUID(), () => usage.record(base));
      usage.withTool(randomUUID(), randomUUID(), 'apps', () => usage.record(base));
      await usage.flush();
      assert.equal(writes.length, 0);
      usage.record(base);
      await usage.flush();
      assert.equal(writes.length, 1);
      assert.deepEqual(JSON.parse(writes[0][9] as string), {
        routingFailure: { code: 'invalid_json' },
      });
      assert.doesNotMatch(JSON.stringify(writes), /private-error|private-secret/);
    } finally {
      await usage.close();
    }
  }
});

test('disabled routing diagnostics keep the pending bound and drain accepted writes on shutdown', async () => {
  let release!: () => void;
  const pruning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('DELETE')) await pruning;
      if (sql.includes('INSERT INTO provider_usage')) writes.push(values!);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'fixture-owner',
    enabled: () => false,
    coverage: [],
  });
  const event: ProviderUsageEvent = {
    provider: 'openai',
    category: 'relevance',
    operation: 'conversation_route',
    status: 'cancelled',
    durationMs: 1,
    routingFailure: { code: 'cancelled' },
  };
  for (let index = 0; index < 140; index++) usage.record(event);
  assert.equal(writes.length, 0);
  assert.equal((await usage.read()).droppedEvents, 12);
  const closing = usage.close();
  usage.record(event);
  release();
  await closing;
  assert.equal(writes.length, 128);
});

test('usage shutdown drains accepted writes and rejects late records', async () => {
  let release!: () => void;
  const pruning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operations: unknown[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      if (sql.startsWith('DELETE')) await pruning;
      if (sql.includes('INSERT INTO provider_usage')) operations.push(values?.[5]);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const event = {
    provider: 'test',
    category: 'browser' as const,
    status: 'succeeded' as const,
    operation: 'accepted',
    durationMs: 1,
  };
  usage.record(event);
  const closing = usage.close();
  usage.record({ ...event, operation: 'late' });
  release();
  await closing;
  assert.deepEqual(operations, ['accepted']);
});

test(
  'provider usage stays owned, counts all operations, preserves unknown pricing and avoids payload capture',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_usage_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const task = randomUUID(),
      foreign = randomUUID();
    let enabled = true;
    const usage = createProviderUsageStore(pool, {
      ownerId: 'owner',
      enabled: () => enabled,
      coverage: [],
    });
    const app = Fastify();
    try {
      await pool.query('CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL)');
      await pool.query('INSERT INTO tasks VALUES($1,$2),($3,$4)', [
        task,
        'owner',
        foreign,
        'other',
      ]);
      await usage.initialize();
      usage.registerRoutes(app);
      const base = {
        provider: 'openai',
        category: 'agent' as const,
        operation: 'response',
        status: 'succeeded' as const,
        durationMs: 10,
        taskId: task,
      };
      const id = randomUUID();
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, id, inputTokens: 100, costUsd: 0.01, pricing: 'sdk_estimate' });
      usage.record({ ...base, inputTokens: 25, costUsd: 100, pricing: 'unavailable' });
      usage.record({ ...base, taskId: foreign, inputTokens: 999 });
      await usage.withTask(task, () =>
        usage.track(
          { provider: 'composio', category: 'integration', operation: 'execute' },
          async () => ({ private: 'never stored' }),
        ),
      );
      await assert.rejects(
        usage.track({ provider: 'jev', category: 'relevance', operation: 'classify' }, async () => {
          throw new Error('private provider error');
        }),
      );
      await usage.flush();
      const current = await usage.read(task);
      const model = current.providers.find((row) => row.provider === 'openai')!;
      assert.equal(model.requests, 2);
      assert.equal(model.inputTokens, 125);
      assert.equal(model.costUsd, 0.01);
      assert.equal(model.pricedRequests, 1);
      assert.equal(model.pricing, 'sdk_estimate');
      assert.equal(current.providers.find((row) => row.provider === 'composio')?.costUsd, null);
      assert.equal(
        current.providers.some((row) => row.provider === 'jev'),
        false,
      );
      assert.equal(
        (await usage.read()).providers.find((row) => row.provider === 'jev')?.failures,
        1,
      );
      assert.equal(
        (await app.inject(`/api/inspector/providers?taskId=${foreign}`)).statusCode,
        404,
      );
      assert.doesNotMatch(
        JSON.stringify((await pool.query('SELECT * FROM provider_usage')).rows),
        /never stored|private provider error/,
      );
      enabled = false;
      usage.record(base);
      await usage.flush();
      assert.equal(
        (await usage.read(task)).providers.find((row) => row.provider === 'openai')?.requests,
        2,
      );
      assert.equal((await app.inject('/api/inspector/providers')).statusCode, 404);
      enabled = true;
      await pool.query("UPDATE provider_usage SET recorded_at=now()-interval '8 days'");
      assert.equal((await usage.read()).providers.length, 0);
    } finally {
      await app.close();
      await usage.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('metering covers capabilities without recording prompts, arguments, output or secrets', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const task = randomUUID();
  const events: AgentEvent[] = [];
  const agent = meterAgent(
    {
      async open(options) {
        return {
          resumed: false,
          async prompt() {
            options.onEvent({
              type: 'model_usage',
              id: randomUUID(),
              provider: 'openai',
              model: 'fixture',
              inputTokens: 4,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 6,
              costUsd: 0.1,
              costSource: 'sdk_estimate',
              createdAt: new Date().toISOString(),
            });
            options.onEvent({
              type: 'provider_usage',
              usage: {
                provider: 'openai',
                category: 'agent',
                operation: 'compaction',
                status: 'succeeded',
                durationMs: 3,
                inputTokens: 5,
              },
            });
          },
          abort() {},
          dispose() {},
        };
      },
      dispose() {},
    },
    usage,
  );
  await (
    await agent.open({
      taskId: task,
      systemPrompt: 'private prompt',
      tools: [],
      shouldStop: () => false,
      onEvent: (event) => events.push(event),
    })
  ).prompt('private text', []);
  assert.equal(events.filter((event) => event.type === 'provider_usage').length, 0);
  const speech = meterSpeech(
    {
      id: 'openai',
      configured: true,
      transcribe: async () => 'private transcript',
      synthesize: async () => ({
        bytes: Buffer.from('sound'),
        mimeType: 'audio/mpeg',
        fileName: 'reply.mp3',
      }),
    },
    usage,
  );
  await speech.synthesize('private speech');
  await speech.transcribe({
    bytes: Buffer.from('audio'),
    mimeType: 'audio/wav',
    fileName: 'private.wav',
  });
  await meterRelevance(
    { id: 'jev', configured: true, classify: async () => 'ignore' },
    usage,
  ).classify(
    { private: 'context' },
    {
      instructions: 'private policy',
      criteria: { ignore: '', digest: '', wake: '' },
      minWakeConfidence: 0.5,
    },
  );
  const integration = {
    id: 'composio',
    restoreSession: async () => ({
      id: 'private-session',
      authorize: async () => ({ accountId: 'private-account', url: 'https://secret.example' }),
      search: async () => ({ tools: [], suggestions: [] }),
      execute: async () => ({ private: 'result' }),
    }),
  } as unknown as IntegrationProvider;
  await (
    await meterIntegrations(integration, usage).restoreSession('private-session')
  ).execute('ACTION', { secret: 'private-credential' }, 'private-account');
  await usage.flush();
  assert.deepEqual(
    rows.map((row) => row[5]).sort(),
    [
      'response',
      'compaction',
      'synthesize',
      'transcribe',
      'classify',
      'restore_session',
      'execute',
    ].sort(),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private|secret\.example/);
});

test('slow recording is bounded and never holds a provider operation', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('SELECT provider')) return { rows: [] };
      await gate;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  for (let index = 0; index < 140; index++)
    usage.record({
      provider: 'fixture',
      category: 'browser',
      operation: 'snapshot',
      status: 'succeeded',
      durationMs: 1,
    });
  assert.equal(
    await usage.track(
      { provider: 'fixture', category: 'relevance', operation: 'classify' },
      async () => 'ready',
    ),
    'ready',
  );
  assert.ok((await usage.read()).droppedEvents > 0);
  release();
  await usage.close();
});

test('usage retention prunes idle disabled capture on startup and hourly, then stops on close', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-09-25T10:00:00Z') });
  let deletes = 0;
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('DELETE')) deletes++;
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const store = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => false,
    coverage: [],
  });
  await store.initialize();
  assert.equal(deletes, 1);
  t.mock.timers.tick(3_600_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(deletes, 2);
  await store.close();
  t.mock.timers.tick(3_600_000);
  assert.equal(deletes, 2);
});

test('workspace attachment reads and publications use distinct usage operations without file data', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const workspace = meterWorkspace(
    fakeWorkspace({ readArtifact: async () => Buffer.from('private-file-bytes') }),
    usage,
  );
  try {
    for (const purpose of ['attachment', 'publication', undefined] as const)
      await workspace.readArtifact!(randomUUID(), 'private-file-path', 50, purpose);
  } finally {
    await usage.close();
  }
  assert.deepEqual(rows.map((row) => row[5]).sort(), [
    'publish_file',
    'read_attachment',
    'read_file',
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /private-file-path|private-file-bytes/);
});

test('connected CLI usage records nonzero exits as failures', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  let exitCode = 0;
  const workspace = meterWorkspace(
    fakeWorkspace({
      open: () => ({
        path: '/fixture/workspace',
        instructions: 'Fixture workspace.',
        execute: async () => '',
        readFile: async () => '',
        writeFile: async () => '',
        executeProgram: async () => ({ exitCode, output: '' }),
      }),
    }),
    usage,
  );
  try {
    const session = workspace.open({
      taskId: randomUUID(),
      workspacePath: '/fixture/workspace',
      signal: new AbortController().signal,
    });
    await session.executeProgram!('fixture', ['read'], {});
    exitCode = 1;
    await session.executeProgram!('fixture', ['write'], {});
  } finally {
    await usage.close();
  }
  assert.deepEqual(
    rows.map((row) => [row[5], row[7]]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      ['execute', 'failed'],
      ['execute', 'succeeded'],
    ],
  );
});

test('standalone browser control records owner usage without a synthetic task association', async () => {
  const rows: unknown[][] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO provider_usage')) rows.push(values!);
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  const usage = createProviderUsageStore(pool, {
    ownerId: 'owner',
    enabled: () => true,
    coverage: [],
  });
  const computer = meterComputer(
    fakeComputer({
      openSignIn: async () => {},
      finishSignIn: async () => {},
      releaseControl: async () => {},
    }),
    usage,
  );
  try {
    const standalone = 'manual-' + 'a'.repeat(32);
    const task = randomUUID();
    await computer.openSignIn!(standalone);
    await computer.releaseControl!(standalone);
    await computer.openSignIn!(task);
    await computer.finishSignIn!(task);
    await computer.releaseControl!(task);
    await usage.flush();
    assert.deepEqual(
      new Set(rows.map((row) => [row[2], row[5]])),
      new Set([
        [null, 'open_sign_in'],
        [null, 'release_control'],
        [task, 'open_sign_in'],
        [task, 'finish_sign_in'],
        [task, 'release_control'],
      ]),
    );
    assert.doesNotMatch(JSON.stringify(rows), /manual-/);
  } finally {
    await usage.close();
  }
});
