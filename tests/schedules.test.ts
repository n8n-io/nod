import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import type { Schedule, ScheduleHistory } from '../src/shared/contracts.ts';

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
    const turnRef = async (turnId: string) => ({
      turnId,
      threadId: (await db.pool.query('SELECT thread_id FROM turns WHERE id=$1', [turnId])).rows[0]
        .thread_id as string,
    });
    const saved = async (id: string) =>
      (await personal.listSchedules()).find((schedule) => schedule.id === id)!;
    const inbox: InboundMessage[] = [];
    const sent: Array<Parameters<MessagingTransport['post']>[0]> = [];
    let uncertain = false;
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
        if (uncertain) throw new Error('Synthetic transport failure after acceptance.');
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

      await t.test(
        'due runs execute only their immutable owned scheduled instruction',
        async () => {
          const { createApprovals } = await import('../src/server/approvals.ts');
          const executed: unknown[] = [];
          const approvals = await createApprovals(async (action, args, context) => {
            executed.push({ action, args, context });
            return { sent: true };
          });
          const schedule = await create({
            kind: 'once',
            runAt: '2035-10-27T09:05:00+01:00',
            prompt: 'Send an email to Alex with the weekly update.',
          });
          await deliver([await jobFor(schedule.id)]);
          const run = (await runs(schedule.id))[0]!;
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [run.turnId]);
          assert.deepEqual(
            await approvals.request(await turnRef(run.turnId), 'GMAIL_SEND_EMAIL', {
              to: 'alex@example.test',
              body: 'Synthetic fixture',
            }),
            { sent: true },
          );
          await approvals.request(await turnRef(run.turnId), 'GMAIL_SEND_EMAIL', {
            to: 'alex@example.test',
            body: 'Synthetic fixture',
          });
          assert.equal(executed.length, 1);
          assert.equal(
            (
              await approvals.request(await turnRef(run.turnId), 'SLACK_SEND_MESSAGE', {
                text: 'No authority',
              })
            ).requiresConfirmation,
            true,
          );
          assert.equal(
            (
              await approvals.request(await turnRef(run.turnId), 'GMAIL_DELETE_MESSAGE', {
                message_id: 'fixture',
              })
            ).requiresConfirmation,
            true,
          );
          assert.equal(executed.length, 1);
          const edited = await create({ cron: '5 9 * * *', prompt: 'Send an email to Alex.' });
          const source = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text) VALUES($1,'local-development','user','Change it to draft an email to Alex and keep it unsent.')",
            [source],
          );
          await personal.manage(
            'schedule_update',
            { id: edited.id, prompt: 'Draft an email to Alex and keep it unsent.' },
            { sourceMessageId: source },
          );
          await deliver([await jobFor(edited.id)]);
          const draft = (await runs(edited.id))[0]!;
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [draft.turnId]);
          await assert.rejects(
            approvals.request(await turnRef(draft.turnId), 'GMAIL_SEND_EMAIL', {
              to: 'alex@example.test',
            }),
          );
          assert.equal(executed.length, 1);
          const generic = await thread.enqueueTurn('Send an email to Alex.', {
            source: 'event',
            sourceId: 'synthetic-event',
          });
          await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [generic]);
          await assert.rejects(
            approvals.request(await turnRef(generic), 'GMAIL_SEND_EMAIL', {
              to: 'alex@example.test',
            }),
          );
          assert.equal(executed.length, 1);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          await request('DELETE', `/api/schedules/${edited.id}`);
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
      await t.test('invalid or ambiguous timing cannot create jobs', async () => {
        const before = (await personal.listSchedules()).length;
        for (const timing of [
          { kind: 'once', runAt: '2035-11-08T10:00:00' },
          { kind: 'once', runAt: '2035-11-01T10:00:00Z' },
          { kind: 'once', runAt: '2035-11-08T10:00:00Z', cron: '0 9 * * *' },
          { kind: 'recurring', runAt: '2035-11-08T10:00:00Z', cron: '0 9 * * *' },
          { kind: 'recurring', cron: '* * * * * *' },
          { kind: 'recurring', cron: '0 9 * * *', timeZone: 'Unknown/Zone' },
        ]) {
          const response = await request('POST', '/api/schedules', {
            title: 'Invalid fixture',
            prompt: 'Synthetic only',
            timeZone: 'Europe/Lisbon',
            ...timing,
          });
          assert.equal(response.statusCode, 400, response.body);
        }
        assert.equal((await personal.listSchedules()).length, before);
      });

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
        'recurrence, rescheduling and pause preserve the route and fence old jobs',
        async () => {
          const schedule = await createRouted(origin, {
            kind: 'recurring',
            cron: '* * * * *',
            runAt: null,
          });
          const stale = await jobFor(schedule.id);
          await personal.manage('schedule_update', { id: schedule.id, cron: '*/2 * * * *' });
          await deliver([stale]);
          assert.equal((await routedRuns(schedule.id)).length, 0);
          const first = await jobFor(schedule.id);
          clock = new Date(first.data.scheduledFor);
          await deliver([first]);
          const firstRun = (await routedRuns(schedule.id))[0];
          await reply(firstRun.turn_id, 'Recurring fixture one.');
          await personal.manage('schedule_update', { id: schedule.id, title: 'Renamed reminder' });
          const second = await jobFor(schedule.id);
          clock = new Date(second.data.scheduledFor);
          await deliver([second]);
          const executions = await routedRuns(schedule.id);
          const secondRun = executions.find((run) => run.turn_id !== firstRun.turn_id)!;
          await reply(secondRun.turn_id, 'Recurring fixture two.');
          assert.equal(executions.length, 2);
          assert.ok(executions.every((run) => run.channel === origin.channel));
          const third = await jobFor(schedule.id);
          const before = sent.length;
          await personal.manage('schedule_cancel', { id: schedule.id });
          clock = new Date(third.data.scheduledFor);
          await deliver([third]);
          await channels!.drain();
          assert.equal((await routedRuns(schedule.id)).length, 2);
          assert.equal(sent.length, before);
        },
      );
      await t.test(
        'model route arguments and unverified message provenance are rejected',
        async () => {
          await assert.rejects(
            createRouted(origin, { channel: 'telegram:arbitrary', threadId: 'other' }),
          );
          const schedule = await createRouted(origin);
          await assert.rejects(
            personal.manage('schedule_update', { id: schedule.id, deliveryChannel: 'web' }),
          );
          await assert.rejects(
            createRouted({ ...origin, sourceMessageId: randomUUID() }),
            /unavailable/,
          );
          await assert.rejects(
            createRouted({ turnId: randomUUID(), sourceMessageId: null }),
            /unavailable/,
          );
          await assert.rejects(
            createRouted({ turnId: origin.turnId, sourceMessageId: null }),
            /unavailable/,
          );
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
        'an uncertain scheduled send remains single-attempt across restart',
        async () => {
          const schedule = await createRouted(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          uncertain = true;
          const before = sent.length;
          const messageId = await reply(
            (await routedRuns(schedule.id))[0].turn_id,
            'Uncertain fixture.',
          );
          assert.equal(sent.length, before + 1);
          assert.equal(
            (
              await db.pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                messageId,
              ])
            ).rows[0].state,
            'uncertain',
          );
          uncertain = false;
          await channels!.close();
          channels = await connect();
          await channels.drain();
          await deliver([job]);
          await channels.drain();
          assert.equal(sent.length, before + 1);
        },
      );
      await t.test(
        'revoked channel access blocks a due reminder without rerouting or retry',
        async () => {
          const schedule = await createRouted(origin);
          const job = await jobFor(schedule.id);
          clock = new Date(job.data.scheduledFor);
          await deliver([job]);
          await channels!.replaceTransport({
            ...transport,
            channels: [{ ...transport.channels[0]!, allowedSenderIds: [] }],
          });
          const before = sent.length;
          const messageId = await reply(
            (await routedRuns(schedule.id))[0].turn_id,
            'Revoked fixture.',
          );
          const state = (
            await db.pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              messageId,
            ])
          ).rows[0];
          assert.deepEqual(state, { state: 'blocked', reason: 'channel_access_changed' });
          await channels!.replaceTransport(transport);
          await channels!.drain();
          assert.equal(sent.length, before);
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
      await t.test('scheduled replies cannot extend a provider reply window', async () => {
        const schedule = await createRouted(origin);
        const job = await jobFor(schedule.id);
        clock = new Date(job.data.scheduledFor);
        await deliver([job]);
        await db.pool.query("UPDATE channel_inbox SET received_at=now()-interval '2 days'");
        await channels!.replaceTransport({
          ...transport,
          channels: [{ ...transport.channels[0]!, replyWindowMs: 86_400_000 }],
        });
        const before = sent.length;
        const messageId = await reply(
          (await routedRuns(schedule.id))[0].turn_id,
          'Expired-window fixture.',
        );
        const state = (
          await db.pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            messageId,
          ])
        ).rows[0];
        assert.deepEqual(state, { state: 'blocked', reason: 'reply_window_closed' });
        assert.equal(sent.length, before);
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
