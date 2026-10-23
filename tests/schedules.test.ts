import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import type { Schedule, ScheduleHistory, TaskDetail } from '../src/shared/contracts.ts';
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
    const { createTasks } = await import('../src/server/tasks.ts');
    const thread = await import('../src/server/thread.ts');
    const { createChannels } = await import('../src/server/channels.ts');
    const ownerId = 'local-development';
    let clock = new Date('2035-10-26T12:00:00.000Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    let failAfterTask = false;
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: thread.boss,
      now: () => clock,
      enqueueTurn: async (...args) => {
        assert.ok(args[1]?.client);
        const id = await thread.enqueueTurn(...args);
        if (failAfterTask) throw new Error('Synthetic failure after turn creation.');
        return id;
      },
      refresh() {},
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
      const response = await request('GET', `/api/schedules/${id}/runs`);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ScheduleHistory>().runs;
    };
    const saved = async (id: string) =>
      (await personal.listSchedules()).find((schedule) => schedule.id === id)!;
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
    const createRouted = (
      provenance?: { turnId: string; sourceMessageId: string | null },
      timing: Record<string, unknown> = {},
    ) =>
      personal.manage(
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
    const routedRuns = async (id: string) =>
      (
        await db.pool.query(
          `SELECT r.turn_id,u.channel,u.source,u.background FROM schedule_runs r
           JOIN turns u ON u.id=r.turn_id
           WHERE r.schedule_id=$1 ORDER BY r.created_at,r.id`,
          [id],
        )
      ).rows;
    const reply = async (turnId: string, text: string) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,turn_id,thread_id) SELECT $1,$2,'assistant',$3,id,thread_id FROM turns WHERE id=$4",
        [id, ownerId, text, turnId],
      );
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [turnId]);
      await channels!.drain();
      return id;
    };
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      const workerMock = t.mock.method(
        thread.boss,
        'work',
        async (_name: string, handler: unknown) => {
          deliver = handler as typeof deliver;
          return randomUUID();
        },
      );
      await personal.initialize();
      await tasks.initialize();

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
          'Use the EUR account, include overdue items, and keep the result in nod.';
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
          'Ignore my previous instructions about sending messages; only prepare the summary in nod.',
          'Find https://reports.example.test/people/alice@example.test and keep the result here.',
        ];
        const credentialLinks = await seed([
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
        await t.test(
          'credential URLs are omitted without dropping ordinary links or owner corrections',
          async () => {
            const response = await draft(credentialLinks);
            assert.equal(response.statusCode, 200, response.body);
            assert.deepEqual(response.json(), {
              title: 'Synthetic account report',
              prompt: reusable.join('\n\n'),
              omittedSensitive: true,
              hasAttachments: false,
            });
            assert.deepEqual(await unchanged(), before);
          },
        );
        await t.test(
          'only an explicit create schedules the reviewed instructions without rerunning the task',
          async () => {
            const prompt =
              'Read only overdue invoices in the synthetic EUR account and summarize them in nod.';
            const schedule = await create({ prompt, cron: '20 14 * * 2' });
            assert.equal(
              (
                await db.pool.query('SELECT authority_instruction FROM schedules WHERE id=$1', [
                  schedule.id,
                ])
              ).rows[0].authority_instruction,
              prompt,
            );
            assert.deepEqual((await unchanged()).turns, before.turns);
            await request('DELETE', `/api/schedules/${schedule.id}`);
          },
        );
      });

      await t.test(
        'schedule editor changes retain the intended recurrence and exact run time',
        async () => {
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
        'one-off firing is single-use under concurrent redelivery and restart',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-10-27T09:05:00+01:00' });
          assert.equal(schedule.kind, 'once');
          assert.equal(schedule.cron, null);
          assert.equal(schedule.runAt, '2035-10-27T08:05:00.000Z');
          assert.equal(schedule.nextRun, schedule.runAt);
          assert.equal(schedule.lastRun, null);
          const job = await jobFor(schedule.id);
          assert.equal(job.startAfter.toISOString(), schedule.runAt);
          clock = new Date(schedule.runAt!);
          await Promise.all([deliver([job]), deliver([job])]);
          const history = await runs(schedule.id);
          assert.equal(history.length, 1);
          assert.equal(history[0]!.scheduledFor, schedule.runAt);
          assert.equal(history[0]!.timeZone, 'Europe/Lisbon');
          assert.equal(history[0]!.status, 'queued');
          assert.equal((await saved(schedule.id)).enabled, false);
          assert.equal((await saved(schedule.id)).nextRun, null);
          assert.equal((await saved(schedule.id)).lastRun?.id, history[0]!.id);
          await personal.initialize({ workers: false });
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
          assert.equal(
            (await db.pool.query('SELECT * FROM turns WHERE id=$1', [history[0]!.turnId])).rows[0]
              .source,
            'schedule',
          );
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true })).statusCode,
            400,
          );
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
            history[0]!.turnId,
          ]);
          assert.equal((await runs(schedule.id))[0]!.status, 'succeeded');
        },
      );
      await t.test(
        'recurring work preserves Lisbon wall time across DST and skips a catch-up flood',
        async () => {
          clock = new Date('2035-10-26T12:00:00.000Z');
          const schedule = await create({ cron: '5 9 * * *' });
          assert.equal(schedule.kind, 'recurring');
          assert.equal(schedule.nextRun, '2035-10-27T08:05:00.000Z');
          let job = await jobFor(schedule.id);
          clock = new Date(schedule.nextRun!);
          await deliver([job]);
          assert.equal((await saved(schedule.id)).nextRun, '2035-10-28T09:05:00.000Z');
          job = await jobFor(schedule.id);
          clock = new Date('2035-11-02T12:00:00.000Z');
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 2);
          assert.equal((await runs(schedule.id))[0]!.scheduledFor, '2035-10-28T09:05:00.000Z');
          assert.equal((await saved(schedule.id)).nextRun, '2035-11-03T09:05:00.000Z');
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
      await t.test('a recurring schedule shows what its finished runs cost a month', async () => {
        const { createLedger } = await import('../src/server/ledger.ts');
        const ledger = createLedger({ pool: db.pool, ownerId });
        await ledger.initialize();
        const priced = createPersonalService({
          pool: db.pool,
          ownerId,
          scheduler: thread.boss,
          now: () => clock,
          enqueueTurn: thread.enqueueTurn,
          refresh() {},
          sessionCosts: ledger.sessionCosts,
        });
        clock = new Date('2035-10-26T12:00:00.000Z');
        const schedule = await create({ cron: '5 9 * * *' });
        const monthly = async () =>
          (await priced.listSchedules()).find((item) => item.id === schedule.id)!.monthlyUsd;
        assert.equal(await monthly(), null);
        let job = await jobFor(schedule.id);
        clock = new Date(schedule.nextRun!);
        await deliver([job]);
        job = await jobFor(schedule.id);
        clock = new Date('2035-10-28T09:05:00.000Z');
        await deliver([job]);
        const turns = (await runs(schedule.id)).map((run) => run.turnId);
        assert.equal(turns.length, 2);
        for (const [index, turnId] of turns.entries())
          await db.pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,$4)',
            [randomUUID(), ownerId, turnId, index ? 0.3 : 0.1],
          );
        assert.equal(await monthly(), null);
        await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=ANY($1::uuid[])", [
          turns,
        ]);
        assert.equal(Math.round((await monthly())! * 100) / 100, 6);
        await db.pool.query(
          'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd) VALUES($1,$2,$3,NULL)',
          [randomUUID(), ownerId, turns[0]],
        );
        assert.equal(Math.round((await monthly())! * 100) / 100, 9);
        assert.equal(
          (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })).statusCode,
          200,
        );
        assert.equal(await monthly(), null);
      });
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
      await t.test('edits, pauses and deletions fence already claimed jobs', async () => {
        const schedule = await create({ kind: 'once', runAt: '2035-11-03T14:30:00Z' });
        const stale = await jobFor(schedule.id);
        const update = await request('PATCH', `/api/schedules/${schedule.id}`, {
          runAt: '2035-11-04T14:30:00Z',
          title: 'Updated fixture',
        });
        assert.equal(update.statusCode, 200, update.body);
        assert.equal(update.json<Schedule>().kind, 'once');
        assert.equal(update.json<Schedule>().revision, schedule.revision + 1);
        await deliver([stale]);
        assert.deepEqual(await runs(schedule.id), []);
        const pausedJob = await jobFor(schedule.id);
        assert.equal(
          (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })).statusCode,
          200,
        );
        await deliver([pausedJob]);
        assert.deepEqual(await runs(schedule.id), []);
        assert.equal((await saved(schedule.id)).nextRun, null);
        await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true });
        const deletedJob = await jobFor(schedule.id);
        await request('DELETE', `/api/schedules/${schedule.id}`);
        await deliver([deletedJob]);
        assert.equal((await request('GET', `/api/schedules/${schedule.id}/runs`)).statusCode, 404);
      });
      await t.test(
        'turn creation, run history and next occurrence roll back together',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-05T10:00:00Z' });
          const job = await jobFor(schedule.id);
          const before = (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0]
            .count;
          failAfterTask = true;
          await assert.rejects(deliver([job]), /Synthetic failure/);
          failAfterTask = false;
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
            before,
          );
          assert.deepEqual(await runs(schedule.id), []);
          assert.equal((await jobFor(schedule.id)).id, job.id);
          await deliver([job]);
          assert.equal((await runs(schedule.id)).length, 1);
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
          assert.equal((await runs(schedule.id)).length, 1);
        },
      );
      await t.test(
        'owned history survives deletion, reflects failures and hides foreign runs',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-08T10:00:00Z' });
          await deliver([await jobFor(schedule.id)]);
          const run = (await runs(schedule.id))[0]!;
          await db.pool.query(
            "UPDATE turns SET status='failed',error='Synthetic fixed error.' WHERE id=$1",
            [run.turnId],
          );
          await request('DELETE', `/api/schedules/${schedule.id}`);
          const retained = (await runs(schedule.id))[0]!;
          assert.equal(retained.title, 'Fixture schedule');
          assert.equal(retained.status, 'failed');
          assert.equal(retained.error, 'Synthetic fixed error.');
          const foreign = randomUUID();
          await db.pool.query('UPDATE schedule_runs SET owner_id=$2 WHERE id=$1', [
            run.id,
            'foreign-owner',
          ]);
          assert.equal(
            (await request('GET', `/api/schedules/${schedule.id}/runs`)).statusCode,
            404,
          );
          assert.equal((await request('GET', `/api/schedules/${foreign}/runs`)).statusCode, 404);
          assert.equal(
            (await request('GET', '/api/schedule-runs'))
              .json<ScheduleHistory>()
              .runs.some((entry) => entry.id === run.id),
            false,
          );
        },
      );
      channels = await connect();
      const origin = await receive('Remind me in a minute.');

      await t.test(
        'one-off replay sends one reminder to the original verified thread',
        async () => {
          const schedule = await createRouted(origin);
          await receive('A later unrelated fixture message.', 'later-thread');
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await Promise.all([deliver([job]), deliver([job])]);
          const dispatched = await routedRuns(schedule.id);
          assert.equal(dispatched.length, 1);
          assert.equal(dispatched[0].channel, origin.channel);
          assert.equal(dispatched[0].source, 'schedule');
          assert.equal(dispatched[0].background, true);
          await reply(dispatched[0].turn_id, 'One-off fixture reminder.');
          await channels!.drain();
          assert.deepEqual(sent, [
            {
              channelId: 'telegram',
              accountId: 'fixture-bot',
              threadId: 'original-thread',
              text: 'One-off fixture reminder.',
            },
          ]);
          await deliver([job]);
          assert.equal((await routedRuns(schedule.id)).length, 1);
        },
      );
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
              'SELECT delivery_channel,channel_source_id,authority_instruction,authority_source_message_id FROM schedules WHERE id=$1',
              [schedule.id],
            )
          ).rows[0];
          assert.deepEqual(stored, {
            delivery_channel: origin.channel,
            channel_source_id: origin.sourceId,
            authority_instruction: 'Remind me in a minute.',
            authority_source_message_id: origin.sourceMessageId,
          });
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
        'a schedule started from a tapped first-task card gets no instruction authority',
        async () => {
          const title = 'Check in with me every Friday';
          const tapped = await receive(title);
          const offer = randomUUID();
          await db.pool.query(
            `INSERT INTO messages(id,owner_id,role,text,thread_id,suggestions,created_at)
             SELECT $1,owner_id,'assistant','Synthetic first tasks',thread_id,$2,created_at-interval '1 second'
             FROM messages WHERE id=$3`,
            [
              offer,
              JSON.stringify({
                intro: 'Synthetic intro',
                tasks: [{ id: randomUUID(), title, source: 'web', kind: 'ongoing' }],
              }),
              tapped.sourceMessageId,
            ],
          );
          const authority = async (id: string) =>
            (
              await db.pool.query(
                'SELECT authority_instruction,authority_source_message_id FROM schedules WHERE id=$1',
                [id],
              )
            ).rows[0];
          const fromCard = await createRouted(tapped);
          assert.deepEqual(await authority(fromCard.id), {
            authority_instruction: null,
            authority_source_message_id: tapped.sourceMessageId,
          });
          const typed = await receive(`${title} at nine`);
          const fromOwner = await createRouted(typed);
          assert.deepEqual(await authority(fromOwner.id), {
            authority_instruction: `${title} at nine`,
            authority_source_message_id: typed.sourceMessageId,
          });
          for (const schedule of [fromCard, fromOwner])
            await personal.manage('schedule_cancel', { id: schedule.id });
          await db.pool.query('DELETE FROM messages WHERE id=$1', [offer]);
        },
      );
      await t.test(
        'a real timed occurrence reaches the original Telegram fixture once',
        async () => {
          workerMock.mock.restore();
          const live = createPersonalService({
            pool: db.pool,
            ownerId,
            scheduler: thread.boss,
            enqueueTurn: thread.enqueueTurn,
            refresh() {},
          });
          await live.initialize();
          const runAt = new Date(Date.now() + 750).toISOString();
          const schedule = (await live.manage(
            'schedule_create',
            {
              title: 'Timed Telegram fixture',
              prompt: 'Send the synthetic reminder.',
              kind: 'once',
              runAt,
              timeZone: 'Europe/Lisbon',
            },
            origin,
          )) as Schedule;
          let dispatched = await routedRuns(schedule.id);
          for (let attempt = 0; !dispatched.length && attempt < 300; attempt++) {
            await delay(20);
            dispatched = await routedRuns(schedule.id);
          }
          assert.equal(dispatched.length, 1);
          const due = (
            await db.pool.query(
              'SELECT scheduled_for,created_at FROM schedule_runs WHERE schedule_id=$1',
              [schedule.id],
            )
          ).rows[0];
          assert.equal(due.scheduled_for.toISOString(), runAt);
          assert.ok(due.created_at.getTime() >= new Date(runAt).getTime());
          const before = sent.length;
          await reply(dispatched[0].turn_id, 'Real-timer fixture reminder.');
          await channels!.drain();
          assert.equal(sent.length, before + 1);
          assert.equal(sent.at(-1)!.threadId, 'original-thread');
          await thread.boss.offWork('scheduled-task', { wait: true });
        },
      );
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
