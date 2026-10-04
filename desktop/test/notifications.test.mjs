import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import {
  assistantNotificationPreview,
  createReadinessNotice,
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

test('completed guided setup waits for the engine and foreground readiness consumes the notice', async () => {
  for (const foreground of [false, true]) {
    let notices = 0;
    const notice = createReadinessNotice({
      notify: async () => {
        notices++;
        return true;
      },
    });
    let state = {
      runtimePhase: 'preparing',
      guided: true,
      enabled: true,
      foreground,
      quitting: false,
      completed: true,
      engineReady: false,
    };
    await notice.update(state);
    state = { ...state, runtimePhase: 'ready' };
    await notice.update(state);
    assert.equal(notices, 0);
    state = { ...state, engineReady: true };
    await notice.update(state);
    assert.equal(notices, foreground ? 0 : 1);
    await notice.update({ ...state, foreground: false });
    assert.equal(notices, foreground ? 0 : 1);
  }
});

test('routine background startup and replaying already-ready setup do not create readiness notices', async () => {
  let notices = 0;
  const notice = createReadinessNotice({
    notify: async () => {
      notices++;
      return true;
    },
  });
  let state = {
    runtimePhase: 'preparing',
    guided: false,
    enabled: true,
    foreground: false,
    quitting: false,
    completed: true,
    engineReady: false,
  };
  await notice.update(state);
  state = { ...state, runtimePhase: 'ready' };
  await notice.update(state);
  state = { ...state, engineReady: true };
  await notice.update(state);
  assert.equal(notices, 0);
  await notice.update({ ...state, guided: true, completed: false });
  assert.equal(notices, 0);
});

test('readiness notifications recheck opt-in, focus and Quit after asynchronous preferences', async () => {
  for (const changed of [{ enabled: false }, { foreground: true }, { quitting: true }]) {
    let release;
    let started;
    const paused = new Promise((resolve) => (release = resolve));
    const reading = new Promise((resolve) => (started = resolve));
    let notices = 0;
    const notice = createReadinessNotice({
      notify: async (eligible) => {
        started();
        await paused;
        if (!eligible()) return false;
        notices++;
        return true;
      },
    });
    const state = {
      runtimePhase: 'preparing',
      guided: true,
      enabled: true,
      foreground: false,
      quitting: false,
      completed: false,
      engineReady: false,
    };
    await notice.update(state);
    const pending = notice.update({ ...state, runtimePhase: 'ready' });
    await reading;
    await notice.update({ ...state, runtimePhase: 'ready', ...changed });
    release();
    await pending;
    assert.equal(notices, 0);
  }
});

test('quiet-time readiness is consumed without a later unsolicited reminder', async () => {
  let checks = 0;
  let notices = 0;
  const preferences = {
    quietHoursEnabled: true,
    quietStart: '22:00',
    quietEnd: '08:00',
    timeZone: 'Europe/Lisbon',
  };
  let now = new Date('2026-10-02T22:30:00Z');
  const notice = createReadinessNotice({
    notify: async () => {
      checks++;
      if (!isQuietTime(preferences, now)) notices++;
      return true;
    },
  });
  const state = {
    runtimePhase: 'preparing',
    guided: true,
    enabled: true,
    foreground: false,
    quitting: false,
    completed: false,
    engineReady: false,
  };
  await notice.update(state);
  await notice.update({ ...state, runtimePhase: 'ready' });
  assert.equal(checks, 1);
  assert.equal(notices, 0);
  now = new Date('2026-10-03T12:00:00Z');
  await notice.update({ ...state, runtimePhase: 'ready' });
  assert.equal(checks, 1);
  assert.equal(notices, 0);
});

test('notification previews extract readable message text without link targets or hidden markup', () => {
  const preview = assistantNotificationPreview({
    text: '## **Your report is ready**\n\nRead [the summary](https://example.test/private?token=synthetic-link-secret) and `review.csv`.\n<!--hidden comment--><script>hidden script</script>',
    replyTo: { text: 'synthetic-private-quoted-message' },
  });
  assert.equal(preview, 'Your report is ready Read the summary and review.csv.');
  for (const value of [
    'synthetic-link-secret',
    'hidden comment',
    'hidden script',
    'synthetic-private-quoted-message',
  ])
    assert.ok(!preview.includes(value));
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

test('notification previews bound Unicode text and use attachment metadata without capability URLs', () => {
  const preview = assistantNotificationPreview({ text: '\u202e' + '🙂'.repeat(400) + '\u0000' });
  assert.equal(Array.from(preview).length, 240);
  assert.ok(!preview.includes('\u202e'));
  assert.ok(!preview.includes('\u0000'));
  assert.equal(preview.isWellFormed(), true);
  const attachment = assistantNotificationPreview({
    text: '',
    attachments: [
      {
        name: 'quarterly-report.csv',
        url: '/api/artifacts/synthetic-capability-token',
        mimeType: 'text/csv',
      },
    ],
  });
  assert.ok(attachment.includes('quarterly-report.csv'));
  assert.ok(!attachment.includes('synthetic-capability-token'));
  assert.ok(assistantNotificationPreview({ text: null, attachments: [null] }).length > 0);
  assert.ok(assistantNotificationPreview({ text: '', attachments: [{}, {}] }).length > 0);
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

test('quiet hours follow the saved IANA time zone and daylight saving', () => {
  const preferences = {
    quietHoursEnabled: true,
    timeZone: 'Europe/Lisbon',
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  assert.equal(isQuietTime(preferences, new Date('2026-07-01T21:00:00Z')), true);
  assert.equal(isQuietTime(preferences, new Date('2026-01-01T21:00:00Z')), false);
  assert.equal(isQuietTime(preferences, new Date('2026-07-01T07:00:00Z')), false);
  assert.equal(isQuietTime(preferences, new Date('2026-01-01T07:00:00Z')), true);
});

test('unset notification time zones follow the current system zone', (t) => {
  const DateTimeFormat = Intl.DateTimeFormat;
  t.mock.method(Intl, 'DateTimeFormat', function (locale, options) {
    return new DateTimeFormat(locale, options ?? { timeZone: 'Asia/Tokyo' });
  });
  const preferences = {
    quietHoursEnabled: true,
    timeZone: null,
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  assert.equal(isQuietTime(preferences, new Date('2026-10-02T13:00:00Z')), true);
  assert.equal(isQuietTime(preferences, new Date('2026-10-02T23:00:00Z')), false);
  assert.equal(
    isQuietTime({ ...preferences, timeZone: 'UTC' }, new Date('2026-10-02T13:00:00Z')),
    false,
  );
});

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await nextTurn();
  assert.ok(predicate());
}

function fixture(t) {
  const streams = [];
  const snapshots = [];
  let threadId = 'synthetic-thread-1';
  let messages = [{ id: 'historical-assistant', role: 'assistant' }];
  const delivered = [];
  const threads = [];
  const stop = watchAssistantMessages({
    retryMs: 1,
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
      const stream = { signal: options.signal, cancelled: false };
      const body = new ReadableStream({
        start(controller) {
          stream.controller = controller;
          options.signal.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
        cancel() {
          stream.cancelled = true;
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
    thread(value) {
      threadId = value;
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
  assert.deepEqual(f.delivered[0], {
    id: 'new-assistant',
    role: 'assistant',
    text: 'Synthetic committed result',
    attachments: [],
  });
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
  assert.equal(f.delivered[0].text, 'Latest synthetic update');
  assert.deepEqual(f.delivered[0].attachments, [{ name: 'result.csv' }]);
  assert.deepEqual(f.threads, ['synthetic-thread-1']);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => f.snapshots.length === 3);
  f.stop();
  assert.ok(f.streams.every(({ signal }) => signal.aborted));
  await nextTurn();
  assert.equal(f.notifications, 1);
});

test('notification thread resets establish a new baseline and forward only matching committed messages', async (t) => {
  const f = fixture(t);
  await eventually(() => f.snapshots.length === 1);
  f.thread('synthetic-thread-2');
  f.messages([{ id: 'different-history', role: 'assistant', text: 'Historical message' }]);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => f.snapshots.length === 2);
  assert.equal(f.notifications, 0);
  f.messages([
    { id: 'different-history', role: 'assistant', text: 'Historical message' },
    { id: 'new-thread-reply', role: 'assistant', text: 'Current thread reply' },
  ]);
  f.send('data: {"type":"refresh"}\n\n');
  await eventually(() => f.notifications === 1);
  assert.equal(f.delivered[0].id, 'new-thread-reply');
  assert.deepEqual(f.threads, ['synthetic-thread-2']);
});

test('oversized notification frames are cancelled before reconnecting', async (t) => {
  const f = fixture(t);
  await eventually(() => f.snapshots.length === 1);
  f.send('x'.repeat(256 * 1024 + 1));
  await eventually(() => f.streams.length === 2);
  assert.equal(f.streams[0].cancelled, true);
  assert.equal(f.notifications, 0);
});
