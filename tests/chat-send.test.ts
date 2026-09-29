import type { Editor } from '@tiptap/core';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { act, createElement, Profiler } from 'react';
import type { AppState, Artifact, Message } from '../src/shared/contracts.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default undefined', shortCircuit: true }
      : next(url, context);
  },
});
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
  'Text',
  'ShadowRoot',
  'DOMParser',
  'MutationObserver',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'CustomEvent',
  'File',
  'FormData',
  'Blob',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const rect = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};
dom.window.Range.prototype.getBoundingClientRect = () => rect;
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
class Events {
  static current: Events;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Events.current = this;
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Events });
after(() => {
  dom.window.close();
  css.deregister();
});
const { createRoot } = await import('react-dom/client');
const { useAppState } = await import('../src/web/hooks/use-app-state.ts');
const { sessionStore } = await import('../src/web/lib/session.ts');
const { Chat } = await import('../src/web/pages/chat.tsx');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
const message: Message = {
  id: 'old-message',
  role: 'assistant',
  text: 'Which draft should I review?',
  taskId: 'old-task',
  attachments: [],
  createdAt: '2026-09-25T12:00:00Z',
};
const base: AppState = {
  conversationRevision: 0,
  messages: [message],
  tasks: [],
  configuration: {
    provider: 'fixture',
    model: 'fixture',
    llmReady: true,
    speechReady: false,
    integrationsReady: true,
    browserAssistReady: false,
    inspectorEnabled: true,
    localOnly: true,
  },
};

async function mount(onCommit: () => void = () => {}) {
  const request = globalThis.fetch;
  globalThis.fetch = async (path, options) =>
    path === '/api/session'
      ? Response.json({
          auth: { mode: 'local', googleAvailable: false },
          user: { id: 'fixture-owner', name: 'Alex Example', email: null, avatarUrl: null },
          settings: { theme: 'system', onboardingCompleted: true },
          capabilities: { developer: false },
        })
      : request(path, options);
  sessionStore.invalidate();
  await sessionStore.refresh();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let app!: ReturnType<typeof useAppState>;
  function Fixture() {
    app = useAppState();
    return app.state
      ? createElement(
          Profiler,
          { id: 'chat', onRender: onCommit },
          createElement(Chat, {
            state: app.state,
            streams: app.streams,
            refresh: app.refresh,
            resetConversation: app.resetConversation,
          }),
        )
      : null;
  }
  await act(async () => {
    root.render(createElement(Fixture));
    await tick();
  });
  return {
    element,
    app: () => app,
    dispose: async () => {
      await act(async () => root.unmount());
      element.remove();
      sessionStore.invalidate();
      globalThis.fetch = request;
    },
  };
}

type Submission = {
  clientMessageId: string;
  conversationRevision: number;
  text: string;
  attachmentIds: string[];
  replyToMessageId?: string;
  verificationRequestId?: string;
};
const image: Artifact = {
  id: '9e7954ee-aa28-49c4-a9fc-7cdc1f5d5bea',
  name: 'fixture.png',
  mimeType: 'image/png',
  size: 7,
  url: '/api/artifacts/9e7954ee-aa28-49c4-a9fc-7cdc1f5d5bea',
};
const sendKey = (element: Element) =>
  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
async function draft(text: string) {
  await act(async () => {
    const input = document.querySelector<HTMLElement>('[role="textbox"]')!;
    (input as HTMLElement & { editor: Editor }).editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
    });
    await tick();
  });
}

test('a real runtime reply stays visible while persistence is pending and retains its bubble after refresh', async () => {
  const previousFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'otto-chat-stream-'));
  let current = base;
  globalThis.fetch = async (path) => {
    assert.equal(path, '/api/state');
    return Response.json(current);
  };
  let finishModel!: () => void;
  const modelContinues = new Promise<void>((resolve) => {
    finishModel = resolve;
  });
  let allowPersistence!: () => void;
  const persistenceContinues = new Promise<void>((resolve) => {
    allowPersistence = resolve;
  });
  let streamed!: () => void;
  const firstText = new Promise<void>((resolve) => {
    streamed = resolve;
  });
  let saving!: () => void;
  const savingStarted = new Promise<void>((resolve) => {
    saving = resolve;
  });
  const text = 'The fixture result is ready.';
  const runtime = createAgentRuntime({
    agent: {
      open: async ({ onEvent }) => ({
        resumed: false,
        prompt: async () => {
          onEvent({ type: 'message_start' });
          onEvent({ type: 'text_delta', text });
          streamed();
          await modelContinues;
          onEvent({ type: 'final', text });
          onEvent({ type: 'message_end', status: 'succeeded' });
        },
        abort() {},
        dispose() {},
      }),
      dispose() {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  const fixture = await mount();
  let running: ReturnType<typeof runtime.runTask> | undefined;
  try {
    await act(async () => {
      running = runtime.runTask({
        taskId: 'stream-fixture',
        ownerId: 'fixture-owner',
        prompt: 'Show the result.',
        history: [],
        memories: [],
        attachments: [],
        workspacePath: directory,
        signal: new AbortController().signal,
        emit: async () => {},
        remember: async () => {},
        publish: async () => {
          throw new Error('Unexpected publication');
        },
        requestCredential: async () => {
          throw new Error('Unexpected credential request');
        },
        integration: async () => ({}),
        manage: async () => ({}),
        delta: (value, streamId, done) =>
          Events.current.emit({
            type: 'delta',
            taskId: 'stream-fixture',
            text: value,
            streamId,
            done,
            conversationRevision: 0,
          }),
        reply: async (value, streamId) => {
          saving();
          await persistenceContinues;
          current = {
            ...base,
            messages: [
              ...base.messages,
              {
                id: 'persisted-reply',
                taskId: 'stream-fixture',
                role: 'assistant',
                text: value,
                streamId,
                attachments: [],
                createdAt: new Date().toISOString(),
              },
            ],
          };
          Events.current.emit({ type: 'refresh' });
        },
      });
      await firstText;
      await tick();
    });
    const bubble = fixture.element.querySelector('.streaming-message');
    assert.ok(bubble);
    assert.match(bubble.textContent ?? '', /The fixture result is ready/);
    await act(async () => {
      finishModel();
      await savingStarted;
      await tick();
    });
    assert.equal(
      bubble.isConnected,
      true,
      'The visible reply must not disappear before it is saved',
    );
    assert.match(fixture.element.textContent ?? '', /The fixture result is ready/);
    await act(async () => {
      allowPersistence();
      await running;
      await tick();
    });
    assert.equal(fixture.element.querySelector('[data-message-id="persisted-reply"]'), bubble);
    assert.equal(fixture.element.querySelectorAll('.message-assistant').length, 2);
  } finally {
    await act(async () => {
      finishModel();
      allowPersistence();
      await running;
    });
    await fixture.dispose();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
  }
});

test('sending keeps the existing conversation mounted and scrolls the new bubble before paint', async () => {
  const previousFetch = globalThis.fetch;
  const previousScroll = dom.window.HTMLElement.prototype.scrollIntoView;
  let scrolledMessages = 0;
  const unpositionedCommits: number[] = [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {
    scrolledMessages = document.querySelectorAll('.message-user').length;
  };
  let finish!: (response: Response) => void;
  let sent!: Submission;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(base);
    if (path === '/api/messages') {
      sent = JSON.parse(String(init?.body));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount(() => {
    const messages = document.querySelectorAll('.message-user').length;
    if (messages > scrolledMessages) unpositionedCommits.push(messages);
  });
  try {
    const existing = fixture.element.querySelector('.message-assistant');
    const composer = fixture.element.querySelector('[role="textbox"]');
    const literal = '<label> & **plain**';
    await draft(literal);
    assert.equal(composer?.textContent, literal);
    assert.equal(composer?.querySelector('label, strong'), null);
    await act(async () => {
      sendKey(composer!);
      await tick();
    });
    assert.deepEqual(
      unpositionedCommits,
      [],
      'The new message should be positioned before a frame can paint',
    );
    assert.equal(
      fixture.element.querySelector('.message-user .message-text')?.textContent,
      literal,
    );
    assert.equal(fixture.element.querySelector('.message-assistant'), existing);
    assert.equal(fixture.element.querySelector('[role="textbox"]'), composer);
    await act(async () => {
      finish(
        Response.json({
          taskId: 'accepted-task',
          messageId: sent.clientMessageId,
          continued: false,
        }),
      );
      await tick();
    });
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
    dom.window.HTMLElement.prototype.scrollIntoView = previousScroll;
  }
});

test('a cancelled task discards its unfinished stream even when cancellation fences the final delta', async () => {
  const previousFetch = globalThis.fetch;
  let current: AppState = {
    ...base,
    tasks: [
      {
        id: 'cancelled-task',
        title: 'Fixture',
        status: 'running',
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      },
    ],
  };
  globalThis.fetch = async () => Response.json(current);
  const fixture = await mount();
  try {
    await act(async () => {
      Events.current.emit({
        type: 'delta',
        taskId: 'cancelled-task',
        streamId: 'unfinished',
        text: 'An unfinished response.',
        conversationRevision: 0,
      });
    });
    assert.match(fixture.element.textContent ?? '', /An unfinished response/);
    current = {
      ...current,
      tasks: current.tasks.map((task) => ({ ...task, status: 'cancelled' })),
    };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    assert.doesNotMatch(fixture.element.textContent ?? '', /An unfinished response/);
    await act(async () =>
      Events.current.emit({
        type: 'delta',
        taskId: 'cancelled-task',
        streamId: 'unfinished',
        text: 'Late.',
        conversationRevision: 0,
      }),
    );
    assert.equal(fixture.element.querySelector('.streaming-message'), null);
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
  }
});

test('a user bubble appears before routing completes and reconciles SSE then response once while preserving focus and a new draft', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  const submissions: Submission[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('Research a small weekend trip.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions.length, 1);
    const sent = submissions[0];
    assert.match(sent.clientMessageId, /^[a-f0-9-]{36}$/);
    assert.equal(sent.conversationRevision, 0);
    const bubble = fixture.element.querySelector(`[data-message-id="${sent.clientMessageId}"]`)!;
    assert.match(bubble.textContent ?? '', /Research a small weekend trip/);
    assert.equal(bubble.querySelector('[aria-label="Reply to message"]'), null);
    assert.equal(input.textContent, '');
    assert.equal(document.activeElement, input);
    await draft('A follow-up draft');
    await act(async () => {
      sendKey(input);
      sendKey(input);
    });
    assert.equal(submissions.length, 1);
    const accepted: Message = {
      id: sent.clientMessageId,
      role: 'user',
      text: sent.text,
      attachments: [],
      taskId: 'accepted-task',
      createdAt: new Date().toISOString(),
    };
    current = { ...base, messages: [message, accepted] };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    await act(async () => {
      finish(Response.json({ taskId: accepted.taskId, messageId: accepted.id, continued: false }));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, 'A follow-up draft');
    assert.equal(document.activeElement, input);
    assert.equal(fixture.element.querySelector('[aria-label="Sending message"]'), null);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('failed sends restore reply and attachment drafts and retry the same message ID without a second upload', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  const submissions: Submission[] = [];
  let uploads = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/uploads') {
      uploads++;
      return Response.json(image);
    }
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await act(async () =>
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!.click(),
    );
    await draft('Review this image.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    const upload = fixture.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(upload, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })],
    });
    await act(async () => {
      upload.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.deepEqual(submissions[0].attachmentIds, [image.id]);
    assert.equal(submissions[0].replyToMessageId, message.id);
    const bubble = fixture.element.querySelector('.message-user')!;
    assert.match(
      bubble.querySelector('blockquote')?.textContent ?? '',
      /Which draft should I review/,
    );
    assert.equal(bubble.querySelector('img')?.getAttribute('src'), image.url);
    await act(async () => {
      finish(Response.json({ error: 'The message could not be sent.' }, { status: 503 }));
      await tick();
    });
    assert.equal(fixture.element.querySelector('.message-user'), null);
    assert.equal(input.textContent, 'Review this image.');
    assert.match(fixture.element.textContent ?? '', /Replying to/);
    assert.ok(fixture.element.querySelector('.composer-wrap img'));
    assert.equal(document.activeElement, input);
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1], submissions[0]);
    assert.equal(uploads, 1);
    const accepted: Message = {
      id: submissions[1].clientMessageId,
      role: 'user',
      text: submissions[1].text,
      attachments: [image],
      taskId: 'accepted-task',
      createdAt: new Date().toISOString(),
      replyToMessageId: message.id,
      replyTo: { id: message.id, role: message.role, text: message.text },
    };
    await act(async () => {
      finish(Response.json({ taskId: accepted.taskId, messageId: accepted.id, continued: true }));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, '');
    current = { ...base, messages: [message, accepted] };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.doesNotMatch(fixture.element.textContent ?? '', /Replying to|message could not be sent/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('reset fences an optimistic send and its late failure cannot restore the old draft or reply into onboarding', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  let finish!: (response: Response) => void;
  let submissions = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submissions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    if (path === '/api/conversation/reset') {
      current = { ...base, conversationRevision: 1, messages: [] };
      return Response.json({ ok: true, conversationRevision: 1 });
    }
    if (path === '/api/onboarding') return Response.json({});
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('This belongs to the old generation.');
    await act(async () => {
      sendKey(fixture.element.querySelector('[role="textbox"]')!);
      await tick();
    });
    assert.match(
      fixture.element.querySelector('.message-user')?.textContent ?? '',
      /old generation/,
    );
    await act(async () => {
      window.dispatchEvent(new CustomEvent('otto:restart-setup'));
      await tick();
    });
    assert.equal(fixture.element.querySelector('.message-user'), null);
    await draft('Fresh draft');
    await act(async () => {
      finish(Response.json({ error: 'Stale request failed.' }, { status: 409 }));
      await tick();
    });
    assert.equal(submissions, 1);
    assert.equal(fixture.element.querySelector('[role="textbox"]')?.textContent, 'Fresh draft');
    assert.doesNotMatch(fixture.element.textContent ?? '', /old generation|Stale request failed/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('persisted acceptance prevents restoring a duplicate draft when the HTTP response is lost', async () => {
  const priorFetch = globalThis.fetch;
  let current = base;
  let submitted!: Submission;
  let loseResponse!: (cause: Error) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submitted = JSON.parse(String(init?.body));
      return new Promise((_resolve, reject) => {
        loseResponse = reject;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('A message accepted before disconnection.');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      sendKey(input);
      await tick();
    });
    current = {
      ...base,
      messages: [
        message,
        {
          id: submitted.clientMessageId,
          taskId: 'accepted-task',
          role: 'user',
          text: submitted.text,
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    await act(async () => {
      loseResponse(new Error('Response connection lost.'));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, '');
    assert.doesNotMatch(fixture.element.textContent ?? '', /Response connection lost/);
    assert.equal(document.activeElement, input);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

const verificationRequest = {
  id: '5c301e08-cf53-4b53-94e4-56fcba13eec7',
  taskId: message.taskId!,
  expiresAt: '2099-01-01T00:00:00Z',
};
const verificationState: AppState = { ...base, verificationRequests: [verificationRequest] };

for (const verificationStatus of ['pending', 'submitted'] as const)
  test(`verification ${verificationStatus} replies stay masked and use canonical text when refresh fails`, async () => {
    const priorFetch = globalThis.fetch;
    let submitted!: Submission;
    let finish!: (response: Response) => void;
    let reads = 0;
    globalThis.fetch = async (path, init) => {
      if (path === '/api/state') {
        if (reads++) throw new Error('State refresh unavailable.');
        return Response.json(verificationState);
      }
      if (path === '/api/messages') {
        submitted = JSON.parse(String(init?.body));
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      throw new Error('Unexpected fixture request');
    };
    const fixture = await mount();
    try {
      await draft('483729');
      const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
      await act(async () => {
        sendKey(input);
        await tick();
      });
      assert.equal(submitted.text, '483729');
      assert.equal(submitted.verificationRequestId, verificationRequest.id);
      assert.equal(input.textContent, '');
      assert.doesNotMatch(fixture.element.innerHTML, /483729/);
      assert.match(
        fixture.element.querySelector('.message-user')?.textContent ?? '',
        /Verification code sent securely/,
      );
      await draft('A new draft');
      await act(async () => {
        finish(
          Response.json({
            taskId: verificationRequest.taskId,
            messageId: submitted.clientMessageId,
            continued: true,
            messageText: 'Verification code received securely.',
            verificationStatus,
          }),
        );
        await tick();
      });
      assert.match(
        fixture.element.querySelector('.message-user')?.textContent ?? '',
        /Verification code received securely/,
      );
      assert.doesNotMatch(fixture.element.innerHTML, /483729/);
      assert.equal(input.textContent, 'A new draft');
      assert.equal(document.activeElement, input);
    } finally {
      await fixture.dispose();
      globalThis.fetch = priorFetch;
    }
  });

test('a persisted masked verification reply survives a lost HTTP response without restoring the code', async () => {
  const priorFetch = globalThis.fetch;
  let current = verificationState;
  let submitted!: Submission;
  let reject!: (cause: Error) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(current);
    if (path === '/api/messages') {
      submitted = JSON.parse(String(init?.body));
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('483729');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
    current = {
      ...base,
      messages: [
        message,
        {
          id: submitted.clientMessageId,
          taskId: verificationRequest.taskId,
          role: 'user',
          text: 'Verification code sent securely.',
          attachments: [],
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await act(async () => {
      Events.current.emit({ type: 'refresh' });
      await tick();
    });
    await act(async () => {
      reject(new Error('Transport rejected 483729'));
      await tick();
    });
    assert.equal(fixture.element.querySelectorAll('.message-user').length, 1);
    assert.equal(input.textContent, '');
    assert.doesNotMatch(fixture.element.innerHTML, /483729|Transport rejected/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('private verification failures discard codes and retries use a new message identity', async () => {
  const priorFetch = globalThis.fetch;
  const submissions: Submission[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(verificationState);
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      throw new Error('Transport rejected 483729');
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    for (let index = 0; index < 2; index++) {
      await draft('483729');
      await act(async () => {
        sendKey(input);
        await tick();
      });
      assert.equal(input.textContent, '');
      assert.equal(fixture.element.querySelector('.message-user'), null);
      assert.doesNotMatch(fixture.element.innerHTML, /483729|Transport rejected/);
      assert.match(fixture.element.textContent ?? '', /code could not be confirmed/i);
    }
    assert.notEqual(submissions[0].clientMessageId, submissions[1].clientMessageId);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('an explicit reply selects its verification request while ambiguous codes stay private', async () => {
  const priorFetch = globalThis.fetch;
  const otherRequest = {
    ...verificationRequest,
    id: 'cd2e9b95-1e0d-484a-8202-ff16e0154ad9',
    taskId: 'other-task',
  };
  const submissions: Submission[] = [];
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state')
      return Response.json({ ...base, verificationRequests: [otherRequest, verificationRequest] });
    if (path === '/api/messages') {
      const sent: Submission = JSON.parse(String(init?.body));
      submissions.push(sent);
      return sent.verificationRequestId
        ? Response.json({
            taskId: message.taskId,
            messageId: sent.clientMessageId,
            continued: true,
            messageText: 'Verification code sent securely.',
            verificationStatus: 'submitted',
          })
        : Response.json(
            {
              error:
                'More than one sign-in needs a code. Reply to the verification request you want to complete.',
            },
            { status: 409 },
          );
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    await draft('483729');
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions[0].verificationRequestId, undefined);
    assert.equal(input.textContent, '');
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
    assert.match(fixture.element.textContent ?? '', /More than one sign-in needs a code/);
    await act(async () =>
      fixture.element.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!.click(),
    );
    await draft('483729');
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions[1].verificationRequestId, verificationRequest.id);
    assert.equal(submissions[1].replyToMessageId, message.id);
    assert.equal(input.textContent, '');
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('ordinary numeric messages preserve normal drafts when no matching unexpired verification is pending', async () => {
  const priorFetch = globalThis.fetch;
  const states: Array<{ state: AppState; reply?: boolean }> = [
    { state: base },
    {
      state: {
        ...base,
        verificationRequests: [{ ...verificationRequest, expiresAt: '2020-01-01T00:00:00Z' }],
      },
    },
    {
      state: { ...base, verificationRequests: [{ ...verificationRequest, taskId: 'other-task' }] },
      reply: true,
    },
  ];
  try {
    for (const entry of states) {
      const submissions: Submission[] = [];
      globalThis.fetch = async (path, init) => {
        if (path === '/api/state') return Response.json(entry.state);
        if (path === '/api/messages') {
          submissions.push(JSON.parse(String(init?.body)));
          return Response.json({ error: 'Message not sent.' }, { status: 503 });
        }
        throw new Error('Unexpected fixture request');
      };
      const fixture = await mount();
      try {
        if (entry.reply)
          await act(async () =>
            fixture.element
              .querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!
              .click(),
          );
        await draft('483729');
        const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
        await act(async () => {
          sendKey(input);
          await tick();
        });
        assert.equal(submissions[0].verificationRequestId, undefined);
        assert.equal(input.textContent, '483729');
        assert.match(fixture.element.textContent ?? '', /Message not sent/);
        await act(async () => {
          sendKey(input);
          await tick();
        });
        assert.equal(submissions[0].clientMessageId, submissions[1].clientMessageId);
      } finally {
        await fixture.dispose();
      }
    }
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('verification with an attachment stays private through a rejected submission', async () => {
  const priorFetch = globalThis.fetch;
  const submissions: Submission[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(verificationState);
    if (path === '/api/uploads') return Response.json(image);
    if (path === '/api/messages') {
      submissions.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    await draft('483729');
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    const upload = fixture.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(upload, 'files', {
      value: [new File(['fixture'], 'fixture.png', { type: 'image/png' })],
    });
    await act(async () => {
      upload.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      sendKey(input);
      await tick();
    });
    assert.equal(submissions[0].verificationRequestId, verificationRequest.id);
    assert.deepEqual(submissions[0].attachmentIds, [image.id]);
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
    await act(async () => {
      finish(Response.json({ error: 'Send the code by itself.' }, { status: 409 }));
      await tick();
    });
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
    assert.equal(input.textContent, '');
    assert.equal(
      fixture.element.querySelector('.composer-wrap img')?.getAttribute('src'),
      image.url,
    );
    assert.match(fixture.element.textContent ?? '', /without attachments/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('a late verification rejection preserves new draft text and combines both attachment drafts', async () => {
  const priorFetch = globalThis.fetch;
  const nextImage = {
    ...image,
    id: 'aafad34e-5dd5-4e50-83dc-8b8e458ff1ac',
    name: 'next.png',
    url: '/api/artifacts/aafad34e-5dd5-4e50-83dc-8b8e458ff1ac',
  };
  const uploads = [image, nextImage];
  let uploadCount = 0;
  const submissions: Submission[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/state') return Response.json(verificationState);
    if (path === '/api/uploads') return Response.json(uploads[uploadCount++]);
    if (path === '/api/messages') {
      const submission: Submission = JSON.parse(String(init?.body));
      submissions.push(submission);
      if (submissions.length === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Response.json({ taskId: 'accepted-task', messageId: submission.clientMessageId });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  try {
    const input = fixture.element.querySelector<HTMLElement>('[role="textbox"]')!;
    const upload = fixture.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const attach = async (name: string) => {
      Object.defineProperty(upload, 'files', {
        configurable: true,
        value: [new File(['fixture'], name, { type: 'image/png' })],
      });
      await act(async () => {
        upload.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      });
    };
    await draft('483729');
    await attach(image.name);
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.deepEqual(submissions[0].attachmentIds, [image.id]);
    assert.equal(submissions[0].verificationRequestId, verificationRequest.id);
    await draft('Review both images.');
    await attach(nextImage.name);
    await act(async () => {
      finish(Response.json({ error: 'Send the code by itself.' }, { status: 409 }));
      await tick();
    });
    assert.equal(input.textContent, 'Review both images.');
    assert.deepEqual(
      [...fixture.element.querySelectorAll('.composer-wrap img')].map((item) =>
        item.getAttribute('src'),
      ),
      uploads.map((item) => item.url),
    );
    assert.equal(fixture.element.querySelector('.message-user'), null);
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
    await act(async () => {
      sendKey(input);
      await tick();
    });
    assert.equal(submissions[1].text, 'Review both images.');
    assert.deepEqual(
      submissions[1].attachmentIds,
      uploads.map((item) => item.id),
    );
    assert.equal(submissions[1].verificationRequestId, undefined);
    assert.notEqual(submissions[0].clientMessageId, submissions[1].clientMessageId);
    assert.equal(uploadCount, 2);
    assert.equal(input.textContent, '');
    assert.equal(fixture.element.querySelector('.pending-attachment'), null);
    assert.doesNotMatch(fixture.element.innerHTML, /483729/);
  } finally {
    await fixture.dispose();
    globalThis.fetch = priorFetch;
  }
});

test('focus-message scrolls to a loaded message, pages back a bounded number of times and reports a missing one', async () => {
  const previousFetch = globalThis.fetch;
  const previousMedia = Object.getOwnPropertyDescriptor(dom.window, 'matchMedia');
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  });
  const scrolled: string[] = [];
  const previousScroll = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    if (this.dataset.messageId) scrolled.push(this.dataset.messageId);
  };
  const older: Message = {
    ...message,
    id: 'older-message',
    text: 'Your weekly summary is ready.',
    createdAt: '2026-09-24T12:00:00Z',
  };
  const filler = (page: number) =>
    Array.from({ length: 60 }, (_, index): Message => ({
      ...message,
      id: `filler-${page}-${index}`,
      createdAt: new Date(
        Date.parse('2026-09-01T00:00:00Z') - (page * 60 + index) * 1000,
      ).toISOString(),
    })).reverse();
  let pages: Message[][] = [[older]];
  const historyRequests: string[] = [];
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return Response.json({ ...base, hasEarlierMessages: true });
    if (String(path).startsWith('/api/messages?')) {
      historyRequests.push(String(path));
      return Response.json({ messages: pages.shift() ?? [], hasMore: false });
    }
    throw new Error('Unexpected fixture request');
  };
  const fixture = await mount();
  const focus = async (messageId: string) => {
    await act(async () => {
      window.dispatchEvent(new CustomEvent('otto:focus-message', { detail: { messageId } }));
      await tick();
    });
    await act(async () => {
      for (let index = 0; index < 4; index++) await tick();
    });
  };
  try {
    await focus('old-message');
    const loaded = fixture.element.querySelector<HTMLElement>('[data-message-id="old-message"]')!;
    assert.deepEqual(scrolled, ['old-message']);
    assert.equal(loaded.classList.contains('message-focused'), true);
    assert.equal(document.activeElement, loaded);
    assert.equal(historyRequests.length, 0);
    await focus('older-message');
    assert.equal(historyRequests.length, 1);
    assert.match(historyRequests[0], /beforeId=old-message/);
    assert.deepEqual(scrolled, ['old-message', 'older-message']);
    await focus('missing-message');
    assert.equal(historyRequests.length, 1);
    assert.match(fixture.element.textContent ?? '', /Could not find that message in this chat\./);
  } finally {
    await fixture.dispose();
    globalThis.fetch = previousFetch;
  }
  pages = [0, 1, 2, 3, 4, 5, 6].map(filler);
  historyRequests.length = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return Response.json({ ...base, hasEarlierMessages: true });
    if (String(path).startsWith('/api/messages?')) {
      historyRequests.push(String(path));
      return Response.json({ messages: pages.shift() ?? [], hasMore: true });
    }
    throw new Error('Unexpected fixture request');
  };
  const bounded = await mount();
  try {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('otto:focus-message', { detail: { messageId: 'never-loaded' } }),
      );
      for (let index = 0; index < 12; index++) await tick();
    });
    assert.equal(historyRequests.length, 5);
    assert.match(bounded.element.textContent ?? '', /Could not find that message in this chat\./);
  } finally {
    await bounded.dispose();
    globalThis.fetch = previousFetch;
  }
  historyRequests.length = 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/state') return Response.json({ ...base, hasEarlierMessages: true });
    if (String(path).startsWith('/api/messages?')) {
      historyRequests.push(String(path));
      return Response.json({ error: 'History is unavailable.' }, { status: 503 });
    }
    throw new Error('Unexpected fixture request');
  };
  const failing = await mount();
  try {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('otto:focus-message', { detail: { messageId: 'never-loaded' } }),
      );
      for (let index = 0; index < 8; index++) await tick();
    });
    assert.equal(historyRequests.length, 1);
    assert.match(failing.element.textContent ?? '', /History is unavailable\./);
    assert.doesNotMatch(failing.element.textContent ?? '', /Could not find that message/);
  } finally {
    await failing.dispose();
    globalThis.fetch = previousFetch;
    dom.window.HTMLElement.prototype.scrollIntoView = previousScroll;
    if (previousMedia) Object.defineProperty(dom.window, 'matchMedia', previousMedia);
    else Reflect.deleteProperty(dom.window, 'matchMedia');
  }
});
