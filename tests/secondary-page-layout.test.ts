import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { Goals } from '../src/web/pages/goals.tsx';
import { SchedulePage } from '../src/web/pages/schedule.tsx';
import { Apps } from '../src/web/pages/apps.tsx';
import { Channels } from '../src/web/pages/channels.tsx';
import { Vault } from '../src/web/pages/vault.tsx';

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
  'CustomEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

test('secondary pages share layout, have one add action, and open new plans in place', async () => {
  const priorFetch = globalThis.fetch;
  let savedLogin = false;
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = async (path, init) => {
    requests.push({ path: String(path), method: init?.method ?? 'GET' });
    const data =
      path === '/api/channels'
        ? { channels: [], error: null }
        : path === '/api/channel-settings'
          ? { ready: true, channels: [] }
          : path === '/api/vault' && savedLogin
            ? [
                {
                  kind: 'login',
                  username: 'fixture@example.test',
                  id: 'fixture-login',
                  label: 'Newly saved login',
                  origin: 'https://example.com',
                  usernameHint: 'f***',
                  updatedAt: new Date().toISOString(),
                },
              ]
            : path === '/api/apps'
              ? [
                  {
                    slug: 'gmail',
                    name: 'Gmail',
                    status: 'disconnected',
                    description: 'Email and labels.',
                    triggersEnabled: false,
                  },
                ]
              : [];
    return new Response(JSON.stringify(data));
  };
  const style = document.createElement('style');
  style.textContent =
    '.content-page {max-width:1200px;padding:40px 80px 70px} .page-heading {margin-bottom:35px}' +
    (await readFile(new URL('../src/web/pages/secondary-pages.css', import.meta.url), 'utf8'));
  document.head.append(style);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(
          'div',
          {},
          [Goals, SchedulePage, Apps, Channels, Vault].map((page, index) =>
            createElement(page, { key: index }),
          ),
        ),
      ),
    );
    const pages = Array.from(element.querySelectorAll('.content-page'));
    assert.equal(pages.length, 5);
    for (const page of pages) {
      assert.equal(page.classList.contains('secondary-page'), true);
      const computed = dom.window.getComputedStyle(page);
      assert.equal(computed.maxWidth, 'none');
      assert.equal(computed.width, '100%');
      assert.equal(computed.marginLeft, '0px');
      assert.equal(computed.marginRight, '0px');
      assert.equal(computed.paddingLeft, '32px');
      assert.equal(computed.paddingRight, '32px');
      assert.equal(dom.window.getComputedStyle(page.querySelector('header')!).marginBottom, '24px');
    }
    const buttons = Array.from(element.querySelectorAll('button'));
    for (const label of ['New goal', 'New schedule', 'New'])
      assert.equal(buttons.filter((button) => button.textContent === label).length, 1);
    assert.equal(element.querySelectorAll('.secondary-empty').length, 3);
    assert.doesNotMatch(element.textContent ?? '', /draft|awake|in chat|Talk about a goal/);
    for (const label of ['New goal', 'New schedule']) {
      const button = buttons.find((item) => item.textContent === label)!;
      await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      assert.equal(button.getAttribute('aria-expanded'), 'true');
    }
    assert.equal(element.querySelectorAll('.new-plan-card .ask-otto-field').length, 2);
    assert.ok(requests.every((request) => request.method === 'GET'));
    assert.equal(element.querySelector('[aria-label^="Refresh"]'), null);
    savedLogin = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.match(element.textContent!, /Newly saved login/);
    assert.equal(requests.filter(({ path }) => path === '/api/vault').length, 2);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    style.remove();
    globalThis.fetch = priorFetch;
  }
});
