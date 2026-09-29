import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext } from '../src/ports/agent.ts';

test(
  'one conversation routes replies to the latest question or an owned message in the same channel',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_continue_${suffix}`;
    const bossSchema = `test_continue_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text');
      const waitFor = async (check: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await check()) return;
          await delay(50);
        }
        throw new Error('Fixture condition did not complete');
      };
      const waitingTask = async (title: string, reason = 'question', channel = 'web') => {
        const id = await tasks.submitTask(title, [], undefined, false, { channel });
        await db.pool.query(
          "UPDATE tasks SET status=$2,waiting_reason=$3,waiting_question='Which city?' WHERE id=$1",
          [id, reason === 'credentials' ? 'waiting_credentials' : 'waiting_user', reason],
        );
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Which city?',$2)",
          [randomUUID(), id],
        );
        return id;
      };
      const clearWaits = () =>
        db.pool.query(
          "UPDATE tasks SET status='cancelled' WHERE status IN ('waiting_user','waiting_credentials')",
        );
      await t.test(
        'a short reply retains the original task identity and is idempotent',
        async () => {
          const id = await waitingTask('Find a suitable restaurant');
          const first = await tasks.submitUserMessage('Lisbon', [], { sourceId: 'answer-fixture' });
          const duplicate = await tasks.submitUserMessage('Lisbon', [], {
            sourceId: 'answer-fixture',
          });
          assert.deepEqual(first, { taskId: id, continued: true });
          assert.deepEqual(duplicate, first);
          const current = (
            await db.pool.query('SELECT revision,waiting_reason FROM tasks WHERE id=$1', [id])
          ).rows[0];
          assert.equal(current.revision, 1);
          assert.equal(current.waiting_reason, null);
          assert.equal(
            (
              await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND text='Lisbon'", [
                id,
              ])
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'an offered sign-in choice continues the waiting task without semantic routing',
        async () => {
          const id = await waitingTask('Sign in to the fixture website');
          await db.pool.query('UPDATE tasks SET waiting_question=$2 WHERE id=$1', [
            id,
            'Which sign-in method would you like to use: email, Google or Apple?',
          ]);
          let routes = 0;
          const service = tasks.createUserMessageService({
            routeConversation: async () => {
              routes++;
              throw new Error('An explicit offered method needs no semantic routing.');
            },
          });
          const first = await service.submit('Use Google, please.');
          assert.deepEqual(first, { taskId: id, continued: true });
          assert.equal(routes, 0);
          assert.deepEqual(
            (await db.pool.query('SELECT revision,waiting_reason FROM tasks WHERE id=$1', [id]))
              .rows[0],
            { revision: 1, waiting_reason: null },
          );
          await clearWaits();
        },
      );
      await t.test(
        'method-like commands cannot borrow unrelated, unoffered or other-channel questions',
        async () => {
          const city = await waitingTask('Choose a city');
          assert.equal((await tasks.submitUserMessage('Use Google')).continued, false);
          assert.equal(
            (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [city])).rows[0].status,
            'waiting_user',
          );
          await clearWaits();
          const id = await waitingTask('Choose a sign-in method');
          await db.pool.query('UPDATE tasks SET waiting_question=$2 WHERE id=$1', [
            id,
            'Which sign-in method would you like to use: email or Apple?',
          ]);
          assert.equal((await tasks.submitUserMessage('Use Google')).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('Use Apple to research trains')).continued,
            false,
          );
          assert.equal(
            (await tasks.submitUserMessage('Use Apple', [], { channel: 'telegram' })).continued,
            false,
          );
          assert.equal(
            (await tasks.submitUserMessage('Use Apple', [], { forceNew: true })).continued,
            false,
          );
          assert.deepEqual(await tasks.submitUserMessage('Use Apple'), {
            taskId: id,
            continued: true,
          });
          await clearWaits();
        },
      );
      await t.test(
        'standalone commands with conversational introductions never resume a waiting question',
        async () => {
          const id = await waitingTask('Waiting sign-in clarification');
          const request =
            'For this development check, open https://example.com on your computer and reply with its title in bold. Keep the browser open.';
          assert.equal((await tasks.submitUserMessage(request)).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('For this check, open example.com')).continued,
            false,
          );
          assert.equal(
            (await tasks.submitUserMessage('On your computer install the tool')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('Calculate 12 + 3')).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('A quick calculation: 12 + 3')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('Describe this image')).continued, false);
          assert.equal(
            (await tasks.submitUserMessage('I am asking you to open example.com')).continued,
            false,
          );
          assert.equal((await tasks.submitUserMessage('I live in Lisbon')).taskId, id);
          await clearWaits();
        },
      );
      await t.test(
        'multiple internal questions follow the latest visible question without a task picker',
        async () => {
          const a = await waitingTask('Plan lunch');
          const b = await waitingTask('Plan dinner');
          assert.deepEqual(await tasks.submitUserMessage('Lisbon'), { taskId: b, continued: true });
          const fresh = await tasks.submitUserMessage('Find a train to Porto');
          assert.equal(fresh.continued, false);
          const forced = await tasks.submitUserMessage('Lisbon', [], { forceNew: true });
          assert.equal(forced.continued, false);
          const target = (
            await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [
              a,
            ])
          ).rows[0].id;
          assert.equal(
            (await tasks.submitUserMessage('Porto', [], { replyToMessageId: target })).taskId,
            a,
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT reply_to_message_id FROM messages WHERE text='Porto' AND task_id=$1",
                [a],
              )
            ).rows[0].reply_to_message_id,
            target,
          );
          await clearWaits();
        },
      );
      await t.test(
        'message replies and manual control preserve owner, channel and revision boundaries',
        async () => {
          const id = await waitingTask('Owned browser work', 'browser');
          const messageId = (
            await db.pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='assistant'", [
              id,
            ])
          ).rows[0].id;
          await assert.rejects(
            tasks.submitUserMessage('Answer', [], {
              replyToMessageId: messageId,
              channel: 'telegram',
            }),
            /unavailable/,
          );
          await assert.rejects(
            tasks.submitUserMessage('Answer', [], { replyToMessageId: randomUUID() }),
            /unavailable/,
          );
          for (const [status, reason] of [
            ['succeeded', null],
            ['failed', null],
            ['cancelled', null],
            ['waiting_user', 'question'],
            ['waiting_user', 'approval'],
            ['waiting_credentials', 'credentials'],
          ]) {
            const protectedId = await waitingTask('Protected browser work');
            await db.pool.query('UPDATE tasks SET status=$2,waiting_reason=$3 WHERE id=$1', [
              protectedId,
              status,
              reason,
            ]);
            await assert.rejects(
              tasks.pauseOwnedTaskForControl(protectedId),
              /not waiting for browser control/,
            );
            const protectedRow = (
              await db.pool.query(
                'SELECT status,waiting_reason,waiting_question,revision FROM tasks WHERE id=$1',
                [protectedId],
              )
            ).rows[0];
            assert.deepEqual(protectedRow, {
              status,
              waiting_reason: reason,
              waiting_question: 'Which city?',
              revision: 0,
            });
          }
          const first = await tasks.pauseOwnedTaskForControl(id);
          assert.deepEqual(await tasks.pauseOwnedTaskForControl(id), first);
          assert.equal(first.revision, 1);
          await assert.rejects(
            tasks.submitUserMessage('Continue', [], { replyToMessageId: messageId }),
            /browser control/,
          );
          await assert.rejects(tasks.resumeOwnedTaskFromControl(id, 0), /no longer active/);
          await tasks.resumeOwnedTaskFromControl(id, first.revision);
          await assert.rejects(
            tasks.resumeOwnedTaskFromControl(id, first.revision),
            /no longer active/,
          );
          assert.deepEqual(
            (
              await db.pool.query('SELECT revision,status,waiting_reason FROM tasks WHERE id=$1', [
                id,
              ])
            ).rows[0],
            { revision: 2, status: 'queued', waiting_reason: null },
          );
          const foreign = await waitingTask('Foreign browser');
          await db.pool.query("UPDATE tasks SET owner_id='foreign-owner' WHERE id=$1", [foreign]);
          await assert.rejects(tasks.pauseOwnedTaskForControl(foreign), /not found/);
          await clearWaits();
        },
      );
      await t.test(
        'credential, approval, interrupted and other-channel tasks cannot absorb a chat answer',
        async () => {
          await waitingTask('Sign in', 'credentials');
          const approval = await waitingTask('Send a reviewed email', 'approval');
          await waitingTask('Check interrupted action', 'recovery');
          const telegram = await waitingTask('Telegram lunch', 'question', 'telegram');
          await waitingTask('Foreign owner lunch');
          await db.pool.query(
            "UPDATE tasks SET owner_id='someone-else' WHERE title='Foreign owner lunch'",
          );
          assert.equal((await tasks.submitUserMessage('Lisbon')).continued, false);
          await assert.rejects(
            tasks.submitUserMessage('yes', [], { taskId: approval }),
            /Reply to the pending action question/,
          );
          await assert.rejects(
            tasks.submitUserMessage('Lisbon', [], { taskId: telegram }),
            /not found/,
          );
          assert.equal(
            (await tasks.submitUserMessage('Lisbon', [], { channel: 'telegram' })).taskId,
            telegram,
          );
          await clearWaits();
        },
      );
      await t.test(
        'legacy questions are recovered only from an observed ask_user tool boundary',
        async () => {
          const id = await waitingTask('Legacy restaurant question', 'recovery');
          await db.pool.query('UPDATE tasks SET waiting_reason=NULL WHERE id=$1', [id]);
          await db.pool.query(
            "INSERT INTO task_events(id,task_id,type,summary) VALUES($1,$2,'tool_start','ask user')",
            [randomUUID(), id],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Which city?',$2)",
            [randomUUID(), id],
          );
          await tasks.initializeTaskSchema();
          assert.equal((await tasks.submitUserMessage('Lisbon')).taskId, id);
          await clearWaits();
        },
      );
      await t.test(
        'restarting onboarding supersedes only prior onboarding work and keeps personal context',
        async () => {
          const unrelated = await waitingTask('Unrelated ongoing question');
          await db.pool.query(
            "INSERT INTO memory_facts(id,owner_id,text) VALUES($1,'local-development','Preserved fixture fact')",
            [randomUUID()],
          );
          const first = await tasks.restartOnboarding();
          await db.pool.query(
            "UPDATE tasks SET status='waiting_user',waiting_reason='question',waiting_question='What should I call you?' WHERE id=$1",
            [first.taskId],
          );
          const second = await tasks.restartOnboarding();
          assert.notEqual(first.taskId, second.taskId);
          const old = (
            await db.pool.query('SELECT status,revision FROM tasks WHERE id=$1', [first.taskId])
          ).rows[0];
          assert.deepEqual(old, { status: 'cancelled', revision: 1 });
          assert.equal(
            (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [unrelated])).rows[0]
              .status,
            'waiting_user',
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM tasks WHERE source_id LIKE 'onboarding:%' AND status <> 'cancelled'",
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT id FROM messages WHERE task_id=$1', [first.taskId]))
              .rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query("SELECT id FROM memory_facts WHERE text='Preserved fixture fact'"))
              .rowCount,
            1,
          );
          await clearWaits();
        },
      );
      await t.test('legacy blocked work returns a structured review over HTTP', async () => {
        const { createApp } = await import('../src/server/app.ts');
        const config = await import('../src/server/config.ts');
        const { conversationRevision } = await import('../src/server/conversations.ts');
        const app = await createApp({
          configuration: () => ({ ...config.configuration(), llmReady: true }),
        });
        const headers = {
          host: `localhost:${config.port}`,
          origin: `http://localhost:${config.port}`,
        };
        const blockedTask = async (
          status: string,
          reason: string | null,
          external: boolean | null,
        ) => {
          const outcomeId = randomUUID();
          await db.pool.query(
            "INSERT INTO outcomes(id,owner_id,channel,conversation_revision,title,objective) VALUES($1,'local-development','web',$2,'Send the synthetic invoice','Send the invoice.')",
            [outcomeId, await conversationRevision(db.pool, 'local-development')],
          );
          const id = await tasks.submitTask('Send the synthetic invoice', [], undefined, false, {
            outcomeId,
          });
          await db.pool.query(
            'UPDATE tasks SET status=$2,waiting_reason=$3,external_action=$4 WHERE id=$1',
            [id, status, reason, external],
          );
          const messageId = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','I couldn’t finish that.',$2)",
            [messageId, id],
          );
          return { id, outcomeId, messageId };
        };
        try {
          const failed = await blockedTask('failed', null, null);
          const blocked = await app.inject({
            method: 'POST',
            url: '/api/messages',
            headers,
            payload: { text: 'Try again', replyToMessageId: failed.messageId },
          });
          assert.equal(blocked.statusCode, 409);
          assert.deepEqual(blocked.json(), {
            error: 'I can’t safely repeat the earlier action because its outcome is unknown.',
            code: 'task_review_required',
            taskId: failed.id,
            summary: 'Send the synthetic invoice',
          });
        } finally {
          await app.close();
        }
      });
      await t.test(
        'an immediate answer waits for the old segment to exit and keeps context timestamps and reactions',
        async () => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let held: RuntimeContext | undefined;
          let resumed: RuntimeContext | undefined;
          const oldPrompt = 'Ask the race fixture question';
          const newPrompt = 'Porto';
          await db.pool.query(
            "INSERT INTO preferences(owner_id,time_zone) VALUES('local-development','Europe/Lisbon') ON CONFLICT(owner_id) DO UPDATE SET time_zone='Europe/Lisbon'",
          );
          await db.pool.query("UPDATE tasks SET status='cancelled' WHERE status='queued'");
          await tasks.boss.deleteAllJobs('assistant-task');
          await tasks.startTaskWorkers({
            runTask: async (context) => {
              if (context.prompt === oldPrompt) {
                held = context;
                await context.waitForUser!('Which city for the race fixture?');
                await gate;
                return {
                  status: 'waiting_user',
                  waitingFor: 'question',
                  question: 'Which city for the race fixture?',
                };
              }
              if (context.prompt === newPrompt) resumed = context;
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
          try {
            const id = await tasks.submitTask(oldPrompt);
            await waitFor(async () =>
              Boolean(
                (
                  await db.pool.query(
                    "SELECT id FROM tasks WHERE id=$1 AND waiting_reason='question'",
                    [id],
                  )
                ).rowCount,
              ),
            );
            await db.pool.query(
              "UPDATE messages SET reaction='like' WHERE task_id=$1 AND role='assistant'",
              [id],
            );
            const continued = await tasks.submitUserMessage(newPrompt);
            assert.equal(continued.taskId, id);
            await delay(1100);
            assert.equal(resumed, undefined);
            await assert.rejects(held!.reply('Stale segment must not publish'), /no longer active/);
            release();
            await waitFor(
              async () =>
                (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0]
                  .status === 'succeeded',
            );
            assert.equal(resumed!.channel, 'web');
            assert.equal(resumed!.timeZone, 'Europe/Lisbon');
            assert.equal(
              resumed!.history.some(
                (message) => message.reaction === 'like' && Boolean(message.createdAt),
              ),
              true,
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE text='Stale segment must not publish'",
                )
              ).rowCount,
              0,
            );
          } finally {
            release();
          }
        },
      );
    } finally {
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map((row) => row.id as string);
      const { dataRoot } = await import('../src/server/config.ts');
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
