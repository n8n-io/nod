import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createElement, act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatTurnRail } from '../src/web/components/chat-turn-rail.tsx';
import {
  collapseScreenshotMessages,
  hasVisibleChatActivity,
  messagesAreGrouped,
  visibleConversationTurns,
} from '../src/web/lib/chat-messages.ts';
import type { Message } from '../src/shared/contracts.ts';
import { nextReaction, reactionName } from '../src/web/lib/reactions.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4310',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'NodeFilter',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'HTMLInputElement',
  'HTMLButtonElement',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: class {
    callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback([{ target, intersectionRatio: 1, isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
});
after(() => dom.window.close());
const { createRoot } = await import('react-dom/client');
const { MessageBubble, MessageText } = await import('../src/web/components/message.tsx');
const { MessageAttachments } = await import('../src/web/components/attachment-card.tsx');
const base: Message = {
  id: 'fixture-message',
  role: 'assistant',
  text: '**A helpful reply**',
  taskId: 'fixture-task',
  attachments: [],
  createdAt: '2026-09-25T12:00:00Z',
};

test('adjacent screenshots from one task appear as one gallery', () => {
  const image = (id: string): Message => ({
    ...base,
    id,
    text: `Browser screenshot: ${id}.png`,
    createdAt: `2026-09-25T12:00:0${id === 'one' ? '0' : '1'}Z`,
    attachments: [
      { id, name: `${id}.png`, mimeType: 'image/png', size: 10, url: `/api/artifacts/${id}` },
    ],
  });
  const first = image('one');
  const second = image('two');
  const otherTask = { ...image('three'), taskId: 'another-task' };
  const result = collapseScreenshotMessages([first, second, { ...base, id: 'answer' }, otherTask]);
  assert.equal(result.length, 3);
  assert.equal(result[0].text, '2 screenshots');
  assert.deepEqual(
    result[0].attachments.map((item) => item.name),
    ['one.png', 'two.png'],
  );
  assert.equal(result[1].id, 'answer');
  assert.equal(result[2].id, 'three');
  assert.equal(first.attachments.length, 1);
  const nextDay = { ...image('two'), createdAt: '2026-09-26T12:00:00Z' };
  assert.equal(collapseScreenshotMessages([first, nextDay])[0].attachments.length, 2);
});

function click(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

test('typing activity excludes background and other channel tasks while preserving ordinary user work', () => {
  assert.equal(
    hasVisibleChatActivity([
      { status: 'queued', showTyping: false },
      { status: 'running', showTyping: false },
    ]),
    false,
  );
  assert.equal(hasVisibleChatActivity([{ status: 'running', showTyping: true }]), true);
  assert.equal(hasVisibleChatActivity([{ status: 'queued' }]), true);
  assert.equal(
    hasVisibleChatActivity([
      { status: 'waiting_user', showTyping: true },
      { status: 'succeeded', showTyping: true },
      { status: 'cancelled', showTyping: true },
    ]),
    false,
  );
});

test('message actions reply and copy, inspect the selected assistant message, and have no read-aloud action', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const inspected: unknown[] = [];
  let replies = 0;
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied = value;
      },
    },
  });
  const inspect = (event: Event) => inspected.push((event as CustomEvent).detail);
  window.addEventListener('otto:inspect-message', inspect);
  try {
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: base,
          inspectorEnabled: true,
          onReply: () => {
            replies++;
          },
        }),
      ),
    );
    assert.equal(element.querySelector('[aria-label="Read aloud"]'), null);
    const footer = element.querySelector('.message-footer')!;
    assert.ok(
      element
        .querySelector('.message-tools')!
        .contains(element.querySelector('[aria-label="Copy message"]')),
    );
    assert.equal(footer.contains(element.querySelector('[aria-label="Copy message"]')), false);
    assert.equal(element.querySelector('.message-body')!.contains(footer), false);
    await act(async () => click(element.querySelector('[aria-label="Inspect message"]')!));
    assert.deepEqual(inspected, [{ messageId: base.id, taskId: base.taskId }]);
    await act(async () => click(element.querySelector('[aria-label="Copy message"]')!));
    assert.equal(copied, base.text);
    await act(async () => click(element.querySelector('[aria-label="Reply to message"]')!));
    assert.equal(replies, 1);
    await act(async () => click(element.querySelector('[aria-label="Message options"]')!));
    assert.ok(document.querySelector('[role="menu"]'));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await act(async () =>
      element.querySelector('article')!.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      ),
    );
    const menu = document.querySelector('[role="menu"]')!;
    assert.ok(menu);
    assert.match(menu.textContent ?? '', /Reply/);
    assert.match(menu.textContent ?? '', /Copy/);
    assert.match(menu.textContent ?? '', /Inspect/);
    assert.doesNotMatch(menu.textContent ?? '', /Read aloud/);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(document.querySelector('[role="menu"]'), null);
    await act(async () =>
      root.render(createElement(MessageBubble, { message: base, inspectorEnabled: false })),
    );
    assert.equal(element.querySelector('[aria-label="Inspect message"]'), null);
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: { ...base, role: 'user' },
          inspectorEnabled: true,
        }),
      ),
    );
    assert.equal(element.querySelector('[aria-label="Inspect message"]'), null);
  } finally {
    window.removeEventListener('otto:inspect-message', inspect);
    await act(async () => root.unmount());
    element.remove();
  }
});

test('message options release keyboard navigation when focus leaves the menu', async () => {
  const element = document.createElement('div');
  const input = document.createElement('textarea');
  document.body.append(element, input);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(MessageBubble, { message: base })));
    await act(async () => click(element.querySelector('[aria-label="Message options"]')!));
    assert.ok(document.querySelector('[role="menu"]'));
    await act(async () => input.focus());
    assert.equal(document.querySelector('[role="menu"]'), null);
    const home = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(home));
    assert.equal(home.defaultPrevented, false);
    assert.equal(document.activeElement, input);
    await act(async () => click(element.querySelector('[aria-label="Message options"]')!));
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    input.remove();
  }
});

test('reactions persist through the user endpoint and assistant reactions appear on user messages', async () => {
  const previousFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}');
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(MessageBubble, { message: base })));
    await act(async () =>
      element
        .querySelector('article')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    await act(async () =>
      click(document.querySelector('[role="menuitemradio"][aria-label="red heart"]')!),
    );
    assert.deepEqual(requests, [
      { url: '/api/messages/fixture-message/reaction', body: { reaction: '❤️' } },
    ]);
    assert.ok(element.querySelector('[aria-label="Remove your red heart reaction"]'));
    await act(async () =>
      click(element.querySelector('[aria-label="Remove your red heart reaction"]')!),
    );
    assert.deepEqual(requests.at(-1), {
      url: '/api/messages/fixture-message/reaction',
      body: { reaction: null },
    });
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: { ...base, role: 'user', reactions: [{ actor: 'assistant', reaction: 'like' }] },
        }),
      ),
    );
    assert.ok(element.querySelector('[aria-label="Otto reacted: thumbs up"]'));
    assert.equal(element.querySelector('[aria-label="React to message"]'), null);
  } finally {
    globalThis.fetch = previousFetch;
    await act(async () => root.unmount());
    element.remove();
  }
});

test('Unicode reactions include flags, skin tones and joined sequences while legacy equivalents toggle off', () => {
  assert.equal(nextReaction('like', '👍'), null);
  assert.equal(nextReaction('heart', '❤️'), null);
  for (const value of ['🎉', '🇵🇹', '👍🏽', '👩🏽‍💻']) {
    assert.equal(nextReaction(null, value), value);
    assert.equal(nextReaction(value, value), null);
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message: { ...base, role: 'user', reactions: [{ actor: 'assistant', reaction: value }] },
      }),
    );
    assert.ok(html.includes(value));
    assert.ok(html.includes(`Otto reacted: ${reactionName(value)}`));
  }
});

test('agent badges are labelled, noninteractive and limited to valid user-message reactions', () => {
  const rendered = renderToStaticMarkup(
    createElement(MessageBubble, {
      message: { ...base, role: 'user', reactions: [{ actor: 'assistant', reaction: '🎉' }] },
    }),
  );
  const container = document.createElement('div');
  container.innerHTML = rendered;
  const badge = container.querySelector('[role="img"][aria-label="Otto reacted: party popper"]');
  assert.ok(badge);
  assert.equal(badge.tagName, 'SPAN');
  assert.equal(badge.hasAttribute('tabindex'), false);
  for (const message of [
    { ...base, reactions: [{ actor: 'assistant' as const, reaction: '🎉' }] },
    {
      ...base,
      role: 'user' as const,
      reactions: [{ actor: 'assistant' as const, reaction: 'not an emoji' }],
    },
  ]) {
    assert.equal(
      renderToStaticMarkup(createElement(MessageBubble, { message })).includes('Otto reacted:'),
      false,
    );
  }
});

test('saved message links render bounded plain-text previews and only server-proxied images', async () => {
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  const imageUrl = '/api/link-preview/image/11111111-1111-4111-8111-111111111111';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/link-preview');
    const body = JSON.parse(String(init?.body)) as { url: string };
    requests.push(body.url);
    return new Response(
      JSON.stringify({
        preview: {
          url: body.url,
          title: '<script>Preview title</script>',
          description: '<b>Plain description</b>',
          siteName: 'Example site',
          imageUrl: body.url.includes('first') ? imageUrl : 'https://tracker.example.com/pixel.png',
        },
      }),
    );
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: {
            ...base,
            text: '[First](https://www.example.com/first-preview) [Again](https://www.example.com/first-preview) [Second](https://www.example.com/second-preview) [Third](https://www.example.com/third-preview)',
          },
        }),
      ),
    );
    assert.deepEqual(requests.sort(), [
      'https://www.example.com/first-preview',
      'https://www.example.com/second-preview',
    ]);
    const cards = element.querySelectorAll('.message-link-preview');
    assert.equal(cards.length, 2);
    assert.match(cards[0].textContent ?? '', /Example site/);
    assert.match(cards[0].textContent ?? '', /<script>Preview title<\/script>/);
    assert.match(cards[0].textContent ?? '', /<b>Plain description<\/b>/);
    assert.equal(element.querySelector('script'), null);
    assert.deepEqual(
      [...element.querySelectorAll('.message-link-preview img')].map((image) =>
        image.getAttribute('src'),
      ),
      [imageUrl],
    );
    assert.equal(element.querySelectorAll('.message-text a').length, 4);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('link previews wait until the message is near the viewport and ignore a removed message', async () => {
  const previousObserver = globalThis.IntersectionObserver;
  const priorFetch = globalThis.fetch;
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const requests: string[] = [];
  let disconnected = 0;
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: class {
      constructor(
        callback: (entries: Array<{ isIntersecting: boolean }>) => void,
        options: IntersectionObserverInit,
      ) {
        callbacks.push(callback);
        assert.equal(options.rootMargin, '300px');
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
  });
  globalThis.fetch = async (_url, init) => {
    const url = (JSON.parse(String(init?.body)) as { url: string }).url;
    requests.push(url);
    return new Response(JSON.stringify({ preview: { url, title: 'Loaded nearby' } }));
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: { ...base, text: 'https://www.example.com/nearby' },
        }),
      ),
    );
    assert.deepEqual(requests, []);
    await act(async () => callbacks[0]!([{ isIntersecting: false }]));
    assert.deepEqual(requests, []);
    await act(async () => callbacks[0]!([{ isIntersecting: true }]));
    assert.deepEqual(requests, ['https://www.example.com/nearby']);
    assert.equal(
      element.querySelector('.message-link-preview strong')?.textContent,
      'Loaded nearby',
    );
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: { ...base, text: 'https://www.example.com/removed' },
        }),
      ),
    );
    await act(async () => root.render(null));
    await act(async () => callbacks[1]!([{ isIntersecting: true }]));
    assert.equal(requests.length, 1);
    assert.ok(disconnected >= 3);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: previousObserver,
    });
  }
});

test('secure links, private destinations and streaming fragments do not request previews, and failures retain links', async () => {
  const priorFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push((JSON.parse(String(init?.body)) as { url: string }).url);
    return new Response('{}', { status: 503 });
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    const text =
      '[Vault](/vault/fixture-token) [Approval](/approvals/fixture-token) [Local](http://127.0.0.1/private) [Private](http://192.168.1.2/) [Login](https://example.com/login) [Secret](https://example.com/post?access_token=secret) `https://code.example.com/post`';
    await act(async () =>
      root.render(createElement(MessageBubble, { message: { ...base, text } })),
    );
    assert.deepEqual(requests, []);
    await act(async () =>
      root.render(createElement(MessageText, { text: 'https://www.example.com/stream-only' })),
    );
    assert.deepEqual(requests, []);
    await act(async () =>
      root.render(
        createElement(MessageBubble, {
          message: { ...base, text: 'https://www.example.com/unavailable-preview' },
        }),
      ),
    );
    assert.deepEqual(requests, ['https://www.example.com/unavailable-preview']);
    assert.equal(element.querySelector('.message-link-preview'), null);
    assert.equal(
      element.querySelector('a')?.getAttribute('href'),
      'https://www.example.com/unavailable-preview',
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
  }
});

test('published screenshot artifacts use the ordinary local image attachment', () => {
  const url = '/api/artifacts/22222222-2222-4222-8222-222222222222';
  const html = renderToStaticMarkup(
    createElement(MessageAttachments, {
      attachments: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 1234,
          url,
        },
      ],
    }),
  );
  assert.ok(html.includes(`src="${url}"`));
  assert.match(html, /aria-label="View image 1 of 1"/);
  assert.doesNotMatch(html, /https?:/);
});

test('reactions start with a keyboard-native strip and load the nonmodal searchable catalog only through More', async () => {
  const priorFetch = globalThis.fetch;
  const dimensions = ['clientHeight', 'clientWidth'] as const;
  const descriptors = dimensions.map((key) =>
    Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, key),
  );
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 36,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 324,
  });
  const requests: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{}');
  };
  const element = document.createElement('div');
  element.className = 'messages';
  element.getBoundingClientRect = () => new dom.window.DOMRect(208, 0, 800, 720);
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(MessageBubble, { message: base })));
    element.querySelector('.message-content')!.getBoundingClientRect = () =>
      new dom.window.DOMRect(280, 100, 700, 100);
    element.querySelector('[aria-label="React to message"]')!.getBoundingClientRect = () =>
      new dom.window.DOMRect(417, 200, 28, 28);
    assert.equal(document.querySelector('.EmojiPickerReact'), null);
    await act(async () => click(element.querySelector('[aria-label="React to message"]')!));
    for (let i = 0; i < 30 && !document.querySelector('.chat-reaction-strip'); i++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const strip = document.querySelector('.chat-reaction-strip')!;
    assert.ok(strip);
    assert.equal(strip.querySelectorAll('button').length, 7);
    assert.equal(strip.querySelectorAll('[aria-pressed]').length, 6);
    assert.equal(strip.querySelectorAll('[tabindex="0"]').length, 1);
    assert.equal(document.querySelector('.EmojiPickerReact'), null);
    assert.equal(document.querySelector('.chat-emoji-heading'), null);
    assert.equal(document.querySelector<HTMLElement>('.chat-emoji-popover')!.style.left, '280px');
    assert.equal(document.activeElement, strip.querySelector('[aria-label="thumbs up"]'));
    for (const [key, label] of [
      ['ArrowRight', 'red heart'],
      ['End', 'More emoji'],
      ['Home', 'thumbs up'],
      ['ArrowLeft', 'More emoji'],
    ]) {
      await act(async () =>
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })),
      );
      assert.equal(document.activeElement?.getAttribute('aria-label'), label);
    }
    await act(async () => click(strip.querySelector('[aria-label="More emoji"]')!));
    for (let i = 0; i < 30 && !document.querySelector('.EmojiPickerReact'); i++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const picker = document.querySelector('.EmojiPickerReact')!;
    assert.ok(picker);
    assert.equal(document.querySelector('.dialog-overlay'), null);
    assert.equal(
      document.querySelector('.chat-emoji-popover')?.getAttribute('aria-modal'),
      'false',
    );
    const search = picker.querySelector<HTMLInputElement>(
      '[aria-label="Type to search for an emoji"]',
    )!;
    assert.ok(search);
    assert.ok(picker.querySelector('[aria-label="Flags"]'));
    assert.ok(picker.querySelector('[aria-label="Animals and nature"]'));
    assert.ok(picker.querySelector('[aria-label^="Skin tone"]'));
    assert.equal(picker.querySelector('img'), null);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'party popper',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const emoji = picker.querySelector<HTMLButtonElement>('button[data-unified="1f389"]')!;
    assert.ok(emoji);
    assert.match(emoji.getAttribute('aria-label') ?? '', /party/i);
    await act(async () => click(emoji));
    assert.deepEqual(requests, [
      { url: '/api/messages/fixture-message/reaction', body: { reaction: '🎉' } },
    ]);
    assert.ok(element.querySelector('[aria-label="Remove your party popper reaction"]'));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const trigger = element.querySelector<HTMLButtonElement>('[aria-label="React to message"]')!;
    assert.equal(document.activeElement, trigger);
    await act(async () => click(trigger));
    assert.ok(document.querySelector('.chat-emoji-popover'));
    assert.equal(document.querySelector('.EmojiPickerReact'), null);
    const selected = document.querySelector<HTMLButtonElement>(
      '.chat-reaction-strip [aria-label="party popper"]',
    )!;
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, selected);
    await act(async () => click(selected));
    assert.deepEqual(requests.at(-1), {
      url: '/api/messages/fixture-message/reaction',
      body: { reaction: null },
    });
    assert.equal(element.querySelector('.selected-reaction'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => click(trigger));
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    assert.equal(document.querySelector('.chat-emoji-popover'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => click(trigger));
    assert.ok(document.querySelector('.chat-emoji-popover'));
    await act(async () => click(trigger));
    assert.equal(document.querySelector('.chat-emoji-popover'), null);
    await act(async () => click(trigger));
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    assert.equal(document.querySelector('.chat-emoji-popover'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    globalThis.fetch = priorFetch;
    dimensions.forEach((key, index) => {
      if (descriptors[index])
        Object.defineProperty(dom.window.HTMLElement.prototype, key, descriptors[index]!);
      else Reflect.deleteProperty(dom.window.HTMLElement.prototype, key);
    });
  }
});

test('message replies render a safe quote and timestamps group only adjacent messages from the same sender', () => {
  const quoted = {
    ...base,
    replyToMessageId: 'quoted',
    replyTo: { id: 'quoted', role: 'user' as const, text: '<script>private()</script>' },
  };
  const html = renderToStaticMarkup(
    createElement(MessageBubble, { message: quoted, showTimestamp: false, grouped: true }),
  );
  assert.match(html, /message-reply-quote/);
  assert.match(html, /&lt;script&gt;private\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<time/);
  assert.equal(
    messagesAreGrouped(base, { ...base, id: 'next', createdAt: '2026-09-25T12:04:00Z' }),
    true,
  );
  assert.equal(messagesAreGrouped(base, { ...base, role: 'user' }), false);
  assert.equal(messagesAreGrouped(base, { ...base, createdAt: '2026-09-25T12:05:00Z' }), false);
  assert.equal(messagesAreGrouped(base, quoted), false);
  assert.equal(messagesAreGrouped(undefined, base), false);
});

test('user timestamps stay inside their bubble while assistant timestamps remain below the reply', () => {
  for (const role of ['user', 'assistant'] as const) {
    const document = new JSDOM(
      renderToStaticMarkup(createElement(MessageBubble, { message: { ...base, role } })),
    ).window.document;
    const time = document.querySelector('time')!;
    assert.equal(time.getAttribute('datetime'), base.createdAt);
    assert.equal(Boolean(time.closest('.message-body')), role === 'user');
    assert.equal(Boolean(time.closest('.message-footer')), role === 'assistant');
    assert.equal(document.querySelectorAll('time').length, 1);
    document.defaultView?.close();
  }
});

test('chat styles keep user content left aligned and remove the editor native focus ring', async () => {
  const style = document.createElement('style');
  style.textContent =
    ':focus-visible { outline: 2px solid magenta; box-shadow: 0 0 0 2px magenta; } .message-actions { opacity: 1; } .with-inspector .conversation-column { padding-inline: 12px; }\n' +
    (await readFile(new URL('../src/web/pages/chat.css', import.meta.url), 'utf8'));
  document.head.append(style);
  const container = document.createElement('div');
  container.className = 'chat-page with-inspector';
  container.innerHTML =
    '<div class="conversation-scroll"><div class="conversation-column"><article class="message message-user"><div class="message-content"><div class="message-body">Text</div><div class="message-actions">Actions</div></div></article></div></div><form class="composer"><div class="composer-editor" contenteditable="true" tabindex="0">Draft</div></form>';
  document.body.append(container);
  try {
    const editor = container.querySelector<HTMLElement>('.composer-editor')!;
    editor.focus();
    assert.equal(dom.window.getComputedStyle(editor).outline, 'none');
    assert.equal(dom.window.getComputedStyle(editor).boxShadow, 'none');
    assert.equal(
      dom.window.getComputedStyle(container.querySelector('.message-actions')!).opacity,
      '0',
    );
    assert.equal(
      dom.window.getComputedStyle(container.querySelector('.conversation-column')!).paddingLeft,
      '32px',
    );
    assert.equal(
      dom.window.getComputedStyle(container.querySelector('.message-body')!).textAlign,
      'left',
    );
    assert.equal(
      dom.window.getComputedStyle(container.querySelector('.message-content')!).alignItems,
      'flex-end',
    );
  } finally {
    container.remove();
    style.remove();
  }
});

test('message actions follow hover and keyboard focus, and narrow chat hides the turn rail', async () => {
  const styles = [
    await readFile(new URL('../src/web/pages/chat.css', import.meta.url), 'utf8'),
    await readFile(new URL('../src/web/styles.css', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(styles, /\.message:focus-within/);
  assert.doesNotMatch(styles, /pointer: coarse\)\s*\{[^}]*message-more-action/);
  assert.match(styles, /\.chat-page \.message:has\(:focus-visible\) \.message-actions/);
  const start = styles.indexOf('{', styles.indexOf('@container (max-width: 640px)'));
  let end = start;
  for (let depth = 0; end < styles.length; end++) {
    if (styles[end] === '{') depth++;
    if (styles[end] === '}' && --depth === 0) break;
  }
  assert.match(styles.slice(start, end), /\.chat-turn-rail \{\s*display: none;/);
  assert.doesNotMatch(
    styles.slice(0, start) + styles.slice(end),
    /\.chat-turn-rail \{[^}]*display: none;/,
  );
});

test('touch selects one message for actions, and moving focus or an outside press clears the selection', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        createElement('div', {}, [
          createElement(MessageBubble, { key: 'first', message: base }),
          createElement(MessageBubble, {
            key: 'second',
            message: { ...base, id: 'second-message' },
          }),
        ]),
      ),
    );
    const articles = element.querySelectorAll('article');
    const touch = (article: Element) => {
      const event = new Event('pointerup', { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      article.dispatchEvent(event);
    };
    assert.equal(element.querySelector('.message-selected'), null);
    await act(async () => touch(articles[0]));
    assert.equal(articles[0].classList.contains('message-selected'), true);
    await act(async () => touch(articles[1]));
    assert.equal(articles[0].classList.contains('message-selected'), false);
    assert.equal(articles[1].classList.contains('message-selected'), true);
    await act(async () => {
      articles[1].dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    assert.equal(articles[1].classList.contains('message-selected'), true);
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    assert.equal(element.querySelector('.message-selected'), null);
    const mouse = new Event('pointerup', { bubbles: true });
    Object.defineProperty(mouse, 'pointerType', { value: 'mouse' });
    await act(async () => articles[0].dispatchEvent(mouse));
    assert.equal(element.querySelector('.message-selected'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('conversation rail navigates only user turns with an accessible active state and safe hover preview', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const jumped: string[] = [];
  const messages: Message[] = [
    {
      ...base,
      id: 'first-user',
      role: 'user',
      text: '<img src="https://tracking.example"> First question',
    },
    base,
    {
      ...base,
      id: 'second-user',
      role: 'user',
      text: 'Second question',
      createdAt: '2026-09-25T12:05:00Z',
    },
  ];
  try {
    await act(async () =>
      root.render(
        createElement(ChatTurnRail, {
          messages,
          activeId: 'second-user',
          visibleIds: ['first-user', 'second-user'],
          onJump: (id) => jumped.push(id),
        }),
      ),
    );
    const buttons = Array.from(element.querySelectorAll('button'));
    assert.equal(buttons.length, 2);
    assert.equal(buttons[1].getAttribute('aria-current'), 'location');
    assert.equal(buttons[1].tabIndex, 0);
    assert.equal(buttons[0].tabIndex, -1);
    assert.equal(element.querySelectorAll('.is-visible').length, 2);
    assert.match(buttons[0].getAttribute('aria-label') ?? '', /Your message/);
    await act(async () => buttons[0].focus());
    const preview = document.querySelector('[role="tooltip"]')!;
    assert.match(preview.textContent ?? '', /First question/);
    assert.ok(preview.querySelector('time'));
    assert.equal(preview.querySelector('img'), null);
    await act(async () => click(buttons[0]));
    assert.deepEqual(jumped, ['first-user']);
    assert.equal(document.querySelector('[role="tooltip"]'), null);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('a long turn rail stays one keyboard stop and supports arrow, endpoint and Escape navigation', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const jumped: string[] = [];
  const messages = Array.from({ length: 100 }, (_, index): Message => ({
    ...base,
    id: `user-${index}`,
    role: 'user',
    text: `Question ${index}`,
  }));
  try {
    await act(async () =>
      root.render(
        createElement(ChatTurnRail, {
          messages,
          activeId: 'user-50',
          onJump: (id) => jumped.push(id),
        }),
      ),
    );
    const buttons = Array.from(element.querySelectorAll('button'));
    assert.equal(buttons.length, 100);
    assert.deepEqual(
      buttons.filter((button) => button.tabIndex === 0),
      [buttons[50]],
    );
    await act(async () => buttons[50].focus());
    const key = async (value: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
        );
      });
    await key('ArrowDown');
    assert.equal(document.activeElement, buttons[51]);
    await key('Home');
    assert.equal(document.activeElement, buttons[0]);
    await key('ArrowUp');
    assert.equal(document.activeElement, buttons[0]);
    await key('End');
    assert.equal(document.activeElement, buttons[99]);
    assert.deepEqual(
      buttons.filter((button) => button.tabIndex === 0),
      [buttons[99]],
    );
    assert.ok(document.querySelector('[role="tooltip"]'));
    await key('Escape');
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    assert.equal(document.activeElement, buttons[99]);
    await act(async () => click(buttons[99]));
    assert.deepEqual(jumped, ['user-99']);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

test('the rail highlights all turn sections that intersect the visible conversation', () => {
  const turns = [
    { id: 'one', top: 0 },
    { id: 'two', top: 150 },
    { id: 'three', top: 400 },
    { id: 'four', top: 800 },
  ];
  assert.deepEqual(visibleConversationTurns(turns, { top: 100, bottom: 500 }), [
    'one',
    'two',
    'three',
  ]);
  assert.deepEqual(visibleConversationTurns(turns, { top: 400, bottom: 800 }), ['three']);
  assert.deepEqual(visibleConversationTurns(turns, { top: 900, bottom: 1200 }), ['four']);
  assert.deepEqual(visibleConversationTurns(turns, { top: -100, bottom: 0 }), []);
  assert.deepEqual(visibleConversationTurns([], { top: 0, bottom: 500 }), []);
});
