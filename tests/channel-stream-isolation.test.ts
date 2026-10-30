import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RuntimeContext, RuntimeResult } from '../src/ports/agent.ts';
import { initialStreamState, streamReducer, type StreamAction } from '../src/web/lib/streams.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';

test(
  'web SSE excludes external-channel and background deltas while the shared thread retains every reply',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_stream_${suffix}`;
    const bossSchema = `test_channel_stream_boss_${suffix}`;
    const dataRoot = await mkdtemp(join(tmpdir(), 'nod-channel-stream-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.NOD_DATA_ROOT = dataRoot;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { port } = await import('../src/server/config.ts');
    const { events } = await import('../src/server/events.ts');
    const contexts = new Map<string, RuntimeContext>();
    const releases = new Map<string, (value: RuntimeResult) => void>();
    const app = await createApp();
    const controller = new AbortController();
    const wire: Array<Record<string, unknown>> = [];
    const visible: string[] = [];
    let streamState = initialStreamState;
    let read: Promise<void> | undefined;
    const waitFor = async (condition: () => boolean | Promise<boolean>) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await condition()) return;
        await delay(10);
      }
      assert.fail('The synthetic stream did not reach its expected boundary.');
    };
    const headers = {
      host: `localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      const personal = createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: thread.boss,
        enqueueTurn: thread.enqueueTurn,
        refresh() {},
      });
      await personal.initialize({ workers: false });
      await thread.startThreadWorkers({
        browserStep: async () => 'run',
        async runTurn(context) {
          contexts.set(context.turnId, context);
          return new Promise<RuntimeResult>((resolve) => releases.set(context.turnId, resolve));
        },
        speech: {
          synthesize: async () => {
            throw new Error('Unused fixture');
          },
        },
        requestCredential: async () => {
          throw new Error('Unused fixture');
        },
        integration: async () => {
          throw new Error('Unused fixture');
        },
        manage: async () => {
          throw new Error('Unused fixture');
        },
      });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(`${origin}/api/events`, { headers, signal: controller.signal }, resolve).on(
          'error',
          reject,
        );
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
      read = (async () => {
        const decoder = new TextDecoder();
        let pending = '';
        for await (const chunk of response) {
          pending += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (!frame.startsWith('data: ')) continue;
            const event = JSON.parse(frame.slice(6)) as Record<string, unknown>;
            wire.push(event);
            if (event.type === 'delta') {
              streamState = streamReducer(streamState, event as StreamAction);
              visible.push(...Object.values(streamState.active).map((stream) => stream.text));
            }
          }
        }
      })().catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
      await waitFor(() => wire.some((event) => event.type === 'refresh'));
      const modes = [
        { channel: 'telegram:account_one:sender_one', source: 'user', marker: 'telegram-one' },
        { channel: 'telegram:account_two:sender_two', source: 'user', marker: 'telegram-two' },
        { channel: 'whatsapp:account_one:sender_one', source: 'user', marker: 'whatsapp-one' },
        { channel: 'web', source: 'schedule', marker: 'web-reminder' },
        { channel: 'web', source: 'event', marker: 'web-event' },
        { channel: 'web', source: 'user', marker: 'web-reply' },
      ] as const;
      const ids = new Map<string, string>();
      const rejectedEvents = [
        { ownerId: 'another-owner', channel: 'web' },
        { ownerId: 'local-development', channel: 'web:another-conversation' },
        { ownerId: 'local-development', channel: 'telegram:another-conversation' },
        { channel: 'web' },
        { ownerId: 'local-development' },
      ].map((routing, index) => ({
        type: 'delta',
        threadId: randomUUID(),
        turnId: randomUUID(),
        text: `rejected-stream-${index}`,
        streamId: `rejected-stream-${index}`,
        ...routing,
      }));
      for (const mode of modes) {
        const id =
          mode.source === 'user'
            ? (
                await thread.submitUserMessage(`Synthetic ${mode.marker}`, [], {
                  channel: mode.channel,
                })
              ).turnId
            : await thread.enqueueTurn(`Synthetic ${mode.marker}`, {
                source: mode.source,
                channel: mode.channel,
              });
        ids.set(mode.marker, id);
        await waitFor(() => contexts.has(id));
        const context = contexts.get(id)!;
        if (mode.marker === 'web-reply')
          for (const event of rejectedEvents) events.emit('event', event as never);
        context.delta(mode.marker, `stream-${mode.marker}`);
        await context.reply(mode.marker, `stream-${mode.marker}`);
        context.delta('', `stream-${mode.marker}`, true);
        releases.get(id)!({ status: 'succeeded' });
        await waitFor(
          async () =>
            (await db.pool.query('SELECT status FROM turns WHERE id=$1', [id])).rows[0]?.status ===
            'succeeded',
        );
      }
      await waitFor(() =>
        wire.some((event) => event.streamId === 'stream-web-reply' && event.done),
      );
    } finally {
      controller.abort();
      try {
        await read;
      } finally {
        for (const release of releases.values()) release({ status: 'succeeded' });
        await app.close();
        await thread.stopThreadWorkers();
        await db.pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
        await rm(dataRoot, { recursive: true, force: true });
      }
    }
  },
);
