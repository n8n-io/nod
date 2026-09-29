import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';

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
  'Node',
  'NodeFilter',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { Channels, ChannelAccount } = await import('../src/web/pages/channels.tsx');
const click = (element: Element) =>
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

test('ready Channels offer a bot conversation and direct removal without setup menus', async () => {
  const priorFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, undefined);
    calls.push(String(url));
    return new Response(
      JSON.stringify(
        String(url) === '/api/channels'
          ? {
              channels: [
                { provider: 'telegram', status: 'configured', missing: [] },
                { provider: 'whatsapp', status: 'disabled', missing: [] },
              ],
              error: null,
            }
          : {
              ready: true,
              channels: [
                {
                  provider: 'telegram',
                  enabled: true,
                  mode: 'polling',
                  accountName: 'FixtureBot',
                  accountHandle: '@FixtureBot',
                },
              ],
            },
      ),
    );
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Channels)));
    assert.deepEqual(calls.sort(), ['/api/channel-settings', '/api/channels']);
    const [telegram, whatsapp] = Array.from(container.querySelectorAll('.channel-option'));
    assert.match(container.textContent ?? '', /Connected channels/);
    assert.match(container.textContent ?? '', /More channels/);
    assert.equal(whatsapp.querySelector('[id="channel-whatsapp"]')?.textContent, 'WhatsApp');
    assert.match(telegram.querySelector('.channel-option-benefit')?.textContent ?? '', /Telegram/);
    assert.equal(Boolean(telegram.querySelector('.channel-option-heading span')), false);
    assert.equal(telegram.querySelector('.channel-account-label')?.textContent, 'FixtureBot');
    assert.equal(Boolean(telegram.querySelector('.channel-account-status')), false);
    assert.doesNotMatch(telegram.textContent ?? '', /Ready for messages/);
    assert.doesNotMatch(
      telegram.textContent ?? '',
      /press Start|send a message|Simple local|Connect your own bot/,
    );
    assert.equal(telegram.querySelector('a')?.getAttribute('href'), 'https://t.me/FixtureBot');
    assert.equal(Boolean(telegram.querySelector('[role="menu"]')), false);
    assert.match(
      whatsapp.querySelector('.channel-option-benefit')?.textContent ?? '',
      /Chat with Otto in WhatsApp\./,
    );
    assert.equal(whatsapp.querySelector('[aria-label="Connect WhatsApp"]'), null);
    assert.equal(whatsapp.querySelector('.channel-coming-soon')?.textContent, 'Coming soon');
    assert.equal(whatsapp.querySelector('button'), null);
    assert.equal(Boolean(container.querySelector('select')), false);
    assert.equal(telegram.querySelector('a')?.textContent, 'Start conversation');
    assert.doesNotMatch(
      container.textContent ?? '',
      /Requires a Meta business app|Manage|Replace setup/,
    );
    const remove = telegram.querySelector<HTMLButtonElement>('[data-channel-remove="telegram"]')!;
    assert.equal(remove.textContent, '');
    assert.equal(remove.getAttribute('aria-label'), 'Remove Telegram channel');
    assert.equal(remove.title, 'Remove channel');
    assert.equal(remove.disabled, false);
    assert.equal(Boolean(telegram.querySelector('[aria-haspopup="menu"]')), false);
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = priorFetch;
  }
});

test('incomplete webhook setup reveals saved instructions without reconnecting or sending', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let disconnected = 0;
  try {
    await act(async () =>
      root.render(
        createElement(ChannelAccount, {
          provider: 'whatsapp',
          setup: {
            provider: 'whatsapp',
            enabled: true,
            mode: 'webhook',
            webhookStatus: 'manual_setup',
            accountName: 'Fixture business',
            accountHandle: '@not-a-telegram-bot',
            webhookUrl: 'https://example.com/api/webhooks/whatsapp',
          },
          configured: true,
          busy: false,
          onDisconnect: () => {
            disconnected++;
          },
        }),
      ),
    );
    assert.equal(Boolean(container.querySelector('[role="menu"]')), false);
    assert.equal(Boolean(container.querySelector('a')), false);
    assert.match(
      container.querySelector('.channel-account-status')?.textContent ?? '',
      /Finish delivery setup/,
    );
    const finish = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Finish setup'),
    )!;
    await act(async () => click(finish));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, 'Finish WhatsApp setup');
    assert.equal(
      dialog.querySelector('code')?.textContent,
      'https://example.com/api/webhooks/whatsapp',
    );
    assert.match(dialog.textContent ?? '', /verification token you saved/);
    assert.doesNotMatch(dialog.textContent ?? '', /Replace setup/);
    assert.equal(disconnected, 0);
    await act(async () => click(dialog.querySelector('[aria-label="Close"]')!));
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
    await act(async () => delay(0));
    assert.equal(document.activeElement?.textContent, 'Finish setup');
    await act(async () => click(container.querySelector('[data-channel-remove="whatsapp"]')!));
    assert.equal(disconnected, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('pending Telegram registration offers saved recovery instructions without Meta guidance', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ChannelAccount, {
          provider: 'telegram',
          setup: {
            provider: 'telegram',
            enabled: true,
            mode: 'webhook',
            webhookStatus: 'registration_pending',
            accountHandle: '@fixture_bot',
          },
          configured: true,
          busy: false,
          onDisconnect: () => assert.fail('No settings should change'),
        }),
      ),
    );
    assert.match(container.textContent ?? '', /Setup needs a retry/);
    assert.equal(Boolean(container.querySelector('a')), false);
    const finish = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Finish setup'),
    )!;
    await act(async () => click(finish));
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /Restart Otto to retry the saved setup/);
    assert.doesNotMatch(dialog.textContent ?? '', /Meta|verification token|replace/i);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
