import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'reset archives only web chat, revokes old work and resumes with fresh history while preserving saved data',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_reset_${suffix}`;
    const bossSchema = `test_reset_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createVault } = await import('../src/server/vault.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { createTriage } = await import('../src/server/triage.ts');
    const { configuration, ownerId, port, dataRoot } = await import('../src/server/config.ts');
    const { events } = await import('../src/server/events.ts');
    await db.initializeDatabase();
    await tasks.initializeTasks();
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    await personal.initialize({ workers: false });
    let injected = 0;
    let executed = 0;
    const fixtureKey = randomBytes(32);
    const vault = await createVault(db.pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      inject: async () => {
        injected++;
      },
      resume: tasks.resumeTask,
      retry: tasks.retryTaskCredentials,
    });
    const approvals = await createApprovals(async () => {
      executed++;
      return {};
    });
    const userMessages = tasks.createUserMessageService({ confirmAction: approvals.acceptChat });
    const app = await createApp({
      submitMessage: userMessages.submit,
      configuration: () => ({ ...configuration(), llmReady: true }),
      onboard: (_timeZone, revision) => tasks.restartOnboarding(revision),
    });
    personal.registerRoutes(app);
    vault.registerRoutes(app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url: path, headers, payload });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: RuntimeContext[] = [];
    const deltas: Array<{ taskId?: string; conversationRevision?: number }> = [];
    const onEvent = (event: { type: string; taskId?: string; conversationRevision?: number }) => {
      if (event.type === 'delta') deltas.push(event);
    };
    events.on('event', onEvent);
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await delay(30);
      }
      throw new Error('Reset fixture did not complete.');
    };
    try {
      const old = await tasks.submitTask('Archived unique conversation phrase');
      await tasks.reply(old, 'Archived answer.');
      await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [old]);
      const oldMessage = (
        await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [old])
      ).rows[0].id as string;
      const oldUser = (
        await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [old])
      ).rows[0].id as string;
      await request('PUT', '/api/profile', {
        name: 'Fixture name',
        location: 'Lisbon',
        phone: '',
        preferences: 'Concise',
      });
      await db.pool.query(
        "INSERT INTO memory_facts(id,owner_id,text,source_message_id) VALUES($1,$2,'Saved fixture preference',$3)",
        [randomUUID(), ownerId, oldUser],
      );
      assert.equal((await request('POST', '/api/goals', { title: 'Saved goal' })).statusCode, 200);
      assert.equal(
        (
          await request('POST', '/api/schedules', {
            title: 'Saved routine',
            prompt: 'Check a fixture',
            cron: '0 9 * * 1',
            timeZone: 'Europe/Lisbon',
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await request('POST', '/api/vault', {
            label: 'Saved account',
            origin: 'https://example.com',
            username: 'fixture',
            password: 'synthetic-secret',
          })
        ).statusCode,
        200,
      );
      await db.pool.query(
        'CREATE TABLE app_connections(id uuid PRIMARY KEY,owner_id text,account_id text)',
      );
      await db.pool.query("INSERT INTO app_connections VALUES($1,$2,'saved-fixture-account')", [
        randomUUID(),
        ownerId,
      ]);
      const credentialTask = await tasks.submitTask('Old credential task');
      await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [credentialTask]);
      const credential = await vault.request(credentialTask, ownerId, {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await db.pool.query(
        "UPDATE tasks SET status='waiting_credentials',waiting_reason='credentials' WHERE id=$1",
        [credentialTask],
      );
      const approvalTask = await tasks.submitTask('Old approval task');
      await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [approvalTask]);
      await approvals.request(approvalTask, 'FIXTURE_WRITE', {}, { revision: 0 });
      const confirmationMessageId = (
        await db.pool.query('SELECT confirmation_message_id FROM approvals WHERE task_id=$1', [
          approvalTask,
        ])
      ).rows[0].confirmation_message_id;
      const other = await tasks.submitTask('Other channel stays intact', [], undefined, false, {
        channel: 'telegram:fixture',
      });
      await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [other]);
      await tasks.reply(other, 'Other channel answer.');
      for (const reaction of ['🧑🏽‍💻', '🧑🏽‍💻'])
        assert.equal(
          (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction })).statusCode,
          200,
        );
      assert.equal(
        (await db.pool.query("SELECT id FROM tasks WHERE source_id LIKE 'reaction:%'")).rowCount,
        1,
      );
      assert.equal(
        (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction: 'not emoji' }))
          .statusCode,
        400,
      );
      await tasks.boss.deleteAllJobs('assistant-task');
      await tasks.startTaskWorkers({
        runTask: async (context) => {
          seen.push(context);
          if (context.prompt === 'Hold old worker') {
            context.delta('Old stream', randomUUID());
            await gate;
          } else if (context.prompt === 'Fresh conversation') {
            context.delta('Fresh stream', randomUUID());
            await context.reply('Fresh answer.');
          }
          return { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused');
          },
        },
        requestCredential: async () => ({}),
        integration: async () => ({}),
        manage: async () => ({}),
      });
      const running = await tasks.submitTask('Hold old worker');
      await waitFor(async () => seen.some((context) => context.taskId === running));
      const held = seen.find((context) => context.taskId === running)!;
      const reset = await request('POST', '/api/conversation/reset', {});
      assert.equal(reset.statusCode, 200, reset.body);
      assert.deepEqual(reset.json(), { ok: true, conversationRevision: 1 });
      assert.equal(held.signal.aborted, true);
      await assert.rejects(held.reply('Late old answer'), /no longer active/);
      await assert.rejects(held.publishScreenshot!(Buffer.from('Late screen')), /no longer active/);
      assert.equal(
        (await db.pool.query('SELECT id FROM artifacts WHERE task_id=$1', [running])).rowCount,
        0,
      );
      const before = deltas.length;
      held.delta('Late old stream', randomUUID());
      assert.equal(deltas.length, before);
      const state = (await request('GET', '/api/state')).json();
      assert.equal(state.conversationRevision, 1);
      assert.deepEqual(state.messages, []);
      assert.deepEqual(state.tasks, []);
      assert.deepEqual(
        (
          await db.pool.query(
            'SELECT channel,status,conversation_revision FROM tasks WHERE id=$1',
            [other],
          )
        ).rows,
        [{ channel: 'telegram:fixture', status: 'succeeded', conversation_revision: 0 }],
      );
      assert.equal(
        (
          await db.pool.query("SELECT text FROM messages WHERE task_id=$1 AND role='assistant'", [
            other,
          ])
        ).rows[0].text,
        'Other channel answer.',
      );
      assert.deepEqual((await request('GET', '/api/messages')).json(), {
        messages: [],
        hasMore: false,
      });
      assert.equal((await request('GET', '/api/messages?conversationRevision=0')).statusCode, 409);
      assert.equal(
        (await request('POST', '/api/messages', { text: 'Stale draft', conversationRevision: 0 }))
          .statusCode,
        409,
      );
      assert.equal(
        (await request('POST', '/api/onboarding', { conversationRevision: 0 })).statusCode,
        409,
      );
      assert.equal(
        (await request('POST', `/api/messages/${oldMessage}/reaction`, { reaction: '😀' }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await request('POST', '/api/messages', {
            text: 'Old reply',
            replyToMessageId: oldMessage,
          })
        ).statusCode,
        404,
      );
      await assert.rejects(tasks.submitTask('Old continuation', [], old), /not found/);
      await assert.rejects(tasks.pauseOwnedTaskForControl(old), /not found/);
      const archived = await personal.manage('history_search', { query: 'Archived' });
      assert.deepEqual(archived, { tasks: [], messages: [] });
      const triageContexts: unknown[] = [];
      const triage = createTriage({
        getProfile: personal.getProfile,
        listGoals: personal.listGoals,
        classifier: {
          id: 'fixture',
          configured: true,
          classify: async (context) => {
            triageContexts.push(context);
            return 'digest';
          },
        },
      });
      await triage.initializeHeartbeat();
      await triage.triageEvent('Synthetic update after reset', 'reset-triage-fixture');
      assert.equal(triageContexts.length, 1);
      assert.equal(JSON.stringify(triageContexts).includes('Archived'), false);
      assert.equal(JSON.stringify(triageContexts).includes('Hold old worker'), false);
      assert.equal(
        (
          await request('POST', '/api/messages', {
            text: 'yes',
            replyToMessageId: confirmationMessageId,
            conversationRevision: 1,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request('POST', credential.url.replace('/vault/', '/api/credential-requests/'), {
            password: 'must-not-inject',
          })
        ).statusCode,
        409,
      );
      assert.equal(executed, 0);
      assert.equal(injected, 0);
      assert.equal((await request('GET', '/api/goals')).json().length, 1);
      assert.equal((await request('GET', '/api/schedules')).json().length, 1);
      assert.equal((await request('GET', '/api/vault')).json().length, 1);
      assert.equal((await request('GET', '/api/profile')).json().name, 'Fixture name');
      assert.equal((await request('GET', '/api/memory')).json().length, 1);
      assert.equal(
        (await db.pool.query('SELECT account_id FROM app_connections')).rows[0].account_id,
        'saved-fixture-account',
      );
      assert.ok((await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [old])).rowCount);
      const fresh = await request('POST', '/api/messages', {
        text: 'Fresh conversation',
        conversationRevision: 1,
      });
      assert.equal(fresh.statusCode, 200);
      await waitFor(
        async () =>
          (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [fresh.json().taskId]))
            .rows[0].status === 'succeeded',
      );
      const current = seen.find((context) => context.taskId === fresh.json().taskId)!;
      assert.deepEqual(current.history, []);
      assert.ok(current.memories.some((text) => text.includes('Saved fixture preference')));
      assert.equal(deltas.find((event) => event.taskId === running)?.conversationRevision, 0);
      assert.equal(
        deltas.find((event) => event.taskId === fresh.json().taskId)?.conversationRevision,
        1,
      );
      release();
      await waitFor(
        async () =>
          (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [running])).rows[0]
            .status === 'cancelled',
      );
      assert.equal(
        (await db.pool.query("SELECT id FROM messages WHERE text='Late old answer'")).rowCount,
        0,
      );
    } finally {
      release();
      events.off('event', onEvent);
      await app.close();
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map((row) => row.id as string);
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
