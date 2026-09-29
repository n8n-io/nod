import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type {
  ConversationRouteDecision,
  ConversationRoutingContext,
} from '../src/ports/conversation.ts';

test(
  'failed work remains fenced while independent requests receive fresh task identities',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_routing_recovery_${suffix}`;
    const bossSchema = `test_routing_recovery_jobs_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    let observed: ConversationRoutingContext | undefined;
    let routes = 0;
    let decide: (context: ConversationRoutingContext) => ConversationRouteDecision = () => ({
      kind: 'conversation',
    });
    const service = tasks.createUserMessageService({
      routeConversation: async (context) => {
        observed = context;
        routes++;
        return decide(context);
      },
    });
    const row = async (id: string) =>
      (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
    const create = async (
      status: string,
      reason: string | null = null,
      outcomeId = randomUUID(),
      externalAction = true,
    ) => {
      await db.pool.query(
        `INSERT INTO outcomes(id,owner_id,channel,conversation_revision,title,objective)
         VALUES($1,'local-development','web',0,'Synthetic weather lookup','Read the current weather.')
         ON CONFLICT(id) DO NOTHING`,
        [outcomeId],
      );
      const taskId = await tasks.submitTask(
        'Read the earlier synthetic weather',
        [],
        undefined,
        false,
        {
          outcomeId,
        },
      );
      await db.pool.query(
        "UPDATE tasks SET status=$2,waiting_reason=$3,external_action=$4,waiting_question='Which city?',updated_at=clock_timestamp() WHERE id=$1",
        [taskId, status, reason, externalAction],
      );
      await db.pool.query('UPDATE outcomes SET updated_at=clock_timestamp() WHERE id=$1', [
        outcomeId,
      ]);
      const messageId = randomUUID();
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'local-development','assistant','Synthetic prior response',$2)",
        [messageId, taskId],
      );
      return { taskId, outcomeId, messageId };
    };
    const snapshot = async () => ({
      tasks: (await db.pool.query('SELECT * FROM tasks ORDER BY id')).rows,
      messages: (await db.pool.query('SELECT * FROM messages ORDER BY id')).rows,
      inputs: (await db.pool.query('SELECT * FROM pending_task_inputs ORDER BY id')).rows,
      continuations: (await db.pool.query('SELECT * FROM task_continuations ORDER BY source_id'))
        .rows,
      outcomes: (await db.pool.query('SELECT * FROM outcomes ORDER BY id')).rows,
      jobs: (
        await db.pool.query(
          `SELECT id,data,state FROM ${bossSchema}.job WHERE name='assistant-task' ORDER BY id`,
        )
      ).rows,
    });
    const blocked = {
      statusCode: 409,
      code: 'task_review_required',
      message: 'I can’t safely repeat the earlier action because its outcome is unknown.',
    };
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await t.test(
        'blocked context shares the eight-outcome bound and never becomes eligible',
        async () => {
          for (let index = 0; index < 9; index++)
            await create(index % 2 ? 'waiting_user' : 'failed', index % 2 ? 'recovery' : null);
          const queued = await create('queued');
          const succeeded = await create('succeeded');
          const prepared = await service.prepare('Check current synthetic weather');
          assert.ok(observed);
          assert.equal(observed.candidates.length, 2);
          assert.equal(observed.blockedCandidates?.length, 6);
          assert.deepEqual(
            new Set(prepared.candidateIds),
            new Set([queued.outcomeId, succeeded.outcomeId]),
          );
          assert.deepEqual(
            new Set(prepared.blockedOutcomeIds),
            new Set(observed.blockedCandidates!.map((candidate) => candidate.outcomeId)),
          );
          assert.ok(
            observed.blockedCandidates!.every(
              (candidate) =>
                candidate.status === 'failed' ||
                (candidate.status === 'waiting_user' && candidate.waitingReason === 'recovery'),
            ),
          );
          assert.ok(prepared.blockedOutcomeIds.every((id) => !prepared.candidateIds.includes(id)));
          assert.deepEqual(
            [...observed.candidates, ...observed.blockedCandidates!]
              .map((candidate) => candidate.recency)
              .sort((a, b) => a! - b!),
            [1, 2, 3, 4, 5, 6, 7, 8],
          );
        },
      );
      await t.test(
        'a fresh weather request creates new work and leaves the failed task unchanged',
        async () => {
          const old = await create('failed');
          const before = await row(old.taskId);
          decide = (context) => {
            assert.ok(
              context.blockedCandidates?.some((candidate) => candidate.taskId === old.taskId),
            );
            assert.equal(
              context.candidates.some((candidate) => candidate.taskId === old.taskId),
              false,
            );
            return {
              kind: 'new_outcome',
              title: 'Current synthetic weather',
              objective: 'Read current weather.',
            };
          };
          const clientMessageId = randomUUID();
          const result = await service.submit(
            'Check the current synthetic weather in Lisbon.',
            [],
            { clientMessageId },
          );
          assert.equal(result.continued, false);
          assert.notEqual(result.taskId, old.taskId);
          assert.notEqual((await row(result.taskId)).outcome_id, old.outcomeId);
          assert.deepEqual(await row(old.taskId), before);
          assert.equal(
            (await db.pool.query('SELECT task_id FROM messages WHERE id=$1', [clientMessageId]))
              .rows[0].task_id,
            result.taskId,
          );
          assert.equal(
            (
              await db.pool.query('SELECT id FROM pending_task_inputs WHERE task_id=$1', [
                old.taskId,
              ])
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'semantic retries and explicit targets reject before any input, revision or job changes',
        async () => {
          for (const [status, reason] of [
            ['failed', null],
            ['waiting_user', 'recovery'],
          ] as const) {
            const old = await create(status, reason);
            decide = () => ({ kind: 'continue', outcomeId: old.outcomeId });
            const prepared = await service.prepare('Try that earlier action again');
            assert.deepEqual(prepared.decision, { kind: 'continue', outcomeId: old.outcomeId });
            assert.ok(prepared.blockedOutcomeIds.includes(old.outcomeId));
            const before = await snapshot();
            await assert.rejects(
              service.submit('Try that earlier action again', [], {
                preparedRoute: prepared,
                clientMessageId: randomUUID(),
                sourceId: randomUUID(),
              }),
              { ...blocked, taskId: old.taskId, summary: 'Synthetic weather lookup' },
            );
            await assert.rejects(
              service.submit('Continue', [], {
                taskId: old.taskId,
                clientMessageId: randomUUID(),
                sourceId: randomUUID(),
              }),
              blocked,
            );
            await assert.rejects(
              service.submit('Continue', [], {
                replyToMessageId: old.messageId,
                clientMessageId: randomUUID(),
                sourceId: randomUUID(),
              }),
              blocked,
            );
            assert.deepEqual(await snapshot(), before);
          }
        },
      );
      await t.test('a queued task that fails after preflight cannot be reactivated', async () => {
        const old = await create('queued');
        decide = () => ({ kind: 'continue', outcomeId: old.outcomeId });
        const prepared = await service.prepare('Add the latest detail to that lookup');
        assert.ok(prepared.candidateIds.includes(old.outcomeId));
        await db.pool.query(
          "UPDATE tasks SET status='failed',error='Synthetic unknown action' WHERE id=$1",
          [old.taskId],
        );
        const before = await snapshot();
        await assert.rejects(
          service.submit('Add the latest detail to that lookup', [], { preparedRoute: prepared }),
          blocked,
        );
        assert.deepEqual(await snapshot(), before);
      });
      await t.test(
        'explicit older targets cannot bypass the latest failed or recovery task in their outcome',
        async () => {
          for (const [status, reason] of [
            ['failed', null],
            ['waiting_user', 'recovery'],
          ] as const) {
            const older = await create('succeeded');
            await db.pool.query("UPDATE tasks SET updated_at='2000-01-01' WHERE id=$1", [
              older.taskId,
            ]);
            await create(status, reason, older.outcomeId);
            const before = await snapshot();
            for (const target of [{ taskId: older.taskId }, { replyToMessageId: older.messageId }])
              await assert.rejects(
                service.submit('Continue the earlier action', [], {
                  ...target,
                  clientMessageId: randomUUID(),
                  sourceId: randomUUID(),
                }),
                blocked,
              );
            assert.deepEqual(await snapshot(), before);
          }
        },
      );
      await t.test(
        'router failure cannot turn an uncertain continuation into new executable work',
        async () => {
          await create('failed');
          for (const mode of ['error', 'timeout', 'invalid', 'unknown-id']) {
            let signal: AbortSignal | undefined;
            const unavailable = tasks.createUserMessageService({
              routingTimeoutMs: 15,
              routeConversation: async (context) => {
                signal = context.signal;
                assert.ok(context.blockedCandidates?.length);
                if (mode === 'error') throw new Error('PRIVATE-FIXTURE routing failure');
                if (mode === 'timeout') return new Promise(() => {});
                if (mode === 'invalid') return { kind: 'new_outcome', title: '', objective: '' };
                return { kind: 'continue', outcomeId: randomUUID() };
              },
            });
            const before = await snapshot();
            await assert.rejects(
              unavailable.submit('Continue the earlier synthetic action', [], {
                clientMessageId: randomUUID(),
                sourceId: randomUUID(),
              }),
              {
                statusCode: 503,
                message: 'I couldn’t check the earlier request. Please try again.',
              },
            );
            assert.equal(signal?.aborted, true);
            assert.deepEqual(await snapshot(), before);
          }
        },
      );
      await t.test(
        'the latest failed or cancelled task never falls back to an older success',
        async () => {
          for (const status of ['failed', 'cancelled']) {
            const older = await create('succeeded');
            await db.pool.query("UPDATE tasks SET updated_at='2000-01-01' WHERE id=$1", [
              older.taskId,
            ]);
            const latest = await create('queued', null, older.outcomeId);
            decide = () => ({ kind: 'continue', outcomeId: older.outcomeId });
            const prepared = await service.prepare('Continue this same synthetic lookup');
            assert.equal(
              observed?.candidates.find((candidate) => candidate.outcomeId === older.outcomeId)
                ?.taskId,
              latest.taskId,
            );
            await db.pool.query('UPDATE tasks SET status=$2 WHERE id=$1', [latest.taskId, status]);
            const before = await snapshot();
            await assert.rejects(
              service.submit('Continue this same synthetic lookup', [], {
                preparedRoute: prepared,
              }),
              status === 'failed' ? blocked : { statusCode: 404 },
            );
            assert.deepEqual(await snapshot(), before);
            decide = () => ({ kind: 'conversation' });
            await service.prepare('Review this same synthetic lookup');
            assert.equal(
              observed?.candidates.some((candidate) => candidate.outcomeId === older.outcomeId),
              false,
            );
            if (status === 'failed')
              assert.equal(
                observed?.blockedCandidates?.find(
                  (candidate) => candidate.outcomeId === older.outcomeId,
                )?.taskId,
                latest.taskId,
              );
          }
        },
      );
      await t.test(
        'a failure without an outside action is retryable as a fresh task in the same outcome',
        async () => {
          const old = await create('failed', null, randomUUID(), false);
          decide = (context) => {
            assert.equal(
              context.candidates.find((candidate) => candidate.outcomeId === old.outcomeId)?.status,
              'failed',
            );
            assert.equal(
              context.blockedCandidates?.some((candidate) => candidate.outcomeId === old.outcomeId),
              false,
            );
            return { kind: 'continue', outcomeId: old.outcomeId };
          };
          const before = await row(old.taskId);
          const clientMessageId = randomUUID();
          const retried = await service.submit('Try again', [], { clientMessageId });
          assert.equal(retried.continued, false);
          assert.notEqual(retried.taskId, old.taskId);
          assert.equal(retried.messageId, clientMessageId);
          const fresh = await row(retried.taskId);
          assert.equal(fresh.outcome_id, old.outcomeId);
          assert.equal(fresh.status, 'queued');
          assert.equal(fresh.external_action, false);
          assert.deepEqual(await row(old.taskId), before);
          assert.equal(
            (
              await db.pool.query('SELECT id FROM pending_task_inputs WHERE task_id=$1', [
                old.taskId,
              ])
            ).rowCount,
            0,
          );
          const again = await create('failed', null, randomUUID(), false);
          for (const target of [{ taskId: again.taskId }, { replyToMessageId: again.messageId }]) {
            const result = await service.submit('Continue', [], target);
            assert.equal(result.continued, false);
            assert.notEqual(result.taskId, again.taskId);
            assert.equal((await row(result.taskId)).outcome_id, again.outcomeId);
            await db.pool.query("UPDATE tasks SET status='cancelled' WHERE id=$1", [result.taskId]);
            await db.pool.query('UPDATE tasks SET updated_at=clock_timestamp() WHERE id=$1', [
              again.taskId,
            ]);
          }
          assert.equal((await row(again.taskId)).status, 'failed');
        },
      );
      await t.test(
        'successful follow-ups and actual question answers retain task identity',
        async () => {
          const succeeded = await create('succeeded');
          decide = () => ({ kind: 'continue', outcomeId: succeeded.outcomeId });
          const followup = await service.submit('Add a summary to that completed lookup');
          assert.equal(followup.taskId, succeeded.taskId);
          assert.equal(followup.continued, true);
          assert.equal((await row(succeeded.taskId)).revision, 1);
          const waiting = await create('waiting_user', 'question');
          const before = routes;
          const answer = await service.submit('Lisbon');
          assert.equal(answer.taskId, waiting.taskId);
          assert.equal(answer.continued, true);
          assert.equal((await row(waiting.taskId)).revision, 1);
          assert.equal(routes, before);
        },
      );
    } finally {
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
