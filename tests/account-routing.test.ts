import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { SessionResponse } from '../src/shared/account.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'PopStateEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
class Events {
  static all: Events[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    Events.all.push(this);
  }
  close() {
    this.closed = true;
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { App } = await import('../src/web/app.tsx');
const { sessionStore } = await import('../src/web/lib/session.ts');
const account: SessionResponse = {
  auth: { mode: 'google', googleAvailable: true },
  user: {
    id: 'd27a54b9-0f68-433d-96a2-8bd390a23be8',
    name: 'Alex Example',
    email: 'alex@example.test',
    avatarUrl: null,
  },
  settings: { theme: 'system', onboardingCompleted: true },
  capabilities: { developer: false },
};
const anonymous: SessionResponse = { ...account, user: null, settings: null };

test('privacy is public and never requests a session, account data or embedded content', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const path of ['/privacy', '/privacy/']) {
    window.history.replaceState(null, '', path);
    const requests: string[] = [];
    const streamCount = Events.all.length;
    globalThis.fetch = async (url, options) => {
      requests.push(String(url));
      assert.equal(options?.credentials, 'omit');
      assert.equal(new Headers(options?.headers).get('X-Otto-Account'), null);
      return Response.json({
        content: [
          '## Your information',
          'A published notice.',
          '[Contact](mailto:privacy@example.test)',
          '![Tracking image](https://example.test/pixel)',
          '<iframe src="https://example.test/frame"></iframe>',
          '<script>alert("unsafe")</script>',
          '[Unsafe](javascript:alert%281%29)',
        ].join('\n\n'),
      });
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.deepEqual(requests, ['/api/privacy']);
      assert.equal(Events.all.length, streamCount);
      assert.ok(element.textContent?.includes('Your information'));
      assert.equal(
        element.querySelector('a[href="mailto:privacy@example.test"]')?.textContent,
        'Contact',
      );
      assert.equal(element.querySelector('img, script, iframe'), null);
      assert.equal(element.querySelector('a[href^="javascript:"]'), null);
      assert.equal(element.textContent?.includes('Continue with Google'), false);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  }
});

test('privacy masks request errors and can retry without loading private routes', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  window.history.replaceState(null, '', '/privacy');
  let attempts = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), '/api/privacy');
    if (++attempts === 1)
      return Response.json({ error: 'private service diagnostics' }, { status: 503 });
    return Response.json({ content: null });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(element.textContent?.includes('The privacy notice could not be loaded.'));
    assert.equal(element.textContent?.includes('private service diagnostics'), false);
    const retry = element.querySelector<HTMLButtonElement>('button');
    assert.equal(retry?.textContent, 'Try again');
    await act(async () => retry!.click());
    assert.equal(attempts, 2);
    assert.ok(element.textContent?.includes('A privacy notice has not been published here yet.'));
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('private routes do not mount or fetch before authentication, including browser and credentials', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const path of ['/', '/browser', '/credentials/private-request']) {
    window.history.replaceState(null, '', path);
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return Response.json(anonymous);
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.deepEqual(requests, ['/api/session']);
      assert.ok(element.textContent?.includes('Continue with Google'));
      assert.equal(Events.all.length, 0);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  }
});

test('ordinary accounts cannot mount developer routes or read computer data', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const path of ['/browser', '/dev']) {
    window.history.replaceState(null, '', path);
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return Response.json(account);
    };
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(App)));
      assert.deepEqual(requests, ['/api/session']);
      assert.ok(element.textContent?.includes('This page isn’t here.'));
      assert.equal(Events.all.length, 0);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  }
});

test('authenticated workspace binds SSE to its account, supports settings shortcut and closes private work on expiry', async () => {
  const previous = globalThis.fetch;
  window.history.replaceState(null, '', '/');
  let finishState!: (response: Response) => void;
  let stateSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url) === '/api/session') return Response.json(account);
    if (String(url) === '/api/state') {
      stateSignal = options?.signal;
      assert.equal(new Headers(options?.headers).get('X-Otto-Account'), account.user!.id);
      return new Promise((resolve) => {
        finishState = resolve;
      });
    }
    throw new Error('Unexpected request');
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(App)));
    const stream = Events.all.at(-1)!;
    assert.equal(stream.url, `/api/events?account=${account.user!.id}`);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    assert.ok(document.querySelector('.account-settings [role="tablist"]'));
    await act(async () => sessionStore.invalidate());
    assert.equal(stream.closed, true);
    assert.equal(stateSignal?.aborted, true);
    assert.equal(document.querySelector('.account-settings'), null);
    await act(async () =>
      finishState(
        Response.json({
          messages: [{ text: 'Old private conversation' }],
          tasks: [],
          configuration: {},
        }),
      ),
    );
    assert.equal(element.textContent?.includes('Old private conversation'), false);
    assert.ok(element.textContent?.includes('Continue with Google'));
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = previous;
  }
});

test('the workspace shell shows a chat skeleton and mounts prefetched pages before app state arrives', async () => {
  const previous = globalThis.fetch;
  const previousUrl = window.location.href;
  window.history.replaceState(null, '', '/');
  const requests: string[] = [];
  let stateSignal: AbortSignal | null | undefined;
  let finishState: ((response: Response) => void) | undefined;
  const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url) === '/api/session') return Response.json(account);
    if (String(url) === '/api/state') {
      stateSignal = options?.signal;
      return new Promise((resolve) => {
        finishState ??= resolve;
      });
    }
    return Response.json([]);
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(element.querySelector('.chat-skeleton'));
    assert.ok(element.querySelector('.sidebar'));
    for (const path of ['/api/vault', '/api/goals', '/api/schedules', '/api/apps'])
      assert.equal(requests.filter((request) => request === path).length, 1, path);
    assert.equal(/workspace|connect/i.test(element.textContent ?? ''), false);
    await act(async () => Events.all.at(-1)!.onopen?.());
    assert.equal(stateSignal?.aborted, false);
    assert.equal(requests.filter((request) => request === '/api/state').length, 1);
    await act(async () =>
      finishState!(
        Response.json({
          conversationRevision: 0,
          messages: [],
          tasks: [],
          configuration: {
            provider: 'fixture',
            model: 'fixture',
            llmReady: true,
            speechReady: false,
            integrationsReady: false,
            browserAssistReady: false,
            inspectorEnabled: false,
            localOnly: false,
          },
        }),
      ),
    );
    assert.equal(requests.filter((request) => request === '/api/account/welcome').length, 1);
    assert.equal(requests.filter((request) => request === '/api/state').length, 3);
    assert.equal(window.localStorage.getItem('otto.chat-layout'), 'welcome');
    await act(async () => {
      window.history.pushState(null, '', '/vault');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    assert.ok(element.textContent?.includes('Your vault is empty'));
    assert.equal(requests.filter((request) => request === '/api/vault').length, 2);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    sessionStore.invalidate();
    globalThis.fetch = previous;
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    window.localStorage.removeItem('otto.chat-layout');
    window.history.replaceState(null, '', previousUrl);
  }
});

test('the startup ghost follows the last chat layout and says little until a start is slow', async () => {
  const { ChatSkeleton } = await import('../src/web/components/startup.tsx');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    window.localStorage.removeItem('otto.chat-layout');
    await act(async () =>
      root.render(createElement(ChatSkeleton, { slowAfterMs: 20, longAfterMs: 60 })),
    );
    assert.ok(element.querySelector('.ghost-welcome'));
    assert.equal(element.querySelector('.ghost-bubble'), null);
    assert.equal(element.querySelector('[role="status"]')?.textContent, 'Opening Otto…');
    assert.equal(element.querySelector('[role="status"] .sr-only') !== null, true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    assert.equal(element.querySelector('[role="status"]')?.textContent, 'Getting things ready…');
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    assert.equal(element.querySelector('[role="status"]')?.textContent, 'Still working on it.');
    assert.equal(/workspace|connect|sign/i.test(element.textContent ?? ''), false);
    await act(async () => root.unmount());
    window.localStorage.setItem('otto.chat-layout', 'conversation');
    const next = createRoot(element);
    await act(async () => next.render(createElement(ChatSkeleton)));
    assert.ok(element.querySelector('.ghost-bubble'));
    assert.equal(element.querySelector('.ghost-welcome'), null);
    await act(async () => next.unmount());
  } finally {
    window.localStorage.removeItem('otto.chat-layout');
    element.remove();
  }
});

test('Open conversation before app state arrives keeps the target and loads its history', async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = window.location.href;
  const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const previousMedia = window.matchMedia;
  const scrolled: string[] = [];
  HTMLElement.prototype.scrollIntoView = function () {
    if (this.dataset.messageId) scrolled.push(this.dataset.messageId);
  };
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const target = {
    id: 'requested-message',
    role: 'user',
    text: 'Adjust my plan',
    taskId: null,
    attachments: [],
    createdAt: '2026-09-28T10:00:00Z',
  };
  const state = {
    conversationRevision: 3,
    hasEarlierMessages: true,
    messages: [
      {
        ...target,
        id: 'recent-message',
        text: 'Latest conversation',
        createdAt: '2026-09-29T10:00:00Z',
      },
    ],
    tasks: [],
    configuration: {
      provider: 'fixture',
      model: 'fixture',
      llmReady: true,
      speechReady: false,
      integrationsReady: false,
      browserAssistReady: false,
      inspectorEnabled: false,
      localOnly: false,
    },
  };
  let finishState!: (response: Response) => void;
  const history: string[] = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path === '/api/session') return Response.json(account);
    if (path === '/api/state')
      return new Promise((resolve) => {
        finishState = resolve;
      });
    if (path.startsWith('/api/messages?')) {
      history.push(path);
      return Response.json({ conversationRevision: 3, messages: [target], hasMore: false });
    }
    return Response.json([]);
  };
  sessionStore.invalidate();
  window.history.replaceState(null, '', '/goals');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(App)));
    assert.ok(element.querySelector('.chat-skeleton'));
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('otto:focus-message', { detail: { messageId: target.id } }),
      ),
    );
    assert.equal(window.location.pathname, '/');
    assert.equal(element.querySelector<HTMLElement>('.chat-route')!.hidden, false);
    await act(async () => finishState(Response.json(state)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    assert.equal(history.length, 1);
    const query = new URL(history[0], window.location.origin).searchParams;
    assert.equal(query.get('beforeId'), 'recent-message');
    assert.equal(query.get('conversationRevision'), '3');
    const message = element.querySelector<HTMLElement>('[data-message-id="requested-message"]');
    assert.ok(message);
    assert.equal(document.activeElement, message);
    assert.ok(message.classList.contains('message-focused'));
    assert.ok(scrolled.includes(target.id));
  } finally {
    await act(async () => root.unmount());
    element.remove();
    sessionStore.invalidate();
    globalThis.fetch = previousFetch;
    window.history.replaceState(null, '', previousUrl);
    window.matchMedia = previousMedia;
    window.localStorage.removeItem('otto.chat-layout');
    if (previousScroll)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previousScroll);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});
