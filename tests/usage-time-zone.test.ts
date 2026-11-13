import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { VaultActivity } from '../src/shared/contracts.ts';
import type { TrustView } from '../src/shared/trust.ts';
import type { ModelsResponse } from '../src/shared/models.ts';
import { VaultUse } from '../src/web/components/vault-activity.tsx';
import {
  browserDateFormat,
  dayKey,
  formatDayLabel,
  formatTime,
  setDateFormat,
} from '../src/web/lib/date-format.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

test('Usage uses the computer time zone for activity and opened logs', async (t) => {
  const oldTimeZone = process.env.TZ;
  process.env.TZ = 'Europe/Lisbon';
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/usage',
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  pageDataCache.clear();
  let unmount: (() => void) | undefined;
  t.after(async () => {
    if (unmount) await act(unmount);
    pageDataCache.clear();
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    if (oldTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimeZone;
  });

  const at = '2026-11-13T00:30:00.000Z';
  const saved = { locale: 'en-GB', hourCycle: 'h23' as const, timeZone: 'America/Los_Angeles' };
  setDateFormat(saved);
  const local = browserDateFormat(saved);
  assert.equal(local.timeZone, 'Europe/Lisbon');
  assert.equal(local.locale, saved.locale);
  assert.equal(local.hourCycle, saved.hourCycle);
  assert.equal(dayKey(at, saved), '2026-11-12');
  assert.equal(dayKey(at, local), '2026-11-13');

  const entry: TrustView['entries'][number] = {
    id: 'synthetic-entry',
    messageId: null,
    at,
    title: 'Synthetic report',
    source: 'chat',
    channel: 'web',
    error: null,
    costUsd: null,
    models: [],
    actions: [],
  };
  const view: TrustView = {
    entries: [entry],
    next: null,
    week: { things: 1, actions: 0, spentUsd: 0, planUsd: 0 },
    month: {
      start: '2026-11-01T00:00:00.000Z',
      days: 30,
      elapsedDays: 13,
      spentUsd: 0,
      forecastUsd: 0,
      planUsd: 0,
      daily: Array(30).fill(0),
      unpriced: false,
      planUsage: false,
      backgroundUsd: 0,
      outside: [],
    },
    limit: null,
    taskUsd: null,
  };
  const vault: VaultActivity = {
    week: { signIns: 1, payments: 0, held: 0 },
    entries: [
      {
        id: 'synthetic-vault',
        at,
        action: 'session',
        origin: 'https://example.test',
        task: 'Synthetic sign-in',
        reason: 'allowed',
      },
    ],
  };
  const data = new Map<string, unknown>([
    ['/api/trust', view],
    ['/api/models', { connections: [], selection: null } satisfies ModelsResponse],
    ['/api/vault/activity', vault],
    ['/api/vault', []],
    ['/api/vault/sessions', []],
    [
      `/api/trust/entries/${entry.id}/steps`,
      {
        steps: [{ at, kind: 'tool', title: 'Synthetic step' }],
        total: 1,
      },
    ],
  ]);
  for (const [path, value] of data) pageDataCache.update(path, () => value);
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const path = String(input);
    assert.ok(data.has(path), `Unexpected request: ${path}`);
    return Response.json(data.get(path));
  });
  const { createRoot } = await import('react-dom/client');
  const { Usage } = await import('../src/web/pages/usage.tsx');
  const root = createRoot(dom.window.document.getElementById('root')!);
  unmount = () => root.unmount();
  await act(async () => root.render(createElement(Usage)));

  const day = dom.window.document.querySelector('.vault-day h4');
  assert.equal(day?.textContent, formatDayLabel(at, local));
  assert.notEqual(day?.textContent, formatDayLabel(at, saved));
  const row = dom.window.document.querySelector<HTMLButtonElement>('.usage-row');
  assert.ok(row);
  assert.match(row.textContent ?? '', /00:30/);
  assert.doesNotMatch(row.textContent ?? '', /16:30/);
  const vaultRow = dom.window.document.querySelector('.vault-day .vault-use:not(.usage-row)');
  assert.match(vaultRow?.textContent ?? '', /00:30/);
  assert.match(renderToStaticMarkup(createElement(VaultUse, { entry: vault.entries[0] })), /16:30/);

  await act(async () => row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const step = dom.window.document.querySelector('.usage-log-rows time');
  assert.equal(step?.textContent, formatTime(at, local, { seconds: true }));
  assert.notEqual(step?.textContent, formatTime(at, saved, { seconds: true }));
});
