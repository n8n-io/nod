import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'history paging, message reactions and task lookup preserve ownership and stable order',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_chat_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { initializeTaskSchema } = await import('../src/server/tasks.ts');
    const { ownerId, port } = await import('../src/server/config.ts');
    const app = await createApp();
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    try {
      await initializeDatabase();
      await initializeTaskSchema();
      const task = randomUUID(),
        otherTask = randomUUID();
      await pool.query(
        "INSERT INTO tasks(id,owner_id,title,prompt) VALUES($1,$2,'Mine','Fixture'),($3,'other-owner','Private','Fixture')",
        [task, ownerId, otherTask],
      );
      for (let i = 0; i < 135; i++)
        await pool.query(
          "INSERT INTO messages(id,owner_id,role,text,task_id,created_at) VALUES($1,$2,'assistant',$3,$4,'2026-09-20 12:00:00.123456+00'::timestamptz)",
          [randomUUID(), ownerId, `Fixture ${i}`, task],
        );
      const foreign = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id) VALUES($1,'other-owner','assistant','private content',$2)",
        [foreign, otherTask],
      );
      const seen = new Set<string>();
      let cursor = '';
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({ url: `/api/messages${cursor}`, headers });
        assert.equal(response.statusCode, 200);
        const { messages: rows, hasMore } = response.json();
        assert.equal(rows.length, i === 2 ? 15 : 60);
        assert.equal(hasMore, i !== 2);
        for (const row of rows) {
          assert.ok(!seen.has(row.id));
          assert.notEqual(row.text, 'private content');
          assert.equal(row.task?.title, 'Mine');
          assert.equal(row.task?.costUsd, null);
          seen.add(row.id);
        }
        cursor = `?before=${encodeURIComponent(rows[0].createdAt)}&beforeId=${rows[0].id}`;
      }
      assert.equal(seen.size, 135);
      await pool.query(
        "UPDATE tasks SET source='onboarding',source_id='onboarding:welcome',status='running',created_at=now()-interval '1 day' WHERE id=$1",
        [task],
      );
      for (let index = 0; index < 51; index++)
        await pool.query(
          "INSERT INTO tasks(id,owner_id,title,prompt) VALUES($1,$2,'Newer fixture','Fixture')",
          [randomUUID(), ownerId],
        );
      const state = (await app.inject({ url: '/api/state', headers })).json();
      assert.equal(
        state.tasks.find((candidate: { id: string }) => candidate.id === task)?.showTyping,
        true,
      );
      const olderPage = (await app.inject({ url: '/api/messages', headers })).json();
      assert.ok(
        olderPage.messages.every((row: { task: { showTyping: boolean } }) => row.task.showTyping),
      );
      const message = [...seen][0];
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/messages/${message}/reaction`,
            headers,
            payload: { reaction: 'heart' },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await pool.query('SELECT reaction FROM messages WHERE id=$1', [message])).rows[0].reaction,
        'heart',
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/messages/${foreign}/reaction`,
            headers,
            payload: { reaction: 'heart' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/messages/${message}/reaction`,
            headers,
            payload: { reaction: 'bogus' },
          })
        ).statusCode,
        400,
      );
      assert.equal((await app.inject({ url: `/api/tasks/${task}`, headers })).json().title, 'Mine');
      assert.equal((await app.inject({ url: `/api/tasks/${otherTask}`, headers })).statusCode, 404);
      assert.equal(
        (
          await app.inject({
            url: '/api/messages',
            headers: { ...headers, 'sec-fetch-site': 'cross-site' },
          })
        ).statusCode,
        403,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
