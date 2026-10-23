import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AccountStore } from '../src/server/account-store.ts';
import type { AccountSettings } from '../src/shared/account.ts';
import { createAccountSession } from '../src/server/account.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import { createFilesystemKeyStore } from '../src/providers/filesystem/key-store.ts';
import { openCredential, sealCredential } from '../src/server/vault.ts';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, type Analytics, type CaptureAnalytics } from '../src/server/analytics.ts';
import { createLedger } from '../src/server/ledger.ts';
import { createModelTraces } from '../src/server/traces.ts';
import type { ModelTrace } from '../src/ports/traces.ts';
import { setRequestAccount } from '../src/web/lib/api.ts';
import { loadLinkPreview } from '../src/web/lib/link-previews.ts';
import { createOtlpTelemetry } from '../src/providers/otlp/telemetry.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { runProcess } from '../src/providers/process.ts';

test('settings Escape preserves nested interactions and pending changes before returning to the prior page', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'http://localhost/apps', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
        BroadcastChannel: undefined,
        EventSource: class { close() {} },
      });
      for (const name of ['Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLButtonElement',
        'HTMLTextAreaElement','HTMLSelectElement','MutationObserver','Event','KeyboardEvent',
        'CustomEvent','PopStateEvent','FocusEvent']) globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      let session = {
        user: { id: 'settings-owner', name: 'Synthetic owner', email: null, avatarUrl: null },
        settings: { theme: 'system', onboardingCompleted: true, usageData: false, traces: false },
        capabilities: { developer: false, traces: false },
      };
      let preferences = { notificationRule: '', locale: 'en-GB', timeZone: 'Europe/Lisbon',
        hourCycle: 'h23', quietHoursEnabled: false, quietStart: '22:00', quietEnd: '08:00' };
      let memory = { saving: true, sensitive: false, archive: [],
        notes: [{ path: 'about/synthetic.md', area: 'about', text: 'Original note', status: 'stated',
          updated: '2026-10-22T10:00:00Z', edited: null, expires: null, learnedFrom: null, sources: [] }],
        skills: [{ name: 'synthetic-skill', description: 'Original description', body: 'Original steps',
          learned: '2026-10-22T10:00:00Z', updated: '2026-10-22T10:00:00Z', edited: null, task: null }],
      };
      let finishSave;
      let finishMemorySave;
      globalThis.fetch = async (input, options = {}) => {
        const path = typeof input === 'string' ? input : input.url;
        if (path === '/api/session') return Response.json(session);
        if (path === '/api/preferences' && options.method === 'PATCH') {
          const change = JSON.parse(options.body);
          return new Promise(resolve => {
            finishSave = () => { preferences = { ...preferences, ...change }; resolve(Response.json(preferences)); };
          });
        }
        if (path === '/api/preferences') return Response.json(preferences);
        if (path === '/api/memory') return Response.json(memory);
        if (path.startsWith('/api/memory/notes/') && options.method === 'PATCH') {
          const change = JSON.parse(options.body);
          return new Promise(resolve => {
            finishMemorySave = () => {
              memory = { ...memory, notes: memory.notes.map(note => ({ ...note, ...change })) };
              resolve(Response.json(memory));
            };
          });
        }
        return new Promise(() => {});
      };
      const { createElement, useState, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { App } = await import('./src/web/app.tsx');
      const { Dialog, DialogContent, DialogTitle } = await import('./src/web/components/ui.tsx');
      let openDialog;
      function Fixture() {
        const [dialog, setDialog] = useState(false);
        openDialog = () => setDialog(true);
        return createElement('div', null, createElement(App), createElement(Dialog, {
          open: dialog, onOpenChange: setDialog,
        }, createElement(DialogContent, { 'aria-describedby': undefined },
          createElement(DialogTitle, null, 'Nested action'), createElement('button', null, 'Nested control'))));
      }
      const root = createRoot(document.querySelector('#root'));
      const settle = async (check) => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        assert.ok(check(), 'Expected settings interaction to settle');
      };
      const click = async (element) => { assert.ok(element); await act(async () => element.click()); };
      const escape = async (target = document.activeElement, options = {}) => {
        await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true, ...options,
        })));
      };
      const edit = async (label, value) => {
        const input = document.querySelector('[aria-label="' + label + '"]');
        assert.ok(input);
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        await act(async () => {
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      };
      const detailButton = label => [...document.querySelectorAll('.memory-detail button')]
        .find(button => button.textContent.trim() === label);
      const open = async () => {
        const trigger = document.querySelector('button[aria-label="Settings"]');
        trigger.focus();
        await click(trigger);
        await settle(() => document.querySelector('[aria-label="Quiet hours"]'));
        assert.equal(window.location.pathname, '/settings');
        return trigger;
      };
      try {
        await act(async () => root.render(createElement(Fixture)));
        await settle(() => document.querySelector('button[aria-label="Settings"]'));
        const link = document.createElement('a');
        link.href = '/settings/models';
        link.textContent = 'Synthetic screen link';
        document.querySelector('#workspace').append(link);
        link.focus();
        await click(link);
        await settle(() => window.location.pathname === '/settings/models');
        await escape();
        await settle(() => window.location.pathname === '/apps');
        await settle(() => document.activeElement === link);
        link.remove();
        const trigger = await open();
        await click(document.querySelector('[role="tab"][aria-label="Memory"]'));
        await escape();
        await settle(() => window.location.pathname === '/apps');
        await settle(() => document.activeElement === trigger);
        await open();
        await click(document.querySelector('[role="tab"][aria-label="Memory"]'));
        await settle(() => detailButton('Edit'));
        await click(detailButton('Edit'));
        await edit('Note', 'Changed note');
        await escape();
        assert.equal(window.location.pathname, '/settings/memory');
        assert.equal(document.querySelector('[aria-label="Note"]').value, 'Changed note');
        await click(document.querySelector('[role="tab"][aria-label="General"]'));
        assert.equal(window.location.pathname, '/settings/memory');
        await click(document.querySelector('[aria-label="Close settings"]'));
        assert.equal(window.location.pathname, '/settings/memory');
        const noteForm = document.querySelector('[aria-label="Note"]').closest('form');
        await act(async () => noteForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => finishMemorySave);
        await click(detailButton('Cancel'));
        await escape();
        assert.equal(window.location.pathname, '/settings/memory');
        await act(async () => finishMemorySave());
        await settle(() => detailButton('End date'));
        await click(detailButton('End date'));
        await edit('Keep until', '2099-10-22');
        await escape();
        assert.equal(window.location.pathname, '/settings/memory');
        assert.equal(document.querySelector('[aria-label="Keep until"]').value, '2099-10-22');
        await click(detailButton('Cancel'));
        await click([...document.querySelectorAll('.memory-stage')].find(button => button.textContent.includes('Skills')));
        await click(detailButton('Edit'));
        await edit('When to use it', 'Changed description');
        await escape();
        assert.equal(window.location.pathname, '/settings/memory');
        await edit('When to use it', 'Original description');
        await edit('Steps', 'Changed steps');
        await escape();
        assert.equal(window.location.pathname, '/settings/memory');
        assert.equal(document.querySelector('[aria-label="Steps"]').value, 'Changed steps');
        await click(detailButton('Cancel'));
        await escape();
        await settle(() => window.location.pathname === '/apps');
        await open();
        await escape(document.activeElement, { isComposing: true });
        await escape(document.activeElement, { repeat: true });
        assert.equal(window.location.pathname, '/settings');
        const consumed = event => event.preventDefault();
        document.addEventListener('keydown', consumed);
        await escape();
        document.removeEventListener('keydown', consumed);
        assert.equal(window.location.pathname, '/settings');
        await click(document.querySelector('[aria-label="Quiet hours"]'));
        await escape();
        assert.equal(window.location.pathname, '/settings');
        await click(document.querySelector('[role="tab"][aria-label="Models"]'));
        assert.equal(window.location.pathname, '/settings');
        const form = document.querySelector('[aria-label="Quiet hours"]').closest('form');
        await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => finishSave);
        await escape();
        assert.equal(window.location.pathname, '/settings');
        await act(async () => finishSave());
        await settle(() => !document.querySelector('.account-settings-actions'));
        await act(async () => openDialog());
        await settle(() => document.querySelector('[role="dialog"]'));
        await escape();
        await settle(() => !document.querySelector('[role="dialog"]'));
        assert.equal(window.location.pathname, '/settings');
        await click(document.querySelector('.time-zone-picker-trigger'));
        await settle(() => document.querySelector('[role="combobox"][aria-expanded="true"]'));
        await escape();
        await settle(() => !document.querySelector('[role="combobox"][aria-expanded="true"]'));
        assert.equal(window.location.pathname, '/settings');
        await escape();
        await settle(() => window.location.pathname === '/apps');
        await click(document.querySelector('a[href="/tasks"]'));
        await open();
        await escape();
        await settle(() => window.location.pathname === '/tasks');
        await act(async () => root.render(null));
        window.history.replaceState(null, '', '/settings/models');
        await act(async () => root.render(createElement(Fixture)));
        await settle(() => document.querySelector('.account-settings:not([hidden])'));
        await escape();
        await settle(() => window.location.pathname === '/');
        await settle(() => document.activeElement === document.querySelector('#workspace'));
        await act(async () => root.render(null));
        const { readFileSync } = await import('node:fs');
        const { runInNewContext } = await import('node:vm');
        const { sessionStore } = await import('./src/web/lib/session.ts');
        const listeners = new Map();
        const desktopPreferences = { theme: 'system', resolvedTheme: 'light',
          notifications: true, launchAtLogin: true, onboardingPreferenceStep: 'complete' };
        runInNewContext(readFileSync('./desktop/preload/engine.cjs', 'utf8'), {
          require: () => ({
            contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; } },
            ipcRenderer: {
              on: (name, listener) => listeners.set(name, listener),
              removeListener: name => listeners.delete(name),
              invoke: async name => name === 'nod:status' ? { phase: 'ready' } : desktopPreferences,
            },
          }),
        });
        session = { ...session, settings: { ...session.settings, onboardingCompleted: false } };
        await act(async () => {
          await sessionStore.refresh();
          root.render(createElement(Fixture));
        });
        await settle(() => window.location.pathname === '/onboarding');
        await act(async () => listeners.get('nod:navigate')({}, '/settings/models'));
        await settle(() => window.location.pathname === '/onboarding');
        session = { ...session, settings: { ...session.settings, onboardingCompleted: true } };
        await act(async () => {
          await sessionStore.refresh();
          window.history.replaceState(null, '', '/');
          window.dispatchEvent(new PopStateEvent('popstate'));
        });
        await settle(() => window.location.pathname === '/settings/models');
        await settle(() => document.querySelector('[role="tab"][aria-label="Models"][aria-selected="true"]'));
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('queued and cached link previews cannot cross an owner change', async (t) => {
  const calls: Array<{ url: string; account: string | null; respond(): void }> = [];
  const requests: ReturnType<typeof loadLinkPreview>[] = [];
  let automatic = false;
  t.mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
    const url = JSON.parse(String(options.body)).url as string;
    const account = new Headers(options.headers).get('X-nod-Account');
    const imageUrl = `/api/link-preview/image/${randomUUID()}`;
    return new Promise<Response>((resolve) => {
      const respond = () => resolve(Response.json({ preview: { url, imageUrl } }));
      calls.push({ url, account, respond });
      if (automatic) respond();
    });
  });
  const load = (url: string) => {
    const pending = loadLinkPreview(url);
    requests.push(pending);
    return pending;
  };
  t.after(async () => {
    automatic = true;
    for (const call of calls) call.respond();
    await Promise.all(requests);
    setRequestAccount(null);
  });
  setRequestAccount('fixture-first-owner');
  const cachedUrl = 'https://example.com/cached';
  const firstCached = load(cachedUrl);
  calls[0].respond();
  const cached = await firstCached;
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.com/queued-${index}`);
  const firstOwner = urls.map(load);
  setRequestAccount('fixture-next-owner');
  const nextOwner = load(urls[0]);
  const nextCached = load(cachedUrl);
  for (const call of calls.slice(1)) call.respond();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.filter((call) => call.account === 'fixture-next-owner').map((call) => call.url),
    [urls[0], cachedUrl],
  );
  assert.deepEqual(
    await Promise.all(firstOwner),
    urls.map(() => null),
  );
  const repeated = load(urls[0]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 7);
  for (const call of calls.filter((call) => call.account === 'fixture-next-owner')) call.respond();
  assert.ok(await nextOwner);
  assert.deepEqual(await repeated, await nextOwner);
  assert.notEqual((await nextCached)?.imageUrl, cached?.imageUrl);
});

describe('account routes', () => {
  const origin = 'http://localhost:4399';
  async function fixture(
    analytics?: Analytics,
    onTraces?: (enabled: boolean) => void,
    key?: string,
    onboardingMissing?: () => Promise<'brain' | 'email' | null>,
  ) {
    let record: AccountSettings = {
      theme: 'system',
      onboardingCompleted: false,
      usageData: false,
      traces: false,
    };
    const calls = { writes: 0, started: 0 };
    const accounts: AccountStore = {
      async readConsent() {
        return { enabled: record.usageData, revision: '0' };
      },
      async read() {
        return record;
      },
      async update(_owner, input) {
        calls.writes++;
        const saved = record;
        record = {
          theme: input.theme ?? saved.theme,
          onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
          usageData: input.usageData ?? saved.usageData,
          traces: input.traces ?? saved.traces,
        };
        return {
          ...record,
          onboardingCompletedNow: record.onboardingCompleted && !saved.onboardingCompleted,
        };
      },
    };
    const app = Fastify();
    if (key) registerLocalAccess(app, 4399, { key });
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'Invalid account request.' }),
    );
    createAccountSession({
      analytics,
      accounts,
      origin,
      localUser: { id: 'local-owner', name: 'You', email: null, avatarUrl: null },
      developerIds: new Set(['local-owner']),
      async start() {
        calls.started++;
      },
      traces: onTraces !== undefined,
      onTraces,
      onboardingMissing,
    }).register(app);
    await app.ready();
    return { app, calls, record: () => record };
  }

  test('first completion requires setup readiness without rechecking a completed profile', async (t) => {
    let ready = false;
    let failed = false;
    let checked = 0;
    const f = await fixture(undefined, undefined, undefined, async () => {
      checked++;
      if (failed) throw new Error('Synthetic provider outage');
      return ready ? null : 'email';
    });
    t.after(() => f.app.close());
    const complete = () =>
      f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { origin },
        payload: { onboardingCompleted: true },
      });
    const refused = await complete();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().step, 'email');
    assert.equal(f.record().onboardingCompleted, false);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
    failed = true;
    assert.equal((await complete()).statusCode, 503);
    assert.equal(f.record().onboardingCompleted, false);
    failed = false;
    ready = true;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(f.record().onboardingCompleted, true);
    const checks = checked;
    ready = false;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(checked, checks);
  });

  test('usage data stays off until the owner opts in and the environment switch always wins', async (t) => {
    for (const available of [true, false]) {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const installationId = randomUUID();
      const analytics = await createAnalytics({
        provider: available
          ? { capture: (event) => captured.push(event), shutdown: async () => {} }
          : undefined,
        environment: 'production',
        dataRoot: '.',
        installationId,
      });
      const f = await fixture(analytics);
      t.after(() => f.app.close());
      const request = (payload?: object) =>
        f.app.inject({
          method: payload ? 'PATCH' : 'GET',
          url: payload ? '/api/account' : '/api/session',
          headers: { origin },
          ...(payload ? { payload } : {}),
        });
      const initial = await request();
      assert.equal(initial.json().settings.usageData, false);
      assert.equal(initial.json().capabilities.traces, false);
      assert.deepEqual(
        [initial.json().analytics.enabled, initial.json().analytics.distinctId],
        [false, null],
      );
      await request({ onboardingCompleted: true });
      assert.equal(f.calls.started, 1);
      analytics.capture('local-owner', { event: 'nod_conversation_reset' });
      assert.equal(captured.length, 0);
      const opted = await request({ usageData: true });
      assert.equal(opted.statusCode, 200);
      assert.equal(opted.json().user.name, 'You');
      assert.equal(opted.json().settings.usageData, true);
      assert.equal(opted.json().analytics.enabled, available);
      assert.equal(f.record().usageData, true);
      await request({ theme: 'dark' });
      analytics.forOwner('local-owner')({ event: 'nod_chat_stopped' });
      assert.deepEqual(
        captured.map((event) => [event.distinctId, event.event]),
        available
          ? [
              [`local:${installationId}`, 'nod_settings_updated'],
              [`local:${installationId}`, 'nod_chat_stopped'],
            ]
          : [],
      );
      const declined = await request({ usageData: false });
      assert.equal(declined.json().analytics.enabled, false);
      analytics.capture('local-owner', { event: 'nod_chat_stopped' });
      assert.equal(captured.length, available ? 2 : 0);
    }
  });

  test('conversation traces stay off until the owner opts in, stop at once and leave without personal data', async (t) => {
    const delivered: ModelTrace[] = [];
    const traces = createModelTraces(async (trace) => {
      delivered.push(trace);
    });
    traces.configure({
      secrets: ['fixture-model-key-8c41f2'],
      profile: async () => ({ names: ['Marta Vidal'], region: 'ES' }),
    });
    const f = await fixture(undefined, (enabled) => traces.configure({ enabled }));
    t.after(() => f.app.close());
    const request = (payload?: object) =>
      f.app.inject({
        method: payload ? 'PATCH' : 'GET',
        url: payload ? '/api/account' : '/api/session',
        headers: { origin },
        ...(payload ? { payload } : {}),
      });
    const trace = (content: string): ModelTrace => ({
      id: randomUUID(),
      name: 'fixture-model',
      provider: 'fixture',
      startedAt: '2026-10-19T10:00:00.000Z',
      endedAt: '2026-10-19T10:00:01.000Z',
      messages: [
        { role: 'user', content },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'send_email',
                arguments:
                  '{"first_name":"Jordi","to":"jordi@example.com","address":{"line1":"12 Main St"},"password":"fixture-tool-secret-77","fields":[["password","fixture-pair-secret-88"]]}',
              },
            },
          ],
        },
      ],
      tools: ['send_email'],
      output: { role: 'assistant', content: 'Thanks Marta, sent to +44 20 7946 0958.' },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
      metadata: { session_id: 'fixture-session', turn_id: 'fixture-turn' },
    });
    const settle = async (count: number) => {
      for (let attempt = 0; attempt < 40 && delivered.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const initial = (await request()).json();
    assert.deepEqual([initial.capabilities.traces, initial.settings.traces], [true, false]);
    traces.record(trace('Before opting in'));
    await settle(1);
    assert.equal(traces.active(), false);
    assert.equal(delivered.length, 0);
    assert.equal((await request({ traces: true })).json().settings.traces, true);
    assert.equal(f.record().traces, true);
    traces.record(
      trace(
        'I am Marta Vidal <marta.vidal@example.com>, cc alice smith <alice@example.com>, card 4111 1111 1111 1111, IBAN ES91 2100 0418 4502 0005 1332, call 612 345 678, DNI 12345678Z, server 2001:db8::1 and 203.0.113.42. Host 192.168.1.1.example stays. Key fixture-model-key-8c41f2, order 123456 on 2026-10-19',
      ),
    );
    await settle(1);
    assert.equal(delivered.length, 1);
    const sent = JSON.stringify(delivered[0]);
    for (const value of [
      'Marta',
      'Vidal',
      'marta.vidal@example.com',
      'Jordi',
      'jordi@example.com',
      'alice smith',
      '12 Main St',
      '2001:db8::1',
      '203.0.113.42',
      '4111',
      'ES91',
      '612 345 678',
      '7946',
      '12345678Z',
      'fixture-model-key-8c41f2',
      'fixture-tool-secret-77',
      'fixture-pair-secret-88',
    ])
      assert.ok(!sent.includes(value), value);
    assert.match(sent, /order 123456 on 2026-10-19/);
    assert.match(sent, /192\.168\.1\.1\.example/);
    assert.deepEqual(Object.keys(delivered[0].metadata), ['session_id', 'turn_id']);
    assert.match(delivered[0].metadata.session_id, /^[0-9a-f]{32}$/);
    assert.ok(!sent.includes('fixture-session') && !sent.includes('fixture-turn'));
    traces.record(trace('A second request in the same conversation'));
    await settle(2);
    assert.equal(delivered[1].metadata.session_id, delivered[0].metadata.session_id);
    await request({ traces: false });
    traces.record(trace('After opting out'));
    await settle(3);
    assert.equal(delivered.length, 2);
  });

  test('account changes require the same origin and owner and never accept provider or owner input', async (t) => {
    const f = await fixture();
    t.after(() => f.app.close());
    const headers = { origin };
    for (const input of [
      { headers: { origin: 'https://foreign.example.test' }, payload: {}, status: 403 },
      { headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload: {}, status: 403 },
      { headers: { ...headers, 'x-nod-account': 'sam' }, payload: {}, status: 401 },
      { headers, payload: { ownerId: 'sam' }, status: 400 },
      { headers, payload: { provider: 'e2b' }, status: 400 },
      { headers, payload: { templateId: 'override' }, status: 400 },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/account/prepare',
        headers: input.headers,
        payload: input.payload,
      });
      assert.equal(response.statusCode, input.status);
    }
    for (const [extra, payload, status] of [
      [{ 'x-nod-account': 'sam' }, { theme: 'dark' }, 401],
      [{}, { name: 'Changed' }, 400],
      [{ origin: 'https://foreign.example.test' }, { theme: 'light' }, 403],
      [{}, { ownerId: 'sam' }, 400],
      [{}, { email: 'other@example.test' }, 400],
      [{}, { developer: true }, 400],
      [{}, { avatarUrl: 'https://example.test/pixel' }, 400],
      [{}, { traces: true }, 400],
    ] as const) {
      const response = await f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { ...headers, ...extra },
        payload,
      });
      assert.equal(response.statusCode, status);
    }
    const welcome = await f.app.inject({
      method: 'POST',
      url: '/api/account/welcome',
      headers,
      payload: {},
    });
    assert.equal(welcome.statusCode, 409);
    const prepared = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: { ...headers, 'x-nod-account': 'local-owner' },
      payload: {},
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
  });
});

describe('analytics privacy', () => {
  test('analytics reject arbitrary event names, unbounded identifiers and private properties', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const installationId = randomUUID();
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId,
    });
    analytics.setUsageData('owner-fixture', true);
    const capture = analytics.forOwner('owner-fixture');
    for (const event of [
      { event: 'private-chat-text' },
      { event: 'nod_onboarding_completed', distinctId: 'another-owner' },
      {
        event: 'nod_settings_updated',
        properties: { section: 'account', operation: 'update', name: 'Private Person' },
      },
      {
        event: 'nod_turn_started',
        properties: { source: 'user', channel: 'telegram:private-recipient', background: false },
      },
    ])
      capture(event as never);
    assert.equal(captured.length, 0);
    capture({
      event: 'nod_turn_started',
      properties: { source: 'user', channel: 'telegram', background: false },
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].distinctId, `local:${installationId}`);
  });

  test('visited websites and secure entries send only the registrable domain of an address', async () => {
    const { createWebsiteVisits } = await import('../src/server/analytics-connections.ts');
    const { captureSecureEntry } = await import('../src/server/vault-use.ts');
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const capture = analytics.forOwner('owner-fixture');
    const addresses = [
      'https://checkout.shop.example.co.uk/orders/private-person?email=person%40example.com#card',
      'https://www.example.co.uk/other',
      'http://192.168.1.20/admin',
      'http://localhost:4310/vault',
      'https://printer.local/status',
    ];
    analytics.withRun('owner-fixture', () => {
      const visited = createWebsiteVisits(analytics, 'owner-fixture');
      for (const address of addresses) {
        visited(address, 'browser', false);
        visited(address, 'fetch', true);
      }
    });
    for (const origin of addresses) {
      captureSecureEntry(capture, { kind: 'password', origin }, 'requested');
      captureSecureEntry(
        capture,
        { kind: 'card', origin, payment: { amount: 1234.5678, currency: 'EUR' } },
        'submitted',
      );
      captureSecureEntry(capture, { kind: 'otp', origin }, 'requested');
    }
    const sent = captured.map(({ event, properties }) => {
      const { analytics_schema, deployment, environment, capture_source, run_id, ...rest } =
        properties;
      return { event, ...rest };
    });
    assert.deepEqual(
      sent.filter(({ event }) => event === 'nod_website_visited'),
      [{ event: 'nod_website_visited', domain: 'example.co.uk', via: 'browser', subagent: false }],
    );
    const entries = sent.filter(({ event }) => event === 'nod_secure_entry_changed');
    assert.equal(entries.length, 15);
    assert.deepEqual(
      new Set(entries.map((entry) => JSON.stringify(entry))),
      new Set(
        [
          { kind: 'sign_in', status: 'requested', domain: 'example.co.uk' },
          { kind: 'sign_in', status: 'requested' },
          {
            kind: 'payment',
            status: 'submitted',
            domain: 'example.co.uk',
            currency: 'EUR',
            amount: 1234.568,
          },
          { kind: 'payment', status: 'submitted', currency: 'EUR', amount: 1234.568 },
          { kind: 'code', status: 'requested' },
        ].map((properties) => JSON.stringify({ event: 'nod_secure_entry_changed', ...properties })),
      ),
    );
    for (const value of [
      'checkout',
      'shop.',
      'private-person',
      'person%40',
      '192.168',
      'localhost',
    ])
      assert.ok(!JSON.stringify(captured).includes(value), value);
  });

  test('OTLP sends bounded model metadata without content or internal identifiers', async (t) => {
    const collector = Fastify();
    const received: { body: any; contentType: string | undefined }[] = [];
    let redirected = false;
    collector.post('/otel/v1/traces', (request) => {
      received.push({ body: request.body, contentType: request.headers['content-type'] });
      return {};
    });
    collector.post('/refuse/v1/traces', (request, reply) => {
      received.push({ body: request.body, contentType: request.headers['content-type'] });
      return reply.redirect('/unexpected', 307);
    });
    collector.post('/unexpected', () => {
      redirected = true;
      return {};
    });
    const origin = await collector.listen({ host: '127.0.0.1', port: 0 });
    t.after(() => collector.close());
    const telemetry = createOtlpTelemetry(`${origin}/otel/`)!;
    t.after(() => telemetry.shutdown());
    const turnId = randomUUID();
    const usage = {
      id: randomUUID(),
      turnId,
      provider: 'openai',
      model: 'fixture-model',
      category: 'agent',
      operation: 'request',
      status: 'succeeded',
      durationMs: 125,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      costUsd: 0.01,
      pricing: 'sdk_estimate',
      messages: ['Synthetic private message'],
      output: 'Synthetic private reply',
      apiKey: 'fixture-secret-value',
      ownerId: 'fixture-owner',
      sessionId: randomUUID(),
    } satisfies ProviderUsageEvent & Record<string, unknown>;
    telemetry.record(usage);
    telemetry.record({ ...usage, id: randomUUID(), status: 'failed', costUsd: null });
    telemetry.record({ ...usage, id: randomUUID(), turnId: randomUUID(), status: 'cancelled' });
    assert.equal(received.length, 0);
    await telemetry.shutdown();
    assert.equal(received.length, 1);
    assert.equal(received[0].contentType, 'application/json');
    const resource = received[0].body.resourceSpans[0];
    assert.deepEqual(resource.resource.attributes, [
      { key: 'service.name', value: { stringValue: 'nod' } },
    ]);
    const spans = resource.scopeSpans[0].spans;
    assert.equal(spans.length, 3);
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.notEqual(spans[0].traceId, spans[2].traceId);
    assert.equal(new Set(spans.map((span: any) => span.spanId)).size, 3);
    for (const span of spans) {
      assert.match(span.traceId, /^[0-9a-f]{32}$/);
      assert.match(span.spanId, /^[0-9a-f]{16}$/);
      assert.equal(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano), 125_000_000n);
    }
    assert.deepEqual(
      spans.map((span: any) => span.status.code),
      [0, 2, 0],
    );
    const attributes = (span: any) =>
      Object.fromEntries(span.attributes.map(({ key, value }: any) => [key, value]));
    assert.deepEqual(attributes(spans[0])['gen_ai.usage.input_tokens'], { intValue: '110' });
    assert.deepEqual(attributes(spans[0])['gen_ai.usage.output_tokens'], { intValue: '5' });
    assert.deepEqual(attributes(spans[0])['nod.usage.cost_usd'], { doubleValue: 0.01 });
    assert.equal(attributes(spans[1])['nod.usage.cost_usd'], undefined);
    assert.deepEqual(attributes(spans[2])['nod.status'], { stringValue: 'cancelled' });
    const body = JSON.stringify(received[0].body);
    for (const value of [
      usage.id,
      turnId,
      usage.sessionId,
      usage.ownerId,
      usage.apiKey,
      usage.messages[0],
      usage.output,
    ])
      assert.ok(!body.includes(value));

    const refused = createOtlpTelemetry(`${origin}/refuse`)!;
    t.after(() => refused.shutdown());
    for (let i = 0; i < 300; i++) refused.record({ ...usage, id: randomUUID() });
    await refused.shutdown();
    const buffered = received[1].body.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(buffered.length, 256);
    assert.notEqual(buffered[0].traceId, spans[0].traceId);
    refused.record(usage);
    await refused.shutdown();
    assert.equal(received.length, 2);
    assert.equal(redirected, false);
  });

  test('agent model usage analytics carry the request duration and cached input', async (t) => {
    const collector = Fastify();
    const spans: any[] = [];
    collector.post('/v1/traces', (request) => {
      spans.push(...(request.body as any).resourceSpans[0].scopeSpans[0].spans);
      return {};
    });
    const telemetry = createOtlpTelemetry(await collector.listen({ host: '127.0.0.1', port: 0 }))!;
    t.after(() => collector.close());
    t.after(() => telemetry.shutdown());
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
      telemetry,
    });
    const agent = ledger.agent({
      open: async (session) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async () =>
          session.onEvent({
            type: 'model_usage',
            id: randomUUID(),
            provider: 'openai',
            model: 'gpt-6-luna',
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 2000,
            cacheWriteTokens: 0,
            totalTokens: 2025,
            costUsd: 0.001,
            costSource: 'sdk_estimate',
            createdAt: new Date(Date.now() - 1_500).toISOString(),
          }),
      }),
      dispose() {},
    });
    const opened = await agent.open({ turnId: randomUUID(), onEvent() {} } as never);
    await opened.prompt('Synthetic', []);
    const used = captured.find((event) => event.event === 'nod_model_used')!;
    assert.equal(used.properties.input_tokens, 2020);
    assert.equal(used.properties.cached_input_tokens, 2000);
    assert.ok(Number(used.properties.duration_ms) >= 1_500);
    analytics.setUsageData('owner-fixture', false);
    await opened.prompt('Synthetic private content', []);
    await telemetry.shutdown();
    assert.equal(spans.length, 2);
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.equal(captured.filter((event) => event.event === 'nod_model_used').length, 1);
  });

  test('model usage analytics never send custom endpoint or unbounded model names', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
    });
    const usage = { category: 'review', operation: 'review', status: 'succeeded' } as const;
    await ledger
      .decisions({
        check: async (_request, _signal, report) => {
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'compatible',
            model: 'private-finance-model',
            durationMs: 12.4,
            inputTokens: 10,
            cacheReadTokens: 30,
            outputTokens: 5,
            costUsd: 0.0000123456,
          });
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'openrouter',
            model: 'acme/Private Person',
            durationMs: 0,
          });
          report?.({
            ...usage,
            id: randomUUID(),
            provider: 'openai',
            model: 'gpt-6-sol',
            durationMs: 0,
            costUsd: null,
            estimateUsd: 0.5,
          });
          return {};
        },
      })
      .check({ instructions: '', input: {}, question: { name: 'answer', choices: [] } });
    const shared = { purpose: 'review', outcome: 'succeeded' };
    assert.deepEqual(
      captured.map(({ properties }) => {
        const { analytics_schema, deployment, environment, capture_source, ...rest } = properties;
        return rest;
      }),
      [
        {
          ...shared,
          provider: 'compatible',
          model: 'custom',
          input_tokens: 40,
          output_tokens: 5,
          cached_input_tokens: 30,
          cost_usd: 0.000012,
          pricing: 'api',
          duration_ms: 12,
        },
        {
          ...shared,
          provider: 'openrouter',
          model: 'custom',
          input_tokens: 0,
          output_tokens: 0,
          pricing: 'unavailable',
        },
        {
          ...shared,
          provider: 'openai',
          model: 'gpt-6-sol',
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0.5,
          pricing: 'plan_estimate',
        },
      ],
    );
  });
});

describe('keychain', () => {
  test('concurrent first key requests create one key and return independent buffers', async () => {
    let saved: string | undefined;
    let adds = 0;
    const store = createKeychainKeyStore({
      platform: 'darwin',
      run: async (_command, args) => {
        await Promise.resolve();
        if (args[0] === 'find-generic-password') {
          if (!saved) throw Object.assign(new Error('not found'), { code: 44 });
          return { stdout: saved };
        }
        adds++;
        if (saved) throw Object.assign(new Error('duplicate'), { code: 45 });
        saved = args.at(-1)!;
        return { stdout: '' };
      },
    });
    const keys = await Promise.all(Array.from({ length: 10 }, () => store.getKey()));
    assert.equal(adds, 1);
    for (const key of keys) assert.equal(key.toString('base64'), saved);
    keys[0].fill(0);
    assert.equal(keys[1].toString('base64'), saved);
    assert.equal((await store.getKey()).toString('base64'), saved);
  });

  test('never creates a replacement Keychain key while sealed data exists', async () => {
    let adds = 0;
    let sealed = true;
    const store = createKeychainKeyStore({
      platform: 'darwin',
      canCreate: async () => !sealed,
      run: async (_command, args) => {
        if (args[0] === 'find-generic-password')
          throw Object.assign(new Error('not found'), { code: 44 });
        adds++;
        return { stdout: '' };
      },
    });
    await assert.rejects(store.getKey(), /missing/);
    assert.equal(adds, 0);
    sealed = false;
    assert.equal((await store.getKey()).length, 32);
    assert.equal(adds, 1);
  });
});

describe('filesystem Vault key', { skip: process.platform === 'win32' }, () => {
  test('new nested roots withhold their key until ancestor entries persist across readers and retries', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-ancestors-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dataRoot = join(root, 'new', 'nested', 'profile');
    const ancestor = await lstat(root);
    const handle = await open(root, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const sync = prototype.sync;
    await handle.close();
    let fail = true;
    t.mock.method(prototype, 'sync', async function (this: typeof handle) {
      const metadata = await this.stat();
      if (fail && metadata.dev === ancestor.dev && metadata.ino === ancestor.ino)
        throw Object.assign(new Error('Synthetic ancestor persistence failure'), { code: 'EIO' });
      return sync.call(this);
    });
    const first = createFilesystemKeyStore({ dataRoot, canCreate: async () => true });
    await assert.rejects(first.getKey(), { code: 'EIO' });
    const saved = await readFile(join(dataRoot, 'vault', 'master-key'), 'utf8');
    const second = createFilesystemKeyStore({ dataRoot, canCreate: async () => false });
    await Promise.all([
      assert.rejects(first.getKey(), { code: 'EIO' }),
      assert.rejects(second.getKey(), { code: 'EIO' }),
    ]);
    assert.equal(await readFile(join(dataRoot, 'vault', 'master-key'), 'utf8'), saved);
    fail = false;
    const keys = await Promise.all([first.getKey(), second.getKey()]);
    assert.ok(keys.every((key) => key.toString('base64') === saved));
    const entry = { id: randomUUID(), owner_id: 'synthetic-owner', origin: 'https://example.test' };
    const secret = { username: 'synthetic@example.test', password: 'synthetic-secret' };
    const ciphertext = sealCredential(keys[0], entry, secret);
    const restored = createFilesystemKeyStore({ dataRoot, canCreate: async () => false });
    assert.deepEqual(openCredential(await restored.getKey(), { ...entry, ciphertext }), secret);
  });

  test('directory persistence failures withhold the key and retry retains the published key', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-durability-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const handle = await open(root, 'r');
    const prototype = Object.getPrototypeOf(handle);
    const sync = prototype.sync;
    await handle.close();
    let fail = true;
    t.mock.method(prototype, 'sync', async function (this: typeof handle) {
      if ((await this.stat()).isDirectory() && fail)
        throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' });
      return sync.call(this);
    });
    const store = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => true });
    await assert.rejects(store.getKey(), { code: 'EIO' });
    const saved = await readFile(join(root, 'vault', 'master-key'), 'utf8');
    fail = false;
    const key = await store.getKey();
    assert.equal(key.toString('base64'), saved);
    const restored = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => false });
    fail = true;
    await assert.rejects(restored.getKey(), { code: 'EIO' });
    fail = false;
    assert.deepEqual(await restored.getKey(), key);
  });

  test('concurrent instances publish one private key and decrypt after restart', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-key-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o755);
    const stores = Array.from({ length: 12 }, () =>
      createFilesystemKeyStore({ dataRoot: root, canCreate: async () => true }),
    );
    const keys = await Promise.all(stores.map((store) => store.getKey()));
    const path = join(root, 'vault', 'master-key');
    const saved = await readFile(path, 'utf8');
    assert.equal(Buffer.from(saved, 'base64').length, 32);
    for (const key of keys) assert.equal(key.toString('base64'), saved);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, 'vault'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(root, 'vault')), ['master-key']);
    const entry = { id: randomUUID(), owner_id: 'synthetic-owner', origin: 'https://example.test' };
    const secret = { username: 'synthetic@example.test', password: 'synthetic-secret' };
    const ciphertext = sealCredential(keys[0], entry, secret);
    keys[0].fill(0);
    assert.equal(keys[1].toString('base64'), saved);
    const alias = join(root, 'trusted-alias');
    await symlink(root, alias);
    const restored = createFilesystemKeyStore({
      dataRoot: alias,
      canCreate: async () => {
        throw new Error('An existing key must not need creation permission.');
      },
    });
    assert.deepEqual(openCredential(await restored.getKey(), { ...entry, ciphertext }), secret);
    assert.deepEqual(openCredential(await stores[0].getKey(), { ...entry, ciphertext }), secret);
  });

  test('missing keys cannot replace sealed data and explicit retry preserves the new key', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-missing-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sealed = true;
    const store = createFilesystemKeyStore({ dataRoot: root, canCreate: async () => !sealed });
    const failed = await Promise.allSettled([store.getKey(), store.getKey()]);
    assert.ok(failed.every((result) => result.status === 'rejected'));
    await assert.rejects(lstat(join(root, 'vault', 'master-key')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(root, 'vault')), []);
    sealed = false;
    const key = await store.getKey();
    sealed = true;
    assert.deepEqual(await store.getKey(), key);
    await rm(join(root, 'vault', 'master-key'));
    await assert.rejects(store.getKey(), /missing/);
    assert.deepEqual(await readdir(join(root, 'vault')), []);
  });

  test('unsafe paths and invalid key contents are refused without replacement', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-unsafe-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = join(root, 'original');
    const originalKey = await createFilesystemKeyStore({
      dataRoot: original,
      canCreate: async () => true,
    }).getKey();
    for (const variant of [
      'symbolic directory',
      'symbolic key',
      'permissive directory',
      'permissive key',
      'writable root',
      'nonregular key',
      'invalid key',
    ]) {
      await t.test(variant, async () => {
        const dataRoot = join(root, variant.replaceAll(' ', '-'));
        const directory = join(dataRoot, 'vault');
        const path = join(directory, 'master-key');
        await mkdir(dataRoot, { mode: 0o700 });
        if (variant === 'symbolic directory') await symlink(join(original, 'vault'), directory);
        else {
          await mkdir(directory, { mode: 0o700 });
          if (variant === 'symbolic key')
            await symlink(join(original, 'vault', 'master-key'), path);
          else if (variant === 'nonregular key') await mkdir(path);
          else
            await writeFile(
              path,
              variant === 'invalid key' ? 'invalid' : originalKey.toString('base64'),
              { mode: 0o600 },
            );
          if (variant === 'permissive key') await chmod(path, 0o644);
          if (variant === 'permissive directory') await chmod(directory, 0o755);
        }
        if (variant === 'writable root') await chmod(dataRoot, 0o777);
        const previous = await lstat(path);
        let creationChecks = 0;
        const store = createFilesystemKeyStore({
          dataRoot,
          canCreate: async () => {
            creationChecks++;
            return true;
          },
        });
        await assert.rejects(store.getKey());
        assert.equal(creationChecks, 0);
        const current = await lstat(path);
        assert.equal(current.ino, previous.ino);
        assert.equal(current.mode, previous.mode);
      });
    }
    assert.equal(
      await readFile(join(original, 'vault', 'master-key'), 'utf8'),
      originalKey.toString('base64'),
    );
  });
});

test('server addresses keep host and port, add http and refuse other schemes, sign-ins, queries and fragments', async () => {
  const { endpointAddress } = await import('../src/server/models.ts');
  assert.deepEqual(
    [
      'localhost:11434',
      'localhost:11434/v1/',
      '192.168.1.5:8080',
      '[::1]:1234/v1',
      'ollama.local',
      'https://api.example.test/openai/v1',
      'file:/tmp',
      'ftp://example.test',
      'http://user:secret@localhost:11434',
      'http://localhost:11434?',
      'http://localhost:11434/v1#',
    ].map(endpointAddress),
    [
      'http://localhost:11434',
      'http://localhost:11434/v1',
      'http://192.168.1.5:8080',
      'http://[::1]:1234/v1',
      'http://ollama.local',
      'https://api.example.test/openai/v1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ],
  );
});

test('Azure endpoints need HTTPS away from this computer and resolve to the v1 API', async () => {
  const { azureAddress } = await import('../src/server/models.ts');
  assert.deepEqual(
    [
      'fixture.openai.azure.com',
      'https://fixture.openai.azure.com/',
      'https://fixture.cognitiveservices.azure.com/openai',
      'https://fixture.services.ai.azure.com/openai/v1/',
      'https://gateway.example.test/llm/openai/v1',
      'http://127.0.0.1:8443',
      'http://fixture.openai.azure.com',
      'https://user:secret@fixture.openai.azure.com',
      'https://fixture.openai.azure.com/?api-version=v1',
    ].map(azureAddress),
    [
      'https://fixture.openai.azure.com/openai/v1',
      'https://fixture.openai.azure.com/openai/v1',
      'https://fixture.cognitiveservices.azure.com/openai/v1',
      'https://fixture.services.ai.azure.com/openai/v1',
      'https://gateway.example.test/llm/openai/v1',
      'http://127.0.0.1:8443/openai/v1',
      undefined,
      undefined,
      undefined,
    ],
  );
});

describe('model connections', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const schema = `test_models_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await root.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const backend = createPiModelBackend({
      fetch: async (input) => {
        assert.equal(String(input), 'https://api.openai.com/v1/models');
        return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({ id })) });
      },
    });
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (
      ownerId: string,
      selectedBackend = backend,
      bootstrap?: Parameters<typeof createModelService>[0]['bootstrap'],
    ) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
        bootstrap,
      });
      await service.initialize();
      services.push(service);
      return service;
    };
    t.after(async () => {
      for (const service of services) await service.close();
      await database.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    return { create, database, backend, keyStore };
  }

  function subscriptionCredential(expires = Date.now() + 3600000) {
    return {
      type: 'oauth' as const,
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires,
      accountId: 'fixture-account',
      clientId: 'fixture-client',
      idToken: 'fixture-id-token',
    };
  }

  function stubSignIn(
    exchange: () => Promise<import('../src/ports/models.ts').ModelCredential>,
    aborted?: () => void,
  ): import('../src/ports/models.ts').ModelBackend['signIn'] {
    return async ({ signal }) => {
      const state = randomBytes(16).toString('hex');
      let resolve!: (value: import('../src/ports/models.ts').ModelCredential) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<import('../src/ports/models.ts').ModelCredential>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      signal.addEventListener(
        'abort',
        () => {
          aborted?.();
          reject(new Error('Sign-in cancelled.'));
        },
        { once: true },
      );
      return {
        url: `https://auth.openai.com/authorize?state=${state}`,
        state,
        result,
        complete(callback) {
          assert.equal(callback.searchParams.get('state'), state);
          void exchange().then(resolve, reject);
        },
      };
    };
  }

  test('image fallback uses owned connected models without changing the chat selection and reads current credentials', async (t) => {
    const f = await fixture(t);
    const backend = {
      ...f.backend,
      catalog: async (
        provider: import('../src/shared/models.ts').ModelProvider,
        method: import('../src/shared/models.ts').ModelMethod,
        credential?: import('../src/ports/models.ts').ModelCredential,
      ) => {
        const definitions = await f.backend.catalog('openai', method, credential);
        return definitions.map((definition) => ({
          ...definition,
          choice: {
            ...definition.choice,
            images: credential?.type === 'api_key' && credential.key === 'fixture-vision',
          },
        }));
      },
    };
    const owner = await f.create('fixture-images', backend);
    const other = await f.create('fixture-images-other', backend);
    await other.addKey('openai', 'fixture-vision');
    const textId = await owner.addKey('openai', 'fixture-text');
    const selection = owner.view().selection!;
    assert.equal(owner.hasImageModel(), false);
    await assert.rejects(owner.resolveImage(), /Connect a model that accepts images/);
    const visionId = await owner.addKey('openai', 'fixture-vision');
    await owner.select({ ...selection, connectionId: textId });
    assert.equal(owner.hasImageModel(), true);
    const access = await owner.resolveImage();
    assert.equal(access.definition.choice.images, true);
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-vision' });
    assert.deepEqual(owner.view().selection, { ...selection, connectionId: textId });
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-images',
      keyStore: f.keyStore,
    });
    await store.initialize();
    await store.change((state) => {
      state.connections.find((row) => row.id === visionId)!.credential = {
        type: 'api_key',
        key: 'fixture-updated',
      };
    });
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-updated' });
    await owner.remove(visionId);
    assert.equal(await access.read(), undefined);
    assert.equal(owner.hasImageModel(), false);
    assert.equal((await owner.resolve()).definition.choice.images, false);
  });

  test('model connections verify credential storage before opening sign-in or calling a provider', async (t) => {
    const f = await fixture(t);
    const { createEnvironmentKeyStore } = await import('../src/providers/environment/key-store.ts');
    const invalidKey = 'a'.repeat(64);
    Object.assign(f.keyStore, createEnvironmentKeyStore(invalidKey));
    const calls = { signIn: 0, authorize: 0, catalog: 0 };
    let rejectSignIn = false;
    const signIn = stubSignIn(async () => {
      if (rejectSignIn) throw new Error('Synthetic sign-in failure');
      return subscriptionCredential();
    });
    const owner = await f.create('fixture-owner', {
      ...f.backend,
      signIn(input) {
        calls.signIn++;
        return signIn(input);
      },
      authorize(input) {
        calls.authorize++;
        return f.backend.authorize(input);
      },
      catalog(provider, method) {
        calls.catalog++;
        return f.backend.catalog(provider, method);
      },
    });
    const app = Fastify();
    const captured: Parameters<CaptureAnalytics>[0][] = [];
    owner.register(app, (event) => captured.push(event));
    t.after(() => app.close());
    for (const [url, payload] of [
      ['/api/models/oauth', { provider: 'openai' }],
      ['/api/models/oauth', { provider: 'openrouter' }],
      ['/api/models/keys', { provider: 'openai', key: 'fixture-provider-key' }],
      ['/api/models/endpoints', { url: 'http://localhost:11434/v1' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(invalidKey));
      assert.deepEqual(calls, { signIn: 0, authorize: 0, catalog: 0 });
    }
    const failures = [
      { provider: 'openai', method: 'subscription' },
      { provider: 'openrouter', method: 'oauth' },
      { provider: 'openai', method: 'api_key' },
      { provider: 'compatible', method: 'api_key' },
    ].map((properties) => ({
      event: 'nod_model_connection_changed',
      properties: { ...properties, status: 'failed' },
    }));
    assert.deepEqual(captured, failures);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    Object.assign(f.keyStore, createEnvironmentKeyStore(Buffer.alloc(32, 77).toString('base64')));
    const started = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(started.statusCode, 200);
    const { attempt } = started.json();
    const completed = await app.inject({
      method: 'POST',
      url: '/api/models/oauth/complete',
      payload: {
        url: `http://127.0.0.1:1455/auth/callback?state=${attempt}&code=fixture`,
      },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(owner.signInStatus(attempt), { status: 'connected' });
    assert.deepEqual(calls, { signIn: 1, authorize: 0, catalog: 1 });
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 1);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 1);
    assert.equal((await (await owner.resolve()).read())?.type, 'oauth');
    assert.ok(!JSON.stringify(owner.view()).includes('fixture-access'));
    assert.deepEqual(captured, [
      ...failures,
      {
        event: 'nod_model_connection_changed',
        properties: { provider: 'openai', method: 'subscription', status: 'connected' },
      },
    ]);
    rejectSignIn = true;
    const next = await owner.start('openai');
    await assert.rejects(
      owner.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${next.attempt}&code=fixture`),
      ),
    );
    assert.deepEqual(captured.slice(failures.length + 1), [failures[0]]);
    assert.deepEqual(calls, { signIn: 2, authorize: 0, catalog: 1 });
  });

  test('model storage preflight preserves database failures without exposing their cause', async (t) => {
    const f = await fixture(t);
    const { checkedKeyStore } = await import('../src/server/vault.ts');
    const { createEnvironmentKeyStore } = await import('../src/providers/environment/key-store.ts');
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `${f.database.options.options} -c lock_timeout=50ms`,
      max: 1,
    });
    t.after(() => database.end());
    let providerCalls = 0;
    const owner = await f.create('fixture-owner', {
      ...f.backend,
      async signIn() {
        providerCalls++;
        throw new Error('Unexpected provider call');
      },
      async catalog() {
        providerCalls++;
        throw new Error('Unexpected provider call');
      },
    });
    Object.assign(
      f.keyStore,
      checkedKeyStore(database, createEnvironmentKeyStore(Buffer.alloc(32, 77).toString('base64'))),
    );
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (value: string) => logs.push(value) } } });
    const captured: Parameters<CaptureAnalytics>[0][] = [];
    owner.register(app, (event) => captured.push(event));
    t.after(() => app.close());
    const blocker = await f.database.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE nod_locks IN ACCESS EXCLUSIVE MODE');
      await assert.rejects(owner.start('openai'), (error: Error) => {
        assert.ok(error.cause instanceof pg.DatabaseError);
        assert.equal(error.cause.code, '55P03');
        assert.ok(!error.message.includes('NOD_VAULT_KEY'));
        assert.ok(!Object.keys(error).includes('cause'));
        return true;
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider: 'openai', key: 'fixture-provider-key' },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(Object.keys(response.json()), ['error']);
      assert.ok(!response.body.includes('NOD_VAULT_KEY'));
      assert.ok(!response.body.includes('55P03'));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const privateValue = 'fixture-private-storage-secret';
    const cause = new Error(`Storage connection failed: ${privateValue}`);
    f.keyStore.getKey = async () => {
      throw cause;
    };
    await assert.rejects(owner.addKey('openai', 'fixture-provider-key'), (error: Error) => {
      assert.equal(error.cause, cause);
      assert.ok(!JSON.stringify(error).includes(privateValue));
      return true;
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(Object.keys(response.json()), ['error']);
    assert.ok(!response.body.includes(privateValue));
    assert.ok(!logs.join('').includes(privateValue));
    assert.ok(!logs.join('').includes('55P03'));
    assert.deepEqual(
      captured,
      ['subscription', 'api_key', 'api_key', 'subscription'].map((method) => ({
        event: 'nod_model_connection_changed',
        properties: { provider: 'openai', method, status: 'failed' },
      })),
    );
    assert.equal(providerCalls, 0);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
  });

  test('model store batches owned credentials and keeps transient key failures distinct from unavailable grants', async (t) => {
    const f = await fixture(t);
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const owner = await f.create('fixture-owner');
    const ids = await Promise.all(
      ['one', 'two', 'three'].map((name) => owner.addKey('openai', `fixture-${name}`)),
    );
    const other = await f.create('fixture-other');
    const foreign = await other.addKey('openai', 'fixture-foreign');
    const originalKey = f.keyStore.getKey;
    let unlocks = 0;
    f.keyStore.getKey = async () => {
      unlocks++;
      return originalKey();
    };
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
    });
    await store.initialize();
    const state = await store.read();
    assert.equal(unlocks, 1);
    assert.deepEqual(new Set(state.connections.map((row) => row.id)), new Set(ids));
    assert.ok(state.connections.every((row) => row.credential?.type === 'api_key'));
    unlocks = 0;
    await store.change(() => {});
    assert.equal(unlocks, 1);
    const snapshot = async () => ({
      connections: (await f.database.query('SELECT * FROM model_connections ORDER BY id')).rows,
      settings: (await f.database.query('SELECT * FROM model_settings ORDER BY owner_id')).rows,
      grants: (await f.database.query('SELECT * FROM vault_app_grants ORDER BY id')).rows,
    });
    const before = await snapshot();
    f.keyStore.getKey = async () => {
      throw new Error('Synthetic temporarily locked key store');
    };
    const initialization = await f.create('fixture-owner').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.deepEqual(await snapshot(), before);
    assert.ok(initialization instanceof Error);
    assert.match(initialization.message, /temporarily locked key store/);
    await assert.rejects((await owner.resolve()).read(), /temporarily locked key store/);
    assert.deepEqual(await snapshot(), before);
    f.keyStore.getKey = originalKey;
    const recovered = await f.create('fixture-owner');
    assert.ok(recovered.view().connections.every((row) => row.status === 'connected'));
    assert.deepEqual(recovered.view().selection, owner.view().selection);
    assert.deepEqual(await (await recovered.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-one',
    });
    assert.deepEqual(await snapshot(), before);
    f.keyStore.getKey = async () => {
      unlocks++;
      return originalKey();
    };
    await f.database.query('UPDATE vault_app_grants SET expires_at=now() WHERE id=$1', [ids[0]]);
    await f.database.query(
      'UPDATE vault_app_grants SET ciphertext=(SELECT ciphertext FROM vault_app_grants WHERE id=$2) WHERE id=$1',
      [ids[1], foreign],
    );
    unlocks = 0;
    const unavailable = await store.read();
    assert.equal(unlocks, 1);
    assert.equal(unavailable.connections.find((row) => row.id === ids[0])?.credential, undefined);
    assert.equal(unavailable.connections.find((row) => row.id === ids[1])?.credential, undefined);
    assert.equal(
      unavailable.connections.find((row) => row.id === ids[2])?.credential?.type,
      'api_key',
    );
    assert.ok(!JSON.stringify(unavailable).includes('fixture-foreign'));
    const missing = await f.create('fixture-owner');
    assert.equal(missing.view().connections.find((row) => row.id === ids[0])?.status, 'reconnect');
    assert.equal(missing.view().connections.find((row) => row.id === ids[1])?.status, 'reconnect');
    assert.equal(missing.view().connections.find((row) => row.id === ids[2])?.status, 'connected');
    f.keyStore.getKey = async () => {
      throw new Error('Synthetic locked key store');
    };
    await assert.rejects(store.read(), /locked key store/);
  });

  test('catalog refresh releases the owner lock and rejects changed or removed model credentials', async (t) => {
    for (const change of ['selection', 'credential', 'reconnect', 'remove'] as const) {
      await t.test(change, async (t) => {
        const f = await fixture(t);
        const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let waiting = false;
        const owner = await f.create('fixture-owner', {
          ...f.backend,
          async catalog(...args: Parameters<typeof f.backend.catalog>) {
            const models = await f.backend.catalog(args[0], args[1], args[2]);
            if (waiting) {
              entered();
              await gate;
            }
            return models;
          },
        });
        const id = await owner.addKey('openai', 'fixture-original-key');
        const otherId = await owner.addKey('openai', 'fixture-second-key');
        const store = createDatabaseModelStore({
          database: f.database,
          ownerId: 'fixture-owner',
          keyStore: f.keyStore,
        });
        await store.initialize();
        waiting = true;
        const refreshing = owner.refreshCatalog(id);
        const outcome = refreshing.then(
          () => undefined,
          (error: unknown) => error,
        );
        await started;
        const client = await f.database.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT key FROM nod_locks WHERE key=$1 FOR UPDATE NOWAIT', [
            'models:fixture-owner',
          ]);
          await client.query('ROLLBACK');
          if (change === 'selection') {
            const model = owner.view().connections.find((row) => row.id === otherId)!.models[0];
            await owner.select({
              connectionId: otherId,
              modelId: model.id,
              effort: model.efforts[0],
            });
          } else if (change === 'remove') await owner.remove(id);
          else
            await store.change((state) => {
              const row = state.connections.find((item) => item.id === id)!;
              if (change === 'credential')
                row.credential = { type: 'api_key', key: 'fixture-new-key' };
              else row.status = 'reconnect';
            });
          const before = await store.read();
          release();
          const error = await outcome;
          if (change === 'selection') {
            assert.equal(error, undefined);
            assert.equal(owner.view().selection?.connectionId, otherId);
          } else {
            assert.ok(error instanceof Error);
            assert.deepEqual(await store.read(), before);
          }
        } finally {
          await client.query('ROLLBACK');
          client.release();
          release();
          await outcome;
        }
      });
    }
  });

  test('saved keys stay encrypted and owner-scoped; a removed connection cannot supply a later turn', async (t) => {
    const f = await fixture(t);
    const owner = await f.create('fixture-owner');
    const other = await f.create('fixture-other');
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
    const first = await owner.addKey('openai', 'fixture-first-api-key');
    assert.equal(owner.hasApiKey('openai'), true);
    assert.equal(await owner.apiKey('openai'), 'fixture-first-api-key');
    assert.equal(other.hasApiKey('openai'), false);
    assert.equal(await other.apiKey('openai'), undefined);
    const original = owner.view().selection!;
    const captured = await owner.resolve();
    const second = await owner.addKey('openai', 'fixture-second-api-key');
    assert.equal(await owner.apiKey('openai'), 'fixture-first-api-key');
    await assert.rejects(other.select(original));
    await other.remove(first);
    assert.equal((await captured.read())?.type, 'api_key');
    const ciphertext = JSON.stringify(
      (await f.database.query('SELECT * FROM vault_app_grants')).rows,
    );
    assert.ok(!ciphertext.includes('fixture-first-api-key'));
    assert.ok(!ciphertext.includes('fixture-second-api-key'));
    assert.ok(!JSON.stringify(owner.view()).includes('fixture-first-api-key'));
    assert.deepEqual(other.view().connections, []);
    await owner.select({ connectionId: second, modelId: 'gpt-6.1-sol', effort: 'medium' });
    assert.equal(await owner.apiKey('openai'), 'fixture-second-api-key');
    assert.equal(((await captured.read()) as { key: string }).key, 'fixture-first-api-key');
    await owner.remove(second);
    assert.equal(owner.configured, false);
    assert.equal(await owner.apiKey('openai'), 'fixture-first-api-key');
    assert.equal(
      (await f.database.query('SELECT id FROM vault_app_grants WHERE id=$1', [second])).rowCount,
      0,
    );
    const third = await owner.addKey('openai', 'fixture-third-api-key');
    assert.equal(await owner.apiKey('openai'), 'fixture-third-api-key');
    const fourth = await owner.addKey('openai', 'fixture-fourth-api-key');
    await owner.remove(third);
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
    await owner.select(original);
    assert.equal(await owner.apiKey('openai'), 'fixture-first-api-key');
    await owner.remove(fourth);
    await owner.remove(first);
    assert.equal(await captured.read(), undefined);
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
  });

  test('OpenAI-compatible servers connect from Models or server settings, and keep their key out of storage', async (t) => {
    const f = await fixture(t);
    const { createServer } = await import('node:http');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const server = createServer((request, response) => {
      const found = request.url === '/v1/models';
      response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(found ? { data: [{ id: 'fixture-local' }] } : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const owner = await f.create('fixture-owner', createPiModelBackend());
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('fixture-owner', true);
    owner.register(Fastify(), analytics.forOwner('fixture-owner'));
    const id = await owner.addEndpoint(
      `${address.slice('http://'.length)}/`,
      'fixture-endpoint-key',
    );
    await owner.select({ connectionId: id, modelId: 'fixture-local', effort: 'off' });
    const { captureConnectionInventory } = await import('../src/server/analytics-connections.ts');
    await captureConnectionInventory(
      analytics,
      'fixture-owner',
      async () => [],
      () => owner.analyticsConnections(),
    );
    assert.deepEqual(
      captured.map(({ event, properties }) => {
        const { analytics_schema, deployment, environment, capture_source, ...rest } = properties;
        return { event, ...rest };
      }),
      [
        {
          event: 'nod_model_connection_changed',
          provider: 'compatible',
          method: 'api_key',
          status: 'connected',
        },
        {
          event: 'nod_model_connection_observed',
          provider: 'compatible',
          method: 'api_key',
          selected: true,
          model: 'custom',
          effort: 'off',
        },
      ],
    );
    const access = await owner.resolve();
    assert.equal(access.definition.spec.baseUrl, `${address}/v1`);
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
    assert.deepEqual(await access.read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-endpoint-key',
    });
    assert.equal(await owner.addEndpoint(address, 'fixture-rotated-key'), id);
    assert.equal(owner.view().connections.length, 1);
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-rotated-key',
    });
    const bootstrap = {
      provider: 'compatible' as const,
      credentials: {
        compatible: { type: 'endpoint' as const, url: address, key: 'fixture-server-key' },
      },
    };
    const configured = await f.create('fixture-server', createPiModelBackend(), bootstrap);
    const [managed] = configured.view().connections;
    assert.deepEqual(
      [managed.managed, managed.status, configured.view().selection?.modelId],
      [true, 'connected', 'fixture-local'],
    );
    assert.equal((await (await configured.resolve()).read())?.type, 'endpoint');
    await assert.rejects(configured.remove(managed.id));
    const stored = JSON.stringify([
      (await f.database.query('SELECT * FROM vault_app_grants')).rows,
      (await f.database.query('SELECT * FROM model_connections')).rows,
    ]);
    assert.ok(!stored.includes('fixture-endpoint-key'));
    assert.ok(!stored.includes('fixture-server-key'));
    assert.ok(!stored.includes('fixture-rotated-key'));
  });

  test('sign-in is single-use; refresh and removal serialize across service instances without restoring a removed key', async (t) => {
    const f = await fixture(t);
    let exchanges = 0;
    let refreshes = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
      async exchange() {
        exchanges++;
        return {
          type: 'oauth' as const,
          access: 'fixture-old-access',
          refresh: 'fixture-old-refresh',
          expires: 0,
          accountId: 'fixture-account',
          clientId: 'fixture-client',
          idToken: 'fixture-id-token',
        };
      },
      async refresh(value: import('../src/ports/models.ts').ModelCredential) {
        if (value.type !== 'oauth') throw new Error('Expected an account credential.');
        refreshes++;
        entered();
        await gate;
        return {
          ...value,
          access: 'fixture-rotated-access',
          refresh: 'fixture-rotated-refresh',
          expires: Date.now() + 3600000,
        };
      },
    };
    backend.signIn = stubSignIn(() => backend.exchange());
    const owner = await f.create('fixture-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const payload of [
      { provider: 'anthropic' },
      { provider: 'openrouter', connectionId: randomUUID() },
    ]) {
      const rejected = await app.inject({ method: 'POST', url: '/api/models/oauth', payload });
      assert.equal(rejected.statusCode, 400);
    }
    const initiated = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(initiated.statusCode, 200, initiated.body);
    const signIn = initiated.json();
    const auth = new URL(signIn.url);
    const status = () => app.inject({ url: `/api/models/oauth/status/${signIn.attempt}` });
    assert.deepEqual((await status()).json(), { status: 'waiting' });
    const other = await f.create('fixture-other', backend);
    const otherApp = Fastify();
    other.register(otherApp);
    t.after(() => otherApp.close());
    assert.equal(
      (await otherApp.inject({ url: `/api/models/oauth/status/${signIn.attempt}` })).json().status,
      'failed',
    );
    const callback = new URL(
      `http://127.0.0.1:1455/auth/callback?state=${auth.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
    );
    const complete = () =>
      app.inject({
        method: 'POST',
        url: '/api/models/oauth/complete',
        payload: { url: callback.href },
      });
    assert.equal((await complete()).statusCode, 200);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    assert.equal((await complete()).statusCode, 400);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const repeated = await app.inject({
      url: `/api/models/oauth/callback?state=${signIn.attempt}&code=fixture-code`,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(exchanges, 1);
    const restored = await f.create('fixture-owner', backend);
    assert.equal(restored.hasApiKey('openai'), false);
    assert.equal(await restored.apiKey('openai'), undefined);
    const a = await owner.resolve();
    const b = await restored.resolve();
    const firstRead = a.read();
    await started;
    const secondRead = b.read();
    release();
    assert.equal(((await firstRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(((await secondRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(refreshes, 1);
    const id = owner.view().connections[0].id;
    const reconnectSignIn = await owner.start('openai', id);
    const reconnect = new URL(reconnectSignIn.url);
    await restored.remove(id);
    await assert.rejects(
      owner.complete(
        new URL(
          `http://127.0.0.1:1455/auth/callback?state=${reconnect.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
        ),
      ),
    );
    assert.equal(owner.signInStatus(reconnectSignIn.attempt).status, 'failed');
    assert.equal(await a.read(), undefined);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    let exchanging!: () => void;
    let finishExchange!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      exchanging = resolve;
    });
    const exchangeGate = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const slow = await f.create('fixture-slow', {
      ...backend,
      async exchange() {
        exchanging();
        await exchangeGate;
        exchanges++;
        return { type: 'api_key' as const, key: 'fixture-openrouter-key' };
      },
    });
    const slowApp = Fastify();
    slow.register(slowApp);
    t.after(() => slowApp.close());
    const slowSignIn = await slow.start('openrouter');
    const slowCallback = `/api/models/oauth/callback?state=${slowSignIn.attempt}&code=fixture-code`;
    const first = slowApp.inject({ url: slowCallback });
    await exchangeStarted;
    const second = slowApp.inject({ url: slowCallback });
    const exchangesBefore = exchanges;
    finishExchange();
    assert.deepEqual(
      (await Promise.all([first, second])).map((response) => response.statusCode),
      [200, 200],
    );
    assert.equal(exchanges, exchangesBefore + 1);
    assert.equal(slow.hasApiKey('openrouter'), true);
    assert.equal(await slow.apiKey('openrouter'), 'fixture-openrouter-key');
    assert.equal(slow.hasApiKey('openai'), false);
    const routerId = slow.view().connections[0].id;
    await slow.remove(routerId);
    assert.equal(slow.hasApiKey('openrouter'), false);
    assert.equal(await slow.apiKey('openrouter'), undefined);
    const failed = await f.create('fixture-failed', {
      ...backend,
      exchange: async () => {
        throw new Error('fixture-secret-must-stay-private');
      },
    });
    const rejected = await failed.start('openrouter');
    const rejectedCallback = new URL(
      `http://127.0.0.1:4310/api/models/oauth/callback?state=${rejected.attempt}&code=fixture-code`,
    );
    await assert.rejects(failed.complete(rejectedCallback));
    assert.equal(failed.signInStatus(rejected.attempt).status, 'failed');
    assert.ok(!JSON.stringify(failed.signInStatus(rejected.attempt)).includes('fixture-secret'));
    await assert.rejects(failed.complete(rejectedCallback));
  });

  test('a verified account survives catalog failure and recovers without repeating sign-in', async (t) => {
    const f = await fixture(t);
    let exchanges = 0;
    let unavailable = true;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => {
        exchanges++;
        return subscriptionCredential();
      }),
      async catalog(...args: Parameters<typeof f.backend.catalog>) {
        if (unavailable) throw new Error('fixture-catalog-outage');
        return f.backend.catalog(args[0], args[1]);
      },
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    assert.equal(exchanges, 1);
    assert.equal(owner.signInStatus(started.attempt).status, 'connected');
    assert.equal(owner.view().connections[0].status, 'loading');
    assert.equal(owner.configured, false);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      1,
    );
    const restarted = await f.create('fixture-owner', backend);
    assert.equal(restarted.view().connections[0].status, 'loading');
    unavailable = false;
    await restarted.refreshCatalog(restarted.view().connections[0].id);
    assert.equal(restarted.view().connections[0].status, 'connected');
    assert.equal(restarted.configured, true);
    const credential = await (await restarted.resolve()).read();
    assert.equal(credential?.type, 'oauth');
    assert.equal(exchanges, 1);
  });

  test('cancelling and replacing pending ChatGPT sign-ins releases each flow and fences late completion', async (t) => {
    const f = await fixture(t);
    let aborted = 0;
    let release!: (value: import('../src/ports/models.ts').ModelCredential) => void;
    const pending = new Promise<import('../src/ports/models.ts').ModelCredential>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      signIn: stubSignIn(
        () => pending,
        () => aborted++,
      ),
    };
    const owner = await f.create('fixture-owner', backend);
    const other = await f.create('fixture-other', backend);
    const app = Fastify();
    const otherApp = Fastify();
    owner.register(app);
    other.register(otherApp);
    t.after(() => app.close());
    t.after(() => otherApp.close());
    const first = await owner.start('openai');
    await otherApp.inject({ method: 'DELETE', url: `/api/models/oauth/${first.attempt}` });
    assert.equal(owner.signInStatus(first.attempt).status, 'waiting');
    assert.equal(aborted, 0);
    const completing = owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${first.attempt}&code=fixture`),
    );
    const rejected = assert.rejects(completing);
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/models/oauth/${first.attempt}`,
    });
    assert.equal(cancelled.statusCode, 200);
    await rejected;
    release(subscriptionCredential());
    await Promise.resolve();
    assert.equal(aborted, 1);
    assert.equal(owner.view().connections.length, 0);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      0,
    );
    for (let count = 0; count < 7; count++) await owner.start('openai');
    assert.equal(aborted, 7);
    const parallel = await Promise.all([owner.start('openai'), owner.start('openai')]);
    assert.equal(owner.signInStatus(parallel[0].attempt).status, 'failed');
    assert.equal(owner.signInStatus(parallel[1].attempt).status, 'waiting');
    await owner.cancel(parallel[1].attempt);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const expires = await owner.start('openai');
    t.mock.timers.tick(600001);
    const afterExpiry = await owner.start('openai');
    assert.equal(owner.signInStatus(expires.attempt).status, 'failed');
    t.mock.timers.reset();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'waiting');
    await owner.close();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'failed');
  });

  test('reconnect signs in with the saved account and a stable host, and a refused reconnect keeps the connection', async (t) => {
    const f = await fixture(t);
    const { ModelAuthError } = await import('../src/ports/models.ts');
    const inputs: Parameters<import('../src/ports/models.ts').ModelBackend['signIn']>[0][] = [];
    let accountId = 'fixture-original-account';
    const backend = {
      ...f.backend,
      signIn(input: Parameters<import('../src/ports/models.ts').ModelBackend['signIn']>[0]) {
        inputs.push(input);
        return stubSignIn(async () => {
          if (input.previous?.type === 'oauth' && input.previous.accountId !== accountId)
            throw new ModelAuthError(
              'That’s a different ChatGPT account. Add it as a new connection instead.',
            );
          return { ...subscriptionCredential(), accountId };
        })(input);
      },
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
    };
    const owner = await f.create('fixture-owner', backend);
    const started = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
    );
    const id = owner.view().connections[0].id;
    const selection = owner.view().selection;
    const access = await owner.resolve();
    const before = (
      await f.database.query('SELECT ciphertext FROM vault_app_grants WHERE id=$1', [id])
    ).rows[0].ciphertext;
    accountId = 'fixture-different-account';
    const restarted = await f.create('fixture-owner', backend);
    const reconnect = await restarted.start('openai', id);
    await assert.rejects(
      restarted.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${reconnect.attempt}&code=fixture`),
      ),
      /different ChatGPT account/,
    );
    assert.equal(inputs[0].previous, undefined);
    assert.equal(
      (inputs[1].previous as { accountId: string }).accountId,
      'fixture-original-account',
    );
    assert.match(
      inputs[0].hostId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(inputs[1].hostId, inputs[0].hostId);
    const other = await f.create('fixture-other', backend);
    await other.start('openai');
    assert.notEqual(inputs[2].hostId, inputs[0].hostId);
    assert.deepEqual(restarted.view().selection, selection);
    assert.equal(restarted.view().connections[0].status, 'connected');
    assert.equal(
      ((await access.read()) as { accountId: string }).accountId,
      'fixture-original-account',
    );
    assert.equal(
      (await f.database.query('SELECT ciphertext FROM vault_app_grants WHERE id=$1', [id])).rows[0]
        .ciphertext,
      before,
    );
    const added = await restarted.start('openai');
    await restarted.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${added.attempt}&code=fixture`),
    );
    assert.equal(inputs.at(-1)!.previous, undefined);
    assert.equal(restarted.view().connections.length, 2);
    assert.deepEqual(restarted.view().selection, selection);
  });

  test('each account is one connection: an unusable one shows on its row, signing in again repairs it, and what the owner adds next takes over', async (t) => {
    const f = await fixture(t);
    const { createPiModelRuntime } = await import('../src/providers/pi/models.ts');
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const { ModelAuthError } = await import('../src/ports/models.ts');
    let account = 'fixture-account';
    let down = false;
    let revoked = false;
    let hidden: string | undefined;
    let held: { access: string; entered(): void; release: Promise<void> } | undefined;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => ({
        ...subscriptionCredential(),
        access: `fixture-access-${randomUUID()}`,
        accountId: account,
        email: `${account}@example.test`,
      })),
      catalog: async (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
        credential?: Parameters<typeof f.backend.catalog>[2],
      ) => {
        if (credential?.type === 'oauth' && credential.access === held?.access) {
          held.entered();
          await held.release;
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        }
        if (down) throw new Error('fixture-catalog-outage');
        if (revoked && method === 'subscription')
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        return f.backend
          .catalog(provider, method, method === 'api_key' ? credential : undefined)
          .then((definitions) => definitions.filter(({ choice }) => choice.id !== hidden));
      },
    };
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
    });
    await store.initialize();
    const grants = async () =>
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count;
    async function signIn(service: Awaited<ReturnType<typeof f.create>>) {
      const started = await service.start('openai');
      await service.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
      );
    }
    const owner = await f.create('fixture-owner', backend);
    await signIn(owner);
    const [chatgpt] = owner.view().connections;
    const selection = owner.view().selection!;
    assert.equal(selection.connectionId, chatgpt.id);
    await signIn(owner);
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(owner.view().selection, selection);
    down = true;
    await signIn(owner);
    down = false;
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.equal(owner.configured, true);
    assert.equal(await grants(), 1);

    await store.change((state) => {
      for (const model of state.connections[0].models)
        model.spec.baseUrl = 'https://chatgpt.com/backend-api';
    });
    const restarted = await f.create('fixture-owner', backend);
    const stale = await restarted.resolve();
    await assert.rejects(
      createPiModelRuntime(stale),
      /Reconnect your ChatGPT account in Settings > Models/,
    );
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    assert.equal(restarted.configured, false);
    await assert.rejects(
      restarted.resolve(),
      /Reconnect the ChatGPT plan connection in Settings > Models/,
    );

    await signIn(restarted);
    assert.deepEqual(
      restarted.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(restarted.view().selection, selection);
    await createPiModelRuntime(await restarted.resolve());
    await stale.needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'connected');

    await (
      await restarted.resolve()
    ).needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    const key = await restarted.addKey('openai', 'fixture-api-1111');
    assert.equal(restarted.view().selection?.connectionId, key);
    assert.equal(restarted.configured, true);
    assert.equal(await restarted.addKey('openai', 'fixture-api-1111'), key);
    assert.equal(restarted.view().connections.length, 2);
    const chosen = restarted.view().selection!;
    hidden = chosen.modelId;
    await restarted.refreshCatalog(key);
    hidden = undefined;
    assert.deepEqual(restarted.view().selection, chosen);
    assert.equal(restarted.configured, false);
    await assert.rejects(restarted.resolve(), /selected model is unavailable/);
    await restarted.refreshCatalog(key);
    assert.equal(restarted.configured, true);

    await store.change((state) => {
      const [original] = state.connections;
      const copies = [randomUUID(), randomUUID()].map((id) => ({
        ...structuredClone(original),
        id,
        status: 'connected' as const,
      }));
      state.connections.push(...copies);
      state.selection = { ...selection, connectionId: copies[1].id };
    });
    const duplicated = await f.create('fixture-owner', backend);
    assert.equal(duplicated.view().connections.length, 4);
    await signIn(duplicated);
    assert.deepEqual(
      duplicated.view().connections.map(({ id, status }) => ({ id, status })),
      [
        { id: chatgpt.id, status: 'connected' },
        { id: key, status: 'connected' },
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(duplicated.configured, true);
    assert.equal(await grants(), 2);

    account = 'fixture-second-account';
    await signIn(duplicated);
    await signIn(duplicated);
    const work = await duplicated.addKey('openai', 'fixture-api-2222');
    assert.deepEqual(
      duplicated.view().connections.map(({ label, keyEnding }) => [label, keyEnding]),
      [
        ['fixture-account@example.test', undefined],
        ['OpenAI API', '1111'],
        ['fixture-second-account@example.test', undefined],
        ['OpenAI API', '2222'],
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    await duplicated.remove(work);
    assert.equal(duplicated.view().connections.length, 3);
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(await grants(), 3);

    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    held = {
      access: ((await (await duplicated.resolve()).read()) as { access: string }).access,
      entered,
      release: new Promise((resolve) => (release = resolve)),
    };
    const racing = duplicated.refreshCatalog(chatgpt.id);
    await reached;
    account = 'fixture-account';
    await signIn(duplicated);
    release();
    await assert.rejects(racing, /Reconnect/);
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'connected',
    );

    revoked = true;
    await assert.rejects(duplicated.refreshCatalog(chatgpt.id), /Reconnect/);
    revoked = false;
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'reconnect',
    );
    assert.equal(duplicated.configured, false);
  });
});
