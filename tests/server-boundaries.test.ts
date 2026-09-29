import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import type { ApprovalExecutionContext } from '../src/server/approvals.ts';

test('localhost access rejects foreign Host, Origin and browser cross-site requests', async () => {
  const app = Fastify();
  registerLocalAccess(app, 4310);
  app.get('/api/fixture', async () => ({ ok: true }));
  app.post('/api/fixture', async () => ({ ok: true }));
  app.get('/api/apps/callback', async () => ({ ok: true }));
  try {
    for (const headers of [
      { host: 'attacker.example:4310' },
      { host: 'localhost:4311' },
      { host: 'localhost:4310', origin: 'https://attacker.example' },
      { host: 'localhost:4310', origin: 'null' },
      { host: 'localhost:4310', origin: 'https://localhost:4310' },
      { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        403,
      );
    for (const host of ['localhost:4310', '127.0.0.1:4310', '[::1]:4310']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/fixture',
        headers: { host, origin: `http://${host}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    }
    assert.equal(
      (
        await app.inject({
          url: '/api/apps/callback?fixture=yes',
          headers: { host: 'localhost:4310', 'sec-fetch-site': 'cross-site' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test(
  'server artifacts, approvals and personal data preserve PostgreSQL ownership and review boundaries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'otto-server-boundaries-')));
    const previousDirectory = process.cwd();
    process.chdir(fixtureRoot);
    t.after(async () => {
      process.chdir(previousDirectory);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_server_${suffix}`;
    const bossSchema = `test_server_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const artifacts = await import('../src/server/artifacts.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    assert.equal(dataRoot, join(fixtureRoot, '.local'));
    let userMessages: ReturnType<typeof tasks.createUserMessageService>;
    const app = await createApp({
      submitMessage: (text, attachments, options) =>
        userMessages.submit(text, attachments, options),
      configuration: () => configuration({ llmReady: true }),
    });
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
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
    const directories: string[] = [];
    let approvals: Awaited<ReturnType<typeof createApprovals>>;
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
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
    const newTask = async (status = 'running', owner = ownerId) => {
      const id = randomUUID();
      const source = randomUUID();
      await db.pool.query(
        'INSERT INTO tasks(id,owner_id,title,prompt,status) VALUES($1,$2,$3,$3,$4)',
        [id, owner, 'Synthetic boundary fixture', status],
      );
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,'user','Synthetic boundary fixture',$3)",
        [source, owner, id],
      );
      await db.pool.query('UPDATE tasks SET source_message_id=$2 WHERE id=$1', [id, source]);
      return id;
    };
    const stored = async (id: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE id=$1', [id])).rows[0];
    async function propose(taskId: string, action: string, args: Record<string, unknown>) {
      const revision = (await db.pool.query('SELECT revision FROM tasks WHERE id=$1', [taskId]))
        .rows[0].revision;
      const result = await approvals.request(taskId, action, args, { revision });
      assert.ok(result && typeof result === 'object' && 'requiresConfirmation' in result);
      assert.equal(result.requiresConfirmation, true);
      assert.equal('url' in result, false);
      const record = (
        await db.pool.query('SELECT * FROM approvals WHERE task_id=$1 AND task_revision=$2', [
          taskId,
          revision,
        ])
      ).rows[0];
      assert.ok(record.confirmation_message_id);
      return record.id as string;
    }
    async function confirm(id: string, approved: boolean, extra: Record<string, unknown> = {}) {
      const record = await stored(id);
      return db.transaction((client) =>
        approvals.acceptChat(client, {
          text: approved ? 'Yes' : 'No',
          channel: 'web',
          conversationRevision: 0,
          replyToMessageId: record.confirmation_message_id,
          clientMessageId: randomUUID(),
          ...extra,
        }),
      );
    }
    async function execute(id: string) {
      const record = await stored(id);
      await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1 AND status='queued'", [
        record.task_id,
      ]);
      const task = (await db.pool.query('SELECT revision FROM tasks WHERE id=$1', [record.task_id]))
        .rows[0];
      return approvals.executeConfirmed(
        record.task_id,
        task.revision,
        new AbortController().signal,
      );
    }
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      approvals = await createApprovals(
        async (action, args, context) => {
          calls.push({ action, args, context });
          if (executionGate) await executionGate;
          if (failExecution) throw new Error('Fixture provider detail must not be exposed.');
          return { successful: true, id: 'fixture-provider-result' };
        },
        async () => {
          if (rejectPreflight)
            throw Object.assign(new Error('This approval needs a new account selection.'), {
              statusCode: 409,
            });
        },
      );
      userMessages = tasks.createUserMessageService({ confirmAction: approvals.acceptChat });
      personal.registerRoutes(app);
      app.get('/api/fixture-error', async () => {
        throw new Error('fixture-private-key');
      });

      await t.test(
        'artifacts are owned, path bounded, and active documents download with sandbox headers',
        async () => {
          const id = await newTask('succeeded');
          const workspace = join(dataRoot, 'workspaces', id);
          const privateDir = await mkdtemp(join(tmpdir(), 'otto-artifact-test-'));
          directories.push(workspace, privateDir);
          await mkdir(workspace, { recursive: true });
          await writeFile(join(privateDir, 'private.txt'), 'private fixture');
          await symlink(join(privateDir, 'private.txt'), join(workspace, 'escape.txt'));
          const read = async (taskId: string, path: string, maxBytes: number) => {
            assert.equal(taskId, id);
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
          const response = await request('GET', published.url);
          assert.equal(response.statusCode, 200);
          assert.match(String(response.headers['content-disposition']), /^attachment;/);
          assert.equal(response.headers['content-type'], 'text/html');
          assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
          assert.match(response.body, /window.fixture/);
          for (const [name, mime] of [
            ['preview.pdf', 'application/pdf'],
            ['preview.mp4', 'video/mp4'],
            ['preview.m4a', 'audio/mp4'],
            ['preview.svg', 'image/svg+xml'],
          ]) {
            await writeFile(join(workspace, name), '0123456789');
            const media = await artifacts.publishArtifact(id, name, undefined, read);
            assert.equal(media.mimeType, mime);
            const full = await request('GET', media.url);
            assert.match(String(full.headers['content-disposition']), /^inline;/);
            assert.equal(full.headers['cache-control'], 'private, no-store');
            assert.equal(full.headers['content-security-policy'], "default-src 'none'; sandbox");
            assert.equal(full.headers['x-content-type-options'], 'nosniff');
            const partial = await app.inject({
              method: 'GET',
              url: media.url,
              headers: { ...headers, range: 'bytes=2-5' },
            });
            assert.equal(partial.statusCode, 206);
            assert.equal(partial.body, '2345');
            assert.equal(partial.headers['content-range'], 'bytes 2-5/10');
            const suffix = await app.inject({
              method: 'GET',
              url: media.url,
              headers: { ...headers, range: 'bytes=-3' },
            });
            assert.equal(suffix.body, '789');
            for (const range of [
              'bytes=30-',
              'bytes=5-2',
              'bytes=-0',
              'bytes=0-1,4-5',
              'bytes=-',
            ]) {
              const invalid = await app.inject({
                method: 'GET',
                url: media.url,
                headers: { ...headers, range },
              });
              assert.equal(invalid.statusCode, 416);
              assert.equal(invalid.headers['content-range'], 'bytes */10');
            }
            await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
              media.id,
              'another-owner',
            ]);
            assert.equal(
              (
                await app.inject({
                  method: 'GET',
                  url: media.url,
                  headers: { ...headers, range: 'bytes=0-1' },
                })
              ).statusCode,
              404,
            );
          }
          await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
            published.id,
            'another-owner',
          ]);
          assert.equal((await request('GET', published.url)).statusCode, 404);
          assert.equal((await request('GET', '/api/artifacts/not-a-uuid')).statusCode, 400);
          await assert.rejects(artifacts.storeArtifact(Buffer.alloc(0), 'empty', 'text/plain'));
          await assert.rejects(
            artifacts.storeArtifact(Buffer.alloc(artifacts.maxFileSize + 1), 'large', 'text/plain'),
          );
          const artifactDirectory = join(dataRoot, 'artifacts');
          const beforeFailedInsert = await readdir(artifactDirectory);
          await assert.rejects(
            artifacts.storeArtifact(
              Buffer.from('Orphan fixture'),
              'orphan.txt',
              'text/plain',
              randomUUID(),
            ),
          );
          assert.deepEqual(await readdir(artifactDirectory), beforeFailedInsert);
          const error = await request('GET', '/api/fixture-error');
          assert.equal(error.statusCode, 500);
          assert.equal(error.body.includes('fixture-private-key'), false);
        },
      );

      await t.test('removed approval HTTP routes cannot read or authorize an action', async () => {
        const id = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
        assert.equal((await request('GET', `/api/approvals/${id}`)).statusCode, 404);
        assert.equal(
          (await request('POST', `/api/approvals/${id}`, { approved: true })).statusCode,
          404,
        );
        assert.equal((await stored(id)).status, 'pending');
      });

      await t.test(
        'chat confirmation executes the stored snapshot once and queues only one continuation',
        async () => {
          const taskId = await newTask();
          const source = (
            await db.pool.query('SELECT source_message_id FROM tasks WHERE id=$1', [taskId])
          ).rows[0].source_message_id;
          const original = {
            recipient: 'fixture@example.test',
            subject: 'Confirmed snapshot',
            nested: { text: 'original' },
          };
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', original);
          original.nested.text = 'changed after request';
          assert.equal((await stored(id)).args.nested.text, 'original');
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: (await stored(id)).confirmation_message_id,
                args: { recipient: 'attacker@example.test' },
              })
            ).statusCode,
            400,
          );
          const before = calls.length;
          const decisions = await Promise.allSettled(
            Array.from({ length: 4 }, () => confirm(id, true)),
          );
          assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
          for (const result of decisions)
            if (result.status === 'rejected') assert.equal(result.reason.statusCode, 409);
          assert.equal(calls.length, before);
          await Promise.all(Array.from({ length: 4 }, () => execute(id)));
          assert.equal(calls.length, before + 1);
          assert.deepEqual(calls.at(-1), {
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient: 'fixture@example.test',
              subject: 'Confirmed snapshot',
              nested: { text: 'original' },
            },
            context: { taskId, sourceMessageId: source },
          });
          const task = (
            await db.pool.query('SELECT status,revision,prompt FROM tasks WHERE id=$1', [taskId])
          ).rows[0];
          assert.equal(task.status, 'running');
          assert.equal(task.revision, 1);
          assert.match(task.prompt, /Do not repeat it/);
          assert.equal((await stored(id)).status, 'completed');
          assert.equal(
            (
              await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
                taskId,
              ])
            ).rowCount,
            1,
          );
        },
      );

      await t.test(
        'confirmation provenance stays within its task and rejects a foreign or missing user source',
        async () => {
          const [firstTask, secondTask, unownedTask] = await Promise.all([
            newTask(),
            newTask(),
            newTask(),
          ]);
          async function message(taskId: string, role: string, owner: string, offset: number) {
            const id = randomUUID();
            await db.pool.query(
              "INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,$2,$3,'Provenance fixture',$4,now()+$5*interval '1 second')",
              [id, owner, role, taskId, offset],
            );
            return id;
          }
          const firstSource = await message(firstTask, 'user', ownerId, -30);
          const secondSource = await message(secondTask, 'user', ownerId, -20);
          const foreignSource = await message(unownedTask, 'user', 'another-owner', 0);
          for (const [taskId, source] of [
            [firstTask, firstSource],
            [secondTask, secondSource],
            [unownedTask, foreignSource],
          ])
            await db.pool.query(
              "UPDATE tasks SET source_message_id=$2,prompt='Provenance fixture' WHERE id=$1",
              [taskId, source],
            );
          await message(firstTask, 'user', 'another-owner', -10);
          await message(firstTask, 'assistant', ownerId, -5);
          const [first, second] = await Promise.all([
            propose(firstTask, 'OTTO_memory_propose', {
              text: 'First task fact',
              sourceMessageId: secondSource,
            }),
            propose(secondTask, 'OTTO_memory_propose', { text: 'Second task fact' }),
          ]);
          await assert.rejects(
            approvals.request(
              unownedTask,
              'OTTO_memory_propose',
              { text: 'No owned source' },
              { revision: 0 },
            ),
            /direct request/,
          );
          await db.pool.query('UPDATE tasks SET source_message_id=NULL WHERE id=$1', [unownedTask]);
          await assert.rejects(
            approvals.request(unownedTask, 'OTTO_memory_propose', {}, { revision: 0 }),
            /direct request/,
          );
          await message(firstTask, 'user', ownerId, 2);
          await message(secondTask, 'user', ownerId, 3);
          await Promise.all([confirm(first, true), confirm(second, true)]);
          await Promise.all([execute(first), execute(second)]);
          assert.deepEqual(calls.find((call) => call.context.taskId === firstTask)?.context, {
            taskId: firstTask,
            sourceMessageId: firstSource,
          });
          assert.deepEqual(calls.find((call) => call.context.taskId === secondTask)?.context, {
            taskId: secondTask,
            sourceMessageId: secondSource,
          });
          assert.equal((await stored(first)).source_message_id, firstSource);
          assert.equal(
            calls.some((call) => call.context.taskId === unownedTask),
            false,
          );
        },
      );

      await t.test(
        'a confirmation preserves its original source while later input stays queued',
        async () => {
          const taskId = await tasks.submitTask('Review the original synthetic fact');
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [taskId]);
          const source = (
            await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [
              taskId,
            ])
          ).rows[0].id;
          await tasks.submitUserMessage(
            'This later instruction must not become the earlier confirmation source',
            [],
            { replyToMessageId: source },
          );
          const pending = (
            await db.pool.query(
              "SELECT message_id FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
              [taskId],
            )
          ).rows[0];
          assert.ok(pending);
          const id = await propose(taskId, 'OTTO_memory_propose', {
            text: 'The original synthetic fact',
          });
          await confirm(id, true);
          await execute(id);
          assert.equal(
            calls.find((call) => call.context.taskId === taskId)?.context.sourceMessageId,
            source,
          );
          assert.equal((await stored(id)).source_message_id, source);
          assert.equal(
            (
              await db.pool.query('SELECT state FROM pending_task_inputs WHERE message_id=$1', [
                pending.message_id,
              ])
            ).rows[0].state,
            'pending',
          );
          const revision = (await db.pool.query('SELECT revision FROM tasks WHERE id=$1', [taskId]))
            .rows[0].revision;
          await assert.rejects(
            approvals.request(taskId, 'FIXTURE_SECOND_ACTION', {}, { revision }),
            /direct request/,
          );
          await tasks.cancelTask(taskId);
        },
      );

      await t.test(
        'preflight rejects invalid proposals and confirmed obsolete actions before any uncertain execution',
        async () => {
          const taskId = await newTask();
          const before = calls.length;
          rejectPreflight = true;
          try {
            await assert.rejects(
              approvals.request(taskId, 'GMAIL_SEND_EMAIL', {}, { revision: 0 }),
              { statusCode: 409 },
            );
            assert.equal(
              (await db.pool.query('SELECT id FROM approvals WHERE task_id=$1', [taskId])).rowCount,
              0,
            );
          } finally {
            rejectPreflight = false;
          }
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
          rejectPreflight = true;
          try {
            await assert.rejects(confirm(id, true), { statusCode: 409 });
            assert.equal((await stored(id)).status, 'pending');
          } finally {
            rejectPreflight = false;
          }
          await confirm(id, true);
          rejectPreflight = true;
          try {
            await assert.rejects(execute(id), { statusCode: 409 });
            assert.equal((await stored(id)).status, 'confirmed');
            assert.equal(calls.length, before);
          } finally {
            rejectPreflight = false;
          }
          await tasks.cancelTask(taskId);
        },
      );

      await t.test(
        'cancelled, expired, wrong-channel and foreign confirmations cannot execute',
        async () => {
          const before = calls.length;
          const cancelledTask = await newTask();
          const cancelled = await propose(cancelledTask, 'GMAIL_SEND_EMAIL', {});
          await tasks.cancelTask(cancelledTask);
          await assert.rejects(confirm(cancelled, true), { statusCode: 409 });
          const expired = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query(
            "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
            [expired],
          );
          await assert.rejects(confirm(expired, true), { statusCode: 409 });
          const foreign = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query('UPDATE approvals SET owner_id=$2 WHERE id=$1', [
            foreign,
            'another-owner',
          ]);
          assert.equal(await confirm(foreign, true), undefined);
          const otherChannel = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
          assert.equal(await confirm(otherChannel, true, { channel: 'telegram' }), undefined);
          assert.equal((await stored(otherChannel)).status, 'pending');
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'stale revision, generation and changed consent cannot authorize a snapshot',
        async () => {
          const taskId = await newTask();
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', { subject: 'obsolete' });
          assert.equal(
            await confirm(id, true, { text: 'Yes, but send it to somebody else' }),
            undefined,
          );
          await assert.rejects(confirm(id, true, { conversationRevision: 1 }), { statusCode: 409 });
          await assert.rejects(confirm(id, true, { taskId: randomUUID() }), { statusCode: 409 });
          await db.pool.query(
            "UPDATE tasks SET revision=revision+1,status='waiting_user' WHERE id=$1",
            [taskId],
          );
          const before = calls.length;
          await assert.rejects(confirm(id, true), { statusCode: 409 });
          assert.equal(calls.length, before);
          await assert.rejects(
            approvals.request(await newTask(), 'GMAIL_SEND_EMAIL', {}, { revision: 99 }),
            { statusCode: 409 },
          );
        },
      );

      await t.test(
        'an unbound yes cannot consume an older question after another assistant message',
        async () => {
          const taskId = await newTask();
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,task_id,role,text,created_at) VALUES($1,$2,$3,'assistant','An unrelated question',now()+interval '1 second')",
            [randomUUID(), ownerId, await newTask()],
          );
          assert.equal(await confirm(id, true, { replyToMessageId: undefined }), undefined);
          assert.equal((await stored(id)).status, 'pending');
          assert.ok(await confirm(id, false));
        },
      );

      await t.test(
        'a connection callback resumes only its current waiting task revision',
        async () => {
          const taskId = await newTask();
          await db.pool.query(
            "UPDATE tasks SET status='waiting_user',waiting_reason='question' WHERE id=$1",
            [taskId],
          );
          assert.equal(await tasks.resumeConnectedTask(taskId, 1, 'linear'), false);
          let task = (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
          assert.equal(task.status, 'waiting_user');
          assert.equal(await tasks.resumeConnectedTask(taskId, 0, 'linear'), true);
          task = (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [taskId])).rows[0];
          assert.equal(task.status, 'queued');
          assert.equal(task.revision, 1);
          assert.equal(task.action_resume_kind, 'connection');
          assert.equal(task.action_resume_revision, 1);
          assert.match(task.prompt, /linear connection completed/);
          assert.equal(await tasks.resumeConnectedTask(taskId, 0, 'linear'), false);
          assert.equal(
            (
              await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
                taskId,
              ])
            ).rowCount,
            1,
          );
        },
      );

      await t.test(
        'an old secure-entry callback cannot resume a newer credential wait',
        async () => {
          const taskId = await newTask();
          await db.pool.query(
            "UPDATE tasks SET status='waiting_user',waiting_reason='browser' WHERE id=$1",
            [taskId],
          );
          const paused = await tasks.pauseOwnedTaskForControl(taskId);
          await tasks.resumeOwnedTaskFromControl(taskId, paused.revision);
          await db.pool.query(
            "UPDATE tasks SET status='waiting_credentials',waiting_reason='credentials' WHERE id=$1",
            [taskId],
          );
          const before = (
            await db.pool.query(
              'SELECT status,revision,action_resume_kind,action_resume_revision FROM tasks WHERE id=$1',
              [taskId],
            )
          ).rows[0];
          const jobsBefore = (
            await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
              taskId,
            ])
          ).rowCount;
          await tasks.resumeTask(taskId, 0);
          assert.deepEqual(
            (
              await db.pool.query(
                'SELECT status,revision,action_resume_kind,action_resume_revision FROM tasks WHERE id=$1',
                [taskId],
              )
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
                taskId,
              ])
            ).rowCount,
            jobsBefore,
          );
          await tasks.resumeTask(taskId, before.revision);
          const resumed = (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [taskId]))
            .rows[0];
          assert.equal(resumed.status, 'queued');
          assert.equal(resumed.revision, before.revision + 1);
          assert.equal(resumed.action_resume_kind, 'credentials');
          assert.equal(resumed.action_resume_revision, resumed.revision);
          assert.equal(
            (
              await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
                taskId,
              ])
            ).rowCount,
            jobsBefore! + 1,
          );
        },
      );

      await t.test(
        'declining resumes once without executing and uncertain actions cannot replay',
        async () => {
          const taskId = await newTask();
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
          const before = calls.length;
          assert.ok(await confirm(id, false));
          assert.equal(calls.length, before);
          const task = (
            await db.pool.query('SELECT status,prompt FROM tasks WHERE id=$1', [taskId])
          ).rows[0];
          assert.equal(task.status, 'queued');
          assert.match(task.prompt, /user declined/);
          assert.equal((await stored(id)).status, 'declined');
          await assert.rejects(confirm(id, true), { statusCode: 409 });
          assert.equal(await execute(id), undefined);
          const failed = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
          await confirm(failed, true);
          failExecution = true;
          try {
            await assert.rejects(execute(failed), (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.doesNotMatch(error.message, /Fixture provider detail/);
              return (error as Error & { statusCode: number }).statusCode === 502;
            });
          } finally {
            failExecution = false;
          }
          assert.equal((await stored(failed)).status, 'uncertain');
          assert.equal(await execute(failed), undefined);
          await assert.rejects(confirm(failed, true), { statusCode: 409 });
          assert.equal(calls.length, before + 1);
        },
      );

      await t.test('a failed decline enqueue rolls back both the decision and reply', async () => {
        const taskId = await newTask();
        const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
        const initialMessages = (
          await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [taskId])
        ).rowCount;
        const send = t.mock.method(tasks.boss, 'send', async () => {
          throw new Error('Injected queue failure');
        });
        try {
          await assert.rejects(confirm(id, false), /Injected queue failure/);
        } finally {
          send.mock.restore();
        }
        assert.equal((await stored(id)).status, 'pending');
        assert.equal(
          (await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [taskId])).rowCount,
          initialMessages,
        );
        assert.ok(await confirm(id, false));
        assert.equal(
          (
            await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
              taskId,
            ])
          ).rowCount,
          1,
        );
      });

      await t.test(
        'cancellation after chat acceptance prevents the worker from executing',
        async () => {
          const taskId = await newTask();
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
          await confirm(id, true);
          const before = calls.length;
          await tasks.cancelTask(taskId);
          assert.equal(await execute(id), undefined);
          assert.equal(calls.length, before);
          assert.equal((await stored(id)).status, 'confirmed');
        },
      );

      await t.test(
        'cancellation during confirmed execution records its result without waking the task',
        async () => {
          const taskId = await newTask();
          const id = await propose(taskId, 'GMAIL_SEND_EMAIL', {});
          await confirm(id, true);
          let release = () => {};
          executionGate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const pending = execute(id);
          const completed = assert.rejects(pending, { statusCode: 409 });
          try {
            for (let attempt = 0; attempt < 100; attempt++) {
              if ((await stored(id)).status === 'executing') break;
              await delay(5);
            }
            assert.equal((await stored(id)).status, 'executing');
            await tasks.cancelTask(taskId);
            release();
            await completed;
            assert.equal((await stored(id)).status, 'completed');
            assert.equal(
              (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [taskId])).rows[0]
                .status,
              'cancelled',
            );
            assert.equal(
              (
                await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'taskId'=$1`, [
                  taskId,
                ])
              ).rowCount,
              1,
            );
          } finally {
            release();
            executionGate = undefined;
            await completed;
          }
          const interrupted = await propose(await newTask(), 'GMAIL_SEND_EMAIL', {});
          await db.pool.query("UPDATE approvals SET status='executing' WHERE id=$1", [interrupted]);
          await createApprovals(async () => {
            throw new Error('Must not automatically retry');
          });
          assert.equal((await stored(interrupted)).status, 'uncertain');
          await assert.rejects(confirm(interrupted, true), { statusCode: 409 });
        },
      );

      await t.test(
        'profile, memory, history and goals retain explicit data and ownership',
        async () => {
          const profile = {
            name: 'Fixture User',
            location: 'Lisbon',
            phone: '+351000000000',
            preferences: 'Concise answers',
          };
          assert.equal((await request('PUT', '/api/profile', profile)).statusCode, 200);
          assert.deepEqual((await request('GET', '/api/profile')).json(), profile);
          assert.equal(
            (await request('PUT', '/api/profile', { ...profile, inferredHealth: 'not accepted' }))
              .statusCode,
            400,
          );
          await personal.manage('memory_propose', {
            text: 'Fixture explicitly prefers concise answers',
          });
          await personal.manage('memory_propose', {
            text: 'Fixture explicitly prefers concise answers',
          });
          const memory = await request('GET', '/api/memory');
          assert.equal(memory.json().length, 1);
          const foreign = randomUUID();
          await db.pool.query('INSERT INTO memory_facts(id,owner_id,text) VALUES($1,$2,$3)', [
            foreign,
            'another-owner',
            'Foreign private fixture',
          ]);
          await request('DELETE', `/api/memory/${foreign}`);
          assert.equal(
            (await db.pool.query('SELECT id FROM memory_facts WHERE id=$1', [foreign])).rowCount,
            1,
          );
          const goal = await request('POST', '/api/goals', {
            title: 'Fixture milestone',
            description: 'An explicit objective',
          });
          assert.equal(goal.statusCode, 200);
          const id = goal.json().id;
          assert.equal(
            (await request('PATCH', `/api/goals/${id}`, { progress: 101 })).statusCode,
            400,
          );
          assert.equal(
            (
              await request('PATCH', `/api/goals/${id}`, {
                progress: 50,
                nextAction: 'Review result',
                status: 'active',
              })
            ).statusCode,
            200,
          );
          assert.equal((await request('GET', '/api/goals')).json()[0].progress, 50);
          await db.pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [id, 'another-owner']);
          assert.equal(
            (await request('PATCH', `/api/goals/${id}`, { progress: 100 })).statusCode,
            404,
          );
          const foreignTask = await newTask('succeeded', 'another-owner');
          await db.pool.query(
            'INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,$2,$3,$4,$5)',
            [randomUUID(), 'another-owner', 'user', 'BoundarySecretKeyword', foreignTask],
          );
          assert.deepEqual(
            await personal.manage('history_search', { query: 'BoundarySecretKeyword' }),
            { tasks: [], messages: [] },
          );
        },
      );

      await t.test(
        'schedules persist exact timezone-aware delayed jobs and deletion cancels only owned work',
        async () => {
          const result = await request('POST', '/api/schedules', {
            title: 'Future fixture',
            prompt: 'No external activity',
            cron: '0 9 1 1 *',
            timeZone: 'Europe/Lisbon',
          });
          assert.equal(result.statusCode, 200);
          const schedule = result.json();
          assert.equal(
            (await request('GET', '/api/schedules')).json()[0].timeZone,
            'Europe/Lisbon',
          );
          const queued = (
            await db.pool.query(
              `SELECT j.id,j.state,j.data,j.start_after FROM schedules s JOIN ${bossSchema}.job j ON j.id=s.job_id WHERE s.id=$1`,
              [schedule.id],
            )
          ).rows[0];
          assert.equal(queued.state, 'created');
          assert.equal(queued.data.scheduleId, schedule.id);
          assert.equal(queued.data.revision, schedule.revision);
          assert.equal(queued.start_after.toISOString(), schedule.nextRun);
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
          assert.equal((await request('GET', '/api/schedules')).json().length, 0);
          assert.equal(
            (await db.pool.query(`SELECT state FROM ${bossSchema}.job WHERE id=$1`, [queued.id]))
              .rows[0].state,
            'cancelled',
          );
          assert.equal(
            (
              await request('POST', '/api/schedules', {
                title: 'Invalid',
                prompt: 'Fixture',
                cron: '* * * * * *',
                timeZone: 'Europe/Lisbon',
              })
            ).statusCode,
            400,
          );
          const foreign = (
            await request('POST', '/api/schedules', {
              title: 'Foreign fixture',
              prompt: 'No external activity',
              cron: '0 9 1 1 *',
              timeZone: 'Europe/Lisbon',
            })
          ).json();
          await db.pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'another-owner',
          ]);
          assert.equal((await request('DELETE', `/api/schedules/${foreign.id}`)).statusCode, 404);
          assert.equal(
            (
              await db.pool.query(
                `SELECT j.id FROM schedules s JOIN ${bossSchema}.job j ON j.id=s.job_id WHERE s.id=$1 AND j.state='created'`,
                [foreign.id],
              )
            ).rowCount,
            1,
          );
        },
      );
    } finally {
      await app.close();
      await tasks.stopTasks();
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
