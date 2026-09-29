import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { VaultCardEntry, VaultLoginDetails } from '../src/shared/contracts.ts';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310/vault',
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
  'FormData',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
let phone = true;
Object.defineProperty(dom.window, 'matchMedia', {
  configurable: true,
  value: () => ({
    matches: phone,
    addEventListener() {},
    removeEventListener() {},
  }),
});
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Vault } = await import('../src/web/pages/vault.tsx');

const savedLogins: VaultLoginDetails[] = [
  {
    kind: 'login',
    username: 'personal-fixture@example.test',
    id: 'personal/login',
    label: 'Personal account',
    origin: 'https://accounts.example.test:8443',
    usernameHint: 'pe…',
    updatedAt: '2026-09-25T12:00:00.000Z',
  },
  {
    kind: 'login',
    username: 'work-fixture@example.test',
    id: 'work login',
    label: 'Work account',
    origin: 'https://accounts.example.test:8443',
    usernameHint: 'wo…',
    updatedAt: '2026-09-25T12:00:00.000Z',
  },
];
const usernames = ['personal-fixture@example.test', 'work-fixture@example.test'];
const syntheticPassword = 'synthetic-vault-password-only';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function item(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-vault-item]')].find(
    (value) => value.querySelector('strong')?.textContent === label,
  );
}

async function click(label: string, scope: ParentNode = document) {
  const button = label.startsWith('View ')
    ? item(label.slice(5))
    : [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
        (value) =>
          value.getAttribute('aria-label') === label || value.textContent?.trim() === label,
      );
  assert.ok(button, `Missing button: ${label}`);
  assert.equal(button.disabled, false);
  await act(async () => button.click());
  return button;
}

const surface = () => document.querySelector<HTMLElement>('.vault-surface')!;
const confirmation = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const title = () => document.querySelector<HTMLElement>('[data-vault-title]')!;
const back = () => click('Vault');
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mountVault() {
  pageDataCache.update('/api/vault', () => null);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Vault)));
  return {
    root,
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      pageDataCache.update('/api/vault', () => null);
      phone = true;
    },
  };
}

function mockVaultRequests(
  respond?: (path: string, options: RequestInit) => Promise<Response> | undefined,
) {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/icon')) return new Response(null, { status: 204 });
    requests.push({ path, options });
    if (path === '/api/vault') return respond?.(path, options) ?? Response.json(savedLogins);
    assert.ok(options.method === 'POST' || options.method === 'PATCH');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    const result = respond?.(path, options);
    if (result) return result;
    const index = savedLogins.findIndex((entry) => path.includes(encodeURIComponent(entry.id)));
    assert.notEqual(index, -1);
    if (path.endsWith('/details'))
      return Response.json({ ...savedLogins[index], username: usernames[index] });
    assert.equal(path, `/api/vault/${encodeURIComponent(savedLogins[index].id)}/password`);
    return Response.json({ password: syntheticPassword });
  };
  return requests;
}

function setClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function startNew(kind: 'New login' | 'New payment card') {
  await click('New');
  await click(kind);
  return document.querySelector<HTMLFormElement>('.vault-add-form')!;
}

test('New login accepts named bare-domain logins and retains separate accounts for the same website', async () => {
  const previousFetch = globalThis.fetch;
  const entries: VaultLoginDetails[] = [];
  const writes: Array<{ label: string; origin: string; username: string; password: string }> = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith('/details'))
      return Response.json(entries.find((entry) => path.includes(encodeURIComponent(entry.id))));
    assert.equal(path, '/api/vault');
    if (options?.method !== 'POST') return Response.json(entries);
    const input = JSON.parse(String(options.body));
    writes.push(input);
    const entry: VaultLoginDetails = {
      kind: 'login',
      username: input.username,
      id: `saved-${writes.length}`,
      label: input.label,
      origin: 'https://example.com',
      usernameHint: 'fi…',
      updatedAt: new Date().toISOString(),
    };
    entries.unshift(entry);
    return Response.json(entry);
  };
  const mounted = await mountVault();
  try {
    for (const label of ['Personal account', 'Work account']) {
      const form = await startNew('New login');
      const name = form.querySelector<HTMLInputElement>('input[name="label"]')!;
      const website = form.querySelector<HTMLInputElement>('input[name="origin"]')!;
      const username = form.querySelector<HTMLInputElement>('input[name="username"]')!;
      const password = form.querySelector<HTMLInputElement>('input[name="password"]')!;
      assert.equal(document.activeElement, name);
      assert.equal(title().textContent, 'New login');
      assert.equal(name.maxLength, 100);
      assert.equal(name.required, true);
      assert.match(name.labels![0].textContent ?? '', /Name/);
      assert.match(website.labels![0].textContent ?? '', /Website domain/);
      name.value = label;
      website.value = 'example.com';
      username.value = `fixture-${writes.length}@example.test`;
      password.value = 'synthetic-only-password';
      assert.equal(form.checkValidity(), true);
      await submit(form);
      assert.equal(password.value, '');
      assert.equal(title().textContent, label);
      assert.equal(document.querySelector('.vault-add-form'), null);
      await back();
    }
    assert.deepEqual(
      writes.map(({ label, origin }) => ({ label, origin })),
      [
        { label: 'Personal account', origin: 'example.com' },
        { label: 'Work account', origin: 'example.com' },
      ],
    );
    await act(async () => mounted.root.render(null));
    pageDataCache.update('/api/vault', () => null);
    await act(async () => mounted.root.render(createElement(Vault)));
    const rows = [...mounted.container.querySelectorAll('[data-vault-item]')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('strong')?.textContent),
      ['Personal account', 'Work account'],
    );
    assert.match(mounted.container.textContent ?? '', /fixture-0@example/);
    assert.match(mounted.container.textContent ?? '', /fixture-1@example/);
    assert.doesNotMatch(mounted.container.textContent ?? '', /synthetic-only-password|Delete/);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault details preserve exact values, read passwords only on demand and return focus on Back', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    assert.equal(requests.length, 1);
    const trigger = item('Personal account')!;
    assert.match(trigger.textContent ?? '', /personal-fixture@example\.test/);
    assert.equal(trigger.querySelector('button'), null);
    trigger.focus();
    await click('View Personal account');
    const view = surface();
    assert.equal(title().textContent, 'Personal account');
    assert.equal(document.activeElement, title());
    assert.equal(view.getAttribute('aria-label'), 'Personal account');
    assert.match(view.textContent ?? '', /accounts\.example\.test:8443/);
    assert.doesNotMatch(view.textContent ?? '', /https:\/\//);
    assert.equal(view.querySelector('img.vault-site-icon'), null);
    assert.equal(
      view.querySelector('a[aria-label="Open accounts.example.test:8443"]')?.getAttribute('rel'),
      'noopener noreferrer',
    );
    assert.equal(mounted.container.querySelector('[data-vault-item]'), null);
    assert.equal(view.querySelector('form'), null);
    assert.match(view.textContent ?? '', new RegExp(usernames[0]));
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 0);
    assert.equal(requests[1].path, '/api/vault/personal%2Flogin/details');
    assert.ok(view.querySelector('[aria-label="Password hidden"]'));
    await click('Copy username');
    assert.deepEqual(clipboard, [usernames[0]]);
    assert.match(view.textContent ?? '', /Username copied/);
    await click('Show password');
    assert.equal(view.querySelector('.vault-password-visible')?.textContent, syntheticPassword);
    assert.equal(requests.at(-1)?.path, '/api/vault/personal%2Flogin/password');
    assert.equal(
      view.querySelector('[aria-label="Hide password"]')?.getAttribute('aria-pressed'),
      'true',
    );
    await click('Hide password');
    assert.equal(view.textContent?.includes(syntheticPassword), false);
    await click('Show password');
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    await act(async () =>
      title().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await settle();
    assert.equal(document.querySelector('.vault-surface'), null);
    assert.equal(document.activeElement, item('Personal account'));
    await click('View Personal account');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    await back();
    await settle();
    assert.equal(document.activeElement, item('Personal account'));
    assert.equal(requests.filter(({ path }) => path.endsWith('/details')).length, 2);
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    await click('View Work account');
    assert.ok(document.body.textContent?.includes(usernames[1]));
    assert.equal(surface().textContent?.includes(usernames[0]), false);
    assert.equal(requests.at(-1)?.path, '/api/vault/work%20login/details');
    const cached = JSON.stringify(pageDataCache.getSnapshot('/api/vault'));
    assert.equal(cached.includes(usernames[0]), true);
    assert.equal(cached.includes(syntheticPassword), false);
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Desktop Vault shows a searchable list beside the selected item without reading passwords', async () => {
  const previousFetch = globalThis.fetch;
  phone = false;
  const requests = mockVaultRequests();
  const mounted = await mountVault();
  try {
    assert.ok(mounted.container.querySelector('.vault-page.is-split'));
    assert.equal(title().textContent, 'Personal account');
    assert.notEqual(document.activeElement, title());
    assert.equal(item('Personal account')?.getAttribute('aria-current'), 'true');
    assert.equal(requests.at(-1)?.path, '/api/vault/personal%2Flogin/details');
    await click('View Work account');
    assert.equal(title().textContent, 'Work account');
    assert.equal(document.activeElement, title());
    assert.equal(item('Work account')?.getAttribute('aria-current'), 'true');
    assert.equal(item('Personal account')?.getAttribute('aria-current'), null);
    const search = mounted.container.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.equal(search.getAttribute('aria-label'), 'Search Vault');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(search, 'work-fixture');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.deepEqual(
      [...mounted.container.querySelectorAll('[data-vault-item] strong')].map(
        (value) => value.textContent,
      ),
      ['Work account'],
    );
    assert.equal(
      requests.some(({ path }) => path.endsWith('/password')),
      false,
    );
    const form = await startNew('New login');
    assert.ok(form);
    assert.ok(mounted.container.querySelector('[data-vault-item]'));
    await click('Cancel');
    await settle();
    assert.equal(document.activeElement?.textContent?.trim(), 'New');
    assert.equal(title().textContent, 'Work account');
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Copy password stays masked and clipboard errors clear revealed values without exposing errors', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Work account');
    await click('Copy password');
    assert.deepEqual(clipboard, [syntheticPassword]);
    assert.equal(requests.at(-1)?.path, '/api/vault/work%20login/password');
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.match(document.body.textContent ?? '', /Password copied/);
    await click('Show password');
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 2);
    setClipboard(async () => {
      throw new Error(`private clipboard failure ${syntheticPassword}`);
    });
    await click('Copy password');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.body.textContent?.includes('private clipboard failure'), false);
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'Could not copy to the clipboard. Try again.',
    );
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Leaving or replacing Vault details aborts reads and ignores late details and password responses', async () => {
  const previousFetch = globalThis.fetch;
  const details = deferred<Response>();
  const password = deferred<Response>();
  const requests = mockVaultRequests((path) => {
    if (path === '/api/vault/personal%2Flogin/details') return details.promise;
    if (path.endsWith('/password')) return password.promise;
  });
  const clipboard: string[] = [];
  setClipboard(async (value) => {
    clipboard.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const first = requests.at(-1)!;
    await back();
    assert.equal(first.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () =>
      details.resolve(Response.json({ ...savedLogins[0], username: usernames[0] })),
    );
    assert.ok(document.body.textContent?.includes(usernames[1]));
    assert.equal(surface().textContent?.includes(usernames[0]), false);
    await click('Copy password');
    const copying = requests.at(-1)!;
    await back();
    assert.equal(copying.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () => password.resolve(Response.json({ password: syntheticPassword })));
    assert.deepEqual(clipboard, []);
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault clears revealed passwords and fences pending reads when the window or tab is hidden', async () => {
  const previousFetch = globalThis.fetch;
  const latePassword = deferred<Response>();
  let holdPassword = false;
  const requests = mockVaultRequests((path) =>
    holdPassword && path.endsWith('/password') ? latePassword.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    assert.ok(document.body.textContent?.includes(syntheticPassword));
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = true;
    await click('Show password');
    const pending = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(pending.options.signal?.aborted, true);
    await act(async () => latePassword.resolve(Response.json({ password: syntheticPassword })));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = false;
    await click('Show password');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    Reflect.deleteProperty(document, 'hidden');
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault navigation aborts pending secrets and late clipboard completion does not update new details', async () => {
  const previousFetch = globalThis.fetch;
  const latePassword = deferred<Response>();
  let holdPassword = true;
  const requests = mockVaultRequests((path) =>
    holdPassword && path.endsWith('/password') ? latePassword.promise : undefined,
  );
  const copied = deferred<void>();
  setClipboard(() => copied.promise);
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    const pending = requests.at(-1)!;
    await act(async () => mounted.root.render(null));
    assert.equal(pending.options.signal?.aborted, true);
    await act(async () => mounted.root.render(createElement(Vault)));
    await click('View Work account');
    await act(async () => latePassword.resolve(Response.json({ password: syntheticPassword })));
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    holdPassword = false;
    await click('Copy password');
    await back();
    await click('View Personal account');
    await act(async () => copied.resolve());
    assert.equal(document.body.textContent?.includes('Password copied.'), false);
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label="Show password"]')?.disabled,
      false,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault detail failures use fixed errors, support retry, and do not read passwords eagerly', async () => {
  const previousFetch = globalThis.fetch;
  let failDetails = true;
  const requests = mockVaultRequests((path) => {
    if ((failDetails && path.endsWith('/details')) || path.endsWith('/password'))
      return Promise.resolve(
        Response.json({ error: `private server error ${syntheticPassword}` }, { status: 500 }),
      );
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This login could not be opened. Try again.',
    );
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.equal(document.querySelector('[aria-label="Show password"]'), null);
    assert.equal(document.querySelector<HTMLButtonElement>('[data-vault-edit]')?.disabled, true);
    assert.equal(
      requests.some(({ path }) => path.endsWith('/password')),
      false,
    );
    failDetails = false;
    await click('Try again');
    assert.ok(document.body.textContent?.includes(usernames[0]));
    await click('Show password');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'The password could not be shown. Try again.',
    );
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault edits a named account and updates the private list without reading its password', async () => {
  const previousFetch = globalThis.fetch;
  const entries = savedLogins.map((entry) => ({ ...entry }));
  const writes: Record<string, unknown>[] = [];
  const requests = mockVaultRequests((path, options) => {
    if (path === '/api/vault') return Promise.resolve(Response.json(entries));
    if (options.method === 'PATCH') {
      assert.equal(path, '/api/vault/personal%2Flogin');
      const input = JSON.parse(String(options.body));
      writes.push(input);
      entries[0] = {
        ...entries[0],
        label: input.label,
        username: input.username,
        usernameHint: 'ne…',
        updatedAt: '2026-09-25T13:00:00.000Z',
      };
      return Promise.resolve(Response.json(entries[0]));
    }
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Edit');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
    const username = form.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(document.activeElement, name);
    assert.equal(name.value, 'Personal account');
    assert.equal(username.value, usernames[0]);
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(form.querySelector('[name="origin"]'), null);
    assert.match(form.textContent ?? '', /Websiteaccounts\.example\.test:8443/);
    assert.ok(form.querySelector('[aria-label="Password hidden"]'));
    assert.equal(form.querySelector('[aria-label="Show password"]'), null);
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    assert.equal(password.required, true);
    assert.equal(password.value, '');
    assert.equal(document.activeElement, password);
    assert.equal(form.checkValidity(), false);
    password.value = 'cancelled-replacement';
    await click('Cancel change', form);
    assert.equal(password.value, '');
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change password');
    await inputValue(name, 'Everyday account');
    await inputValue(username, 'new-private-username@example.test');
    await submit(form);
    assert.deepEqual(writes, [
      { label: 'Everyday account', username: 'new-private-username@example.test' },
    ]);
    assert.equal(
      requests.some((request) => request.path.endsWith('/password')),
      false,
    );
    assert.equal(document.querySelector('.vault-edit-form'), null);
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.match(surface().textContent ?? '', /Login updated/);
    assert.equal(title().textContent, 'Everyday account');
    assert.match(surface().textContent ?? '', /new-private-username@example\.test/);
    assert.equal(document.activeElement, document.querySelector('[data-vault-edit]'));
    await back();
    assert.ok(item('Everyday account'));
    assert.ok(item('Work account'));
    assert.match(item('Everyday account')?.textContent ?? '', /new-private-username/);
    const cached = JSON.stringify(pageDataCache.getSnapshot('/api/vault'));
    assert.match(cached, /Everyday account/);
    assert.match(cached, /new-private-username/);
    assert.doesNotMatch(cached, /synthetic-vault-password/);
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault uses the saved website identifier label in details and edits without reading secrets', async () => {
  const previousFetch = globalThis.fetch;
  const label = 'Member number';
  const requests = mockVaultRequests((path) =>
    path.endsWith('/details')
      ? Promise.resolve(
          Response.json({ ...savedLogins[0], username: usernames[0], identifierLabel: label }),
        )
      : undefined,
  );
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    const view = surface();
    const status = view.querySelector('[role="status"]')!;
    assert.equal(status.className, 'sr-only');
    assert.match(view.textContent ?? '', /Member number/);
    await click('Copy member number');
    assert.deepEqual(copied, [usernames[0]]);
    assert.equal(status.textContent, 'Member number copied.');
    assert.equal(status.className, 'vault-detail-status');
    await click('Edit');
    const input = view.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(input.labels![0].textContent, label);
    assert.equal(input.value, usernames[0]);
    await click('Cancel');
    assert.equal(
      requests.some(({ path }) => path.endsWith('/password')),
      false,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault edit cancel, blur and failed submission discard replacement passwords', async () => {
  const previousFetch = globalThis.fetch;
  const writes: Record<string, unknown>[] = [];
  const requests = mockVaultRequests((_path, options) => {
    if (options.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)));
      return Promise.resolve(
        Response.json({ error: 'private-new-password-error' }, { status: 500 }),
      );
    }
  });
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Show password');
    await click('Edit');
    assert.equal(document.body.textContent?.includes(syntheticPassword), false);
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await click('Change password', form);
    form.querySelector<HTMLInputElement>('[name="password"]')!.value = 'cancelled-secret';
    await click('Cancel');
    assert.equal(writes.length, 0);
    assert.equal(document.querySelector('.vault-edit-form'), null);
    assert.equal(document.activeElement, document.querySelector('[data-vault-edit]'));
    await click('Edit');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.querySelector('[name="password"]'), null);
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    assert.equal(password.value, '');
    password.value = 'blurred-secret';
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(password.value, '');
    password.value = 'replacement-secret';
    await submit(form);
    assert.equal(writes[0].password, 'replacement-secret');
    assert.equal(password.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This login could not be updated. Try again.',
    );
    assert.ok(document.querySelector('.vault-edit-form'));
    assert.doesNotMatch(
      document.body.textContent ?? '',
      /replacement-secret|private-new-password-error/,
    );
    assert.equal(requests.filter((request) => request.path.endsWith('/password')).length, 1);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /replacement-secret|private-new-password-error/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Leaving a pending Vault edit aborts its request and fences a late save from the next account', async () => {
  const previousFetch = globalThis.fetch;
  const pending = deferred<Response>();
  const requests = mockVaultRequests((_path, options) =>
    options.method === 'PATCH' ? pending.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    await click('View Personal account');
    await click('Edit');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await inputValue(form.querySelector<HTMLInputElement>('[name="label"]')!, 'Late account');
    await click('Change password', form);
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    password.value = 'pending-secret';
    await submit(form);
    const request = requests.at(-1)!;
    assert.equal(password.value, '');
    await back();
    assert.equal(request.options.signal?.aborted, true);
    await click('View Work account');
    await act(async () =>
      pending.resolve(Response.json({ ...savedLogins[0], label: 'Late account' })),
    );
    assert.equal(title().textContent, 'Work account');
    assert.doesNotMatch(
      document.body.textContent ?? '',
      /Late account|pending-secret|Login updated/,
    );
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /Late account|pending-secret/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

const savedCard: VaultCardEntry = {
  kind: 'card',
  id: 'card/private',
  label: 'Everyday card',
  brand: 'Visa',
  last4: '4242',
  expiryMonth: 4,
  expiryYear: 2032,
  updatedAt: '2026-09-25T12:00:00.000Z',
};
const syntheticCardNumber = '4242424242424242';
const syntheticCardholder = 'Synthetic Cardholder';

function mockCardRequests(
  respond?: (path: string, options: RequestInit) => Promise<Response> | undefined,
) {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/icon')) return new Response(null, { status: 204 });
    requests.push({ path, options });
    const response = respond?.(path, options);
    if (response) return response;
    if (path === '/api/vault') return Response.json([savedCard, ...savedLogins]);
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (path === '/api/vault/card%2Fprivate/details')
      return Response.json({
        ...savedCard,
        cardholder: syntheticCardholder,
        hasSecurityCode: false,
      });
    if (path === '/api/vault/card%2Fprivate/card-number') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(String(options.body)), {});
      return Response.json({ cardNumber: syntheticCardNumber });
    }
    const login = savedLogins.find((entry) => path.includes(encodeURIComponent(entry.id)));
    if (login && path.endsWith('/details')) return Response.json(login);
    assert.fail(`Unexpected fixture request: ${path}`);
  };
  return requests;
}

test('Vault Edit only enables Save for an actual change and Cancel restores saved values', async () => {
  const previousFetch = globalThis.fetch;
  const requests = mockVaultRequests();
  const mounted = await mountVault();
  const save = () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save',
    )!;
  try {
    await click('View Personal account');
    assert.equal(document.querySelector('.vault-edit-form'), null);
    await click('Edit');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
    const username = form.querySelector<HTMLInputElement>('[name="username"]')!;
    assert.equal(name.disabled, false);
    assert.equal(username.disabled, false);
    assert.equal(save().disabled, true);
    assert.equal(document.querySelector('.vault-delete-row'), null);
    await inputValue(name, 'Changed account');
    assert.equal(save().disabled, false);
    await inputValue(name, savedLogins[0].label);
    assert.equal(save().disabled, true);
    await inputValue(username, 'edited-identifier@example.test');
    await click('Change password');
    const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
    await inputValue(password, 'cancelled-secret');
    await click('Cancel');
    assert.equal(password.value, '');
    assert.match(surface().textContent ?? '', new RegExp(usernames[0]));
    assert.doesNotMatch(surface().textContent ?? '', /edited-identifier/);
    await click('Edit');
    assert.equal(
      document.querySelector<HTMLInputElement>('.vault-edit-form [name="username"]')?.value,
      usernames[0],
    );
    assert.equal(save().disabled, true);
    assert.equal(requests.filter(({ options }) => options.method === 'PATCH').length, 0);
    assert.equal(requests.filter(({ path }) => path.endsWith('/password')).length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card security code can be added, revealed, replaced or removed without entering list metadata', async () => {
  const previousFetch = globalThis.fetch;
  let code = '';
  const writes: Record<string, unknown>[] = [];
  const requests = mockCardRequests((path, options) => {
    if (path.endsWith('/details'))
      return Promise.resolve(
        Response.json({ ...savedCard, cardholder: syntheticCardholder, hasSecurityCode: !!code }),
      );
    if (path.endsWith('/security-code'))
      return Promise.resolve(Response.json({ securityCode: code }));
    if (options.method === 'PATCH') {
      const input = JSON.parse(String(options.body));
      writes.push(input);
      if ('securityCode' in input) code = input.securityCode ?? '';
      return Promise.resolve(Response.json({ ...savedCard, label: input.label }));
    }
  });
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    assert.equal(document.querySelector('[aria-label="Show security code"]'), null);
    assert.equal(requests.filter(({ path }) => path.endsWith('/security-code')).length, 0);
    await click('Edit');
    await click('Add security code');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    let field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    assert.equal(field.type, 'password');
    assert.equal(field.required, true);
    assert.equal(document.activeElement, field);
    for (const invalid of ['', '12', 'ab3', '12345']) {
      await inputValue(field, invalid);
      assert.equal(form.checkValidity(), false);
      await submit(form);
      assert.equal(writes.length, 0);
    }
    await inputValue(field, '734');
    await submit(form);
    assert.equal(writes[0].securityCode, '734');
    assert.equal(field.value, '');
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(requests.filter(({ path }) => path.endsWith('/security-code')).length, 0);
    await click('Copy security code');
    assert.deepEqual(copied, ['734']);
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    const request = requests.at(-1)!;
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.cache, 'no-store');
    assert.ok(request.options.signal);
    assert.deepEqual(JSON.parse(String(request.options.body)), {});
    await click('Show security code');
    assert.equal(document.querySelector('.vault-password-visible')?.textContent, '734');
    await click('Edit');
    assert.equal(document.querySelector('.vault-password-visible'), null);
    await click('Change security code');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(field, '9876');
    await click('Cancel change', field.closest('.vault-secret-field')!);
    assert.equal(field.value, '');
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change security code');
    assert.equal(writes.length, 1);
    await inputValue(form.querySelector<HTMLInputElement>('[name="label"]')!, 'Updated card');
    await submit(form);
    assert.equal('securityCode' in writes[1], false);
    assert.equal(code, '734');
    await click('Edit');
    await click('Change security code');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    field = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(field, '9876');
    await submit(form);
    assert.equal(writes[2].securityCode, '9876');
    assert.equal(field.value, '');
    await click('Edit');
    await click('Remove security code');
    assert.equal(document.activeElement?.textContent, 'Cancel removal');
    await click('Cancel removal');
    assert.ok(document.querySelector('[aria-label="Security code hidden"]'));
    assert.equal(writes.length, 3);
    await click('Remove security code');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await submit(form);
    assert.equal(writes[3].securityCode, null);
    assert.equal(document.querySelector('[aria-label="Show security code"]'), null);
    assert.doesNotMatch(surface().textContent ?? '', /Security code/);
    await click('Edit');
    assert.ok(document.querySelector('[aria-label="Add security code"]'));
    assert.equal(requests.filter(({ path }) => path.endsWith('/card-number')).length, 0);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /734|9876|securityCode|hasSecurityCode/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card security code reads and replacement inputs are cleared and fenced across hiding and leaving', async () => {
  const previousFetch = globalThis.fetch;
  const lateShow = deferred<Response>();
  const lateCopy = deferred<Response>();
  let held: Promise<Response> | undefined;
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault/card%2Fprivate/details')
      return Promise.resolve(
        Response.json({ ...savedCard, cardholder: syntheticCardholder, hasSecurityCode: true }),
      );
    if (path.endsWith('/security-code'))
      return held ?? Promise.resolve(Response.json({ securityCode: '681' }));
    if (options.method === 'PATCH')
      return Promise.resolve(Response.json({ error: 'private-code-681' }, { status: 500 }));
  });
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    await click('Show security code');
    assert.equal(document.querySelector('.vault-password-visible')?.textContent, '681');
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    held = lateShow.promise;
    await click('Show security code');
    const showing = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(showing.options.signal?.aborted, true);
    await act(async () => lateShow.resolve(Response.json({ securityCode: '681' })));
    assert.equal(document.querySelector('.vault-password-visible'), null);
    held = undefined;
    await click('Edit');
    await click('Change security code');
    const form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    const input = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    await inputValue(input, '732');
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(input.value, '');
    await inputValue(input, '732');
    await submit(form);
    assert.equal(input.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This card could not be updated. Try again.',
    );
    assert.doesNotMatch(document.body.textContent ?? '', /private-code-681/);
    await click('Cancel');
    held = lateCopy.promise;
    await click('Copy security code');
    const copying = requests.at(-1)!;
    await back();
    assert.equal(copying.options.signal?.aborted, true);
    await click('View Personal account');
    await act(async () => lateCopy.resolve(Response.json({ securityCode: '681' })));
    assert.deepEqual(copied, []);
    assert.equal(document.querySelector('.vault-password-visible'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /681|732|Security code copied/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /681|732|securityCode|hasSecurityCode/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('New payment card supports an optional security code and returns only card metadata to the list', async () => {
  const previousFetch = globalThis.fetch;
  let added = false;
  const writes: Record<string, unknown>[] = [];
  mockCardRequests((path, options) => {
    if (path !== '/api/vault') return;
    if (options.method === 'POST') {
      writes.push(JSON.parse(String(options.body)));
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal);
      added = true;
      return Promise.resolve(Response.json(savedCard));
    }
    return Promise.resolve(Response.json(added ? [savedCard] : []));
  });
  const mounted = await mountVault();
  try {
    assert.equal(document.querySelector('form'), null);
    const form = await startNew('New payment card');
    const code = form.querySelector<HTMLInputElement>('[name="securityCode"]')!;
    assert.equal(title().textContent, 'New payment card');
    assert.equal(code.required, false);
    assert.equal(code.type, 'password');
    assert.equal(code.maxLength, 4);
    assert.equal(form.querySelector('[name="password"]'), null);
    assert.equal(form.querySelector('[name="origin"]'), null);
    assert.equal(document.activeElement, form.elements.namedItem('label'));
    (form.elements.namedItem('label') as HTMLInputElement).value = savedCard.label;
    (form.elements.namedItem('cardholder') as HTMLInputElement).value = syntheticCardholder;
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    number.value = syntheticCardNumber;
    const expiry = form.elements.namedItem('expiry') as HTMLInputElement;
    expiry.value = '13/2032';
    await submit(form);
    assert.equal(writes.length, 0);
    assert.equal(document.activeElement, expiry);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /MM \/ YYYY/);
    expiry.value = '04 / 32';
    code.value = '734';
    await submit(form);
    assert.deepEqual(writes, [
      {
        kind: 'card',
        label: savedCard.label,
        cardholder: syntheticCardholder,
        cardNumber: syntheticCardNumber,
        securityCode: '734',
        expiryMonth: 4,
        expiryYear: 2032,
      },
    ]);
    assert.equal(number.value, '');
    assert.equal(code.value, '');
    assert.equal(document.querySelector('.vault-add-form'), null);
    assert.equal(title().textContent, 'Everyday card');
    await back();
    await settle();
    const row = item('Everyday card')!;
    assert.equal(document.activeElement, row);
    assert.match(row.textContent ?? '', /Visa •••• 4242/);
    assert.doesNotMatch(row.textContent ?? '', /Synthetic Cardholder|4242424242424242/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Synthetic Cardholder/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card details reveal and copy only on demand and clear a late number after window hiding', async () => {
  const previousFetch = globalThis.fetch;
  const late = deferred<Response>();
  let delay = false;
  const requests = mockCardRequests((path) =>
    delay && path.endsWith('/card-number') ? late.promise : undefined,
  );
  const copied: string[] = [];
  setClipboard(async (value) => {
    copied.push(value);
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    const view = surface();
    assert.match(view.textContent ?? '', /Synthetic Cardholder/);
    assert.match(view.textContent ?? '', /Expiry date04 \/ 2032/);
    assert.equal(
      requests.some(({ path }) => path.endsWith('/card-number')),
      false,
    );
    assert.equal(view.querySelector('[aria-label="Password hidden"]'), null);
    assert.ok(view.querySelector('[aria-label="Card number hidden"]'));
    assert.equal(title().textContent, 'Everyday card');
    assert.match(view.querySelector('.vault-hero p')?.textContent ?? '', /^Visa •••• 4242$/);
    assert.equal(view.querySelector('img'), null);
    await click('Copy cardholder name');
    await click('Copy card number');
    assert.deepEqual(copied, [syntheticCardholder, syntheticCardNumber]);
    assert.ok(view.querySelector('[aria-label="Card number hidden"]'));
    assert.equal(view.textContent?.includes(syntheticCardNumber), false);
    await click('Show card number');
    assert.equal(view.querySelector('.vault-password-visible')?.textContent, syntheticCardNumber);
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(view.textContent?.includes(syntheticCardNumber), false);
    delay = true;
    await click('Show card number');
    const request = requests.at(-1)!;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(request.options.signal?.aborted, true);
    await act(async () => late.resolve(Response.json({ cardNumber: syntheticCardNumber })));
    assert.equal(view.textContent?.includes(syntheticCardNumber), false);
    await back();
    await click('View Personal account');
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
    assert.doesNotMatch(surface().textContent ?? '', /4242424242424242|Synthetic Cardholder/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Synthetic Cardholder/,
    );
    assert.equal(dom.window.localStorage.length, 0);
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Card edits preserve an omitted number and clear replacement input on cancellation and failure', async () => {
  const previousFetch = globalThis.fetch;
  let card = { ...savedCard };
  const writes: Record<string, unknown>[] = [];
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault') return Promise.resolve(Response.json([card, ...savedLogins]));
    if (path === '/api/vault/card%2Fprivate/details')
      return Promise.resolve(
        Response.json({
          ...card,
          cardholder: writes.length ? 'Updated Holder' : syntheticCardholder,
          hasSecurityCode: false,
        }),
      );
    if (options.method !== 'PATCH') return;
    const input = JSON.parse(String(options.body));
    writes.push(input);
    if (writes.length > 1)
      return Promise.resolve(
        Response.json({ error: `private ${syntheticCardNumber}` }, { status: 500 }),
      );
    card = {
      ...card,
      label: input.label,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
    };
    return Promise.resolve(Response.json(card));
  });
  const mounted = await mountVault();
  try {
    await click('View Everyday card');
    await click('Edit');
    let form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.elements.namedItem('cardNumber'), null);
    assert.match(
      form.querySelector('[aria-label="Card number hidden"]')?.textContent ?? '',
      /4242/,
    );
    await click('Change card number', form);
    const cancelledNumber = form.elements.namedItem('cardNumber') as HTMLInputElement;
    assert.equal(cancelledNumber.required, true);
    assert.equal(cancelledNumber.value, '');
    assert.equal(document.activeElement, cancelledNumber);
    assert.equal(form.checkValidity(), false);
    cancelledNumber.value = '                ';
    await submit(form);
    assert.equal(writes.length, 0);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? '',
      /Enter the new card number/,
    );
    cancelledNumber.value = syntheticCardNumber;
    await click('Cancel change', form);
    assert.equal(cancelledNumber.value, '');
    assert.equal(form.elements.namedItem('cardNumber'), null);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Change card number');
    assert.equal(
      (form.elements.namedItem('cardholder') as HTMLInputElement).value,
      syntheticCardholder,
    );
    await inputValue(form.elements.namedItem('label') as HTMLInputElement, 'Travel card');
    await inputValue(form.elements.namedItem('cardholder') as HTMLInputElement, 'Updated Holder');
    await inputValue(form.elements.namedItem('expiry') as HTMLInputElement, '05 / 2033');
    await submit(form);
    assert.deepEqual(writes[0], {
      kind: 'card',
      label: 'Travel card',
      cardholder: 'Updated Holder',
      expiryMonth: 5,
      expiryYear: 2033,
    });
    assert.equal(
      requests.some(({ path }) => path.endsWith('/card-number')),
      false,
    );
    assert.equal(title().textContent, 'Travel card');
    assert.match(surface().textContent ?? '', /Updated Holder/);
    await click('Edit');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    await click('Change card number', form);
    (form.elements.namedItem('cardNumber') as HTMLInputElement).value = syntheticCardNumber;
    await click('Cancel');
    await click('Edit');
    form = document.querySelector<HTMLFormElement>('.vault-edit-form')!;
    assert.equal(form.elements.namedItem('cardNumber'), null);
    await click('Change card number', form);
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    await submit(form);
    assert.equal(writes[1].cardNumber, syntheticCardNumber);
    assert.equal(number.value, '');
    assert.equal(
      document.querySelector('[role="alert"]')?.textContent,
      'This card could not be updated. Try again.',
    );
    assert.doesNotMatch(document.body.textContent ?? '', /4242424242424242|private /);
    await back();
    assert.ok(item('Travel card'));
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /4242424242424242|Updated Holder/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault deletion is only available in details and requires an explicit confirmation', async () => {
  const previousFetch = globalThis.fetch;
  let removed = false;
  let fail = true;
  const requests = mockCardRequests((path, options) => {
    if (path === '/api/vault')
      return Promise.resolve(Response.json(removed ? savedLogins : [savedCard, ...savedLogins]));
    if (options.method !== 'DELETE') return;
    assert.equal(path, '/api/vault/card%2Fprivate');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (fail)
      return Promise.resolve(Response.json({ error: 'private deletion error' }, { status: 500 }));
    removed = true;
    return Promise.resolve(Response.json({ ok: true }));
  });
  const mounted = await mountVault();
  try {
    assert.equal(
      [...mounted.container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('Delete'),
      ),
      false,
    );
    await click('View Everyday card');
    const row = await click('Delete card');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    assert.match(confirmation().textContent ?? '', /Delete this card\?/);
    assert.match(
      confirmation().textContent ?? '',
      /Otto will remove “Everyday card” from your vault\. You cannot undo this\./,
    );
    assert.equal(document.activeElement?.textContent?.trim(), 'Cancel');
    assert.equal(
      requests.some(({ options }) => options.method === 'DELETE'),
      false,
    );
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(document.querySelector('.vault-surface'));
    assert.equal(document.activeElement, row);
    await click('Delete card');
    await click('Cancel', confirmation());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, row);
    assert.ok(document.querySelector('[aria-label="Card number hidden"]'));
    await click('Delete card');
    await click('Delete card', confirmation());
    assert.equal(
      confirmation().querySelector('[role="alert"]')?.textContent,
      'This card could not be deleted. Try again.',
    );
    assert.equal(document.body.textContent?.includes('private deletion error'), false);
    fail = false;
    await click('Delete card', confirmation());
    await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector('.vault-surface'), null);
    assert.equal(item('Everyday card'), undefined);
    assert.ok(item('Personal account'));
    assert.equal(document.activeElement?.textContent?.trim(), 'New');
    await click('View Personal account');
    await click('Delete login');
    assert.match(confirmation().textContent ?? '', /Delete this login\?/);
    assert.match(
      confirmation().textContent ?? '',
      /“Personal account” for accounts\.example\.test:8443/,
    );
    await click('Cancel', confirmation());
    assert.ok(document.querySelector('[aria-label="Password hidden"]'));
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('New payment card blocks cancellation while saving and fences responses after unmount', async () => {
  const previousFetch = globalThis.fetch;
  const pending = deferred<Response>();
  const requests = mockCardRequests((path, options) =>
    path === '/api/vault' && options.method === 'POST' ? pending.promise : undefined,
  );
  const mounted = await mountVault();
  try {
    let form = await startNew('New payment card');
    (form.elements.namedItem('label') as HTMLInputElement).value = 'Pending card';
    (form.elements.namedItem('cardholder') as HTMLInputElement).value = syntheticCardholder;
    const number = form.elements.namedItem('cardNumber') as HTMLInputElement;
    number.value = syntheticCardNumber;
    await act(async () => window.dispatchEvent(new Event('blur')));
    assert.equal(number.value, '');
    number.value = syntheticCardNumber;
    (form.elements.namedItem('expiry') as HTMLInputElement).value = '04/2032';
    await submit(form);
    const saving = requests.at(-1)!;
    assert.equal(number.value, '');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    )!;
    assert.equal(cancel.disabled, true);
    await act(async () => cancel.click());
    await act(async () =>
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(document.querySelector('.vault-add-form'), form);
    assert.equal(saving.options.signal?.aborted, false);
    await act(async () => mounted.root.render(null));
    assert.equal(saving.options.signal?.aborted, true);
    await act(async () => mounted.root.render(createElement(Vault)));
    form = await startNew('New login');
    assert.equal((form.elements.namedItem('password') as HTMLInputElement).value, '');
    await act(async () => pending.resolve(Response.json({ ...savedCard, label: 'Pending card' })));
    assert.equal(title().textContent, 'New login');
    assert.doesNotMatch(document.body.textContent ?? '', /Pending card|4242424242424242/);
    assert.doesNotMatch(
      JSON.stringify(pageDataCache.getSnapshot('/api/vault')),
      /Pending card|4242424242424242/,
    );
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('deleting the default desktop Vault item closes details and returns focus to New', async () => {
  const previousFetch = globalThis.fetch;
  let removed = false;
  mockCardRequests((path, options) => {
    if (path === '/api/vault')
      return Promise.resolve(Response.json(removed ? savedLogins : [savedCard, ...savedLogins]));
    if (options.method === 'DELETE') {
      assert.equal(path, '/api/vault/card%2Fprivate');
      removed = true;
      return Promise.resolve(Response.json({ ok: true }));
    }
  });
  phone = false;
  const mounted = await mountVault();
  try {
    assert.equal(title().textContent, 'Everyday card');
    await click('Delete card');
    await click('Delete card', confirmation());
    await settle();
    assert.equal(Boolean(surface()), false);
    assert.ok(item('Personal account'));
    assert.equal(document.activeElement?.textContent?.trim(), 'New');
    await click('View Personal account');
    assert.equal(title().textContent, 'Personal account');
  } finally {
    await mounted.unmount();
    globalThis.fetch = previousFetch;
  }
});

test('Vault icons use guarded account requests and discard stale loads and revoke object URLs', async () => {
  const { VaultEntryIcon } = await import('../src/web/components/vault-surface.tsx');
  const { setRequestAccount } = await import('../src/web/lib/api.ts');
  const previousFetch = globalThis.fetch;
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const created: Blob[] = [];
  const revoked: string[] = [];
  const pending = deferred<Response>();
  const requests: Array<{ path: string; options: RequestInit }> = [];
  URL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    created.push(blob);
    return `blob:fixture-${created.length}`;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path: String(path), options });
    return requests.length === 1 ? pending.promise : new Response('synthetic-icon');
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    setRequestAccount('first-owner');
    await act(async () => root.render(createElement(VaultEntryIcon, { entry: savedLogins[0] })));
    assert.equal(requests[0].path, '/api/vault/personal%2Flogin/icon');
    assert.equal(new Headers(requests[0].options.headers).get('X-Otto-Account'), 'first-owner');
    assert.equal(requests[0].options.cache, 'no-store');
    setRequestAccount('second-owner');
    assert.equal(requests[0].options.signal?.aborted, true);
    await act(async () => pending.resolve(new Response('stale-icon')));
    assert.equal(created.length, 0);
    assert.equal(container.querySelector('img'), null);
    await act(async () => root.render(createElement(VaultEntryIcon, { entry: savedLogins[1] })));
    assert.equal(new Headers(requests[1].options.headers).get('X-Otto-Account'), 'second-owner');
    assert.equal(container.querySelector('img')?.getAttribute('src'), 'blob:fixture-1');
    await act(async () => root.render(null));
    assert.deepEqual(revoked, ['blob:fixture-1']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    setRequestAccount(null);
    globalThis.fetch = previousFetch;
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
  }
});
