import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
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
    const watched = new Map<string, string>();
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: thread.boss,
      now: () => clock,
      watchable: async (ids) => ids.every((id) => watched.has(id)),
      watchState: async (ids) =>
        ids.every((id) => watched.has(id)) ? ids.map((id) => watched.get(id)).join() : null,
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
      const response = await request('GET', '/api/schedule-runs?limit=100');
      assert.equal(response.statusCode, 200, response.body);
      return response.json<ScheduleHistory>().runs.filter((run) => run.scheduleId === id);
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
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      t.mock.method(thread.boss, 'work', async (_name: string, handler: unknown) => {
        deliver = handler as typeof deliver;
        return randomUUID();
      });
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
        'a recurring schedule starts no run while its last run is busy or waiting on the owner',
        async () => {
          const before = clock;
          const schedule = await create({ cron: '*/15 * * * *' });
          const fire = async () => {
            const job = await jobFor(schedule.id);
            clock = new Date(job.data.scheduledFor);
            await deliver([job]);
            return (await runs(schedule.id)).map((run) => run.turnId);
          };
          const [first] = await fire();
          assert.deepEqual(await fire(), [first]);
          for (const status of ['running', 'waiting']) {
            await db.pool.query('UPDATE turns SET status=$2,started_at=now() WHERE id=$1', [
              first,
              status,
            ]);
            assert.deepEqual(await fire(), [first]);
          }
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,prompt,session_id,parent_turn_id,background,status,started_at)
             SELECT $1,owner_id,thread_id,'resume','Synthetic answer.',id,id,true,'succeeded',now() FROM turns WHERE id=$2`,
            [randomUUID(), first],
          );
          assert.equal((await fire()).length, 2);
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=ANY($1::uuid[])", [
            (await runs(schedule.id)).map((run) => run.turnId),
          ]);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          clock = before;
        },
      );
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
          await finish('failed');
          assert.equal((await fire()).length, 2);
          await finish();
          assert.equal((await fire()).length, 2);
          watched.set(account, 'v2');
          assert.equal((await fire()).length, 3);
          await finish();
          await personal.manage('schedule_update', { id: schedule.id, watch: null });
          assert.equal((await fire()).length, 4);
          await finish();
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
          assert.equal((await runs(schedule.id)).length, 1);
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
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (duration: number) => nativeTimeout(duration / 50));
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
    baselineObservation: null,
    watch: null,
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
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${name}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
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
