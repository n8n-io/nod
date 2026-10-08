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
import type { AppState, MessageHistoryPage } from '../src/shared/contracts.ts';
import { initialStreamState, streamReducer, type StreamAction } from '../src/web/lib/streams.ts';
import {
  latestChatReadCursor,
  mergeChatReadCursor,
  parseChatReadCursor,
  readChatReadCursor,
  reconcileUnreadChat,
  unreadChatMessageIds,
  writeChatReadCursor,
} from '../src/web/lib/chat-unread.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';

test(
  'web SSE excludes external-channel and background deltas while the shared thread retains every reply',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_stream_${suffix}`;
    const bossSchema = `test_channel_stream_boss_${suffix}`;
    const dataRoot = await mkdtemp(join(tmpdir(), 'otto-channel-stream-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_DATA_ROOT = dataRoot;
    process.env.OTTO_MODE = 'local';
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
      const persisted = (
        await app.inject({ method: 'GET', url: '/api/state', headers })
      ).json<AppState>();
      const history = (
        await app.inject({ method: 'GET', url: '/api/messages', headers })
      ).json<MessageHistoryPage>().messages;
      const expected = modes.map((mode) => mode.marker).sort();
      await t.test('reload and history retain every reply in the shared thread', async () => {
        assert.deepEqual(
          persisted.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.text)
            .sort(),
          expected,
        );
        assert.deepEqual(
          history
            .filter((message) => message.role === 'assistant')
            .map((message) => message.text)
            .sort(),
          expected,
        );
        assert.equal(
          (await db.pool.query("SELECT id FROM messages WHERE role='assistant'")).rowCount,
          modes.length,
        );
        assert.ok(visible.includes('web-reply'));
        assert.equal(
          wire.some((event) => event.type === 'delta' && event.turnId === ids.get('web-reminder')),
          false,
        );
        assert.equal(
          wire.some((event) => event.type === 'delta' && event.turnId === ids.get('web-event')),
          false,
        );
        assert.equal(
          wire.some((event) => 'ownerId' in event || 'channel' in event),
          false,
        );
      });
      const foreignIds = new Set(
        modes.filter((mode) => mode.channel !== 'web').map((mode) => ids.get(mode.marker)),
      );
      await t.test('external-channel task deltas never leave the web SSE response', () => {
        assert.deepEqual(
          wire.filter((event) => event.type === 'delta' && foreignIds.has(String(event.turnId))),
          [],
          'External-channel assistant bytes reached the web SSE response.',
        );
      });
      await t.test('SSE rejects foreign-owner, foreign-destination and unscoped events', () => {
        assert.deepEqual(
          wire.filter((event) =>
            rejectedEvents.some((rejected) => rejected.turnId === event.turnId),
          ),
          [],
        );
      });
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

function unreadMessage(index: number, role: 'user' | 'assistant' = 'assistant') {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    role,
    createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, index)).toISOString(),
    text: 'Synthetic private message that must never enter read-state storage.',
    attachments: [],
    turnId: null,
  };
}

test('chat read cursors distinguish initial history, committed replies and timestamp ties without storing content', () => {
  const initial = [unreadMessage(1), unreadMessage(2, 'user')];
  const cursor = latestChatReadCursor(initial);
  assert.equal(unreadChatMessageIds(initial, cursor).size, 0);
  const tied = { ...unreadMessage(3), createdAt: initial[1].createdAt };
  const messages = [...initial, tied, unreadMessage(4, 'user'), unreadMessage(5), tied];
  assert.deepEqual([...unreadChatMessageIds(messages, cursor)], [tied.id, unreadMessage(5).id]);
  const read = latestChatReadCursor(messages);
  assert.equal(unreadChatMessageIds(messages, read).size, 0);
  assert.deepEqual(mergeChatReadCursor(read, cursor), read);
  assert.deepEqual(
    mergeChatReadCursor(cursor, { createdAt: cursor.createdAt, messageIds: [tied.id] }).messageIds,
    [initial[1].id, tied.id],
  );
  assert.deepEqual(Object.keys(read).sort(), ['createdAt', 'messageIds']);
  assert.ok(!JSON.stringify(read).includes(initial[0].text));
  assert.equal(parseChatReadCursor({ ...read, text: initial[0].text }), null);
  assert.equal(parseChatReadCursor({ createdAt: 'invalid', messageIds: [] }), null);
});

test('chat unread reconciliation includes replies outside the state window and stops at the read cursor or display cap', async () => {
  const cursor = latestChatReadCursor([unreadMessage(2)]);
  const pages = [
    { messages: [unreadMessage(4), unreadMessage(5, 'user')], hasMore: true },
    { messages: [unreadMessage(1), unreadMessage(2), unreadMessage(3)], hasMore: true },
  ];
  const requested: string[] = [];
  const count = await reconcileUnreadChat(
    [unreadMessage(6), unreadMessage(7, 'user')],
    true,
    cursor,
    async (before) => {
      requested.push(before.id);
      return pages.shift()!;
    },
    new AbortController().signal,
    () => {},
  );
  assert.equal(count, 3);
  assert.deepEqual(requested, [unreadMessage(6).id, unreadMessage(4).id]);
  assert.equal(pages.length, 0);
  let cappedLoads = 0;
  assert.equal(
    await reconcileUnreadChat(
      Array.from({ length: 100 }, (_, index) => unreadMessage(index + 3)),
      true,
      cursor,
      async () => {
        cappedLoads++;
        throw new Error('History should not be needed beyond the display cap.');
      },
      new AbortController().signal,
      () => {},
    ),
    100,
  );
  assert.equal(cappedLoads, 0);
  const controller = new AbortController();
  let progress = 0;
  await assert.rejects(
    reconcileUnreadChat(
      [unreadMessage(6)],
      true,
      cursor,
      async () => {
        controller.abort();
        return { messages: [unreadMessage(5)], hasMore: false };
      },
      controller.signal,
      () => progress++,
    ),
    { name: 'AbortError' },
  );
  assert.equal(progress, 0);
});

test('chat read storage and delayed native loads remain scoped to the owner and reset thread', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useChatUnread } = await import('../src/web/hooks/use-chat-unread.ts');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://otto.fixture.test' });
  const globals = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  });
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const threadA = randomUUID();
  const threadB = randomUUID();
  const cursor = latestChatReadCursor([unreadMessage(1)]);
  await writeChatReadCursor(ownerA, threadA, cursor);
  assert.deepEqual(await readChatReadCursor(ownerA, threadA), cursor);
  assert.equal(await readChatReadCursor(ownerB, threadA), null);
  assert.equal(await readChatReadCursor(ownerA, threadB), null);
  assert.ok(
    !dom.window.localStorage
      .getItem(dom.window.localStorage.key(0)!)!
      .includes('Synthetic private'),
  );
  const loads: Array<{ owner: string; thread: string; resolve(value: unknown): void }> = [];
  const saved: Array<{ owner: string; thread: string; cursor: unknown }> = [];
  let failRead = false;
  let failWrite = false;
  Object.assign(dom.window, {
    ottoDesktop: {
      getChatReadCursor: (owner: string, thread: string) =>
        failRead
          ? Promise.reject(new Error('Synthetic saved-state failure'))
          : new Promise((resolve) => loads.push({ owner, thread, resolve })),
      setChatReadCursor: async (owner: string, thread: string, cursor: unknown) => {
        if (failWrite) throw new Error('Synthetic read-position write failure');
        saved.push({ owner, thread, cursor });
      },
    },
  });
  let result!: ReturnType<typeof useChatUnread>;
  function Probe({ owner, state }: { owner: string; state: AppState }) {
    result = useChatUnread(owner, state);
    return null;
  }
  const state = (threadId: string, messages = [unreadMessage(1)]): AppState => ({
    threadId,
    messages,
    turns: [],
    configuration: {
      provider: 'synthetic',
      model: '',
      llmReady: false,
      integrationsReady: false,
      localOnly: true,
      conversationResetEnabled: false,
    },
  });
  await act(async () =>
    root.render(createElement(Probe, { owner: ownerA, state: state(threadA) })),
  );
  await act(async () =>
    root.render(
      createElement(Probe, {
        owner: ownerA,
        state: state(threadA, [unreadMessage(1), unreadMessage(2)]),
      }),
    ),
  );
  await act(async () => loads[0].resolve(cursor));
  assert.equal(result.count, 1);
  const retiredRead = result.markRead;
  await act(async () =>
    root.render(createElement(Probe, { owner: ownerB, state: state(threadB) })),
  );
  await act(async () => retiredRead(threadA));
  assert.equal(saved.length, 0);
  await act(async () =>
    root.render(createElement(Probe, { owner: ownerA, state: state(threadB) })),
  );
  await act(async () => loads[1].resolve(cursor));
  assert.equal(saved.length, 0);
  await act(async () => loads[2].resolve(null));
  assert.equal(result.count, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].owner, ownerA);
  assert.equal(saved[0].thread, threadB);
  await act(async () =>
    root.render(
      createElement(Probe, {
        owner: ownerA,
        state: state(threadB, [unreadMessage(1), unreadMessage(2)]),
      }),
    ),
  );
  assert.equal(result.count, 1);
  await act(async () => result.markRead(threadA));
  assert.equal(result.count, 1);
  await act(async () => result.markRead(threadB));
  assert.equal(result.count, 0);
  assert.ok(!JSON.stringify(saved).includes('Synthetic private'));
  failRead = true;
  const writes = saved.length;
  const threadC = randomUUID();
  await act(async () =>
    root.render(
      createElement(Probe, {
        owner: ownerA,
        state: state(threadC, [unreadMessage(1), unreadMessage(2)]),
      }),
    ),
  );
  assert.equal(result.pending, true);
  assert.equal(saved.length, writes);
  failRead = false;
  await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
  await act(async () => loads.at(-1)!.resolve(cursor));
  assert.equal(result.count, 1);
  assert.equal(result.pending, false);
  assert.equal(saved.length, writes);
  failWrite = true;
  await act(async () => result.markRead(threadC));
  assert.equal(result.count, 1);
  assert.equal(result.pending, true);
  assert.equal(saved.length, writes);
  failWrite = false;
  await act(async () => dom.window.dispatchEvent(new dom.window.Event('online')));
  await act(async () => loads.at(-1)!.resolve(cursor));
  assert.equal(result.count, 0);
  assert.equal(result.pending, false);
  assert.equal(saved.length, writes + 1);
  assert.equal(saved.at(-1)!.owner, ownerA);
  assert.equal(saved.at(-1)!.thread, threadC);
  assert.deepEqual(saved.at(-1)!.cursor, latestChatReadCursor([unreadMessage(2)]));
});
