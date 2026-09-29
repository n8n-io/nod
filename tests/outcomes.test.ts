import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { RuntimeContext, RuntimeResult } from '../src/ports/agent.ts';
import type { ConversationRoutingContext } from '../src/ports/conversation.ts';
import type { InboundMessage } from '../src/ports/messaging.ts';

test(
  'outcomes link related messages while execution, secure waits, provenance and channel inboxes remain fenced',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 40_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_outcomes_${suffix}`;
    const bossSchema = `test_outcomes_boss_${suffix}`;
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
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    const routes: ConversationRoutingContext[] = [];
    const contextByPrompt = new Map<string, RuntimeContext>();
    const releases = new Map<string, (result: RuntimeResult) => void>();
    const seen: RuntimeContext[] = [];
    let selectedOutcome = '';
    let newOutcome = false;
    let hold = false;
    let foreignOutcome = '';
    const userMessages = tasks.createUserMessageService({
      async routeConversation(context) {
        routes.push(context);
        if (
          context.text === 'Hello there' ||
          context.text === 'For travel plans, I prefer short bullet lists.' ||
          context.text === 'Correction: remember travel plans as one short paragraph.'
        )
          return { kind: 'conversation' };
        if (context.text === 'Try a foreign outcome')
          return { kind: 'continue', outcomeId: foreignOutcome };
        if (newOutcome || !selectedOutcome)
          return {
            kind: 'new_outcome',
            title: 'Synthetic research outcome',
            objective: 'Complete the synthetic research and summary.',
          };
        return { kind: 'continue', outcomeId: selectedOutcome };
      },
    });
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let index = 0; index < 400; index++) {
        if (await check()) return;
        await delay(20);
      }
      throw new Error('Fixture condition did not complete.');
    };
    const row = async (id: string) =>
      (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
    const message = async (text: string) =>
      (
        await db.pool.query(
          "SELECT * FROM messages WHERE role='user' AND text=$1 ORDER BY created_at DESC LIMIT 1",
          [text],
        )
      ).rows[0];
    let firstId = '';
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const app = Fastify();
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await t.test(
        'small talk has no outcome, and concrete work creates one without backfilling it',
        async () => {
          const greeting = await userMessages.submit('Hello there');
          assert.equal((await row(greeting.taskId)).outcome_id, null);
          const first = await userMessages.submit('Build the synthetic research report');
          firstId = first.taskId;
          selectedOutcome = (await row(firstId)).outcome_id;
          assert.ok(selectedOutcome);
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM outcomes')).rows[0].count,
            1,
          );
          assert.equal((await row(greeting.taskId)).outcome_id, null);
        },
      );
      await t.test(
        'concurrent related input deduplicates into the existing queued execution',
        async () => {
          const preparedRoute = await userMessages.prepare('I prefer concise replies.', [], {
            sourceId: 'queued-preference',
          });
          const options = { sourceId: 'queued-preference', preparedRoute };
          const [a, b] = await Promise.all([
            userMessages.submit('I prefer concise replies.', [], options),
            userMessages.submit('I prefer concise replies.', [], options),
          ]);
          assert.deepEqual(a, { taskId: firstId, continued: true });
          assert.deepEqual(b, a);
          await userMessages.submit('Include a short summary in that research report');
          assert.equal(
            (
              await db.pool.query(
                "SELECT * FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
                [firstId],
              )
            ).rowCount,
            2,
          );
          assert.equal(
            (await db.pool.query('SELECT * FROM tasks WHERE outcome_id=$1', [selectedOutcome]))
              .rowCount,
            1,
          );
          assert.equal(
            (await row(firstId)).source_message_id,
            (await message('Build the synthetic research report')).id,
          );
        },
      );
      await t.test(
        'a later route sees accepted pending follow-ups before the original execution starts',
        async () => {
          const prepared = await userMessages.prepare(
            'After that same research summary, also attach its supporting table',
          );
          assert.deepEqual(prepared.decision, { kind: 'continue', outcomeId: selectedOutcome });
          const candidate = routes.at(-1)!.candidates[0];
          assert.equal(candidate.outcomeId, selectedOutcome);
          assert.equal(candidate.taskId, firstId);
          assert.equal(candidate.status, 'queued');
          assert.deepEqual(
            candidate.recentMessages
              .filter((item) => item.role === 'user')
              .map((item) => item.text),
            [
              'Build the synthetic research report',
              'I prefer concise replies.',
              'Include a short summary in that research report',
            ],
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
                [firstId],
              )
            ).rowCount,
            2,
          );
        },
      );
      await t.test(
        'ordinary preference context remains available without duplicating outcome transcripts',
        async () => {
          const preference = await userMessages.submit(
            'For travel plans, I prefer short bullet lists.',
          );
          assert.equal((await row(preference.taskId)).outcome_id, null);
          const correction = await userMessages.prepare(
            'Correction: remember travel plans as one short paragraph.',
          );
          assert.deepEqual(correction.decision, { kind: 'conversation' });
          const context = routes.at(-1)!;
          assert.ok(
            context.recentConversation?.some(
              (item) =>
                item.text === 'For travel plans, I prefer short bullet lists.' &&
                item.outcomeId === null,
            ),
          );
          const candidateTexts = new Set(
            context.candidates.flatMap((candidate) =>
              candidate.recentMessages.map((item) => item.text),
            ),
          );
          assert.equal(
            context.recentConversation?.some((item) => candidateTexts.has(item.text)),
            false,
          );
          assert.ok(
            context.recentConversation!.every(
              (item) => Object.keys(item).sort().join(',') === 'outcomeId,role,text',
            ),
          );
        },
      );
      await tasks.startTaskWorkers({
        recoveryDelaysSeconds: [0, 0],
        async runTask(context) {
          seen.push(context);
          contextByPrompt.set(context.prompt, context);
          if (context.prompt === 'Build the synthetic research report' || hold)
            return new Promise<RuntimeResult>((resolve) => releases.set(context.taskId, resolve));
          if (context.prompt === 'I prefer concise replies.')
            await context.manage('memory_remember', { quote: context.prompt });
          if (context.prompt === 'Press the synthetic send button') {
            await context.startExternalAction!();
            return { status: 'waiting_user', waitingFor: 'question', question: 'Which inbox?' };
          }
          if (context.prompt === 'The fixture inbox') throw new Error('Synthetic model failure');
          return { status: 'succeeded' };
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused fixture.');
          },
        },
        requestCredential: async () => ({ url: '/vault/fixture' }),
        integration: async () => {
          throw new Error('Unused fixture.');
        },
        manage: (_taskId, action, args, provenance) => personal.manage(action, args, provenance),
      });
      await t.test(
        'pending inputs wait through secure resume and retain their own source message IDs',
        async () => {
          await waitFor(() => contextByPrompt.has('Build the synthetic research report'));
          const original = contextByPrompt.get('Build the synthetic research report')!;
          assert.equal(original.currentMessageId, (await message(original.prompt)).id);
          assert.equal(
            original.history.some((item) => item.text === 'I prefer concise replies.'),
            false,
          );
          releases.get(firstId)!({ status: 'waiting_credentials', waitingFor: 'credentials' });
          await waitFor(async () => (await row(firstId)).status === 'waiting_credentials');
          const revision = (await row(firstId)).revision;
          await userMessages.submit('Use the same report format for the final research');
          assert.equal((await row(firstId)).revision, revision);
          assert.equal((await row(firstId)).status, 'waiting_credentials');
          assert.equal(contextByPrompt.has('I prefer concise replies.'), false);
          await tasks.resumeTask(firstId, revision);
          await waitFor(() =>
            contextByPrompt.has('Use the same report format for the final research'),
          );
          await waitFor(async () => (await row(firstId)).status === 'succeeded');
          const resumed = seen.find((context) =>
            context.prompt.startsWith('The secure credential step has completed.'),
          )!;
          assert.ok(resumed);
          assert.equal(resumed.currentMessageId, undefined);
          assert.equal(
            resumed.history.some((item) => item.text === 'I prefer concise replies.'),
            false,
          );
          const followups = seen
            .filter((context) => context.taskId === firstId)
            .map((context) => context.prompt);
          assert.deepEqual(followups.slice(2), [
            'I prefer concise replies.',
            'Include a short summary in that research report',
            'Use the same report format for the final research',
          ]);
          const preference = contextByPrompt.get('I prefer concise replies.')!;
          assert.equal(preference.currentMessageId, (await message(preference.prompt)).id);
          assert.equal(
            preference.history.some(
              (item) => item.text === 'Include a short summary in that research report',
            ),
            false,
          );
          assert.equal(
            (
              await db.pool.query('SELECT source_message_id FROM memory_facts WHERE text=$1', [
                preference.prompt,
              ])
            ).rows[0].source_message_id,
            preference.currentMessageId,
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT * FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
                [firstId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'idle follow-ups reuse the session and explicit replies bypass the model router',
        async () => {
          const revision = (await row(firstId)).revision;
          const continued = await userMessages.submit(
            'Expand the conclusion of this same research report',
          );
          assert.equal(continued.taskId, firstId);
          await waitFor(async () => (await row(firstId)).status === 'succeeded');
          assert.equal((await row(firstId)).revision, revision + 1);
          const target = await message('Build the synthetic research report');
          const calls = routes.length;
          await userMessages.submit('One more detail about the report', [], {
            replyToMessageId: target.id,
          });
          assert.equal(routes.length, calls);
          await waitFor(async () => (await row(firstId)).status === 'succeeded');
        },
      );
      await t.test(
        'approval and manual-control waits keep related messages queued without changing revision',
        async () => {
          for (const reason of ['approval', 'manual_control']) {
            await db.pool.query(
              "UPDATE tasks SET status='waiting_user',waiting_reason=$2 WHERE id=$1",
              [firstId, reason],
            );
            const revision = (await row(firstId)).revision;
            await userMessages.submit(
              `Keep the related report instruction pending during ${reason}`,
            );
            assert.equal((await row(firstId)).revision, revision);
            assert.equal((await row(firstId)).waiting_reason, reason);
          }
          await db.pool.query(
            "UPDATE tasks SET status='succeeded',waiting_reason=NULL WHERE id=$1",
            [firstId],
          );
          await userMessages.submit('Now continue the queued report work');
          await waitFor(() => contextByPrompt.has('Now continue the queued report work'));
          await waitFor(async () => (await row(firstId)).status === 'succeeded');
        },
      );
      await t.test(
        'foreign and other-channel outcomes are not candidates or accepted targets',
        async () => {
          foreignOutcome = randomUUID();
          await db.pool.query(
            "INSERT INTO outcomes(id,owner_id,channel,conversation_revision,title,objective) VALUES($1,'foreign-owner','web',0,'PRIVATE FOREIGN OUTCOME','PRIVATE FOREIGN OBJECTIVE')",
            [foreignOutcome],
          );
          const plan = await userMessages.prepare('Try a foreign outcome');
          assert.equal(plan.decision.kind, 'conversation');
          assert.equal(JSON.stringify(routes.at(-1)).includes('PRIVATE FOREIGN'), false);
          const forged = {
            ...plan,
            candidateIds: [foreignOutcome],
            decision: { kind: 'continue' as const, outcomeId: foreignOutcome },
          };
          await assert.rejects(
            userMessages.submit('Try a foreign outcome', [], { preparedRoute: forged }),
            /no longer available/,
          );
          const other = await userMessages.prepare('Continue the report', [], {
            channel: 'telegram:verified',
          });
          assert.equal(other.candidateIds.includes(selectedOutcome), false);
          assert.deepEqual(routes.at(-1)?.recentConversation, []);
          await assert.rejects(
            userMessages.submit('Different text', [], { preparedRoute: plan }),
            /conversation changed/i,
          );
        },
      );
      await t.test(
        'a stalled router times out, aborts and never creates a guessed outcome',
        async () => {
          let signal: AbortSignal | undefined;
          const slow = tasks.createUserMessageService({
            routingTimeoutMs: 15,
            routeConversation: async (context) => {
              signal = context.signal;
              return new Promise(() => {});
            },
          });
          const plan = await slow.prepare('A synthetic timeout request');
          assert.equal(plan.decision.kind, 'conversation');
          assert.equal(signal?.aborted, true);
        },
      );
      await t.test(
        'channel preflight holds no inbox row lock and duplicate delivery queues one continuation',
        async () => {
          const incoming: InboundMessage[] = [];
          let lockChecks = 0;
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
              receive: async () => ({ status: 200, body: 'ok', messages: incoming.splice(0) }),
              post: async () => ({ id: randomUUID() }),
              close: async () => {},
            },
            prepare: async (text, sourceId, channel) => {
              const client = await db.pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(
                  'SELECT source_id FROM channel_inbox WHERE source_id=$1 FOR UPDATE NOWAIT',
                  [sourceId],
                );
                lockChecks++;
                await client.query('ROLLBACK');
              } finally {
                client.release();
              }
              return userMessages.prepare(text, [], { sourceId, channel });
            },
            submit: async (text, sourceId, client, channel, preparedRoute) =>
              (await userMessages.submit(text, [], { sourceId, client, channel, preparedRoute }))
                .taskId,
            subscribe: () => () => {},
          });
          channels.registerRoutes(app);
          const inbound = (id: string, text: string): InboundMessage => ({
            channelId: 'telegram',
            accountId: 'fixture-bot',
            senderId: 'fixture-owner',
            messageId: id,
            threadId: 'fixture-dm',
            text,
            sentAt: new Date(),
          });
          newOutcome = true;
          hold = true;
          incoming.push(inbound('one', 'Research the Telegram fixture'));
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          const channelTask = (
            await db.pool.query(
              "SELECT task_id FROM channel_inbox WHERE source_id='channel:telegram:fixture-bot:one'",
            )
          ).rows[0].task_id;
          selectedOutcome = (await row(channelTask)).outcome_id;
          newOutcome = false;
          incoming.push(
            inbound('two', 'Add the Telegram report summary'),
            inbound('two', 'Add the Telegram report summary'),
          );
          await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
          await channels.drain();
          assert.equal(
            (
              await db.pool.query(
                "SELECT task_id FROM channel_inbox WHERE source_id='channel:telegram:fixture-bot:two'",
              )
            ).rows[0].task_id,
            channelTask,
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT * FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
                [channelTask],
              )
            ).rowCount,
            1,
          );
          assert.equal(lockChecks, 2);
          await tasks.cancelTask(channelTask);
          hold = false;
          releases.get(channelTask)?.({ status: 'succeeded' });
        },
      );
      await t.test(
        'cancel and reset discard pending work and stale prepared decisions cannot resurrect it',
        async () => {
          newOutcome = true;
          hold = true;
          const current = await userMessages.submit('Build a cancellable fixture report');
          selectedOutcome = (await row(current.taskId)).outcome_id;
          newOutcome = false;
          await waitFor(() => releases.has(current.taskId));
          await userMessages.submit('Add a detail to the cancellable fixture');
          await tasks.cancelTask(current.taskId);
          hold = false;
          releases.get(current.taskId)!({ status: 'succeeded' });
          await delay(50);
          assert.equal((await row(current.taskId)).status, 'cancelled');
          assert.equal(
            (
              await db.pool.query(
                "SELECT * FROM pending_task_inputs WHERE task_id=$1 AND state='pending'",
                [current.taskId],
              )
            ).rowCount,
            0,
          );
          newOutcome = true;
          const next = await userMessages.submit('Build a reset fixture report');
          selectedOutcome = (await row(next.taskId)).outcome_id;
          newOutcome = false;
          const stale = await userMessages.prepare('Continue after a reset');
          await tasks.resetConversation();
          await assert.rejects(
            userMessages.submit('Continue after a reset', [], { preparedRoute: stale }),
            /conversation changed/i,
          );
          const after = await userMessages.prepare('Continue after a reset');
          assert.equal(after.candidateIds.includes(selectedOutcome), false);
          assert.deepEqual(routes.at(-1)?.recentConversation, []);
          assert.equal(
            (await db.pool.query('SELECT * FROM outcomes WHERE id=$1', [selectedOutcome])).rowCount,
            1,
          );
        },
      );
      await t.test(
        'an outside action marks its instruction and a later user instruction starts clean',
        async () => {
          newOutcome = true;
          const sent = await userMessages.submit('Press the synthetic send button');
          newOutcome = false;
          await waitFor(async () => (await row(sent.taskId)).status === 'waiting_user');
          assert.equal((await row(sent.taskId)).external_action, true);
          selectedOutcome = (await row(sent.taskId)).outcome_id;
          const answer = await userMessages.submit('The fixture inbox');
          assert.equal(answer.taskId, sent.taskId);
          await waitFor(async () => (await row(sent.taskId)).status === 'failed');
          assert.equal((await row(sent.taskId)).external_action, false);
          const prepared = await userMessages.prepare('Try again');
          assert.ok(prepared.candidateIds.includes(selectedOutcome));
          assert.equal(prepared.blockedOutcomeIds.includes(selectedOutcome), false);
          await db.pool.query('UPDATE tasks SET external_action=NULL WHERE id=$1', [sent.taskId]);
          const legacy = await userMessages.prepare('Try again');
          assert.ok(legacy.blockedOutcomeIds.includes(selectedOutcome));
          assert.equal(routes.at(-1)?.blockedCandidates?.[0]?.outcomeId, selectedOutcome);
        },
      );
    } finally {
      for (const release of releases.values()) release({ status: 'succeeded' });
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
