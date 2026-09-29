import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { SessionResponse } from '../src/shared/account.ts';
import type { AppState } from '../src/shared/contracts.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
});
for (const key of ['window', 'document', 'navigator', 'Event'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());

class Events {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: Events[] = [];
  readyState = Events.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    Events.all.push(this);
  }
  close() {
    this.readyState = Events.CLOSED;
  }
  open() {
    this.readyState = Events.OPEN;
    this.onopen?.();
  }
  fail(terminal = true) {
    this.readyState = terminal ? Events.CLOSED : Events.CONNECTING;
    this.onerror?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
const { createRoot } = await import('react-dom/client');
const { useAppState } = await import('../src/web/hooks/use-app-state.ts');
const { sessionStore } = await import('../src/web/lib/session.ts');

const account: SessionResponse = {
  auth: { mode: 'google', googleAvailable: true },
  user: { id: 'account-a', name: 'Alex Example', email: null, avatarUrl: null },
  settings: { theme: 'system', onboardingCompleted: true },
  capabilities: { developer: false },
};
const state: AppState = {
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
};

async function fixture(
  t: TestContext,
  options: { accountless?: boolean; session?: SessionResponse } = {},
) {
  const previousFetch = globalThis.fetch;
  Events.all = [];
  let currentSession = options.session ?? account;
  let currentState = state;
  let sessionResponse: (() => Promise<Response>) | undefined;
  let sessionReads = 0;
  let stateReads = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/logout') return Response.json({ ok: true });
    if (path === '/api/session') {
      sessionReads++;
      return sessionResponse ? sessionResponse() : Response.json(currentSession);
    }
    assert.equal(path, '/api/state');
    stateReads++;
    return Response.json(currentState);
  };
  sessionStore.invalidate();
  await sessionStore.refresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let app!: ReturnType<typeof useAppState>;
  function Fixture({ owner }: { owner?: string }) {
    app = useAppState(owner);
    return createElement('div', null, app.connected ? 'Connected' : 'Reconnecting');
  }
  let mounted = true;
  async function unmount() {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  }
  t.after(async () => {
    await unmount();
    element.remove();
    sessionStore.invalidate();
    t.mock.timers.reset();
    globalThis.fetch = previousFetch;
  });
  await act(async () =>
    root.render(
      createElement(Fixture, {
        key: account.user!.id,
        owner: options.accountless ? undefined : account.user!.id,
      }),
    ),
  );
  return {
    app: () => app,
    element,
    reads: () => ({ session: sessionReads, state: stateReads }),
    state(value: AppState) {
      currentState = value;
    },
    session(value: SessionResponse) {
      currentSession = value;
    },
    sessionResponse(value?: () => Promise<Response>) {
      sessionResponse = value;
    },
    render: (owner: string) =>
      act(async () => root.render(createElement(Fixture, { key: owner, owner }))),
    tick: (ms: number) => act(async () => t.mock.timers.tick(ms)),
    unmount,
  };
}

test('terminal event failure reconnects the accepted account without losing streamed text', async (t) => {
  const f = await fixture(t);
  const first = Events.all[0];
  const epoch = sessionStore.getSnapshot().epoch;
  await act(async () => {
    first.open();
    first.emit({ type: 'delta', taskId: 'task', streamId: 'reply', text: 'First ' });
    first.fail();
  });
  assert.equal(f.element.textContent, 'Reconnecting');
  await f.tick(999);
  assert.equal(Events.all.length, 1);
  await f.tick(1);
  assert.equal(Events.all.length, 2);
  assert.equal(sessionStore.getSnapshot().epoch, epoch);
  const next = Events.all[1];
  assert.equal(next.url, '/api/events?account=account-a');
  await act(async () => {
    next.open();
    next.emit({ type: 'delta', taskId: 'task', streamId: 'reply', text: 'second' });
  });
  assert.equal(f.element.textContent, 'Connected');
  assert.equal(f.app().streams.reply, 'First second');
  const reads = f.reads();
  await act(async () => {
    first.onopen?.();
    first.onerror?.();
    first.emit({ type: 'delta', taskId: 'old', streamId: 'stale', text: 'Stale reply' });
  });
  await f.tick(60_000);
  assert.deepEqual(f.reads(), reads);
  assert.equal(Events.all.length, 2);
  assert.equal(f.element.textContent, 'Connected');
  assert.equal(f.app().streams.stale, undefined);
  f.state({ ...state, conversationRevision: 1 });
  await act(async () => next.emit({ type: 'refresh' }));
  await act(async () =>
    next.emit({ type: 'delta', taskId: 'task', streamId: 'old-revision', text: 'Old revision' }),
  );
  assert.equal(f.app().state?.conversationRevision, 1);
  assert.deepEqual(f.app().streams, {});
});

test('native CONNECTING retries keep their source and do not schedule a duplicate', async (t) => {
  const f = await fixture(t);
  const first = Events.all[0];
  await act(async () => {
    first.open();
    first.fail(false);
  });
  assert.equal(f.element.textContent, 'Reconnecting');
  const reads = f.reads();
  await f.tick(120_000);
  assert.equal(Events.all.length, 1);
  assert.deepEqual(f.reads(), reads);
  assert.equal(first.readyState, Events.CONNECTING);
  await act(async () => first.open());
  assert.equal(f.element.textContent, 'Connected');
  assert.equal(Events.all.length, 1);
});

test('terminal failures deduplicate and back off while session refresh is unavailable', async (t) => {
  const f = await fixture(t);
  f.sessionResponse(async () => Response.json({ error: 'Updating' }, { status: 503 }));
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
    const source = Events.all.at(-1)!;
    await act(async () => {
      source.fail();
      source.fail();
    });
    const reads = f.reads();
    const count = Events.all.length;
    await f.tick(delay - 1);
    assert.equal(Events.all.length, count);
    assert.deepEqual(f.reads(), reads);
    await f.tick(1);
    assert.equal(Events.all.length, count + 1);
    assert.deepEqual(f.reads(), reads);
  }
  f.sessionResponse();
  const next = Events.all.at(-1)!;
  const count = Events.all.length;
  await act(async () => {
    next.open();
    next.fail();
  });
  await f.tick(999);
  assert.equal(Events.all.length, count);
  await f.tick(1);
  assert.equal(Events.all.length, count + 1);
});

test('unmount cancels terminal retries and fences stale source callbacks', async (t) => {
  const f = await fixture(t);
  const first = Events.all[0];
  await act(async () => first.fail());
  await f.unmount();
  const reads = f.reads();
  await act(async () => {
    first.onopen?.();
    first.onerror?.();
    first.emit({ type: 'refresh' });
  });
  await f.tick(60_000);
  assert.deepEqual(f.reads(), reads);
  assert.equal(Events.all.length, 1);
});

test('a late session refresh cannot reopen an unmounted workspace', async (t) => {
  const f = await fixture(t);
  let finish!: (response: Response) => void;
  f.sessionResponse(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = Events.all[0];
  await act(async () => first.fail());
  assert.ok(finish);
  await f.unmount();
  await act(async () => finish(Response.json(account)));
  await f.tick(60_000);
  assert.equal(Events.all.length, 1);
});

test('account replacement fences a pending retry and old events before remount', async (t) => {
  const f = await fixture(t);
  let finish!: (response: Response) => void;
  f.sessionResponse(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = Events.all[0];
  await act(async () => first.fail());
  const secondAccount = { ...account, user: { ...account.user!, id: 'account-b' } };
  f.sessionResponse();
  f.session(secondAccount);
  await act(async () => sessionStore.refresh());
  await act(async () => {
    first.onopen?.();
    first.emit({ type: 'delta', taskId: 'old', streamId: 'stale', text: 'Old account' });
  });
  assert.equal(f.app().streams.stale, undefined);
  await f.render(secondAccount.user.id);
  assert.equal(Events.all.length, 2);
  assert.equal(Events.all[1].url, '/api/events?account=account-b');
  await act(async () => finish(Response.json(account)));
  await f.tick(60_000);
  assert.equal(Events.all.length, 2);
  assert.equal(sessionStore.getSnapshot().session?.user?.id, 'account-b');
});

test('expired sessions close the source without reconnecting the previous account', async (t) => {
  const f = await fixture(t);
  const first = Events.all[0];
  f.session({ ...account, user: null, settings: null });
  await act(async () => first.fail());
  await f.tick(1000);
  const reads = f.reads();
  await f.tick(60_000);
  assert.equal(Events.all.length, 1);
  assert.equal(first.readyState, Events.CLOSED);
  assert.deepEqual(f.reads(), reads);
  assert.equal(sessionStore.getSnapshot().session?.user, null);
});

test('a hung session refresh cannot block terminal stream recovery', async (t) => {
  const f = await fixture(t);
  f.sessionResponse(() => new Promise(() => {}));
  await act(async () => Events.all[0].fail());
  const reads = f.reads();
  await f.tick(999);
  assert.equal(Events.all.length, 1);
  assert.deepEqual(f.reads(), reads);
  await f.tick(1);
  assert.equal(Events.all.length, 2);
  await act(async () => Events.all[1].open());
  await f.tick(60_000);
  assert.equal(Events.all.length, 2);
  assert.equal(f.element.textContent, 'Connected');
  assert.equal(f.reads().session, reads.session);
});

test('a superseded session refresh neither blocks nor duplicates terminal recovery', async (t) => {
  const f = await fixture(t);
  let finishFirst!: (response: Response) => void;
  let finishSecond!: (response: Response) => void;
  f.sessionResponse(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  await act(async () => Events.all[0].fail());
  const accepted = sessionStore.getSnapshot().session;
  f.sessionResponse(
    () =>
      new Promise((resolve) => {
        finishSecond = resolve;
      }),
  );
  const pending = sessionStore.refresh();
  await act(async () => finishFirst(Response.json(account)));
  assert.equal(sessionStore.getSnapshot().session, accepted);
  assert.equal(Events.all.length, 1);
  await f.tick(1000);
  assert.equal(Events.all.length, 2);
  await act(async () => {
    finishSecond(Response.json(account));
    await pending;
  });
  f.sessionResponse();
  await f.tick(60_000);
  assert.equal(Events.all.length, 2);
});

test('an accountless subscription requires an accepted account before opening a source', async (t) => {
  const f = await fixture(t, {
    accountless: true,
    session: { ...account, user: null, settings: null },
  });
  assert.equal(Events.all.length, 0);
  f.session(account);
  await act(async () => sessionStore.refresh());
  await f.tick(60_000);
  assert.equal(Events.all.length, 0);
  await f.render(account.user!.id);
  assert.equal(Events.all.length, 1);
  assert.equal(Events.all[0].url, '/api/events?account=account-a');
});

test('an accountless local subscription derives the accepted account for initial and replacement sources', async (t) => {
  const f = await fixture(t, {
    accountless: true,
    session: { ...account, auth: { mode: 'local', googleAvailable: false } },
  });
  assert.equal(Events.all[0].url, '/api/events?account=account-a');
  await act(async () => Events.all[0].fail());
  await f.tick(1000);
  assert.equal(Events.all.length, 2);
  assert.equal(Events.all[1].url, '/api/events?account=account-a');
});

for (const change of ['owner', 'epoch', 'signout'] as const)
  test(`an accountless subscription fences old callbacks and retries after ${change} changes`, async (t) => {
    const f = await fixture(t, { accountless: true });
    const first = Events.all[0];
    await act(async () => first.fail());
    const epoch = sessionStore.getSnapshot().epoch;
    await act(async () => {
      if (change === 'owner') {
        f.session({ ...account, user: { ...account.user!, id: 'account-b' } });
        await sessionStore.refresh();
      } else if (change === 'epoch') {
        sessionStore.invalidate();
        await sessionStore.refresh();
      } else await sessionStore.logout();
    });
    assert.ok(sessionStore.getSnapshot().epoch > epoch);
    const reads = f.reads();
    await act(async () => {
      first.onopen?.();
      first.onerror?.();
      first.emit({ type: 'delta', taskId: 'old', streamId: 'stale', text: 'Old session' });
    });
    await f.tick(60_000);
    assert.equal(Events.all.length, 1);
    assert.equal(first.readyState, Events.CLOSED);
    assert.equal(f.app().connected, false);
    assert.equal(f.app().streams.stale, undefined);
    assert.deepEqual(f.reads(), reads);
  });

test('opening the stream keeps an in-flight state read and queues one follow-up read', async (t) => {
  const f = await fixture(t);
  const reads: Array<{ signal: AbortSignal; finish(response: Response): void }> = [];
  globalThis.fetch = (path, options) => {
    assert.equal(path, '/api/state');
    return new Promise((resolve) => reads.push({ signal: options!.signal!, finish: resolve }));
  };
  const source = Events.all[0];
  await act(async () => source.emit({ type: 'refresh' }));
  assert.equal(reads.length, 1);
  await act(async () => {
    source.open();
    source.open();
  });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].signal.aborted, false);
  await act(async () => reads[0].finish(Response.json({ ...state, conversationRevision: 1 })));
  assert.equal(f.app().state?.conversationRevision, 1);
  assert.equal(reads.length, 2);
  await act(async () => reads[1].finish(Response.json({ ...state, conversationRevision: 1 })));
  assert.equal(reads.length, 2);
});
