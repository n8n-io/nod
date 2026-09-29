import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { Sidebar } from '../src/web/components/sidebar.tsx';

const dom = new JSDOM(
  '<!doctype html><html><body><main id="workspace" tabindex="-1"></main></body></html>',
  { url: 'http://localhost:4310', pretendToBeVisual: true },
);
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'requestAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(dom.window.navigator, 'platform', { value: 'MacIntel' });
const cancelOnEscape = (event: KeyboardEvent) => {
  const dialog = event.currentTarget as HTMLDialogElement;
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (dialog.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))) dialog.close();
};
Object.assign(dom.window.HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.addEventListener('keydown', cancelOnEscape);
  },
  close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new dom.window.Event('close'));
  },
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');

test('sidebar exposes navigation shortcuts, keyboard focus and modifier hints without consuming normal typing', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const navigations: string[] = [];
  let toggles = 0;
  let inspections = 0;
  let restarts = 0;
  const desktopWidth = window.innerWidth;
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/goals',
          development: true,
          collapsed: false,
          onToggle() {
            toggles++;
          },
          onNavigate(path) {
            navigations.push(path);
          },
          onRestart() {
            restarts++;
          },
          inspectorEnabled: true,
          inspectorOpen: false,
          onToggleInspector() {
            inspections++;
          },
        }),
      ),
    );
    const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('.main-nav a'));
    assert.equal(links.length, 6);
    assert.equal(links[1]?.getAttribute('aria-current'), 'page');
    assert.ok(
      links.every(
        (link) =>
          link.getAttribute('aria-label') &&
          link.getAttribute('aria-keyshortcuts') &&
          link.getAttribute('title'),
      ),
    );
    assert.equal(links[5]?.getAttribute('aria-keyshortcuts'), 'Meta+K Control+K');
    assert.equal(links[5]?.getAttribute('title'), 'Vault (⌘K)');
    assert.equal(links[5]?.querySelector('kbd')?.textContent, 'K');
    links[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement, links[0]);
    links[0]!.focus();
    links[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement, links[5]);
    links[5]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, links[0]);
    const more = element.querySelector<HTMLButtonElement>('[aria-label="Navigation menu"]')!;
    const sheet = element.querySelector<HTMLDialogElement>('dialog.mobile-sheet')!;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await act(async () => more.click());
    assert.equal(sheet.open, true);
    const actions = [
      ...sheet.querySelectorAll<HTMLButtonElement>('.mobile-sheet-actions > button'),
    ];
    assert.deepEqual(
      actions.map((button) => button.textContent?.trim()),
      ['Switch to dark theme', 'Inspector'],
    );
    assert.equal(sheet.querySelector('kbd, [title], [aria-keyshortcuts]'), null);
    assert.equal(element.textContent?.includes('Restart setup'), false);
    await act(async () => actions[1]!.click());
    assert.equal(inspections, 1);
    assert.equal(sheet.open, false);
    assert.equal(document.activeElement, more);
    await act(async () =>
      element
        .querySelector<HTMLButtonElement>('.sidebar-bottom [aria-label="Get started"]')!
        .click(),
    );
    assert.equal(restarts, 1);
    const darkTheme = element.querySelector<HTMLButtonElement>(
      '.sidebar-bottom [aria-label="Switch to dark theme"]',
    )!;
    assert.ok(darkTheme);
    await act(async () => darkTheme.click());
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(window.localStorage.getItem('otto.theme'), 'dark');
    assert.ok(element.querySelector('.sidebar-bottom [aria-label="Switch to light theme"]'));
    await act(async () => more.click());
    const lightTheme = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Switch to light theme'),
    )!;
    assert.ok(lightTheme);
    await act(async () => lightTheme.click());
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.equal(window.localStorage.getItem('otto.theme'), 'light');
    assert.equal(sheet.open, true);
    await act(async () => sheet.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(sheet.open, false);
    assert.equal(document.activeElement, more);
    await act(async () => more.click());
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(sheet.open, false);
    assert.equal(inspections, 2);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    inspections = 0;
    const press = async (key: string, extra: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      await act(async () => window.dispatchEvent(event));
      return event;
    };
    await press('Meta', { metaKey: true });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), true);
    assert.equal(element.querySelector('.nav-shortcut')?.textContent, 'J');
    await press('j', { metaKey: true });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await press('g', { metaKey: true });
    for (const key of ['s', 'e', 'd', 'k']) await press(key, { metaKey: true });
    for (const key of ['b', 'i']) {
      assert.equal((await press(key, { metaKey: true })).defaultPrevented, true);
      assert.equal((await press(key.toUpperCase(), { ctrlKey: true })).defaultPrevented, true);
      for (const modifier of [
        { repeat: true },
        { shiftKey: true },
        { altKey: true },
        { isComposing: true },
      ])
        assert.equal((await press(key, { metaKey: true, ...modifier })).defaultPrevented, false);
    }
    assert.deepEqual(navigations, ['/', '/goals', '/schedule', '/apps', '/channels', '/vault']);
    assert.equal(toggles, 2);
    assert.equal(inspections, 2);
    const inspector = element.querySelector<HTMLButtonElement>('[aria-label="Inspector"]')!;
    const collapse = element.querySelector<HTMLButtonElement>('[aria-label="Collapse sidebar"]')!;
    for (const [button, key] of [
      [inspector, 'I'],
      [collapse, 'B'],
    ] as const) {
      assert.equal(button.getAttribute('aria-keyshortcuts'), `Meta+${key} Control+${key}`);
      assert.equal(button.querySelector('kbd')?.textContent, key);
      assert.ok(button.title.includes(`⌘${key}`));
    }
    await act(async () => {
      inspector.click();
      collapse.click();
    });
    assert.equal(toggles, 3);
    assert.equal(inspections, 3);
    assert.equal(
      element.querySelector('[aria-label="Inspector"]')?.getAttribute('aria-expanded'),
      'false',
    );
    assert.equal((await press('b')).defaultPrevented, false);
    assert.equal((await press('b', { metaKey: true, repeat: true })).defaultPrevented, false);
    await press('Meta', { metaKey: true });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: true,
          onToggle() {},
          onNavigate() {},
          onRestart() {},
        }),
      ),
    );
    assert.equal(
      element.querySelector('[aria-label="Expand sidebar"]')?.getAttribute('aria-expanded'),
      'false',
    );
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth });
    await act(async () => root.unmount());
    element.remove();
  }
});

test('sidebar preserves all shortcuts inside editable fields, including nested and shadow inputs', async () => {
  const element = document.createElement('div');
  const fields = document.createElement('div');
  fields.innerHTML =
    '<input><textarea></textarea><textarea class="browser-input-surface" aria-label="Control workspace browser"></textarea><select><option>One</option></select><div contenteditable="true" tabindex="0"><span>Draft</span></div><div role="textbox" tabindex="0">Text</div>';
  const shadowHost = document.createElement('div');
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  const shadowInput = document.createElement('input');
  shadow.append(shadowInput);
  fields.append(shadowHost);
  document.body.append(element, fields);
  const root = createRoot(element);
  const actions: string[] = [];
  const press = (target: EventTarget, key: string, modifier: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...modifier,
    });
    target.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          onToggle: () => actions.push('toggle'),
          onNavigate: (path) => actions.push(path),
          onRestart() {},
          inspectorEnabled: true,
          onToggleInspector: () => actions.push('inspect'),
        }),
      ),
    );
    const targets = [
      ...fields.querySelectorAll<HTMLElement>(
        'input, textarea, select, [contenteditable], span, [role="textbox"]',
      ),
      shadowInput,
    ];
    await act(async () => {
      for (const target of targets) {
        target.focus();
        for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
          for (const key of ['j', 'g', 's', 'e', 'd', 'k', 'b', 'i', 'a', 'c', 'v', 'z']) {
            assert.equal(press(target, key, modifier).defaultPrevented, false);
          }
        }
      }
      assert.equal(press(window, 'g', { metaKey: true }).defaultPrevented, false);
      targets[0]!.focus();
      assert.equal(press(window, 'g', { metaKey: true }).defaultPrevented, false);
      press(targets[0]!, 'Meta', { metaKey: true });
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    assert.deepEqual(actions, []);
    await act(async () => {
      document.getElementById('workspace')!.focus();
      press(window, 'Meta', { metaKey: true });
      shadowInput.focus();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    assert.equal(element.querySelector('.sidebar')?.classList.contains('show-shortcuts'), false);
    await act(async () => {
      document.getElementById('workspace')!.focus();
      for (const key of ['g', 'b', 'i']) {
        const handled = new KeyboardEvent('keydown', { key, metaKey: true, cancelable: true });
        handled.preventDefault();
        window.dispatchEvent(handled);
      }
    });
    assert.deepEqual(actions, []);
    await act(async () => {
      assert.equal(press(window, 'g', { ctrlKey: true }).defaultPrevented, true);
    });
    assert.deepEqual(actions, ['/goals']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    fields.remove();
  }
});

test('small screens use a chat-first top bar and a section sheet without shortcut hints', async () => {
  const initialWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const navigations: string[] = [];
  const settings: string[] = [];
  const triggers: unknown[] = [];
  const render = (path: string) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          path,
          collapsed: true,
          onToggle() {},
          onRestart() {},
          onNavigate(path) {
            navigations.push(path);
          },
          account: {
            user: { id: 'owner', name: 'Alex Morgan', email: 'alex@example.test', avatarUrl: null },
            theme: 'system',
            saving: false,
            canLogout: true,
            onSettings(tab, trigger) {
              settings.push(tab);
              triggers.push(trigger);
            },
            async onTheme() {},
            onLogout() {},
          },
        }),
      ),
    );
  try {
    await render('/vault');
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="Navigation menu"]')!;
    const sheet = element.querySelector<HTMLDialogElement>('dialog.mobile-sheet')!;
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.querySelector('.account-avatar')?.textContent, 'AM');
    assert.equal(sheet.open, false);
    const open = async () => {
      await act(async () => trigger.click());
      assert.equal(sheet.open, true);
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    };
    await open();
    assert.equal(document.activeElement, sheet.querySelector('.mobile-sheet-body'));
    const links = [...sheet.querySelectorAll<HTMLAnchorElement>('a.mobile-section')];
    assert.deepEqual(
      links.map((link) => link.getAttribute('href')),
      ['/', '/goals', '/schedule', '/apps', '/channels', '/vault'],
    );
    assert.equal(links[0]!.textContent, 'Chat');
    assert.equal(links[0]!.querySelector('.brand-glyph'), null);
    assert.ok(links[0]!.querySelector('svg'));
    assert.equal(links[0]!.getAttribute('aria-current'), null);
    assert.equal(links[5]!.getAttribute('aria-current'), 'page');
    assert.ok(sheet.querySelector('.account-menu-identity')?.textContent?.includes('Alex Morgan'));
    assert.equal(sheet.querySelector('kbd, [title*="⌘"], [aria-keyshortcuts]'), null);
    assert.equal(element.querySelector('.mobile-top-bar kbd'), null);
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
      await act(async () => links[0]!.dispatchEvent(event));
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(navigations, []);
    }
    await act(async () =>
      sheet
        .querySelector('.mobile-sheet-body')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(sheet.open, false);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, trigger);
    await open();
    assert.equal(sheet.querySelector('[role^=menuitem]'), null);
    assert.equal(
      sheet.querySelector('[aria-label="System theme"]')?.getAttribute('aria-pressed'),
      'true',
    );
    await act(async () => sheet.querySelector<HTMLElement>('.mobile-sheet-body')!.click());
    assert.equal(sheet.open, true);
    await act(async () => sheet.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(sheet.open, false);
    await open();
    await act(async () => sheet.querySelector<HTMLAnchorElement>('a[href="/goals"]')!.click());
    assert.deepEqual(navigations, ['/goals']);
    assert.equal(sheet.open, false);
    assert.equal(document.activeElement, trigger);
    await open();
    await act(async () =>
      [...sheet.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Settings'))!
        .click(),
    );
    assert.equal(sheet.open, false);
    assert.deepEqual(settings, ['Preferences']);
    assert.deepEqual(triggers, [trigger]);
    await render('/');
    await open();
    const current = sheet.querySelectorAll('[aria-current="page"]');
    assert.equal(current.length, 1);
    assert.equal(current[0]!.getAttribute('href'), '/');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    await act(async () => window.dispatchEvent(new Event('resize')));
    assert.equal(sheet.open, false);
    assert.equal(document.activeElement, document.getElementById('workspace'));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
    const chat = element.querySelector<HTMLAnchorElement>('.mobile-chat-link')!;
    assert.equal(chat.getAttribute('href'), '/');
    assert.equal(chat.getAttribute('aria-current'), 'page');
    assert.ok(chat.querySelector('.brand-glyph'));
    await act(async () => chat.click());
    assert.deepEqual(navigations, ['/goals', '/']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
  }
});

test('panel shortcuts use current callbacks and preserve unavailable inspector shortcuts', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const actions: string[] = [];
  const render = async (enabled: boolean, version: number) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          development: false,
          inspectorEnabled: enabled,
          onNavigate() {},
          onRestart() {},
          onToggle: () => actions.push(`sidebar-${version}`),
          onToggleInspector: () => actions.push(`inspector-${version}`),
        }),
      ),
    );
  const press = async (key: string) => {
    const event = new KeyboardEvent('keydown', {
      key,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(event));
    return event.defaultPrevented;
  };
  try {
    document.getElementById('workspace')!.focus();
    await render(false, 1);
    assert.equal(await press('i'), false);
    assert.equal(await press('b'), true);
    await render(true, 2);
    assert.equal(await press('i'), true);
    assert.equal(await press('b'), true);
    await render(false, 3);
    assert.equal(await press('i'), false);
    assert.deepEqual(actions, ['sidebar-1', 'inspector-2', 'sidebar-2']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('sidebar shortcut opens and closes the small-screen sheet without changing the desktop rail', async () => {
  const initialWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let desktopToggles = 0;
  const press = async () => {
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => window.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
  };
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: true,
          onNavigate() {},
          onRestart() {},
          onToggle: () => desktopToggles++,
        }),
      ),
    );
    document.getElementById('workspace')!.focus();
    const sheet = element.querySelector<HTMLDialogElement>('dialog.mobile-sheet')!;
    await press();
    assert.equal(sheet.open, true);
    assert.equal(document.activeElement, sheet.querySelector('.mobile-sheet-body'));
    await press();
    assert.equal(sheet.open, false);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Navigation menu');
    assert.equal(desktopToggles, 0);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    await press();
    assert.equal(desktopToggles, 1);
    assert.equal(sheet.open, false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: initialWidth });
  }
});

test('shortcut focus uses only the latest navigation and never runs after sidebar unmount', async () => {
  const requestFrame = window.requestAnimationFrame;
  const cancelFrame = window.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    pending.set(++nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  const element = document.createElement('div');
  const composer = document.createElement('div');
  composer.className = 'composer-editor';
  composer.setAttribute('contenteditable', 'true');
  composer.tabIndex = 0;
  document.body.append(element, composer);
  const root = createRoot(element);
  let mounted = true;
  const navigations: string[] = [];
  const press = async (key: string) => {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
  };
  try {
    await act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: false,
          onToggle() {},
          onRestart() {},
          onNavigate(path) {
            navigations.push(path);
          },
        }),
      ),
    );
    document.getElementById('workspace')!.focus();
    await press('g');
    assert.equal(pending.size, 1);
    await press('j');
    assert.equal(pending.size, 1);
    assert.deepEqual(navigations, ['/goals', '/']);
    await act(async () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
    });
    assert.equal(document.activeElement, composer);
    document.getElementById('workspace')!.focus();
    await press('e');
    assert.equal(pending.size, 1);
    await act(async () => root.unmount());
    mounted = false;
    assert.equal(pending.size, 0);
  } finally {
    if (mounted) await act(async () => root.unmount());
    window.requestAnimationFrame = requestFrame;
    window.cancelAnimationFrame = cancelFrame;
    element.remove();
    composer.remove();
  }
});

test('production keeps Inspector in the app menu and hides More when it is empty', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let inspections = 0;
  const render = async (enabled: boolean) =>
    act(async () =>
      root.render(
        createElement(Sidebar, {
          path: '/',
          collapsed: true,
          development: false,
          inspectorEnabled: enabled,
          onNavigate() {},
          onToggle() {},
          onRestart() {},
          onToggleInspector() {
            inspections++;
          },
        }),
      ),
    );
  try {
    await render(true);
    assert.equal(element.querySelector('.sidebar-bottom [aria-label="Inspector"]'), null);
    assert.equal(element.querySelector('.sidebar-bottom [aria-label="Get started"]'), null);
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="App menu"]')!;
    assert.ok(trigger);
    await act(async () => trigger.click());
    const menu = element.querySelector<HTMLElement>('[role="menu"]')!;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(
      buttons.map((button) => button.textContent?.trim()),
      ['Inspector'],
    );
    assert.equal(element.textContent?.includes('Restart setup'), false);
    await act(async () => buttons[0]!.click());
    assert.equal(inspections, 1);
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(element.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await render(false);
    assert.equal(element.querySelector('[aria-label="App menu"]'), null);
    assert.equal(element.querySelector('.sidebar-app-menu'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('the small-screen sheet scrolls on short screens and keeps touch-sized theme controls', async () => {
  const css = await readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`  ${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  assert.match(rule('.mobile-sheet'), /max-height: min\(86dvh, 680px\);/);
  assert.match(rule('.mobile-sheet'), /overflow-y: auto;/);
  assert.match(rule('.mobile-sheet-actions .account-menu-themes button'), /min-height: 44px;/);
});
