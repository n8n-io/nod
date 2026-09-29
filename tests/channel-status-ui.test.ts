import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'Element',
  'NodeFilter',
  'MutationObserver',
  'CustomEvent',
  'getComputedStyle',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Channels } = await import('../src/web/pages/channels.tsx');
const status = {
  channels: [
    { provider: 'telegram', status: 'configured', missing: [] },
    { provider: 'whatsapp', status: 'configured', missing: [] },
  ],
  error: null,
};
const settings = {
  ready: true,
  channels: [
    {
      provider: 'telegram',
      enabled: true,
      mode: 'polling',
      accountName: 'Fixture Telegram',
      accountHandle: '@fixture_bot',
    },
    {
      provider: 'whatsapp',
      enabled: true,
      mode: 'webhook',
      webhookStatus: 'registered',
      accountName: 'Fixture WhatsApp',
    },
  ],
};
const snapshot = (path: string) => (path === '/api/channels' ? status : settings);
const dialogButton = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent === label,
  );
  assert.ok(button, `Expected dialog button: ${label}`);
  return button;
};

test('accepted channel disconnect survives a failed refresh and an older in-flight read', async () => {
  const priorFetch = globalThis.fetch;
  let mode: 'ready' | 'held' | 'failed' = 'ready';
  const pending: Array<{ path: string; finish: (response: Response) => void }> = [];
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === 'DELETE') {
      writes.push(path);
      mode = 'failed';
      return Response.json({ ok: true, channel: { provider: 'telegram', enabled: false } });
    }
    if (mode === 'held') return new Promise<Response>((finish) => pending.push({ path, finish }));
    if (mode === 'failed')
      return Response.json({ error: 'Fixture status refresh failed.' }, { status: 503 });
    return Response.json(snapshot(path));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    assert.match(element.textContent!, /Fixture Telegram|Ready for messages/);
    mode = 'held';
    await act(async () => window.dispatchEvent(new Event('focus')));
    assert.equal(pending.length, 2);
    const telegram = element.querySelector<HTMLElement>('.channel-option')!;
    await act(async () => {
      const remove = telegram.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
      remove.focus();
      remove.click();
    });
    assert.deepEqual(writes, []);
    await act(async () => dialogButton('Remove channel').click());
    await act(async () => delay(0));
    assert.deepEqual(writes, ['/api/channel-settings/telegram']);
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Connect Telegram');
    assert.doesNotMatch(
      element.querySelector('[aria-labelledby="channel-telegram"]')?.textContent ?? '',
      /Fixture Telegram|Ready for messages|Start conversation/,
    );
    assert.match(element.textContent!, /Fixture status refresh failed/);
    assert.match(element.textContent!, /Fixture WhatsApp|Webhook registered/);
    await act(async () => {
      for (const read of pending) read.finish(Response.json(snapshot(read.path)));
    });
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.doesNotMatch(
      element.querySelector('[aria-labelledby="channel-telegram"]')?.textContent ?? '',
      /Fixture Telegram|Ready for messages/,
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('a rejected channel removal preserves the saved account and leaves the dialog ready to retry', async () => {
  const priorFetch = globalThis.fetch;
  let removed = false;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE') {
      writes.push(String(input));
      if (writes.length === 1)
        return Response.json({ error: 'Fixture disconnect was rejected.' }, { status: 503 });
      removed = true;
      return Response.json({ channel: { provider: 'telegram', enabled: false } });
    }
    return Response.json(
      removed
        ? String(input) === '/api/channels'
          ? {
              ...status,
              channels: [
                { provider: 'telegram', status: 'disabled', missing: [] },
                status.channels[1],
              ],
            }
          : { ...settings, channels: [settings.channels[1]] }
        : snapshot(String(input)),
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    await act(async () => {
      const remove = element.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
      remove.focus();
      remove.click();
    });
    await act(async () => dialogButton('Remove channel').click());
    assert.equal(Boolean(element.querySelector('[aria-label="Connect Telegram"]')), false);
    assert.match(element.textContent ?? '', /Fixture Telegram/);
    assert.match(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '',
      /Fixture disconnect was rejected/,
    );
    assert.equal(dialogButton('Remove channel').disabled, false);
    assert.deepEqual(writes, ['/api/channel-settings/telegram']);
    await act(async () => dialogButton('Remove channel').click());
    await act(async () => delay(0));
    assert.deepEqual(writes, ['/api/channel-settings/telegram', '/api/channel-settings/telegram']);
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.equal(Boolean(element.querySelector('[data-channel-remove="telegram"]')), false);
    assert.ok(element.querySelector('[data-channel-remove="whatsapp"]'));
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Connect Telegram');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

const typeInDialog = async (value: string) =>
  act(async () => {
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const submitDialogForm = async () =>
  act(async () => {
    document
      .querySelector('[role="dialog"] form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
const clickInDialog = async (label: string) =>
  act(async () => {
    const control = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"] button, [role="dialog"] a'),
    ].find((candidate) => candidate.textContent?.trim() === label);
    assert.ok(control, `Expected dialog control: ${label}`);
    control.click();
  });

test('Telegram setup asks the owner to confirm the account that pressed Start before binding it', async () => {
  const priorFetch = globalThis.fetch;
  const priorOpen = window.open;
  const startUrl = (index: number) =>
    `https://t.me/fixture_bot?start=synthetic-one-time-code-${index}-0000000000`;
  let saved: 'none' | 'waiting' | 'candidate' | 'bound' = 'none';
  let links = 0;
  let reject = true;
  let opened = 0;
  const writes: string[] = [];
  window.open = () => {
    opened++;
    return null;
  };
  const expiry = new Date(Date.now() + 600000).toISOString();
  const telegram = () => ({
    ...settings.channels[0],
    ...(saved === 'bound'
      ? { allowedUserId: '123456789', pairedUser: '@fixture_owner' }
      : { pairingExpiresAt: expiry }),
    ...(saved === 'candidate'
      ? { pairingCandidate: { id: '123456789', name: '@fixture_owner' } }
      : {}),
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method) {
      writes.push(`${init.method} ${path}`);
      if (init.method === 'PUT') {
        assert.deepEqual(JSON.parse(String(init.body)), { botToken: 'synthetic-fixture-token' });
        if (reject) return Response.json({ error: 'Verification failed.' }, { status: 503 });
        saved = 'waiting';
        return Response.json({ channel: telegram(), pairingUrl: startUrl(++links) });
      }
      if (path.endsWith('/pairing')) {
        saved = 'waiting';
        return Response.json({ channel: telegram(), pairingUrl: startUrl(++links) });
      }
      saved = 'bound';
      return Response.json({ channel: telegram() });
    }
    return Response.json(
      saved === 'none'
        ? path === '/api/channels'
          ? { channels: [], error: null }
          : { ready: true, channels: [] }
        : path === '/api/channels'
          ? status
          : { ...settings, channels: [telegram(), settings.channels[1]] },
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const dialogText = () => document.querySelector('[role="dialog"]')!.textContent!;
  const refresh = () => act(async () => window.dispatchEvent(new Event('focus')));
  try {
    await act(async () => root.render(createElement(Channels)));
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Connect Telegram"]')!.click(),
    );
    assert.match(dialogText(), /Add your bot/);
    assert.doesNotMatch(dialogText(), /user ID/);
    const style = document.createElement('style');
    style.textContent = await readFile(
      new URL('../src/web/pages/channels.css', import.meta.url),
      'utf8',
    );
    document.head.append(style);
    const next = document.querySelector<HTMLElement>('.telegram-checklist > li.is-next')!;
    assert.equal(
      dom.window.getComputedStyle(next.querySelector('.telegram-checklist-marker')!).opacity,
      '0.55',
    );
    style.remove();
    await typeInDialog('synthetic-fixture-token');
    await submitDialogForm();
    assert.match(dialogText(), /Verification failed/);
    reject = false;
    await submitDialogForm();
    assert.match(dialogText(), /@fixture_bot is ready/);
    assert.match(dialogText(), /Press Start in Telegram/);
    assert.match(dialogText(), /Enter your user ID instead/);
    assert.equal(document.activeElement?.getAttribute('href'), startUrl(1));
    assert.equal(document.activeElement?.getAttribute('target'), '_blank');

    saved = 'candidate';
    await refresh();
    assert.match(
      dialogText(),
      /Only this Telegram account can message Otto: @fixture_owner, ID 123456789\. Is this you\?/,
    );
    assert.equal(document.activeElement?.textContent, 'Confirm');
    await clickInDialog('Not me');
    assert.equal(writes.at(-1), 'POST /api/channel-settings/telegram/pairing');
    assert.doesNotMatch(dialogText(), /Is this you/);
    assert.equal(document.activeElement?.getAttribute('href'), startUrl(2));

    saved = 'candidate';
    await refresh();
    await clickInDialog('Confirm');
    assert.equal(writes.at(-1), 'POST /api/channel-settings/telegram/confirm');
    assert.match(dialogText(), /Telegram is connected/);
    assert.match(
      dialogText(),
      /Only this Telegram account can message Otto: @fixture_owner, ID 123456789\./,
    );
    assert.equal(document.activeElement?.getAttribute('href'), 'https://t.me/fixture_bot');
    await clickInDialog('Done');
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.match(element.textContent!, /Only @fixture_owner, ID 123456789 can message Otto/);
    assert.equal(
      element.querySelector('a[href="https://t.me/fixture_bot"]')?.textContent,
      'Start conversation',
    );
    assert.equal(opened, 0);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    window.open = priorOpen;
  }
});

test('an unpaired Telegram channel can bind a user ID found with @userinfobot', async () => {
  const priorFetch = globalThis.fetch;
  const writes: Array<{ path: string; body: unknown }> = [];
  let bound = false;
  const pending = () => ({
    ...settings.channels[0],
    ...(bound
      ? { allowedUserId: '4242' }
      : { pairingExpiresAt: new Date(Date.now() - 1000).toISOString() }),
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method) {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/user')) bound = true;
      return Response.json(
        path.endsWith('/pairing')
          ? {
              channel: {
                ...pending(),
                pairingExpiresAt: new Date(Date.now() + 600000).toISOString(),
              },
              pairingUrl: 'https://t.me/fixture_bot?start=synthetic-fresh-code-0000000000000',
            }
          : { channel: pending() },
      );
    }
    return Response.json(
      path === '/api/channels'
        ? status
        : { ...settings, channels: [pending(), settings.channels[1]] },
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const row = element.querySelector<HTMLElement>('[aria-labelledby="channel-telegram"]')!;
    assert.match(row.textContent!, /Start link expired/);
    assert.equal(Boolean(row.querySelector('a[href="https://t.me/fixture_bot"]')), false);
    await act(async () =>
      [...row.querySelectorAll('button')]
        .find((button) => button.textContent?.startsWith('Finish setup'))!
        .click(),
    );
    assert.deepEqual(writes, [{ path: '/api/channel-settings/telegram/pairing', body: {} }]);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog.querySelector('a[href$="synthetic-fresh-code-0000000000000"]'));
    await clickInDialog('Enter your user ID instead');
    assert.match(dialog.textContent!, /@userinfobot/);
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    assert.equal(input.inputMode, 'numeric');
    assert.equal(input.pattern, '[1-9][0-9]{0,15}');
    assert.equal(input.required, true);
    await typeInDialog('4242');
    await submitDialogForm();
    assert.deepEqual(writes.at(-1), {
      path: '/api/channel-settings/telegram/user',
      body: { allowedUserId: '4242' },
    });
    assert.match(
      document.querySelector('[role="dialog"]')!.textContent!,
      /Only this Telegram account can message Otto: ID 4242\./,
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('leaving Channels aborts a single pending setup and ignores its late completion after returning', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let reads = 0;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PUT') {
      writes.push(String(input));
      signal = init.signal;
      assert.deepEqual(JSON.parse(String(init.body)), { botToken: 'synthetic-fixture-token' });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    reads++;
    return Response.json(
      String(input) === '/api/channels'
        ? { channels: [], error: null }
        : { ready: true, channels: [] },
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const submit = () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const type = async (value: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  try {
    await act(async () => root.render(createElement(Channels)));
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Connect Telegram"]')!.click(),
    );
    await type('synthetic-fixture-token');
    await act(async () => {
      submit();
      submit();
    });
    assert.deepEqual(writes, ['/api/channel-settings/telegram']);
    assert.equal(dialogButton('Checking…').disabled, true);
    await act(async () => root.render(null));
    await act(async () => delay(0));
    assert.equal(signal?.aborted, true);
    await act(async () => root.render(createElement(Channels)));
    const readsBeforeResponse = reads;
    await act(async () => finish(Response.json({ channel: settings.channels[0] })));
    assert.equal(reads, readsBeforeResponse);
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.ok(element.querySelector('[aria-label="Connect Telegram"]'));
    assert.equal(Boolean(element.querySelector('[data-channel-remove="telegram"]')), false);
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[aria-label="Connect Telegram"]')!.click(),
    );
    assert.equal(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value, '');
  } finally {
    await act(async () => root.unmount());
    await act(async () => delay(0));
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('delivery guidance closes with Escape and returns focus without changing channel setup', async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    Response.json(
      String(input) === '/api/channels'
        ? status
        : {
            ...settings,
            channels: [
              settings.channels[0],
              {
                ...settings.channels[1],
                webhookStatus: 'manual_setup',
                webhookUrl: 'https://fixture.example.test/api/webhooks/whatsapp',
              },
            ],
          },
    );
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const [telegram, whatsapp] = [...element.querySelectorAll<HTMLElement>('.channel-option')];
    assert.equal(Boolean(telegram.querySelector('.channel-account-status')), false);
    assert.equal(Boolean(telegram.querySelector('[aria-haspopup="menu"]')), false);
    assert.match(whatsapp.textContent!, /Finish delivery setup/);
    await act(async () =>
      [...whatsapp.querySelectorAll('button')]
        .find((button) => button.textContent?.startsWith('Finish setup'))!
        .click(),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(dialog.textContent!, /Finish the callback in Meta/);
    assert.match(dialog.textContent!, /fixture\.example\.test\/api\/webhooks\/whatsapp/);
    assert.equal(dialog.querySelectorAll('[role="menuitem"]').length, 0);
    await act(async () =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    await act(async () => delay(0));
    assert.equal(document.activeElement?.textContent, 'Finish setup');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('cancelling channel removal returns focus and keeps the saved connection without a request', async () => {
  const priorFetch = globalThis.fetch;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method) writes.push(String(input));
    return Response.json(snapshot(String(input)));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const remove = element.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
    await act(async () => {
      remove.focus();
      remove.click();
    });
    assert.deepEqual(writes, []);
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /Remove Telegram channel\?/,
    );
    assert.equal(document.activeElement?.textContent, 'Keep channel');
    await act(async () => dialogButton('Keep channel').click());
    await act(async () => delay(0));
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Remove Telegram channel');
    assert.match(element.textContent!, /Fixture Telegram/);
    assert.equal(Boolean(element.querySelector('[aria-label="Connect Telegram"]')), false);
    assert.deepEqual(writes, []);
    await act(async () => remove.click());
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await act(async () => delay(0));
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Remove Telegram channel');
    assert.deepEqual(writes, []);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('pending channel removal blocks dismissal and repeated requests until the selected provider is removed', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let removed = false;
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE') {
      writes.push(String(input));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json(
      removed
        ? String(input) === '/api/channels'
          ? {
              ...status,
              channels: [
                status.channels[0],
                { provider: 'whatsapp', status: 'disabled', missing: [] },
              ],
            }
          : { ...settings, channels: [settings.channels[0]] }
        : snapshot(String(input)),
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    const remove = element.querySelector<HTMLButtonElement>('[data-channel-remove="whatsapp"]')!;
    await act(async () => {
      remove.focus();
      remove.click();
    });
    assert.match(
      document.querySelector('[role="dialog"]')?.textContent ?? '',
      /Remove WhatsApp channel\?/,
    );
    assert.deepEqual(writes, []);
    const confirm = dialogButton('Remove channel');
    await act(async () => confirm.click());
    assert.deepEqual(writes, ['/api/channel-settings/whatsapp']);
    assert.equal(confirm.disabled, true);
    assert.equal(dialogButton('Keep channel').disabled, true);
    assert.match(element.textContent ?? '', /Fixture WhatsApp/);
    await act(async () => {
      confirm.click();
      remove.click();
      document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.deepEqual(writes, ['/api/channel-settings/whatsapp']);
    await act(async () => {
      removed = true;
      finish(Response.json({ channel: { provider: 'whatsapp', enabled: false } }));
    });
    await act(async () => delay(0));
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    assert.equal(Boolean(element.querySelector('[data-channel-remove="whatsapp"]')), false);
    assert.ok(element.querySelector('[data-channel-remove="telegram"]'));
    assert.equal(element.querySelector('[aria-label="Connect WhatsApp"]'), null);
    assert.match(element.textContent ?? '', /WhatsAppChat with Otto in WhatsApp\.Coming soon/);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('leaving Channels aborts removal and ignores a late accepted response', async () => {
  const priorFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'DELETE') {
      signal = init.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    reads++;
    return Response.json(snapshot(String(input)));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(Channels)));
    await act(async () =>
      element.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!.click(),
    );
    await act(async () => dialogButton('Remove channel').click());
    await act(async () => root.render(null));
    assert.equal(signal?.aborted, true);
    const previousReads = reads;
    await act(async () =>
      finish(Response.json({ channel: { provider: 'telegram', enabled: false } })),
    );
    assert.equal(reads, previousReads);
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});
