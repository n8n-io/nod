import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, snapshotAnalytics } from '../src/server/analytics.ts';
import {
  accessCookie,
  accessKey,
  credentialRequestKey,
  registerLocalAccess,
} from '../src/server/access.ts';
import { appConfirmation } from '../src/ports/agent.ts';
import type { ApprovalDescription, ApprovalExecutionContext } from '../src/server/approvals.ts';
import { serverNetwork } from '../src/server/network.ts';

test('server configuration refuses remote exposure without a valid token and an exact secure public origin', () => {
  const key = randomBytes(32).toString('base64url');
  for (const environment of [
    { NOD_HOST: '0.0.0.0' },
    { NOD_HOST: '::' },
    { NOD_HOST: '192.0.2.1' },
    { NOD_PUBLIC_URL: 'https://nod.example' },
    { NOD_AUTH_TOKEN: '' },
    { NOD_AUTH_TOKEN: key.slice(1) },
    { NOD_AUTH_TOKEN: `${key}\n` },
    { NOD_HOST: 'attacker.example', NOD_AUTH_TOKEN: key },
    ...['0', '-1', '65536', '4310.5', 'not-a-port', ''].map((PORT) => ({ PORT })),
  ])
    assert.throws(() => serverNetwork(environment));
  for (const NOD_PUBLIC_URL of [
    '',
    'http://nod.example',
    'http://192.0.2.1:4310',
    'http://127.0.0.2:4310',
    'https://user:password@nod.example',
    'https://nod.example/assistant',
    'https://nod.example?token=secret',
    'https://nod.example#token',
    'https://nod.example/../',
    ' https://nod.example',
    'https://nod.example\n',
    'file:///tmp/nod',
  ])
    assert.throws(() => serverNetwork({ NOD_PUBLIC_URL, NOD_AUTH_TOKEN: key }));
  const remote = serverNetwork({
    PORT: '8080',
    NOD_HOST: '0.0.0.0',
    NOD_PUBLIC_URL: 'https://nod.example:8443/',
    NOD_AUTH_TOKEN: key,
  });
  assert.equal(remote.host, '0.0.0.0');
  assert.equal(remote.port, 8080);
  assert.equal(remote.publicOrigin, 'https://nod.example:8443');
  assert.equal(remote.accessOrigin, remote.publicOrigin);
  assert.equal(remote.authToken, key);
  for (const NOD_PUBLIC_URL of [
    'http://localhost:4310',
    'http://127.0.0.1:4310',
    'http://[::1]:4310',
  ])
    assert.equal(serverNetwork({ NOD_PUBLIC_URL }).publicOrigin, NOD_PUBLIC_URL);
  assert.equal(serverNetwork({}).accessOrigin, undefined);
  assert.equal(serverNetwork({ NOD_DESKTOP: 'true', NOD_AUTH_TOKEN: '' }).authToken, undefined);
});

test('remote access authenticates cookies and bearer clients only on the configured origin and host', async (t) => {
  const key = randomBytes(32).toString('base64url');
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key, origin: 'https://nod.example', bearer: true });
  app.get('/api/fixture', async () => ({ private: true }));
  app.post('/api/fixture', async () => ({ private: true }));
  app.post('/api/webhooks/telegram', async () => ({ ok: true }));
  const authorized = { host: 'nod.example', authorization: `Bearer ${key}` };
  for (const method of ['GET', 'POST'] as const) {
    assert.equal(
      (await app.inject({ method, url: '/api/fixture', headers: { host: 'nod.example' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method, url: '/api/fixture', headers: authorized })).statusCode,
      200,
    );
  }
  for (const headers of [
    { ...authorized, host: 'localhost:4310' },
    { ...authorized, host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
    { ...authorized, origin: 'http://nod.example' },
    { ...authorized, origin: 'https://attacker.example' },
    { ...authorized, origin: 'https://nod.example/path' },
    { ...authorized, origin: 'https://nod.example/' },
    { ...authorized, origin: 'null' },
    { ...authorized, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
      403,
    );
  for (const authorization of ['Bearer wrong', `Basic ${key}`, `Bearer ${key} trailing`])
    assert.equal(
      (
        await app.inject({
          url: '/api/fixture',
          headers: { ...authorized, authorization, cookie: `${accessCookie(4310)}=${key}` },
        })
      ).statusCode,
      401,
    );
  const signedIn = await app.inject({
    method: 'POST',
    url: '/api/access',
    headers: { host: 'nod.example', origin: 'https://nod.example' },
    payload: { key },
  });
  assert.equal(signedIn.statusCode, 204);
  assert.equal(signedIn.body, '');
  const cookie = String(signedIn.headers['set-cookie']);
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/);
  assert.equal(
    (
      await app.inject({
        url: '/api/fixture',
        headers: { host: 'nod.example', cookie: cookie.split(';')[0]! },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/access',
        headers: { host: 'nod.example', origin: 'https://attacker.example' },
        payload: { key },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { host: 'nod.example' },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
      })
    ).statusCode,
    403,
  );
  const rotated = Fastify();
  t.after(() => rotated.close());
  registerLocalAccess(rotated, 4310, {
    key: randomBytes(32).toString('base64url'),
    origin: 'https://nod.example',
    bearer: true,
  });
  rotated.get('/api/fixture', async () => ({ private: true }));
  for (const headers of [authorized, { host: 'nod.example', cookie: cookie.split(';')[0]! }])
    assert.equal((await rotated.inject({ url: '/api/fixture', headers })).statusCode, 401);
});

test('localhost access requires the owner key and rejects foreign Host, Origin and cross-site requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nod-access-'));
  const app = Fastify();
  try {
    const key = await accessKey(root);
    assert.equal(await accessKey(root), key);
    assert.equal((await stat(join(root, 'access-key'))).mode & 0o777, 0o600);
    await chmod(join(root, 'access-key'), 0o644);
    assert.equal(await accessKey(root), key);
    assert.equal((await stat(join(root, 'access-key'))).mode & 0o777, 0o600);
    const requestKeys = await Promise.all(
      Array.from({ length: 4 }, () => credentialRequestKey(root)),
    );
    assert.equal(new Set(requestKeys).size, 1);
    assert.equal(requestKeys[0] === key, false);
    assert.equal((await stat(join(root, 'credential-request-key'))).mode & 0o777, 0o600);
    registerLocalAccess(app, 4310, { key });
    app.post('/api/fixture', async () => ({ ok: true }));
    app.get('/api/privacy', async () => ({ content: null }));
    const settingsPages = ['/settings', '/settings/models', '/settings/apps', '/settings/memory'];
    for (const path of settingsPages) app.get(path, async () => 'nod');
    app.get('/api/settings', async () => ({ private: true }));
    const navigation = {
      host: 'localhost:4310',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    for (const path of settingsPages) {
      assert.equal((await app.inject({ url: path, headers: navigation })).statusCode, 200);
      assert.equal(
        (await app.inject({ url: path, headers: { ...navigation, 'sec-fetch-mode': 'cors' } }))
          .statusCode,
        403,
      );
    }
    for (const path of ['/settings/unknown', '/settings-typo'])
      assert.equal((await app.inject({ url: path, headers: navigation })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/settings', headers: navigation })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: '/api/settings',
          headers: { ...navigation, cookie: `nod-access-4310=${key}` },
        })
      ).statusCode,
      403,
    );
    const cookie = `nod-access-4310=${key}`;
    for (const headers of [
      { host: 'attacker.example:4310', cookie },
      { host: 'localhost:4311', cookie },
      { host: 'localhost:4310', cookie, origin: 'https://attacker.example' },
      { host: 'localhost:4310', cookie, origin: 'null' },
      { host: 'localhost:4310', cookie, origin: 'https://localhost:4310' },
      { host: 'localhost:4310', cookie, 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        403,
      );
    for (const headers of [
      { host: 'localhost:4310' },
      { host: 'localhost:4310', origin: 'http://localhost:4310' },
      {
        host: 'localhost:4310',
        cookie: `nod-access-4310=${randomBytes(32).toString('base64url')}`,
      },
      { host: 'localhost:4310', cookie: `nod-access-4311=${key}` },
      { host: 'localhost:4310', cookie: `nod-access-4310=${requestKeys[0]}` },
      { host: 'localhost:4310', 'x-nod-desktop-token': key },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        401,
      );
    assert.equal(
      (await app.inject({ url: '/api/privacy', headers: { host: 'localhost:4310' } })).statusCode,
      200,
    );
    const exchange = (candidate: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/access',
        headers: { host: 'localhost:4310', origin: 'http://localhost:4310', ...headers },
        payload: { key: candidate },
      });
    for (const rejected of [
      await exchange(key.slice(1)),
      await exchange(randomBytes(32).toString('base64url')),
    ]) {
      assert.equal(rejected.statusCode, 401);
      assert.equal(rejected.headers['set-cookie'], undefined);
    }
    assert.equal((await exchange(key, { origin: 'https://attacker.example' })).statusCode, 403);
    const accepted = await exchange(key);
    assert.equal(accepted.statusCode, 204);
    const issued = String(accepted.headers['set-cookie']);
    assert.match(issued, /HttpOnly/);
    assert.match(issued, /SameSite=Strict/);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fixture',
          headers: { host: 'localhost:4310', cookie: issued.split(';')[0]! },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'approvals preserve explicit-request authority, execute confirmed snapshots once and fence owners',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'nod-approvals-')));
    const previousDirectory = process.cwd();
    process.chdir(fixtureRoot);
    t.after(async () => {
      process.chdir(previousDirectory);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_approvals_${suffix}`;
    const bossSchema = `test_approvals_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const { transaction } = await import('../src/server/transaction.ts');
    const thread = await import('../src/server/thread.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const artifacts = (await import('../src/server/artifacts.ts')).localArtifacts;
    const { createApp } = await import('../src/server/app.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    assert.equal(dataRoot, join(fixtureRoot, '.local'));
    let messages: ReturnType<typeof thread.createUserMessageService>;
    const app = await createApp({
      submitMessage: (text, attachments, options) => messages.submit(text, attachments, options),
      configuration: () => configuration({ llmReady: true }),
    });
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    const calls: Array<{
      action: string;
      args: Record<string, unknown>;
      context: ApprovalExecutionContext;
    }> = [];
    let failExecution = false;
    let rejectPreflight = false;
    let executionGate: Promise<void> | undefined;
    let executionResult: (() => unknown) | undefined;
    let descriptionFailure = false;
    const defaultDescription = async () => 'Synthetic approval question.';
    let describe: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<string> =
      defaultDescription;
    const directories: string[] = [];
    let approvals: Awaited<ReturnType<typeof createApprovals>>;
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: { ...headers, 'content-type': 'application/json' },
            }),
      });

    const row = async (turnId: string) =>
      (await db.pool.query('SELECT * FROM turns WHERE id=$1', [turnId])).rows[0];
    const turnStatus = async (turnId: string) => (await row(turnId)).status;
    const running = async (turnId: string) => {
      await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
        turnId,
      ]);
      return { threadId: (await thread.activeThread()).id, turnId };
    };
    const begin = async (
      prompt: string,
      options: { channel?: string; source?: 'event' | 'schedule' } = {},
    ) => {
      if (options.source)
        return running(await thread.enqueueTurn(prompt, { source: options.source }));
      const submitted = await thread.submitUserMessage(prompt, [], { channel: options.channel });
      return running(submitted.turnId);
    };
    const finish = (turnId: string, status = 'waiting') =>
      db.pool.query('UPDATE turns SET status=$2,finished_at=now() WHERE id=$1', [turnId, status]);
    const proposal = async (turnId: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE turn_id=$1', [turnId])).rows[0];
    const assistantMessages = async (turnId: string) =>
      (
        await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
          turnId,
        ])
      ).rowCount;
    const confirmTurn = async (turnId: string, text = 'Yes.') => {
      await finish(turnId);
      return messages.submit(text, [], {
        replyToMessageId: (await proposal(turnId)).confirmation_message_id,
      });
    };

    const newTurn = async (status = 'running', text = 'Synthetic boundary fixture') => {
      const submitted = await thread.submitUserMessage(text);
      await db.pool.query('UPDATE turns SET status=$2 WHERE id=$1', [submitted.turnId, status]);
      return submitted;
    };
    const stored = async (id: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE id=$1', [id])).rows[0];
    async function propose(
      turn: { threadId: string; turnId: string },
      action: string,
      args: Record<string, unknown>,
    ) {
      const result = await approvals.request(turn, action, args);
      assert.ok(result && typeof result === 'object' && appConfirmation in result);
      assert.equal('url' in result, false);
      const record = (
        await db.pool.query(
          'SELECT * FROM approvals WHERE turn_id=$1 AND action=$2 AND args=$3::jsonb',
          [turn.turnId, action, JSON.parse(JSON.stringify(args))],
        )
      ).rows[0];
      assert.ok(record.confirmation_message_id);
      return record.id as string;
    }
    async function confirm(id: string, approved: boolean, extra: Record<string, unknown> = {}) {
      const record = await stored(id);
      const input = {
        text: approved ? 'Yes' : 'No',
        channel: 'web',
        threadId: record.thread_id,
        replyToMessageId: record.confirmation_message_id,
        clientMessageId: randomUUID(),
        ...extra,
      };
      const answer = await approvals.chat.answer(input);
      const result = await transaction(
        (client) => approvals.chat.accept(client, { ...input, answer }),
        db.pool,
      );
      return result;
    }
    async function execute(id: string, signal = new AbortController().signal) {
      const record = await stored(id);
      await db.pool.query("UPDATE turns SET status='running' WHERE id=$1 AND status='queued'", [
        record.execution_turn_id,
      ]);
      return approvals.executeConfirmed(record.execution_turn_id, signal);
    }
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await personal.initialize({ workers: false });
      const approved = await createApprovals(
        async (action, args, context) => {
          calls.push({ action, args, context });
          if (executionGate) await executionGate;
          if (failExecution) throw new Error('Fixture provider detail must not be exposed.');
          if (executionResult) return executionResult();
          return { successful: true, id: 'fixture-provider-result' };
        },
        async () => {
          if (rejectPreflight)
            throw Object.assign(new Error('Fixture account disconnected.'), { statusCode: 409 });
        },
        (reply) => trust.answer(reply),
        async (proposal, signal) => {
          if (descriptionFailure) throw new Error('Synthetic confirmation model failure.');
          return describe(proposal, signal);
        },
      );
      const checked = (base: typeof approved): typeof approved => ({
        ...base,
        request: async (turn, action, args, options = {}) =>
          base.request(turn, action, args, {
            ...options,
            allowed: options.allowed ?? !(await trust.check(turn, action, args)).confirm,
          }),
      });
      approvals = checked(approved);
      messages = thread.createUserMessageService({
        confirmAction: approvals.chat,
        taskReply: (client, threadId, messageId) => tasks.resolveReply(client, threadId, messageId),
      });
      personal.registerRoutes(app);
      const tasks = createTasks({ pool: db.pool, ownerId });
      await tasks.initialize();
      tasks.registerRoutes(app);
      app.get('/api/fixture-error', async () => {
        throw new Error('fixture-private-key');
      });

      const { createTrust } = await import('../src/server/trust.ts');
      const reviews: Array<Record<string, any>> = [];
      const prompts: string[] = [];
      let duringReview: () => Promise<void> = async () => {};
      let aligned:
        boolean | string | ((input: Record<string, any>) => boolean | Record<string, unknown>) =
        false;
      let ruled = false;
      const cite = (input: Record<string, any>) =>
        input.userMessages?.at(-1)?.text ??
        input.scheduledTaskInstruction ??
        input.standingInstruction ??
        input.userRules ??
        'read';
      t.beforeEach(() => {
        aligned = false;
        ruled = false;
        duringReview = async () => {};
      });
      const replies: object[] = [];
      const replyAnswers: Record<string, string> = {
        yes: 'yes',
        'yes please': 'yes',
        sim: 'yes',
        no: 'no',
        cancel: 'no',
      };
      const trust = createTrust({
        pool: db.pool,
        ownerId,
        review: async (instructions, input) => {
          if ('reply' in input) {
            replies.push(input);
            const reply = String(input.reply)
              .replace(/[.!]+$/, '')
              .toLowerCase();
            if (replyAnswers[reply] === 'fail') throw new Error('Synthetic reader outage.');
            return { answer: replyAnswers[reply] ?? 'other' };
          }
          reviews.push(input as Record<string, any>);
          prompts.push(instructions);
          await duringReview();
          const yes =
            typeof aligned === 'function' ? aligned(input as Record<string, any>) : aligned;
          if (yes && typeof yes === 'object') return yes;
          return {
            run: yes,
            ...(yes === true ? { because: cite(input) } : {}),
            ...(ruled ? { rule: true } : {}),
          };
        },
      });
      const email = (to: string) => ({
        recipient_email: to,
        subject: 'Synthetic update',
        body: 'Synthetic body.',
      });
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      await t.test(
        'one authorization review preserves the original instructions and executed arguments',
        async () => {
          const turn = await begin(
            'Email Ana at ana@example.test: EUR 1,200, due at the end of November 2026.',
          );
          const args = {
            ...email('ana@example.test'),
            connectionId: randomUUID(),
            body: '1.200,00 EUR, a finales de noviembre de 2026.',
          };
          const original = structuredClone(args);
          const before = calls.length;
          const primary = reviews.length;
          aligned = true;
          try {
            await approvals.request(turn, 'GMAIL_SEND_EMAIL', args);
            assert.equal(reviews.length, primary + 1);
            assert.deepEqual(reviews.at(-1)!.action, {
              name: 'GMAIL_SEND_EMAIL',
              arguments: original,
            });
            assert.equal(calls.length, before + 1);
            assert.deepEqual(calls.at(-1)!.args, original);
            assert.deepEqual(args, original);
            assert.equal(await proposal(turn.turnId), undefined);
          } finally {
            await finish(turn.turnId, 'succeeded');
          }
        },
      );

      await t.test('a quoted permission cannot override a reported term mismatch', async () => {
        const turn = await begin('Email Ana the invoice for EUR 1200.');
        try {
          for (const terms of [
            null,
            {},
            [false],
            [{ user: 'EUR 1200', action: 'EUR 1300', same: false }],
            [{ user: 'EUR 1200', action: 'EUR 1200', same: 'true' }],
          ]) {
            aligned = (input) => ({ run: true, because: cite(input), terms });
            assert.equal(
              (
                await trust.check(turn, 'GMAIL_SEND_EMAIL', {
                  ...email('ana@example.test'),
                  body: 'Invoice EUR 1300.',
                })
              ).confirm,
              true,
            );
          }
          aligned = (input) => ({
            run: true,
            because: cite(input),
            terms: [{ user: 'EUR 1200', action: 'EUR 1200', same: true }],
          });
          assert.equal(
            (
              await trust.check(turn, 'GMAIL_SEND_EMAIL', {
                ...email('ana@example.test'),
                body: 'Invoice EUR 1200.',
              })
            ).confirm,
            false,
          );
        } finally {
          await finish(turn.turnId, 'cancelled');
        }
      });

      await t.test('a stopped turn cannot use an awaited authorization result', async () => {
        for (const status of ['cancelled', 'succeeded']) {
          for (const action of ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS']) {
            const turn = await begin('Send the agreed invoice to ana@example.test.');
            const entered = deferred();
            const release = deferred();
            aligned =
              action === 'GMAIL_FETCH_EMAILS' ? () => ({ run: true, because: 'read' }) : true;
            duringReview = async () => {
              entered.resolve();
              await release.promise;
            };
            const before = calls.length;
            const outcome = approvals.request(turn, action, email('ana@example.test')).then(
              () => undefined,
              (error: unknown) => error,
            );
            await entered.promise;
            await finish(turn.turnId, status);
            release.resolve();
            assert.ok((await outcome) instanceof Error);
            assert.equal(calls.length, before);
            assert.equal(await proposal(turn.turnId), undefined);
          }
        }
      });

      await t.test(
        'owner corrections and changed rules reject stale proposals without asking for them',
        async () => {
          aligned = true;
          const preferences = (
            await db.pool.query(
              'SELECT notification_rule,rules FROM preferences WHERE owner_id=$1',
              [ownerId],
            )
          ).rows[0];
          try {
            for (const change of ['owner', 'rule', 'standing'] as const) {
              await db.pool.query(
                'INSERT INTO preferences(owner_id,notification_rule,rules) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET notification_rule=EXCLUDED.notification_rule,rules=EXCLUDED.rules',
                [ownerId, 'Email Ana when a synthetic invoice arrives.', ''],
              );
              const turn = await begin(
                'Email Ana the EUR 1,200 invoice.',
                change === 'standing' ? { source: 'event' } : {},
              );
              const entered = deferred();
              const release = deferred();
              duringReview = async () => {
                entered.resolve();
                await release.promise;
              };
              const before = calls.length;
              const outcome = approvals
                .request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'))
                .then(
                  () => undefined,
                  (error: unknown) => error,
                );
              await entered.promise;
              if (change === 'owner') {
                const correction = await thread.submitUserMessage(
                  'Correction: do not send that invoice.',
                );
                await finish(correction.turnId, 'cancelled');
              } else {
                await db.pool.query(
                  `UPDATE preferences SET ${change === 'rule' ? 'rules' : 'notification_rule'}=$2 WHERE owner_id=$1`,
                  [ownerId, 'Ask me before sending any invoice.'],
                );
              }
              release.resolve();
              assert.ok((await outcome) instanceof Error);
              assert.equal(calls.length, before);
              assert.equal(await proposal(turn.turnId), undefined);
              await finish(turn.turnId, 'cancelled');
            }
          } finally {
            await db.pool.query(
              'UPDATE preferences SET notification_rule=$2,rules=$3 WHERE owner_id=$1',
              [ownerId, preferences?.notification_rule ?? '', preferences?.rules ?? ''],
            );
          }
        },
      );

      await t.test(
        'authorization ignores unrelated task messages and detects replies to its own task',
        async (t) => {
          const parent = await begin('Email Ana the fixture invoice for EUR 1,200.');
          const task = (await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Invoice delivery',
              message: 'Preparing the fixture invoice.',
              doneWhen: 'Invoice sent',
              now: 'Preparing',
            },
            (await row(parent.turnId)).message_id,
          )) as { id: string; messageId: string };
          t.after(async () => {
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const turn = await running(
            (
              await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
                task.id,
              ])
            ).rows[0].id,
          );
          await tasks.inherit(turn);
          aligned = true;
          for (const own of [false, true]) {
            const entered = deferred();
            const release = deferred();
            duringReview = async () => {
              entered.resolve();
              await release.promise;
            };
            const before = calls.length;
            const outcome = approvals
              .request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'))
              .then(
                (result) => ({ result }),
                (error: unknown) => ({ error }),
              );
            await entered.promise;
            const update = await messages.submit(
              own
                ? 'Correction: do not send this invoice.'
                : 'Send a separate hotel request to hotel@example.test.',
              [],
              own ? { replyToMessageId: task.messageId } : {},
            );
            release.resolve();
            const result = await outcome;
            if (own) {
              assert.ok('error' in result && result.error instanceof Error);
              assert.equal(calls.length, before);
              assert.equal(await proposal(turn.turnId), undefined);
            } else {
              assert.ok('result' in result);
              assert.equal(calls.length, before + 1);
              assert.equal(
                reviews
                  .at(-1)!
                  .userMessages.some((message: { text: string }) =>
                    message.text.includes('hotel@example.test'),
                  ),
                false,
              );
            }
            await finish(update.turnId, 'cancelled');
          }
          aligned = false;
          let described: ApprovalDescription | undefined;
          describe = async (proposal) => {
            described = proposal;
            return defaultDescription();
          };
          await approvals.request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
          describe = defaultDescription;
          assert.deepEqual(described?.work, {
            kind: 'task',
            title: 'Invoice delivery',
            ownerRequest: 'Email Ana the fixture invoice for EUR 1,200.',
          });
        },
      );

      await t.test(
        'caller mutation during the final context read cannot change the reviewed action',
        async () => {
          const turn = await begin('Email Ana the unchanged fixture invoice.');
          const entered = deferred();
          const release = deferred();
          let preferenceReads = 0;
          const pool = new Proxy(db.pool, {
            get(target, property) {
              if (property === 'query')
                return async (...args: Parameters<typeof db.pool.query>) => {
                  if (
                    typeof args[0] === 'string' &&
                    args[0].includes('SELECT notification_rule,rules') &&
                    ++preferenceReads === 2
                  ) {
                    entered.resolve();
                    await release.promise;
                  }
                  return target.query(...args);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const checking = createTrust({
            pool,
            ownerId,
            review: async (_instructions, input) => ({ run: true, because: cite(input) }),
          });
          const args = email('ana@example.test');
          const before = calls.length;
          const outcome = checking
            .check(turn, 'GMAIL_SEND_EMAIL', args)
            .then((verdict) =>
              approved.request(turn, 'GMAIL_SEND_EMAIL', args, { allowed: !verdict.confirm }),
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          await entered.promise;
          args.recipient_email = 'unreviewed@example.test';
          release.resolve();
          assert.ok((await outcome) instanceof Error);
          assert.equal(calls.length, before);
          assert.equal(await proposal(turn.turnId), undefined);
          await finish(turn.turnId, 'cancelled');
        },
      );
      await t.test(
        'onboarding reads require a strict decision and retain owner rules without message authority',
        async () => {
          await db.pool.query(
            'INSERT INTO preferences(owner_id,rules) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET rules=EXCLUDED.rules',
            [ownerId, 'Ask before reading private project documents.'],
          );
          const schema = { description: 'Read existing records', inputSchema: { type: 'object' } };
          const args = { connectionId: randomUUID(), tool: 'records_list', input: { limit: 5 } };
          aligned = () => ({ run: true, because: 'read' });
          assert.equal(
            await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
            false,
          );
          assert.deepEqual(reviews.at(-1), {
            action: { name: 'CONNECTED_MCP_CALL', arguments: args, schema },
            userRules: 'Ask before reading private project documents.',
          });
          for (const decision of [{ readOnly: false }, { readOnly: 'true' }, { run: true }, {}]) {
            aligned = () => decision;
            assert.equal(
              await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
              false,
            );
          }
          aligned = () => ({ readOnly: true });
          assert.equal(
            await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
            true,
          );
          const before = reviews.length;
          await assert.rejects(
            trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.abort()),
          );
          assert.equal(reviews.length, before);
          await db.pool.query("UPDATE preferences SET rules='' WHERE owner_id=$1", [ownerId]);
        },
      );
      await t.test(
        'decision action checks retain owner evidence, confirmation and action locks',
        async () => {
          const text = 'Email Ana the synthetic report.';
          const turn = await begin(text);
          let output: unknown;
          let mutate = false;
          const args = email('ana@example.test');
          const checking = createTrust({
            pool: db.pool,
            ownerId,
            review: async () => assert.fail('A decision check must not switch to an LLM.'),
            decisions: {
              check: async ({ instructions, input, question, additionalQuestions }) => {
                assert.equal(question.name, 'trust');
                assert.equal(
                  additionalQuestions?.find(({ name }) => name === 'permission')?.minProbability,
                  0.99,
                );
                assert.doesNotMatch(instructions, /Reply with only JSON/);
                const messages = (input as { userMessages: Array<{ text: string }> }).userMessages;
                const index = messages.findIndex((message) => message.text === text);
                assert.ok(index >= 0);
                assert.ok(question.choices.some(({ value }) => value === `message:${index}`));
                assert.deepEqual((input as { action: unknown }).action, {
                  name: 'GMAIL_SEND_EMAIL',
                  arguments: { ...args },
                });
                if (mutate) args.recipient_email = 'other@example.test';
                if (output instanceof Error) throw output;
                const answer = output ?? { trust: `message:${index}` };
                return {
                  ...(answer as object),
                  probability: 1,
                  additional: {
                    ...Object.fromEntries(
                      (additionalQuestions ?? [])
                        .filter(({ name }) => !['permission', 'preparation'].includes(name))
                        .map(({ name }) => [name, { choice: name === 'scope', probability: 1 }]),
                    ),
                    permission: {
                      permission: (answer as { trust?: unknown }).trust !== 'ask',
                      choice: (answer as { trust?: unknown }).trust !== 'ask',
                      probability: 1,
                    },
                    preparation: { preparation: false, probability: 1 },
                  },
                };
              },
            },
          });
          const allowed = await checking.check(turn, 'GMAIL_SEND_EMAIL', args);
          assert.equal(allowed.confirm, false);
          if (!allowed.confirm) {
            assert.equal(allowed.basis.kind, 'message');
            if (allowed.basis.kind === 'message')
              assert.equal(allowed.basis.quote, text.slice(0, -1));
          }
          for (const value of [
            { trust: 'ask' },
            { trust: 'message:999' },
            { trust: 'assistant' },
            { run: true, because: text },
            new Error('Synthetic outage.'),
          ]) {
            output = value;
            assert.equal((await checking.check(turn, 'GMAIL_SEND_EMAIL', args)).confirm, true);
          }
          output = undefined;
          mutate = true;
          await assert.rejects(checking.check(turn, 'GMAIL_SEND_EMAIL', args), /action changed/);
          await finish(turn.turnId, 'cancelled');
        },
      );
      const askFor = async (turn: { threadId: string; turnId: string }, args: object) => {
        const verdict = await trust.check(turn, 'GMAIL_SEND_EMAIL', { ...args });
        assert.equal(verdict.confirm, true);
        return approvals.request(
          turn,
          'GMAIL_SEND_EMAIL',
          { ...args },
          { allowed: false, details: { reason: verdict.confirm ? verdict.reason : 'unrequested' } },
        );
      };

      await t.test(
        'the checker sees only the owner words and the action, fails closed, and a past confirmation never skips it',
        async () => {
          const turn = await begin('Summarise my inbox.');
          await trust.check(turn, 'GMAIL_FETCH_EMAILS', {});
          assert.deepEqual(
            Object.keys(reviews.at(-1)!).filter(
              (key) =>
                ![
                  'userMessages',
                  'assistantMessageBeforeLatestUserMessage',
                  'action',
                  'timeZone',
                ].includes(key),
            ),
            [],
          );
          assert.equal(reviews.at(-1)?.userMessages.at(-1).text, 'Summarise my inbox.');
          assert.equal(reviews.at(-1)?.timeZone, 'UTC');
          await db.pool.query(
            "UPDATE preferences SET time_zone='Europe/Madrid' WHERE owner_id=$1",
            [ownerId],
          );
          await trust.check(turn, 'GMAIL_FETCH_EMAILS', {});
          assert.equal(reviews.at(-1)?.timeZone, 'Europe/Madrid');
          await db.pool.query('UPDATE preferences SET time_zone=NULL WHERE owner_id=$1', [ownerId]);
          await trust.check(turn, 'GMAIL_SEND_EMAIL', email('stranger@example.test'));
          assert.match(JSON.stringify(reviews.at(-1)?.action), /stranger@example\.test/);
          aligned = () => {
            throw new Error('Synthetic checker failure.');
          };
          assert.deepEqual(await trust.check(turn, 'GMAIL_FETCH_EMAILS', {}), {
            confirm: true,
            reason: 'unrequested',
          });
          for (const loose of ['read', 'requested', 'true', 'yes']) {
            aligned = loose;
            assert.equal((await trust.check(turn, 'GMAIL_FETCH_EMAILS', {})).confirm, true);
          }
          aligned = false;
          await askFor(turn, email('stranger@example.test'));
          await confirmTurn(turn.turnId);
          await execute((await proposal(turn.turnId)).id);
          const reviewed = reviews.length;
          const later = await begin('Summarise my inbox again.');
          assert.deepEqual(
            await trust.check(later, 'GMAIL_SEND_EMAIL', email('stranger@example.test')),
            { confirm: true, reason: 'unrequested' },
          );
          assert.equal(reviews.length, reviewed + 1);
        },
      );

      await t.test(
        'background work shows the checker only the standing instruction, and a scheduled run only its instruction',
        async () => {
          const setRule = (rule: string) =>
            db.pool.query(
              `INSERT INTO preferences(owner_id,notification_rule) VALUES($1,$2)
               ON CONFLICT(owner_id) DO UPDATE SET notification_rule=EXCLUDED.notification_rule`,
              [ownerId, rule],
            );
          await setRule('');
          aligned = false;
          const event = await begin('Synthetic event', { source: 'event' });
          assert.deepEqual(
            await trust.check(event, 'GMAIL_SEND_EMAIL', email('ana.named@example.test')),
            { confirm: true, reason: 'background' },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          assert.equal(reviews.at(-1)?.scheduledTaskInstruction, undefined);
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          const standing = 'Whenever Ana sends an invoice, forward it to accounting@example.test.';
          await setRule(standing);
          aligned = (input) => input.standingInstruction === standing;
          assert.deepEqual(
            await trust.check(event, 'GMAIL_FORWARD_MESSAGE', {
              message_id: 'synthetic-invoice',
              recipient_email: 'accounting@example.test',
            }),
            { confirm: false, basis: { kind: 'standing', quote: standing.slice(0, -1) } },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          await trust.check(await begin('Check my inbox.'), 'GMAIL_FETCH_EMAILS', {});
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          const scheduled = await begin('Synthetic scheduled work', { source: 'schedule' });
          assert.deepEqual(
            await trust.check(scheduled, 'GOOGLECALENDAR_PATCH_EVENT', {
              event_id: 'synthetic-shared',
              start_time: '10:00',
            }),
            { confirm: true, reason: 'schedule' },
          );
          const instruction = 'Every Monday, move the synthetic standup to 10:00.';
          const authorized = await begin('Synthetic scheduled work', { source: 'schedule' });
          const scheduleId = randomUUID();
          await db.pool.query(
            `INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone,kind)
             VALUES($1,$2,'Synthetic standup','Move the synthetic standup.','0 7 * * 1','Europe/Madrid','recurring')`,
            [scheduleId, ownerId],
          );
          await db.pool.query(
            `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority_instruction)
             VALUES($1,$2,$3,1,$4,'Synthetic standup',$5,'2026-10-19T07:00:00Z','Europe/Madrid',$6)`,
            [randomUUID(), ownerId, scheduleId, randomUUID(), authorized.turnId, instruction],
          );
          aligned = (input) =>
            input.scheduledTaskInstruction === instruction &&
            input.scheduledFor === '2026-10-19T09:00:00+02:00' &&
            input.timeZone === 'Europe/Madrid';
          assert.deepEqual(
            await trust.check(authorized, 'GOOGLECALENDAR_PATCH_EVENT', {
              event_id: 'synthetic-standup',
              start_time: '10:00',
            }),
            { confirm: false, basis: { kind: 'schedule', quote: instruction.slice(0, -1) } },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          for (const undecided of [
            () => {
              throw new Error('Synthetic checker failure.');
            },
            () => ({ run: true, because: 'Words the owner never wrote.' }),
          ]) {
            aligned = undecided;
            for (const turn of [event, authorized])
              await assert.rejects(
                trust.check(turn, 'GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary' }),
              );
          }
          aligned = false;
          let described: ApprovalDescription | undefined;
          describe = async (proposal) => {
            described = proposal;
            return defaultDescription();
          };
          await approvals.request(authorized, 'GOOGLECALENDAR_PATCH_EVENT', {
            event_id: 'synthetic-standup',
            start_time: '11:00',
          });
          describe = defaultDescription;
          assert.deepEqual(described?.work, {
            kind: 'schedule',
            title: 'Synthetic standup',
            ownerRequest: instruction,
            waitsForAnswer: true,
          });
          await finish(authorized.turnId, 'cancelled');
          await setRule('');
        },
      );

      await t.test(
        'owner rules reach the checker in chat, scheduled and background work, only owners with rules get the rules prompt, and only a real rule is named as the reason to ask',
        async () => {
          const setRules = (rules: string) =>
            db.pool.query(
              `INSERT INTO preferences(owner_id,rules) VALUES($1,$2)
               ON CONFLICT(owner_id) DO UPDATE SET rules=EXCLUDED.rules`,
              [ownerId, rules],
            );
          const send = email('ana.named@example.test');
          await setRules('');
          aligned = true;
          const chat = await begin('Send Ana the synthetic update.');
          assert.equal((await trust.check(chat, 'GMAIL_SEND_EMAIL', send)).confirm, false);
          assert.equal(reviews.at(-1)?.userRules, undefined);
          const plain = prompts.at(-1)!;
          assert.doesNotMatch(plain, /userRules/);
          aligned = false;
          ruled = true;
          assert.deepEqual(await trust.check(chat, 'GMAIL_SEND_EMAIL', { ...send }), {
            confirm: true,
            reason: 'unrequested',
          });
          const rules = 'Always ask me before sending any email.';
          await setRules(`  ${rules}\n`);
          aligned = (input) => input.userRules === undefined;
          for (const turn of [
            chat,
            await begin('Synthetic event', { source: 'event' }),
            await begin('Synthetic scheduled work', { source: 'schedule' }),
          ]) {
            assert.deepEqual(await trust.check(turn, 'GMAIL_SEND_EMAIL', send), {
              confirm: true,
              reason: 'rule',
            });
            assert.equal(reviews.at(-1)?.userRules, rules);
            assert.ok(prompts.at(-1)!.startsWith(plain));
            assert.match(prompts.at(-1)!, /userRules/);
          }
          ruled = false;
          assert.deepEqual(
            await trust.check(
              await begin('Synthetic event', { source: 'event' }),
              'GMAIL_SEND_EMAIL',
              send,
            ),
            { confirm: true, reason: 'background' },
          );
          await setRules('');
          await trust.check(chat, 'NOD_notification_preferences_update', {
            rules,
            currentRules: '',
          });
          assert.equal(reviews.at(-1)?.userRules, undefined);
          assert.match(prompts.at(-1)!, /currentRules/);
        },
      );

      await t.test(
        'sign-in authority comes from the checker or an owned yes bound to the exact site and item',
        async () => {
          const { createVaultAccess } = await import('../src/server/vault-access.ts');
          const site = 'https://bank.example.test';
          const first = randomUUID();
          const second = randomUUID();
          const access = await createVaultAccess(db.pool, { ownerId, check: trust.check });
          const confirmAccess = async (
            turn: { threadId: string; turnId: string },
            args: Record<string, unknown>,
          ) => {
            const id = await propose(turn, 'NOD_vault_allow', args);
            await finish(turn.turnId);
            await confirm(id, true);
            await execute(id);
            const record = await stored(id);
            assert.equal(record.status, 'completed');
            return { threadId: turn.threadId, turnId: record.execution_turn_id as string };
          };
          const group = await begin('Open my work dashboard.');
          const target = {
            origin: 'https://workspace.example.test',
            kind: 'session' as const,
            itemId: first,
          };
          const session = await access.authorize(group, target);
          assert.ok('details' in session);
          assert.deepEqual(reviews.at(-1)?.action.name, 'NOD_browser_session');
          const groupResumed = await confirmAccess(group, session.args);
          const afterGroup = reviews.length;
          assert.deepEqual(await access.authorize(groupResumed, target), {
            ok: true,
            reason: 'allowed',
            basis: { kind: 'approved' },
          });
          assert.equal(reviews.length, afterGroup);
          const task = await begin('Download my bank statement.');
          const signIn = await access.authorize(task, {
            origin: site,
            kind: 'sign_in',
            itemId: first,
          });
          assert.ok('details' in signIn);
          const resumed = await confirmAccess(task, signIn.args);
          assert.deepEqual(
            await access.authorize(resumed, { origin: site, kind: 'sign_in', itemId: first }),
            { ok: true, reason: 'allowed', basis: { kind: 'approved' } },
          );
          for (const other of [
            { origin: site, kind: 'sign_in' as const, itemId: second },
            { origin: site, kind: 'session' as const, itemId: first },
            { origin: 'https://other.example.test', kind: 'sign_in' as const, itemId: first },
          ])
            assert.ok('details' in (await access.authorize(resumed, other)));
          assert.ok(
            'details' in
              (await access.authorize(await begin('Check what is due.'), {
                origin: site,
                kind: 'sign_in',
                itemId: first,
              })),
          );
          aligned = (input) =>
            input.action?.name === 'NOD_sign_in' &&
            input.action.arguments.website === site &&
            input.userMessages?.at(-1)?.text === 'Download my bank statement now.';
          const requested = await begin('Download my bank statement now.');
          const download = (
            await db.pool.query(
              "SELECT id FROM messages WHERE owner_id=$1 AND role='user' AND text=$2",
              [ownerId, 'Download my bank statement now.'],
            )
          ).rows[0].id;
          assert.deepEqual(
            await access.authorize(requested, { origin: site, kind: 'sign_in', itemId: first }),
            {
              ok: true,
              reason: 'asked',
              basis: {
                kind: 'message',
                messageId: download,
                quote: 'Download my bank statement now',
              },
            },
          );
          aligned = false;
          const background = await begin('Synthetic background work', { source: 'event' });
          const verdict = await access.authorize(background, {
            origin: site,
            kind: 'session',
            itemId: first,
          });
          assert.ok('details' in verdict);
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          await access.record(requested, {
            action: 'sign_in',
            origin: site,
            reason: 'asked',
            itemId: first,
            itemKind: 'login',
            basis: { kind: 'message', messageId: download, quote: 'Download my bank statement' },
          });
          await access.record(requested, {
            action: 'sign_in',
            origin: site,
            reason: 'asked',
            itemId: second,
            itemKind: 'login',
            basis: {
              kind: 'message',
              messageId: randomUUID(),
              quote: 'Download my bank statement',
            },
          });
          const listed = (await access.activity({ origin: site })).entries;
          assert.deepEqual(listed.find((entry) => entry.itemId === first)?.because, {
            kind: 'message',
            text: 'Download my bank statement',
          });
          assert.equal(listed.find((entry) => entry.itemId === second)?.because, undefined);
        },
      );

      await t.test('payments from a chat app are approved outside it', async () => {
        assert.equal(await trust.inNod(await begin('Buy hinges at shop.example.test.')), true);
        assert.equal(
          await trust.inNod(
            await begin('Buy hinges at shop.example.test.', { channel: 'telegram:synthetic' }),
          ),
          false,
        );
        assert.equal(
          await trust.inNod(
            await begin('Buy hinges at shop.example.test.', { channel: 'whatsapp:synthetic' }),
          ),
          false,
        );
        assert.equal(await trust.inNod(await begin('Synthetic event', { source: 'event' })), true);
      });

      await t.test(
        'saved task authority excludes owner instructions addressed to other work',
        async (t) => {
          const parent = await begin('Read my fixture flight dates.');
          const oldStatus = randomUUID();
          t.after(() => finish(parent.turnId, 'cancelled'));
          const source = (await row(parent.turnId)).message_id;
          const assigned = await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Flight dates',
              message: 'Checking flight dates.',
              doneWhen: 'Dates checked',
              now: 'Reading',
            },
            source,
          );
          assert.ok('id' in assigned);
          const task = assigned as { id: string; messageId: string };
          assert.equal(
            (await db.pool.query('SELECT text FROM messages WHERE id=$1', [task.messageId])).rows[0]
              .text,
            'Checking flight dates.',
          );
          t.after(async () => {
            await db.pool.query('DELETE FROM messages WHERE id=$1', [oldStatus]);
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const worker = (
            await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
              task.id,
            ])
          ).rows[0].id;
          const turn = await running(worker);
          await tasks.inherit(turn);
          const hotel = await begin('Send the separate hotel request to hotel@example.test.');
          t.after(() => finish(hotel.turnId, 'cancelled'));
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Do you want the fixture summary?')",
            [randomUUID(), ownerId, hotel.threadId, hotel.turnId],
          );
          await finish(hotel.turnId, 'succeeded');
          await trust.check(turn, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          const started = reviews.at(-1)!.userMessages.map((item: { text: string }) => item.text);
          assert.equal(started.at(-1), 'Read my fixture flight dates.');
          assert.equal(
            started.includes('Send the separate hotel request to hotel@example.test.'),
            false,
          );
          const oldApproval = await propose(turn, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id) SELECT $1,$2,thread_id,'assistant','Saved task question',confirmation_message_id FROM approvals WHERE id=$3",
            [oldStatus, ownerId, oldApproval],
          );
          const mainReply = await begin('Yes.');
          t.after(() => finish(mainReply.turnId, 'cancelled'));
          await trust.check(mainReply, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          assert.equal(
            reviews.at(-1)!.assistantMessageBeforeLatestUserMessage,
            'Do you want the fixture summary?',
          );
          await finish(mainReply.turnId, 'succeeded');
          const update = await messages.submit('Use the new fixture flight dates.', [], {
            replyToMessageId: task.messageId,
          });
          await finish(worker);
          assert.equal(await confirm(oldApproval, true), undefined);
          assert.equal(
            await confirm(oldApproval, true, { replyToMessageId: oldStatus }),
            undefined,
          );
          const continued = await running(update.turnId);
          await tasks.inherit(continued);
          assert.equal(await confirm(oldApproval, true), undefined);
          const freshApproval = await propose(continued, 'GMAIL_SEND_EMAIL', {
            to: 'hotel@example.test',
          });
          assert.notEqual(freshApproval, oldApproval);
          assert.equal((await stored(oldApproval)).status, 'expired');
          await db.pool.query("UPDATE approvals SET status='expired' WHERE id=$1", [freshApproval]);
          await trust.check(continued, 'GMAIL_FETCH_EMAILS', {});
          const words = reviews.at(-1)!.userMessages.map((item: { text: string }) => item.text);
          assert.deepEqual(words.slice(-2), [
            'Read my fixture flight dates.',
            'Use the new fixture flight dates.',
          ]);
          assert.equal(
            words.includes('Send the separate hotel request to hotel@example.test.'),
            false,
          );
          await tasks.execute(
            continued,
            { action: 'finish', id: task.id, status: 'done', result: 'Dates checked' },
            update.messageId,
          );
          await finish(update.turnId, 'succeeded');
          const chat = await begin('Summarise the fixture tasks.');
          t.after(() => finish(chat.turnId, 'cancelled'));
          await trust.check(chat, 'GMAIL_FETCH_EMAILS', {});
          const chatWords = reviews.at(-1)!.userMessages.map((item: { text: string }) => item.text);
          assert.equal(chatWords.includes('Read my fixture flight dates.'), false);
          assert.equal(chatWords.includes('Use the new fixture flight dates.'), false);
          await finish(chat.turnId, 'succeeded');
        },
      );

      await t.test(
        'a repeated relay of one owner message delivers once and does not reset the spending boundary',
        async (t) => {
          const parent = await begin('Draft the fixture relay plan.');
          const task = (await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Fixture relay',
              message: 'Working on the fixture relay.',
              doneWhen: 'Done',
              now: 'Working',
            },
            (await row(parent.turnId)).message_id,
          )) as { id: string };
          t.after(async () => {
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const owner = await begin('Send the fixture relay details to Ana.');
          t.after(() => finish(owner.turnId, 'cancelled'));
          const ownerMessageId = (await row(owner.turnId)).message_id;
          await tasks.execute(owner, { action: 'reply', ids: [task.id] }, ownerMessageId);
          await tasks.execute(owner, { action: 'reply', ids: [task.id] }, ownerMessageId);
          const delivered = (
            await db.pool.query(
              "SELECT id FROM turns WHERE task_id=$1 AND source='task' AND message_id=$2",
              [task.id, ownerMessageId],
            )
          ).rows;
          assert.equal(delivered.length, 1);
          const revision = (
            await db.pool.query('SELECT revision FROM tasks WHERE id=$1', [task.id])
          ).rows[0].revision;
          assert.equal(revision, 2);
          await finish(owner.turnId, 'succeeded');
        },
      );

      await t.test(
        'a relayed owner message shows a task only its own question, and only the main chat steers or stops tasks',
        async (t) => {
          const start = async (request: string, title: string) => {
            const parent = await begin(request);
            const task = (await tasks.execute(
              parent,
              {
                action: 'start',
                title,
                message: `Working on ${title}.`,
                doneWhen: 'Done',
                now: 'Working',
              },
              (await row(parent.turnId)).message_id,
            )) as { id: string };
            t.after(async () => {
              await db.pool.query(
                "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
                [task.id],
              );
              await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
            });
            await finish(parent.turnId, 'succeeded');
            return task;
          };
          const relay = async (text: string, taskId: string) => {
            const owner = await begin(text);
            await tasks.execute(
              owner,
              { action: 'reply', ids: [taskId] },
              (await row(owner.turnId)).message_id,
            );
            await finish(owner.turnId, 'succeeded');
            const relayed = await running(
              (
                await db.pool.query('SELECT id FROM turns WHERE task_id=$1 AND parent_turn_id=$2', [
                  taskId,
                  owner.turnId,
                ])
              ).rows[0].id,
            );
            await tasks.inherit(relayed);
            await trust.check(relayed, 'NOD_browser', { website: 'https://dentist.example.test' });
            await finish(relayed.turnId, 'succeeded');
            return reviews.at(-1)!;
          };
          const dentist = await start('Find a fixture dentist slot.', 'Fixture dentist');
          const worker = await running(
            (
              await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
                dentist.id,
              ])
            ).rows[0].id,
          );
          const question = 'Fixture dentist has Tuesday 10:00. Shall I book it?';
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
            [randomUUID(), ownerId, worker.threadId, worker.turnId, question],
          );
          await db.pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='question' WHERE id=$1",
            [worker.turnId],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,hidden_at) VALUES($1,$2,$3,$4,'assistant','Retired schedule confirmation fixture',now())",
            [randomUUID(), ownerId, worker.threadId, worker.turnId],
          );
          assert.equal(
            (await relay('Yes.', dentist.id)).assistantMessageBeforeLatestUserMessage,
            question,
          );
          const chat = await begin('Anything else pending?');
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Shall I send the fixture summary to Ana now?')",
            [randomUUID(), ownerId, chat.threadId, chat.turnId],
          );
          await finish(chat.turnId, 'succeeded');
          assert.equal(
            'assistantMessageBeforeLatestUserMessage' in (await relay('Yes.', dentist.id)),
            false,
          );
          const parcel = await start('Watch the fixture parcel.', 'Fixture parcel');
          const backgrounds: string[] = [];
          for (const source of ['event', 'schedule'] as const) {
            const background = await begin('Synthetic background work.', { source });
            backgrounds.push(background.turnId);
            t.after(() => finish(background.turnId, 'cancelled'));
            await assert.rejects(
              tasks.execute(background, { action: 'stop', id: parcel.id }, null),
            );
            const answer = (await row(chat.turnId)).message_id;
            await db.pool.query('UPDATE turns SET message_id=$2 WHERE id=$1', [
              background.turnId,
              answer,
            ]);
            await assert.rejects(
              tasks.execute(background, { action: 'stop', id: parcel.id }, answer),
            );
            await assert.rejects(tasks.execute(background, { action: 'stop' }, answer));
          }
          const stopper = await begin('Stop the fixture dentist task.');
          t.after(() => finish(stopper.turnId, 'cancelled'));
          await tasks.execute(
            stopper,
            { action: 'stop', id: dentist.id },
            (await row(stopper.turnId)).message_id,
          );
          const reopen = await begin('Yes.');
          t.after(() => finish(reopen.turnId, 'cancelled'));
          await assert.rejects(
            tasks.execute(
              reopen,
              { action: 'reply', ids: [dentist.id] },
              (await row(reopen.turnId)).message_id,
            ),
          );
          const states = (
            await db.pool.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [
              [dentist.id, parcel.id],
            ])
          ).rows;
          assert.deepEqual(Object.fromEntries(states.map((task) => [task.id, task.state])), {
            [dentist.id]: 'cancelled',
            [parcel.id]: 'open',
          });
          assert.equal(
            (
              await db.pool.query('SELECT id FROM turns WHERE task_id=$1 AND parent_turn_id=$2', [
                dentist.id,
                reopen.turnId,
              ])
            ).rowCount,
            0,
          );
          const everything = await begin('Stop everything you are doing.');
          t.after(() => finish(everything.turnId, 'cancelled'));
          const stopped = await tasks.execute(
            everything,
            { action: 'stop' },
            (await row(everything.turnId)).message_id,
          );
          assert.deepEqual(Object.keys(stopped), ['stopped']);
          assert.deepEqual((stopped as { stopped: { tasks: string[] } }).stopped.tasks, [
            'Fixture parcel',
          ]);
          for (const turnId of backgrounds) assert.equal(await turnStatus(turnId), 'cancelled');
          for (const turnId of [everything.turnId, reopen.turnId])
            assert.equal(await turnStatus(turnId), 'running');
          assert.equal(
            (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [parcel.id])).rows[0].state,
            'cancelled',
          );
        },
      );

      await t.test(
        'revision replies supersede the addressed proposal before a new user turn',
        async () => {
          for (const explicit of [false, true]) {
            const before = calls.length;
            const origin = await begin('A useful change is ready.', { source: 'event' });
            const args = { notificationRule: 'Original preference.' };
            const id = await propose(origin, 'NOD_notification_preferences_update', args);
            await finish(origin.turnId);
            let unrelated: string | undefined;
            if (explicit)
              unrelated = await propose(
                await begin('Another useful decision.', { source: 'event' }),
                'NOD_notification_preferences_update',
                { notificationRule: 'A separate proposal.' },
              );
            const revised = await messages.submit('Update my preferences to be shorter.', [], {
              ...(explicit ? { replyToMessageId: (await stored(id)).confirmation_message_id } : {}),
            });
            const resumed = await row(revised.turnId);
            assert.equal(resumed.source, 'user');
            assert.equal((await stored(id)).status, 'expired');
            assert.equal(await turnStatus(origin.turnId), explicit ? 'waiting' : 'cancelled');
            assert.equal(resumed.background, explicit);
            assert.equal(resumed.parent_turn_id, explicit ? origin.turnId : null);
            if (explicit) assert.equal(resumed.session_id, (await row(origin.turnId)).session_id);
            if (unrelated) assert.equal((await stored(unrelated)).status, 'pending');
            assert.equal(await confirm(id, true), undefined);
            const next = await propose(
              await running(revised.turnId),
              'NOD_notification_preferences_update',
              {
                notificationRule: 'Shorter preference.',
              },
            );
            assert.equal((await stored(next)).status, 'pending');
            assert.equal(calls.length, before);
            await confirm(next, true);
            await execute(next);
            await execute(next);
            assert.equal(calls.length, before + 1);
            assert.equal(calls.at(-1)?.args.notificationRule, 'Shorter preference.');
          }
          const before = calls.length;
          const origin = await begin('A useful change is ready.', { source: 'event' });
          const id = await propose(origin, 'NOD_notification_preferences_update', {
            notificationRule: 'Original preference.',
          });
          const confirmationMessageId = (await stored(id)).confirmation_message_id;
          const result = await messages.submit(
            'Yes',
            [
              await artifacts.storeUpload(
                Buffer.from('revision fixture'),
                'revision.txt',
                'text/plain',
              ),
            ],
            { replyToMessageId: confirmationMessageId },
          );
          assert.equal((await row(result.turnId)).source, 'user');
          assert.equal((await row(result.turnId)).parent_turn_id, origin.turnId);
          assert.equal(await turnStatus(origin.turnId), 'running');
          assert.equal((await stored(id)).status, 'expired');
          assert.equal(await confirm(id, true), undefined);
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'background turns share one pending confirmation for the same action',
        async () => {
          const args = { id: randomUUID() };
          const turns = await Promise.all([
            begin('A synthetic event proposes a pause.', { source: 'event' }),
            begin('A synthetic scheduled check proposes a pause.', { source: 'schedule' }),
          ]);
          const before = calls.length;
          const results = await Promise.all(
            turns.map((turn) => approvals.request(turn, 'NOD_schedule_pause', args)),
          );
          for (const result of results) assert.ok(result[appConfirmation]);
          assert.equal(results[0][appConfirmation], results[1][appConfirmation]);
          const records = (
            await db.pool.query(
              'SELECT * FROM approvals WHERE owner_id=$1 AND thread_id=$2 AND action=$3 AND args=$4::jsonb',
              [ownerId, turns[0]!.threadId, 'NOD_schedule_pause', args],
            )
          ).rows;
          assert.equal(records.length, 1);
          assert.equal(records[0].status, 'pending');
          assert.equal(calls.length, before);
          assert.equal(
            (await assistantMessages(turns[0]!.turnId))! +
              (await assistantMessages(turns[1]!.turnId))!,
            1,
          );
          const original = turns.find((turn) => turn.turnId === records[0].turn_id)!;
          await assert.rejects(approvals.request(original, 'NOD_schedule_pause', args), {
            statusCode: 409,
          });
          const other = await begin('A different schedule needs a pause.', { source: 'event' });
          await propose(other, 'NOD_schedule_pause', { id: randomUUID() });
          assert.equal(await assistantMessages(other.turnId), 1);
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'a resume that does not trace back to an owner message carries no owner words',
        async () => {
          const generic = await running(
            await thread.enqueueTurn('Synthetic unrelated continuation', { source: 'resume' }),
          );
          await assert.rejects(
            approvals.request(generic, 'NOD_notification_preferences_update', {}),
            /direct request/,
          );
          assert.equal(await proposal(generic.turnId), undefined);
          aligned = true;
          await trust.check(generic, 'GMAIL_SEND_EMAIL', email('owner@example.test'));
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          aligned = false;
          await db.pool.query(
            "UPDATE turns SET status='succeeded',finished_at=now() WHERE status IN ('queued','running')",
          );
        },
      );

      await t.test(
        'a channel confirmation preserves the exact snapshot and client retries do not execute twice',
        async (t) => {
          const analyticsEvents: Parameters<ProductAnalytics['capture']>[0][] = [];
          const analytics = await createAnalytics({
            provider: { capture: (event) => analyticsEvents.push(event), shutdown: async () => {} },
            environment: 'development',
            dataRoot,
            installationId: randomUUID(),
          });
          t.after(() => analytics.shutdown());
          analytics.setUsageData(ownerId, true);
          const capture = analytics.forOwner(ownerId);
          const observedMessages = thread.createUserMessageService({
            confirmAction: approvals.chat,
            accepted: () => {
              const snapshot = snapshotAnalytics(capture);
              return (channel) =>
                snapshot?.({
                  event: 'owner_message_accepted',
                  properties: { channel: channel === 'web' ? 'web' : 'telegram' },
                });
            },
          });
          const acceptedEvents = () =>
            analyticsEvents.filter((event) => event.event === 'owner_message_accepted');
          const channel = 'telegram:fixture';
          const turn = await begin('Synthetic channel fixture', { channel });
          const turnIds = [turn.turnId];
          const statusMessageId = randomUUID();
          const foreignStatus = randomUUID();
          t.after(async () => {
            await db.pool.query(
              'UPDATE messages SET reply_to_message_id=NULL WHERE reply_to_message_id=ANY($1::uuid[])',
              [[statusMessageId, foreignStatus]],
            );
            await db.pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [
              [statusMessageId, foreignStatus],
            ]);
            await db.pool.query(
              "UPDATE turns SET status='cancelled',finished_at=now() WHERE id=ANY($1::uuid[]) AND status IN ('queued','running','waiting')",
              [turnIds],
            );
          });
          const args = { notificationRule: 'Synthetic original' };
          await approvals.request(turn, 'NOD_notification_preferences_update', args);
          const saved = await proposal(turn.turnId);
          args.notificationRule = 'Substituted after proposal';
          await finish(turn.turnId);
          const clientMessageId = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id,delivered_channel) VALUES($1,$2,$3,'assistant',$4,$5,$6)",
            [
              statusMessageId,
              ownerId,
              turn.threadId,
              'Saved task question',
              saved.confirmation_message_id,
              channel,
            ],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id) VALUES($1,'foreign-owner',$2,'assistant',$3,$4)",
            [foreignStatus, turn.threadId, 'Foreign question', saved.confirmation_message_id],
          );
          assert.equal(
            await approvals.chat.answer({ threadId: turn.threadId, channel, text: 'Yes' }),
            undefined,
          );
          assert.equal(
            await approvals.chat.answer({
              threadId: turn.threadId,
              channel,
              text: 'Yes',
              replyToMessageId: foreignStatus,
            }),
            undefined,
          );
          const reply = {
            channel,
            replyToMessageId: statusMessageId,
            clientMessageId,
            sourceId: `channel:telegram:fixture:${randomUUID()}`,
          };
          await assert.rejects(
            observedMessages.submit('Yes.', [], {
              ...reply,
              persistSubmission: async () => {
                throw new Error('Synthetic confirmation rollback.');
              },
            }),
            /Synthetic confirmation rollback/,
          );
          assert.equal((await proposal(turn.turnId)).status, 'pending');
          assert.deepEqual(acceptedEvents(), []);
          let insertions = 0;
          const accepted = await observedMessages.submit('Yes.', [], {
            ...reply,
            onInserted: () => {
              insertions++;
            },
          });
          turnIds.push(accepted.turnId);
          assert.notEqual(accepted.turnId, turn.turnId);
          assert.deepEqual(
            await observedMessages.submit('Yes.', [], { ...reply, onInserted: () => insertions++ }),
            accepted,
          );
          assert.deepEqual(
            await observedMessages.submit('Yes.', [], {
              ...reply,
              clientMessageId: randomUUID(),
              onInserted: () => insertions++,
            }),
            accepted,
          );
          assert.equal(insertions, 1);
          assert.deepEqual(
            acceptedEvents().map((event) => event.properties.channel),
            ['telegram'],
          );
          const confirmed = await proposal(turn.turnId);
          assert.equal(confirmed.status, 'confirmed');
          assert.equal(confirmed.execution_turn_id, accepted.turnId);
          assert.equal((await row(accepted.turnId)).channel, channel);
          const before = calls.length;
          await assert.rejects(
            approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
            /no longer active/,
          );
          await assert.rejects(
            approvals.executeConfirmed(turn.turnId, new AbortController().signal),
            /no longer active/,
          );
          await running(accepted.turnId);
          assert.ok(
            await approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
          );
          assert.equal(calls.length, before + 1);
          assert.equal(calls.at(-1)?.args.notificationRule, 'Synthetic original');
          assert.equal(
            await approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
            undefined,
          );
          assert.equal((await proposal(turn.turnId)).status, 'completed');
          await finish(accepted.turnId, 'succeeded');

          const declinedTurn = await begin('Synthetic declined confirmation', { channel: 'web' });
          turnIds.push(declinedTurn.turnId);
          await approvals.request(declinedTurn, 'NOD_notification_preferences_update', {
            notificationRule: 'Synthetic declined',
          });
          await finish(declinedTurn.turnId);
          const declinedReply = {
            channel: 'web',
            replyToMessageId: (await proposal(declinedTurn.turnId)).confirmation_message_id,
            clientMessageId: randomUUID(),
          };
          let declinedInsertions = 0;
          const declined = await observedMessages.submit('No.', [], {
            ...declinedReply,
            onInserted: () => {
              declinedInsertions++;
            },
          });
          turnIds.push(declined.turnId);
          assert.equal((await proposal(declinedTurn.turnId)).status, 'declined');
          assert.deepEqual(
            await observedMessages.submit('No.', [], {
              ...declinedReply,
              onInserted: () => declinedInsertions++,
            }),
            declined,
          );
          assert.equal(declinedInsertions, 1);
          assert.deepEqual(
            acceptedEvents().map((event) => event.properties.channel),
            ['telegram', 'web'],
          );
        },
      );

      await t.test('artifacts are owned and published only from inside the workspace', async () => {
        const { threadId: id } = await newTurn('succeeded');
        const workspace = join(dataRoot, 'workspaces', id);
        const privateDir = await mkdtemp(join(tmpdir(), 'nod-artifact-test-'));
        directories.push(workspace, privateDir);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(privateDir, 'private.txt'), 'private fixture');
        await symlink(join(privateDir, 'private.txt'), join(workspace, 'escape.txt'));
        const read = async (threadId: string, path: string, maxBytes: number) => {
          assert.equal(threadId, id);
          const handle = await open(
            join(workspace, path),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await handle.stat();
            assert.ok(stat.isFile() && stat.size <= maxBytes);
            return await handle.readFile();
          } finally {
            await handle.close();
          }
        };
        await assert.rejects(
          artifacts.publishArtifact(id, join(privateDir, 'private.txt'), undefined, read),
        );
        await assert.rejects(artifacts.publishArtifact(id, 'escape.txt', undefined, read));
        await writeFile(join(workspace, 'report.html'), '<script>window.fixture=true</script>');
        const published = await artifacts.publishArtifact(
          id,
          'report.html',
          '../../report\r\n.html',
          read,
        );
        assert.equal(published.name, 'report.html');
        await writeFile(join(workspace, 'alert.n8n.json'), '{"nodes":[],"connections":{}}');
        const workflow = await artifacts.publishArtifact(id, 'alert.n8n.json', 'Rain alert', read);
        assert.equal(workflow.name, 'Rain alert.n8n.json');
        const response = await request('GET', published.url);
        assert.equal(response.statusCode, 200);
        await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
          published.id,
          'another-owner',
        ]);
        assert.equal((await request('GET', published.url)).statusCode, 404);
        const error = await request('GET', '/api/fixture-error');
        assert.equal(error.statusCode, 500);
        assert.equal(error.body.includes('fixture-private-key'), false);
      });

      await t.test(
        'the reply reader sees only the owner reply and its answer binds to the question it read',
        async () => {
          const reply = 'dale, adelante';
          replyAnswers[reply] = 'yes';
          const ask = async () => {
            const turn = await newTurn();
            const id = await propose(turn, 'NOD_notification_preferences_update', {
              notificationRule: 'Read reply',
            });
            await finish(turn.turnId);
            const record = await stored(id);
            return {
              id,
              input: {
                text: reply,
                channel: 'web',
                threadId: record.thread_id as string,
                replyToMessageId: record.confirmation_message_id as string,
                clientMessageId: randomUUID(),
              },
            };
          };
          const first = await ask();
          const before = replies.length;
          assert.deepEqual(await approvals.chat.answer({ ...first.input, hasAttachments: true }), {
            approvalId: first.id,
          });
          assert.equal(replies.length, before);
          replyAnswers['reader down'] = 'fail';
          const outage = { ...first.input, text: 'reader down' };
          const unread = await approvals.chat.answer(outage);
          assert.equal(unread, undefined);
          assert.equal(
            await transaction(
              (client) => approvals.chat.accept(client, { ...outage, answer: unread }),
              db.pool,
            ),
            undefined,
          );
          assert.equal((await stored(first.id)).status, 'pending');
          delete replyAnswers['reader down'];
          const answer = await approvals.chat.answer(first.input);
          assert.deepEqual(answer, { approvalId: first.id, approved: true });
          assert.deepEqual(replies.at(-1), { reply });
          const long = `${'yes '.repeat(400)}but send it elsewhere`;
          assert.equal(await trust.answer(long), undefined);
          assert.deepEqual(replies.at(-1), { reply: long });
          const forged = await transaction(
            (client) =>
              approvals.chat.accept(client, {
                ...first.input,
                answer: { approvalId: randomUUID(), approved: true },
              }),
            db.pool,
          );
          assert.equal(forged, undefined);
          assert.equal((await stored(first.id)).status, 'expired');
          const second = await ask();
          await transaction(
            async (client) =>
              approvals.chat.accept(client, {
                ...second.input,
                answer: await approvals.chat.answer(second.input),
              }),
            db.pool,
          );
          assert.equal((await stored(second.id)).status, 'confirmed');
          delete replyAnswers[reply];
          await thread.stopThread();
        },
      );
    } finally {
      await app.close();
      await thread.stopThreadWorkers();
      const files = (await db.pool.query('SELECT storage_path FROM artifacts')).rows.map((row) =>
        String(row.storage_path),
      );
      await db.pool.end();
      for (const path of files) await rm(path, { force: true });
      for (const path of directories) await rm(path, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
