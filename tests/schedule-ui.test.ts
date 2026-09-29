import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import type { Schedule, ScheduleHistory, ScheduleRun } from '../src/shared/contracts.ts';
import { SchedulePage, ScheduleRow, ScheduleRunRow } from '../src/web/pages/schedule.tsx';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { scheduleDate, scheduleExpression, scheduleLabel } from '../src/web/lib/schedules.ts';
import { PlanToast } from '../src/web/components/plan-controls.tsx';
import { setDateFormat } from '../src/web/lib/date-format.ts';

setDateFormat({ locale: 'en-GB', hourCycle: 'auto', timeZone: 'Europe/Lisbon' });

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const historyPath = '/api/schedule-runs?limit=20';
const once: Schedule = {
  id: 'once',
  title: 'Send a reminder',
  prompt: 'Remind me to check the draft.',
  kind: 'once',
  cron: null,
  runAt: '2030-04-01T08:30:00.000Z',
  timeZone: 'Europe/Lisbon',
  enabled: true,
  revision: 0,
  nextRun: '2030-04-01T08:30:00.000Z',
  lastRun: null,
  baselineObservation: null,
};
const recurring: Schedule = {
  ...once,
  id: 'repeat',
  title: 'Weekly review',
  kind: 'recurring',
  cron: '0 9 * * 1',
  runAt: null,
  nextRun: '2030-04-08T08:00:00.000Z',
};
const run: ScheduleRun = {
  id: 'run-recent',
  scheduleId: 'deleted-schedule',
  title: 'Past reminder',
  taskId: 'internal-task',
  scheduledFor: '2026-09-24T09:00:00.000Z',
  timeZone: 'Europe/Lisbon',
  createdAt: '2026-09-24T09:00:01.000Z',
  status: 'failed',
  error: 'The task could not finish.',
  observation: null,
  messageId: null,
  messagePreview: null,
  messageText: null,
};
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('common recurring timings have readable labels without rounding irregular cron intervals', () => {
  for (const [cron, label] of [
    ['* * * * *', 'Every minute'],
    ['*/1 * * * *', 'Every minute'],
    ['*/5 * * * *', 'Every 5 minutes'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at :15'],
    ['0 */1 * * *', 'Every hour'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['5 9 * * *', 'Every day at 09:05'],
    ['0 9 * * 1-5', 'Every weekday at 09:00'],
    ['30 8 * * 0,6', 'Every Saturday and Sunday at 08:30'],
    ['30 8 * * 6,0', 'Every Saturday and Sunday at 08:30'],
    ['30 8 * * 6-7', 'Every Saturday and Sunday at 08:30'],
    ['0 9 1 * *', 'Day 1 of every month at 09:00'],
    ['0 9 31 * *', 'Day 31 of every month at 09:00'],
    ['  */10   * * * *  ', 'Every 10 minutes'],
  ])
    assert.equal(scheduleLabel(cron), label, cron);
  const twelveHour = { locale: 'en-GB', hourCycle: 'h12' as const, timeZone: 'UTC' };
  assert.equal(scheduleLabel('5 21 * * *', twelveHour), 'Every day at 9:05 pm');
  assert.equal(
    scheduleLabel('0 9 * * 1-5', { locale: 'en-US', hourCycle: 'auto', timeZone: 'UTC' }),
    'Every weekday at 9:00 AM',
  );
  for (const cron of [
    '*/7 * * * *',
    '*/0 * * * *',
    '0 */5 * * *',
    '60 * * * *',
    '0 24 * * 1-5',
    '0 9 32 * *',
    '0 9 1 1 *',
    '0 9 1 * 1',
    '* * * * * *',
  ]) {
    assert.equal(scheduleLabel(cron), 'Custom timing', cron);
    assert.equal(scheduleExpression('custom', '09:00', '1', cron), cron);
  }
});

test('one-time and recurring schedules keep their timezone without converting a one-time run to cron', () => {
  assert.equal(scheduleDate(once.runAt!, once.timeZone), '1 Apr 2030, 09:30');
  assert.equal(
    scheduleDate(once.runAt!, once.timeZone, {
      locale: 'en-US',
      hourCycle: 'auto',
      timeZone: 'Asia/Tokyo',
    }),
    'Apr 1, 2030, 9:30 AM',
  );
  assert.equal(scheduleDate('invalid', once.timeZone), 'Time unavailable');
  const html = renderToStaticMarkup(createElement(ScheduleRow, { schedule: once }));
  assert.match(html, /One time/);
  assert.match(html, /1 Apr 2030, 09:30/);
  assert.doesNotMatch(html, /Custom timing|null|<select|<form/);
  const past = renderToStaticMarkup(
    createElement(ScheduleRow, {
      schedule: { ...once, enabled: false, runAt: '2020-01-01T00:00:00Z', nextRun: null },
    }),
  );
  assert.doesNotMatch(past, /role="switch"/);
  assert.match(past, /Ask Otto/);
  const failed = renderToStaticMarkup(
    createElement(ScheduleRunRow, { run: { ...run, error: '<script>bad()</script>' } }),
  );
  assert.match(failed, /Could not finish/);
  assert.match(failed, /&lt;script&gt;/);
  assert.doesNotMatch(failed, /<script|internal-task|deleted-schedule/);
  const checked = renderToStaticMarkup(
    createElement(ScheduleRunRow, {
      run: {
        ...run,
        observation: {
          status: 'verified',
          value: 'EUR 215',
          summary: 'Return fare with taxes.',
          sourceUrl: 'https://example.com/offer',
          checkedAt: '2026-09-24T09:00:03.000Z',
        },
      },
    }),
  );
  assert.match(checked, /EUR 215/);
  assert.match(checked, /Checked/);
  assert.match(checked, /dateTime="2026-09-24T09:00:03.000Z"/);
  assert.match(checked, /Return fare with taxes/);
  assert.match(checked, /https:\/\/example.com\/offer/);
});

test('a paused rescheduled one-time task stays visible while its previous execution remains in history', () => {
  pageDataCache.update('/api/schedules', () => [
    { ...once, enabled: false, lastRun: run, title: 'Paused future reminder' },
    {
      ...once,
      id: 'completed-once',
      enabled: false,
      runAt: run.scheduledFor,
      nextRun: null,
      lastRun: run,
      title: 'Already dispatched reminder',
    },
  ]);
  try {
    const html = renderToStaticMarkup(createElement(SchedulePage));
    assert.match(html, /Paused future reminder/);
    assert.match(
      html,
      /aria-label="Paused future reminder on" type="button" role="switch" aria-checked="false"/,
    );
    assert.match(html, /<details class="schedule-inactive" open=""/);
    assert.doesNotMatch(html, /Already dispatched reminder/);
  } finally {
    pageDataCache.update('/api/schedules', () => null);
  }
});

test('Schedule shows cached upcoming work, lazy read-only history and keyboard tabs while new schedules stay in place', async () => {
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  const readReplies: Array<(response: Response) => void> = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, undefined);
    requests.push(String(url));
    return new Promise((resolve) => readReplies.push(resolve));
  };
  pageDataCache.update('/api/schedules', () => [recurring, once]);
  pageDataCache.update<ScheduleHistory>(historyPath, () => ({
    runs: [run],
    nextCursor: 'older-cursor',
  }));
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(SchedulePage)));
    assert.equal(element.querySelector('.loading'), null);
    assert.deepEqual(
      [...element.querySelectorAll('.saved-plan h2')].map((item) => item.textContent),
      ['Send a reminder', 'Weekly review'],
    );
    assert.deepEqual(requests, ['/api/schedules']);
    const add = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'New schedule',
    )!;
    await act(async () => click(add));
    assert.equal(add.getAttribute('aria-expanded'), 'true');
    assert.ok(
      element.querySelector('.new-plan-card [aria-label="What should Otto do, and when?"]'),
    );
    assert.deepEqual(requests, ['/api/schedules']);
    await act(async () => click(add));
    const upcoming = element.querySelector<HTMLButtonElement>('#schedule-tab-upcoming')!;
    upcoming.focus();
    await act(async () =>
      upcoming.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    assert.equal(document.activeElement?.id, 'schedule-tab-history');
    assert.equal(
      element.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'),
      'schedule-tab-history',
    );
    assert.equal(element.querySelector('[role="tabpanel"]')?.getAttribute('tabindex'), '0');
    assert.equal(element.querySelector('.loading'), null);
    assert.match(element.textContent ?? '', /Past reminder/);
    assert.match(element.textContent ?? '', /Could not finish/);
    assert.equal(element.querySelector('.schedule-run button'), null);
    assert.match(element.querySelector('.schedule-run')?.textContent ?? '', /No message/);
    assert.equal(element.querySelector('select'), null);
    assert.deepEqual(requests, ['/api/schedules', historyPath]);
    await act(async () => readReplies[0](new Response(JSON.stringify([recurring, once]))));
    await act(async () =>
      readReplies[1](new Response(JSON.stringify({ runs: [run], nextCursor: 'older-cursor' }))),
    );
    const more = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load earlier',
    )!;
    await act(async () => click(more));
    assert.equal(requests[2], `${historyPath}&cursor=older-cursor`);
    const older = {
      ...run,
      id: 'run-older',
      title: 'Older deleted task',
      createdAt: '2026-09-23T00:00:00Z',
      status: 'succeeded',
      error: null,
    };
    await act(async () =>
      readReplies[2](
        new Response(
          JSON.stringify({ runs: [{ ...run, status: 'running' }, older], nextCursor: null }),
        ),
      ),
    );
    assert.equal(element.querySelectorAll('.schedule-run').length, 2);
    assert.match(element.querySelector('.schedule-run')?.textContent ?? '', /Could not finish/);
    await act(async () =>
      pageDataCache.update<ScheduleHistory>(historyPath, () => ({
        runs: [{ ...run, status: 'succeeded', error: null }],
        nextCursor: 'older-cursor',
      })),
    );
    assert.match(element.querySelector('.schedule-run')?.textContent ?? '', /Finished/);
    assert.doesNotMatch(
      element.querySelector('.schedule-run')?.textContent ?? '',
      /Could not finish/,
    );
    await act(async () => click(upcoming));
    assert.equal(element.querySelector('.loading'), null);
    assert.equal(element.querySelectorAll('.saved-plan').length, 2);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.update('/api/schedules', () => null);
    pageDataCache.update(historyPath, () => null);
    globalThis.fetch = priorFetch;
  }
});

test('history refresh updates loaded older active runs, keeps existing rows and rejects late obsolete page responses', async () => {
  const priorFetch = globalThis.fetch;
  const requests: Array<{ path: string; resolve(value: Response): void }> = [];
  globalThis.fetch = async (url) =>
    new Promise((resolve) => requests.push({ path: String(url), resolve }));
  const recent = { ...run, status: 'waiting_user' as const, error: null };
  pageDataCache.update('/api/schedules', () => []);
  pageDataCache.update<ScheduleHistory>(historyPath, () => ({
    runs: [recent],
    nextCursor: 'older-cursor',
  }));
  const older = {
    ...run,
    id: 'older-running',
    title: 'Older running task',
    createdAt: '2026-09-22T00:00:00Z',
    status: 'running' as const,
    error: null,
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(SchedulePage)));
    await act(async () => click(element.querySelector('#schedule-tab-history')!));
    await act(async () => requests[0].resolve(Response.json([])));
    await act(async () =>
      requests[1].resolve(Response.json({ runs: [recent], nextCursor: 'older-cursor' })),
    );
    await act(async () =>
      click(
        [...element.querySelectorAll('button')].find(
          (item) => item.textContent === 'Load earlier',
        )!,
      ),
    );
    await act(async () => requests[2].resolve(Response.json({ runs: [older], nextCursor: null })));
    assert.equal(element.querySelectorAll('.schedule-run').length, 2);
    assert.match(element.textContent ?? '', /Older running taskWorking/);
    await act(async () =>
      pageDataCache.update<ScheduleHistory>(historyPath, () => ({
        runs: [{ ...recent }],
        nextCursor: 'older-cursor',
      })),
    );
    assert.equal(requests[3]?.path, `${historyPath}&cursor=older-cursor`);
    assert.equal(element.querySelector('.loading'), null);
    assert.equal(element.querySelectorAll('.schedule-run').length, 2);
    await act(async () =>
      pageDataCache.update<ScheduleHistory>(historyPath, () => ({
        runs: [{ ...recent }],
        nextCursor: 'older-cursor',
      })),
    );
    assert.equal(requests[4]?.path, `${historyPath}&cursor=older-cursor`);
    await act(async () =>
      requests[3].resolve(
        Response.json({ runs: [{ ...older, status: 'failed' }], nextCursor: null }),
      ),
    );
    assert.match(element.textContent ?? '', /Older running taskWorking/);
    await act(async () =>
      requests[4].resolve(
        Response.json({ runs: [{ ...older, status: 'succeeded' }], nextCursor: null }),
      ),
    );
    assert.match(element.textContent ?? '', /Older running taskFinished/);
    assert.equal(element.querySelectorAll('.schedule-run').length, 2);
    assert.equal(element.querySelector('.loading'), null);
    await act(async () =>
      pageDataCache.update<ScheduleHistory>(historyPath, () => ({
        runs: [{ ...run, id: 'new-head', title: 'Newest task', createdAt: '2026-09-25T00:00:00Z' }],
        nextCursor: 'shifted-head-cursor',
      })),
    );
    assert.equal(requests[5]?.path, `${historyPath}&cursor=shifted-head-cursor`);
    assert.equal(element.querySelectorAll('.schedule-run').length, 3);
    await act(async () =>
      requests[5].resolve(
        Response.json({ runs: [{ ...recent, status: 'succeeded' }], nextCursor: 'older-cursor' }),
      ),
    );
    assert.match(element.textContent ?? '', /Past reminderFinished/);
    assert.equal(element.querySelectorAll('.schedule-run').length, 3);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.update('/api/schedules', () => null);
    pageDataCache.update(historyPath, () => null);
    globalThis.fetch = priorFetch;
  }
});

test('schedule controls pause, resume and retime through the owned route with Undo and no chat draft', async () => {
  const priorFetch = globalThis.fetch;
  const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
  const chatEvents: string[] = [];
  const onChat = (event: Event) => chatEvents.push(event.type);
  window.addEventListener('otto:compose', onChat);
  window.addEventListener('otto:focus-message', onChat);
  globalThis.fetch = async (path, options) => {
    assert.notEqual(path, '/api/messages');
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      patches.push({ path: String(path), body });
      return Response.json({ ...recurring, ...body });
    }
    return Response.json([recurring]);
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (schedule: Schedule) =>
    act(async () =>
      root.render(
        createElement('div', {}, [
          createElement(PlanToast, { key: 'toast' }),
          createElement(ScheduleRow, { key: 'row', schedule }),
        ]),
      ),
    );
  try {
    await render(recurring);
    const toggle = element.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Weekly review on"]',
    )!;
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await act(async () => click(toggle));
    assert.deepEqual(patches[0], {
      path: `/api/schedules/${recurring.id}`,
      body: { enabled: false },
    });
    assert.match(
      element.querySelector('.plan-toast')?.textContent ?? '',
      /Paused Weekly review\. Otto will not run it until you resume it\./,
    );
    await act(async () =>
      click(
        [...element.querySelectorAll<HTMLButtonElement>('.plan-toast button')].find(
          (button) => button.textContent === 'Undo',
        )!,
      ),
    );
    assert.deepEqual(patches[1], {
      path: `/api/schedules/${recurring.id}`,
      body: { enabled: true },
    });
    await render({ ...recurring, enabled: false, nextRun: null });
    assert.doesNotMatch(element.textContent ?? '', /Next /);
    await act(async () => click(element.querySelector('[aria-label="Weekly review on"]')!));
    assert.deepEqual(patches[2], {
      path: `/api/schedules/${recurring.id}`,
      body: { enabled: true },
    });
    assert.match(
      element.querySelector('.plan-toast')?.textContent ?? '',
      /Resumed Weekly review\./,
    );
    const days = element.querySelector<HTMLSelectElement>('[aria-label="Weekly review days"]')!;
    assert.equal(days.value, '1');
    days.value = '1-5';
    await act(async () => days.dispatchEvent(new Event('change', { bubbles: true })));
    assert.deepEqual(patches[3], {
      path: `/api/schedules/${recurring.id}`,
      body: { cron: '0 9 * * 1-5' },
    });
    assert.match(element.querySelector('.plan-toast')?.textContent ?? '', /runs on weekdays/);
    const time = element.querySelector<HTMLInputElement>('[aria-label="Weekly review time"]')!;
    assert.equal(time.value, '09:00');
    time.value = '07:45';
    await act(async () => time.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    assert.deepEqual(patches[4], {
      path: `/api/schedules/${recurring.id}`,
      body: { cron: '45 7 * * 1' },
    });
    const overdue = { ...once, runAt: '2020-01-01T00:00:00.000Z', enabled: false, nextRun: null };
    await render(overdue);
    assert.equal(element.querySelector('[role="switch"]'), null);
    assert.ok(element.querySelector('[aria-label="Ask Otto about Send a reminder"]'));
    assert.deepEqual(chatEvents, []);
  } finally {
    window.removeEventListener('otto:compose', onChat);
    window.removeEventListener('otto:focus-message', onChat);
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('a run message is readable in place and opens in the conversation on request', async () => {
  const focused: unknown[] = [];
  const onFocus = (event: Event) => focused.push((event as CustomEvent).detail);
  window.addEventListener('otto:focus-message', onFocus);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(ScheduleRunRow, {
          run: {
            ...run,
            status: 'succeeded',
            error: null,
            messageId: 'posted-message',
            messagePreview: 'Your weekly summary is ready. Two items need a reply.',
            messageText:
              'Your **weekly** summary is ready.\n\nTwo items need a reply.<script>bad()</script>',
          },
        }),
      ),
    );
    const preview = element.querySelector<HTMLButtonElement>('.schedule-run-preview')!;
    assert.equal(preview.getAttribute('aria-expanded'), 'false');
    assert.match(preview.textContent ?? '', /Your weekly summary is ready/);
    assert.equal(element.querySelector('.schedule-run-body'), null);
    assert.equal(focused.length, 0);
    await act(async () => click(preview));
    assert.equal(preview.getAttribute('aria-expanded'), 'true');
    const body = element.querySelector('.schedule-run-body')!;
    assert.equal(body.id, preview.getAttribute('aria-controls'));
    assert.equal(body.querySelector('strong')?.textContent, 'weekly');
    assert.match(body.textContent ?? '', /Two items need a reply/);
    assert.equal(body.querySelector('script'), null);
    assert.doesNotMatch(element.textContent ?? '', /No message/);
    await act(async () =>
      click(
        element.querySelector(
          '[aria-label="Open the message from Past reminder in the conversation"]',
        )!,
      ),
    );
    assert.deepEqual(focused, [{ messageId: 'posted-message' }]);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    window.removeEventListener('otto:focus-message', onFocus);
  }
});

test('failed schedule and history reads offer a retry and keep saved rows visible', async () => {
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  const attempts = new Map<string, number>();
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, undefined);
    const path = String(url);
    requests.push(path);
    const attempt = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, attempt);
    if (attempt === 1) throw new TypeError('Failed to fetch');
    return Response.json(
      path === '/api/schedules' ? [recurring] : { runs: [run], nextCursor: null },
    );
  };
  pageDataCache.update('/api/schedules', () => [recurring]);
  pageDataCache.update(historyPath, () => null);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const retry = () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!;
  try {
    await act(async () => root.render(createElement(SchedulePage)));
    assert.match(
      element.querySelector('[role="alert"]')?.textContent ?? '',
      /Could not load schedules\./,
    );
    assert.match(element.textContent ?? '', /Weekly review/);
    assert.equal(element.querySelector('.loading'), null);
    await act(async () => click(retry()));
    assert.equal(element.querySelector('[role="alert"]'), null);
    assert.equal(retry(), undefined);
    assert.match(element.textContent ?? '', /Weekly review/);
    await act(async () => click(element.querySelector('#schedule-tab-history')!));
    assert.match(
      element.querySelector('[role="alert"]')?.textContent ?? '',
      /Could not load schedule history\./,
    );
    assert.doesNotMatch(element.textContent ?? '', /No runs yet/);
    await act(async () => click(retry()));
    assert.equal(element.querySelector('[role="alert"]'), null);
    assert.equal(retry(), undefined);
    assert.match(element.textContent ?? '', /Past reminder/);
    assert.deepEqual(requests, ['/api/schedules', '/api/schedules', historyPath, historyPath]);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.update('/api/schedules', () => null);
    pageDataCache.update(historyPath, () => null);
    globalThis.fetch = priorFetch;
  }
});

test('every saved weekday is selected and remains unchanged when editing its time', async () => {
  const previousFetch = globalThis.fetch;
  const patches: Array<{ path: string; body: unknown }> = [];
  const reads: string[] = [];
  globalThis.fetch = async (path, options) => {
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body));
      patches.push({ path: String(path), body });
      return Response.json({ ...recurring, ...body });
    }
    reads.push(String(path));
    return Response.json([recurring]);
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    for (let day = 0; day < 7; day++) {
      const schedule = { ...recurring, cron: `0 9 * * ${day}` };
      await act(async () => root.render(createElement(ScheduleRow, { key: day, schedule })));
      const select = element.querySelector<HTMLSelectElement>('[aria-label="Weekly review days"]')!;
      assert.equal(select.value, String(day));
      const time = element.querySelector<HTMLInputElement>('[aria-label="Weekly review time"]')!;
      time.value = '07:45';
      await act(async () =>
        time.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })),
      );
      assert.deepEqual(patches.at(-1), {
        path: `/api/schedules/${recurring.id}`,
        body: { cron: `45 7 * * ${day}` },
      });
    }
    assert.equal(patches.length, 7);
    assert.deepEqual(
      reads,
      Array.from({ length: 7 }, () => '/api/schedules'),
    );
    assert.equal(pageDataCache.getSnapshot('/api/schedules').error, '');
    assert.deepEqual(pageDataCache.getSnapshot('/api/schedules').data, [recurring]);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    pageDataCache.update('/api/schedules', () => null);
    globalThis.fetch = previousFetch;
  }
});
