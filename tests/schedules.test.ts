import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import type {
  Schedule,
  ScheduleHistory,
  ScheduleRun,
  TaskDetail,
} from '../src/shared/contracts.ts';
import { modelPricingSignature, type ModelPricing } from '../src/shared/models.ts';
import {
  captureOwnerInstructions,
  mergeOwnerInstructions,
  validateOwnerInstructions,
} from '../src/server/owner-instructions.ts';
import {
  readSchedule,
  scheduleExpression,
  scheduleLocalTime,
  scheduleRunAt,
  type ScheduleFrequency,
} from '../src/web/lib/schedules.ts';

test(
  'one-off and recurring schedules dispatch atomically with exact timing and retained owned history',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_schedules_${suffix}`;
    const bossSchema = `test_schedules_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createActivity } = await import('../src/server/activity.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const thread = await import('../src/server/thread.ts');
    const { createChannels } = await import('../src/server/channels.ts');
    const { turnOrigin } = await import('../src/server/approvals.ts');
    const ownerId = 'local-development';
    let clock = new Date('2035-10-26T12:00:00.000Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    let failAfterTask = false;
    const watched = new Map<string, string>();
    let watchPolls = 0;
    let modelPaused = false;
    const clearedBrowsers: string[] = [];
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: thread.boss,
      now: () => clock,
      watchable: async (ids) => ids.every((id) => watched.has(id)),
      watchState: async (ids) => {
        watchPolls++;
        return ids.every((id) => watched.has(id)) ? ids.map((id) => watched.get(id)).join() : null;
      },
      modelPaused: () => modelPaused,
      enqueueTurn: async (...args) => {
        assert.ok(args[1]?.client);
        const id = await thread.enqueueTurn(...args);
        if (failAfterTask) throw new Error('Synthetic failure after turn creation.');
        return id;
      },
      refresh() {},
      clearBrowser: async (id) => {
        clearedBrowsers.push(id);
      },
      validateModel: (choice) => choice,
    });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const value = error as Error & { statusCode?: number };
      reply
        .code(error instanceof z.ZodError ? 400 : (value.statusCode ?? 500))
        .send({ error: value.message });
    });
    personal.registerRoutes(app);
    const tasks = createTasks({ pool: db.pool, ownerId });
    tasks.registerRoutes(app);
    const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
      app.inject({
        method,
        url: path,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
      });
    const create = async (input: Record<string, unknown>) => {
      const response = await request('POST', '/api/schedules', {
        title: 'Fixture schedule',
        prompt: 'Return a synthetic result only.',
        timeZone: 'Europe/Lisbon',
        ...input,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Schedule>();
    };
    const jobFor = async (id: string) => {
      const result = await db.pool.query('SELECT job_id FROM schedules WHERE id=$1', [id]);
      const job = await thread.boss.getJobById<Data>('scheduled-task', result.rows[0].job_id);
      assert.ok(job);
      return { ...job, signal: new AbortController().signal };
    };
    const runs = async (id: string) => {
      const response = await request('GET', '/api/schedule-runs?limit=100');
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ScheduleHistory>().runs.filter((run) => run.scheduleId === id);
    };
    const saved = async (id: string) =>
      (await personal.listSchedules()).find((schedule) => schedule.id === id)!;
    const runNow = (schedule: Schedule, requestId = randomUUID()) =>
      request('POST', `/api/schedules/${schedule.id}/run`, {
        requestId,
        expectedRevision: schedule.revision,
      });
    const inbox: InboundMessage[] = [];
    const sent: Array<Parameters<MessagingTransport['post']>[0]> = [];
    const transport: MessagingTransport = {
      channels: [
        {
          id: 'telegram',
          status: 'configured',
          missing: [],
          accountId: 'fixture-bot',
          allowedSenderIds: ['fixture-owner'],
        },
      ],
      async poll(accept) {
        for (const message of inbox.splice(0)) await accept(message);
      },
      async receive() {
        return { status: 200, body: 'ok' };
      },
      async post(input) {
        sent.push(input);
        return { id: randomUUID() };
      },
      async close() {},
    };
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const connect = () =>
      createChannels(db.pool, {
        ownerId,
        transport,
        intervalMs: 60_000,
        subscribe: () => () => {},
        submit: async (text, sourceId, client, channel, messageId) =>
          (
            await thread.submitUserMessage(text, [], {
              sourceId,
              client,
              channel,
              clientMessageId: messageId,
            })
          ).turnId,
      });
    const receive = async (text: string, threadId = 'original-thread') => {
      const messageId = randomUUID();
      inbox.push({
        channelId: 'telegram',
        accountId: 'fixture-bot',
        senderId: 'fixture-owner',
        messageId,
        threadId,
        text,
        sentAt: new Date(),
      });
      await channels!.drain();
      const sourceId = `channel:telegram:fixture-bot:${messageId}`;
      const row = (
        await db.pool.query(
          `SELECT i.turn_id,i.message_id,u.channel,m.text FROM channel_inbox i
           JOIN turns u ON u.id=i.turn_id JOIN messages m ON m.id=i.message_id
           WHERE i.source_id=$1 AND i.state='submitted'`,
          [sourceId],
        )
      ).rows[0];
      assert.ok(row);
      assert.equal(row.text, text);
      return {
        turnId: row.turn_id as string,
        sourceMessageId: row.message_id as string,
        channel: row.channel as string,
        sourceId,
      };
    };
    const manageRouted = async (
      action: string,
      args: Record<string, unknown>,
      provenance?: { turnId: string; sourceMessageId: string | null },
    ) => {
      if (!provenance) return personal.manage(action, args);
      const turn = (
        await db.pool.query(
          "SELECT thread_id,to_jsonb(turns)->>'task_id' AS task_id FROM turns WHERE id=$1",
          [provenance.turnId],
        )
      ).rows[0];
      const captured =
        turn && provenance.sourceMessageId
          ? await captureOwnerInstructions(
              db.pool,
              ownerId,
              turn.thread_id,
              [provenance.sourceMessageId],
              turn.task_id,
              new Date(Date.now() - 86_400_000),
              provenance.turnId,
            )
          : undefined;
      const prepared = await personal.prepareScheduleChange(action, args);
      return personal.manage(action, args, {
        ...provenance,
        instructionChange: {
          ...prepared,
          evidence: captured?.evidence ?? { messages: [] },
          previousEvidence: 'evidence' in prepared ? prepared.evidence : undefined,
        },
      });
    };
    const createRouted = (
      provenance?: { turnId: string; sourceMessageId: string | null },
      timing: Record<string, unknown> = {},
    ) =>
      manageRouted(
        'schedule_create',
        {
          title: 'Synthetic reminder',
          prompt: 'Send the synthetic reminder.',
          kind: 'once',
          runAt: new Date(clock.getTime() + 60_000).toISOString(),
          timeZone: 'Europe/Lisbon',
          ...timing,
        },
        provenance,
      ) as Promise<Schedule>;
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      t.mock.method(thread.boss, 'work', async (_name: string, handler: unknown) => {
        deliver = handler as typeof deliver;
        return randomUUID();
      });
      await personal.initialize();
      await tasks.initialize();
      await db.pool.query(`ALTER TABLE schedule_runs ADD CONSTRAINT
        schedule_runs_schedule_id_schedule_revision_scheduled_for_key
        UNIQUE(schedule_id,schedule_revision,scheduled_for)`);
      await personal.initialize({ workers: false });

      await t.test('a new schedule prices recent chat requests at the selected tier', async () => {
        const { createLedger } = await import('../src/server/ledger.ts');
        const threshold = 272_000;
        const ledger = createLedger({
          pool: db.pool,
          ownerId,
          pricingThresholds: () => [threshold],
        });
        await ledger.initialize();
        const original: ModelPricing = {
          input: 2,
          output: 10,
          longCacheWrites: true,
          tiers: [{ inputTokensAbove: threshold, input: 4, output: 15 }],
        };
        let pricing = original;
        const modelId = 'synthetic-model';
        const modelled = createPersonalService({
          pool: db.pool,
          ownerId,
          scheduler: thread.boss,
          now: () => clock,
          enqueueTurn: thread.enqueueTurn,
          refresh() {},
          sessionCosts: ledger.sessionCosts,
          sessionUsage: ledger.sessionUsage,
          recentTurnUsage: ledger.recentTurnUsage,
          workPricing: () => ({ modelId, pricing }),
        });
        const turnId = await thread.enqueueTurn('Synthetic forecast sample', { source: 'event' });
        const schedule = await create({ title: 'Synthetic first schedule', cron: '0 9 * * *' });
        const sampleTurns = [turnId];
        try {
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [turnId]);
          for (const [inputTokens, cacheWriteTokens, cost] of [
            [150_000, 0, 0.3],
            [150_000, 0, 0.3],
            [280_000, 20_000, 1.28],
          ] as const)
            await db.pool.query(
              'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,$4,$5)',
              [
                randomUUID(),
                ownerId,
                turnId,
                cost,
                {
                  category: 'agent',
                  model: modelId,
                  inputTokens,
                  cacheWriteTokens,
                  cacheWrite1hTokens: cacheWriteTokens,
                  pricingSignature: modelPricingSignature(original),
                },
              ],
            );
          const old = (await modelled.getSchedule(schedule.id)).monthlyUsd!;
          assert.ok(old > 0);
          pricing = {
            input: 2.2,
            output: 11,
            longCacheWrites: true,
            tiers: [{ inputTokensAbove: threshold, input: 4.4, output: 16.5 }],
          };
          const revised = (await modelled.getSchedule(schedule.id)).monthlyUsd!;
          assert.ok(Math.abs(revised / old - 2.068 / 1.88) < 1e-9);
          pricing = { ...original, longCacheWrites: false };
          const standardWrites = (await modelled.getSchedule(schedule.id)).monthlyUsd!;
          assert.ok(Math.abs(standardWrites / old - 1.8 / 1.88) < 1e-9);
          const reviewUsage = randomUUID();
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,0,$4)',
            [
              reviewUsage,
              ownerId,
              turnId,
              { category: 'review', status: 'succeeded', pricing: 'sdk_estimate' },
            ],
          );
          assert.equal((await modelled.getSchedule(schedule.id)).monthlyUsd, null);
          await db.pool.query(
            "UPDATE model_usage SET details=details || jsonb_build_object('pricing','reported') WHERE id=$1",
            [reviewUsage],
          );
          assert.equal((await modelled.getSchedule(schedule.id)).monthlyUsd, standardWrites);

          const secondTurn = await thread.enqueueTurn('Synthetic second sample', {
            source: 'event',
          });
          sampleTurns.push(secondTurn);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [secondTurn]);
          await db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
               ($1,$3,$4,0.2,'{"category":"agent","inputTokens":100000}'),
               ($2,$3,$4,0.02,'{"category":"review","inputTokens":5000}')`,
            [randomUUID(), randomUUID(), ownerId, secondTurn],
          );
          pricing = { input: 0, output: 0 };
          const expectMonthly = async (perRun: number) => {
            const monthly = (await modelled.getSchedule(schedule.id)).monthlyUsd!;
            assert.ok(Math.abs(monthly / old - perRun / 1.88) < 1e-9);
          };
          await expectMonthly(0.01);

          await db.pool.query(
            "UPDATE model_usage SET cost_usd=0 WHERE turn_id=$1 AND details->>'category'='agent'",
            [turnId],
          );
          await expectMonthly(0.01);

          await db.pool.query(
            "UPDATE model_usage SET details=details || jsonb_build_object('estimateUsd',cost_usd),cost_usd=NULL WHERE turn_id=$1",
            [secondTurn],
          );
          await expectMonthly(0.01);
          pricing = { ...original, input: 2.2 };
          await expectMonthly((1.94 + 0.24) / 2);

          const taskTurn = await thread.enqueueTurn('Synthetic task sample', {
            source: 'task',
            background: true,
          });
          sampleTurns.push(taskTurn);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [taskTurn]);
          await db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details)
             VALUES($1,$2,$3,0.1,'{"category":"agent","inputTokens":50000}')`,
            [randomUUID(), ownerId, taskTurn],
          );
          await expectMonthly(0.11);
        } finally {
          await request('DELETE', `/api/schedules/${schedule.id}`);
          await db.pool.query('DELETE FROM model_usage WHERE turn_id=ANY($1::uuid[])', [
            sampleTurns,
          ]);
          await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [sampleTurns]);
        }
      });

      await t.test(
        'Stop ends only the selected schedule run and keeps future runs enabled',
        async () => {
          const schedule = await create({ title: 'Synthetic stoppable run', cron: '0 9 * * *' });
          const other = await create({ title: 'Synthetic separate run', cron: '0 10 * * *' });
          const otherTurn = (await runNow(other)).json().turnId as string;
          const main = await thread.enqueueTurn('Synthetic separate chat work', {
            source: 'event',
          });
          const stop = (id: string, turnId: string) =>
            request('POST', `/api/schedules/${id}/runs/${turnId}/stop`);
          const status = async (id: string) =>
            (await db.pool.query('SELECT status FROM turns WHERE id=$1', [id])).rows[0].status;
          const targets: string[] = [];
          try {
            for (const state of ['queued', 'running', 'waiting']) {
              const result = await runNow(await saved(schedule.id));
              assert.equal(result.statusCode, 200, result.body);
              const turnId = result.json().turnId as string;
              targets.push(turnId);
              await db.pool.query(
                "UPDATE turns SET status=$2,waiting_reason=CASE WHEN $2='waiting' THEN 'question' ELSE NULL END WHERE id=$1",
                [turnId, state],
              );
              const response = await stop(schedule.id, turnId);
              assert.equal(response.statusCode, 200, response.body);
              assert.equal(await status(turnId), 'cancelled');
              assert.equal((await saved(schedule.id)).enabled, true);
              assert.equal((await saved(schedule.id)).nextRun, schedule.nextRun);
              assert.equal(await status(otherTurn), 'queued');
              assert.equal(await status(main), 'queued');
              assert.equal(clearedBrowsers.filter((id) => id === turnId).length, 1);
              await assert.rejects(
                thread.withTurnLock(turnId, async () => {}),
                /no longer active/,
              );
              assert.equal((await stop(schedule.id, turnId)).statusCode, 200);
              assert.equal(clearedBrowsers.filter((id) => id === turnId).length, 1);
            }
            const resumedRoot = (await runNow(await saved(schedule.id))).json().turnId as string;
            targets.push(resumedRoot);
            await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [resumedRoot]);
            const resumed = await thread.enqueueTurn('Synthetic resumed scheduled work', {
              source: 'resume',
              background: true,
              parentTurnId: resumedRoot,
              sessionId: resumedRoot,
            });
            targets.push(resumed);
            const folded = await thread.enqueueTurn('Synthetic steering message', {
              source: 'resume',
              parentTurnId: resumed,
              sessionId: resumedRoot,
            });
            targets.push(folded);
            const messageId = randomUUID();
            await db.pool.query(
              `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text)
               SELECT $2,owner_id,thread_id,id,'user','Synthetic steering message' FROM turns WHERE id=$1`,
              [folded, messageId],
            );
            await db.pool.query(
              "UPDATE turns SET source='user',status='succeeded',message_id=$2 WHERE id=$1",
              [folded, messageId],
            );
            for (const state of ['running', 'waiting', 'failed', 'succeeded']) {
              await db.pool.query(
                "UPDATE turns SET status=$2,started_at=now(),waiting_reason=CASE WHEN $2='waiting' THEN 'question' ELSE NULL END WHERE id=$1",
                [resumed, state],
              );
              assert.equal((await saved(schedule.id)).lastRun?.status, state);
            }
            await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [resumed]);
            const pendingResume = await thread.enqueueTurn('Synthetic queued continuation', {
              source: 'resume',
              sessionId: resumedRoot,
              parentTurnId: resumed,
              background: true,
            });
            targets.push(pendingResume);
            assert.equal((await saved(schedule.id)).activeRun?.turnId, resumed);
            const stopped = await stop(schedule.id, resumed);
            assert.equal(stopped.statusCode, 200, stopped.body);
            assert.equal(await status(resumed), 'cancelled');
            assert.equal(await status(pendingResume), 'cancelled');
            assert.equal(clearedBrowsers.at(-1), resumedRoot);
            assert.equal(
              (await runs(schedule.id)).find((run) => run.turnId === resumedRoot)?.status,
              'cancelled',
            );
            assert.equal((await saved(schedule.id)).lastRun?.status, 'cancelled');
            assert.equal(await status(resumedRoot), 'succeeded');
            const later = (await runNow(await saved(schedule.id))).json().turnId as string;
            targets.push(later);
            assert.equal((await stop(schedule.id, resumed)).statusCode, 200);
            assert.equal(await status(later), 'queued');
            assert.equal((await stop(other.id, later)).statusCode, 404);
            assert.equal((await stop(schedule.id, otherTurn)).statusCode, 404);
            assert.equal((await stop(schedule.id, main)).statusCode, 404);
            assert.equal((await stop(schedule.id, randomUUID())).statusCode, 404);
            await db.pool.query('UPDATE schedule_runs SET owner_id=$2 WHERE turn_id=$1', [
              later,
              'synthetic-other-owner',
            ]);
            assert.equal((await stop(schedule.id, later)).statusCode, 404);
            assert.equal(await status(later), 'queued');
            assert.equal((await saved(schedule.id)).enabled, true);
          } finally {
            await db.pool.query("UPDATE turns SET status='cancelled' WHERE id=ANY($1::uuid[])", [
              [...targets, otherTurn, main],
            ]);
            await request('DELETE', `/api/schedules/${schedule.id}`);
            await request('DELETE', `/api/schedules/${other.id}`);
          }
        },
      );

      await t.test(
        'manual runs retain timing and start once across concurrent requests and retries',
        async () => {
          const schedule = await create({ cron: '0 9 * * *' });
          const job = await jobFor(schedule.id);
          const requestId = randomUUID();
          const responses = await Promise.all([
            runNow(schedule, requestId),
            runNow(schedule, requestId),
          ]);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(responses[0]!.json(), responses[1]!.json());
          const [run] = await runs(schedule.id);
          assert.equal((await runs(schedule.id)).length, 1);
          assert.equal(run!.scheduledFor, clock.toISOString());
          assert.deepEqual(await saved(schedule.id), {
            ...schedule,
            lastRun: run,
            activeRun: { turnId: run!.turnId, status: 'queued', questionMessageId: null },
          });
          assert.equal((await jobFor(schedule.id)).id, job.id);
          assert.equal((await runNow(schedule)).statusCode, 409);
          const before = clock;
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
          assert.notEqual((await jobFor(schedule.id)).id, job.id);
          clock = before;
          const turn = (
            await db.pool.query('SELECT source,background,prompt FROM turns WHERE id=$1', [
              run!.turnId,
            ])
          ).rows[0];
          assert.equal(turn.source, 'schedule');
          assert.equal(turn.background, true);
          assert.match(turn.prompt, /Return a synthetic result only/);
          const activity = createActivity({ pool: db.pool, ownerId });
          const runActivity = async () =>
            (await activity.current()).find((item) => item.turnId === run!.turnId);
          const queued = await runActivity();
          assert.equal(
            queued?.runId,
            run!.id,
            'A queued schedule should publish its run activity.',
          );
          assert.equal(queued?.doing, 'queued');
          assert.equal(queued?.scheduleId, schedule.id);
          assert.equal(queued?.background, true);
          await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
            run!.turnId,
          ]);
          await db.pool.query(
            "INSERT INTO turn_events(id,turn_id,type,summary,call_id) VALUES($1,$2,'tool_start','read',$3)",
            [randomUUID(), run!.turnId, randomUUID()],
          );
          const running = await runActivity();
          assert.equal(running?.doing, 'tool');
          assert.ok(running?.tool);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [run!.turnId]);
          assert.equal(await runActivity(), undefined);
          const repeated = await runNow(schedule, requestId);
          assert.deepEqual(repeated.json(), { turnId: run!.turnId, activeRun: null });
          assert.equal((await runs(schedule.id)).length, 1);
          assert.equal((await saved(schedule.id)).activeRun, null);

          failAfterTask = true;
          const failed = await runNow(schedule);
          failAfterTask = false;
          assert.equal(failed.statusCode, 500);
          assert.equal((await runs(schedule.id)).length, 1);
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*)::int AS count FROM turns WHERE source_id LIKE $1',
                [`schedule:${schedule.id}:%`],
              )
            ).rows[0].count,
            1,
          );

          const stale = schedule;
          const paused = (
            await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })
          ).json<Schedule>();
          assert.equal((await runNow(stale)).statusCode, 409);
          assert.equal((await runNow(paused)).statusCode, 200);
          assert.equal((await saved(schedule.id)).enabled, false);
          assert.equal((await saved(schedule.id)).nextRun, null);
          assert.equal((await runs(schedule.id)).length, 2);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          assert.equal((await runNow(paused)).statusCode, 404);
          assert.equal((await runNow({ ...paused, id: randomUUID() })).statusCode, 404);
          const foreign = await create({ cron: '0 10 * * *' });
          await db.pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'foreign-run',
          ]);
          assert.equal((await runNow(foreign)).statusCode, 404);
          assert.equal((await runNow({ ...paused, id: 'invalid' })).statusCode, 400);
          assert.equal(
            (
              await request('POST', `/api/schedules/${foreign.id}/run`, {
                requestId: 'invalid',
                expectedRevision: 0,
              })
            ).statusCode,
            400,
          );
        },
      );

      await t.test('manual and timed one-time runs stay separate at the same time', async () => {
        const before = clock;
        const schedule = await create({
          kind: 'once',
          runAt: new Date(clock.getTime() + 60_000).toISOString(),
        });
        const job = await jobFor(schedule.id);
        clock = new Date(schedule.runAt!);
        const manual = await runNow(schedule);
        assert.equal(manual.statusCode, 200, manual.body);
        await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
          manual.json().turnId,
        ]);
        assert.equal((await saved(schedule.id)).enabled, true);
        assert.equal((await jobFor(schedule.id)).id, job.id);
        await deliver([job]);
        assert.equal((await runs(schedule.id)).length, 2);
        const completed = await saved(schedule.id);
        assert.equal(completed.enabled, false);
        assert.equal((await runNow(completed)).statusCode, 409);
        await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
          completed.activeRun!.turnId,
        ]);
        assert.equal((await runNow(completed)).statusCode, 200);
        assert.equal((await saved(schedule.id)).enabled, false);
        await request('DELETE', `/api/schedules/${schedule.id}`);
        clock = before;
      });

      await t.test(
        'a due one-time schedule waits for a manual run and keeps its due time',
        async () => {
          const before = clock;
          const schedule = await create({
            kind: 'once',
            runAt: new Date(clock.getTime() + 60_000).toISOString(),
          });
          const manual = await runNow(schedule);
          assert.equal(manual.statusCode, 200, manual.body);
          const manualTurn = manual.json().turnId;
          const originalJob = await jobFor(schedule.id);
          clock = new Date(Date.parse(schedule.runAt!) + 11 * 60_000);
          await deliver([originalJob]);
          assert.equal((await saved(schedule.id)).enabled, true);
          assert.equal((await saved(schedule.id)).runAt, schedule.runAt);
          assert.equal((await runs(schedule.id)).length, 1);
          let deferred = await jobFor(schedule.id);
          assert.notEqual(deferred.id, originalJob.id);
          assert.equal(Date.parse(deferred.data.scheduledFor), clock.getTime() + 60_000);
          await db.pool.query("UPDATE turns SET status='waiting',started_at=now() WHERE id=$1", [
            manualTurn,
          ]);
          clock = new Date(deferred.data.scheduledFor);
          await deliver([deferred]);
          assert.equal((await saved(schedule.id)).enabled, true);
          assert.equal((await runs(schedule.id)).length, 1);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [manualTurn]);
          deferred = await jobFor(schedule.id);
          clock = new Date(deferred.data.scheduledFor);
          await deliver([deferred]);
          const [timed] = (await runs(schedule.id)).filter((run) => run.turnId !== manualTurn);
          assert.equal(timed!.scheduledFor, schedule.runAt);
          assert.equal((await saved(schedule.id)).enabled, false);
          assert.equal((await saved(schedule.id)).nextRun, null);
          assert.match(
            (await db.pool.query('SELECT prompt FROM turns WHERE id=$1', [timed!.turnId])).rows[0]
              .prompt,
            /This run was due/,
          );
          await deliver([originalJob, deferred]);
          assert.equal((await runs(schedule.id)).length, 2);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          clock = before;
        },
      );

      await t.test('completed tasks produce isolated, reviewable schedule drafts', async (t) => {
        const seed = async (
          messages: string[],
          options: { owner?: string; attachments?: boolean } = {},
        ) => {
          const owner = options.owner ?? ownerId;
          const current = await thread.activeThread(db.pool, owner);
          const taskId = randomUUID();
          await db.pool.query(
            `INSERT INTO tasks(id,owner_id,title,done_when,now_text,result,state,closed_at)
             VALUES($1,$2,'Synthetic account report','Requested report','Finished','Assistant summary','done',now())`,
            [taskId, owner],
          );
          let lastTurn = '';
          for (const [index, text] of messages.entries()) {
            lastTurn = randomUUID();
            const at = new Date(Date.UTC(2035, 9, 25, 9, index));
            await db.pool.query(
              `INSERT INTO turns(id,owner_id,thread_id,source,status,prompt,task_id,created_at)
               VALUES($1,$2,$3,'user','succeeded',$4,$5,$6)`,
              [lastTurn, owner, current.id, text, taskId, at],
            );
            await db.pool.query(
              `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,created_at,attachments)
               VALUES($1,$2,'user',$3,$4,$5,$6,$7)`,
              [
                randomUUID(),
                owner,
                text,
                current.id,
                lastTurn,
                at,
                JSON.stringify(
                  options.attachments && index === 0 ? [{ name: 'synthetic.csv' }] : [],
                ),
              ],
            );
          }
          if (lastTurn) {
            await db.pool.query('UPDATE tasks SET turn_id=$2 WHERE id=$1', [taskId, lastTurn]);
            for (const [messageOwner, role, text] of [
              [owner, 'assistant', 'Assistant-only instruction: send to a new recipient.'],
              ['draft-foreign-message-owner', 'user', 'Foreign owner instruction.'],
            ])
              await db.pool.query(
                `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
                 VALUES($1,$2,$3,$4,$5,$6)`,
                [randomUUID(), messageOwner, role, text, current.id, lastTurn],
              );
          }
          return taskId;
        };
        const draft = (id: string) => request('GET', `/api/tasks/${id}/schedule-draft`);
        const unchanged = async () => ({
          tasks: (await db.pool.query('SELECT * FROM tasks ORDER BY id')).rows,
          turns: (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows,
          schedules: (await db.pool.query('SELECT count(*)::int AS count FROM schedules')).rows,
        });
        const first = 'Read the synthetic team account and summarize its outstanding invoices.';
        const clarification =
          'Use the EUR account, include overdue items, and keep the result in Nod.';
        const base = await seed(
          [
            first,
            'Verification code sent securely.',
            '654321',
            'My password is synthetic-only.',
            clarification,
          ],
          { attachments: true },
        );
        const foreign = await seed(['Foreign task content.'], { owner: 'draft-foreign-owner' });
        const reusable = [
          'Read https://reports.example.test/invoices?currency=EUR and summarize the totals.',
          'Ignore my previous instructions about sending messages; only prepare the summary in Nod.',
          'Find https://reports.example.test/people/alice@example.test and keep the result here.',
        ];
        await seed([
          reusable[0],
          'Open https://alice:s3cr3t@example.test/invoices.',
          'Check URL:https://alice:s3cr3t@example.test/invoices.',
          'Check URL:https://alice@example.test/invoices.',
          'Check URL=(https://alice:s3cr3t@example.test/invoices).',
          'Check URL—https://alice:s3cr3t@example.test/invoices.',
          'Open [the report](https://alice:p%40ss%3Aword@example.test/invoices).',
          'Open https://alice@example.test/invoices.',
          'Open http://:p%3Aa%40ss@example.test/invoices.',
          'Read postgresql://alice:p%40ss@example.test:5432/reports.',
          'Open //alice:s3cr3t@example.test/invoices.',
          reusable[1],
          reusable[2],
        ]);
        const before = await unchanged();

        await t.test(
          'base retains ordered requests without assistant or credential content',
          async () => {
            const response = await draft(base);
            assert.equal(response.statusCode, 200, response.body);
            assert.deepEqual(response.json(), {
              title: 'Synthetic account report',
              prompt: `${first}\n\nMy password is synthetic-only.\n\n${clarification}`,
              omittedSensitive: true,
              hasAttachments: true,
            });
            assert.equal((await draft(foreign)).statusCode, 404);
            assert.deepEqual(await unchanged(), before);
          },
        );
      });

      await t.test(
        'schedule editor changes retain the intended recurrence and exact run time',
        async () => {
          const edited = await create({ cron: '0 9 * * *' });
          const beforePreview = (await request('GET', '/api/schedules'))
            .json()
            .find((row: { id: string }) => row.id === edited.id);
          const preview = await request('POST', `/api/schedules/${edited.id}/preview`, {
            cron: '30 10 * * 1-5',
            timeZone: 'Europe/Lisbon',
          });
          assert.equal(preview.statusCode, 200);
          assert.equal(preview.json().nextRun, '2035-10-29T10:30:00.000Z');
          assert.deepEqual(
            (await request('GET', '/api/schedules'))
              .json()
              .find((row: { id: string }) => row.id === edited.id),
            beforePreview,
          );
          assert.equal(
            (
              await request('PATCH', `/api/schedules/${edited.id}`, {
                title: 'Changed title',
                expectedRevision: beforePreview.revision,
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await request('PATCH', `/api/schedules/${edited.id}`, {
                title: 'Stale reversal',
                expectedRevision: beforePreview.revision,
              })
            ).statusCode,
            409,
          );
          for (const [frequency, day, expected] of [
            ['daily', '1', '2035-10-27T09:30:00.000Z'],
            ['weekdays', '1', '2035-10-29T10:30:00.000Z'],
            ['weekends', '1', '2035-10-27T09:30:00.000Z'],
            ['weekly', '0', '2035-10-28T10:30:00.000Z'],
            ['monthly', '31', '2035-10-31T10:30:00.000Z'],
          ] as Array<[ScheduleFrequency, string, string]>) {
            const schedule = await create({ cron: '0 9 * * *' });
            const response = await request('PATCH', `/api/schedules/${schedule.id}`, {
              cron: scheduleExpression(frequency, '10:30', day),
              timeZone: 'Europe/Lisbon',
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json<Schedule>().nextRun, expected);
            const job = await jobFor(schedule.id);
            assert.equal(job.startAfter.toISOString(), expected);
            await deliver([job]);
            assert.equal((await runs(schedule.id))[0].scheduledFor, expected);
            if (frequency === 'monthly')
              assert.equal(
                (await personal.getSchedule(schedule.id)).nextRun,
                '2035-12-31T10:30:00.000Z',
              );
            await request('DELETE', `/api/schedules/${schedule.id}`);
          }
          const customCron = '15 8 1,15 * 1-5';
          const custom = await create({ cron: customCron });
          const draft = readSchedule(custom.cron!);
          const response = await request('PATCH', `/api/schedules/${custom.id}`, {
            cron: scheduleExpression(draft.frequency, draft.time, draft.day, custom.cron!),
            timeZone: 'America/New_York',
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json<Schedule>().cron, customCron);
          assert.equal(response.json<Schedule>().timeZone, 'America/New_York');
          assert.equal(
            (await jobFor(custom.id)).startAfter.toISOString(),
            response.json<Schedule>().nextRun,
          );
          await request('DELETE', `/api/schedules/${custom.id}`);

          for (const [date, timeZone, expected] of [
            ['2035-10-27', 'Europe/Lisbon', '2035-10-27T08:05:00.000Z'],
            ['2035-10-28', 'Europe/Lisbon', '2035-10-28T09:05:00.000Z'],
            ['2035-10-27', 'Asia/Kathmandu', '2035-10-27T03:20:00.000Z'],
          ]) {
            const schedule = await create({ kind: 'once', runAt: '2035-10-27T12:00:00Z' });
            const response = await request('PATCH', `/api/schedules/${schedule.id}`, {
              runAt: scheduleRunAt(date, '09:05', timeZone),
              timeZone,
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json<Schedule>().runAt, expected);
            assert.deepEqual(scheduleLocalTime(response.json<Schedule>().runAt!, timeZone), {
              date,
              time: '09:05',
            });
            const job = await jobFor(schedule.id);
            assert.equal(job.startAfter.toISOString(), expected);
            await deliver([job]);
            assert.equal((await runs(schedule.id))[0].scheduledFor, expected);
            await request('DELETE', `/api/schedules/${schedule.id}`);
          }
        },
      );

      await t.test(
        'task activity names each tool call and the app actions the task took, only the owner’s',
        async () => {
          const { createLedger } = await import('../src/server/ledger.ts');
          await createLedger({ pool: db.pool, ownerId }).initialize();
          const current = await thread.activeThread(db.pool, ownerId);
          const taskId = randomUUID();
          const work = randomUUID();
          await db.pool.query(
            `INSERT INTO tasks(id,owner_id,title,done_when,now_text,result,state,closed_at)
             VALUES($1,$2,'Report for Lena','Report sent','Finished','Sent','done',now())`,
            [taskId, ownerId],
          );
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,status,prompt,task_id)
             VALUES($1,$2,$3,'task','succeeded','Email Lena the report.',$4)`,
            [work, ownerId, current.id, taskId],
          );
          for (const [type, summary] of [
            ['tool_complete', 'web search'],
            ['tool_complete', 'apps'],
            ['tool_failed', 'apps'],
            ['tool_complete', 'mcp  linear  create issue'],
          ])
            await db.pool.query(
              'INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,$3,$4)',
              [randomUUID(), work, type, summary],
            );
          await db.pool.query(
            `INSERT INTO app_actions(owner_id,turn_id,action,basis) VALUES($1,$2,'GMAIL_SEND_EMAIL','{"kind":"approved"}'),
             ('another-owner',$2,'SLACK_SEND_MESSAGE','{"kind":"approved"}')`,
            [ownerId, work],
          );
          const response = await request('GET', `/api/tasks/${taskId}`);
          assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(
            response
              .json<TaskDetail>()
              .events.filter((event) => event.type !== 'message' && event.type !== 'step')
              .map((event) => [event.type, event.summary]),
            [
              ['tool_complete', 'Searched the web'],
              ['tool_failed', 'Used a connected app'],
              ['tool_complete', 'Used linear'],
              ['tool_complete', 'Gmail: send email'],
            ],
          );
        },
      );
      await t.test(
        'schedule costs retain recorded charges and exclude plan estimates',
        async (t) => {
          const { createLedger } = await import('../src/server/ledger.ts');
          const ledger = createLedger({ pool: db.pool, ownerId });
          await ledger.initialize();
          let failCosts = false;
          const costRequests: string[][] = [];
          const priced = createPersonalService({
            pool: db.pool,
            ownerId,
            scheduler: thread.boss,
            now: () => clock,
            enqueueTurn: thread.enqueueTurn,
            refresh() {},
            sessionCosts: async (ids) => {
              costRequests.push(ids);
              if (failCosts) throw new Error('Synthetic cost lookup unavailable');
              return ledger.sessionCosts(ids);
            },
          });
          const pricedApp = Fastify();
          priced.registerRoutes(pricedApp);
          t.after(() => pricedApp.close());
          const costs = async (id: string) => {
            const response = await pricedApp.inject({
              method: 'GET',
              url: `/api/schedule-runs?scheduleId=${id}`,
            });
            assert.equal(response.statusCode, 200, response.body);
            return Object.fromEntries(
              response.json<ScheduleHistory>().runs.map((run) => [run.turnId, run.costUsd]),
            );
          };
          clock = new Date('2035-10-26T12:00:00.000Z');
          const schedule = await create({ cron: '5 9 * * *' });
          const monthly = async () =>
            (await priced.listSchedules()).find((item) => item.id === schedule.id)!.monthlyUsd;
          assert.equal(await monthly(), null);
          let job = await jobFor(schedule.id);
          clock = new Date(schedule.nextRun!);
          await deliver([job]);
          const [firstRun] = await runs(schedule.id);
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,0.3)',
            [randomUUID(), ownerId, firstRun!.turnId],
          );
          assert.equal(await monthly(), null);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
            firstRun!.turnId,
          ]);
          job = await jobFor(schedule.id);
          clock = new Date('2035-10-28T09:05:00.000Z');
          await deliver([job]);
          const turns = (await runs(schedule.id)).map((run) => run.turnId);
          assert.equal(turns.length, 2);
          await t.test(
            'filtered history paginates without exposing another owner’s runs',
            async () => {
              const otherOwner = 'schedule-history-other';
              const otherThread = await thread.activeThread(db.pool, otherOwner);
              const otherTurn = randomUUID();
              const otherSchedule = randomUUID();
              await db.pool.query(
                `INSERT INTO turns(id,owner_id,thread_id,source,status,prompt)
               VALUES($1,$2,$3,'schedule','succeeded','Synthetic other-owner run')`,
                [otherTurn, otherOwner, otherThread.id],
              );
              await db.pool.query(
                `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone)
               SELECT $1,$2,$3,0,$4,title,$5,scheduled_for,time_zone FROM schedule_runs
               WHERE owner_id=$6 AND turn_id=$7`,
                [
                  randomUUID(),
                  otherOwner,
                  otherSchedule,
                  randomUUID(),
                  otherTurn,
                  ownerId,
                  turns[0],
                ],
              );
              const path = `/api/schedule-runs?scheduleId=${schedule.id}&limit=1`;
              const firstResponse = await request('GET', path);
              assert.equal(firstResponse.statusCode, 200, firstResponse.body);
              const first = firstResponse.json<ScheduleHistory>();
              assert.deepEqual(
                first.runs.map((run) => run.turnId),
                [turns[0]],
              );
              assert.ok(first.nextCursor);
              const secondResponse = await request(
                'GET',
                `${path}&cursor=${encodeURIComponent(first.nextCursor)}`,
              );
              assert.equal(secondResponse.statusCode, 200, secondResponse.body);
              const second = secondResponse.json<ScheduleHistory>();
              assert.deepEqual(
                second.runs.map((run) => run.turnId),
                [turns[1]],
              );
              assert.equal(second.nextCursor, null);
              for (const id of [otherSchedule, randomUUID()]) {
                const response = await request('GET', `/api/schedule-runs?scheduleId=${id}`);
                assert.equal(response.statusCode, 200, response.body);
                assert.deepEqual(response.json<ScheduleHistory>(), { runs: [], nextCursor: null });
              }
              assert.deepEqual(await runs(otherSchedule), []);
              for (const id of ['', 'not-a-uuid'])
                assert.equal(
                  (await request('GET', `/api/schedule-runs?scheduleId=${id}`)).statusCode,
                  400,
                );
            },
          );
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,0.1)',
            [randomUUID(), ownerId, turns[0]],
          );
          assert.deepEqual(await costs(schedule.id), { [turns[0]!]: 0.1, [turns[1]!]: 0.3 });
          await t.test(
            'history stays pageable when recorded cost lookup is unavailable',
            async () => {
              const path = `/api/schedule-runs?scheduleId=${schedule.id}&limit=1`;
              const before = await pricedApp.inject({ method: 'GET', url: path });
              assert.equal(before.statusCode, 200, before.body);
              const expected = before.json<ScheduleHistory>();
              assert.ok(expected.nextCursor);
              const withoutCosts = expected.runs.map(({ costUsd: _cost, ...run }) => run);
              const previousRequests = costRequests.length;
              failCosts = true;
              try {
                const first = await pricedApp.inject({ method: 'GET', url: path });
                assert.equal(first.statusCode, 200, first.body);
                const firstPage = first.json<ScheduleHistory>();
                assert.deepEqual(firstPage, {
                  runs: withoutCosts,
                  nextCursor: expected.nextCursor,
                });
                const second = await pricedApp.inject({
                  method: 'GET',
                  url: `${path}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
                });
                assert.equal(second.statusCode, 200, second.body);
                const secondPage = second.json<ScheduleHistory>();
                assert.deepEqual(
                  secondPage.runs.map((run) => run.turnId),
                  [turns[1]],
                );
                assert.equal(Object.hasOwn(secondPage.runs[0]!, 'costUsd'), false);
                assert.equal(secondPage.nextCursor, null);
                assert.deepEqual(costRequests.slice(previousRequests), [[turns[0]], [turns[1]]]);
              } finally {
                failCosts = false;
              }
              const recovered = await pricedApp.inject({ method: 'GET', url: path });
              assert.equal(recovered.statusCode, 200, recovered.body);
              assert.deepEqual(recovered.json<ScheduleHistory>(), expected);
            },
          );
          assert.equal(Math.round((await monthly())! * 100) / 100, 9);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=ANY($1::uuid[])", [
            turns,
          ]);
          assert.equal(Math.round((await monthly())! * 100) / 100, 6);
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,NULL)',
            [randomUUID(), ownerId, turns[0]],
          );
          assert.equal(Math.round((await monthly())! * 100) / 100, 9);
          assert.deepEqual(await costs(schedule.id), { [turns[0]!]: null, [turns[1]!]: 0.3 });
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false }))
              .statusCode,
            200,
          );
          assert.equal(await monthly(), null);
          const continuation = randomUUID();
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,session_id,source,status,prompt)
           SELECT $1,owner_id,thread_id,session_id,'resume','succeeded','Synthetic follow-up'
           FROM turns WHERE id=$2`,
            [continuation, turns[1]],
          );
          await db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,0.2),
           ($4,'another-owner',$5,99)`,
            [randomUUID(), ownerId, continuation, randomUUID(), turns[1]],
          );
          assert.deepEqual(await costs(schedule.id), { [turns[0]!]: null, [turns[1]!]: 0.5 });
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
          assert.deepEqual(await costs(schedule.id), { [turns[0]!]: null, [turns[1]!]: 0.5 });

          const planSchedule = await create({ cron: '0 10 * * *' });
          clock = new Date(planSchedule.nextRun!);
          await deliver([await jobFor(planSchedule.id)]);
          const [planRun] = await runs(planSchedule.id);
          await db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details)
           VALUES($1,$2,$3,NULL,'{"estimateUsd":2.5}')`,
            [randomUUID(), ownerId, planRun!.turnId],
          );
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [planRun!.turnId]);
          assert.deepEqual(await costs(planSchedule.id), { [planRun!.turnId]: null });
          assert.equal(
            (await priced.listSchedules()).find((item) => item.id === planSchedule.id)!.monthlyUsd,
            null,
          );
        },
      );
      await t.test(
        'a schedule model changes only the model of its next runs and reprices its month',
        async (t) => {
          const { createLedger } = await import('../src/server/ledger.ts');
          const threshold = 900_000;
          const ledger = createLedger({
            pool: db.pool,
            ownerId,
            pricingThresholds: () => [threshold],
          });
          await ledger.initialize();
          const connectionId = randomUUID();
          const main = { connectionId, modelId: 'gpt-6.1-sol', effort: 'high' };
          const light = { connectionId, modelId: 'gpt-6-luna', effort: 'low' };
          const originalPrice: ModelPricing = {
            input: 2,
            output: 10,
            tiers: [{ inputTokensAbove: threshold, input: 2.25, output: 10 }],
          };
          let nativeAudio = false;
          let plan = false;
          const prices: Record<string, ModelPricing | null> = {
            'gpt-6.1-sol': originalPrice,
            'gpt-6-luna': { input: 0.1, output: 0.5 },
            'fixture-local': null,
            'fixture-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
          const modelled = createPersonalService({
            pool: db.pool,
            ownerId,
            scheduler: thread.boss,
            now: () => clock,
            enqueueTurn: thread.enqueueTurn,
            refresh() {},
            sessionCosts: ledger.sessionCosts,
            sessionUsage: ledger.sessionUsage,
            validateModel: (choice) => {
              if (!(choice.modelId in prices))
                throw Object.assign(new Error('Choose an available text model and effort.'), {
                  statusCode: 400,
                });
              return choice;
            },
            workPricing: (own) => {
              const modelId = own?.modelId ?? main.modelId;
              return { modelId, pricing: prices[modelId] ?? undefined, audio: nativeAudio, plan };
            },
          });
          const modelledApp = Fastify();
          modelledApp.setErrorHandler((error, _request, reply) => {
            const value = error as Error & { statusCode?: number };
            reply
              .code(error instanceof z.ZodError ? 400 : (value.statusCode ?? 500))
              .send({ error: value.message });
          });
          modelled.registerRoutes(modelledApp);
          t.after(() => modelledApp.close());
          const send = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
            modelledApp.inject({ method, url, payload: payload as object });
          const setModel = (id: string, model: unknown) =>
            send('PUT', `/api/schedules/${id}/model`, { model });
          clock = new Date('2035-10-26T12:00:00.000Z');
          const fixture = {
            title: 'Fixture modelled schedule',
            prompt: 'Return a synthetic modelled result only.',
            timeZone: 'Europe/Lisbon',
            kind: 'recurring',
            cron: '15 8 * * *',
          };
          assert.equal(
            (
              await send('POST', '/api/schedules', {
                ...fixture,
                model: { ...light, modelId: 'fixture-unavailable' },
              })
            ).statusCode,
            400,
          );
          const created = await send('POST', '/api/schedules', { ...fixture, model: light });
          assert.equal(created.statusCode, 200, created.body);
          const schedule = created.json<Schedule>();
          assert.deepEqual(schedule.model, light);
          const before = (
            await db.pool.query('SELECT revision,job_id,next_run_at FROM schedules WHERE id=$1', [
              schedule.id,
            ])
          ).rows[0];
          const changed = await setModel(schedule.id, main);
          assert.equal(changed.statusCode, 200, changed.body);
          assert.deepEqual(changed.json<Schedule>().model, main);
          assert.deepEqual(
            (
              await db.pool.query('SELECT revision,job_id,next_run_at FROM schedules WHERE id=$1', [
                schedule.id,
              ])
            ).rows[0],
            before,
          );
          assert.equal(
            (await setModel(schedule.id, { ...main, modelId: 'gpt-x' })).statusCode,
            400,
          );
          assert.equal((await setModel(randomUUID(), main)).statusCode, 404);
          assert.deepEqual((await modelled.getSchedule(schedule.id)).model, main);

          clock = new Date(schedule.nextRun!);
          await deliver([await jobFor(schedule.id)]);
          const [run] = await runs(schedule.id);
          assert.ok(run);
          assert.deepEqual(await thread.workOrigin(run.turnId), {
            kind: 'schedule',
            task: null,
            schedule: main,
          });
          await thread.resumeTurn(run.turnId, `fixture-resume:${run.turnId}`, 'Continue.');
          const resumed = (
            await db.pool.query<{ id: string }>(
              'SELECT id FROM turns WHERE parent_turn_id=$1 AND owner_id=$2',
              [run.turnId, ownerId],
            )
          ).rows[0]!;
          assert.equal((await thread.workOrigin(resumed.id))?.kind, 'schedule');

          const agentUsageId = randomUUID();
          const agentUsage = {
            category: 'agent',
            model: main.modelId,
            inputTokens: 1_000_000,
            outputTokens: 100_000,
          };
          await db.pool.query(
            `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES
               ($1,$3,$4,3.35,$5),
               ($2,$3,$4,0.01,'{"category":"review","model":"gpt-6.1-sol","inputTokens":5000}')`,
            [
              agentUsageId,
              randomUUID(),
              ownerId,
              run.turnId,
              { ...agentUsage, pricingSignature: modelPricingSignature(originalPrice) },
            ],
          );
          await db.pool.query(
            "UPDATE turns SET status='succeeded' WHERE id=$1 OR parent_turn_id=$1",
            [run.turnId],
          );
          const monthly = async () => (await modelled.getSchedule(schedule.id)).monthlyUsd!;
          const onMain = await monthly();
          assert.ok(onMain > 0);
          const expectRunCost = async (cost: number) => {
            assert.ok(Math.abs((await monthly()) / onMain - cost / 3.36) < 1e-9);
          };
          prices[main.modelId] = { input: 2.2, output: 11 };
          await expectRunCost(3.31);
          prices[main.modelId] = { ...originalPrice, tiers: [] };
          await expectRunCost(3.01);
          prices[main.modelId] = originalPrice;
          await db.pool.query('UPDATE model_usage SET details=$2 WHERE id=$1', [
            agentUsageId,
            agentUsage,
          ]);
          await expectRunCost(3.26);
          assert.ok(Math.abs((await ledger.sessionCosts([run.turnId]))[run.turnId]! - 3.36) < 1e-9);
          await setModel(schedule.id, light);
          await expectRunCost(0.16);
          await setModel(schedule.id, { ...light, modelId: 'fixture-free' });
          await expectRunCost(0.01);
          await setModel(schedule.id, { ...light, modelId: 'fixture-local' });
          assert.equal((await modelled.getSchedule(schedule.id)).monthlyUsd ?? null, null);
          await setModel(schedule.id, null);
          assert.equal((await modelled.getSchedule(schedule.id)).model, null);
          await expectRunCost(3.26);
          nativeAudio = true;
          assert.equal(await monthly(), null);
          nativeAudio = false;
          await db.pool.query(
            "UPDATE model_usage SET details=details || jsonb_build_object('estimateUsd',cost_usd),cost_usd=NULL WHERE turn_id=$1",
            [run.turnId],
          );
          plan = true;
          assert.equal(await monthly(), null);
          plan = false;
          await expectRunCost(3.26);
          await db.pool.query(
            "UPDATE model_usage SET cost_usd=(details->>'estimateUsd')::float8,details=details-'estimateUsd' WHERE turn_id=$1",
            [run.turnId],
          );
          const cancelledUsageId = randomUUID();
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,NULL,$4)',
            [
              cancelledUsageId,
              ownerId,
              run.turnId,
              { category: 'agent', status: 'cancelled', model: main.modelId },
            ],
          );
          await expectRunCost(3.26);
          assert.equal((await ledger.sessionCosts([run.turnId]))[run.turnId], null);
          await db.pool.query('DELETE FROM model_usage WHERE id=$1', [cancelledUsageId]);
          const unpricedAgent = randomUUID();
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,NULL,$4)',
            [
              unpricedAgent,
              ownerId,
              run.turnId,
              { category: 'agent', status: 'succeeded', model: main.modelId },
            ],
          );
          for (const pricingSignature of [undefined, modelPricingSignature(originalPrice)]) {
            await db.pool.query('UPDATE model_usage SET details=$2 WHERE id=$1', [
              agentUsageId,
              { ...agentUsage, pricingSignature },
            ]);
            assert.equal(await monthly(), null);
            await db.pool.query('UPDATE model_usage SET cost_usd=0 WHERE id=$1', [unpricedAgent]);
            assert.equal(await monthly(), null);
            await db.pool.query('UPDATE model_usage SET cost_usd=NULL WHERE id=$1', [
              unpricedAgent,
            ]);
          }
          await db.pool.query('DELETE FROM model_usage WHERE id=$1', [unpricedAgent]);
          await db.pool.query('UPDATE model_usage SET details=$2 WHERE id=$1', [
            agentUsageId,
            agentUsage,
          ]);
          const unpricedReview = randomUUID();
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,NULL,$4)',
            [
              unpricedReview,
              ownerId,
              run.turnId,
              { category: 'review', status: 'succeeded', inputTokens: 100 },
            ],
          );
          assert.equal(await monthly(), null);
          await db.pool.query(
            "UPDATE model_usage SET cost_usd=0,details=details || jsonb_build_object('pricing','sdk_estimate') WHERE id=$1",
            [unpricedReview],
          );
          assert.equal(await monthly(), null);
          await db.pool.query(
            "UPDATE model_usage SET details=details || jsonb_build_object('pricing','reported') WHERE id=$1",
            [unpricedReview],
          );
          await expectRunCost(3.26);
          await db.pool.query('DELETE FROM model_usage WHERE id=$1', [unpricedReview]);
          await db.pool.query('UPDATE model_usage SET cost_usd=0 WHERE turn_id=$1', [run.turnId]);
          await setModel(schedule.id, light);
          await expectRunCost(0.15);
        },
      );
      await t.test(
        'a recurring schedule starts no run while its last run is busy or waiting on the owner',
        async () => {
          const before = clock;
          const schedule = await create({ cron: '*/15 * * * *' });
          const active = async () => {
            const response = await request('GET', '/api/schedules');
            assert.equal(response.statusCode, 200, response.body);
            return response.json<Schedule[]>().find((item) => item.id === schedule.id)!.activeRun;
          };
          const question = async (turnId: string, text: string) => {
            const id = randomUUID();
            await db.pool.query(
              `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text)
               SELECT $1,owner_id,thread_id,id,'assistant',$3 FROM turns WHERE id=$2`,
              [id, turnId, text],
            );
            return id;
          };
          const fire = async () => {
            const job = await jobFor(schedule.id);
            clock = new Date(job.data.scheduledFor);
            await deliver([job]);
            return (await runs(schedule.id)).map((run) => run.turnId);
          };
          const [first] = await fire();
          await question(first!, 'Checking the synthetic account report.');
          const firstQuestion = await question(first!, 'May I use the synthetic saved login?');
          assert.deepEqual(await fire(), [first]);
          assert.equal((await runNow(schedule)).statusCode, 409);
          for (const status of ['running', 'waiting']) {
            await db.pool.query('UPDATE turns SET status=$2,started_at=now() WHERE id=$1', [
              first,
              status,
            ]);
            assert.deepEqual(await fire(), [first]);
            assert.equal((await runNow(schedule)).statusCode, 409);
            assert.deepEqual(await active(), {
              turnId: first,
              status,
              questionMessageId: status === 'waiting' ? firstQuestion : null,
            });
          }
          const resumed = await thread.enqueueTurn('Synthetic answer.', {
            source: 'resume',
            sessionId: first!,
            parentTurnId: first!,
            background: true,
          });
          const resumedQuestion = await question(resumed, 'Enter the synthetic verification code.');
          for (const status of ['queued', 'running', 'waiting'] as const) {
            await db.pool.query(
              `UPDATE turns SET status=$2,started_at=CASE WHEN $2='queued' THEN NULL ELSE now() END WHERE id=$1`,
              [resumed, status],
            );
            assert.deepEqual(await active(), {
              turnId: resumed,
              status,
              questionMessageId: status === 'waiting' ? resumedQuestion : null,
            });
            assert.equal((await runNow(schedule)).statusCode, 409);
          }
          const archivedThread = randomUUID();
          await db.pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,now())', [
            archivedThread,
            ownerId,
          ]);
          for (const [owner, threadId, hidden, text] of [
            ['another-owner', null, false, 'Foreign question'],
            [ownerId, archivedThread, false, 'Question from another conversation'],
            [ownerId, null, true, 'Hidden question'],
            [ownerId, null, false, ''],
          ] as const)
            await db.pool.query(
              `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,hidden_at,created_at)
               SELECT $1,$3,COALESCE($4::uuid,thread_id),id,'assistant',$6,
                 CASE WHEN $5 THEN now() END,now()+interval '1 second' FROM turns WHERE id=$2`,
              [randomUUID(), resumed, owner, threadId, hidden, text],
            );
          assert.equal((await active())?.questionMessageId, resumedQuestion);
          await db.pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [resumedQuestion]);
          assert.deepEqual(await active(), {
            turnId: resumed,
            status: 'waiting',
            questionMessageId: null,
          });
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [resumed]);
          assert.equal((await saved(schedule.id)).activeRun, null);
          assert.equal((await fire()).length, 2);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=ANY($1::uuid[])", [
            (await runs(schedule.id)).map((run) => run.turnId),
          ]);
          const due = await jobFor(schedule.id);
          clock = new Date(due.data.scheduledFor);
          const beforeRace = (await runs(schedule.id)).length;
          const [, manual] = await Promise.all([deliver([due]), runNow(schedule)]);
          assert.ok([200, 409].includes(manual.statusCode), manual.body);
          assert.equal((await runs(schedule.id)).length, beforeRace + 1);
          assert.notEqual((await jobFor(schedule.id)).id, due.id);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          clock = before;
        },
      );
      await t.test('stale watched jobs do not poll accounts or start runs', async () => {
        const before = clock;
        const account = randomUUID();
        watched.set(account, 'v1');
        const disabled = await create({ cron: '*/15 * * * *', watch: [account] });
        const disabledJob = await jobFor(disabled.id);
        const pause = await request('PATCH', `/api/schedules/${disabled.id}`, {
          enabled: false,
        });
        assert.equal(pause.statusCode, 200, pause.body);
        const beforeDisabled = watchPolls;
        clock = new Date(disabledJob.data.scheduledFor);
        await deliver([disabledJob]);
        assert.equal(watchPolls, beforeDisabled);
        assert.equal((await runs(disabled.id)).length, 0);

        const revised = await create({ cron: '*/15 * * * *', watch: [account] });
        const oldJob = await jobFor(revised.id);
        const update = await request('PATCH', `/api/schedules/${revised.id}`, {
          title: 'Updated fixture watch',
        });
        assert.equal(update.statusCode, 200, update.body);
        const currentJob = await jobFor(revised.id);
        assert.notEqual(currentJob.id, oldJob.id);
        assert.notEqual(currentJob.data.revision, oldJob.data.revision);
        const beforeRevised = watchPolls;
        clock = new Date(oldJob.data.scheduledFor);
        await deliver([oldJob]);
        assert.equal(watchPolls, beforeRevised);
        assert.equal((await runs(revised.id)).length, 0);

        clock = new Date(currentJob.data.scheduledFor);
        await deliver([currentJob]);
        assert.equal(watchPolls, beforeRevised + 1);
        assert.equal((await runs(revised.id)).length, 1);
        await request('DELETE', `/api/schedules/${disabled.id}`);
        await request('DELETE', `/api/schedules/${revised.id}`);
        clock = before;
      });
      await t.test(
        'a watch schedule skips a fire only while its accounts are unchanged since a finished run',
        async () => {
          const before = clock;
          const account = randomUUID();
          const body = {
            title: 'Fixture watch',
            prompt: 'Return a synthetic result only.',
            timeZone: 'Europe/Lisbon',
            cron: '*/15 * * * *',
            watch: [account],
          };
          assert.equal((await request('POST', '/api/schedules', body)).statusCode, 400);
          watched.set(account, 'v1');
          const schedule = await create({ cron: '*/15 * * * *', watch: [account] });
          const fire = async () => {
            const job = await jobFor(schedule.id);
            clock = new Date(job.data.scheduledFor);
            await deliver([job]);
            return (await runs(schedule.id)).map((run) => run.turnId);
          };
          const finish = async (status = 'succeeded') =>
            db.pool.query('UPDATE turns SET status=$2 WHERE id=ANY($1::uuid[])', [
              (await runs(schedule.id)).map((run) => run.turnId),
              status,
            ]);
          const [first] = await fire();
          await finish();
          assert.deepEqual(await fire(), [first]);
          const resumed = await thread.enqueueTurn('Synthetic watched resume', {
            source: 'resume',
            background: true,
            parentTurnId: first,
            sessionId: first,
          });
          const stopped = await request(
            'POST',
            `/api/schedules/${schedule.id}/runs/${resumed}/stop`,
          );
          assert.equal(stopped.statusCode, 200, stopped.body);
          assert.equal((await runs(schedule.id))[0].status, 'cancelled');
          assert.equal((await fire()).length, 2);
          await finish();
          const manual = await runNow(schedule);
          assert.equal(manual.statusCode, 200, manual.body);
          assert.equal((await runs(schedule.id)).length, 3);
          await finish('failed');
          assert.equal((await fire()).length, 4);
          await finish();
          assert.equal((await fire()).length, 4);
          watched.set(account, 'v2');
          assert.equal((await fire()).length, 5);
          await finish();
          await personal.manage('schedule_update', { id: schedule.id, watch: null });
          assert.equal((await fire()).length, 6);
          await finish();
          await request('DELETE', `/api/schedules/${schedule.id}`);
          clock = before;
        },
      );
      await t.test(
        'a stopped run at the same scheduled time replaces an earlier success for watch checks',
        async () => {
          const before = clock;
          const account = randomUUID();
          watched.set(account, 'synthetic-unchanged');
          const schedule = await create({ cron: '*/15 * * * *', watch: [account] });
          try {
            const firstJob = await jobFor(schedule.id);
            clock = new Date(firstJob.data.scheduledFor);
            await deliver([firstJob]);
            const first = (await runs(schedule.id))[0].turnId;
            await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [first]);
            const later = (await runNow(await saved(schedule.id))).json().turnId as string;
            const times = (
              await db.pool.query(
                'SELECT scheduled_for FROM schedule_runs WHERE turn_id=ANY($1::uuid[])',
                [[first, later]],
              )
            ).rows;
            assert.equal(times.length, 2);
            assert.equal(
              times[0].scheduled_for.toISOString(),
              times[1].scheduled_for.toISOString(),
            );
            const response = await request(
              'POST',
              `/api/schedules/${schedule.id}/runs/${later}/stop`,
            );
            assert.equal(response.statusCode, 200, response.body);
            const nextJob = await jobFor(schedule.id);
            clock = new Date(nextJob.data.scheduledFor);
            await deliver([nextJob]);
            assert.equal((await runs(schedule.id)).length, 3);
          } finally {
            await db.pool.query(
              "UPDATE turns SET status='cancelled' WHERE session_id IN (SELECT turn_id FROM schedule_runs WHERE schedule_id=$1)",
              [schedule.id],
            );
            await request('DELETE', `/api/schedules/${schedule.id}`);
            watched.delete(account);
            clock = before;
          }
        },
      );
      await t.test(
        'a recurring schedule skips planned fires while its model is paused, while Run now and one-time runs still start',
        async () => {
          const before = clock;
          const schedule = await create({ cron: '*/15 * * * *' });
          const fire = async () => {
            const job = await jobFor(schedule.id);
            clock = new Date(job.data.scheduledFor);
            await deliver([job]);
            return (await runs(schedule.id)).length;
          };
          modelPaused = true;
          try {
            assert.equal(await fire(), 0);
            assert.equal(await fire(), 0);
            const manual = await runNow(await saved(schedule.id));
            assert.equal(manual.statusCode, 200, manual.body);
            assert.equal((await runs(schedule.id)).length, 1);
            assert.deepEqual(
              (
                await db.pool.query('SELECT skipped FROM schedule_runs WHERE turn_id=$1', [
                  manual.json().turnId,
                ])
              ).rows[0].skipped.map((skip: { reason: string }) => skip.reason),
              ['paused', 'paused'],
            );
            await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
              manual.json().turnId,
            ]);
            const once = await create({
              kind: 'once',
              runAt: new Date(clock.getTime() + 60_000).toISOString(),
            });
            const job = await jobFor(once.id);
            clock = new Date(job.data.scheduledFor);
            await deliver([job]);
            assert.equal((await runs(once.id)).length, 1);
            await request('DELETE', `/api/schedules/${once.id}`);
          } finally {
            modelPaused = false;
          }
          assert.equal(await fire(), 2);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          clock = before;
        },
      );
      await t.test(
        'a baseline added to an existing watch is what its next run compares with',
        async () => {
          const before = clock;
          const schedule = await create({ cron: '0 9 * * 1' });
          const baseline = {
            status: 'verified',
            sourceUrl: 'https://watch.example.test/pricing',
            value: 'Pro 29 EUR',
            summary: 'Synthetic pricing baseline.',
          };
          await personal.manage('schedule_update', {
            id: schedule.id,
            baselineObservation: baseline,
          });
          assert.equal((await saved(schedule.id)).baselineObservation?.value, 'Pro 29 EUR');
          assert.equal((await saved(schedule.id)).nextRun, schedule.nextRun);
          clock = new Date(schedule.nextRun!);
          await deliver([await jobFor(schedule.id)]);
          const [run] = await runs(schedule.id);
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [run!.turnId]);
          const recorded = (await personal.manage(
            'schedule_record_observation',
            { ...baseline, value: 'Pro 39 EUR' },
            { sourceMessageId: null, turnId: run!.turnId },
          )) as { previous: { value: string } | null };
          assert.equal(recorded.previous?.value, 'Pro 29 EUR');
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [run!.turnId]);
          clock = new Date(clock.getTime() + 60_000);
          await personal.manage('schedule_update', {
            id: schedule.id,
            baselineObservation: { ...baseline, value: 'Pro 35 EUR' },
          });
          clock = new Date((await saved(schedule.id)).nextRun!);
          await deliver([await jobFor(schedule.id)]);
          const next = (await runs(schedule.id)).find((item) => item.turnId !== run!.turnId);
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [next!.turnId]);
          const rebased = (await personal.manage(
            'schedule_record_observation',
            { ...baseline, value: 'Pro 45 EUR' },
            { sourceMessageId: null, turnId: next!.turnId },
          )) as { previous: { value: string } | null };
          assert.equal(rebased.previous?.value, 'Pro 35 EUR');
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [next!.turnId]);
          clock = before;
        },
      );
      await t.test(
        'restart preserves due jobs and replaces a failed dispatcher without replay',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-06T10:00:00Z' });
          const job = await jobFor(schedule.id);
          await personal.initialize({ workers: false });
          assert.equal((await jobFor(schedule.id)).id, job.id);
          await thread.boss.cancel('scheduled-task', job.id);
          clock = new Date('2035-11-07T10:00:00Z');
          await personal.initialize({ workers: false });
          const replacement = await jobFor(schedule.id);
          assert.notEqual(replacement.id, job.id);
          assert.equal(replacement.data.scheduledFor, schedule.runAt);
          await deliver([job]);
          assert.deepEqual(await runs(schedule.id), []);
          await deliver([replacement]);
          const lateRuns = await runs(schedule.id);
          assert.equal(lateRuns.length, 1);
          assert.match(
            (await db.pool.query('SELECT prompt FROM turns WHERE id=$1', [lateRuns[0]!.turnId]))
              .rows[0].prompt,
            /\nThis run was due at Tue,? 6 Nov 2035, 10:00 WET and started at Wed,? 7 Nov 2035, 10:00 WET\.$/,
          );
        },
      );
      await t.test(
        'a late recurring run says when it was due, when it started and what was skipped',
        async () => {
          const before = clock;
          clock = new Date('2035-11-07T10:00:00.000Z');
          const promptOf = async (id: string) => {
            const [run] = await runs(id);
            return (await db.pool.query('SELECT prompt FROM turns WHERE id=$1', [run!.turnId]))
              .rows[0].prompt as string;
          };
          const title = `${'x'.repeat(119)}\u{1F600} digest`;
          const onTime = await create({ cron: '0 8 * * *', title });
          clock = new Date(onTime.nextRun!);
          await deliver([await jobFor(onTime.id)]);
          const base = await promptOf(onTime.id);
          assert.doesNotMatch(base, /This run was due/);
          const late = await create({ cron: '0 8 * * *', title });
          clock = new Date(new Date(late.nextRun!).getTime() + 2 * 86_400_000 + 36_720_000);
          await deliver([await jobFor(late.id)]);
          const prompt = await promptOf(late.id);
          assert.match(
            prompt,
            /This run was due at Fri,? 9 Nov 2035, 08:00 WET and started at Sun,? 11 Nov 2035, 18:12 WET\. 2 later runs were skipped\.$/,
          );
          assert.equal(prompt.replace(/\nThis run was due.*$/, ''), base);
          const [lateRun] = await runs(late.id);
          const { thread_id: threadId } = (
            await db.pool.query('SELECT thread_id FROM turns WHERE id=$1', [lateRun!.turnId])
          ).rows[0];
          const posted = async () => {
            const client = await db.pool.connect();
            try {
              const id = await thread.insertAssistantMessage(
                client,
                { threadId, turnId: lateRun!.turnId },
                'Synthetic late result.',
              );
              return (await client.query('SELECT presentation FROM messages WHERE id=$1', [id]))
                .rows[0].presentation;
            } finally {
              client.release();
            }
          };
          const first = await posted();
          assert.deepEqual(
            {
              type: first?.type,
              title: first?.title,
              outcome: first?.outcome,
              dueAt: first?.dueAt,
              skipped: first?.skipped.map((skip: { at: string; reason: string }) => skip.reason),
            },
            {
              type: 'schedule-run',
              title: 'x'.repeat(119),
              outcome: 'ran',
              dueAt: '2035-11-09T08:00:00.000Z',
              skipped: ['stopped', 'stopped'],
            },
          );
          assert.equal(await posted(), null);
          clock = before;
        },
      );
      channels = await connect();
      const origin = await receive('Remind me in a minute.');

      await t.test(
        'resumed schedules retain their owned source route and instruction',
        async () => {
          const continuation = await thread.enqueueTurn('Synthetic continuation.', {
            source: 'resume',
          });
          const provenance = { ...origin, turnId: continuation };
          const schedule = await createRouted(provenance);
          const stored = (
            await db.pool.query(
              'SELECT delivery_channel,channel_source_id,authority FROM schedules WHERE id=$1',
              [schedule.id],
            )
          ).rows[0];
          assert.equal(stored.delivery_channel, origin.channel);
          assert.equal(stored.channel_source_id, origin.sourceId);
          assert.equal(
            stored.authority.messages.find(
              (message: { id: string }) => message.id === origin.sourceMessageId,
            )?.text,
            'Remind me in a minute.',
          );
          const manual = await runNow(schedule);
          assert.equal(manual.statusCode, 200, manual.body);
          const manualTurn = manual.json().turnId;
          assert.deepEqual(
            (
              await db.pool.query('SELECT channel,channel_source_id FROM turns WHERE id=$1', [
                manualTurn,
              ])
            ).rows[0],
            {
              channel: origin.channel,
              channel_source_id: origin.sourceId,
            },
          );
          assert.deepEqual(
            (
              await db.pool.query('SELECT authority FROM schedule_runs WHERE turn_id=$1', [
                manualTurn,
              ])
            ).rows[0],
            {
              authority: stored.authority,
            },
          );
          const sameThread = await receive('Remind me in a minute again.');
          const otherThread = await receive('Remind me in a minute.', 'other-thread');
          for (const [route, timing, reused] of [
            [provenance, {}, true],
            [provenance, { prompt: 'Send the reworded synthetic reminder.' }, true],
            [provenance, { title: 'Reworded synthetic reminder' }, true],
            [sameThread, {}, true],
            [otherThread, {}, false],
            [
              provenance,
              { title: 'Another synthetic reminder', prompt: 'Send another synthetic reminder.' },
              false,
            ],
          ] as const) {
            const created = (await createRouted(route, timing)) as Schedule & {
              existing?: boolean;
            };
            assert.equal(created.id === schedule.id, reused);
            assert.equal(created.existing === true, reused);
          }
          const pinned = { connectionId: randomUUID(), modelId: 'fixture-model', effort: 'high' };
          await db.pool.query('UPDATE schedules SET model=$2 WHERE id=$1', [
            schedule.id,
            JSON.stringify(pinned),
          ]);
          assert.equal((await createRouted(provenance)).id, schedule.id);
          const repinned = { ...pinned, modelId: 'fixture-other-model' };
          const again = await createRouted(provenance, { model: repinned });
          assert.equal(again.id, schedule.id);
          assert.deepEqual(again.model, repinned);
          for (const sourceOwner of [ownerId, 'foreign-source']) {
            const sourceThread = randomUUID();
            const sourceTurn = randomUUID();
            const sourceMessage = randomUUID();
            await db.pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,$3)', [
              sourceThread,
              sourceOwner,
              sourceOwner === ownerId ? new Date() : null,
            ]);
            await db.pool.query(
              "INSERT INTO turns(id,owner_id,thread_id,source,prompt) VALUES($1,$2,$3,'user','Unrelated source.')",
              [sourceTurn, sourceOwner, sourceThread],
            );
            await db.pool.query(
              "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'user','Unrelated source.')",
              [sourceMessage, sourceOwner, sourceThread, sourceTurn],
            );
            const unownedSource = { turnId: continuation, sourceMessageId: sourceMessage };
            await assert.rejects(createRouted(unownedSource), /unavailable/);
            await assert.rejects(
              personal.manage(
                'schedule_update',
                { id: schedule.id, prompt: 'Substituted instruction.' },
                unownedSource,
              ),
              /unavailable/,
            );
          }
          await assert.rejects(
            createRouted(origin, { channel: 'telegram:arbitrary', threadId: 'other' }),
          );
          await assert.rejects(
            personal.manage('schedule_update', { id: schedule.id, deliveryChannel: 'web' }),
          );
          for (const source of [
            { ...origin, sourceMessageId: randomUUID() },
            { turnId: origin.turnId, sourceMessageId: null },
          ])
            await assert.rejects(createRouted(source), /unavailable/);
          const foreign = randomUUID();
          const foreignThread = randomUUID();
          await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'foreign')", [
            foreignThread,
          ]);
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel) VALUES($1,'foreign',$2,'schedule','Other',$3)",
            [foreign, foreignThread, origin.channel],
          );
          await assert.rejects(
            createRouted({ turnId: foreign, sourceMessageId: null }),
            /unavailable/,
          );
        },
      );
      await t.test(
        'schedule changes retain exact owner evidence and bind each run to its revision',
        async () => {
          const withdrawn = await receive('Withdrawn synthetic request.');
          await db.pool.query('UPDATE turns SET withdrawn=true WHERE id=$1', [withdrawn.turnId]);
          const context = await receive('Look at the synthetic budget folder.');
          const asked = await receive('Check it every morning.');
          const schedule = await createRouted(asked, {
            title: 'Synthetic budget check',
            prompt: 'Check the synthetic budget folder.',
          });
          const evidence = async () =>
            (await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [schedule.id]))
              .rows[0].authority;
          const first = await evidence();
          assert.equal(
            first.messages.find((message: { id: string }) => message.id === asked.sourceMessageId)
              ?.text,
            'Check it every morning.',
          );
          assert.equal(
            first.messages.find((message: { id: string }) => message.id === context.sourceMessageId)
              ?.canAuthorize,
            false,
          );
          assert.ok(
            !first.messages.some(
              (message: { id: string }) => message.id === withdrawn.sourceMessageId,
            ),
          );
          const change = await receive('Make it cheaper.');
          for (const prompt of ['Check the folder cheaply.', 'Check the folder more cheaply.'])
            await manageRouted('schedule_update', { id: schedule.id, prompt }, change);
          const changed = await evidence();
          assert.equal(
            changed.messages.filter(
              (message: { id: string }) => message.id === change.sourceMessageId,
            ).length,
            1,
          );
          assert.ok(
            changed.messages.some(
              (message: { id: string }) => message.id === asked.sourceMessageId,
            ),
          );
          const manual = await runNow(await saved(schedule.id));
          assert.equal(manual.statusCode, 200, manual.body);
          assert.deepEqual((await turnOrigin(manual.json().turnId))?.scheduleInstruction, changed);
          for (let index = 0; index < 11; index++) {
            const update = await receive(`Use synthetic format ${index}.`);
            await manageRouted(
              'schedule_update',
              { id: schedule.id, prompt: `Read the folder with format ${index}.` },
              update,
            );
          }
          assert.ok(
            (await evidence()).messages.some(
              (message: { id: string }) => message.id === asked.sourceMessageId,
            ),
          );
          assert.deepEqual((await turnOrigin(manual.json().turnId))?.scheduleInstruction, changed);
          await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
            manual.json().turnId,
          ]);
          const beforeRestart = await evidence();
          await personal.initialize({ workers: false });
          assert.deepEqual(await evidence(), beforeRestart);
          const timing = await receive('Move it to the next day.');
          await manageRouted(
            'schedule_update',
            { id: schedule.id, runAt: new Date(clock.getTime() + 86_400_000).toISOString() },
            timing,
          );
          assert.ok(
            (await evidence()).messages.some(
              (message: { id: string }) => message.id === timing.sourceMessageId,
            ),
          );
          await db.pool.query('UPDATE turns SET withdrawn=true WHERE id=$1', [timing.turnId]);
          await assert.rejects(
            validateOwnerInstructions(db.pool, ownerId, await evidence()),
            /withdrawn or unavailable/,
          );
          const edited = await request('PATCH', `/api/schedules/${schedule.id}`, {
            prompt: 'Owner-written synthetic prompt.',
          });
          assert.equal(edited.statusCode, 200, edited.body);
          const reset = await evidence();
          assert.equal(reset.messages.length, 1);
          assert.equal(reset.messages[0].id, null);
          assert.equal(reset.messages[0].text, 'Owner-written synthetic prompt.');
        },
      );
      await t.test(
        'a schedule created in a task retains the allowed earlier chat and exact proposal',
        async () => {
          const background = await receive('The synthetic task board is in Documents/board.');
          const asked = await receive('Check it every morning.');
          const current = (
            await db.pool.query('SELECT thread_id FROM turns WHERE id=$1', [asked.turnId])
          ).rows[0];
          await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
            asked.turnId,
          ]);
          const task = await tasks.execute(
            { threadId: current.thread_id, turnId: asked.turnId },
            {
              action: 'start',
              title: 'Synthetic board schedule',
              message: 'Set the synthetic schedule.',
              doneWhen: 'The schedule exists.',
              now: 'Set the schedule.',
            },
            asked.sourceMessageId,
          );
          assert.ok(task && 'id' in task);
          const started = new Date(Date.now() - 3 * 86_400_000);
          await db.pool.query('UPDATE tasks SET created_at=$2 WHERE id=$1', [task.id, started]);
          for (const [source, age] of [
            [background, 60_000],
            [asked, 1_000],
          ] as const)
            await db.pool.query('UPDATE messages SET created_at=$2 WHERE id=$1', [
              source.sourceMessageId,
              new Date(started.getTime() - age),
            ]);
          const unrelated = await receive('Send the separate synthetic invoice to Lena.');
          const child = (await db.pool.query('SELECT id FROM turns WHERE task_id=$1', [task.id]))
            .rows[0];
          const schedule = await createRouted(
            { turnId: child.id, sourceMessageId: asked.sourceMessageId },
            { title: 'Synthetic task schedule', prompt: 'Read Documents/board.' },
          );
          const authority = (
            await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [schedule.id])
          ).rows[0].authority;
          assert.equal(
            authority.messages.find(
              (message: { id: string }) => message.id === background.sourceMessageId,
            )?.canAuthorize,
            false,
          );
          assert.equal(
            authority.messages.find(
              (message: { id: string }) => message.id === asked.sourceMessageId,
            )?.canAuthorize,
            true,
          );
          assert.ok(
            !authority.messages.some(
              (message: { id: string }) => message.id === unrelated.sourceMessageId,
            ),
          );
          const proposalId = randomUUID();
          const proposal = 'Read the synthetic board every Friday?';
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
            [proposalId, ownerId, current.thread_id, asked.turnId, proposal],
          );
          const reply = await receive('Do that every Friday.');
          await db.pool.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
            reply.sourceMessageId,
            proposalId,
          ]);
          const accepted = await createRouted(reply, {
            title: 'Synthetic proposal schedule',
            prompt: 'Read the synthetic board on Friday.',
          });
          const record = (
            await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [accepted.id])
          ).rows[0].authority;
          assert.deepEqual(
            record.messages.find((message: { id: string }) => message.id === reply.sourceMessageId)
              ?.replyTo,
            { id: proposalId, text: proposal },
          );
        },
      );
      await t.test(
        'legacy schedule instructions migrate once without inventing earlier context',
        async () => {
          const source = await receive('Read the synthetic legacy board every Friday.');
          const schedule = await create({
            title: 'Synthetic legacy evidence',
            prompt: 'Read the synthetic legacy board.',
            kind: 'once',
            runAt: new Date(clock.getTime() + 60_000).toISOString(),
          });
          const manual = await runNow(schedule);
          assert.equal(manual.statusCode, 200, manual.body);
          await db.pool.query(
            'ALTER TABLE schedules ADD COLUMN authority_instruction text, ADD COLUMN authority_source_message_id uuid, ADD COLUMN authority_context jsonb; ALTER TABLE schedule_runs ADD COLUMN authority_instruction text, ADD COLUMN authority_source_message_id uuid, ADD COLUMN authority_context jsonb;',
          );
          for (const table of ['schedules', 'schedule_runs'])
            await db.pool.query(
              `UPDATE ${table} SET authority=NULL,authority_instruction=$2,authority_source_message_id=$3 WHERE ${table === 'schedules' ? 'id' : 'schedule_id'}=$1`,
              [
                schedule.id,
                'Read the synthetic legacy board every Friday.',
                source.sourceMessageId,
              ],
            );
          const sourceTime = new Date(Date.now() - 3 * 86_400_000).toISOString();
          await db.pool.query('UPDATE messages SET created_at=$2 WHERE id=$1', [
            source.sourceMessageId,
            sourceTime,
          ]);
          const incomplete = await create({
            title: 'Synthetic legacy correction',
            kind: 'once',
            runAt: new Date(clock.getTime() + 60_000).toISOString(),
          });
          await db.pool.query(
            'UPDATE schedules SET authority=NULL,authority_instruction=$2,authority_source_message_id=$3,authority_context=$4 WHERE id=$1',
            [
              incomplete.id,
              'Send the synthetic report every Friday.',
              source.sourceMessageId,
              JSON.stringify({ changes: ['Only summarize in Nod. Never send email.'] }),
            ],
          );
          await personal.initialize({ workers: false });
          const migrated = (
            await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [schedule.id])
          ).rows[0].authority;
          assert.equal(migrated.messages.length, 1);
          assert.equal(migrated.messages[0].id, source.sourceMessageId);
          assert.equal(new Date(migrated.messages[0].at).toISOString(), sourceTime);
          assert.equal(migrated.messages[0].text, 'Read the synthetic legacy board every Friday.');
          const run = (await turnOrigin(manual.json().turnId))?.scheduleInstruction;
          assert.equal(run?.messages[0]?.id, source.sourceMessageId);
          assert.equal(run?.messages[0]?.text, migrated.messages[0].text);
          assert.equal(new Date(run!.messages[0]!.at).toISOString(), sourceTime);
          const incompleteEvidence = async () =>
            (await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [incomplete.id]))
              .rows[0].authority;
          await assert.rejects(
            validateOwnerInstructions(db.pool, ownerId, await incompleteEvidence()),
            /changes without source records/,
          );
          const metadata = await request('PATCH', `/api/schedules/${incomplete.id}`, {
            title: 'Synthetic renamed legacy schedule',
          });
          assert.equal(metadata.statusCode, 200, metadata.body);
          await assert.rejects(
            validateOwnerInstructions(db.pool, ownerId, await incompleteEvidence()),
            /changes without source records/,
          );
          const replacement = await request('PATCH', `/api/schedules/${incomplete.id}`, {
            prompt: 'Read the synthetic report. Never send email.',
          });
          assert.equal(replacement.statusCode, 200, replacement.body);
          assert.equal((await runNow(await saved(incomplete.id))).statusCode, 200);
          await personal.initialize({ workers: false });
          assert.deepEqual(
            (await db.pool.query('SELECT authority FROM schedules WHERE id=$1', [schedule.id]))
              .rows[0].authority,
            migrated,
          );
        },
      );
      await t.test('scheduled cache retention follows the actual recurring cadence', async () => {
        const before = clock;
        try {
          clock = new Date('2035-10-26T12:00:00.000Z');
          for (const [cron, delay, expected] of [
            ['*/3 * * * *', 0, 'short'],
            ['*/15 * * * *', 20 * 60_000, 'long'],
            ['0 * * * *', 0, undefined],
          ] as const) {
            const schedule = await create({ cron });
            const job = await jobFor(schedule.id);
            clock = new Date(new Date(job.data.scheduledFor).getTime() + delay);
            await deliver([job]);
            const [run] = await runs(schedule.id);
            assert.equal(await personal.scheduleCache(run!.turnId), expected);
            assert.equal(
              (await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode,
              200,
            );
          }
          const once = await create({
            kind: 'once',
            runAt: new Date(clock.getTime() + 60_000).toISOString(),
          });
          const job = await jobFor(once.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          const [run] = await runs(once.id);
          assert.equal(await personal.scheduleCache(run!.turnId), undefined);
          assert.equal(await personal.scheduleCache(randomUUID()), undefined);
          assert.equal((await request('DELETE', `/api/schedules/${once.id}`)).statusCode, 200);
        } finally {
          clock = before;
        }
      });
    } finally {
      await channels?.close();
      await app.close();
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('scheduled controls reconcile pause and delete after a client timeout', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/',
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.method(AbortSignal, 'timeout', (duration: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
      duration / 50,
    );
    return controller.signal;
  });
  const schedule: Schedule = {
    id: randomUUID(),
    title: 'Delayed schedule',
    prompt: 'Synthetic reminder.',
    kind: 'recurring',
    cron: '0 9 * * *',
    runAt: null,
    timeZone: 'UTC',
    enabled: true,
    revision: 1,
    nextRun: null,
    lastRun: null,
    activeRun: null,
    baselineObservation: null,
    watch: null,
    model: null,
    monthlyUsd: null,
  };
  let current: Schedule | null = schedule;
  const mutations: string[] = [];
  const attempts: string[] = [];
  let mutationDelay = 650;
  let finishAfterAbort = false;
  let holdNextMutation = false;
  const heldMutations: Array<() => void> = [];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(String(path), `/api/schedules${options?.method ? `/${schedule.id}` : ''}`);
    if (!options?.method) {
      reads++;
      return Response.json(current ? [current] : []);
    }
    if (options.method === 'PATCH') {
      const body = JSON.parse(String(options.body));
      assert.deepEqual(
        body,
        'title' in body
          ? { title: 'My unsaved title', expectedRevision: 1 }
          : { enabled: false, expectedRevision: 1 },
      );
    } else assert.equal(options.method, 'DELETE');
    attempts.push(options.method);
    const signal = options.signal;
    const held = holdNextMutation;
    holdNextMutation = false;
    return new Promise<Response>((resolve, reject) => {
      const commit = () => {
        if (options.method === 'PATCH') {
          if (current?.revision !== 1) {
            resolve(Response.json({ error: 'Schedule changed.' }, { status: 409 }));
            return;
          }
          mutations.push(options.method);
          current = { ...schedule, enabled: false, revision: 2 };
          resolve(Response.json(current));
        } else {
          if (!current) {
            resolve(Response.json({ error: 'Schedule not found.' }, { status: 404 }));
            return;
          }
          mutations.push(options.method!);
          current = null;
          resolve(Response.json({ ok: true }));
        }
      };
      const timer = held ? undefined : setTimeout(commit, mutationDelay);
      if (held) heldMutations.push(commit);
      signal?.addEventListener(
        'abort',
        () => {
          if (!finishAfterAbort && timer) clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });
  const { act, createElement, Fragment } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { pageDataCache } = await import('../src/web/lib/page-data-cache.ts');
  const { PauseSwitch, PlanToast, ScheduleEditor, useDirectChange } =
    await import('../src/web/components/plan-controls.tsx');
  const { DeletePlan } = await import('../src/web/components/delete-plan.tsx');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pageDataCache.clear();
  pageDataCache.update('/api/schedules', () => [schedule]);
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    pageDataCache.clear();
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  function Controls() {
    const change = useDirectChange(schedule.id);
    return createElement(
      Fragment,
      null,
      createElement(PauseSwitch, { schedule, change }),
      createElement(ScheduleEditor, { schedule, change }),
    );
  }
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(PlanToast),
        createElement(Controls),
        createElement(DeletePlan, { id: schedule.id, title: schedule.title }),
      ),
    ),
  );
  const click = async (selector: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button);
    await act(async () => button.click());
  };
  const buttonByText = (label: string) =>
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  const clickButton = async (label: string) => {
    const button = buttonByText(label);
    assert.ok(button);
    await act(async () => button.click());
  };
  const release = async () => {
    const commit = heldMutations.shift();
    assert.ok(commit);
    await act(async () => commit());
  };
  const waitFor = async (ready: () => boolean, name: string, timeoutMs = 5000) => {
    for (let waited = 0; !ready(); waited += 50) {
      if (waited >= timeoutMs) assert.fail(`Timed out waiting for ${name}`);
      await act(async () => {
        t.mock.timers.tick(50);
        await new Promise((resolve) => setImmediate(resolve));
      });
    }
  };
  await click('[role="switch"]');
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    true,
  );
  await waitFor(
    () =>
      mutations.length === 1 &&
      dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled') === false,
    'initial pause',
  );
  assert.match(
    dom.window.document.querySelector('.plan-toast')?.textContent ?? '',
    /Paused Delayed schedule/,
  );
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    false,
  );
  await click('button[aria-label="Delete schedule Delayed schedule"]');
  await click('.delete-plan-actions button.button-destructive');
  assert.match(
    dom.window.document.querySelector('.delete-plan-dialog')?.textContent ?? '',
    /Deleting/,
  );
  await waitFor(
    () => dom.window.document.querySelector('.delete-plan-dialog') === null,
    'initial deletion',
  );
  assert.equal(dom.window.document.querySelector('.delete-plan-dialog'), null);
  assert.deepEqual(mutations, ['PATCH', 'DELETE']);
  current = schedule;
  mutationDelay = 1200;
  finishAfterAbort = true;
  const beforeReads = reads;
  await click('[role="switch"]');
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    true,
  );
  await waitFor(
    () =>
      current?.enabled === false &&
      reads > beforeReads &&
      dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled') === false,
    'pause after client timeout',
  );
  assert.equal(current.enabled, false);
  assert.match(
    dom.window.document.querySelector('.plan-toast')?.textContent ?? '',
    /Paused Delayed schedule/,
  );
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    false,
  );
  assert.ok(reads > beforeReads);
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH']);
  await click('button[aria-label="Delete schedule Delayed schedule"]');
  await click('.delete-plan-actions button.button-destructive');
  await waitFor(
    () => current === null && dom.window.document.querySelector('.delete-plan-dialog') === null,
    'deletion after client timeout',
  );
  assert.equal(dom.window.document.querySelector('.delete-plan-dialog'), null);
  assert.equal(current, null);
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE']);
  current = schedule;
  holdNextMutation = true;
  await click('button[aria-label="Delete schedule Delayed schedule"]');
  await click('.delete-plan-actions button.button-destructive');
  await waitFor(
    () =>
      dom.window.document
        .querySelector('.delete-plan-dialog')
        ?.textContent?.includes('The deletion may still finish.') === true,
    'unresolved deletion',
  );
  assert.match(
    dom.window.document.querySelector('.delete-plan-dialog')?.textContent ?? '',
    /deletion may still finish/i,
  );
  assert.equal(
    dom.window.document
      .querySelector('.delete-plan-actions button.button-destructive')
      ?.hasAttribute('disabled'),
    true,
  );
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE']);
  assert.equal(current, schedule);
  await release();
  await click('.delete-plan-actions button.button-outline');
  await waitFor(
    () => dom.window.document.querySelector('.delete-plan-dialog') === null,
    'confirmed late deletion',
  );
  assert.equal(dom.window.document.querySelector('.delete-plan-dialog'), null);
  assert.equal(current, null);
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE', 'DELETE']);
  current = schedule;
  holdNextMutation = true;
  await click('[role="switch"]');
  await waitFor(
    () =>
      dom.window.document
        .querySelector('.plan-toast')
        ?.textContent?.includes('may still finish') === true,
    'unresolved pause',
  );
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    true,
  );
  assert.equal(buttonByText('Try again'), undefined);
  assert.equal(current, schedule);
  assert.equal(attempts.filter((method) => method === 'PATCH').length, 3);
  await clickButton('Check status');
  await waitFor(() => Boolean(buttonByText('Try again')), 'qualified pause retry');
  assert.ok(dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
  mutationDelay = 650;
  await clickButton('Try again');
  await waitFor(
    () =>
      current?.enabled === false &&
      dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled') === false,
    'retried pause',
  );
  assert.equal(current.enabled, false);
  assert.equal(
    dom.window.document.querySelector('[role="switch"]')?.hasAttribute('disabled'),
    false,
  );
  await release();
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE', 'DELETE', 'PATCH']);
  assert.equal(attempts.filter((method) => method === 'PATCH').length, 4);
  current = schedule;
  holdNextMutation = true;
  await click('button[aria-label="Delete schedule Delayed schedule"]');
  await click('.delete-plan-actions button.button-destructive');
  await waitFor(
    () =>
      dom.window.document
        .querySelector('.delete-plan-dialog')
        ?.textContent?.includes('The deletion may still finish.') === true,
    'unresolved deletion before retry',
  );
  assert.equal(attempts.filter((method) => method === 'DELETE').length, 4);
  assert.equal(buttonByText('Try deleting again'), undefined);
  await clickButton('Check status');
  await waitFor(() => Boolean(buttonByText('Try deleting again')), 'qualified deletion retry');
  assert.equal(
    [...dom.window.document.querySelectorAll<HTMLButtonElement>('.delete-plan-actions button')]
      .find((button) => button.textContent?.trim() === 'Delete schedule')
      ?.hasAttribute('disabled'),
    true,
  );
  mutationDelay = 650;
  await clickButton('Try deleting again');
  await waitFor(
    () => current === null && dom.window.document.querySelector('.delete-plan-dialog') === null,
    'retried deletion',
  );
  assert.equal(current, null);
  assert.equal(dom.window.document.querySelector('.delete-plan-dialog'), null);
  await release();
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE', 'DELETE', 'PATCH', 'DELETE']);
  assert.equal(attempts.filter((method) => method === 'DELETE').length, 5);
  current = { ...schedule, title: 'Changed elsewhere', revision: 2 };
  mutationDelay = 0;
  await click('button[aria-label="Edit schedule Delayed schedule"]');
  const title = dom.window.document.querySelector<HTMLInputElement>('.schedule-editor-form input');
  assert.ok(title);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      title,
      'My unsaved title',
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(buttonByText('Save changes')?.hasAttribute('disabled'), false);
  await clickButton('Save changes');
  assert.equal(attempts.filter((method) => method === 'PATCH').length, 5);
  await waitFor(
    () =>
      dom.window.document
        .querySelector('.schedule-editor-dialog')
        ?.textContent?.includes('Schedule changed.') === true,
    'editor conflict',
  );
  assert.equal(title.value, 'My unsaved title');
  assert.ok(dom.window.document.querySelector('.schedule-editor-dialog'));
  assert.deepEqual(mutations, ['PATCH', 'DELETE', 'PATCH', 'DELETE', 'DELETE', 'PATCH', 'DELETE']);
});

test('waiting scheduled runs open their pending question without starting another run (LAB-1215)', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/tasks',
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { pageDataCache } = await import('../src/web/lib/page-data-cache.ts');
  const { Scheduled } = await import('../src/web/pages/tasks.tsx');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    pageDataCache.clear();
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  pageDataCache.clear();
  const completed: ScheduleRun = {
    id: randomUUID(),
    scheduleId: randomUUID(),
    title: 'Synthetic account report',
    turnId: randomUUID(),
    scheduledFor: '2035-10-25T09:00:00.000Z',
    timeZone: 'UTC',
    createdAt: '2035-10-25T09:00:00.000Z',
    status: 'succeeded',
    error: null,
    observation: null,
    messageId: randomUUID(),
    messagePreview: 'Synthetic report ready.',
    messageText: 'Synthetic report ready.',
  };
  const queued: ScheduleRun = {
    ...completed,
    id: randomUUID(),
    turnId: randomUUID(),
    scheduledFor: '2035-10-26T09:00:00.000Z',
    createdAt: '2035-10-26T09:00:00.000Z',
    status: 'queued',
    messageId: null,
    messagePreview: null,
    messageText: null,
  };
  let schedule: Schedule = {
    id: completed.scheduleId,
    title: completed.title,
    prompt: 'Read the report at https://reports.example.test and summarize it in Nod.',
    kind: 'recurring',
    cron: '0 9 * * *',
    runAt: null,
    timeZone: 'UTC',
    enabled: true,
    revision: 1,
    nextRun: '2035-10-27T09:00:00.000Z',
    lastRun: completed,
    activeRun: null,
    baselineObservation: null,
    watch: null,
    monthlyUsd: null,
    model: null,
  };
  const historyPath = `/api/schedule-runs?scheduleId=${schedule.id}&limit=10`;
  let history: ScheduleHistory = { runs: [completed], nextCursor: null };
  const mutations: string[] = [];
  let releaseStop = () => {};
  let stopWait: Promise<void> | undefined;
  let stopFailure = false;
  let releaseSchedules = () => {};
  let scheduleWait: Promise<void> | undefined;
  let oneTime: Schedule | undefined;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input);
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      mutations.push(`${method} ${path}`);
      assert.equal(method, 'POST');
      if (path.endsWith('/stop')) {
        if (stopFailure) throw new TypeError('Synthetic stop response lost.');
        await stopWait;
        return Response.json({ ok: true });
      }
      assert.equal(path, `/api/schedules/${schedule.id}/run`);
      schedule = {
        ...schedule,
        lastRun: queued,
        activeRun: { turnId: queued.turnId, status: 'queued', questionMessageId: null },
      };
      history = { runs: [queued, completed], nextCursor: null };
      return Response.json({ turnId: queued.turnId, activeRun: schedule.activeRun });
    }
    if (path === '/api/schedules') {
      const response = oneTime ? [schedule, oneTime] : [schedule];
      await scheduleWait;
      return Response.json(response);
    }
    if (path === '/api/tasks') return Response.json([]);
    assert.equal(path, historyPath);
    return Response.json(history);
  });
  const asked: string[] = [];
  const focused: unknown[] = [];
  dom.window.addEventListener('nod:focus-message', (event) =>
    focused.push((event as CustomEvent).detail),
  );
  await act(async () =>
    root.render(createElement(Scheduled, { onAsk: (text) => asked.push(text) })),
  );
  const runNow = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Run now for ${schedule.title}"]`,
  );
  assert.ok(runNow);
  await act(async () => runNow.click());
  const expectedMutations = [`POST /api/schedules/${schedule.id}/run`];
  assert.deepEqual(mutations, expectedMutations);

  const questionId = randomUUID();
  const question = 'May I use your saved login for reports.example.test for this report?';
  const waiting: ScheduleRun = {
    ...queued,
    status: 'waiting',
    messageId: questionId,
    messagePreview: question,
    messageText: question,
  };
  schedule = {
    ...schedule,
    lastRun: waiting,
    activeRun: { turnId: waiting.turnId, status: 'waiting', questionMessageId: questionId },
  };
  history = { runs: [waiting, completed], nextCursor: null };
  await act(async () => {
    await pageDataCache.refresh('/api/schedules', true);
    await pageDataCache.refresh(historyPath, true);
  });
  const needsInput = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Needs your input for ${schedule.title}"]`,
  );
  assert.ok(needsInput);
  await act(async () => needsInput.click());
  assert.deepEqual(
    mutations,
    expectedMutations,
    'Opening the question must not start another run.',
  );
  assert.deepEqual(asked, [], 'Opening the question must not post a new chat request.');
  assert.deepEqual(
    focused,
    [{ messageId: questionId }],
    'Needs your input must open the waiting run’s existing question in Chat.',
  );

  const resumedQuestionId = randomUUID();
  schedule = {
    ...schedule,
    activeRun: { turnId: randomUUID(), status: 'waiting', questionMessageId: resumedQuestionId },
  };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  const resumedInput = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Needs your input for ${schedule.title}"]`,
  );
  assert.ok(resumedInput);
  await act(async () => resumedInput.click());
  assert.deepEqual(focused, [{ messageId: questionId }, { messageId: resumedQuestionId }]);

  for (const status of ['queued', 'running', 'waiting'] as const) {
    schedule = {
      ...schedule,
      activeRun: { turnId: schedule.activeRun!.turnId, status, questionMessageId: null },
    };
    await act(async () => pageDataCache.refresh('/api/schedules', true));
    const button = dom.window.document.querySelector<HTMLButtonElement>(
      `button[aria-label$=" for ${schedule.title}"][aria-live="polite"]`,
    );
    assert.ok(button);
    assert.equal(button.disabled, true);
    await act(async () => button.click());
  }
  assert.deepEqual(mutations, expectedMutations);
  assert.deepEqual(asked, []);
  assert.deepEqual(focused, [{ messageId: questionId }, { messageId: resumedQuestionId }]);

  const confirmedTurnId = schedule.activeRun!.turnId;
  stopWait = new Promise<void>((resolve) => (releaseStop = resolve));
  scheduleWait = new Promise<void>((resolve) => (releaseSchedules = resolve));
  let staleRefresh: Promise<void>;
  await act(async () => {
    staleRefresh = pageDataCache.refresh('/api/schedules', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const confirmedStop = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Stop this run for ${schedule.title}"]`,
  );
  assert.ok(confirmedStop);
  await act(async () => confirmedStop.click());
  schedule = { ...schedule, activeRun: null };
  await act(async () => {
    releaseStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(
    Boolean(
      dom.window.document.querySelector(`button[aria-label="Stop this run for ${schedule.title}"]`),
    ),
    false,
  );
  assert.equal(pageDataCache.getSnapshot<Schedule[]>('/api/schedules').data?.[0].activeRun, null);
  let replacementRefresh: Promise<void>;
  await act(async () => {
    replacementRefresh = pageDataCache.refresh('/api/schedules', true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(
    Boolean(
      dom.window.document.querySelector(`button[aria-label="Stop this run for ${schedule.title}"]`),
    ),
    false,
  );
  await act(async () => {
    releaseSchedules();
    await Promise.all([staleRefresh!, replacementRefresh!]);
  });
  assert.equal(pageDataCache.getSnapshot<Schedule[]>('/api/schedules').data?.[0].activeRun, null);
  expectedMutations.push(`POST /api/schedules/${schedule.id}/runs/${confirmedTurnId}/stop`);
  assert.deepEqual(mutations, expectedMutations);
  schedule = {
    ...schedule,
    activeRun: { turnId: randomUUID(), status: 'running', questionMessageId: null },
  };
  await act(async () => pageDataCache.refresh('/api/schedules', true));

  const stoppedTurnId = schedule.activeRun!.turnId;
  stopWait = new Promise<void>((resolve) => (releaseStop = resolve));
  const stopButton = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Stop this run for ${schedule.title}"]`,
  );
  assert.ok(stopButton);
  await act(async () => stopButton.click());
  const stopMutation = `POST /api/schedules/${schedule.id}/runs/${stoppedTurnId}/stop`;
  assert.deepEqual(mutations, [...expectedMutations, stopMutation]);
  assert.equal(stopButton.disabled, true);
  const nextTurnId = randomUUID();
  schedule = {
    ...schedule,
    activeRun: { turnId: nextTurnId, status: 'queued', questionMessageId: null },
  };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  await act(async () => stopButton.click());
  assert.deepEqual(mutations, [...expectedMutations, stopMutation]);
  scheduleWait = new Promise<void>((resolve) => (releaseSchedules = resolve));
  await act(async () => {
    releaseStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(stopButton.disabled, false);
  assert.deepEqual(mutations, [...expectedMutations, stopMutation]);
  await act(async () => {
    releaseSchedules();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(
    pageDataCache.getSnapshot<Schedule[]>('/api/schedules').data?.[0].activeRun?.turnId,
    nextTurnId,
  );
  assert.equal(schedule.activeRun?.turnId, nextTurnId);
  assert.equal(schedule.enabled, true);
  stopFailure = true;
  const currentStop = dom.window.document.querySelector<HTMLButtonElement>(
    `button[aria-label="Stop this run for ${schedule.title}"]`,
  );
  assert.ok(currentStop);
  assert.equal(currentStop.disabled, false);
  await act(async () => {
    currentStop.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(
    dom.window.document.body.textContent ?? '',
    /Could not confirm that this run stopped/,
  );
  assert.equal(schedule.enabled, true);
  assert.equal(mutations.length, expectedMutations.length + 2);
  assert.equal(mutations.at(-1), `POST /api/schedules/${schedule.id}/runs/${nextTurnId}/stop`);
  schedule = { ...schedule, activeRun: null };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  assert.equal(
    Boolean(
      dom.window.document.querySelector(`button[aria-label="Stop this run for ${schedule.title}"]`),
    ),
    false,
  );

  oneTime = {
    ...schedule,
    id: randomUUID(),
    title: 'Synthetic one-time review',
    kind: 'once',
    cron: null,
    runAt: schedule.nextRun,
    lastRun: null,
  };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  assert.equal(dom.window.document.querySelector('details.schedule-inactive'), null);
  oneTime = {
    ...oneTime,
    enabled: false,
    nextRun: null,
    activeRun: { turnId: randomUUID(), status: 'running', questionMessageId: null },
  };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  const inactive = dom.window.document.querySelector<HTMLDetailsElement>(
    'details.schedule-inactive',
  );
  assert.ok(inactive?.open, 'A one-time run stays visible when it moves into Inactive.');
  oneTime = { ...oneTime, activeRun: null };
  await act(async () => pageDataCache.refresh('/api/schedules', true));
  assert.equal(inactive.open, true);
});
