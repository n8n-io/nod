import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext, RuntimeResult } from '../src/ports/agent.ts';

test(
  'task progress contains useful agent replies without timed filler',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_progress_${suffix}`;
    const bossSchema = `test_progress_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createPreferencesStore } = await import('../src/server/preferences.ts');
    const { dataRoot } = await import('../src/server/config.ts');
    const personal = createPersonalService({
      pool: db.pool,
      ownerId: 'local-development',
      scheduler: tasks.boss,
      submitTask: tasks.submitTask,
      refresh() {},
    });
    const contexts = new Map<string, RuntimeContext>();
    const releases = new Map<string, (result: RuntimeResult) => void>();
    let releaseDownload: (() => void) | undefined;
    const silentTimers: Array<() => void> = [];
    const nativeSetTimeout = globalThis.setTimeout;
    t.mock.method(
      globalThis,
      'setTimeout',
      (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
        if (milliseconds !== 8000) return nativeSetTimeout(callback, milliseconds, ...args);
        const timer = nativeSetTimeout(() => {}, 20 * 60_000);
        silentTimers.push(() => {
          clearTimeout(timer);
          callback(...args);
        });
        return timer;
      },
    );
    const passQuietWindow = async () => {
      for (const fire of silentTimers.splice(0)) fire();
      await delay(50);
    };
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let index = 0; index < 250; index++) {
        if (await check()) return;
        await delay(10);
      }
      throw new Error('Fixture condition did not complete.');
    };
    const messages = async (taskId: string) =>
      (
        await db.pool.query(
          "SELECT * FROM messages WHERE task_id=$1 AND role='assistant' ORDER BY created_at",
          [taskId],
        )
      ).rows;
    const begin = async (
      prompt: string,
      options: { channel?: string; source?: 'user' | 'event' } = {},
    ) => {
      const id = await tasks.submitTask(prompt, [], undefined, false, options);
      await waitFor(() => contexts.has(id));
      return { id, context: contexts.get(id)! };
    };
    const finish = async (id: string, status: RuntimeResult['status'] = 'succeeded') => {
      releases.get(id)?.({ status });
      await waitFor(
        async () =>
          (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0]?.status ===
          status,
      );
    };
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await personal.initialize({ workers: false });
      await tasks.startTaskWorkers({
        async runTask(context) {
          contexts.set(context.taskId, context);
          return new Promise<RuntimeResult>((resolve) => releases.set(context.taskId, resolve));
        },
        speech: {
          async synthesize() {
            throw new Error('Unused fixture');
          },
        },
        async requestCredential() {
          return { url: '/vault/synthetic-step' };
        },
        async integration() {
          return {};
        },
        async downloadIntegrationFile(_id, _action, args) {
          if (args.delayed)
            await new Promise<void>((resolve) => {
              releaseDownload = resolve;
            });
          return {
            name: 'invoice.csv',
            mimeType: 'TEXT/CSV',
            bytes: Buffer.from(
              args.large ? 'invoice,total\n'.repeat(1000) : 'invoice,total\nNS-1042,240\n',
            ),
          };
        },
        async manage() {
          return {};
        },
      });
      await t.test(
        'web, Telegram and background execution never invent a progress message',
        async () => {
          for (const mode of ['web', 'telegram', 'background']) {
            const { id, context } = await begin('Check the requested document', {
              channel: mode === 'telegram' ? 'telegram:fixture' : 'web',
              source: mode === 'background' ? 'event' : 'user',
            });
            context.delta('Unfinished model draft.', 'fixture-stream');
            await context.emit('tool_start', 'Read document');
            await passQuietWindow();
            assert.equal((await messages(id)).length, 0);
            await context.reply('The document is available. I’m checking its two attachments.');
            assert.deepEqual(
              (await messages(id)).map((message) => message.text),
              ['The document is available. I’m checking its two attachments.'],
            );
            await finish(id);
            await passQuietWindow();
            assert.equal((await messages(id)).length, 1);
          }
        },
      );
      await t.test(
        'a cancelled or replaced segment cannot publish a late progress reply',
        async () => {
          for (const mode of ['cancelled', 'replaced']) {
            const { id, context } = await begin(mode);
            if (mode === 'cancelled') await tasks.cancelTask(id);
            else
              await db.pool.query(
                "UPDATE tasks SET revision=revision+1,status='cancelled' WHERE id=$1",
                [id],
              );
            await assert.rejects(context.reply('Late progress'));
            releases.get(id)!({ status: 'succeeded' });
            await passQuietWindow();
            assert.equal((await messages(id)).length, 0);
          }
        },
      );
      await t.test(
        'account files use private owned artifacts and cancellation prevents late delivery',
        async () => {
          const first = await begin('Retrieve the file');
          const artifact = await first.context.downloadIntegrationFile!('GMAIL_GET_ATTACHMENT', {});
          assert.equal(artifact.content, 'invoice,total\nNS-1042,240\n');
          const stored = (
            await db.pool.query('SELECT owner_id,task_id,storage_path FROM artifacts WHERE id=$1', [
              artifact.id,
            ])
          ).rows[0];
          assert.equal(stored.owner_id, 'local-development');
          assert.equal(stored.task_id, first.id);
          assert.equal(JSON.stringify(artifact).includes('storage_path'), false);
          const { content: _content, ...savedArtifact } = artifact;
          assert.deepEqual((await messages(first.id))[0].attachments, [savedArtifact]);
          assert.equal((await messages(first.id))[0].text, '');
          await finish(first.id);
          const large = await begin('Retrieve a large file');
          const largeArtifact = await large.context.downloadIntegrationFile!(
            'GMAIL_GET_ATTACHMENT',
            {
              large: true,
            },
          );
          assert.equal(largeArtifact.content, undefined);
          await finish(large.id);
          const late = await begin('Retrieve a delayed file');
          const pending = late.context.downloadIntegrationFile!('GMAIL_GET_ATTACHMENT', {
            delayed: true,
          });
          await waitFor(() => Boolean(releaseDownload));
          await tasks.cancelTask(late.id);
          const rejected = assert.rejects(pending);
          releaseDownload!();
          await rejected;
          assert.equal((await messages(late.id)).length, 0);
          assert.equal(
            (await db.pool.query('SELECT id FROM artifacts WHERE task_id=$1', [late.id])).rowCount,
            0,
          );
          releases.get(late.id)!({ status: 'succeeded' });
        },
      );
      await t.test(
        'persisted browser IANA preferences enter task context and retain schedule wall-clock time',
        async () => {
          const preferences = createPreferencesStore(db.pool, 'local-development');
          await preferences.update({ timeZone: 'America/New_York' });
          const { id, context } = await begin('saved-timezone');
          assert.equal(context.timeZone, 'America/New_York');
          const schedule = await personal.manage('schedule_create', {
            title: 'Synthetic morning',
            prompt: 'Fixture',
            cron: '0 9 * * 1-5',
            timeZone: context.timeZone,
          });
          assert.equal((schedule as { timeZone: string }).timeZone, 'America/New_York');
          assert.equal((schedule as { cron: string }).cron, '0 9 * * 1-5');
          await finish(id);
        },
      );
    } finally {
      for (const release of releases.values()) release({ status: 'succeeded' });
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map((row) => row.id as string);
      const artifacts = (await db.pool.query('SELECT storage_path FROM artifacts')).rows;
      await db.pool.end();
      for (const artifact of artifacts) await rm(artifact.storage_path, { force: true });
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
