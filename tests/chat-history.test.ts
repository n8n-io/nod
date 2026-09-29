import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type { AppState, MessageHistoryPage } from '../src/shared/contracts.ts';

test(
  'state and history report earlier messages only when they exist',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_chat_history_${suffix}`;
    const bossSchema = `test_chat_history_boss_${suffix}`;
    const dataRoot = await mkdtemp(join(tmpdir(), 'otto-chat-history-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const cleanups: Array<() => Promise<unknown>> = [
      () => rm(dataRoot, { recursive: true, force: true }),
      () => admin.end(),
      () => admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      () => admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`),
    ];
    const errors: unknown[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
      databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
      process.env.DATABASE_URL = databaseUrl.href;
      process.env.PGBOSS_SCHEMA = bossSchema;
      process.env.OTTO_DATA_ROOT = dataRoot;
      process.env.OTTO_MODE = 'local';
      const db = await import('../src/server/db.ts');
      cleanups.push(() => db.pool.end());
      const tasks = await import('../src/server/tasks.ts');
      cleanups.push(() => tasks.stopTasks());
      const { createApp } = await import('../src/server/app.ts');
      const { ownerId, port } = await import('../src/server/config.ts');
      const app = await createApp();
      cleanups.push(() => app.close());
      const headers = { host: `localhost:${port}` };
      const get = async <T>(url: string) => {
        const response = await app.inject({ method: 'GET', url, headers });
        assert.equal(
          response.statusCode,
          200,
          `${url} -> ${response.statusCode}: ${response.body}`,
        );
        return response.json<T>();
      };
      const add = async (taskId: string, count: number, start: number) =>
        db.pool.query(
          `INSERT INTO messages(id,owner_id,role,text,task_id,created_at)
         SELECT gen_random_uuid(),$1,'assistant','Synthetic '||n,$2,timestamptz '2026-09-01T00:00:00Z'+n*interval '1 second'
         FROM generate_series($3::int,$3::int+$4::int-1) n`,
          [ownerId, taskId, start, count],
        );
      await db.initializeDatabase();
      await tasks.initializeTasks();
      const taskId = await tasks.submitTask('Synthetic history');
      await db.pool.query('UPDATE messages SET created_at=$2 WHERE task_id=$1', [
        taskId,
        '2026-08-31T00:00:00Z',
      ]);
      let state = await get<AppState>('/api/state');
      assert.equal(state.messages.length, 1);
      assert.equal(state.hasEarlierMessages, false);
      await add(taskId, 149, 1);
      state = await get<AppState>('/api/state');
      assert.equal(state.messages.length, 150);
      assert.equal(state.hasEarlierMessages, false);
      await add(taskId, 60, 150);
      state = await get<AppState>('/api/state');
      assert.equal(state.messages.length, 150);
      assert.equal(state.hasEarlierMessages, true);
      assert.equal(state.messages[0].text, 'Synthetic 60');
      assert.equal(state.messages.at(-1)!.text, 'Synthetic 209');
      const first = state.messages[0];
      const query = new URLSearchParams({ before: first.createdAt, beforeId: first.id });
      const page = await get<MessageHistoryPage>(`/api/messages?${query}`);
      assert.equal(page.messages.length, 60);
      assert.equal(page.hasMore, false);
      assert.equal(page.messages[0].text, 'Synthetic history');
      assert.equal(page.messages.at(-1)!.text, 'Synthetic 59');
      await add(taskId, 1, -1);
      const longer = await get<MessageHistoryPage>(`/api/messages?${query}`);
      assert.equal(longer.messages.length, 60);
      assert.equal(longer.hasMore, true);
    } catch (error) {
      errors.push(error);
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, 'History fixture or cleanup failed.', { cause: errors[0] });
  },
);
