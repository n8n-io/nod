import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'execution failures report once through normal messages while obsolete and cancelled segments stay quiet',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_failures_${suffix}`;
    const bossSchema = `test_failures_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createChannels } = await import('../src/server/channels.ts');
    const { dataRoot } = await import('../src/server/config.ts');
    const app = Fastify();
    const held = new Map<string, () => void>();
    const attempted = new Set<string>();
    const diagnostics: Array<{ taskId: string; revision: number; error: unknown }> = [];
    const contexts: RuntimeContext[] = [];
    const runs = new Map<string, number>();
    const sent: Array<{ text: string; threadId: string }> = [];
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await delay(20);
      }
      throw new Error('Fixture condition did not complete.');
    };
    const row = async (id: string) =>
      (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
    const messages = async (id: string) =>
      (
        await db.pool.query(
          "SELECT * FROM messages WHERE task_id=$1 AND role='assistant' ORDER BY created_at,id",
          [id],
        )
      ).rows;
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: tasks.boss,
        submitTask: tasks.submitTask,
        refresh() {},
      }).initialize({ workers: false });
      await tasks.startTaskWorkers({
        async runTask(context) {
          attempted.add(context.taskId);
          contexts.push(context);
          const run = (runs.get(context.taskId) ?? 0) + 1;
          runs.set(context.taskId, run);
          if (context.checkOutcome) {
            await assert.rejects(context.startExternalAction!(), /earlier outcome/);
            await assert.rejects(context.manage('goal_create', {}), /earlier outcome/);
            if (context.prompt.includes('verify-done')) {
              await context.reportOutcome!('completed', 'The synthetic send went through.');
              return { status: 'succeeded' };
            }
            if (context.prompt.includes('verify-twice')) {
              if (run === 2) throw new Error('Synthetic check failure');
              await context.reportOutcome!('not_completed', 'The synthetic post did not happen.');
              return { status: 'succeeded' };
            }
            if (context.prompt.includes('verify-redo')) {
              await context.reportOutcome!('not_completed', 'The synthetic send did not happen.');
              return { status: 'succeeded' };
            }
            if (context.prompt.includes('verify-unknown')) {
              await context.waitForUser!('Did the synthetic send arrive?');
              return {
                status: 'waiting_user',
                waitingFor: 'question',
                question: 'Did the synthetic send arrive?',
              };
            }
          } else if (context.prompt.startsWith('The earlier step went through.'))
            return { status: 'succeeded' };
          else if (context.prompt.startsWith('flaky:') && run > 1) return { status: 'succeeded' };
          else if (context.prompt.startsWith('verify-redo') && run > 2)
            return { status: 'succeeded' };
          else if (/^(?:write|verify-)/.test(context.prompt)) await context.startExternalAction!();
          if (context.prompt.startsWith('held:') && run === 1)
            await new Promise<void>((resolve) => held.set(context.taskId, resolve));
          throw new Error('PRIVATE-FIXTURE-KEY provider implementation /private/fixture/path');
        },
        recoveryDelaysSeconds: [0, 0],
        recordFailure: async (taskId, revision, error) => {
          diagnostics.push({ taskId, revision, error });
          return new Promise<void>(() => {});
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused fixture.');
          },
        },
        requestCredential: async () => ({ url: '/vault/fixture' }),
        integration: async () => ({}),
        manage: async () => ({}),
      });
      await t.test(
        'setup failures before the runtime starts create a concise persisted reply',
        async () => {
          const artifactId = randomUUID();
          await db.pool.query(
            'INSERT INTO artifacts(id,owner_id,name,mime_type,size,storage_path) VALUES($1,$2,$3,$4,1,$5)',
            [
              artifactId,
              'local-development',
              'unavailable.txt',
              'text/plain',
              join(dataRoot, 'artifacts', `missing-${artifactId}`),
            ],
          );
          const id = await tasks.submitTask('Read the synthetic unavailable attachment', [
            {
              id: artifactId,
              name: 'unavailable.txt',
              mimeType: 'text/plain',
              size: 1,
              url: `/api/artifacts/${artifactId}`,
            },
          ]);
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.equal(attempted.has(id), false);
          const replies = await messages(id);
          assert.equal(replies.length, 1);
          assert.equal(replies[0].text, tasks.recoveryFailure);
          assert.equal(replies[0].stream_id, `failure:${id}:2`);
          assert.equal((await row(id)).revision, 2);
          assert.equal(replies[0].owner_id, 'local-development');
        },
      );
      await t.test(
        'duplicate delivery and a retry of a read-only failure preserve the original failed segment',
        async () => {
          const id = await tasks.submitTask('Fail the synthetic request');
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.equal((await row(id)).external_action, false);
          const first = (await messages(id))[0];
          await tasks.boss.send('assistant-task', { taskId: id, revision: 0 }, { retryLimit: 0 });
          await delay(650);
          assert.equal((await messages(id)).length, 1);
          const retried = await tasks.submitUserMessage('Retry the synthetic request', [], {
            replyToMessageId: first.id,
          });
          assert.equal(retried.continued, false);
          assert.notEqual(retried.taskId, id);
          assert.equal((await row(retried.taskId)).title, 'Retry the synthetic request');
          await waitFor(async () => (await row(retried.taskId)).status === 'failed');
          const replies = await messages(id);
          assert.deepEqual(
            replies.map((item) => item.stream_id),
            [`failure:${id}:2`],
          );
          assert.equal((await row(id)).revision, 2);
          assert.equal(
            (await db.pool.query('SELECT id FROM pending_task_inputs WHERE task_id=$1', [id]))
              .rowCount,
            0,
          );
          const publicData = JSON.stringify({
            task: await row(id),
            messages: replies,
            events: (await db.pool.query('SELECT * FROM task_events WHERE task_id=$1', [id])).rows,
          });
          assert.equal(publicData.includes('PRIVATE-FIXTURE-KEY'), false);
          assert.equal(publicData.includes('/private/fixture/path'), false);
          assert.ok(diagnostics.some((item) => item.taskId === id && item.revision === 0));
        },
      );
      const segments = (id: string) => contexts.filter((context) => context.taskId === id);
      await t.test(
        'a read-only failure retries quietly in a fresh session and succeeds',
        async () => {
          const id = await tasks.submitTask('flaky:Read the synthetic weather');
          await waitFor(async () => (await row(id)).status === 'succeeded');
          assert.deepEqual(
            segments(id).map((context) => [
              context.prompt,
              context.freshSession,
              context.checkOutcome,
            ]),
            [
              ['flaky:Read the synthetic weather', false, false],
              ['flaky:Read the synthetic weather', true, false],
            ],
          );
          assert.equal(segments(id)[1].currentMessageId, segments(id)[0].currentMessageId);
          assert.deepEqual(await messages(id), []);
          const task = await row(id);
          assert.deepEqual(
            [task.revision, task.recovery_attempts, task.fresh_session],
            [1, 1, false],
          );
        },
      );
      await t.test(
        'a failure after a started outside action checks the outcome first',
        async () => {
          const id = await tasks.submitTask('write:Send the synthetic confirmation');
          await waitFor(async () => (await row(id)).status === 'waiting_user');
          const [first, ...checks] = segments(id);
          assert.equal(first.checkOutcome, false);
          assert.equal(checks.length, 2);
          for (const check of checks) {
            assert.equal(check.checkOutcome, true);
            assert.equal(check.freshSession, true);
            assert.match(check.prompt, /check with read-only steps/);
            assert.match(check.prompt, /write:Send the synthetic confirmation/);
          }
          const task = await row(id);
          assert.equal(task.waiting_reason, 'question');
          assert.deepEqual(
            (await messages(id)).map((item) => item.text),
            [
              'I couldn’t check whether “write:Send the synthetic confirmation” went through. Can you check it and tell me?',
            ],
          );
          const answer = await tasks.submitUserMessage('It did not arrive', [], {
            replyToMessageId: (await messages(id))[0].id,
          });
          assert.equal(answer.taskId, id);
          assert.equal(answer.continued, true);
          const continued = await row(id);
          assert.deepEqual(
            [continued.external_action, continued.recovery_attempts, continued.recovery_mode],
            [false, 0, null],
          );
        },
      );
      await t.test('a verified outside action continues without a redo', async () => {
        const id = await tasks.submitTask('verify-done:Send the synthetic reminder');
        await waitFor(
          async () =>
            (await row(id)).status === 'succeeded' &&
            segments(id).some((context) => context.prompt.startsWith('The earlier step')),
        );
        const prompts = segments(id).map((context) => context.prompt);
        assert.equal(prompts.length, 3);
        assert.equal(prompts[0], 'verify-done:Send the synthetic reminder');
        assert.equal(segments(id)[1].checkOutcome, true);
        assert.match(prompts[2], /^The earlier step went through\./);
        assert.equal(
          prompts.filter((prompt) => prompt === 'verify-done:Send the synthetic reminder').length,
          1,
        );
        assert.deepEqual(
          (await messages(id)).map((item) => item.text),
          ['The synthetic send went through.'],
        );
        assert.equal((await row(id)).external_action, false);
      });
      await t.test('a verified missing action is redone through the original request', async () => {
        const id = await tasks.submitTask('verify-redo:Send the synthetic note');
        await waitFor(async () => (await row(id)).status === 'succeeded');
        assert.deepEqual(
          segments(id).map((context) => [context.prompt.slice(0, 11), context.checkOutcome]),
          [
            ['verify-redo', false],
            ['An earlier ', true],
            ['verify-redo', false],
          ],
        );
        assert.equal(segments(id)[2].currentMessageId, segments(id)[0].currentMessageId);
        assert.equal((await row(id)).recovery_attempts, 2);
      });
      await t.test('a redo beyond the recovery limit ends with one plain message', async () => {
        const id = await tasks.submitTask('verify-twice:Post the synthetic update');
        await waitFor(async () => (await row(id)).status === 'failed');
        await delay(200);
        assert.deepEqual(
          segments(id).map((context) => context.checkOutcome),
          [false, true, true],
        );
        assert.deepEqual(
          (await messages(id)).map((item) => item.text),
          ['The synthetic post did not happen.', tasks.recoveryFailure],
        );
      });
      await t.test('an outcome that cannot be checked asks one plain question', async () => {
        const id = await tasks.submitTask('verify-unknown:Send the synthetic invite');
        await waitFor(async () => (await row(id)).status === 'waiting_user');
        assert.equal(segments(id).length, 2);
        assert.deepEqual(
          (await messages(id)).map((item) => item.text),
          ['Did the synthetic send arrive?'],
        );
      });
      await t.test(
        'an already accepted follow-up remains held when its active segment fails',
        async () => {
          const id = await tasks.submitTask('held:synthetic work with a queued follow-up');
          await waitFor(() => held.has(id));
          await tasks.submitUserMessage('Add the synthetic supporting detail', [], { taskId: id });
          held.get(id)!();
          await waitFor(async () => (await row(id)).status === 'failed');
          await delay(100);
          assert.equal((await row(id)).revision, 2);
          assert.deepEqual(
            (await db.pool.query('SELECT state FROM pending_task_inputs WHERE task_id=$1', [id]))
              .rows,
            [{ state: 'pending' }],
          );
          assert.ok(segments(id).every((context) => context.prompt.startsWith('held:')));
          assert.equal((await messages(id)).length, 1);
        },
      );
      await t.test(
        'cancelled, superseded, reset and no-longer-owned failures cannot publish',
        async () => {
          for (const mode of ['cancel', 'revision', 'owner', 'reset']) {
            const id = await tasks.submitTask(`held:${mode}`);
            await waitFor(() => held.has(id));
            if (mode === 'cancel') await tasks.cancelTask(id);
            if (mode === 'revision')
              await db.pool.query('UPDATE tasks SET revision=revision+1 WHERE id=$1', [id]);
            if (mode === 'owner')
              await db.pool.query("UPDATE tasks SET owner_id='foreign-owner' WHERE id=$1", [id]);
            if (mode === 'reset') await tasks.resetConversation();
            const before = diagnostics.length;
            held.get(id)!();
            await delay(75);
            assert.deepEqual(await messages(id), []);
            assert.equal(diagnostics.length, before);
            if (mode === 'revision') await tasks.cancelTask(id);
          }
        },
      );
      await t.test(
        'background failures stay quiet while private diagnostics cannot block completion',
        async () => {
          const id = await tasks.submitTask('Synthetic quiet review failure', [], undefined, true, {
            source: 'event',
          });
          await waitFor(async () => (await row(id)).status === 'failed');
          assert.deepEqual(await messages(id), []);
          assert.ok(diagnostics.some((item) => item.taskId === id));
        },
      );
      await t.test(
        'channel failures enter the existing outbox and are delivered only once to the same thread',
        async () => {
          channels = await createChannels(db.pool, {
            ownerId: 'local-development',
            intervalMs: 60_000,
            transport: {
              channels: [
                {
                  id: 'telegram',
                  status: 'configured',
                  missing: [],
                  accountId: 'fixture-bot',
                  allowedSenderIds: ['fixture-owner'],
                },
              ],
              receive: async () => ({
                status: 200,
                body: 'ok',
                messages: [
                  {
                    channelId: 'telegram',
                    accountId: 'fixture-bot',
                    senderId: 'fixture-owner',
                    messageId: 'failure-message',
                    threadId: 'fixture-dm',
                    text: 'Synthetic channel failure',
                    sentAt: new Date(),
                  },
                ],
              }),
              post: async (input) => {
                sent.push({ text: input.text, threadId: input.threadId });
                return { id: randomUUID() };
              },
              close: async () => {},
            },
            submit: async (text, sourceId, client, channel) =>
              (await tasks.submitUserMessage(text, [], { sourceId, client, channel })).taskId,
            subscribe: () => () => {},
          });
          channels.registerRoutes(app);
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          const id = (
            await db.pool.query(
              "SELECT task_id FROM channel_inbox WHERE source_id='channel:telegram:fixture-bot:failure-message'",
            )
          ).rows[0].task_id;
          await waitFor(async () => (await row(id)).status === 'failed');
          await channels.drain();
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          assert.deepEqual(sent, [{ text: tasks.recoveryFailure, threadId: 'fixture-dm' }]);
          assert.equal((await db.pool.query('SELECT * FROM channel_outbox')).rowCount, 1);
        },
      );
    } finally {
      for (const release of held.values()) release();
      await channels?.close();
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
