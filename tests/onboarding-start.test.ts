import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Agent, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

test(
  'completing onboarding starts one assistant-initiated welcome without a user message or reset',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_welcome_${suffix}`;
    const bossSchema = `test_welcome_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { welcomeGreeting } = await import('../src/server/welcome.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createAccountSession } = await import('../src/server/account.ts');
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const { configuration, ownerId, port } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await tasks.initializeTasks();
    const { createPersonalService } = await import('../src/server/personal.ts');
    await createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    }).initialize({ workers: false });
    const accounts = createAccountStore(db.pool);
    await accounts.initialize();
    const app = await createApp({
      configuration: () => ({ ...configuration(), llmReady: true }),
      startOnboarding: tasks.startOnboarding,
    });
    createAccountSession({
      accounts,
      origin: `http://localhost:${port}`,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      start: async (_owner, name) => {
        await tasks.startOnboarding(name, ['Gmail', 'Google Calendar', 'Slack']);
      },
    }).register(app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    try {
      const earlier = await tasks.submitTask('Earlier synthetic request');
      const before = (await app.inject({ url: '/api/state', headers })).json();
      await tasks.startOnboarding('Alex', ['Gmail']);
      assert.equal(
        (await db.pool.query("SELECT id FROM tasks WHERE source_id='onboarding:welcome'")).rowCount,
        0,
      );
      await tasks.cancelTask(earlier);
      const landing = () =>
        app.inject({ method: 'POST', url: '/api/account/welcome', headers, payload: {} });
      assert.equal((await landing()).statusCode, 409);
      assert.equal(
        (await db.pool.query("SELECT id FROM tasks WHERE source_id LIKE 'onboarding:%'")).rowCount,
        0,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/account',
            headers,
            payload: { name: 'Alex Example' },
          })
        ).statusCode,
        200,
      );
      const complete = () =>
        app.inject({
          method: 'PATCH',
          url: '/api/account',
          headers,
          payload: { onboardingCompleted: true },
        });
      const responses = await Promise.all([complete(), complete()]);
      responses.push(await complete());
      for (const response of responses) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().settings.onboardingCompleted, true);
      }
      assert.deepEqual(
        (
          await app.inject({ method: 'POST', url: '/api/onboarding/start', headers, payload: {} })
        ).json(),
        { ok: true },
      );
      for (const response of await Promise.all([landing(), landing()]))
        assert.deepEqual(response.json(), { ok: true });
      const welcome = await db.pool.query(
        "SELECT id,status,source,source_id,source_message_id,channel,conversation_revision,prompt FROM tasks WHERE source_id LIKE 'onboarding:%'",
      );
      assert.equal(welcome.rowCount, 1);
      assert.equal(welcome.rows[0].source, 'event');
      assert.equal(welcome.rows[0].source_id, 'onboarding:welcome');
      assert.equal(welcome.rows[0].status, 'queued');
      const greeting =
        'Hi Alex, I’m looking through your Gmail, Google Calendar and Slack for things I can take off your plate.';
      assert.deepEqual(
        (
          await db.pool.query('SELECT role,text FROM messages WHERE task_id=$1', [
            welcome.rows[0].id,
          ])
        ).rows,
        [{ role: 'assistant', text: greeting }],
      );
      const prompt = welcome.rows[0].prompt as string;
      assert.ok(prompt.includes(JSON.stringify({ greeting })));
      assert.match(prompt, /Do not greet the user again/);
      assert.ok(prompt.indexOf('read-only tools only') < prompt.indexOf('send_message'));
      assert.match(prompt, /Before you write anything, look into each connected app/);
      assert.match(prompt, /Do not send, create, change or delete anything in any app/);
      assert.match(prompt, /normal approvals still apply/);
      assert.match(prompt, /hardest or most tedious one first/);
      assert.equal(
        welcomeGreeting(' Sam   Rivera ', ['Gmail']),
        'Hi Sam, I’m looking through your Gmail for things I can take off your plate.',
      );
      assert.match(welcomeGreeting(undefined, []), /^Hi, I’m Otto\..*Connect one app/);
      assert.equal(
        welcomeGreeting('Alex', ['Gmail', 'Slack', 'Notion', 'Linear', 'Google Drive']),
        'Hi Alex, I’m looking through your Gmail, Slack, Notion and 2 more apps for things I can take off your plate.',
      );
      assert.match(prompt, /If only one item is useful, offer only that one/);
      assert.equal(welcome.rows[0].source_message_id, null);
      assert.equal(welcome.rows[0].channel, 'web');
      assert.equal(welcome.rows[0].conversation_revision, before.conversationRevision);
      assert.equal(
        (
          await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [
            welcome.rows[0].id,
          ])
        ).rowCount,
        0,
      );
      const after = (await app.inject({ url: '/api/state', headers })).json();
      assert.equal(after.conversationRevision, before.conversationRevision);
      assert.deepEqual(
        after.messages.map((message: { text: string }) => message.text),
        ['Earlier synthetic request', greeting],
      );
      const typing = Object.fromEntries(
        after.tasks.map((task: { id: string; showTyping: boolean }) => [task.id, task.showTyping]),
      );
      assert.deepEqual(typing, { [earlier]: true, [welcome.rows[0].id]: true });
      assert.equal(
        (await app.inject({ url: `/api/tasks/${welcome.rows[0].id}`, headers })).json().showTyping,
        true,
      );
      await tasks.submitTask('Synthetic background event', [], undefined, true, {
        source: 'event',
        sourceId: `event:${randomUUID()}`,
      });
      const background = (await app.inject({ url: '/api/state', headers }))
        .json()
        .tasks.filter((task: { showTyping: boolean }) => !task.showTyping);
      assert.equal(background.length, 1);
      await db.pool.query('DELETE FROM messages WHERE task_id=$1', [welcome.rows[0].id]);
      await db.pool.query('DELETE FROM tasks WHERE id=$1', [welcome.rows[0].id]);
      await tasks.startOnboarding(undefined, []);
      const empty = await db.pool.query(
        "SELECT t.status,m.text FROM tasks t JOIN messages m ON m.task_id=t.id WHERE t.source_id='onboarding:welcome'",
      );
      assert.deepEqual(empty.rows, [{ status: 'succeeded', text: welcomeGreeting(undefined, []) }]);
      await db.pool.query(
        "DELETE FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE source_id='onboarding:welcome')",
      );
      await db.pool.query("DELETE FROM tasks WHERE source_id='onboarding:welcome'");
      const refusals: string[] = [];
      const agent: Agent = {
        open: async (input) => ({
          resumed: false,
          abort: () => {},
          dispose: () => {},
          prompt: async () => {
            const tools = new Map(input.tools.map((entry) => [entry.name, entry]));
            await tools.get('apps')!.execute({ action: 'GMAIL_FETCH_EMAILS', args: {} });
            await tools
              .get('shell')!
              .execute({ command: 'curl https://example.test' })
              .catch((error: Error) => refusals.push(error.message));
            await tools.get('send_message')!.execute({ text: 'Two threads wait for your reply.' });
          },
        }),
        dispose: () => {},
      };
      const runtime = createAgentRuntime({
        agent,
        computer: fakeComputer(),
        workspace: fakeWorkspace(),
      });
      const seen: RuntimeContext[] = [];
      const reads: boolean[] = [];
      await tasks.startTaskWorkers({
        runTask: async (context) => {
          seen.push(context);
          return context.readOnly ? runtime.runTask(context) : { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused');
          },
        },
        requestCredential: async () => ({}),
        integration: async (_taskId, _action, _args, options) => {
          reads.push(options.readOnly);
          return { successful: true, data: { threads: 2 } };
        },
        manage: async () => ({}),
      });
      const ordinary = await tasks.submitTask('Later synthetic request');
      let ordinaryResult = { status: '', error: null };
      for (let attempt = 0; attempt < 800 && ordinaryResult.status !== 'succeeded'; attempt++) {
        ordinaryResult = (
          await db.pool.query('SELECT status,error FROM tasks WHERE id=$1', [ordinary])
        ).rows[0];
        assert.notEqual(ordinaryResult.status, 'failed', ordinaryResult.error ?? undefined);
        await delay(25);
      }
      assert.equal(ordinaryResult.status, 'succeeded');
      assert.ok(seen.some((context) => context.taskId === ordinary && !context.readOnly));
      await tasks.startOnboarding('Alex', ['Gmail']);
      const discovery = (
        await db.pool.query("SELECT id FROM tasks WHERE source_id='onboarding:welcome'")
      ).rows[0].id as string;
      let finished = { status: '', error: null };
      for (let attempt = 0; attempt < 800 && finished.status !== 'succeeded'; attempt++) {
        finished = (await db.pool.query('SELECT status,error FROM tasks WHERE id=$1', [discovery]))
          .rows[0];
        assert.notEqual(finished.status, 'failed', finished.error ?? undefined);
        await delay(25);
      }
      assert.equal(finished.status, 'succeeded');
      assert.deepEqual(
        (
          await db.pool.query('SELECT text FROM messages WHERE task_id=$1 ORDER BY created_at,id', [
            discovery,
          ])
        ).rows.map((row) => row.text),
        [welcomeGreeting('Alex', ['Gmail']), 'Two threads wait for your reply.'],
      );
      assert.deepEqual(refusals, [
        'This task can only read. Use app reads, and browser open, snapshot or scroll.',
      ]);
      assert.deepEqual(reads, [true]);
      assert.deepEqual(
        seen.filter((context) => context.readOnly).map((context) => context.taskId),
        [discovery],
      );
      await runtime.dispose();
    } finally {
      await app.close();
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
