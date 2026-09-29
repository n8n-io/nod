import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { createPersonalService } from '../src/server/personal.ts';
import { readSchedule, scheduleExpression, scheduleLabel } from '../src/web/lib/schedules.ts';
import { setDateFormat } from '../src/web/lib/date-format.ts';

setDateFormat({ locale: 'en-GB', hourCycle: 'auto', timeZone: 'Europe/Lisbon' });

test('daily and weekly schedule forms preserve local wall time and existing custom timing', () => {
  assert.equal(scheduleExpression('daily', '09:05', '1'), '5 9 * * *');
  assert.equal(scheduleExpression('weekly', '00:00', '0'), '0 0 * * 0');
  assert.deepEqual(readSchedule('5 9 * * 7'), { frequency: 'weekly', time: '09:05', day: '0' });
  assert.equal(scheduleLabel('5 9 * * *'), 'Every day at 09:05');
  assert.equal(scheduleLabel('0 8 * * 1'), 'Every Monday at 08:00');
  assert.equal(readSchedule('0 9 1 1 *').frequency, 'custom');
  assert.equal(scheduleExpression('custom', '09:00', '1', '0 9 1 1 *'), '0 9 1 1 *');
  assert.throws(() => scheduleExpression('weekly', '25:00', '1'));
  assert.throws(() => scheduleExpression('weekly', '09:00', '8'));
});

test(
  'personal data routes edit goals and manage owned recurring schedules with durable reloads',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_personal_${suffix}`;
    const bossSchema = `test_personal_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const scheduler = new PgBoss({
      connectionString: process.env.TEST_DATABASE_URL,
      schema: bossSchema,
      schedule: false,
      supervise: false,
    });
    const personal = createPersonalService({
      pool,
      ownerId: 'fixture-owner',
      scheduler,
      submitTask: async () => {
        throw new Error('No task execution is expected in this fixture.');
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
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        ...(payload === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) }),
      });
    const storedSchedule = (id: string) =>
      pool.query(
        `SELECT s.cron,s.time_zone AS timezone FROM schedules s JOIN ${bossSchema}.job j ON j.id=s.job_id AND j.name='scheduled-task' WHERE s.id=$1 AND j.state IN ('created','retry','active')`,
        [id],
      );
    try {
      await scheduler.start();
      await personal.initialize({ workers: false });
      await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'queued',error text,
          channel text NOT NULL DEFAULT 'web',conversation_revision integer NOT NULL DEFAULT 0);
        CREATE TABLE conversations(owner_id text NOT NULL,channel text NOT NULL,revision integer NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,channel));
        CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL DEFAULT '',task_id uuid,created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE memory_facts(id uuid PRIMARY KEY,owner_id text NOT NULL,text text NOT NULL,
          source_message_id uuid REFERENCES messages(id),UNIQUE(owner_id,text))`);
      await pool.query(`CREATE TABLE preferences(owner_id text PRIMARY KEY,notification_rule text NOT NULL DEFAULT '',
        time_zone text NOT NULL DEFAULT 'Europe/Lisbon',quiet_start text NOT NULL DEFAULT '22:00',quiet_end text NOT NULL DEFAULT '08:00',quiet_hours_enabled boolean NOT NULL DEFAULT true,
        locale text,hour_cycle text NOT NULL DEFAULT 'auto')`);
      await t.test(
        'conversation preferences start useful but preserve an explicit quiet choice and partial changes',
        async () => {
          const initial = (await personal.manage('notification_preferences_get', {})) as {
            notificationRule: string;
            timeZone: string;
          };
          assert.match(initial.notificationRule, /time-sensitive/);
          assert.match(initial.notificationRule, /quiet/);
          await personal.manage('notification_preferences_update', {
            notificationRule: '',
            quietStart: '21:00',
          });
          const updated = (await personal.manage('notification_preferences_update', {
            timeZone: 'UTC',
          })) as {
            notificationRule: string;
            timeZone: string;
            quietStart: string;
            quietEnd: string;
          };
          assert.equal(updated.notificationRule, '');
          assert.equal(updated.timeZone, 'UTC');
          assert.equal(updated.quietStart, '21:00');
          assert.equal(updated.quietEnd, '08:00');
          await assert.rejects(
            personal.manage('notification_preferences_update', { timeZone: 'Unknown/Fixture' }),
          );
          await assert.rejects(
            personal.manage('notification_preferences_update', { quietStart: '25:00' }),
          );
          await assert.rejects(
            personal.manage('notification_preferences_update', { unexpected: true }),
          );
        },
      );
      await t.test(
        'automatic learning requires an exact owned user statement and preserves provenance without approval',
        async () => {
          const id = randomUUID(),
            taskId = randomUUID(),
            foreign = randomUUID(),
            assistant = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'fixture-owner','user','I prefer concise replies',$4),($2,'other-owner','user','I prefer concise replies',$4),($3,'fixture-owner','assistant','I prefer concise replies',$4)",
            [id, foreign, assistant, taskId],
          );
          assert.deepEqual(
            await personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: id, taskId },
            ),
            { ok: true },
          );
          const remembered = (
            await pool.query(
              'SELECT text,source_message_id FROM memory_facts WHERE source_message_id=$1',
              [id],
            )
          ).rows[0];
          assert.deepEqual(remembered, { text: 'I prefer concise replies', source_message_id: id });
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer long replies' },
              { sourceMessageId: id },
            ),
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: foreign },
            ),
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: assistant },
            ),
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: null },
            ),
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: id, taskId: randomUUID() },
            ),
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies', sourceMessageId: id },
              { sourceMessageId: null },
            ),
          );
          const qualifiedSource = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,role,text) VALUES($1,'fixture-owner','user','I prefer concise replies only for notifications.')",
            [qualifiedSource],
          );
          await assert.rejects(
            personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies' },
              { sourceMessageId: qualifiedSource },
            ),
          );
          assert.deepEqual(
            await personal.manage(
              'memory_remember',
              { quote: 'I prefer concise replies only for notifications.' },
              { sourceMessageId: qualifiedSource },
            ),
            { ok: true },
          );
          for (const quote of [
            'The website says I prefer concise replies',
            'My password is a-fixture-only-secret',
            'I prefer the api key fixture-private-token',
          ]) {
            const source = randomUUID();
            await pool.query(
              "INSERT INTO messages(id,owner_id,role,text) VALUES($1,'fixture-owner','user',$2)",
              [source, quote],
            );
            await assert.rejects(
              personal.manage('memory_remember', { quote }, { sourceMessageId: source }),
            );
          }
        },
      );
      await t.test(
        'contextual and corrected preferences retain the complete direct user statement',
        async () => {
          const taskId = randomUUID();
          for (const quote of [
            'For travel plans, I prefer short bullet lists. Please remember this preference.',
            'Correction: I prefer short bullet lists only for travel plans.',
            'Actually, I prefer prose for complex travel plans, not bullet lists.',
            'For travel plans, I do not prefer long lists unless I ask for every option.',
            "Actually, for travel plans, I don't like bullet lists except for packing.",
          ]) {
            const source = randomUUID();
            await pool.query(
              "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'fixture-owner','user',$2,$3)",
              [source, quote, taskId],
            );
            assert.deepEqual(
              await personal.manage(
                'memory_remember',
                { quote },
                { sourceMessageId: source, taskId },
              ),
              { ok: true },
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT text,source_message_id FROM memory_facts WHERE source_message_id=$1',
                  [source],
                )
              ).rows,
              [{ text: quote, source_message_id: source }],
            );
            await assert.rejects(
              personal.manage(
                'memory_remember',
                { quote: 'I prefer short bullet lists.' },
                { sourceMessageId: source, taskId },
              ),
              /complete current user statement/,
            );
          }
          for (const quote of [
            'The website says I prefer short bullet lists.',
            'For travel plans, the website says I prefer short bullet lists.',
            'Correction: the website says I prefer short bullet lists.',
            'Actually, the website says I prefer short bullet lists.',
            'For travel plans, "I prefer short bullet lists" is what the article says.',
            'Actually, "I prefer short bullet lists" is a quote from the website.',
          ]) {
            const source = randomUUID();
            await pool.query(
              "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'fixture-owner','user',$2,$3)",
              [source, quote, taskId],
            );
            await assert.rejects(
              personal.manage('memory_remember', { quote }, { sourceMessageId: source, taskId }),
              /explicit personal fact or preference/,
            );
            assert.equal(
              (await pool.query('SELECT id FROM memory_facts WHERE source_message_id=$1', [source]))
                .rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'explicit profile statements and answers to personal questions update only the cited field',
        async () => {
          const nameSource = randomUUID(),
            locationSource = randomUUID(),
            shortSource = randomUUID(),
            questionSource = randomUUID(),
            taskId = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,role,text) VALUES($1,'fixture-owner','user','My name is Fixture Person'),($2,'fixture-owner','user','I live in Lisbon')",
            [nameSource, locationSource],
          );
          await personal.manage(
            'profile_learn',
            { field: 'name', value: 'Fixture Person', quote: 'My name is Fixture Person' },
            { sourceMessageId: nameSource },
          );
          await personal.manage(
            'profile_learn',
            { field: 'location', value: 'Lisbon', quote: 'I live in Lisbon' },
            { sourceMessageId: locationSource },
          );
          await assert.rejects(
            personal.manage(
              'profile_learn',
              { field: 'location', value: 'Porto', quote: 'I live in Lisbon' },
              { sourceMessageId: locationSource },
            ),
          );
          assert.equal((await personal.getProfile()).name, 'Fixture Person');
          assert.equal((await personal.getProfile()).location, 'Lisbon');
          await pool.query(
            "INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,'fixture-owner','assistant','What should I call you?',$3,now()-interval '1 second'),($2,'fixture-owner','user','Filipe',$3,now())",
            [questionSource, shortSource, taskId],
          );
          await personal.manage(
            'profile_learn',
            { field: 'name', value: 'Filipe', quote: 'Filipe' },
            { sourceMessageId: shortSource, taskId },
          );
          assert.equal((await personal.getProfile()).name, 'Filipe');
          assert.equal((await personal.getProfile()).location, 'Lisbon');
          assert.equal(
            (
              await pool.query('SELECT source_message_id FROM memory_facts WHERE text=$1', [
                'Filipe',
              ])
            ).rows[0].source_message_id,
            shortSource,
          );
        },
      );
      await t.test('personal answers can decline and memory cannot store credentials', async () => {
        const before = await personal.getProfile();
        for (const [field, question] of [
          ['name', 'What should I call you?'],
          ['location', 'Where do you live?'],
        ] as const) {
          for (const text of [
            'No thanks',
            'Skip',
            'I would rather not',
            "I don't want to share that",
          ]) {
            const taskId = randomUUID(),
              source = randomUUID();
            await pool.query(
              "INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,'fixture-owner','assistant',$2,$3,now()-interval '1 second'),($4,'fixture-owner','user',$5,$3,now())",
              [randomUUID(), question, taskId, source, text],
            );
            await assert.rejects(
              personal.manage(
                'profile_learn',
                { field, value: text, quote: text },
                { sourceMessageId: source, taskId },
              ),
            );
          }
        }
        assert.deepEqual(await personal.getProfile(), before);
        const taskId = randomUUID(),
          source = randomUUID();
        await pool.query(
          "INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,'fixture-owner','assistant','What should I call you?',$2,now()-interval '1 second'),($3,'fixture-owner','user','Noel',$2,now())",
          [randomUUID(), taskId, source],
        );
        await personal.manage(
          'profile_learn',
          { field: 'name', value: 'Noel', quote: 'Noel' },
          { taskId, sourceMessageId: source },
        );
        assert.equal((await personal.getProfile()).name, 'Noel');
        const initial = (await pool.query('SELECT id FROM memory_facts')).rowCount;
        for (const text of [
          'My password is fixture-secret',
          'The recovery code is 123456',
          'API key: synthetic-token',
          'My CVV is 123',
        ]) {
          await assert.rejects(personal.manage('memory_propose', { text }), z.ZodError);
        }
        assert.equal((await pool.query('SELECT id FROM memory_facts')).rowCount, initial);
      });
      await t.test(
        'memory preserves trusted user-message provenance and rejects spoofed sources',
        async () => {
          const initialMemoryCount = (await pool.query('SELECT id FROM memory_facts')).rowCount!;
          const trustedId = randomUUID();
          const laterId = randomUUID();
          const foreignId = randomUUID();
          const assistantId = randomUUID();
          await pool.query(
            'INSERT INTO messages(id,owner_id,role) VALUES($1,$5,$6),($2,$5,$6),($3,$7,$6),($4,$5,$8)',
            [
              trustedId,
              laterId,
              foreignId,
              assistantId,
              'fixture-owner',
              'user',
              'another-owner',
              'assistant',
            ],
          );
          await personal.manage(
            'memory_propose',
            { text: 'Fixture prefers concise updates' },
            { sourceMessageId: trustedId },
          );
          await personal.manage(
            'memory_propose',
            { text: 'Fixture prefers concise updates' },
            { sourceMessageId: laterId },
          );
          const memory = await pool.query(
            'SELECT owner_id,source_message_id FROM memory_facts WHERE text=$1',
            ['Fixture prefers concise updates'],
          );
          assert.equal(memory.rowCount, 1);
          assert.deepEqual(memory.rows[0], {
            owner_id: 'fixture-owner',
            source_message_id: trustedId,
          });
          for (const sourceMessageId of [foreignId, assistantId, randomUUID()]) {
            await assert.rejects(
              personal.manage(
                'memory_propose',
                { text: 'Untrusted source must not save' },
                { sourceMessageId },
              ),
              { statusCode: 400, message: 'This memory source is unavailable.' },
            );
          }
          for (const spoof of [{ sourceMessageId: foreignId }, { source_message_id: foreignId }]) {
            await assert.rejects(
              personal.manage(
                'memory_propose',
                { text: 'Model source must not save', ...spoof },
                { sourceMessageId: trustedId },
              ),
              z.ZodError,
            );
          }
          await assert.rejects(
            personal.manage(
              'memory_propose',
              { text: 'Invalid source must not save' },
              { sourceMessageId: 'not-an-id' },
            ),
            z.ZodError,
          );
          assert.equal(
            (await pool.query('SELECT * FROM memory_facts')).rowCount,
            initialMemoryCount + 1,
          );
          await personal.manage(
            'memory_propose',
            { text: 'Explicit direct fixture detail' },
            { sourceMessageId: null },
          );
          await personal.manage('memory_propose', { text: 'Explicit legacy fixture detail' });
          const direct = await pool.query(
            'SELECT text FROM memory_facts WHERE source_message_id IS NULL ORDER BY text',
          );
          assert.deepEqual(direct.rows, [
            { text: 'Explicit direct fixture detail' },
            { text: 'Explicit legacy fixture detail' },
          ]);
        },
      );
      await t.test('profile values remain explicit and owned', async () => {
        assert.equal(
          (
            await request('PUT', '/api/profile', {
              name: 'Fixture owner',
              location: 'Lisbon',
              phone: '',
              preferences: 'Brief answers',
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await request('PUT', '/api/profile', {
              name: 'Fixture',
              location: '',
              phone: '',
              preferences: '',
              ownerId: 'another-owner',
            })
          ).statusCode,
          400,
        );
        const another = createPersonalService({
          pool,
          ownerId: 'another-owner',
          scheduler,
          submitTask: async () => '',
          refresh() {},
        });
        assert.equal((await another.getProfile()).name, '');
        assert.equal((await personal.getProfile()).name, 'Fixture owner');
      });
      await t.test('goal fields update independently and clearing a date is durable', async () => {
        const created = await request('POST', '/api/goals', {
          title: 'Write a fixture report',
          description: 'A synthetic goal',
          targetDate: '2027-02-15',
        });
        assert.equal(created.statusCode, 200);
        const goal = created.json();
        assert.equal(goal.progress, 0);
        assert.equal(goal.status, 'active');
        assert.equal(
          (await request('PATCH', `/api/goals/${goal.id}`, { progress: 35 })).statusCode,
          200,
        );
        const unchanged = (await request('GET', '/api/goals')).json()[0];
        assert.equal(unchanged.description, 'A synthetic goal');
        assert.equal(unchanged.targetDate, '2027-02-15');
        const updated = await request('PATCH', `/api/goals/${goal.id}`, {
          title: 'Complete a fixture report',
          description: 'Updated details',
          targetDate: null,
          nextAction: 'Review the draft',
          progress: 60,
          status: 'paused',
        });
        assert.equal(updated.statusCode, 200);
        assert.equal(updated.json().title, 'Complete a fixture report');
        const reloaded = (await request('GET', '/api/goals')).json()[0];
        assert.equal(reloaded.targetDate, null);
        assert.equal(reloaded.nextAction, 'Review the draft');
        assert.equal(reloaded.status, 'paused');
        assert.equal(
          (
            await request('PATCH', `/api/goals/${goal.id}`, { progress: 100, status: 'completed' })
          ).json().status,
          'completed',
        );
        for (const payload of [
          { progress: 101 },
          { progress: 2.5 },
          { targetDate: '2027-02-30' },
          { title: '  ' },
          {},
          { ownerId: 'another-owner' },
        ])
          assert.equal((await request('PATCH', `/api/goals/${goal.id}`, payload)).statusCode, 400);
        await pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [goal.id, 'another-owner']);
        assert.equal(
          (await request('PATCH', `/api/goals/${goal.id}`, { progress: 10 })).statusCode,
          404,
        );
        assert.deepEqual((await request('GET', '/api/goals')).json(), []);
      });
      await t.test(
        'goal deletion is owned, durable and safe to repeat without deleting conversation history',
        async () => {
          const created = [];
          for (const title of ['Delete this fixture', 'Keep this fixture', 'Foreign fixture']) {
            const response = await request('POST', '/api/goals', { title });
            assert.equal(response.statusCode, 200);
            created.push(response.json());
          }
          const [target, survivor, foreign] = created;
          await pool.query('UPDATE goals SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'another-owner',
          ]);
          const messageId = randomUUID();
          await pool.query(
            "INSERT INTO messages(id,owner_id,role,text) VALUES($1,'fixture-owner','user','Synthetic goal discussion')",
            [messageId],
          );
          assert.equal((await request('DELETE', '/api/goals/not-a-uuid')).statusCode, 400);
          assert.equal((await request('DELETE', `/api/goals/${foreign.id}`)).statusCode, 404);
          assert.equal((await request('DELETE', `/api/goals/${randomUUID()}`)).statusCode, 404);
          const removed = await Promise.all([
            request('DELETE', `/api/goals/${target.id}`),
            request('DELETE', `/api/goals/${target.id}`),
          ]);
          assert.deepEqual(removed.map((response) => response.statusCode).sort(), [200, 404]);
          assert.deepEqual(removed.find((response) => response.statusCode === 200)!.json(), {
            ok: true,
          });
          assert.deepEqual(
            (await request('GET', '/api/goals')).json().map((goal: { id: string }) => goal.id),
            [survivor.id],
          );
          assert.equal(
            (await pool.query('SELECT id FROM goals WHERE id=$1', [target.id])).rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT id FROM goals WHERE id=$1', [foreign.id])).rowCount,
            1,
          );
          assert.equal(
            (await pool.query('SELECT id FROM messages WHERE id=$1', [messageId])).rowCount,
            1,
          );
          await personal.initialize({ workers: false });
          assert.equal((await request('DELETE', `/api/goals/${target.id}`)).statusCode, 404);
          assert.equal((await request('DELETE', `/api/goals/${survivor.id}`)).statusCode, 200);
        },
      );
      await t.test(
        'schedule editing, pause, resume and deletion agree with the recurring queue',
        async () => {
          const created = await request('POST', '/api/schedules', {
            title: 'Fixture routine',
            prompt: 'Prepare a synthetic summary',
            cron: '5 9 * * *',
            timeZone: 'Europe/Lisbon',
          });
          assert.equal(created.statusCode, 200);
          const schedule = created.json();
          assert.equal(schedule.enabled, true);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          const edited = await request('PATCH', `/api/schedules/${schedule.id}`, {
            title: 'Weekly fixture',
            prompt: 'Prepare a weekly summary',
            cron: '15 18 * * 1',
            timeZone: 'Europe/Paris',
          });
          assert.equal(edited.statusCode, 200);
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '15 18 * * 1');
          assert.equal((await storedSchedule(schedule.id)).rows[0].timezone, 'Europe/Paris');
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false })).json()
              .enabled,
            false,
          );
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('GET', '/api/schedules')).json()[0].enabled, false);
          await personal.initialize({ workers: false });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true })).json()
              .enabled,
            true,
          );
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          await personal.manage('schedule_cancel', { id: schedule.id });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('GET', '/api/schedules')).json().length, 1);
          await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: true });
          const cancel = t.mock.method(scheduler, 'cancel', async () => {
            throw new Error('Synthetic cancellation failure');
          });
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 500);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          assert.equal((await request('GET', '/api/schedules')).json()[0].id, schedule.id);
          cancel.mock.restore();
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 200);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.deepEqual((await request('GET', '/api/schedules')).json(), []);
          await personal.initialize({ workers: false });
          assert.equal((await storedSchedule(schedule.id)).rowCount, 0);
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 404);
        },
      );
      await t.test(
        'invalid or foreign schedule changes do not alter the saved schedule or queue',
        async () => {
          const schedule = (
            await request('POST', '/api/schedules', {
              title: 'Protected fixture',
              prompt: 'Synthetic only',
              cron: '0 9 1 1 *',
              timeZone: 'Europe/Lisbon',
            })
          ).json();
          for (const payload of [
            { cron: '* * * * * *' },
            { cron: '60 9 * * *' },
            { timeZone: 'Invalid/Zone' },
            { title: ' ' },
            { enabled: 'yes' },
            {},
          ])
            assert.equal(
              (await request('PATCH', `/api/schedules/${schedule.id}`, payload)).statusCode,
              400,
            );
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '0 9 1 1 *');
          assert.equal(
            (await request('GET', '/api/schedules')).json()[0].timeZone,
            'Europe/Lisbon',
          );
          const originalSend = scheduler.send.bind(scheduler);
          let failOnce = true;
          t.mock.method(scheduler, 'send', async (...args: Parameters<typeof scheduler.send>) => {
            if (failOnce) {
              failOnce = false;
              throw new Error('Fixture queue write failure');
            }
            return originalSend(...args);
          });
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { cron: '0 10 1 1 *' }))
              .statusCode,
            500,
          );
          assert.equal((await storedSchedule(schedule.id)).rows[0].cron, '0 9 1 1 *');
          assert.equal((await request('GET', '/api/schedules')).json()[0].cron, '0 9 1 1 *');
          await pool.query('UPDATE schedules SET owner_id=$2 WHERE id=$1', [
            schedule.id,
            'another-owner',
          ]);
          assert.equal(
            (await request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false }))
              .statusCode,
            404,
          );
          assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`)).statusCode, 404);
          assert.equal((await storedSchedule(schedule.id)).rowCount, 1);
          assert.deepEqual((await request('GET', '/api/schedules')).json(), []);
        },
      );
    } finally {
      await app.close();
      await scheduler.stop({ graceful: false });
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
