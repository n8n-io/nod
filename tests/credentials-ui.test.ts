import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { Credentials } from '../src/web/pages/credentials.tsx';
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
  'FormData',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const first = 'first-secure-request-12345',
  next = 'next-secure-request-123456';
const pending = {
  id: first,
  origin: 'https://example.com',
  kind: 'password',
  status: 'pending',
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  fields: [
    { kind: 'identifier', label: 'Username' },
    { kind: 'password', label: 'Password' },
  ],
  methods: [],
};
async function setup(
  retryUrl = '/vault/' + next,
  options: {
    request?: Record<string, unknown>;
    ok?: boolean;
    rejectSaved?: boolean;
    response?: (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const previous = globalThis.fetch;
  const requests: Array<{
    path: string;
    body: Record<string, string>;
    cache?: RequestCache;
    signal?: AbortSignal | null;
  }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push({ path, body, cache: init?.cache, signal: init?.signal });
    const response = options.response?.(path, init);
    if (response) return response;
    const value =
      path.endsWith('/refresh') || !init?.method
        ? { ...pending, ...options.request }
        : (path.endsWith('/' + first) && !options.ok) ||
            (path.endsWith('/saved') && options.rejectSaved)
          ? {
              ok: false,
              retryUrl,
              error: 'The site did not accept those details. Please try again.',
            }
          : { ok: true };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  window.history.replaceState(null, '', '/vault/' + first);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(createElement(Credentials, { id: first })));
  return {
    element,
    requests,
    async change(id: string) {
      await act(async () => root.render(createElement(Credentials, { id })));
    },
    async submit(password: string) {
      const user = element.querySelector<HTMLInputElement>('input[name=username]')!;
      const pass = element.querySelector<HTMLInputElement>('input[name=password]')!;
      element.querySelector<HTMLInputElement>('input[name=label]')!.value = 'My work account';
      user.value = 'synthetic-user';
      pass.value = password;
      await act(async () =>
        element
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
    },
    async close() {
      await act(async () => root.unmount());
      element.remove();
      globalThis.fetch = previous;
    },
  };
}
test('known rejection replaces consumed Vault link, clears values and submits corrected details to fresh request', async () => {
  const f = await setup();
  try {
    await f.submit('incorrect-synthetic');
    assert.equal(window.location.pathname, '/vault/' + next);
    assert.match(f.element.textContent!, /did not accept/);
    assert.doesNotMatch(f.element.textContent!, /Details submitted/);
    assert.equal(f.element.querySelector<HTMLInputElement>('input[name=password]')!.value, '');
    assert.equal(f.element.querySelector<HTMLInputElement>('input[name=username]')!.value, '');
    assert.equal(
      f.element.querySelector<HTMLInputElement>('input[name=label]')!.value,
      'My work account',
    );
    await f.submit('correct-synthetic');
    assert.equal(f.requests.filter((r) => r.body.password).length, 2);
    assert.ok(
      f.requests.some(
        (r) => r.path.endsWith('/' + next) && r.body.password === 'correct-synthetic',
      ),
    );
    assert.match(f.element.textContent!, /Details submitted/);
  } finally {
    await f.close();
  }
});

const savedEntries = [
  { id: 'personal', label: 'Personal account', origin: 'https://example.com', usernameHint: 'pe…' },
  { id: 'work', label: 'Work account', origin: 'https://example.com', usernameHint: 'wo…' },
];

test('a new login offers an editable website name and submits it without another request', async () => {
  const f = await setup(undefined, { request: { origin: 'https://x.com' }, ok: true });
  try {
    const name = f.element.querySelector<HTMLInputElement>('input[name=label]')!;
    assert.equal(name.value, 'X.com');
    assert.match(name.labels![0].textContent ?? '', /^Name/);
    assert.equal(document.activeElement?.getAttribute('name'), 'username');
    f.element.querySelector<HTMLInputElement>('input[name=username]')!.value = 'synthetic-user';
    f.element.querySelector<HTMLInputElement>('input[name=password]')!.value = 'synthetic-password';
    await act(async () =>
      f.element
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.deepEqual(f.requests.find((request) => request.body.password)?.body, {
      label: 'X.com',
      username: 'synthetic-user',
      password: 'synthetic-password',
    });
    assert.equal(f.requests.length, 2);
    assert.match(f.element.textContent!, /Details submitted/);
  } finally {
    await f.close();
  }
});

test('another login suggests a distinct name and retains edits while switching saved choices', async () => {
  const f = await setup(undefined, {
    request: {
      savedEntries: savedEntries.map((entry, index) => ({
        ...entry,
        label: index === 0 ? 'Example.com' : 'example.COM 2',
      })),
    },
  });
  const click = async (label: string) => {
    const button = [...f.element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    )!;
    await act(async () => button.click());
  };
  try {
    await click('Use another login');
    const name = f.element.querySelector<HTMLInputElement>('input[name=label]')!;
    assert.equal(name.value, 'Example.com 3');
    name.value = 'My personal account';
    await act(async () => name.dispatchEvent(new Event('input', { bubbles: true })));
    await click('Choose a saved login');
    await click('Use another login');
    assert.equal(
      f.element.querySelector<HTMLInputElement>('input[name=label]')!.value,
      'My personal account',
    );
    assert.equal(f.requests.length, 1);
  } finally {
    await f.close();
  }
});

test('multiple saved logins show named choices and submit only the selected entry ID', async () => {
  const f = await setup(undefined, { request: { savedEntries } });
  try {
    assert.match(f.element.textContent!, /Sign inexample\.com/);
    assert.doesNotMatch(f.element.textContent!, /https:\/\//);
    assert.match(f.element.textContent!, /Choose a login/);
    assert.equal(f.element.querySelector('input[name=password]'), null);
    const selected = [...f.element.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Work account'),
    )!;
    await act(async () => selected.click());
    assert.deepEqual(f.requests.find((request) => request.path.endsWith('/saved'))?.body, {
      entryId: 'work',
    });
    assert.match(f.element.textContent!, /Details submitted/);
  } finally {
    await f.close();
  }
});

test('another login submits its own name and never changes the trusted website', async () => {
  const f = await setup(undefined, { request: { savedEntries }, ok: true });
  try {
    const another = [...f.element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use another login',
    )!;
    await act(async () => another.click());
    assert.equal(f.element.querySelector<HTMLInputElement>('input[name=label]')!.required, true);
    assert.equal(f.element.querySelector('input[name=origin]'), null);
    await f.submit('new-synthetic-secret');
    assert.deepEqual(f.requests.find((request) => request.body.password)?.body, {
      label: 'My work account',
      username: 'synthetic-user',
      password: 'new-synthetic-secret',
    });
    assert.equal(
      f.requests.some((request) => request.path.endsWith('/saved')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('an identifier stage collects the named login and password in one private submission', async () => {
  const f = await setup(undefined, {
    request: { kind: 'identifier', fields: [{ kind: 'identifier', label: 'Email address' }] },
    ok: true,
  });
  try {
    assert.match(f.element.textContent!, /Email address/);
    assert.ok(f.element.querySelector('input[name=password]'));
    assert.ok(f.element.querySelector('input[name=label]'));
    await f.submit('one-form-secret');
    assert.deepEqual(f.requests.find((request) => request.body.password)?.body, {
      label: 'My work account',
      username: 'synthetic-user',
      password: 'one-form-secret',
    });
    assert.equal(f.requests.filter((request) => request.body.password).length, 1);
    assert.equal(f.element.querySelector('input[name=password]'), null);
    assert.doesNotMatch(f.element.textContent!, /one-form-secret/);
  } finally {
    await f.close();
  }
});

test('rejected saved login opens fresh entry instead of retrying the same account', async () => {
  const f = await setup(undefined, { request: { savedEntries }, rejectSaved: true });
  try {
    const selected = [...f.element.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Work account'),
    )!;
    await act(async () => selected.click());
    assert.equal(window.location.pathname, '/vault/' + next);
    assert.ok(f.element.querySelector('input[name=label]'));
    assert.ok(f.element.querySelector('input[name=password]'));
    assert.doesNotMatch(f.element.textContent!, /Details submitted/);
    assert.equal(f.requests.filter((request) => request.path.endsWith('/saved')).length, 1);
  } finally {
    await f.close();
  }
});

test('verification codes never ask for a login name or offer saved passwords', async () => {
  const f = await setup(undefined, {
    request: { kind: 'otp', savedEntries, fields: [{ kind: 'otp', label: 'Verification code' }] },
  });
  try {
    assert.ok(f.element.querySelector('input[name=code]'));
    assert.equal(f.element.querySelector('input[name=label]'), null);
    assert.doesNotMatch(f.element.textContent!, /Choose a login|Personal account/);
  } finally {
    await f.close();
  }
});
test('rejected credentials never navigate to an external retry URL', async () => {
  const f = await setup('https://elsewhere.example/vault/' + next);
  try {
    await f.submit('incorrect-synthetic');
    assert.equal(window.location.pathname, '/vault/' + first);
    assert.match(f.element.textContent!, /new Vault form could not be opened/);
    assert.equal(f.element.querySelector<HTMLInputElement>('input[name=password]')!.value, '');
  } finally {
    await f.close();
  }
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('opening a secure form uses one uncached read without another browser round trip', async () => {
  const f = await setup();
  try {
    assert.ok(f.element.querySelector('input[name=password]'));
    assert.deepEqual(
      f.requests.map((request) => request.path),
      ['/api/credential-requests/' + first],
    );
    assert.equal(f.requests[0]?.cache, 'no-store');
  } finally {
    await f.close();
  }
});

test('submission clears inputs immediately and shows progress until the website responds', async () => {
  const response = deferred<Response>();
  const f = await setup(undefined, {
    response: (_, init) => (init?.method === 'POST' ? response.promise : undefined),
  });
  try {
    await f.submit('synthetic-pending-password');
    assert.equal(f.element.querySelector('input[name=password]'), null);
    assert.match(f.element.querySelector('[role=status]')!.textContent!, /Continuing sign-in/);
    assert.equal(f.element.querySelector('[aria-busy=true]') !== null, true);
    assert.doesNotMatch(f.element.textContent!, /Details submitted|synthetic-pending-password/);
    assert.equal(f.requests.at(-1)?.cache, 'no-store');
    await act(async () => response.resolve(json({ ok: true })));
    assert.match(f.element.textContent!, /Details submitted/);
    assert.doesNotMatch(f.element.textContent!, /signed in|authenticated|Waiting for the website/);
  } finally {
    await f.close();
  }
});

test('a late secure result cannot navigate or complete a replacement form', async () => {
  const response = deferred<Response>();
  const f = await setup(undefined, {
    response: (path, init) => {
      if (init?.method === 'POST') return response.promise;
      if (path.endsWith(next)) return json({ ...pending, id: next, origin: 'https://next.test' });
    },
  });
  try {
    await f.submit('synthetic-stale-password');
    const submission = f.requests.at(-1)!;
    await f.change(next);
    assert.equal(submission.signal?.aborted, true);
    await act(async () =>
      response.resolve(json({ ok: false, retryUrl: '/vault/obsolete-secure-request-12345' })),
    );
    assert.match(f.element.textContent!, /next\.test/);
    assert.equal(f.element.querySelector('[aria-busy=true]'), null);
    assert.ok(f.element.querySelector('input[name=password]'));
    assert.doesNotMatch(f.element.textContent!, /Details submitted|not accept/);
    assert.equal(window.location.pathname, '/vault/' + first);
  } finally {
    await f.close();
  }
});

test('repeated rejected verification codes keep a fresh usable form and never echo server content', async () => {
  let attempts = 0;
  const paths: string[] = [];
  const secondRetry = 'third-secure-request-12345';
  const f = await setup(undefined, {
    request: { kind: 'otp', fields: [{ kind: 'otp', label: 'Verification code' }] },
    response: (path, init) => {
      if (init?.method !== 'POST') return;
      paths.push(path);
      attempts++;
      return json(
        attempts < 3
          ? {
              ok: false,
              retryUrl: '/vault/' + (attempts === 1 ? next : secondRetry),
              error: 'private-site-error-and-code',
            }
          : { ok: true },
      );
    },
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      f.element.querySelector<HTMLInputElement>('input[name=code]')!.value = '00000' + attempt;
      await act(async () =>
        f.element
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      if (attempt < 2) {
        assert.match(
          f.element.querySelector('[role=alert]')!.textContent!,
          /did not accept that code/,
        );
        assert.equal(f.element.querySelector<HTMLInputElement>('input[name=code]')!.value, '');
        assert.equal(f.element.querySelector('input[name=password]'), null);
        assert.doesNotMatch(
          f.element.textContent!,
          /private-site-error-and-code|Details submitted/,
        );
      }
    }
    assert.deepEqual(
      paths,
      [first, next, secondRetry].map((token) => '/api/credential-requests/' + token),
    );
    assert.match(f.element.textContent!, /Details submitted/);
  } finally {
    await f.close();
  }
});

test('late initial reads and credential responses are aborted when the secure form is dismissed', async () => {
  const initial = deferred<Response>();
  const f = await setup(undefined, { response: () => initial.promise });
  assert.match(f.element.textContent!, /Opening your form/);
  const read = f.requests[0]!;
  await f.close();
  assert.equal(read.signal?.aborted, true);
  await act(async () => initial.resolve(json(pending)));
  assert.equal(f.element.textContent, '');

  const submission = deferred<Response>();
  const nextForm = await setup(undefined, {
    response: (_, init) => (init?.method === 'POST' ? submission.promise : undefined),
  });
  await nextForm.submit('discarded-secret');
  const post = nextForm.requests.at(-1)!;
  await nextForm.close();
  assert.equal(post.signal?.aborted, true);
  await act(async () => submission.resolve(json({ ok: true })));
  assert.equal(nextForm.element.textContent, '');
});

test('sign-in method choices stay in chat instead of appearing in a Vault form', async () => {
  const f = await setup(undefined, {
    request: {
      fields: [],
      methods: [{ id: 'oauth', label: 'Continue with fixture', kind: 'oauth', supported: true }],
    },
  });
  try {
    assert.doesNotMatch(f.element.textContent!, /Continue with fixture/);
    assert.match(f.element.textContent!, /Return to chat/);
    assert.equal(f.element.querySelector('form'), null);
    assert.equal(
      f.requests.some((request) => request.path.endsWith('/method')),
      false,
    );
  } finally {
    await f.close();
  }
});
