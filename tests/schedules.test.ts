import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { createPersonalService } from '../src/server/personal.ts';
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
    const tasks = await import('../src/server/tasks.ts');
    let clock = new Date('2035-10-26T12:00:00.000Z');
    type Data = { scheduleId: string; revision: number; scheduledFor: string };
    let deliver: (jobs: Job<Data>[]) => Promise<unknown> = async () => {
      throw new Error('Schedule worker was not registered.');
    };
    let failAfterTask = false;
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      now: () => clock,
      submitTask: async (...args) => {
        assert.ok(args[4]?.client);
        const id = await tasks.submitTask(...args);
        if (failAfterTask) throw new Error('Synthetic failure after task creation.');
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
      const job = await tasks.boss.getJobById<Data>('scheduled-task', result.rows[0].job_id);
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
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      const workerMock = t.mock.method(
        tasks.boss,
        'work',
        async (_name: string, handler: unknown) => {
          deliver = handler as typeof deliver;
          return randomUUID();
        },
      );
      await db.pool.query(`CREATE TABLE schedules (
        id uuid PRIMARY KEY,owner_id text NOT NULL,title text NOT NULL,prompt text NOT NULL,
        cron text NOT NULL,time_zone text NOT NULL,enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      const legacyId = randomUUID();
      await db.pool.query(
        "INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone) VALUES($1,'local-development','Legacy fixture','Synthetic only','0 9 * * *','Europe/Lisbon')",
        [legacyId],
      );
      await tasks.boss.createQueue('scheduled-task');
      await tasks.boss.schedule(
        'scheduled-task',
        '0 9 * * *',
        { scheduleId: legacyId },
        { key: legacyId, tz: 'Europe/Lisbon' },
      );
      await personal.initialize();

      await t.test(
        'migration replaces legacy cron dispatch once and rejects its old payload',
        async () => {
          const migrated = await saved(legacyId);
          assert.equal(migrated.kind, 'recurring');
          assert.equal(migrated.nextRun, '2035-10-27T08:00:00.000Z');
          const current = await jobFor(legacyId);
          await personal.initialize({ workers: false });
          assert.equal((await jobFor(legacyId)).id, current.id);
          assert.equal(
            (await db.pool.query(`SELECT * FROM ${bossSchema}.schedule WHERE key=$1`, [legacyId]))
              .rowCount,
            0,
          );
          await deliver([{ ...current, id: randomUUID(), data: { scheduleId: legacyId } as Data }]);
          assert.deepEqual(await runs(legacyId), []);
        },
      );

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
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [run.taskId]);
          assert.deepEqual(
            await approvals.request(
              run.taskId,
              'GMAIL_SEND_EMAIL',
              { to: 'alex@example.test', body: 'Synthetic fixture' },
              { revision: 0 },
            ),
            { sent: true },
          );
          await approvals.request(
            run.taskId,
            'GMAIL_SEND_EMAIL',
            { to: 'alex@example.test', body: 'Synthetic fixture' },
            { revision: 0 },
          );
          assert.equal(executed.length, 1);
          await assert.rejects(
            approvals.request(
              run.taskId,
              'SLACK_SEND_MESSAGE',
              { text: 'No authority' },
              { revision: 0 },
            ),
          );
          await assert.rejects(
            approvals.request(
              run.taskId,
              'GMAIL_DELETE_MESSAGE',
              { message_id: 'fixture' },
              { revision: 0 },
            ),
          );
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
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [draft.taskId]);
          await assert.rejects(
            approvals.request(
              draft.taskId,
              'GMAIL_SEND_EMAIL',
              { to: 'alex@example.test' },
              { revision: 0 },
            ),
          );
          assert.equal(executed.length, 1);
          const generic = await tasks.submitTask('Send an email to Alex.', [], undefined, true, {
            source: 'event',
            sourceId: 'synthetic-event',
          });
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [generic]);
          await assert.rejects(
            approvals.request(
              generic,
              'GMAIL_SEND_EMAIL',
              { to: 'alex@example.test' },
              { revision: 0 },
            ),
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
            (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [history[0]!.taskId])).rows[0]
              .source,
            'schedule',
          );
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true })).statusCode,
            400,
          );
          await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [
            history[0]!.taskId,
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
        'scheduled observations retain a baseline and return the previous verified value',
        async () => {
          clock = new Date('2035-11-02T12:00:00.000Z');
          const sourceUrl = 'https://example.com/offer';
          const rejectedBaseline = await request('POST', '/api/schedules', {
            title: 'Rejected baseline',
            prompt: 'Check a source.',
            timeZone: 'Europe/Lisbon',
            baselineObservation: {
              status: 'unavailable',
              sourceUrl,
              value: null,
              summary: 'Source did not load.',
            },
          });
          assert.equal(rejectedBaseline.statusCode, 400);
          const schedule = await create({
            cron: '* * * * *',
            baselineObservation: {
              status: 'verified',
              sourceUrl,
              value: 'EUR 240',
              summary: 'Synthetic return fare with taxes.',
            },
          });
          assert.equal(schedule.baselineObservation?.value, 'EUR 240');
          for (const [value, previous] of [
            ['EUR 240', 'EUR 240'],
            ['EUR 215', 'EUR 240'],
            ['EUR 215', 'EUR 215'],
          ] as const) {
            clock = new Date((await saved(schedule.id)).nextRun!);
            await deliver([await jobFor(schedule.id)]);
            const run = (await runs(schedule.id))[0]!;
            await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [run.taskId]);
            const revision = value === 'EUR 240' ? 1 : 0;
            if (revision) {
              await db.pool.query('UPDATE tasks SET revision=1 WHERE id=$1', [run.taskId]);
              await assert.rejects(
                personal.manage(
                  'schedule_record_observation',
                  { status: 'verified', sourceUrl, value, summary: 'Stale task.' },
                  { taskId: run.taskId, sourceMessageId: null, revision: 0 },
                ),
                /no active scheduled run/,
              );
              assert.equal((await runs(schedule.id))[0]!.observation, null);
            }
            const result = await personal.manage(
              'schedule_record_observation',
              { status: 'verified', sourceUrl, value, summary: 'Same synthetic fare terms.' },
              { taskId: run.taskId, sourceMessageId: null, revision },
            );
            assert.equal(result.previous?.value, previous);
            assert.equal((await runs(schedule.id))[0]!.observation?.value, value);
            await assert.rejects(
              personal.manage(
                'schedule_record_observation',
                { status: 'verified', sourceUrl, value, summary: 'Duplicate.' },
                { taskId: run.taskId, sourceMessageId: null, revision },
              ),
              /already has a saved observation/,
            );
            await db.pool.query("UPDATE tasks SET status='succeeded' WHERE id=$1", [run.taskId]);
          }
          clock = new Date((await saved(schedule.id)).nextRun!);
          await deliver([await jobFor(schedule.id)]);
          const unavailableRun = (await runs(schedule.id))[0]!;
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [
            unavailableRun.taskId,
          ]);
          const unavailable = await personal.manage(
            'schedule_record_observation',
            { status: 'unavailable', sourceUrl, value: null, summary: 'Source did not load.' },
            { taskId: unavailableRun.taskId, sourceMessageId: null, revision: 0 },
          );
          assert.equal(unavailable.previous?.value, 'EUR 215');
          assert.deepEqual(
            (await runs(schedule.id)).map((run) => run.observation?.value),
            [null, 'EUR 215', 'EUR 215', 'EUR 240'],
          );
          const deleted = await create({
            cron: '* * * * *',
            baselineObservation: {
              status: 'verified',
              sourceUrl,
              value: 'EUR 240',
              summary: 'Synthetic return fare with taxes.',
            },
          });
          clock = new Date((await saved(deleted.id)).nextRun!);
          await deliver([await jobFor(deleted.id)]);
          const deletedRun = (await runs(deleted.id))[0]!;
          await db.pool.query("UPDATE tasks SET status='running' WHERE id=$1", [deletedRun.taskId]);
          assert.equal((await request('DELETE', `/api/schedules/${deleted.id}`)).statusCode, 200);
          const afterDelete = await personal.manage(
            'schedule_record_observation',
            {
              status: 'verified',
              sourceUrl,
              value: 'EUR 215',
              summary: 'Same synthetic fare terms.',
            },
            { taskId: deletedRun.taskId, sourceMessageId: null, revision: 0 },
          );
          assert.equal(afterDelete.previous?.value, 'EUR 240');
          assert.equal((await runs(deleted.id))[0]!.observation?.value, 'EUR 215');
          await assert.rejects(
            personal.manage('schedule_record_observation', {
              status: 'verified',
              sourceUrl,
              value: 'EUR 100',
              summary: 'No matching task.',
            }),
          );
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
        'task creation, run history and next occurrence roll back together',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-05T10:00:00Z' });
          const job = await jobFor(schedule.id);
          const before = (await db.pool.query('SELECT count(*)::int AS count FROM tasks')).rows[0]
            .count;
          failAfterTask = true;
          await assert.rejects(deliver([job]), /Synthetic failure/);
          failAfterTask = false;
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM tasks')).rows[0].count,
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
          await tasks.boss.cancel('scheduled-task', job.id);
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
        'owned history survives deletion, paginates precisely and reflects failures',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-08T10:00:00Z' });
          await deliver([await jobFor(schedule.id)]);
          const run = (await runs(schedule.id))[0]!;
          await db.pool.query(
            "UPDATE tasks SET status='failed',error='Synthetic fixed error.' WHERE id=$1",
            [run.taskId],
          );
          await request('DELETE', `/api/schedules/${schedule.id}`);
          const retained = (await runs(schedule.id))[0]!;
          assert.equal(retained.title, 'Fixture schedule');
          assert.equal(retained.status, 'failed');
          assert.equal(retained.error, 'Synthetic fixed error.');
          const seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const page: ScheduleHistory = (
              await request('GET', `/api/schedule-runs?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
            ).json<ScheduleHistory>();
            for (const entry of page.runs) {
              assert.equal(seen.has(entry.id), false);
              seen.add(entry.id);
            }
            cursor = page.nextCursor;
          } while (cursor);
          assert.equal(
            seen.size,
            (await db.pool.query('SELECT count(*)::int AS count FROM schedule_runs')).rows[0].count,
          );
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
          assert.equal((await request('GET', '/api/schedule-runs?cursor=broken')).statusCode, 400);
          assert.equal((await request('GET', '/api/schedule-runs?limit=101')).statusCode, 400);
          assert.equal(
            (await request('GET', '/api/schedule-runs'))
              .json<ScheduleHistory>()
              .runs.some((entry) => entry.id === run.id),
            false,
          );
        },
      );

      await t.test(
        'history links a run to its first owned assistant message in the current web chat',
        async () => {
          const schedule = await create({ kind: 'once', runAt: '2035-11-09T10:00:00Z' });
          await deliver([await jobFor(schedule.id)]);
          let run = (await runs(schedule.id))[0]!;
          assert.equal(run.messageId, null);
          assert.equal(run.messagePreview, null);
          const insert = (id: string, owner: string, role: string, text: string, at: string) =>
            db.pool.query(
              'INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
              [id, owner, role, text, run.taskId, at],
            );
          const first = randomUUID();
          await insert(
            randomUUID(),
            'foreign-owner',
            'assistant',
            'Foreign',
            '2035-11-09T10:00:01Z',
          );
          await insert(
            randomUUID(),
            'local-development',
            'user',
            'Synthetic',
            '2035-11-09T10:00:02Z',
          );
          await insert(
            first,
            'local-development',
            'assistant',
            `Synthetic   summary\n\n${'word '.repeat(60)}`,
            '2035-11-09T10:00:03Z',
          );
          await insert(
            randomUUID(),
            'local-development',
            'assistant',
            'Later',
            '2035-11-09T10:00:04Z',
          );
          run = (await runs(schedule.id))[0]!;
          assert.equal(run.messageId, first);
          assert.equal(run.messagePreview!.length, 160);
          assert.match(run.messagePreview!, /^Synthetic summary word word .*…$/);
          assert.equal(run.messageText, `Synthetic   summary\n\n${'word '.repeat(60)}`);
          assert.equal((await saved(schedule.id)).lastRun?.messageId, first);
          await db.pool.query("UPDATE tasks SET channel='telegram' WHERE id=$1", [run.taskId]);
          assert.equal((await runs(schedule.id))[0]!.messageId, null);
          await db.pool.query("UPDATE tasks SET channel='web' WHERE id=$1", [run.taskId]);
          assert.equal((await runs(schedule.id))[0]!.messageId, first);
          await db.pool.query(
            `INSERT INTO conversations(owner_id,channel,revision) VALUES('local-development','web',1)
             ON CONFLICT(owner_id,channel) DO UPDATE SET revision=conversations.revision+1`,
          );
          const archived = (await runs(schedule.id))[0]!;
          assert.equal(archived.messageId, null);
          assert.equal(archived.messagePreview, null);
          assert.equal(archived.messageText, null);
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

      await t.test(
        'a real pg-boss worker dispatches one due one-off without a model or external action',
        async () => {
          workerMock.mock.restore();
          const liveScheduler = createPersonalService({
            pool: db.pool,
            ownerId: 'local-development',
            scheduler: tasks.boss,
            submitTask: tasks.submitTask,
            refresh() {},
          });
          await liveScheduler.initialize();
          const actualRunAt = new Date(Date.now() + 750).toISOString();
          const schedule = (await liveScheduler.manage('schedule_create', {
            title: 'Timed synthetic fixture',
            prompt: 'Synthetic execution only',
            kind: 'once',
            runAt: actualRunAt,
            timeZone: 'Europe/Lisbon',
          })) as Schedule;
          let history = await runs(schedule.id);
          for (let attempts = 0; !history.length && attempts < 300; attempts++) {
            await delay(20);
            history = await runs(schedule.id);
          }
          assert.equal(history.length, 1);
          assert.equal(history[0]!.scheduledFor, actualRunAt);
          assert.ok(new Date(history[0]!.createdAt).getTime() >= new Date(actualRunAt).getTime());
          assert.equal(history[0]!.status, 'queued');
          assert.equal(
            (await liveScheduler.listSchedules()).find((item) => item.id === schedule.id)?.enabled,
            false,
          );
          await tasks.boss.offWork('scheduled-task', { wait: true });
        },
      );
    } finally {
      await app.close();
      await tasks.stopTasks();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
