import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import Fastify from 'fastify';

test(
  'new notification preferences gate useful events while explicit silence and narrow feedback survive',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_triage_${suffix}`;
    const bossSchema = `test_triage_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createTriage, getPreferences, updatePreferences, isQuietTime } =
      await import('../src/server/triage.ts');
    const { createPreferencesStore, defaultPreferences } =
      await import('../src/server/preferences.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    const contexts: object[] = [];
    let decision: 'digest' | 'wake' = 'digest';
    const triage = createTriage({
      getProfile: personal.getProfile,
      listGoals: personal.listGoals,
      classifier: {
        id: 'fixture',
        configured: true,
        classify: async (context, policy) => {
          contexts.push(context);
          assert.match(policy.instructions, /One dislike must not disable unrelated useful help/);
          return decision;
        },
      },
    });
    const app = Fastify();
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'Invalid preferences.' }),
    );
    triage.registerRoutes(app);
    try {
      await db.pool
        .query(`CREATE TABLE preferences(owner_id text PRIMARY KEY,notification_rule text NOT NULL DEFAULT '',
        time_zone text NOT NULL DEFAULT 'Europe/Lisbon',quiet_start text NOT NULL DEFAULT '22:00',quiet_end text NOT NULL DEFAULT '08:00');
        INSERT INTO preferences(owner_id) VALUES('legacy-fixture')`);
      await db.initializeDatabase();
      const legacy = createPreferencesStore(db.pool, 'legacy-fixture');
      assert.equal((await legacy.get()).quietHoursEnabled, true);
      await legacy.update({ quietHoursEnabled: false });
      assert.equal((await legacy.get()).quietStart, '22:00');
      assert.equal((await legacy.get()).locale, null);
      assert.equal((await legacy.get()).hourCycle, 'auto');
      assert.equal((await legacy.update({ locale: 'pt-pt' })).locale, 'pt-PT');
      await assert.rejects(legacy.update({ locale: 'not a region' }), /valid region/);
      await assert.rejects(legacy.update({ hourCycle: 'h24' }));
      assert.equal((await legacy.update({ hourCycle: 'h23' })).hourCycle, 'h23');
      assert.equal((await legacy.get()).locale, 'pt-PT');
      assert.equal((await legacy.get()).quietHoursEnabled, false);
      assert.equal((await getPreferences()).quietHoursEnabled, true);
      await assert.rejects(updatePreferences({ quietHoursEnabled: 'false' }));
      await db.pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text');
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await triage.initializeHeartbeat();
      assert.match((await getPreferences()).notificationRule, /time-sensitive/);
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,reaction) VALUES($1,'local-development','assistant','Synthetic reminder','dislike')",
        [randomUUID()],
      );
      await triage.triageEvent('A synthetic meeting time changed', 'default-preferences-fixture');
      assert.equal(contexts.length, 1);
      assert.match(JSON.stringify(contexts[0]), /"reaction":"dislike"/);
      assert.match(JSON.stringify(contexts[0]), /"createdAt"/);
      assert.equal(
        (
          await db.pool.query('SELECT decision FROM notifications WHERE event_id=$1', [
            'default-preferences-fixture',
          ])
        ).rows[0].decision,
        'digest',
      );
      await updatePreferences({ notificationRule: '' });
      await updatePreferences({ timeZone: 'UTC' });
      assert.equal((await getPreferences()).notificationRule, '');
      await triage.triageEvent(
        'Another synthetic meeting time changed',
        'explicit-silence-fixture',
      );
      assert.equal(contexts.length, 1);
      assert.equal(
        (
          await db.pool.query('SELECT decision FROM notifications WHERE event_id=$1', [
            'explicit-silence-fixture',
          ])
        ).rows[0].decision,
        'digest',
      );
      assert.equal((await db.pool.query('SELECT id FROM tasks')).rowCount, 0);
      const clock = new Date('2026-09-26T23:00:00Z');
      assert.equal(isQuietTime({ ...defaultPreferences, timeZone: 'UTC' }, clock), true);
      assert.equal(
        isQuietTime({ ...defaultPreferences, timeZone: 'UTC', quietHoursEnabled: false }, clock),
        false,
      );
      decision = 'wake';
      const quietStart = new Date(Date.now() - 30 * 60_000).toISOString().slice(11, 16);
      const quietEnd = new Date(Date.now() + 30 * 60_000).toISOString().slice(11, 16);
      await updatePreferences({
        notificationRule: 'Only this synthetic timely update',
        timeZone: 'UTC',
        quietStart,
        quietEnd,
      });
      await triage.triageEvent('A synthetic urgent update', 'quiet-enabled-fixture');
      assert.equal(
        (
          await db.pool.query('SELECT decision,task_id FROM notifications WHERE event_id=$1', [
            'quiet-enabled-fixture',
          ])
        ).rows[0].decision,
        'digest',
      );
      await updatePreferences({ quietHoursEnabled: false });
      await updatePreferences({ timeZone: 'UTC' });
      const restored = await createPreferencesStore(db.pool, 'local-development').get();
      assert.equal(restored.quietHoursEnabled, false);
      assert.equal(restored.quietStart, quietStart);
      assert.equal(restored.quietEnd, quietEnd);
      const patch = await app.inject({
        method: 'PATCH',
        url: '/api/preferences',
        payload: { timeZone: 'Europe/Lisbon' },
      });
      assert.equal(patch.statusCode, 200);
      assert.equal(patch.json().quietHoursEnabled, false);
      const legacyPut = await app.inject({
        method: 'PUT',
        url: '/api/preferences',
        payload: {
          notificationRule: restored.notificationRule,
          timeZone: 'UTC',
          quietStart,
          quietEnd,
        },
      });
      assert.equal(legacyPut.statusCode, 200);
      assert.equal(legacyPut.json().quietHoursEnabled, false);
      const original = (await app.inject({ url: '/api/preferences' })).json();
      assert.equal(original.locale, null);
      const roundTrip = await app.inject({
        method: 'PUT',
        url: '/api/preferences',
        payload: original,
      });
      assert.equal(roundTrip.statusCode, 200);
      assert.deepEqual(roundTrip.json(), original);
      await updatePreferences({ locale: 'pt-PT' });
      assert.equal((await updatePreferences({ locale: null })).locale, null);
      await updatePreferences({ locale: 'en-US' });
      assert.equal((await updatePreferences({ timeZone: 'UTC' })).locale, 'en-US');
      const foreign = await app.inject({
        method: 'PATCH',
        url: '/api/preferences',
        payload: { ownerId: 'legacy-fixture', quietHoursEnabled: true },
      });
      assert.equal(foreign.statusCode, 400);
      assert.equal((await getPreferences()).quietHoursEnabled, false);
      await triage.triageEvent(
        'A synthetic urgent update after explicit opt-in',
        'quiet-disabled-fixture',
      );
      const delivered = (
        await db.pool.query('SELECT decision,task_id FROM notifications WHERE event_id=$1', [
          'quiet-disabled-fixture',
        ])
      ).rows[0];
      assert.equal(delivered.decision, 'wake');
      assert.ok(delivered.task_id);
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
