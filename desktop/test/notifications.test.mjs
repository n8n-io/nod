import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createChatReadCursorStore } from '../main/chat-read-cursors.mjs';
import {
  assistantNotificationPreview,
  createReadinessNotice,
  createUnreadBadge,
  isQuietTime,
  watchAssistantMessages,
} from '../main/notifications.mjs';

test('readiness notices require an observed preparation and durable opt-in, then send once', async () => {
  let notices = 0;
  const notice = createReadinessNotice({
    notify: async () => {
      notices++;
      return true;
    },
  });
  let state = {
    runtimePhase: 'ready',
    guided: true,
    enabled: true,
    foreground: false,
    quitting: false,
    completed: false,
    engineReady: false,
  };
  await notice.update(state);
  assert.equal(notices, 0);
  state = { ...state, runtimePhase: 'preparing', enabled: false, foreground: true };
  await notice.update(state);
  state = { ...state, runtimePhase: 'ready' };
  await notice.update(state);
  await notice.update({ ...state, foreground: false });
  assert.equal(notices, 0);
  state = { ...state, enabled: true, foreground: false };
  await Promise.all([notice.update(state), notice.update(state), notice.update(state)]);
  assert.equal(notices, 1);
  await notice.update({ ...state, completed: true, engineReady: true });
  await notice.update({ ...state, completed: false, engineReady: true });
  assert.equal(notices, 1);
});

test('notification previews extract readable message text without link targets or hidden markup', () => {
  const preview = assistantNotificationPreview({
    text: '## **Your report is ready**\n\nRead [the summary](https://example.test/private?token=synthetic-link-secret) and `review.csv`.\n<!--hidden comment--><script>hidden script</script>',
    replyTo: { text: 'synthetic-private-quoted-message' },
  });
  assert.ok(preview.includes('Your report is ready'));
  assert.ok(preview.includes('the summary'));
  for (const value of [
    'synthetic-link-secret',
    'hidden comment',
    'hidden script',
    'synthetic-private-quoted-message',
  ])
    assert.ok(!preview.includes(value));
  const attachment = assistantNotificationPreview({
    text: '',
    attachments: [
      { name: 'quarterly-report.csv', url: '/api/artifacts/synthetic-capability-token' },
    ],
  });
  assert.ok(attachment.includes('quarterly-report.csv'));
  assert.ok(!attachment.includes('synthetic-capability-token'));
});

test('notification previews redact configured credentials after decoding formatting', () => {
  const known = 'synthetic-notification-secret/123456=';
  const encoded = [...known].map((character) => `&#${character.codePointAt(0)};`).join('');
  for (const input of [known, encodeURIComponent(known), encoded]) {
    const preview = assistantNotificationPreview({ text: `Result: ${input}` }, new Set([known]));
    assert.ok(!preview.includes(known));
    assert.ok(!preview.includes(encodeURIComponent(known)));
    assert.ok(preview.includes('[redacted]'));
  }
});

test('quiet hours suppress the configured interval with inclusive start and exclusive end', () => {
  const preferences = {
    quietHoursEnabled: true,
    timeZone: 'UTC',
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  for (const [time, expected] of [
    ['21:59', false],
    ['22:00', true],
    ['23:59', true],
    ['00:00', true],
    ['07:59', true],
    ['08:00', false],
  ])
    assert.equal(isQuietTime(preferences, new Date(`2026-10-02T${time}:00Z`)), expected, time);
  const daytime = { ...preferences, quietStart: '09:00', quietEnd: '17:00' };
  for (const [time, expected] of [
    ['08:59', false],
    ['09:00', true],
    ['16:59', true],
    ['17:00', false],
    ['23:00', false],
  ])
    assert.equal(isQuietTime(daytime, new Date(`2026-10-02T${time}:00Z`)), expected, time);
  assert.equal(
    isQuietTime({ ...preferences, quietHoursEnabled: false }, new Date('2026-10-02T23:00:00Z')),
    false,
  );
  assert.equal(
    isQuietTime({ ...preferences, quietEnd: '22:00' }, new Date('2026-10-02T22:00:00Z')),
    false,
  );
});

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await nextTurn();
  assert.ok(predicate());
}

function fixture(t, onState) {
  const streams = [];
  const snapshots = [];
  const threadId = 'synthetic-thread-1';
  let messages = [{ id: 'historical-assistant', role: 'assistant' }];
  const delivered = [];
  const threads = [];
  const stop = watchAssistantMessages({
    retryMs: 1,
    onState,
    onMessage: (message, threadId) => {
      delivered.push(message);
      threads.push(threadId);
    },
    request: async (path, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (path === '/api/state') {
        snapshots.push(messages);
        return Response.json({ threadId, messages });
      }
      assert.equal(path, '/api/events');
      const stream = { signal: options.signal };
      const body = new ReadableStream({
        start(controller) {
          stream.controller = controller;
          options.signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      streams.push(stream);
      return new Response(body);
    },
  });
  t.after(stop);
  return {
    streams,
    snapshots,
    stop,
    delivered,
    threads,
    get notifications() {
      return delivered.length;
    },
    messages(value) {
      messages = value;
    },
    send(...chunks) {
      for (const chunk of chunks)
        streams.at(-1).controller.enqueue(new TextEncoder().encode(chunk));
    },
  };
}

test('assistant notifications use committed messages without history, delta, or duplicate alerts', async (t) => {
  const f = fixture(t);
  await eventually(() => f.snapshots.length === 1);
  assert.equal(f.notifications, 0);
  f.messages([
    { id: 'historical-assistant', role: 'assistant' },
    { id: 'new-user', role: 'user' },
  ]);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => f.snapshots.length === 2);
  assert.equal(f.notifications, 0);
  f.messages([
    { id: 'historical-assistant', role: 'assistant' },
    { id: 'new-user', role: 'user' },
    { id: 'new-assistant', role: 'assistant', text: 'Synthetic committed result', attachments: [] },
  ]);
  f.send('data: {"type":"delta","text":"not a committed message"}\n\n');
  f.send('data: {"type":"refresh"}\r', '\n\r', '\n');
  await eventually(() => f.notifications === 1);
  assert.equal(f.delivered[0].id, 'new-assistant');
  assert.deepEqual(f.threads, ['synthetic-thread-1']);
  assert.equal(f.snapshots.length, 3);
  f.send('data: {"type":"refresh"}\n\n', 'data: {"type":"refresh"}\n\n');
  await eventually(() => f.snapshots.length === 5);
  await nextTurn();
  assert.equal(f.notifications, 1);
  f.stop();
  assert.equal(f.streams[0].signal.aborted, true);
});

test('notification reconnect reconciles missed messages and stop aborts subscription', async (t) => {
  const f = fixture(t);
  await eventually(() => f.snapshots.length === 1);
  f.messages([
    { id: 'historical-assistant', role: 'assistant' },
    { id: 'earlier-while-disconnected', role: 'assistant', text: 'Earlier synthetic update' },
    {
      id: 'received-while-disconnected',
      role: 'assistant',
      text: 'Latest synthetic update',
      attachments: [{ name: 'result.csv' }],
    },
  ]);
  f.streams[0].controller.close();
  await eventually(() => f.streams.length === 2 && f.notifications === 1);
  assert.equal(f.delivered[0].id, 'received-while-disconnected');
  assert.deepEqual(f.threads, ['synthetic-thread-1']);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => f.snapshots.length === 3);
  f.stop();
  assert.ok(f.streams.every(({ signal }) => signal.aborted));
  await nextTurn();
  assert.equal(f.notifications, 1);
});

test('notification state is available on startup and reconnect without blocking or duplicating alerts', async (t) => {
  const states = [];
  const f = fixture(t, (state) => {
    states.push(state);
    return states.length === 1 ? new Promise(() => {}) : Promise.reject(new Error('Unavailable'));
  });
  await eventually(() => states.length === 1);
  f.messages([
    ...states[0].messages,
    { id: 'new-assistant', role: 'assistant', text: 'Synthetic update' },
  ]);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => states.length === 2 && f.notifications === 1);
  f.streams[0].controller.close();
  await eventually(() => states.length === 3);
  assert.equal(f.notifications, 1);
  assert.ok(states.every((state) => state.threadId === 'synthetic-thread-1'));
});

function message(index, role = 'assistant', createdAt) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    role,
    createdAt: createdAt ?? new Date(Date.UTC(2026, 9, 27, 12, 0, index)).toISOString(),
  };
}

function position(...messages) {
  return {
    createdAt: messages.at(-1)?.createdAt ?? '1970-01-01T00:00:00.000Z',
    messageIds: messages.map((value) => value.id),
  };
}

function snapshot(messages, hasEarlierMessages = false, threadId = 'synthetic-thread-1') {
  return { threadId, messages, hasEarlierMessages };
}

function unreadFixture(t, options = {}) {
  const saved = new Map(options.cursor ? [['synthetic-thread-1', options.cursor]] : []);
  const counts = [];
  const writes = [];
  const badge = createUnreadBadge({
    request: async () => {
      throw new Error('Unexpected history request');
    },
    readCursor: async (threadId) => saved.get(threadId) ?? null,
    writeCursor: async (threadId, cursor) => {
      writes.push({ threadId, cursor });
      saved.set(threadId, cursor);
    },
    ...options,
    onCount: (count) => counts.push(count),
  });
  t.after(() => badge.stop());
  return { badge, counts, writes, saved };
}

test('unread badges ignore first-run history and count committed assistant messages until read', async (t) => {
  const historical = message(1);
  const f = unreadFixture(t);
  await f.badge.update(snapshot([historical]));
  assert.deepEqual(f.counts, [0]);
  assert.deepEqual(f.writes, [{ threadId: 'synthetic-thread-1', cursor: position(historical) }]);
  const sameTime = message(2, 'assistant', historical.createdAt);
  const user = message(3, 'user');
  const assistant = message(4);
  await f.badge.update(snapshot([historical, sameTime, user, assistant, assistant]));
  await f.badge.update(snapshot([historical, sameTime, user, assistant]));
  assert.deepEqual(f.counts, [0, 2]);
  f.saved.set('synthetic-thread-1', position(assistant));
  await f.badge.refresh();
  assert.deepEqual(f.counts, [0, 2, 0]);
  assert.equal(f.writes.length, 1);
});

test('unread badges preserve their count through a runtime restart using a reopened durable cursor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-unread-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = message(500).id;
  const thread = message(501).id;
  const counts = [];
  function open(
    request = async () => {
      throw new Error('Unexpected history request');
    },
    initialCount,
  ) {
    const cursors = createChatReadCursorStore(join(directory, 'read.json'), {
      owner: async () => owner,
    });
    const badge = createUnreadBadge({
      request,
      initialCount,
      readCursor: (threadId) => cursors.get(owner, threadId),
      writeCursor: (threadId, cursor) => cursors.set(owner, threadId, cursor),
      onCount: (count) => counts.push(count),
    });
    t.after(() => badge.stop());
    return { badge, cursors };
  }
  const first = open();
  await first.badge.update(snapshot([message(1)], false, thread));
  await first.badge.update(snapshot([message(1), message(2), message(3)], false, thread));
  await first.cursors.set(owner, thread, position(message(3)));
  first.badge.stop({ clear: false });
  assert.deepEqual(counts, [0, 2]);
  assert.equal(first.badge.count, 2);
  let resume;
  let requested = false;
  let failed = true;
  const history = new Promise((resolve) => {
    resume = resolve;
  });
  const restarted = open(async () => {
    requested = true;
    await history;
    if (failed) throw new Error('Offline');
    return Response.json({ messages: [message(1), message(2), message(3)], hasMore: false });
  }, first.badge.count);
  const pending = restarted.badge.update(snapshot([message(4)], true, thread));
  await eventually(() => requested);
  assert.deepEqual(counts, [0, 2]);
  const rejected = assert.rejects(pending, /Offline/);
  resume();
  await rejected;
  assert.deepEqual(counts, [0, 2]);
  assert.equal(restarted.badge.count, 2);
  failed = false;
  await restarted.badge.refresh();
  assert.deepEqual(counts, [0, 2, 1]);
  await restarted.cursors.set(owner, thread, position(message(4)));
  await restarted.badge.refresh();
  assert.equal(counts.at(-1), 0);
});

test('unread badge initialization keeps the first snapshot while persistence is pending', async (t) => {
  let release;
  let saved = null;
  const writes = [];
  const f = unreadFixture(t, {
    readCursor: async () => saved,
    writeCursor: async (threadId, cursor) => {
      writes.push({ threadId, cursor });
      await new Promise((resolve) => {
        release = resolve;
      });
      saved = cursor;
    },
  });
  const first = f.badge.update(snapshot([message(1)]));
  await eventually(() => release);
  const next = f.badge.update(snapshot([message(1), message(2)]));
  await nextTurn();
  release();
  await Promise.all([first, next]);
  assert.deepEqual(writes, [{ threadId: 'synthetic-thread-1', cursor: position(message(1)) }]);
  assert.deepEqual(f.counts, [1]);
});

test('unread badge initialization honors a read saved while its baseline is being written', async (t) => {
  let release;
  let saved = null;
  const f = unreadFixture(t, {
    readCursor: async () => saved,
    writeCursor: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = f.badge.update(snapshot([message(1)]));
  await eventually(() => release);
  const next = f.badge.update(snapshot([message(1), message(2)]));
  saved = position(message(2));
  release();
  await Promise.all([first, next]);
  assert.deepEqual(f.counts, [0]);
});

test('unread badges reconcile history with timestamp and ID pagination, stop at read history, and cap at 100', async (t) => {
  const timestamp = message(1).createdAt;
  const sameTime = Array.from({ length: 5 }, (_, index) =>
    message(index + 1, 'assistant', timestamp),
  );
  const queries = [];
  const f = unreadFixture(t, {
    cursor: position(sameTime[0]),
    request: async (path, options) => {
      const query = new URL(path, 'http://localhost').searchParams;
      queries.push(Object.fromEntries(query));
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ messages: sameTime.slice(0, 3), hasMore: false });
    },
  });
  await f.badge.update(snapshot(sameTime.slice(3), true));
  assert.equal(f.counts.at(-1), 4);
  assert.deepEqual(queries, [
    {
      threadId: 'synthetic-thread-1',
      before: timestamp,
      beforeId: sameTime[3].id,
    },
  ]);
  await f.badge.update(snapshot([message(0), ...sameTime], true));
  assert.equal(queries.length, 1);
  await f.badge.update(
    snapshot(
      Array.from({ length: 101 }, (_, index) => message(index + 10)),
      true,
    ),
  );
  assert.equal(f.counts.at(-1), 100);
  assert.equal(queries.length, 1);
});

test('unread badges publish known unread messages while older history is pending or unavailable', async (t) => {
  let reject;
  const f = unreadFixture(t, {
    cursor: position(message(1)),
    request: () =>
      new Promise((resolve, rejectRequest) => {
        reject = rejectRequest;
      }),
  });
  const pending = f.badge.update(snapshot([message(2), message(3)], true));
  await eventually(() => reject);
  assert.deepEqual(f.counts, [2]);
  const failed = assert.rejects(pending, /Offline/);
  reject(new Error('Offline'));
  await failed;
  assert.deepEqual(f.counts, [2]);
});

test('unread badges retain the last count on failed history and reject pagination that does not advance', async (t) => {
  let page;
  const f = unreadFixture(t, {
    cursor: position(message(1)),
    request: async () => (page instanceof Error ? Promise.reject(page) : Response.json(page)),
  });
  await f.badge.update(snapshot([message(2), message(3)]));
  page = new Error('Offline');
  await assert.rejects(f.badge.update(snapshot([message(3)], true)), /Offline/);
  assert.equal(f.counts.at(-1), 2);
  for (const invalid of [
    { messages: [message(3)], hasMore: true },
    { messages: [message(4)], hasMore: false },
    { messages: [], hasMore: true },
  ]) {
    page = invalid;
    await assert.rejects(f.badge.refresh(), /did not advance/);
    assert.equal(f.counts.at(-1), 2);
  }
});

test('unread badges do not replace an unreadable saved cursor with a new baseline', async (t) => {
  let unavailable = false;
  const f = unreadFixture(t, {
    readCursor: async () => {
      if (unavailable) throw new Error('Read state unavailable');
      return position(message(1));
    },
  });
  await f.badge.update(snapshot([message(2)]));
  unavailable = true;
  await assert.rejects(
    f.badge.update(snapshot([message(2), message(3)])),
    /Read state unavailable/,
  );
  assert.deepEqual(f.counts, [1]);
  assert.deepEqual(f.writes, []);
});

test('refresh invalidates a cursor read and pagination started before the conversation was read', async (t) => {
  let releaseRead;
  let pendingRead = true;
  let cursor = position(message(1));
  let releasePage;
  let pageSignal;
  let requests = 0;
  const f = unreadFixture(t, {
    readCursor: async () => {
      const selected = cursor;
      if (pendingRead) {
        pendingRead = false;
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
      }
      return selected;
    },
    request: async (path, { signal }) => {
      if (requests++) return Response.json({ messages: [message(2)], hasMore: false });
      pageSignal = signal;
      return new Promise((resolve) => {
        releasePage = () => resolve(Response.json({ messages: [message(2)], hasMore: false }));
      });
    },
  });
  const reading = f.badge.update(snapshot([message(3)]));
  await eventually(() => releaseRead);
  cursor = position(message(3));
  await f.badge.refresh();
  releaseRead();
  await reading;
  assert.deepEqual(f.counts, [0]);
  cursor = position(message(1));
  const paging = f.badge.update(snapshot([message(3)], true));
  await eventually(() => releasePage);
  cursor = position(message(3));
  await f.badge.refresh();
  assert.equal(pageSignal.aborted, true);
  releasePage();
  await paging;
  assert.deepEqual(f.counts, [0, 1, 0]);
});

test('thread reset clears its badge and fences delayed history from the previous conversation', async (t) => {
  let release;
  let signal;
  const f = unreadFixture(t, {
    cursor: position(message(1)),
    request: async (path, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        release = () => resolve(Response.json({ messages: [message(2)], hasMore: false }));
      });
    },
  });
  await f.badge.update(snapshot([message(3)]));
  const pending = f.badge.update(snapshot([message(3)], true));
  await eventually(() => release);
  await f.badge.update(snapshot([message(4)], false, 'synthetic-thread-2'));
  assert.equal(signal.aborted, true);
  assert.deepEqual(f.counts, [1, 0]);
  release();
  await pending;
  assert.deepEqual(f.counts, [1, 0]);
  assert.deepEqual(f.writes, [{ threadId: 'synthetic-thread-2', cursor: position(message(4)) }]);
});

test('runtime interruption retains unread messages and fences delayed cursor reads and history', async (t) => {
  for (const phase of ['read', 'history']) {
    let release;
    let signal;
    let pauseRead = false;
    const f = unreadFixture(t, {
      readCursor: async () => {
        if (pauseRead)
          await new Promise((resolve) => {
            release = resolve;
          });
        return position(message(1));
      },
      request: async (path, options) => {
        signal = options.signal;
        await new Promise((resolve) => {
          release = resolve;
        });
        return Response.json({ messages: [message(2)], hasMore: false });
      },
    });
    await f.badge.update(snapshot([message(3)]));
    assert.deepEqual(f.counts, [1]);
    pauseRead = phase === 'read';
    const pending = f.badge.update(
      snapshot(phase === 'read' ? [message(3), message(4)] : [message(3)], phase === 'history'),
    );
    await eventually(() => release);
    f.badge.stop({ clear: false });
    if (signal) assert.equal(signal.aborted, true);
    assert.deepEqual(f.counts, [1]);
    release();
    await pending;
    await f.badge.update(snapshot([message(3), message(4)]));
    await f.badge.refresh();
    assert.deepEqual(f.counts, [1]);
    f.badge.stop();
    f.badge.stop();
    assert.deepEqual(f.counts, [1, 0]);
  }
});

test('stopping unread badges fences delayed cursor reads, baseline writes, and history', async (t) => {
  for (const phase of ['read', 'write', 'history']) {
    let release;
    let signal;
    const f = unreadFixture(t, {
      readCursor: async () => {
        if (phase === 'read')
          await new Promise((resolve) => {
            release = resolve;
          });
        return phase === 'write' ? null : position(message(1));
      },
      writeCursor: async () => {
        await new Promise((resolve) => {
          release = resolve;
        });
      },
      request: async (path, options) => {
        signal = options.signal;
        await new Promise((resolve) => {
          release = resolve;
        });
        return Response.json({ messages: [message(2)], hasMore: false });
      },
    });
    const pending = f.badge.update(snapshot([message(3)], true));
    await eventually(() => release);
    f.badge.stop();
    const stopped = [...f.counts];
    if (signal) assert.equal(signal.aborted, true);
    release();
    await pending;
    await f.badge.update(snapshot([message(4)]));
    await f.badge.refresh();
    assert.deepEqual(f.counts, stopped, phase);
    assert.equal(f.counts.at(-1), 0, phase);
  }
});
