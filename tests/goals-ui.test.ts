import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { AppState, Goal } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { Goals } from '../src/web/pages/goals.tsx';

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

const goal: Goal = {
  id: '148fba96-abfc-48ee-b9d0-59b6564c60f4',
  title: 'Complete Northstar review',
  description: 'Review the synthetic invoices.',
  progress: 25,
  status: 'active',
  nextAction: 'Prepare the summary.',
  targetDate: '2026-10-02',
  updatedAt: '2026-09-25T12:00:00.000Z',
};
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('Goals exposes a loading status and recovers from first-load failure with an error-only retry', async () => {
  const previousFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  globalThis.fetch = async (path, options) => {
    assert.equal(path, '/api/goals');
    assert.equal(options?.method ?? 'GET', 'GET');
    return new Promise((resolve) => reads.push(resolve));
  };
  pageDataCache.update('/api/goals', () => null);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /Loading goals/);
    assert.equal(container.querySelector('.secondary-empty'), null);
    await act(async () =>
      reads[0](Response.json({ error: 'Goals are unavailable.' }, { status: 503 })),
    );
    assert.match(
      container.querySelector('[role="alert"]')?.textContent ?? '',
      /Could not load goals\./,
    );
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry loading goals"]')!;
    assert.ok(retry);
    retry.focus();
    assert.equal(document.activeElement, retry);
    await act(async () => click(retry));
    assert.equal(retry.disabled, true);
    assert.equal(reads.length, 2);
    await act(async () => reads[1](Response.json([goal])));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Complete Northstar review/);
    assert.equal(container.querySelector('[aria-label="Retry loading goals"]'), null);
    assert.equal(container.querySelector('header [aria-label^="Refresh"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('cached goals remain usable through failed refreshes and navigation', async () => {
  const previousFetch = globalThis.fetch;
  const reads: Array<(response: Response) => void> = [];
  globalThis.fetch = async () => new Promise((resolve) => reads.push(resolve));
  pageDataCache.update('/api/goals', () => [goal]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Prepare the summary/);
    await act(async () =>
      reads[0](Response.json({ error: 'Refresh is unavailable.' }, { status: 503 })),
    );
    assert.match(container.textContent ?? '', /Could not load goals\./);
    assert.match(container.textContent ?? '', /25%/);
    const pause = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Complete Northstar review active"]',
    )!;
    assert.ok(pause);
    assert.equal(pause.disabled, false);
    await act(async () => click(container.querySelector('[aria-label="Retry loading goals"]')!));
    assert.equal(container.querySelector('.loading'), null);
    assert.match(container.textContent ?? '', /Complete Northstar review/);
    await act(async () => reads[1](Response.json([{ ...goal, status: 'paused' }])));
    assert.equal(
      container
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="Complete Northstar review active"]',
        )
        ?.getAttribute('aria-checked'),
      'false',
    );
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Goals)));
    assert.equal(container.querySelector('.loading'), null);
    assert.equal(
      container
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="Complete Northstar review active"]',
        )
        ?.getAttribute('aria-checked'),
      'false',
    );
    await act(async () => reads[2](Response.json([{ ...goal, status: 'paused' }])));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('goal controls save first-party changes in place with Undo and never open chat', async () => {
  const previousFetch = globalThis.fetch;
  const goals: Goal[] = [
    goal,
    { ...goal, id: 'done-goal', title: 'Finished review', status: 'completed', progress: 100 },
  ];
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
      return Response.json({ ...goal, ...body });
    }
    return Response.json(goals);
  };
  pageDataCache.update('/api/goals', () => goals);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Goals)));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Complete Northstar review active"]',
    )!;
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    await act(async () => click(toggle));
    assert.deepEqual(patches[0], { path: `/api/goals/${goal.id}`, body: { status: 'paused' } });
    assert.match(
      container.querySelector('.plan-toast')?.textContent ?? '',
      /Paused Complete Northstar review\. Progress and next step stay saved\./,
    );
    const undo = [...container.querySelectorAll<HTMLButtonElement>('.plan-toast button')].find(
      (button) => button.textContent === 'Undo',
    )!;
    await act(async () => click(undo));
    assert.deepEqual(patches[1]?.body, { status: 'active' });
    assert.equal(container.querySelector('.plan-toast .notice'), null);
    const progress = container.querySelector<HTMLInputElement>(
      '[aria-label="Complete Northstar review progress"]',
    )!;
    assert.equal(progress.type, 'range');
    progress.value = '40';
    await act(async () =>
      progress.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })),
    );
    assert.deepEqual(patches[2]?.body, { progress: 40 });
    assert.match(container.querySelector('.plan-toast')?.textContent ?? '', /40% done/);
    await act(async () => click(container.querySelector('[role="tab"][data-view="completed"]')!));
    const completed = container.querySelector('article')!;
    assert.equal(completed.querySelector('[role="switch"]'), null);
    assert.equal(completed.querySelector('.saved-plan-next'), null);
    assert.ok(completed.querySelector('progress'));
    assert.ok(completed.querySelector('[aria-label="Ask Otto about Finished review"]'));
    assert.ok(completed.querySelector('[aria-label="Delete goal Finished review"]'));
    assert.deepEqual(chatEvents, []);
  } finally {
    window.removeEventListener('otto:compose', onChat);
    window.removeEventListener('otto:focus-message', onChat);
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

test('Ask Otto sends a named request through the conversation and shows the reply in place', async () => {
  const previousFetch = globalThis.fetch;
  const posts: Array<{ text: string; clientMessageId: string; conversationRevision?: number }> = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/messages' && options?.method === 'POST') {
      posts.push(JSON.parse(String(options.body)));
      return Response.json({ taskId: 'ask-task', messageId: posts[0].clientMessageId });
    }
    return Response.json([goal]);
  };
  pageDataCache.update('/api/goals', () => [goal]);
  const focused: unknown[] = [];
  const onFocus = (event: Event) => focused.push((event as CustomEvent).detail);
  window.addEventListener('otto:focus-message', onFocus);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const conversation = (tasks: AppState['tasks'], messages: AppState['messages']): AppState => ({
    conversationRevision: 3,
    messages,
    tasks,
    configuration: {} as AppState['configuration'],
  });
  try {
    await act(async () =>
      root.render(createElement(Goals, { conversation: conversation([], []) })),
    );
    await act(async () =>
      click(container.querySelector('[aria-label="Ask Otto about Complete Northstar review"]')!),
    );
    const chip = [...container.querySelectorAll<HTMLButtonElement>('.ask-otto-chips button')].find(
      (button) => button.textContent === 'Mark it 50% done',
    )!;
    await act(async () => click(chip));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, 'About the goal "Complete Northstar review": Mark it 50% done');
    assert.equal(posts[0].conversationRevision, 3);
    assert.match(container.textContent ?? '', /Otto is on it/);
    const task = { id: 'ask-task', title: 'Goal', createdAt: '', updatedAt: '' };
    await act(async () =>
      root.render(
        createElement(Goals, {
          conversation: conversation(
            [{ ...task, status: 'succeeded' }],
            [
              {
                id: 'reply',
                role: 'assistant',
                text: 'Done. The goal is 50% done.',
                taskId: 'ask-task',
                attachments: [],
                createdAt: '2026-09-29T08:00:00.000Z',
              },
            ],
          ),
        }),
      ),
    );
    assert.match(container.querySelector('.ask-otto-reply')?.textContent ?? '', /50% done/);
    const open = [...container.querySelectorAll<HTMLButtonElement>('.ask-otto button')].find(
      (button) => button.textContent === 'Open conversation',
    )!;
    await act(async () => click(open));
    assert.deepEqual(focused, [{ messageId: posts[0].clientMessageId }]);
    await act(async () =>
      root.render(
        createElement(Goals, {
          conversation: conversation([{ ...task, status: 'waiting_credentials' }], []),
        }),
      ),
    );
    assert.match(container.querySelector('.ask-otto-reply')?.textContent ?? '', /needs your input/);
  } finally {
    window.removeEventListener('otto:focus-message', onFocus);
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});

async function show(goals: Goal[]) {
  const previousFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (_path, options) => {
    assert.equal(options?.method ?? 'GET', 'GET');
    reads++;
    return Response.json(goals);
  };
  pageDataCache.update('/api/goals', () => goals);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(createElement(Goals)));
  return {
    element,
    reads: () => reads,
    tab: (view: string) =>
      element.querySelector<HTMLButtonElement>(`[role=tab][data-view=${view}]`)!,
    async close() {
      await act(async () => root.unmount());
      element.remove();
      pageDataCache.update('/api/goals', () => null);
      globalThis.fetch = previousFetch;
    },
  };
}

test('goal views use roving keyboard tabs and switch cached content without fetching', async () => {
  const f = await show([
    goal,
    { ...goal, id: 'completed', title: 'Finished goal', status: 'completed' },
  ]);
  try {
    const active = f.tab('active');
    const completed = f.tab('completed');
    assert.equal(active.getAttribute('aria-selected'), 'true');
    assert.equal(completed.tabIndex, -1);
    for (const tab of [active, completed])
      assert.ok(document.getElementById(tab.getAttribute('aria-controls')!));
    assert.match(active.textContent!, /Active1/);
    assert.match(completed.textContent!, /Completed1/);
    for (const [key, target] of [
      ['ArrowRight', completed],
      ['ArrowRight', active],
      ['End', completed],
      ['Home', active],
      ['ArrowLeft', completed],
    ] as const) {
      await act(async () =>
        f.element
          .querySelector('[aria-selected=true]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
      assert.equal(document.activeElement, target);
      assert.equal(target.getAttribute('aria-selected'), 'true');
      assert.equal(f.element.querySelectorAll('[role=tab][tabindex="0"]').length, 1);
      const panel = f.element.querySelector('[role=tabpanel]:not([hidden])')!;
      assert.equal(panel.id, target.getAttribute('aria-controls'));
      assert.equal(panel.getAttribute('aria-labelledby'), target.id);
      assert.equal(panel.getAttribute('tabindex'), '0');
    }
    assert.equal(f.element.querySelectorAll('article').length, 1);
    assert.match(f.element.querySelector('article')!.textContent!, /Finished goal/);
    assert.equal(f.reads(), 1);
    assert.equal(f.element.querySelector('.loading'), null);
  } finally {
    await f.close();
  }
});

test('paused-only goals stay visible and resumable outside the completed view', async () => {
  const f = await show([{ ...goal, status: 'paused' }]);
  try {
    assert.match(f.element.textContent!, /No active goals/);
    assert.match(f.element.textContent!, /Resume a paused goal/);
    assert.equal(f.element.querySelector<HTMLDetailsElement>('.goals-paused')!.open, true);
    assert.equal(
      f.element
        .querySelector<HTMLButtonElement>(
          '[role="switch"][aria-label="Complete Northstar review active"]',
        )
        ?.getAttribute('aria-checked'),
      'false',
    );
    await act(async () => click(f.tab('completed')));
    assert.match(f.element.textContent!, /No completed goals yet/);
    assert.equal(f.element.querySelector('article'), null);
    assert.equal(f.element.querySelector('.goals-paused'), null);
    await act(async () => click(f.tab('active')));
    assert.equal(f.element.querySelector<HTMLDetailsElement>('.goals-paused')!.open, true);
  } finally {
    await f.close();
  }
});

test('each view has a specific empty state and accepted cache changes preserve the selected view', async () => {
  const f = await show([]);
  try {
    assert.match(f.element.textContent!, /No goals yet/);
    await act(async () => click(f.tab('completed')));
    assert.match(f.element.textContent!, /No completed goals yet/);
    await act(async () =>
      pageDataCache.update('/api/goals', () => [{ ...goal, status: 'completed' }]),
    );
    assert.equal(f.tab('completed').getAttribute('aria-selected'), 'true');
    assert.match(f.element.querySelector('article')!.textContent!, /Complete Northstar review/);
    await act(async () => pageDataCache.update('/api/goals', () => [goal]));
    assert.match(f.element.textContent!, /No completed goals yet/);
    await act(async () => click(f.tab('active')));
    assert.match(f.element.querySelector('article')!.textContent!, /Complete Northstar review/);
    assert.equal(f.element.querySelector('header [aria-label^="Refresh"]'), null);
    assert.equal(f.reads(), 1);
  } finally {
    await f.close();
  }
});

test('Ask Otto retries a failed request with the same message ID', async () => {
  const previousFetch = globalThis.fetch;
  const posts: Array<{ text: string; clientMessageId: string }> = [];
  globalThis.fetch = async (path, options) => {
    if (path === '/api/messages' && options?.method === 'POST') {
      posts.push(JSON.parse(String(options.body)));
      return posts.length === 1
        ? Response.json({ error: 'Otto is unavailable.' }, { status: 503 })
        : Response.json({ taskId: 'retry-task', messageId: posts[0].clientMessageId });
    }
    return Response.json([goal]);
  };
  pageDataCache.update('/api/goals', () => [goal]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const chip = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>('.ask-otto-chips button, .ask-otto button'),
    ].find((button) => button.textContent === 'Mark it 50% done');
  try {
    await act(async () => root.render(createElement(Goals)));
    await act(async () =>
      click(container.querySelector('[aria-label="Ask Otto about Complete Northstar review"]')!),
    );
    await act(async () => click(chip()!));
    assert.match(container.textContent ?? '', /Otto is unavailable\./);
    const input = container.querySelector<HTMLInputElement>('.ask-otto-field input')!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      setValue.call(input, 'Mark it 50% done');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector('.ask-otto-field')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.equal(posts.length, 2);
    assert.equal(posts[1].clientMessageId, posts[0].clientMessageId);
    assert.equal(posts[1].text, posts[0].text);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    pageDataCache.update('/api/goals', () => null);
    globalThis.fetch = previousFetch;
  }
});
