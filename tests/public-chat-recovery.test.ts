import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type { AuthenticatedSession, AuthenticationProvider } from '../src/ports/authentication.ts';
import type { ConversationRouteDecision } from '../src/ports/conversation.ts';

test(
  'hosted message ingress rejects forceNew while preserving recovery routing and trusted onboarding',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_public_recovery_${suffix}`;
    const bossSchema = `sk_jobs_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const cleanup: Array<() => Promise<unknown> | void> = [() => admin.end()];
    t.after(async () => {
      const errors: unknown[] = [];
      for (const release of cleanup.reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed.');
    });
    cleanup.push(() => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
    await admin.query(`CREATE SCHEMA ${schema}`);
    cleanup.push(() => admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`));
    await admin.query(`CREATE SCHEMA ${bossSchema}`);
    const directory = await mkdtemp(join(tmpdir(), 'otto-public-recovery-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const previousDirectory = process.cwd();
    cleanup.push(() => process.chdir(previousDirectory));
    process.chdir(directory);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    const ownerId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_MODE = 'tenant';
    process.env.OTTO_OWNER_ID = ownerId;
    process.env.OTTO_RUNTIME_SECRET = secret;
    process.env.OTTO_ENVIRONMENT = 'test';
    process.env.OTTO_RUNTIME_GENERATION = '1';
    const db = await import('../src/server/db.ts');
    cleanup.push(() => db.pool.end());
    const tasks = await import('../src/server/tasks.ts');
    cleanup.push(() => tasks.stopTasks());
    const { createApp } = await import('../src/server/app.ts');
    const { createGateway } = await import('../src/server/gateway.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { signRuntimeRequest, runtimeHeader } = await import('../src/server/runtime-auth.ts');
    const { configuration } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await tasks.initializeTasks();
    let providerCalls = 0;
    const approvals = await createApprovals(async () => {
      providerCalls++;
      return { successful: true };
    });
    let routes = 0;
    let submissions = 0;
    let decide: ConversationRouteDecision = { kind: 'conversation' };
    const messages = tasks.createUserMessageService({
      routeConversation: async () => {
        routes++;
        return decide;
      },
      confirmAction: approvals.acceptChat,
    });
    const tenant = await createApp({
      configuration: () => configuration({ llmReady: true }),
      submitMessage: async (text, attachments, options) => {
        submissions++;
        return messages.submit(text, attachments, options);
      },
      onboard: (_timeZone, revision) => tasks.restartOnboarding(revision),
    });
    cleanup.push(() => tenant.close());
    const origin = 'https://otto.example.test';
    const cookie = `fixture=${randomBytes(32).toString('base64url')}`;
    const session: AuthenticatedSession = {
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: ownerId, name: 'Synthetic user', email: 'user@example.test', avatarUrl: null },
    };
    const authentication: AuthenticationProvider = {
      configured: true,
      async initialize() {},
      async session(headers) {
        return headers.get('cookie') === cookie ? session : null;
      },
      async signIn() {
        return Response.json({ url: 'https://accounts.example.test/google' });
      },
      async signOut() {
        return Response.json({ ok: true });
      },
      async callback() {
        return Response.redirect(`${origin}/onboarding`);
      },
    };
    const gateway = await createGateway({
      origin,
      authentication,
      developerIds: new Set(),
      accounts: {
        async read() {
          return { theme: 'system', onboardingCompleted: true, displayName: null };
        },
        async update() {
          return { theme: 'system', onboardingCompleted: true, displayName: null };
        },
      },
      runtimes: {
        async fetch(owner, request, options) {
          assert.equal(owner, ownerId);
          assert.equal(options.developer, false);
          const body = Buffer.from(await request.arrayBuffer());
          const url = new URL(request.url);
          const target = url.pathname + url.search;
          const response = await tenant.inject({
            method: 'POST',
            url: target,
            headers: {
              'content-type': 'application/json',
              [runtimeHeader]: signRuntimeRequest({
                secret,
                ownerId,
                environment: 'test',
                generation: '1',
                method: request.method,
                target,
                body,
                developer: options.developer,
              }),
            },
            payload: body,
          });
          return new Response(response.body, {
            status: response.statusCode,
            headers: { 'content-type': 'application/json' },
          });
        },
        async close() {},
      },
    });
    cleanup.push(() => gateway.close());
    const send = (payload: Record<string, unknown>, path = '/api/messages') =>
      gateway.inject({
        method: 'POST',
        url: path,
        headers: { host: new URL(origin).host, origin, cookie, 'x-otto-account': ownerId },
        payload,
      });
    const snapshot = async () => ({
      tasks: (await db.pool.query('SELECT * FROM tasks ORDER BY id')).rows,
      messages: (await db.pool.query('SELECT * FROM messages ORDER BY id')).rows,
      inputs: (await db.pool.query('SELECT * FROM pending_task_inputs ORDER BY id')).rows,
      continuations: (await db.pool.query('SELECT * FROM task_continuations ORDER BY source_id'))
        .rows,
      outcomes: (await db.pool.query('SELECT * FROM outcomes ORDER BY id')).rows,
      conversations: (await db.pool.query('SELECT * FROM conversations ORDER BY owner_id,channel'))
        .rows,
      approvals: (await db.pool.query('SELECT * FROM approvals ORDER BY id')).rows,
      jobs: (
        await db.pool.query(
          `SELECT id,data,state FROM ${bossSchema}.job WHERE name='assistant-task' ORDER BY id`,
        )
      ).rows,
    });
    const outcomeId = randomUUID();
    await db.pool.query(
      `INSERT INTO outcomes(id,owner_id,channel,conversation_revision,title,objective)
         VALUES($1,$2,'web',0,'Synthetic uncertain action','Check the earlier action before continuing.')`,
      [outcomeId, ownerId],
    );
    const taskId = await tasks.submitTask('Synthetic earlier action', [], undefined, false, {
      outcomeId,
    });
    await db.pool.query(
      "UPDATE tasks SET status='waiting_user',waiting_reason='recovery' WHERE id=$1",
      [taskId],
    );
    await db.pool.query(
      `INSERT INTO approvals(id,owner_id,task_id,action,args,status)
         VALUES($1,$2,$3,'SYNTHETIC_SEND','{}','uncertain')`,
      [randomUUID(), ownerId, taskId],
    );
    decide = { kind: 'continue', outcomeId };
    await t.test('public forceNew rejects before persistence, routing or dispatch', async () => {
      const before = await snapshot();
      for (const forceNew of [true, false]) {
        const response = await send({
          text: 'Repeat the earlier synthetic action',
          forceNew,
          clientMessageId: randomUUID(),
        });
        assert.equal(response.statusCode, 400, response.body);
        assert.deepEqual(response.json(), { error: 'Check the supplied values.' });
      }
      assert.equal(submissions, 0);
      assert.equal(routes, 0);
      assert.equal(providerCalls, 0);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test('ordinary retries retain the recovery fence', async () => {
      const before = await snapshot();
      const response = await send({ text: 'Repeat the earlier synthetic action' });
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(response.json(), {
        error: 'I can’t safely repeat the earlier action because its outcome is unknown.',
        code: 'task_review_required',
        taskId,
        summary: 'Synthetic uncertain action',
      });
      assert.equal(submissions, 1);
      assert.equal(routes, 1);
      assert.equal(providerCalls, 0);
      assert.deepEqual(await snapshot(), before);
    });
    await t.test('independent requests still create normally routed work', async () => {
      decide = {
        kind: 'new_outcome',
        title: 'Synthetic weather',
        objective: 'Read the weather.',
      };
      const before = await snapshot();
      const response = await send({ text: 'Read the current synthetic weather' });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().continued, false);
      assert.notEqual(response.json().taskId, taskId);
      assert.equal(routes, 2);
      const after = await snapshot();
      assert.equal(after.tasks.length, before.tasks.length + 1);
      assert.equal(after.messages.length, before.messages.length + 1);
      assert.equal(after.jobs.length, before.jobs.length + 1);
      assert.deepEqual(after.approvals, before.approvals);
      assert.deepEqual(
        after.tasks.find((task) => task.id === taskId),
        before.tasks.find((task) => task.id === taskId),
      );
      assert.equal(providerCalls, 0);
    });
    await t.test('onboarding cannot accept arbitrary instructions or routing options', async () => {
      const before = await snapshot();
      for (const extra of [
        { text: 'Repeat the earlier synthetic action' },
        { forceNew: true },
        { taskId },
      ]) {
        const response = await send({ conversationRevision: 0, ...extra }, '/api/onboarding');
        assert.equal(response.statusCode, 400, response.body);
      }
      assert.deepEqual(await snapshot(), before);
      assert.equal(submissions, 2);
      assert.equal(routes, 2);
      assert.equal(providerCalls, 0);
    });
    await t.test(
      'trusted onboarding creates its fixed request without replaying uncertain work',
      async () => {
        const before = await snapshot();
        const response = await send({ conversationRevision: 0 }, '/api/onboarding');
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().continued, false);
        const after = await snapshot();
        const onboarding = after.tasks.find((task) => task.id === response.json().taskId);
        assert.ok(onboarding);
        assert.match(onboarding.source_id, /^onboarding:/);
        assert.equal(onboarding.owner_id, ownerId);
        assert.equal(onboarding.channel, 'web');
        assert.match(onboarding.prompt, /^Help me get started\. First check my app connections\./);
        assert.match(
          onboarding.prompt,
          /Do not ask profile questions or make changes to connected accounts\./,
        );
        assert.equal(after.tasks.length, before.tasks.length + 1);
        assert.equal(after.jobs.length, before.jobs.length + 1);
        assert.deepEqual(after.approvals, before.approvals);
        assert.deepEqual(
          after.tasks.find((task) => task.id === taskId),
          before.tasks.find((task) => task.id === taskId),
        );
        assert.equal(submissions, 2);
        assert.equal(routes, 2);
        assert.equal(providerCalls, 0);
      },
    );
  },
);
