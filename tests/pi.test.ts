import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { RuntimeContext } from '../src/ports/agent.ts';
import type { WorkspaceExecOptions, WorkspaceSession } from '../src/ports/computer.ts';
import type { PrivateObjectStore } from '../src/ports/object-storage.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import {
  closeInterruptedCalls,
  createPiCheckpoint,
  openLocalSession,
  readPiSessionEntries,
  rebaseAt,
  removedCredential,
} from '../src/providers/pi/checkpoint.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createDecisionModel, type DecisionConnection } from '../src/providers/decisions.ts';
import type { DecisionQuestion } from '../src/ports/decisions.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { createSandbox } from '../src/providers/pi/sandbox.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { rootObject, toolDefinitions } from '../src/runtime/tools.ts';
import { Type } from '@sinclair/typebox';
import { fakeComputer, fakeWorkspace, fakeExecution } from './runtime-fixtures.ts';

// Pi sessions: credential pause and resume, native tools only via the sandbox.

const sandbox = {
  workspace: {
    path: '/workspace/fixture',
    instructions: 'Fixture',
    exec: async () => ({ exitCode: 0 }),
  },
  runTool: (_name: string, _params: unknown, run: () => Promise<{ content: [] }>) => run(),
};

test('real Pi sessions persist a credential pause and resume without replaying chat history', async (t) => {
  for (const background of [false, true])
    await t.test(background ? 'background session' : 'chat session', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-pi-'));
      const id = 'test-' + randomUUID();
      const replies: string[] = [];
      const prompts: string[] = [];
      let managed = 0;
      let phase = 0;
      const context: RuntimeContext = {
        threadId: id,
        turnId: randomUUID(),
        sessionId: background ? randomUUID() : id,
        background,
        prompt: 'Sign in to the fixture',
        history: [{ role: 'user', text: 'Older fixture context' }],
        workspacePath: directory,
        signal: new AbortController().signal,
        attachments: [],
        emit: async () => {},
        reply: async (text) => {
          replies.push(text);
        },
        delta: () => {},
        publish: async () => {
          throw new Error('Not used');
        },
        requestCredential: async () => ({ url: '/credentials/fixture' }),
        integration: async () => ({}),
        manage: async () => {
          managed += 1;
          return {};
        },
      };
      const factory: typeof createAgentSession = async (options) => {
        assert.equal(
          options?.resourceLoader?.getSystemPrompt()?.includes('runtime-fixture-key'),
          false,
        );
        const result = await createAgentSession(options);
        result.session.agent.streamFunction = (model, request) => {
          prompts.push(JSON.stringify(request.messages));
          if (phase === 0 && prompts.length > 1) throw new Error('Fixture exceeded one turn');
          const output: AssistantMessage = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            responseId: `fixture-phase-${phase}`,
            stopReason: phase === 0 ? 'toolUse' : 'stop',
            content:
              phase === 0
                ? [
                    {
                      type: 'toolCall',
                      id: 'credential-call',
                      name: 'sign_in',
                      arguments: {
                        origin: 'https://example.com',
                        label: 'Example',
                        kind: 'password',
                        passwordSelector: '#password',
                        submitSelector: '#submit',
                        message: 'Example needs your password.',
                        action: 'Add password',
                      },
                    },
                    {
                      type: 'toolCall',
                      id: 'later-call',
                      name: 'manage_personal_context',
                      arguments: {
                        action: 'schedule_create',
                        args: { title: 'This should not execute' },
                      },
                    },
                  ]
                : [{ type: 'text', text: 'Resumed successfully.' }],
            usage: {
              input: phase === 0 ? 100 : 200,
              output: 10,
              cacheRead: 20,
              cacheWrite: 5,
              totalTokens: phase === 0 ? 135 : 235,
              cost: {
                input: 0.001,
                output: 0.0008,
                cacheRead: 0.0001,
                cacheWrite: 0.0001,
                total: 0.002,
              },
            },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: 'start', partial: output });
          stream.push({ type: 'done', reason: phase === 0 ? 'toolUse' : 'stop', message: output });
          return stream;
        };
        return result;
      };
      const runtime = createAgentRuntime({
        agent: createPiAgent({
          provider: 'openai',
          apiKey: 'runtime-fixture-key',
          sessionRoot: join(directory, 'sessions'),
          createSession: factory,
        }),
        computer: fakeComputer({
          currentPage: async () => ({
            origin: 'https://example.com',
            url: phase === 0 ? 'https://example.com/login' : 'https://example.com/account',
          }),
        }),
        workspace: fakeWorkspace(),
      });
      try {
        assert.equal((await runtime.runTurn(context)).status, 'waiting_credentials');
        assert.equal(managed, 0);
        phase = 1;
        assert.equal(
          (
            await runtime.runTurn({
              ...context,
              prompt: 'Secure entry completed',
              history: [{ role: 'user', text: 'New context from the continuous conversation' }],
            })
          ).status,
          'succeeded',
        );
        assert.equal(prompts.length, 2);
        assert.equal(prompts[1].includes('Older fixture context'), true);
        assert.equal(prompts[1].includes('Secure entry completed'), true);
        assert.equal(prompts[1].includes('New context from the continuous conversation'), false);
        assert.equal(
          JSON.parse(prompts[1]).filter(
            (item: { role: string; content: unknown }) =>
              item.role === 'user' &&
              JSON.stringify(item.content).includes('Older fixture context'),
          ).length,
          1,
        );
        assert.equal(prompts[1].includes('runtime-fixture-key'), false);
        assert.equal(replies.length, background ? 1 : 2);
      } finally {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
});

test('messages taken after a Pi turn reach the next request together and not after a question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-steer-'));
  const requests: string[] = [];
  const replies: string[] = [];
  const batches = [
    [
      { id: randomUUID(), text: 'Also check the second fixture', attachments: [] },
      { id: randomUUID(), text: 'And the third fixture', attachments: [] },
    ],
  ];
  let takes = 0;
  let question = false;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, request) => {
      requests.push(JSON.stringify(request.messages));
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        responseId: `fixture-${requests.length}`,
        stopReason: question ? 'toolUse' : 'stop',
        content: question
          ? [
              {
                type: 'toolCall',
                id: 'question-call',
                name: 'ask_user',
                arguments: { question: 'Which fixture?' },
              },
            ]
          : [{ type: 'text', text: `Answer ${requests.length}.` }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'done', reason: question ? 'toolUse' : 'stop', message: output });
      return stream;
    };
    return result;
  };
  const context: RuntimeContext = {
    threadId: 'test-' + randomUUID(),
    sessionId: 'test-' + randomUUID(),
    turnId: randomUUID(),
    prompt: 'Check the first fixture',
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async (text) => {
      replies.push(text);
    },
    waitForUser: async (text) => {
      replies.push(text);
    },
    delta: () => {},
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => {
      throw new Error('Not used');
    },
    integration: async () => ({}),
    manage: async () => ({}),
    takeMessages: async () => {
      takes += 1;
      return batches.shift() ?? [];
    },
  };
  const runtime = createAgentRuntime({
    agent: createPiAgent({
      provider: 'openai',
      apiKey: 'fixture-key',
      sessionRoot: join(directory, 'sessions'),
      createSession: factory,
    }),
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    assert.equal((await runtime.runTurn(context)).status, 'succeeded');
    assert.equal(requests.length, 2);
    assert.equal(takes, 2);
    assert.equal(requests[0].includes('second fixture'), false);
    const later = requests[1];
    assert.ok(later.indexOf('Answer 1.') < later.indexOf('Also check the second fixture'));
    assert.ok(
      later.indexOf('Also check the second fixture') < later.indexOf('And the third fixture'),
    );
    assert.deepEqual(replies, ['Answer 1.', 'Answer 2.']);

    question = true;
    batches.push([{ id: randomUUID(), text: 'Sent while asking', attachments: [] }]);
    assert.equal(
      (await runtime.runTurn({ ...context, turnId: randomUUID(), prompt: 'Ask me' })).status,
      'waiting_user',
    );
    assert.equal(takes, 2);
    assert.equal(batches.length, 1);
    assert.equal(replies.at(-1), 'Which fixture?');
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function recordingWorkspace() {
  const scripts: string[] = [];
  return {
    scripts,
    workspace: {
      path: '/workspace/sandbox-fixture',
      instructions: 'Fixture',
      exec: async (script: string) => {
        scripts.push(script);
        return { exitCode: 0 };
      },
    },
  };
}

test('Pi sessions use native tools on the sandbox workspace plus Otto tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-native-'));
  const { workspace, scripts } = recordingWorkspace();
  const ran: string[] = [];
  let captured: Parameters<typeof createAgentSession>[0];
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: async (options) => {
      captured = options;
      return createAgentSession(options);
    },
  });
  try {
    const session = await agent.open({
      ...fakeExecution(randomUUID(), randomUUID()),
      systemPrompt: 'fixture',
      workspace,
      runTool: async (name, params, run) => {
        ran.push(name);
        if (name === 'web_search') assert.equal((params as { workflow?: string }).workflow, 'none');
        return run();
      },
      tools: [
        {
          name: 'fixture_tool',
          description: 'Fixture',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
      ],
      shouldStop: () => false,
      onEvent: () => {},
    });
    assert.equal(captured!.noTools, 'builtin');
    const before = scripts.length;
    const ls = captured!.customTools!.find((tool) => tool.name === 'ls')!;
    await ls.execute('call', {}, undefined, undefined, undefined as never);
    assert.deepEqual(ran, ['ls']);
    assert.ok(scripts.length > before);
    assert.ok(scripts.slice(before).every((script) => script.includes(workspace.path)));
    const extension = captured!
      .resourceLoader!.getExtensions()
      .extensions.find((item) => item.tools.has('web_search'))!;
    const storedContent = extension.tools.get('get_search_content')!;
    await storedContent.definition.execute(
      'call',
      { responseId: 'synthetic-missing' },
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(ran, ['ls', 'get_search_content']);
    const webSearch = extension.tools.get('web_search')!;
    await webSearch.definition.execute(
      'call',
      { workflow: 'summary-review' },
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(ran, ['ls', 'get_search_content', 'web_search']);
    const fetchContent = extension.tools.get('fetch_content')!;
    await writeFile(join(directory, 'host.mp4'), 'synthetic host video');
    const hostFile = async (name: string) =>
      JSON.stringify(
        (
          await fetchContent.definition.execute(
            'call',
            { url: join(directory, name), timestamp: '0:01' },
            undefined,
            undefined,
            undefined as never,
          )
        ).content,
      ).replaceAll(name, 'file.mp4');
    assert.equal(await hostFile('host.mp4'), await hostFile('missing.mp4'));
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('codemode scripts reach only workspace and web tools, each call through the turn guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-codemode-'));
  const { workspace } = recordingWorkspace();
  const ran: string[] = [];
  const requests: string[] = [];
  const code =
    "const [, , stored] = await Promise.allSettled([tools.ls({}), tools.find({ pattern: '*' }), tools.get_search_content({ responseId: 'synthetic-missing' })]); return JSON.stringify({ stored: String(stored.reason).includes('No stored results'), ottoTool: 'fixture_tool' in tools, apps: 'apps' in tools });";
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (model, request) => {
        requests.push(JSON.stringify(request.messages.at(-1)));
        const first = requests.length === 1;
        const output: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: first ? 'toolUse' : 'stop',
          content: first
            ? [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code } }]
            : [{ type: 'text', text: 'Done.' }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'start', partial: output });
        stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message: output });
        return stream;
      };
      return result;
    },
  });
  try {
    const session = await agent.open({
      ...fakeExecution(randomUUID(), randomUUID()),
      systemPrompt: 'fixture',
      workspace,
      runTool: async (name, _params, run) => {
        ran.push(name);
        return run();
      },
      tools: ['fixture_tool', 'apps'].map((name) => ({
        name,
        description: 'Fixture',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      })),
      shouldStop: () => false,
      onEvent: () => {},
    });
    await session.prompt('Run the script', []);
    assert.deepEqual(ran.toSorted(), ['codemode', 'find', 'get_search_content', 'ls']);
    assert.match(requests[1], /\{\\"stored\\":true,\\"ottoTool\\":false,\\"apps\\":false\}/);
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

// Durable Pi checkpoints: rebase, stale writers, dangling tool calls, restore.

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'otto-durable-pi-'));
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  return {
    directory,
    store,
    threadId: randomUUID(),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

async function savedText(f: Awaited<ReturnType<typeof fixture>>) {
  const entries = await readPiSessionEntries({
    threadId: f.threadId,
    sessionRoot: f.directory,
    objectStore: f.store,
  });
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

function visibleContext(manager: SessionManager) {
  return manager
    .buildSessionContext()
    .messages.map((message) =>
      message.role === 'compactionSummary' ? { ...message, timestamp: 0 } : message,
    );
}

function compactedHistory(manager: SessionManager, filler = '') {
  const ids: string[] = [];
  for (let index = 0; index < 6; index++)
    ids.push(
      manager.appendMessage({
        role: 'user',
        content: `Earlier fixture message ${index} ${filler}`,
        timestamp: 1000 + index,
      }),
    );
  manager.appendCompaction('Fixture summary of earlier work', ids[4], 4321, { fixture: true });
  for (let index = 0; index < 3; index++)
    manager.appendMessage({
      role: 'user',
      content: `Later fixture message ${index}`,
      timestamp: 2000 + index,
    });
}

test('a durable saved session above the rebase size is rebased on load with the same model context', async () => {
  const f = await fixture();
  try {
    const original = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'old'),
    });
    compactedHistory(original.manager, 'x'.repeat(Math.ceil(rebaseAt / 5)));
    await original.checkpoint();
    const saved = Buffer.byteLength(await savedText(f));
    assert.ok(saved > rebaseAt);
    const restored = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'new'),
    });
    assert.deepEqual(visibleContext(restored.manager), visibleContext(original.manager));
    assert.ok(restored.manager.getEntries().length < original.manager.getEntries().length);
    const rewritten = Buffer.byteLength(await savedText(f));
    assert.ok(rewritten < saved);
    assert.ok(rewritten < rebaseAt);
  } finally {
    await f.close();
  }
});

function legacyLogin(manager: SessionManager, password = 'synthetic-legacy-password') {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const call = (id: string, name: string, args: Record<string, string>, timestamp: number) =>
    manager.appendMessage({
      role: 'assistant',
      api: 'openai-responses',
      provider: 'openai',
      model: 'fixture',
      timestamp,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id, name, arguments: args }],
      usage,
    });
  manager.appendMessage({ role: 'user', content: 'Sign in to the fixture site.', timestamp: 1 });
  call('legacy', 'get_credential', {}, 2);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'legacy',
    toolName: 'get_credential',
    content: [
      {
        type: 'text',
        text: JSON.stringify({ username: 'fixture-user', password }),
      },
    ],
    details: {},
    isError: false,
    timestamp: 3,
  });
  call('typed', 'browser', { action: 'fill', selector: '@e2', text: password }, 4);
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'typed',
    toolName: 'browser',
    content: [{ type: 'text', text: 'Filled.' }],
    details: {},
    isError: false,
    timestamp: 5,
  });
}

async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(path);
  }
  return found;
}

test('a saved session loses old plaintext logins from model context and storage when it loads', async () => {
  const f = await fixture();
  try {
    const original = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'old'),
    });
    legacyLogin(original.manager);
    await original.checkpoint();
    const restored = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'new'),
    });
    const context = JSON.stringify(restored.manager.buildSessionContext().messages);
    assert.equal(context.includes('synthetic-legacy-password'), false);
    assert.ok(context.includes(removedCredential));
    for (const file of await filesUnder(join(f.directory, 'objects')))
      assert.equal((await readFile(file, 'utf8')).includes('synthetic-legacy-password'), false);

    const local = join(f.directory, 'local');
    await mkdir(local);
    legacyLogin(SessionManager.create(local, local));
    const opened = openLocalSession(local);
    assert.equal(
      JSON.stringify(opened.buildSessionContext().messages).includes('synthetic-legacy-password'),
      false,
    );
    const files = (await readdir(local)).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    assert.equal(
      (await readFile(join(local, files[0]!), 'utf8')).includes('synthetic-legacy-password'),
      false,
    );
  } finally {
    await f.close();
  }
});

test('short legacy passwords are removed after compaction without changing message types', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.directory);
    legacyLogin(manager, 'q');
    const kept = manager.getLeafId()!;
    manager.appendCompaction('The saved password was q.', kept, 50, { value: 'q' });
    manager.appendMessage({ role: 'user', content: 'Use the password q.', timestamp: 6 });
    manager.appendMessage({
      role: 'bashExecution',
      command: 'printf q',
      output: 'q',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 7,
    });
    manager.appendMessage({
      role: 'assistant',
      api: 'openai-responses',
      provider: 'openai',
      model: 'fixture',
      timestamp: 8,
      stopReason: 'stop',
      content: [{ type: 'thinking', thinking: 'The password was q.' }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    await f.store.write(
      `sessions/${f.threadId}.jsonl`,
      Buffer.from(
        [manager.getHeader(), ...manager.getEntries()].map((row) => JSON.stringify(row)).join('\n'),
      ),
      { expectedVersion: null },
    );
    const restored = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'new'),
    });
    assert.doesNotMatch(
      JSON.stringify(restored.manager.buildSessionContext().messages),
      /password (?:was )?q/,
    );
    assert.ok(
      restored.manager.buildSessionContext().messages.some((message) => message.role === 'user'),
    );
    await restored.checkpoint();
    assert.doesNotMatch(await savedText(f), /get_credential|"value":"q"|password (?:was )?q/);
  } finally {
    await f.close();
  }
});

test('legacy passwords are removed from embedded JSON strings', async () => {
  const f = await fixture();
  try {
    const password = 'synthetic"quoted\\password';
    const manager = SessionManager.inMemory(f.directory);
    legacyLogin(manager, password);
    manager.appendMessage({ role: 'user', content: JSON.stringify({ password }), timestamp: 6 });
    await f.store.write(
      `sessions/${f.threadId}.jsonl`,
      Buffer.from(
        [manager.getHeader(), ...manager.getEntries()].map((row) => JSON.stringify(row)).join('\n'),
      ),
      { expectedVersion: null },
    );
    const restored = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'new'),
    });
    const texts = restored.manager
      .buildSessionContext()
      .messages.flatMap((message) =>
        'content' in message
          ? typeof message.content === 'string'
            ? [message.content]
            : message.content.filter((part) => part.type === 'text').map((part) => part.text)
          : [],
      );
    for (const text of texts) {
      assert.equal(text.includes(password), false);
      assert.equal(text.includes(JSON.stringify(password).slice(1, -1)), false);
    }
    await restored.checkpoint();
    assert.doesNotMatch(await savedText(f), /synthetic.*quoted/);
  } finally {
    await f.close();
  }
});

test('a local summary is scrubbed with credentials from its retained earlier file', async () => {
  const f = await fixture();
  try {
    const local = join(f.directory, 'local');
    await mkdir(local);
    const older = SessionManager.create(local, local);
    legacyLogin(older);
    const current = SessionManager.create(local, local);
    current.appendMessage({ role: 'user', content: 'Read the report.', timestamp: 6 });
    current.appendCompaction(
      'Use fixture-user with synthetic-legacy-password.',
      current.getLeafId(),
      50,
    );
    const activeFile = current.getSessionFile()!;
    const { utimes } = await import('node:fs/promises');
    await utimes(activeFile, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    const opened = openLocalSession(local);
    assert.doesNotMatch(
      JSON.stringify(opened.buildSessionContext().messages),
      /fixture-user|synthetic-legacy-password/,
    );
    const files = await filesUnder(local);
    assert.equal(files.length, 1);
    assert.doesNotMatch(
      await readFile(files[0]!, 'utf8'),
      /fixture-user|synthetic-legacy-password/,
    );
  } finally {
    await f.close();
  }
});

test('failed checkpoint cleanup blocks startup and preserves the published session', async () => {
  const f = await fixture();
  try {
    const original = await createPiCheckpoint({ ...f, directory: f.directory });
    legacyLogin(original.manager);
    await original.checkpoint();
    const store = {
      ...f.store,
      remove: async () => {
        throw new Error('Synthetic removal failure');
      },
    };
    await assert.rejects(
      createPiCheckpoint({ ...f, store, directory: join(f.directory, 'blocked') }),
      /could not be saved/,
    );
    const restored = await createPiCheckpoint({ ...f, directory: join(f.directory, 'restored') });
    assert.doesNotMatch(
      JSON.stringify(restored.manager.buildSessionContext().messages),
      /fixture-user|synthetic-legacy-password/,
    );
    assert.match(
      JSON.stringify(restored.manager.buildSessionContext().messages),
      /removed from context/,
    );
    for (const file of await filesUnder(join(f.directory, 'objects')))
      assert.doesNotMatch(await readFile(file, 'utf8'), /fixture-user|synthetic-legacy-password/);
  } finally {
    await f.close();
  }
});

function dangling(manager: SessionManager, answered: string[]) {
  manager.appendMessage({ role: 'user', content: 'Run two actions', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant',
    api: 'openai-responses',
    provider: 'openai',
    model: 'fixture',
    timestamp: 2,
    stopReason: 'toolUse',
    content: [
      { type: 'toolCall', id: 'call-one', name: 'bash', arguments: { command: 'true' } },
      { type: 'toolCall', id: 'call-two', name: 'browser', arguments: { action: 'click' } },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  for (const id of answered)
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: id,
      toolName: 'bash',
      content: [{ type: 'text', text: 'done' }],
      details: {},
      isError: false,
      timestamp: 3,
    });
}

function toolResults(manager: SessionManager) {
  return manager
    .buildSessionContext()
    .messages.flatMap((message) => (message.role === 'toolResult' ? [message] : []));
}

test('closeInterruptedCalls answers each dangling tool call with an unknown-outcome error', () => {
  const manager = SessionManager.inMemory('/fixture');
  dangling(manager, ['call-one']);
  closeInterruptedCalls(manager);
  const results = toolResults(manager);
  assert.deepEqual(
    results.map((result) => [result.toolCallId, result.isError]),
    [
      ['call-one', false],
      ['call-two', true],
    ],
  );
  const text = JSON.stringify(results[1].content);
  assert.match(text, /interrupted/);
  assert.match(text, /outcome is unknown/);
  closeInterruptedCalls(manager);
  assert.equal(toolResults(manager).length, 2);
});

test('a session saved as one file before part uploads restores and keeps saving', async () => {
  const f = await fixture();
  try {
    const legacy = SessionManager.inMemory(f.directory);
    compactedHistory(legacy);
    await f.store.write(
      `sessions/${f.threadId}.jsonl`,
      Buffer.from(
        [legacy.getHeader(), ...legacy.getEntries()].map((row) => JSON.stringify(row)).join('\n'),
      ),
      { expectedVersion: null },
    );
    const restored = await createPiCheckpoint({ ...f, directory: join(f.directory, 'new') });
    assert.deepEqual(visibleContext(restored.manager), visibleContext(legacy));
    restored.manager.appendMessage({ role: 'user', content: 'after upgrade', timestamp: 3000 });
    await restored.checkpoint();
    const again = await createPiCheckpoint({ ...f, directory: join(f.directory, 'again') });
    assert.match(JSON.stringify(visibleContext(again.manager)), /after upgrade/);
    assert.match(JSON.stringify(visibleContext(again.manager)), /Later fixture message 2/);
  } finally {
    await f.close();
  }
});

test('a session entry larger than one stored object is saved and restored', async () => {
  const f = await fixture();
  try {
    const saved = await createPiCheckpoint({ ...f, directory: join(f.directory, 'old') });
    saved.manager.appendMessage({
      role: 'user',
      content: 'y'.repeat(20 * 1024 * 1024),
      timestamp: 1,
    });
    await saved.checkpoint();
    const restored = await createPiCheckpoint({ ...f, directory: join(f.directory, 'new') });
    assert.deepEqual(visibleContext(restored.manager), visibleContext(saved.manager));
  } finally {
    await f.close();
  }
});

for (const failure of [
  'part-before',
  'part-after',
  'manifest-before',
  'manifest-after',
  'manifest-unreadable',
])
  test(`failed checkpoint ${failure} removes only unpublished parts`, async () => {
    const f = await fixture();
    let armed = false;
    let failed = false;
    const written: string[] = [];
    const manifestKey = `sessions/${f.threadId}.jsonl`;
    const store: PrivateObjectStore = {
      ...f.store,
      read: async (...args) => {
        if (failed && failure === 'manifest-unreadable' && args[0] === manifestKey)
          throw new Error('Synthetic read failure');
        return f.store.read(...args);
      },
      write: async (...args) => {
        if (!armed) return f.store.write(...args);
        if (args[0] !== manifestKey) written.push(args[0]);
        const fail =
          args[0] === manifestKey
            ? failure.startsWith('manifest-')
            : failure.startsWith('part-') && written.length === 2;
        if (fail && failure.endsWith('-before')) {
          failed = true;
          throw new Error('Synthetic write failure');
        }
        const version = await f.store.write(...args);
        if (fail) {
          failed = true;
          throw new Error('Synthetic lost write acknowledgement');
        }
        return version;
      },
    };
    try {
      const checkpoint = await createPiCheckpoint({ ...f, store, directory: f.directory });
      checkpoint.manager.appendMessage({
        role: 'user',
        content: 'synthetic-data '.repeat(700_000),
        timestamp: 1,
      });
      armed = true;
      await assert.rejects(checkpoint.checkpoint(), /could not be saved/);
      assert.equal(written.length, 2);
      const published = JSON.parse(
        Buffer.from((await f.store.read(manifestKey, 1024 * 1024))!.bytes).toString(),
      );
      for (const key of written) {
        const referenced = published.parts.some((id: string) => key.endsWith(`/${id}.jsonl`));
        assert.equal(Boolean(await f.store.read(key, 15 * 1024 * 1024)), referenced);
      }
      const restored = await createPiCheckpoint({ ...f, directory: join(f.directory, 'restored') });
      assert.equal(
        restored.manager.buildSessionContext().messages.some((message) => message.role === 'user'),
        failure === 'manifest-after' || failure === 'manifest-unreadable',
      );
    } finally {
      await f.close();
    }
  });

test('a stale Pi writer cannot overwrite a newer session checkpoint', async () => {
  const f = await fixture();
  try {
    const first = await createPiCheckpoint({ ...f, directory: f.directory });
    const next = await createPiCheckpoint({ ...f, directory: f.directory });
    await assert.rejects(first.checkpoint(), /could not be saved/);
    next.manager.appendMessage({ role: 'user', content: 'new version', timestamp: Date.now() });
    await next.checkpoint();
    first.manager.appendMessage({ role: 'user', content: 'stale version', timestamp: Date.now() });
    await assert.rejects(first.checkpoint(), /could not be saved/);
    const restored = await createPiCheckpoint({ ...f, directory: f.directory });
    assert.match(JSON.stringify(restored.manager.getEntries()), /new version/);
    assert.doesNotMatch(JSON.stringify(restored.manager.getEntries()), /stale version/);
  } finally {
    await f.close();
  }
});

test('real Pi awaits durable final checkpoints and restores a conversation in a fresh actor directory', async () => {
  const f = await fixture();
  const prompts: string[] = [];
  let blockFinal = false;
  let release: (() => void) | undefined;
  let checkpointStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    checkpointStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: PrivateObjectStore = {
    ...f.store,
    async write(key, bytes, condition) {
      if (blockFinal && bytes.toString().includes('Durable final fixture')) {
        checkpointStarted!();
        await gate;
      }
      return f.store.write(key, bytes, condition);
    },
  };
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, request) => {
      prompts.push(JSON.stringify(request.messages));
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Durable final fixture' }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      return stream;
    };
    return result;
  };
  const create = (name: string) =>
    createPiAgent({
      provider: 'openai',
      apiKey: 'fixture',
      sessionRoot: join(f.directory, name),
      objectStore: store,
      createSession: factory,
    });
  const first = create('first');
  const second = create('second');
  const final: string[] = [];
  try {
    const session = await first.open({
      ...fakeExecution(f.threadId, randomUUID()),
      systemPrompt: 'fixture',
      ...sandbox,
      tools: [],
      shouldStop: () => false,
      onEvent(event) {
        if (event.type === 'final') final.push(event.text);
      },
    });
    blockFinal = true;
    const prompt = session.prompt('Remember synthetic context', []);
    await started;
    assert.deepEqual(final, []);
    release!();
    await prompt;
    assert.deepEqual(final, ['Durable final fixture']);
    blockFinal = false;
    await first.dispose();
    await rm(join(f.directory, 'first'), { recursive: true, force: true });
    const restored = await second.open({
      ...fakeExecution(f.threadId, randomUUID()),
      systemPrompt: 'fixture',
      ...sandbox,
      tools: [],
      shouldStop: () => false,
      onEvent() {},
    });
    assert.equal(restored.resumed, true);
    await restored.prompt('Continue now', []);
    assert.match(prompts[1], /Remember synthetic context/);
    assert.match(prompts[1], /Durable final fixture/);
  } finally {
    release!();
    await first.dispose();
    await second.dispose();
    await f.close();
  }
});

test('real Pi persists its user message and tool call before a side effect and records the result before continuing', async () => {
  const f = await fixture();
  let turns = 0;
  let executed = 0;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model) => {
      const tool = turns++ === 0;
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: tool ? 'toolUse' : 'stop',
        content: tool
          ? [{ type: 'toolCall', id: 'effect-one', name: 'effect', arguments: {} }]
          : [{ type: 'text', text: 'Done' }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
      return stream;
    };
    return result;
  };
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture',
    sessionRoot: join(f.directory, 'cache'),
    objectStore: f.store,
    createSession: factory,
  });
  try {
    const session = await agent.open({
      ...fakeExecution(f.threadId, randomUUID()),
      systemPrompt: 'fixture',
      ...sandbox,
      shouldStop: () => false,
      onEvent() {},
      tools: [
        {
          name: 'effect',
          description: 'fixture',
          parameters: { type: 'object', properties: {} },
          async execute() {
            const saved = await savedText(f);
            assert.match(saved, /synthetic user request/);
            assert.match(saved, /toolCall/);
            executed++;
            return { content: [{ type: 'text', text: 'durable receipt' }] };
          },
        },
      ],
    });
    await session.prompt('synthetic user request', []);
    assert.equal(executed, 1);
    assert.equal(turns, 2);
    await agent.dispose();
    const resumed = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: join(f.directory, 'replacement'),
    });
    assert.equal(
      resumed.manager
        .getEntries()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult').length,
      1,
    );
    assert.match(JSON.stringify(resumed.manager.buildSessionContext().messages), /durable receipt/);
  } finally {
    await agent.dispose();
    await f.close();
  }
});

test('a restored durable session closes dangling tool calls before the next prompt', async () => {
  const f = await fixture();
  const prompts: string[] = [];
  const saved = await createPiCheckpoint({
    store: f.store,
    threadId: f.threadId,
    directory: join(f.directory, 'old'),
  });
  dangling(saved.manager, ['call-one']);
  await saved.checkpoint();
  await createPiCheckpoint({ ...f, directory: join(f.directory, 'reload') });
  assert.match(await savedText(f), /outcome is unknown/);
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture',
    sessionRoot: join(f.directory, 'new'),
    objectStore: f.store,
    createSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (model, request) => {
        prompts.push(JSON.stringify(request.messages));
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Checked' }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      };
      return result;
    },
  });
  try {
    const session = await agent.open({
      ...fakeExecution(f.threadId, randomUUID()),
      systemPrompt: 'fixture',
      ...sandbox,
      tools: [],
      shouldStop: () => false,
      onEvent() {},
    });
    assert.equal(session.resumed, true);
    await session.prompt('Did it work?', []);
    assert.match(prompts[0], /call-two/);
    assert.match(prompts[0], /outcome is unknown/);
  } finally {
    await agent.dispose();
    await f.close();
  }
});

// Sandbox: native tools never touch the host and receive no host environment.

const timeoutShim = `#!/usr/bin/perl
shift if $ARGV[0] eq '--verbose';
shift, shift if $ARGV[0] eq '-k';
my $seconds = shift;
my $pid = fork;
if (!$pid) { exec @ARGV; exit 127 }
$SIG{ALRM} = sub { print STDERR "timeout\\n"; kill 'KILL', $pid; exit 124 };
alarm $seconds;
waitpid $pid, 0;
exit($? >> 8);
`;

async function hostSandbox(t: test.TestContext) {
  const host = await mkdtemp(join(tmpdir(), 'otto-sandbox-'));
  const bin = join(host, 'bin');
  const root = join(host, 'root');
  await mkdir(bin);
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(bin, 'timeout'), timeoutShim);
  await chmod(join(bin, 'timeout'), 0o755);
  t.after(() => rm(host, { recursive: true, force: true }));
  const prefix = `/otto-sandbox-${randomUUID()}`;
  const calls: string[] = [];
  const workspace: WorkspaceSession = {
    path: `${prefix}/workspace`,
    instructions: 'Fixture sandbox.',
    exec(command: string, options: WorkspaceExecOptions = {}) {
      calls.push(command);
      return new Promise((resolve) => {
        const child = spawn('bash', ['-c', command.replaceAll(prefix, root)], {
          cwd: join(root, 'workspace'),
          env: { PATH: `${bin}:/usr/bin:/bin` },
        });
        const deliver = (chunk: Buffer) =>
          options.onData?.(Buffer.from(chunk.toString('utf8').replaceAll(root, prefix)));
        child.stdout.on('data', deliver);
        child.stderr.on('data', deliver);
        child.stdin.on('error', () => {});
        child.stdin.end(options.input ?? '');
        child.on('error', () => resolve({ exitCode: 127 }));
        child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
      });
    },
  };
  const tools = Object.fromEntries(createSandbox(workspace).map((tool) => [tool.name, tool]));
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await (tools[name] as ToolDefinition).execute(
      randomUUID(),
      params,
      undefined,
      undefined,
      undefined as never,
    );
    return result.content.map((part) => (part.type === 'text' ? part.text : part.type)).join('');
  };
  return { prefix, root, bin, calls, tools, run };
}

test('native Pi tools run only through workspace exec on sandbox paths that do not exist on the host', async (t) => {
  const { prefix, calls, run } = await hostSandbox(t);
  assert.equal(existsSync(prefix), false);
  await run('write', { path: 'notes/a.txt', content: 'alpha\nbeta\n' });
  assert.equal(await run('read', { path: 'notes/a.txt' }), 'alpha\nbeta\n');
  await run('edit', { path: 'notes/a.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] });
  assert.equal(await run('read', { path: `${prefix}/workspace/notes/a.txt` }), 'alpha\ngamma\n');
  assert.equal(await run('ls', {}), 'notes/');
  assert.equal(await run('ls', { path: 'notes' }), 'a.txt');
  assert.equal(await run('find', { pattern: '*.txt' }), 'notes/a.txt');
  assert.equal((await run('bash', { command: 'pwd' })).trim(), `${prefix}/workspace`);
  await assert.rejects(run('read', { path: 'missing.txt' }));
  assert.ok(calls.length >= 8);
  assert.equal(existsSync(prefix), false);
});

test('bash output larger than Pi limits stays in the sandbox and never creates host temp files', async (t) => {
  const { prefix, root, tools, run } = await hostSandbox(t);
  const before = (await readdir(tmpdir())).filter((name) => name.startsWith('pi-bash-'));
  const output = await run('bash', { command: 'seq 1 100000' });
  assert.ok(Buffer.byteLength(output) < 60 * 1024);
  assert.match(output, /100000\n/);
  const path = output.match(/Full output: (\S+)\]/)?.[1];
  assert.ok(path?.startsWith(`${prefix}/workspace/.otto/outputs/pi-bash-`));
  const saved = await readFile(path!.replace(prefix, root), 'utf8');
  assert.equal(saved.split('\n').length, 100001);
  const huge = await run('bash', { command: 'seq 1 400000' });
  const complete = huge.match(/Complete output \(\d+ bytes\): (\S+)\]/)?.[1];
  assert.ok(complete?.startsWith(`${prefix}/workspace/.otto/outputs/bash-`));
  assert.equal(
    (await readFile(complete!.replace(prefix, root), 'utf8')).split('\n').length,
    400001,
  );
  const failed = await (tools.bash as ToolDefinition).execute(
    randomUUID(),
    { command: 'echo failed; seq 1 100000; exit 3' },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(failed.isError, true);
  const failure = failed.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  assert.ok(Buffer.byteLength(failure) < 60 * 1024);
  await assert.rejects(run('bash', { command: 'sleep 5', timeout: 1 }));
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('pi-bash-'));
  assert.deepEqual(after, before);
});

test('bash rewrites inside the workspace and never retries an executed command', async (t) => {
  const { root, bin, run } = await hostSandbox(t);
  const directory = join(root, 'workspace');
  await writeFile(
    join(directory, 'job.sh'),
    'printf "run\\n" >> executions\nprintf "%s\\n" "$1"\nexit 7\n',
  );
  await writeFile(join(bin, 'git'), '#!/bin/sh\nbash job.sh original\n', { mode: 0o755 });
  await writeFile(
    join(bin, 'rtk'),
    '#!/bin/sh\n[ "$1" = rewrite ] || exec bash job.sh filtered\ncat rewrite-output\nexit "$(cat rewrite-code)"\n',
    { mode: 0o755 },
  );
  for (const { code, replacement } of [
    { code: 0, replacement: 'bash job.sh filtered' },
    { code: 3, replacement: 'bash job.sh filtered' },
    { code: 1, replacement: '' },
    { code: 42, replacement: 'bash job.sh filtered' },
    { code: 0, replacement: '' },
    { code: 2, replacement: 'bash job.sh filtered' },
  ]) {
    await writeFile(join(directory, 'rewrite-code'), String(code));
    await writeFile(join(directory, 'rewrite-output'), replacement);
    await writeFile(join(directory, 'executions'), '');
    await run('bash', { command: 'git status' });
    assert.equal(await readFile(join(directory, 'executions'), 'utf8'), 'run\n');
  }
  await rm(join(bin, 'rtk'));
  await writeFile(join(directory, 'executions'), '');
  await run('bash', { command: 'git status' });
  assert.equal(await readFile(join(directory, 'executions'), 'utf8'), 'run\n');
});

// Runtime: one active turn, stop and shutdown drain.

function context(directory: string): RuntimeContext {
  return {
    threadId: 'fixture',
    sessionId: 'fixture',
    turnId: 'fixture',
    workspacePath: directory,
    prompt: 'Use the replacement tools',
    history: [],
    attachments: [],
    signal: new AbortController().signal,
    emit: async () => {},
    delta: () => {},
    reply: async () => {},
    publish: async (path) => ({
      id: 'fixture',
      name: path,
      mimeType: 'text/plain',
      size: 1,
      url: '/api/artifacts/fixture',
    }),
    requestCredential: async () => ({ filled: true }),
    integration: async () => ({}),
    manage: async () => ({}),
  };
}

test('delegated subagents run in parallel, each in its own browser, and answer as untrusted data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-delegate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened = new Map<string, string>();
  const discarded: string[] = [];
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let results: unknown[] = [];
  let childTools: string[] = [];
  const runtime = createAgentRuntime({
    agent: {
      open: async (input) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async (text) => {
          const tool = (name: string) => input.tools.find((item) => item.name === name)!;
          if (!input.tools.some((item) => item.name === 'delegate')) {
            childTools = input.tools.map((item) => item.name);
            const shop = /shop-\w/.exec(text)![0];
            started.push(shop);
            await tool('browser').execute({ action: 'open', url: `https://${shop}.example/drill` });
            await gate;
            input.onEvent({ type: 'final', text: `${shop} sells the drill for 89 EUR` });
            return;
          }
          const pending = Promise.all(
            ['shop-a', 'shop-b', 'shop-c'].map((shop) =>
              tool('delegate').execute({ title: shop, instruction: `Price the drill on ${shop}.` }),
            ),
          );
          for (let wait = 0; started.length < 3 && wait < 200; wait++) await setTimeout(5);
          const first = [...started].sort();
          release();
          results = await pending;
          assert.deepEqual(first, ['shop-a', 'shop-b', 'shop-c']);
        },
      }),
      dispose() {},
    },
    computer: fakeComputer({
      act: async (id, action) => {
        if (action.action === 'open' && action.url) opened.set(action.url, id);
        return { text: 'Fixture page', url: action.url ?? 'https://example.com' };
      },
      discard: async (id) => {
        discarded.push(id);
      },
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTurn({ ...context(directory), turnId: randomUUID() });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(started.sort(), ['shop-a', 'shop-b', 'shop-c']);
    for (const name of [
      'delegate',
      'sign_in',
      'pay',
      'browser_session',
      'ask_user',
      'send_message',
      'follow_up',
      'manage_apps',
    ])
      assert.equal(childTools.includes(name), false);
    const browsers = [...opened.values()];
    assert.equal(new Set(browsers).size, 3);
    assert.ok(browsers.every((id) => id !== 'fixture'));
    assert.deepEqual(discarded.sort(), browsers.sort());
    for (const [index, shop] of ['shop-a', 'shop-b', 'shop-c'].entries()) {
      const text = JSON.stringify(results[index]);
      assert.match(text, /untrusted_tool_result/);
      assert.match(text, new RegExp(`${shop} sells the drill for 89 EUR`));
    }
  } finally {
    release();
    await runtime.dispose();
  }
});

test('a paused turn cannot start a subagent still preparing and failed children return errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-delegate-stop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let opened = 0;
  let preparing = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createAgentRuntime({
    agent: {
      open: async (input) => {
        const child = Boolean(input.ephemeral);
        if (child) opened++;
        return {
          resumed: false,
          abort: () => release(),
          dispose() {},
          prompt: async () => {
            if (child) {
              await gate;
              input.onEvent({ type: 'error' });
              input.onEvent({ type: 'message_end', status: 'failed' });
              return;
            }
            const delegate = input.tools.find((tool) => tool.name === 'delegate')!;
            const pending = [1, 2, 3].map((number) =>
              delegate.execute({ title: `Check ${number}`, instruction: 'Run a synthetic check.' }),
            );
            for (let wait = 0; preparing < 3 && wait < 200; wait++) await setTimeout(5);
            assert.equal(preparing, 3);
            await input.tools
              .find((tool) => tool.name === 'ask_user')!
              .execute({ question: 'Which source should I use?' });
            const outcomes = await Promise.allSettled(pending);
            assert.equal(opened, 2);
            assert.ok(outcomes.every((outcome) => outcome.status === 'rejected'));
            assert.ok(
              outcomes
                .slice(0, 2)
                .every(
                  (outcome) =>
                    outcome.status === 'rejected' &&
                    /subagent model request failed/.test(String(outcome.reason)),
                ),
            );
          },
        };
      },
      dispose() {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace({
      open: () => ({
        path: '/fixture/workspace',
        instructions: 'Fixture workspace only.',
        exec: async () => {
          if (++preparing === 3) await gate;
          return { exitCode: 0 };
        },
      }),
    }),
  });
  try {
    assert.equal(
      (await runtime.runTurn({ ...context(directory), turnId: randomUUID() })).status,
      'waiting_user',
    );
  } finally {
    release();
    await runtime.dispose();
  }
});

test('runtime shutdown drains tasks and releases every capability after adapter failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-disposal-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: string[] = [];
  const runtime = createAgentRuntime({
    agent: {
      open: async () => ({
        resumed: false,
        prompt: async () => {
          entered();
          await stopped;
        },
        abort: () => {
          finish();
        },
        dispose: () => {},
      }),
      dispose: () => {
        throw new Error('Synthetic agent cleanup failure');
      },
    },
    computer: fakeComputer({
      dispose: () => {
        events.push('computer');
        throw new Error('Synthetic browser cleanup failure');
      },
    }),
    workspace: fakeWorkspace({
      dispose: () => {
        events.push('workspace');
      },
    }),
  });
  const running = assert.rejects(runtime.runTurn(context(directory)), /abort/i);
  await started;
  await assert.rejects(runtime.runTurn(context(directory)), /already active/);
  const disposal = runtime.dispose();
  assert.equal(runtime.dispose(), disposal);
  await assert.rejects(disposal);
  await running;
  assert.equal(events.filter((value) => value === 'computer').length, 1);
  assert.equal(events.filter((value) => value === 'workspace').length, 1);
  await assert.rejects(runtime.runTurn(context(directory)), /stopped/);
});

test('decision providers preserve inputs, bind answers, and refuse failed requests without a retry', async (t) => {
  const { createServer } = await import('node:http');
  const calls: Array<{ path: string; authorization: string | undefined; body: any }> = [];
  let reply: unknown;
  let status = 200;
  let redirect: string | undefined;
  let invalidJson = false;
  let hold = false;
  let arrived = () => {};
  const server = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    calls.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body: JSON.parse(data),
    });
    arrived();
    if (hold) return;
    response.writeHead(status, {
      'content-type': 'application/json',
      ...(redirect ? { location: redirect } : {}),
    });
    response.end(invalidJson ? 'Synthetic invalid JSON' : JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const urls: string[] = [];
  const usage: ProviderUsageEvent[] = [];
  let connection: DecisionConnection | undefined = { provider: 'openai', key: 'fixture-key' };
  const model = createDecisionModel({
    resolve: async () => connection,
    fetch: async (url, options) => {
      urls.push(String(url));
      return fetch(`${origin}${new URL(String(url)).pathname}`, options);
    },
  });
  const input = {
    userMessages: [{ text: 'Ask before sending the synthetic report.' }],
    action: {
      name: 'CONNECTED_MCP_CALL',
      arguments: { body: `${'x'.repeat(50_000)}final restriction` },
    },
  };
  const question: DecisionQuestion = {
    name: 'run',
    choices: [
      { value: true, description: 'Run.' },
      { value: false, description: 'Ask.' },
    ],
  };
  const check = (signal?: AbortSignal) =>
    model.check({ instructions: 'Apply the owner policy.', input, question }, signal, (event) =>
      usage.push(event),
    );
  const openai = (choice: unknown = false, name = 'run') => ({
    model: 'gpt-6-luna',
    answers: [{ type: 'choice', name, choice }],
    usage: { input_tokens: 1000, output_tokens: 0 },
  });
  const jev = (choice = 'false') => ({
    model: 'jev-1.13.0',
    answers: { run: { type: 'choice', choice } },
    usage: { input_tokens: 1000, output_tokens: 20 },
  });
  for (const provider of ['openai', 'openrouter', 'typesafe'] as const) {
    connection = { provider, key: `fixture-${provider}-key` };
    reply = provider === 'openai' ? openai() : jev();
    assert.deepEqual(await check(), { run: false });
    const sent = calls.at(-1)!;
    assert.equal(sent.authorization, `Bearer fixture-${provider}-key`);
    assert.deepEqual(provider === 'openai' ? JSON.parse(sent.body.input) : sent.body.state, input);
    const supplied = provider === 'openai' ? sent.body.questions[0] : sent.body.questions.run;
    assert.equal(supplied.instructions, 'Apply the owner policy.');
    assert.equal(supplied.type, 'choice');
    assert.deepEqual(
      provider === 'openai'
        ? supplied.choices.map((choice: any) => choice.value)
        : Object.keys(supplied.criteria),
      provider === 'openai' ? [true, false] : ['true', 'false'],
    );
    const recorded = usage.at(-1)!;
    assert.equal(recorded.status, 'succeeded');
    assert.equal(recorded.operation, 'action_check');
    assert.equal(recorded.inputTokens, 1000);
    assert.equal(recorded.costUsd, provider === 'openai' ? 0.0001 : 0.000042);
    assert.equal(recorded.pricing, 'sdk_estimate');
    assert.ok(recorded.durationMs >= 0);
  }
  assert.deepEqual(urls, [
    'https://api.openai.com/v1/decisions',
    'https://openrouter.ai/api/alpha/decisions',
    'https://api.typesafe.ai/v1/systemone',
  ]);
  reply = jev();
  await model.check({
    instructions: 'Apply the owner policy.',
    input,
    question: { ...question, instructions: 'Classify the action first.' },
  });
  assert.equal(
    calls.at(-1)!.body.questions.run.instructions,
    'Classify the action first.\nApply the owner policy.',
  );
  for (const provider of ['openai', 'openrouter', 'typesafe'] as const) {
    connection = { provider, key: 'fixture-key' };
    for (const value of ['yes', 'no', 'other']) {
      reply = {
        ...openai(value, 'answer'),
        answers:
          provider === 'openai'
            ? [{ type: 'choice', name: 'answer', choice: value }]
            : { answer: { type: 'choice', choice: value } },
      };
      assert.deepEqual(
        await model.check({
          instructions: 'Classify the reply.',
          input: { reply: 'Synthetic reply.' },
          question: {
            name: 'answer',
            choices: ['yes', 'no', 'other'].map((value) => ({ value, description: value })),
          },
        }),
        { answer: value },
      );
    }
  }
  connection = { provider: 'openrouter', key: 'fixture-key' };
  reply = { ...jev('true'), usage: { input_tokens: 1000, cost: 0.00007 } };
  assert.deepEqual(await check(), { run: true });
  assert.equal(usage.at(-1)?.costUsd, 0.00007);
  assert.equal(usage.at(-1)?.pricing, 'reported');
  const before = calls.length;
  connection = undefined;
  assert.equal(await check(), undefined);
  assert.equal(calls.length, before);
  connection = { provider: 'openai', key: 'fixture-key' };
  for (const invalid of [
    openai('true'),
    openai(true, 'different_question'),
    openai('other'),
    { ...openai(), answers: [] },
    { ...openai(), answers: [...openai().answers, ...openai().answers] },
    { ...openai(), answers: [{ type: 'refusal', name: 'run' }] },
    { ...openai(), usage: { input_tokens: -1 } },
    { answers: [{ type: 'choice', name: 'run', choice: true }] },
  ]) {
    reply = invalid;
    const count = calls.length;
    await assert.rejects(check(), /^Error: The decision service could not complete the check\.$/);
    assert.equal(calls.length, count + 1);
    assert.equal(usage.at(-1)?.status, 'failed');
  }
  for (const provider of ['openrouter', 'typesafe'] as const) {
    connection = { provider, key: 'fixture-key' };
    for (const answers of [
      { valid: { type: 'choice', choice: 'true' } },
      { run: { type: 'choice', choice: true } },
      { run: { type: 'choice', choice: 'yes' } },
      { run: { type: 'refusal' } },
    ]) {
      reply = { ...jev(), answers };
      await assert.rejects(check(), /could not complete/);
    }
  }
  reply = { secret: 'fixture-key private response body' };
  for (const code of [401, 429, 503]) {
    status = code;
    const count = calls.length;
    await assert.rejects(check(), /^Error: The decision service could not complete the check\.$/);
    assert.equal(calls.length, count + 1);
  }
  status = 307;
  redirect = `${origin}/stolen-key`;
  const redirects = calls.length;
  await assert.rejects(check(), /could not complete/);
  assert.equal(calls.length, redirects + 1);
  status = 200;
  redirect = undefined;
  invalidJson = true;
  await assert.rejects(check(), /could not complete/);
  invalidJson = false;
  const cancelled = new AbortController();
  cancelled.abort();
  const count = calls.length;
  await assert.rejects(check(cancelled.signal));
  assert.equal(calls.length, count);
  hold = true;
  const waiting = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const stop = new AbortController();
  const stopped = assert.rejects(check(stop.signal), /could not complete/);
  await waiting;
  stop.abort();
  await stopped;
  assert.equal(usage.at(-1)?.status, 'cancelled');
  assert.equal(new Set(usage.map(({ id }) => id)).size, usage.length);
  assert.doesNotMatch(JSON.stringify(usage), /fixture-key|final restriction|userMessages/);
});

test('decision routing uses the selected connection and never sends subscription credentials', async (t) => {
  const requests: Array<{ url: string; key: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    requests.push({ url: String(url), key: new Headers(options?.headers).get('authorization') });
    const openai = String(url).includes('api.openai.com');
    return Response.json({
      answers: openai
        ? [{ type: 'choice', name: 'run', choice: false }]
        : { run: { type: 'choice', choice: 'false' } },
      usage: { input_tokens: 100 },
    });
  });
  const { createDefaultAdapters } = await import('../src/server/composition.ts');
  const adapters = createDefaultAdapters({
    OTTO_FEEDBACK_ENABLED: 'false',
    OTTO_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  const models = adapters.models!;
  let selected: {
    provider: 'openai' | 'openrouter' | 'anthropic';
    method: 'api_key' | 'oauth' | 'subscription';
    key: string;
  } = { provider: 'openai', method: 'api_key', key: 'fixture-owner-one-key' };
  let reads = 0;
  Object.defineProperty(models, 'configured', { get: () => true });
  models.resolve = async () => {
    const current = { ...selected };
    return {
      ...current,
      definition: {
        choice: {
          id: 'fixture',
          name: 'Fixture',
          efforts: ['off'],
          images: false,
          contextWindow: 32_000,
        },
        spec: {},
      },
      effort: 'off',
      read: async () => {
        reads++;
        return current.method === 'subscription'
          ? {
              type: 'oauth',
              access: current.key,
              refresh: 'fixture-refresh',
              expires: Date.now() + 60_000,
              accountId: 'fixture-owner',
            }
          : { type: 'api_key', key: current.key };
      },
    };
  };
  const question: DecisionQuestion = {
    name: 'run',
    choices: [
      { value: true, description: 'Run.' },
      { value: false, description: 'Ask.' },
    ],
  };
  const check = () =>
    adapters.decisions!.check({ instructions: 'Apply policy.', input: {}, question });
  assert.deepEqual(await check(), { run: false });
  selected = { provider: 'openrouter', method: 'oauth', key: 'fixture-owner-two-key' };
  assert.deepEqual(await check(), { run: false });
  selected = { provider: 'openai', method: 'api_key', key: 'fixture-rotated-key' };
  assert.deepEqual(await check(), { run: false });
  const count = reads;
  for (const value of [
    { provider: 'anthropic', method: 'api_key', key: 'fixture-anthropic-key' },
    { provider: 'openai', method: 'subscription', key: 'fixture-subscription-token' },
  ] as const) {
    selected = value;
    assert.equal(await check(), undefined);
  }
  assert.equal(reads, count);
  assert.deepEqual(requests, [
    { url: 'https://api.openai.com/v1/decisions', key: 'Bearer fixture-owner-one-key' },
    { url: 'https://openrouter.ai/api/alpha/decisions', key: 'Bearer fixture-owner-two-key' },
    { url: 'https://api.openai.com/v1/decisions', key: 'Bearer fixture-rotated-key' },
  ]);
  const overridden = createDefaultAdapters({
    TYPESAFE_API_KEY: 'fixture-explicit-jev-key',
    OTTO_FEEDBACK_ENABLED: 'false',
  });
  overridden.models!.resolve = async () => {
    throw new Error('The override must not read another connection.');
  };
  assert.deepEqual(
    await overridden.decisions!.check({ instructions: 'Apply policy.', input: {}, question }),
    { run: false },
  );
  assert.deepEqual(requests.at(-1), {
    url: 'https://api.typesafe.ai/v1/systemone',
    key: 'Bearer fixture-explicit-jev-key',
  });
});

test('codemode heldout output preserves UTF-8 bytes and fails closed through the guard', async (t) => {
  const expected =
    Array.from(
      { length: 731 },
      (_, index) => `${String(index).padStart(4, '0')}|nível-π-🙂|${'abcXYZ09'.repeat(23)}\n`,
    ).join('') + 'END-OF-HELDOUT-OUTPUT';
  for (const mode of ['success', 'guard-refused', 'transfer-cleanup-failed'] as const)
    await t.test(mode, { timeout: 20_000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-codemode-holdout-'));
      const sdkTemporary = join(directory, 'sdk-temporary');
      const workspacePath = join(directory, 'workspace');
      await mkdir(sdkTemporary);
      await mkdir(workspacePath);
      const temporaryEnvironment = ['TMPDIR', 'TMP', 'TEMP'].map(
        (key) => [key, process.env[key]] as const,
      );
      for (const [key] of temporaryEnvironment) process.env[key] = sdkTemporary;
      let definition: ToolDefinition | undefined;
      let guardedRuns = 0;
      let recordedResults = 0;
      let workspaceCommands = 0;
      let transferAttempts = 0;
      let cleanupAttempts = 0;
      let observedSpill = false;
      const guardError = new Error('Synthetic owned turn guard refused execution.');
      const spills = async () =>
        (await readdir(sdkTemporary)).filter((name) => name.startsWith('pi-codemode-'));
      const agent = createPiAgent({
        provider: 'openai',
        apiKey: 'fixture-key',
        sessionRoot: join(directory, 'sessions'),
        createSession: async (options) => {
          definition = options!
            .resourceLoader!.getExtensions()
            .extensions.find((extension) => extension.tools.has('codemode'))!
            .tools.get('codemode')!.definition;
          return createAgentSession(options);
        },
      });
      try {
        await agent.open({
          ...fakeExecution(randomUUID(), randomUUID()),
          systemPrompt: 'Independent synthetic fixture',
          workspace: {
            path: workspacePath,
            instructions: 'Disposable workspace',
            exec: async (script, options) => {
              workspaceCommands += 1;
              if ((await spills()).length) observedSpill = true;
              if (script.startsWith('base64 -d ')) {
                transferAttempts += 1;
                if (mode === 'transfer-cleanup-failed') return { exitCode: 73 };
              }
              if (script.startsWith('rm -f --')) {
                cleanupAttempts += 1;
                if (mode === 'transfer-cleanup-failed')
                  throw new Error('Synthetic workspace cleanup failure.');
              }
              return new Promise((accept, reject) => {
                const child = spawn('/bin/sh', ['-c', script], {
                  cwd: workspacePath,
                  env: { PATH: '/usr/bin:/bin' },
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
                child.stdout.on('data', (chunk) => options?.onData?.(chunk));
                child.stderr.resume();
                child.once('error', reject);
                child.once('close', (code) => accept({ exitCode: code ?? 1 }));
                child.stdin.end(options?.input);
              });
            },
          },
          runTool: async (name, _params, run) => {
            assert.equal(name, 'codemode');
            if (mode === 'guard-refused') throw guardError;
            guardedRuns += 1;
            const result = await run();
            recordedResults += 1;
            const path = (result.details as { fullOutputPath: string }).fullOutputPath;
            assert.ok(path.startsWith(workspacePath + '/.otto/outputs/'));
            assert.equal(await readFile(path, 'utf8'), expected);
            assert.ok(!JSON.stringify(result).includes(sdkTemporary));
            assert.deepEqual(await spills(), []);
            return result;
          },
          tools: [],
          shouldStop: () => false,
          onEvent: () => {},
        });
        const execute = () =>
          definition!.execute(
            'independent-overflow-fixture',
            { code: `return ${JSON.stringify(expected)}` },
            undefined,
            undefined,
            undefined as never,
          );
        if (mode === 'success') {
          const result = await execute();
          const path = (result.details as { fullOutputPath: string }).fullOutputPath;
          assert.equal(await readFile(path, 'utf8'), expected);
          assert.equal(guardedRuns, 1);
          assert.equal(recordedResults, 1);
          assert.equal(transferAttempts, 1);
          assert.equal(observedSpill, true);
        } else if (mode === 'guard-refused') {
          await assert.rejects(execute, (error) => error === guardError);
          assert.equal(guardedRuns, 0);
          assert.equal(workspaceCommands, 0);
          assert.equal(recordedResults, 0);
          assert.equal(observedSpill, false);
        } else {
          await assert.rejects(execute, (error: Error) => {
            assert.ok(!error.message.includes(sdkTemporary));
            assert.ok(!error.message.includes(workspacePath));
            assert.ok(!error.message.includes('Synthetic workspace cleanup'));
            return true;
          });
          assert.equal(guardedRuns, 1);
          assert.equal(transferAttempts, 1);
          assert.equal(cleanupAttempts, 1);
          assert.equal(recordedResults, 0);
          assert.equal(observedSpill, true);
        }
        assert.deepEqual(await spills(), []);
      } finally {
        await agent.dispose();
        for (const [key, value] of temporaryEnvironment) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
});

test('every Otto tool schema reaches a model provider as a root object with its properties', () => {
  for (const tool of Object.values(toolDefinitions)) {
    const schema = tool.parameters as { type?: string; anyOf?: unknown; properties?: object };
    assert.equal(schema.type, 'object', tool.name);
    assert.equal(schema.anyOf, undefined, tool.name);
    assert.ok(schema.properties, tool.name);
  }
  const merged = rootObject(
    Type.Union([
      Type.Object({ id: Type.String(), origin: Type.String() }),
      Type.Object({ origin: Type.String(), kind: Type.Literal('otp') }),
    ]),
  ) as unknown as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(merged.properties).sort(), ['id', 'kind', 'origin']);
  assert.deepEqual(merged.required, ['origin']);
});

function codexFixtureAccess(accountId = 'fixture-owner') {
  return `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.signature`;
}

test('ChatGPT sign-in listens only on a free loopback callback before requesting tokens', async (t) => {
  for (const host of ['127.0.0.1', '::1'])
    await t.test(host, async (t) => {
      const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
      const { createServer, Server } = await import('node:http');
      const blocker = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once('error', reject);
          blocker.listen(0, host, resolve);
        });
      } catch (error) {
        if (
          host === '::1' &&
          error instanceof Error &&
          'code' in error &&
          ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(String(error.code))
        ) {
          t.skip('IPv6 loopback is unavailable.');
          return;
        }
        throw error;
      }
      const port = (blocker.address() as import('node:net').AddressInfo).port;
      const listen = Server.prototype.listen;
      const owned: import('node:http').Server[] = [];
      t.mock.method(
        Server.prototype,
        'listen',
        function (this: import('node:http').Server, ...args: unknown[]) {
          assert.equal(args[0], 1455);
          args[0] = port;
          owned.push(this);
          return Reflect.apply(listen, this, args);
        },
      );
      let requests = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        requests++;
        throw new Error('Unexpected network request');
      });
      const controller = new AbortController();
      let flow:
        Awaited<ReturnType<import('../src/ports/models.ts').ModelBackend['signIn']>> | undefined;
      t.after(async () => {
        controller.abort();
        await flow?.result.catch(() => {});
        for (const server of owned) {
          server.closeAllConnections();
          server.close();
        }
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      });
      await assert.rejects(
        createPiModelBackend()
          .signIn({ signal: controller.signal })
          .then((value) => {
            flow = value;
            return value;
          }),
        /another sign-in|already in use/,
      );
      assert.equal(flow, undefined);
      assert.equal(requests, 0);
      assert.ok(owned.every((server) => !server.listening));
      assert.equal(blocker.listening, true);
    });
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { Server } = await import('node:http');
  let binds = 0;
  t.mock.method(Server.prototype, 'listen', () => {
    binds++;
    throw new Error('Unexpected listener');
  });
  const previous = process.env.PI_OAUTH_CALLBACK_HOST;
  try {
    for (const host of ['0.0.0.0', '::', 'example.test', '127.0.0.2']) {
      process.env.PI_OAUTH_CALLBACK_HOST = host;
      await assert.rejects(
        createPiModelBackend().signIn({ signal: new AbortController().signal }),
        /loopback/,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.PI_OAUTH_CALLBACK_HOST;
    else process.env.PI_OAUTH_CALLBACK_HOST = previous;
  }
  assert.equal(binds, 0);
});

test('Pi ChatGPT sign-in validates callbacks, exchanges PKCE once and drains cancellation', async (t) => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { ModelAuthError } = await import('../src/ports/models.ts');
  const { Server } = await import('node:http');
  const listen = Server.prototype.listen;
  const originalFetch = globalThis.fetch;
  const servers: import('node:http').Server[] = [];
  let port = 0;
  let abortOnListen: AbortController | undefined;
  t.mock.method(
    Server.prototype,
    'listen',
    function (this: import('node:http').Server, ...args: unknown[]) {
      assert.equal(args[0], 1455);
      args[0] = servers.some((server) => server.listening) ? port : 0;
      servers.push(this);
      this.once('listening', () => {
        port = (this.address() as import('node:net').AddressInfo).port;
        abortOnListen?.abort();
      });
      return Reflect.apply(listen, this, args);
    },
  );
  const grants: URLSearchParams[] = [];
  let tokenStatus = 200;
  let holdExchange = false;
  let exchangeStarted!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') {
      assert.equal(url.port, String(port));
      return originalFetch(input, { ...init, headers: { connection: 'close' } });
    }
    assert.equal(url.href, 'https://auth.openai.com/oauth/token');
    grants.push(new URLSearchParams(String(init?.body)));
    if (holdExchange) {
      exchangeStarted();
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => reject(new Error('Canceled fixture-secret fixture-owner'));
        if (init?.signal?.aborted) cancel();
        else init?.signal?.addEventListener('abort', cancel, { once: true });
      });
    }
    return tokenStatus === 200
      ? Response.json({
          access_token: codexFixtureAccess('fixture-owner'),
          refresh_token: 'fixture-refresh',
          expires_in: 3600,
        })
      : Response.json(
          { error: 'fixture-secret fixture-owner fixture-refresh' },
          { status: tokenStatus },
        );
  });
  const backend = createPiModelBackend();
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  });
  const signIn = await backend.signIn({ signal: controller.signal });
  async function checkCallbackPage(response: Response, url: string, closes: boolean) {
    const html = await response.text();
    assert.doesNotMatch(html, /fixture-code|fixture-secret|fixture-refresh|fixture-owner/);
    const closed: string[] = [];
    let dispose = () => {};
    const dom = new JSDOM(html, {
      url,
      runScripts: 'dangerously',
      beforeParse(window) {
        dispose = window.close.bind(window);
        window.close = () => {
          closed.push(window.location.href);
        };
      },
    });
    try {
      const clean = new URL(url);
      clean.search = '';
      clean.hash = '';
      assert.equal(dom.window.location.href, clean.href);
      assert.deepEqual(closed, closes ? [clean.href] : []);
    } finally {
      dispose();
    }
  }
  const authorization = new URL(signIn.url);
  assert.equal(
    authorization.origin + authorization.pathname,
    'https://auth.openai.com/oauth/authorize',
  );
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({ state: signIn.state, code: 'fixture-code' }).toString();
  for (const invalid of [
    `${callback}&state=foreign`,
    `${callback}&code=second`,
    `${callback}&error=denied`,
    callback.href.replace(signIn.state, 'foreign'),
    callback.href.replace('localhost', '127.0.0.1'),
    callback.href.replace('/auth/callback', '/wrong'),
    `${callback}#fragment`,
  ])
    assert.throws(() => signIn.complete(new URL(invalid)), ModelAuthError);
  const wrong = new URL(`http://127.0.0.1:${port}/auth/callback?state=foreign&code=fixture-code`);
  const invalidResponse = await fetch(wrong);
  assert.equal(invalidResponse.status, 400);
  await checkCallbackPage(invalidResponse, wrong.href, false);
  assert.equal(grants.length, 0);
  for (const suffix of [
    `state=${signIn.state}&state=second&code=fixture-code`,
    `state=${signIn.state}&code=first&code=second`,
    `state=foreign&error=denied`,
    `state=${signIn.state}&code=first&error=denied`,
  ]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback?${suffix}`)).status, 400);
    assert.equal(grants.length, 0);
  }
  const local = new URL(callback);
  local.hostname = '127.0.0.1';
  local.port = String(port);
  const received = await fetch(local);
  assert.equal(received.status, 200);
  await checkCallbackPage(received, local.href, true);
  const credential = await signIn.result;
  assert.equal(credential.type, 'oauth');
  if (credential.type !== 'oauth') throw new Error('Expected OAuth.');
  assert.equal(credential.accountId, 'fixture-owner');
  assert.equal(credential.access, codexFixtureAccess('fixture-owner'));
  assert.equal(grants.length, 1);
  assert.equal(grants[0].get('grant_type'), 'authorization_code');
  assert.equal(grants[0].get('client_id'), authorization.searchParams.get('client_id'));
  assert.equal(grants[0].get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(
    createHash('sha256').update(grants[0].get('code_verifier')!).digest('base64url'),
    authorization.searchParams.get('code_challenge'),
  );
  assert.ok(servers.every((server) => !server.listening));
  assert.throws(() => signIn.complete(callback), /expired/);

  const manual = await backend.signIn({ signal: controller.signal });
  manual.complete(
    new URL(`http://localhost:1455/auth/callback?state=${manual.state}&code=manual-code`),
  );
  assert.equal((await manual.result).type, 'oauth');
  assert.equal(grants.at(-1)!.get('code'), 'manual-code');
  assert.ok(servers.every((server) => !server.listening));

  const cancel = new AbortController();
  const pending = await backend.signIn({ signal: cancel.signal });
  cancel.abort();
  await assert.rejects(pending.result, /canceled/);
  assert.ok(servers.every((server) => !server.listening));

  abortOnListen = new AbortController();
  await assert.rejects(backend.signIn({ signal: abortOnListen.signal }), /canceled/);
  assert.ok(servers.every((server) => !server.listening));
  abortOnListen = undefined;

  const declined = await backend.signIn({ signal: controller.signal });
  const beforeDeclined = grants.length;
  const declinedResult = assert.rejects(declined.result, /declined/);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${port}/auth/callback?state=${declined.state}&error=access_denied&error_description=fixture-secret`,
      )
    ).status,
    400,
  );
  await declinedResult;
  assert.equal(grants.length, beforeDeclined);
  assert.ok(servers.every((server) => !server.listening));

  tokenStatus = 403;
  const denied = await backend.signIn({ signal: controller.signal });
  denied.complete(
    new URL(`http://localhost:1455/auth/callback?state=${denied.state}&code=denied-code`),
  );
  await assert.rejects(denied.result, (error: Error) => {
    assert.ok(error instanceof ModelAuthError);
    assert.doesNotMatch(error.message, /fixture-secret|fixture-owner|fixture-refresh/);
    return true;
  });
  assert.ok(servers.every((server) => !server.listening));

  holdExchange = true;
  const started = new Promise<void>((resolve) => {
    exchangeStarted = resolve;
  });
  const interrupted = new AbortController();
  const active = await backend.signIn({ signal: interrupted.signal });
  active.complete(
    new URL(`http://localhost:1455/auth/callback?state=${active.state}&code=interrupted-code`),
  );
  await started;
  interrupted.abort();
  await assert.rejects(active.result, /canceled/);
  assert.ok(servers.every((server) => !server.listening));
});

test('Pi ChatGPT refresh distinguishes rejected credentials from transient service failures', async (t) => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { ModelAuthError } = await import('../src/ports/models.ts');
  const credential = {
    type: 'oauth' as const,
    access: codexFixtureAccess(),
    refresh: 'fixture-refresh',
    expires: 1,
    accountId: 'fixture-owner',
    email: 'fixture-previous@example.test',
  };
  let status = 200;
  let changed = false;
  let offline = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://auth.openai.com/oauth/token');
    assert.ok(init?.signal);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'fixture-refresh');
    if (offline) throw new Error('Offline fixture-refresh fixture-owner');
    return status === 200
      ? Response.json({
          access_token: codexFixtureAccess(changed ? 'foreign' : 'fixture-owner'),
          refresh_token: 'fixture-rotated',
          expires_in: 3600,
        })
      : Response.json({ error: 'invalid_grant fixture-refresh fixture-owner' }, { status });
  });
  const backend = createPiModelBackend();
  const renewed = await backend.refresh(credential);
  assert.equal(renewed.type, 'oauth');
  if (renewed.type !== 'oauth') throw new Error('Expected OAuth.');
  assert.equal(renewed.refresh, 'fixture-rotated');
  assert.equal(renewed.accountId, credential.accountId);
  for (const code of [400, 401, 403, 429, 500, 503]) {
    status = code;
    const before = calls;
    await assert.rejects(backend.refresh(credential), (error: Error) => {
      assert.ok(error instanceof ModelAuthError);
      assert.equal(error.requiresReconnect, [400, 401, 403].includes(code));
      assert.doesNotMatch(error.message, /fixture-refresh|fixture-owner/);
      return true;
    });
    assert.equal(calls, before + 1);
  }
  offline = true;
  await assert.rejects(
    backend.refresh(credential),
    (error: Error) => error instanceof ModelAuthError && !error.requiresReconnect,
  );
  offline = false;
  status = 200;
  changed = true;
  await assert.rejects(
    backend.refresh(credential),
    (error: Error) => error instanceof ModelAuthError && error.requiresReconnect,
  );
  const before = calls;
  await assert.rejects(
    backend.refresh({ ...credential, accountId: undefined } as unknown as typeof credential),
    /Reconnect/,
  );
  assert.equal(calls, before);
});

test('ChatGPT requests make one provider attempt and keep account tokens out of errors', async () => {
  const { createPiModelBackend, createPiModelRuntime } =
    await import('../src/providers/pi/models.ts');
  const access = codexFixtureAccess();
  const credential = {
    type: 'oauth' as const,
    access,
    refresh: 'fixture-refresh',
    expires: Date.now() + 3600000,
    accountId: 'fixture-owner',
  };
  const backend = createPiModelBackend({
    fetch: async () => Response.json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }),
  });
  const [definition] = await backend.catalog('openai', 'subscription', credential);
  const { runtime, model } = await createPiModelRuntime({
    provider: 'openai',
    method: 'subscription',
    definition,
    effort: 'high',
    read: async () => credential,
  });
  let calls = 0;
  const failed = await runtime.completeSimple(
    model,
    { messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }] },
    {
      maxRetries: 5,
      fetch: async () => {
        calls++;
        return Response.json(
          {
            error: {
              message: `Synthetic service failure ${access} fixture-refresh fixture-owner`,
              type: 'server_error',
            },
          },
          { status: 503 },
        );
      },
    },
  );
  assert.equal(failed.stopReason, 'error');
  assert.doesNotMatch(JSON.stringify(failed), /fixture-refresh|fixture-owner/);
  assert.ok(!JSON.stringify(failed).includes(access));
  assert.equal(calls, 1);
});

test('OpenRouter requests in both formats make one provider attempt', async () => {
  const { createPiModelBackend, createPiModelRuntime } =
    await import('../src/providers/pi/models.ts');
  const backend = createPiModelBackend({
    fetch: async (input) => {
      if (String(input) === 'https://openrouter.ai/api/v1/key')
        return Response.json({ data: { is_management_key: false } });
      return Response.json({
        data: ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5'].map((id) => ({
          id,
          name: id,
          context_length: 100000,
          supported_parameters: ['tools', 'reasoning'],
          reasoning: { supported_efforts: ['low', 'medium', 'high'] },
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          pricing: { prompt: '0.000002', completion: '0.00001' },
        })),
      });
    },
  });
  const definitions = await backend.catalog('openrouter', 'api_key', {
    type: 'api_key',
    key: 'fixture-router-key',
  });
  const apis = new Set<string>();
  for (const definition of definitions) {
    const { runtime, model } = await createPiModelRuntime({
      provider: 'openrouter',
      method: 'api_key',
      definition,
      effort: 'high',
      read: async () => ({ type: 'api_key', key: 'fixture-router-key' }),
    });
    apis.add(model.api);
    let calls = 0;
    const failed = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'Synthetic fixture', timestamp: 1 }] },
      {
        maxRetries: 5,
        fetch: async () => {
          calls++;
          return Response.json(
            { error: { type: 'rate_limit_error', message: 'Synthetic rate limit' } },
            { status: 429 },
          );
        },
      },
    );
    assert.equal(failed.stopReason, 'error');
    assert.equal(calls, 1, failed.errorMessage);
  }
  assert.equal(apis.size, 2);
});

test('the Pi transcript keeps model changes for the next turn and leaves background turns out', async () => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const backend = createPiModelBackend({
    fetch: async () => {
      throw new Error('Network access is disabled.');
    },
  });
  const openai = (await backend.catalog('openai', 'api_key')).find(
    (item) => item.choice.id === 'gpt-6.1-sol',
  )!;
  const anthropic = (await backend.catalog('anthropic', 'api_key')).find(
    (item) => item.choice.id === 'claude-opus-5-5',
  )!;
  const codex = (await backend.catalog('openai', 'subscription')).find(
    (item) => item.choice.id === 'gpt-6.1-sol',
  )!;
  const directory = await mkdtemp(join(tmpdir(), 'otto-model-switch-'));
  const requests: Array<{ provider: string; effort: string; history: string }> = [];
  let selected: import('../src/ports/models.ts').ModelAccess = {
    provider: 'openai',
    method: 'api_key',
    definition: openai,
    effort: 'high',
    read: async () => ({ type: 'api_key', key: 'fixture-openai-key' }),
  };
  const agent = createPiAgent({
    provider: 'openai',
    resolve: async () => selected,
    sessionRoot: directory,
    createSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (model, context) => {
        requests.push({
          provider: model.provider,
          effort: options?.thinkingLevel ?? 'off',
          history: JSON.stringify(context.messages),
        });
        const message: AssistantMessage = {
          ...fauxAssistantMessage([{ type: 'text', text: 'Synthetic answer' }]),
          provider: model.provider,
          model: model.id,
          api: model.api,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      };
      return result;
    },
  });
  const threadId = randomUUID();
  const open = (background = false) =>
    agent.open({
      ...fakeExecution(threadId, randomUUID()),
      systemPrompt: 'Fixture system',
      ...sandbox,
      tools: [],
      ephemeral: background,
      shouldStop: () => false,
      onEvent() {},
    });
  try {
    const first = await open();
    selected = {
      provider: 'anthropic',
      method: 'api_key',
      definition: anthropic,
      effort: 'medium',
      read: async () => ({ type: 'api_key', key: 'fixture-anthropic-key' }),
    };
    await first.prompt('Remember the synthetic blue label.', []);
    const background = await open(true);
    assert.equal(background.resumed, false);
    await background.prompt('Run the synthetic schedule.', []);
    await background.dispose();
    await first.dispose();
    const next = await open();
    assert.equal(next.resumed, true);
    await next.prompt('Use the previous label.', []);
    await next.dispose();
    assert.equal(requests[0].provider, 'openai');
    assert.equal(requests[0].effort, 'high');
    assert.ok(!requests[1].history.includes('Remember the synthetic blue label.'));
    assert.equal(requests[2].provider, 'anthropic');
    assert.equal(requests[2].effort, 'medium');
    assert.ok(requests[2].history.includes('Remember the synthetic blue label.'));
    assert.ok(requests[2].history.includes('Synthetic answer'));
    assert.ok(!requests[2].history.includes('Run the synthetic schedule.'));
    assert.ok(!requests[2].history.includes('fixture-openai-key'));
    assert.ok(!requests[2].history.includes('fixture-anthropic-key'));
    selected = {
      provider: 'openai',
      method: 'subscription',
      definition: codex,
      effort: 'high',
      read: async () => ({
        type: 'oauth',
        access: codexFixtureAccess(),
        refresh: 'fixture-refresh',
        expires: Date.now() + 3600000,
        accountId: 'fixture-owner',
      }),
    };
    const subscription = await open();
    await subscription.prompt('Use the ChatGPT plan for the same label.', []);
    await subscription.dispose();
    assert.equal(requests[3].provider, 'openai-codex');
    assert.equal(requests[3].effort, 'high');
    assert.ok(requests[3].history.includes('Remember the synthetic blue label.'));
    assert.ok(!requests[3].history.includes(codexFixtureAccess()));
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
