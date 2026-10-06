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
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  calculateCost,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { AgentSession, RuntimeContext } from '../src/ports/agent.ts';
import type { WorkspaceExecOptions, WorkspaceSession } from '../src/ports/computer.ts';
import type { PrivateObjectStore } from '../src/ports/object-storage.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import {
  closeInterruptedCalls,
  createPiCheckpoint,
  readPiSessionEntries,
  rebaseAt,
} from '../src/providers/pi/checkpoint.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createPiMemoryCurator } from '../src/providers/pi/memory-curator.ts';
import { createSandbox } from '../src/providers/pi/sandbox.ts';
import type { runProcess } from '../src/providers/process.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { inspectToolCatalog, rootObject } from '../src/runtime/tools.ts';
import { Type } from '@sinclair/typebox';
import { createBrowserFlows } from '../src/runtime/browser-flows.ts';
import { createBrowserFixture as createAgentBrowserComputer } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

// Pi sessions: abort/drain, credential pause and resume, native tools only via the sandbox.

const sandbox = {
  workspace: {
    path: '/workspace/fixture',
    instructions: 'Fixture',
    exec: async () => ({ exitCode: 0 }),
  },
  runTool: (_name: string, _params: unknown, run: () => Promise<{ content: [] }>) => run(),
};

test('Pi drains every session before reporting an abort failure and retries failed disposal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-disposal-'));
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const aborting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let opened = 0;
  let disposalAttempts = 0;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    const index = opened++;
    const abort = result.session.abort.bind(result.session);
    const dispose = result.session.dispose.bind(result.session);
    result.session.abort = async () => {
      events.push(`abort:${index}`);
      await abort();
      if (index === 0) throw new Error('private provider abort detail');
      started();
      await gate;
    };
    result.session.dispose = () => {
      events.push(`dispose:${index}`);
      if (index === 1 && disposalAttempts++ === 0)
        throw new Error('private provider disposal detail');
      dispose();
    };
    return result;
  };
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: factory,
  });
  try {
    for (let index = 0; index < 2; index += 1)
      await agent.open({
        threadId: randomUUID(),
        turnId: randomUUID(),
        systemPrompt: 'fixture',
        ...sandbox,
        tools: [],
        shouldStop: () => false,
        onEvent: () => {},
      });
    let finished = false;
    const stopping = Promise.resolve(agent.dispose()).then(
      () => {
        finished = true;
        return null;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    await aborting;
    assert.equal(finished, false);
    assert.ok(events.includes('dispose:0'));
    release();
    const error = await stopping;
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'The agent service could not finish cleaning up its sessions.');
    assert.deepEqual(events, ['abort:0', 'abort:1', 'dispose:0', 'dispose:1']);
    await agent.dispose();
    assert.deepEqual(events.slice(4), ['abort:1', 'dispose:1']);
    await agent.dispose();
    assert.equal(events.length, 6);
    await assert.rejects(
      agent.open({
        threadId: randomUUID(),
        turnId: randomUUID(),
        systemPrompt: 'fixture',
        ...sandbox,
        tools: [],
        shouldStop: () => false,
        onEvent: () => {},
      }),
      /service has stopped/,
    );
  } finally {
    release();
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real Pi sessions persist a credential pause and resume without replaying chat history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-'));
  const id = 'test-' + randomUUID();
  const replies: string[] = [];
  const prompts: string[] = [];
  let managed = 0;
  let phase = 0;
  const context: RuntimeContext = {
    threadId: id,
    turnId: randomUUID(),
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
    assert.deepEqual(options?.resourceLoader?.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(
      options?.resourceLoader
        ?.getExtensions()
        .extensions.flatMap((extension) => [...extension.tools.keys()]),
      ['web_search', 'source_check', 'fetch_content', 'get_search_content', 'codemode'],
    );
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
                  name: 'get_credential',
                  arguments: {
                    origin: 'https://example.com',
                    label: 'Example',
                    kind: 'password',
                    passwordSelector: '#password',
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
          item.role === 'user' && JSON.stringify(item.content).includes('Older fixture context'),
      ).length,
      1,
    );
    assert.equal(prompts[1].includes('runtime-fixture-key'), false);
    assert.equal(replies.length, 2);
    assert.match(replies[0], /\[Add password\]\(\/credentials\/fixture\)/);
    assert.equal(replies[1], 'Resumed successfully.');
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('messages taken after a Pi turn reach the next request together and not after a question', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-steer-'));
  const requests: string[] = [];
  const replies: string[] = [];
  const batches = [
    [
      { id: randomUUID(), text: 'Also check the second fixture' },
      { id: randomUUID(), text: 'And the third fixture' },
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
    batches.push([{ id: randomUUID(), text: 'Sent while asking' }]);
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

const nativeNames = ['read', 'bash', 'edit', 'write', 'find', 'ls'];

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
    assert.deepEqual(
      agent.nativeTools?.map((tool) => tool.name),
      nativeNames,
    );
    const session = await agent.open({
      threadId: randomUUID(),
      turnId: randomUUID(),
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
    const names = captured!.customTools!.map((tool) => tool.name);
    assert.deepEqual(names, [...nativeNames, 'fixture_tool']);
    assert.deepEqual(captured!.tools, [
      ...names,
      'web_search',
      'source_check',
      'fetch_content',
      'get_search_content',
      'codemode',
    ]);
    assert.equal(captured!.noTools, 'builtin');
    assert.equal(captured!.cwd, workspace.path);
    const before = scripts.length;
    const ls = captured!.customTools!.find((tool) => tool.name === 'ls')!;
    const result = await ls.execute('call', {}, undefined, undefined, undefined as never);
    assert.deepEqual(ran, ['ls']);
    assert.match(JSON.stringify(result.content), /empty directory/);
    assert.ok(scripts.length > before);
    assert.ok(scripts.slice(before).every((script) => script.includes(workspace.path)));
    const extension = captured!
      .resourceLoader!.getExtensions()
      .extensions.find((item) => item.tools.has('web_search'))!;
    const storedContent = extension.tools.get('get_search_content')!;
    const missing = await storedContent.definition.execute(
      'call',
      { responseId: 'synthetic-missing' },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match(JSON.stringify(missing.content), /No stored results/);
    assert.deepEqual(ran, ['ls', 'get_search_content']);
    const webSearch = extension.tools.get('web_search')!;
    assert.equal(
      'workflow' in
        (webSearch.definition.parameters as { properties: Record<string, unknown> }).properties,
      false,
    );
    const direct = await webSearch.definition.execute(
      'call',
      { workflow: 'summary-review' },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match(JSON.stringify(direct.content), /No query provided/);
    assert.deepEqual(ran, ['ls', 'get_search_content', 'web_search']);
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
      threadId: randomUUID(),
      turnId: randomUUID(),
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

function dangling(
  manager: SessionManager,
  answered: string[],
  stopReason: 'toolUse' | 'aborted' | 'error' = 'toolUse',
) {
  manager.appendMessage({ role: 'user', content: 'Run two actions', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant',
    api: 'openai-responses',
    provider: 'openai',
    model: 'fixture',
    timestamp: 2,
    stopReason,
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

test('closeInterruptedCalls leaves aborted and failed assistant messages alone because Pi never replays them', () => {
  for (const stopReason of ['aborted', 'error'] as const) {
    const manager = SessionManager.inMemory('/fixture');
    dangling(manager, [], stopReason);
    closeInterruptedCalls(manager);
    assert.equal(toolResults(manager).length, 0, stopReason);
  }
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

test('the bug report reads only the requested saved Pi session', async () => {
  const f = await fixture();
  try {
    const checkpoint = await createPiCheckpoint({
      store: f.store,
      threadId: f.threadId,
      directory: f.directory,
    });
    checkpoint.manager.appendMessage({
      role: 'user',
      content: 'Saved fixture question',
      timestamp: Date.now(),
    });
    await checkpoint.checkpoint();
    const saved = await readPiSessionEntries({
      threadId: f.threadId,
      sessionRoot: f.directory,
      objectStore: f.store,
    });
    assert.match(JSON.stringify(saved), /Saved fixture question/);
    assert.equal(
      (
        await readPiSessionEntries({
          threadId: randomUUID(),
          sessionRoot: f.directory,
          objectStore: f.store,
        })
      ).length,
      0,
    );
    const localRoot = join(f.directory, 'local');
    const localDirectory = join(localRoot, f.threadId);
    await mkdir(localDirectory, { recursive: true });
    const localManager = SessionManager.continueRecent(localDirectory, localDirectory);
    localManager.appendMessage({
      role: 'user',
      content: 'Local fixture question',
      timestamp: Date.now(),
    });
    dangling(localManager, []);
    assert.equal(localManager.getSessionDir(), localDirectory);
    assert.ok((await readdir(localDirectory)).some((name) => name.endsWith('.jsonl')));
    const local = await readPiSessionEntries({ threadId: f.threadId, sessionRoot: localRoot });
    assert.match(JSON.stringify(local), /Local fixture question/);
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
      threadId: f.threadId,
      turnId: randomUUID(),
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
      threadId: f.threadId,
      turnId: randomUUID(),
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
      threadId: f.threadId,
      turnId: randomUUID(),
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
      threadId: f.threadId,
      turnId: randomUUID(),
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
shift, shift if $ARGV[0] eq '-k';
my $seconds = shift;
my $pid = fork;
if (!$pid) { exec @ARGV; exit 127 }
$SIG{ALRM} = sub { kill 'KILL', $pid; exit 124 };
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
  const calls: Array<{ command: string; options: string[] }> = [];
  const workspace: WorkspaceSession = {
    path: `${prefix}/workspace`,
    instructions: 'Fixture sandbox.',
    exec(command: string, options: WorkspaceExecOptions = {}) {
      calls.push({ command, options: Object.keys(options).sort() });
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
  return { prefix, root, workspace, calls, tools, run };
}

test('native Pi tools run only through workspace exec on sandbox paths that do not exist on the host', async (t) => {
  const { prefix, calls, tools, run } = await hostSandbox(t);
  assert.equal(existsSync(prefix), false);
  assert.deepEqual(Object.keys(tools).sort(), ['bash', 'edit', 'find', 'ls', 'read', 'write']);
  assert.match(
    await run('write', { path: 'notes/a.txt', content: 'alpha\nbeta\n' }),
    /Successfully wrote/,
  );
  assert.equal(await run('read', { path: 'notes/a.txt' }), 'alpha\nbeta\n');
  await run('edit', { path: 'notes/a.txt', edits: [{ oldText: 'beta', newText: 'gamma' }] });
  assert.equal(await run('read', { path: `${prefix}/workspace/notes/a.txt` }), 'alpha\ngamma\n');
  assert.equal(await run('ls', {}), 'notes/');
  assert.equal(await run('ls', { path: 'notes' }), 'a.txt');
  assert.equal(await run('find', { pattern: '*.txt' }), 'notes/a.txt');
  assert.equal((await run('bash', { command: 'pwd' })).trim(), `${prefix}/workspace`);
  await assert.rejects(run('read', { path: 'missing.txt' }), /not found or not readable/);
  assert.ok(calls.length >= 8);
  assert.ok(
    calls.every(({ options }) =>
      options.every((key) => ['input', 'onData', 'signal', 'timeoutMs', 'notices'].includes(key)),
    ),
  );
  assert.equal(existsSync(prefix), false);
});

test('write refuses to replace a directory instead of moving the file into it', async (t) => {
  const { root, run } = await hostSandbox(t);
  await mkdir(join(root, 'workspace/reports'));
  await assert.rejects(run('write', { path: 'reports', content: 'x' }), /Could not write/);
  assert.deepEqual(await readdir(join(root, 'workspace/reports')), []);
  assert.deepEqual(await readdir(join(root, 'workspace')), ['reports']);
});

test('browser flows stay discoverable after a thread reset and stop when a page changes', async (t) => {
  const { prefix, root, workspace, run: nativeRun } = await hostSandbox(t);
  const actions: string[] = [];
  const fills: string[] = [];
  let page = 'Search box';
  const computer = fakeComputer({
    act: async (_id, action) => {
      actions.push(action.action);
      if (action.action === 'fill') fills.push(action.text ?? '');
      if (action.action === 'open') page = 'Search box';
      if (action.action === 'fill') page = 'Search results';
      if (action.action === 'click') page = 'Result page';
      return {
        url: 'https://market.example.test/search',
        text: page,
      };
    },
  });
  const run = createBrowserFlows(workspace, computer, 'first-thread', new AbortController().signal);
  assert.deepEqual(await run({ action: 'list' }), { flows: [], invalid: [] });
  assert.equal(existsSync(join(root, '.otto')), false);
  const flow = {
    id: 'bike-watch',
    title: 'Find used bikes',
    description: 'Search the bike marketplace for a saved watch.',
    origin: 'https://market.example.test/',
    inputs: { query: 'Search words' },
    steps: [
      {
        action: { action: 'open' as const, url: 'https://market.example.test/search' },
        expectText: 'Search box',
      },
      {
        action: { action: 'fill' as const, selector: '#search', text: '{{query}}' },
        expectText: 'Expected results',
      },
      { action: { action: 'click' as const, selector: '#next' } },
      { action: { action: 'snapshot' as const }, expectText: 'Result page' },
    ],
  };
  const saved = await run({ action: 'save', flow });
  assert.match(JSON.stringify(saved), /\/\.otto\/browser-flows\/bike-watch\.json/);
  assert.equal(existsSync(prefix), false);
  assert.equal(
    JSON.parse(await readFile(join(root, '.otto/browser-flows/bike-watch.json'), 'utf8')).id,
    'bike-watch',
  );
  assert.match(
    await nativeRun('ls', { path: `${prefix}/.otto/browser-flows` }),
    /bike-watch\.json/,
  );
  await run({
    action: 'save',
    flow: {
      id: 'car-listings',
      title: 'Find used cars',
      description: 'Check a car listing site.',
      origin: 'https://cars.example.test/',
      inputs: {},
      steps: [
        { action: { action: 'open', url: 'https://cars.example.test/' } },
        { action: { action: 'snapshot' }, expectText: 'Cars' },
      ],
    },
  });
  await mkdir(join(root, 'second-thread'));
  const afterReset = createBrowserFlows(
    { ...workspace, path: `${prefix}/second-thread` },
    computer,
    'second-thread',
    new AbortController().signal,
  );
  const registry = await afterReset({ action: 'list', query: 'cars listings' });
  assert.equal((registry as { flows: Array<{ id: string }> }).flows[0].id, 'car-listings');
  assert.equal((registry as { flows: Array<{ id: string }> }).flows.length, 2);
  const paused = await afterReset({
    action: 'run',
    id: 'bike-watch',
    inputs: { query: 'restomod' },
  });
  assert.equal((paused as { status: string }).status, 'needs_repair');
  assert.deepEqual(actions, ['open', 'fill']);
  await afterReset({
    action: 'save',
    flow: {
      ...flow,
      steps: flow.steps.map((step) =>
        step.action.action === 'fill' ? { ...step, expectText: 'Search results' } : step,
      ),
    },
  });
  const completed = await afterReset({
    action: 'run',
    id: 'bike-watch',
    inputs: { query: 'restomod' },
  });
  assert.equal((completed as { status: string }).status, 'completed');
  assert.deepEqual(actions, ['open', 'fill', 'open', 'fill', 'click', 'snapshot']);
  assert.deepEqual(fills, ['restomod', 'restomod']);
  await assert.rejects(
    run({
      action: 'save',
      flow: {
        ...flow,
        steps: [
          flow.steps[0],
          { action: { action: 'fill', selector: '#password', text: 'stored-secret' } },
          flow.steps.at(-1)!,
        ],
      },
    }),
    /named input/,
  );
  await assert.rejects(
    run({
      action: 'save',
      flow: {
        ...flow,
        steps: [
          flow.steps[0],
          { action: { action: 'click', selector: '@e12' } },
          flow.steps.at(-1)!,
        ],
      },
    }),
    /stable selector/,
  );
  await assert.rejects(
    run({
      action: 'save',
      flow: {
        ...flow,
        steps: [
          { action: { action: 'open', url: 'https://user:secret@market.example.test/search' } },
          flow.steps.at(-1)!,
        ],
      },
    }),
    /URL credentials/,
  );
  await assert.rejects(
    run({
      action: 'save',
      flow: {
        ...flow,
        steps: [
          flow.steps[0],
          {
            action: { action: 'snapshot' },
            expectUrl: 'https://user:secret@market.example.test/search',
          },
        ],
      },
    }),
    /URL credentials/,
  );
  const library = join(root, '.otto/browser-flows');
  for (let index = 0; index < 101; index++) {
    const id = `old-flow-${index}`;
    await writeFile(
      join(library, `${id}.json`),
      JSON.stringify({
        ...flow,
        id,
        title: 'Old routine',
        description: 'Archived site routine.',
      }),
    );
  }
  await writeFile(
    join(library, 'z-last.json'),
    JSON.stringify({
      ...flow,
      id: 'z-last',
      title: 'Late unique listing',
      description: 'A later site routine.',
    }),
  );
  const fullRegistry = await afterReset({ action: 'list', query: 'late unique' });
  assert.equal((fullRegistry as { flows: Array<{ id: string }> }).flows[0].id, 'z-last');
  assert.equal((fullRegistry as { flows: Array<{ id: string }> }).flows.length, 104);
});

test('a saved flow uses the current agent-browser session on a synthetic page', async (t) => {
  const { root, workspace } = await hostSandbox(t);
  const fixture = stagedLoginBrowser();
  const computer = createAgentBrowserComputer({ dataRoot: root, run: fixture.run });
  t.after(() => computer.dispose());
  const flows = createBrowserFlows(
    workspace,
    computer,
    'flow-fixture',
    new AbortController().signal,
  );
  await flows({
    action: 'save',
    flow: {
      id: 'search-page',
      title: 'Open the search page',
      description: 'Enter a search phrase on the synthetic site.',
      origin: 'https://1.1.1.1/',
      inputs: { query: 'Search phrase' },
      steps: [
        {
          action: { action: 'open', url: 'https://1.1.1.1/login' },
          expectText: 'Sign in identifier',
        },
        { action: { action: 'fill', selector: '#search', text: '{{query}}' } },
        { action: { action: 'snapshot' }, expectText: '{{query}}' },
      ],
    },
  });
  const result = await flows({
    action: 'run',
    id: 'search-page',
    inputs: { query: 'restomod bike' },
  });
  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(fixture.pages.get('flow-fixture')?.search.value, 'restomod bike');
  const second = await flows({
    action: 'run',
    id: 'search-page',
    inputs: { query: 'vintage frame' },
  });
  assert.equal((second as { status: string }).status, 'completed');
  assert.equal(fixture.pages.get('flow-fixture')?.search.value, 'vintage frame');
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
  assert.match(failure, /Command exited with code 3/);
  await assert.rejects(
    run('bash', { command: 'sleep 5', timeout: 1 }),
    /timed out after 1 seconds/,
  );
  assert.match(await run('bash', { command: 'exit 124' }), /Command exited with code 124/);
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('pi-bash-'));
  assert.deepEqual(after, before);
});

test('find honors exclusions and a failed chunked write leaves the existing file intact', async (t) => {
  const { root, workspace, run } = await hostSandbox(t);
  await mkdir(join(root, 'workspace/node_modules/pkg'), { recursive: true });
  await mkdir(join(root, 'workspace/.git'), { recursive: true });
  await writeFile(join(root, 'workspace/node_modules/pkg/hidden.txt'), 'x');
  await writeFile(join(root, 'workspace/.git/hidden.txt'), 'x');
  await writeFile(join(root, 'workspace/kept.txt'), 'original');
  assert.equal(await run('find', { pattern: '*.txt' }), 'kept.txt');
  const exec = workspace.exec;
  workspace.exec = (command, options) =>
    command.includes('>>') ? Promise.resolve({ exitCode: 1 }) : exec(command, options);
  await assert.rejects(run('write', { path: 'kept.txt', content: 'y'.repeat(600 * 1024) }));
  assert.equal(await readFile(join(root, 'workspace/kept.txt'), 'utf8'), 'original');
  assert.deepEqual(
    (await readdir(join(root, 'workspace'))).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('bash runs in the owner time zone and receives nothing else from the host', async (t) => {
  process.env.OTTO_TEST_PROVIDER_KEY = 'sk-test-secret';
  t.after(() => delete process.env.OTTO_TEST_PROVIDER_KEY);
  const { workspace, run } = await hostSandbox(t);
  const bash = createSandbox(workspace, 'Asia/Kolkata').find(({ name }) => name === 'bash')!;
  const result = await bash.execute(
    randomUUID(),
    { command: 'date +%z; echo "[$OTTO_TEST_PROVIDER_KEY]"' },
    undefined,
    undefined,
    undefined as never,
  );
  const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  assert.equal(text.trim(), '+0530\n[]');
  assert.equal((await run('bash', { command: 'echo "[$TZ]"' })).trim(), '[]');
});

test('bash receives no host environment and small outputs leave no saved file', async (t) => {
  process.env.OTTO_TEST_PROVIDER_KEY = 'sk-test-secret';
  t.after(() => delete process.env.OTTO_TEST_PROVIDER_KEY);
  const { root, calls, run } = await hostSandbox(t);
  assert.equal((await run('bash', { command: 'echo "[$OTTO_TEST_PROVIDER_KEY]"' })).trim(), '[]');
  assert.ok(calls.every(({ command }) => !command.includes('sk-test-secret')));
  assert.deepEqual(await readdir(join(root, 'workspace/.otto/outputs')), []);
});

// Runtime: credential guard in observations, one active turn, stop and shutdown drain.

function browserFixture() {
  const commands: string[][] = [];
  const launches: string[][] = [];
  const png = Buffer.from('fixture-png');
  const dom = new JSDOM('<input id="password" type="password">', {
    url: 'https://1.1.1.1/',
    runScripts: 'outside-only',
  });
  dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  const run: typeof runProcess = async (_executable, args, options) => {
    launches.push(args);
    const command = args.slice(args.indexOf('--idle-timeout') + 2);
    commands.push(command);
    let data: Record<string, unknown> = {};
    if (command[0] === 'get')
      data =
        command[1] === 'url'
          ? { url: 'https://1.1.1.1/' }
          : {
              value:
                dom.window.document.querySelector(command[2])?.getAttribute(command[3]) ?? null,
            };
    if (command[0] === 'eval') data = { result: dom.window.eval(options?.input ?? '') };
    if (command[0] === 'fill') {
      const node = dom.window.document.querySelector<HTMLInputElement>(command[1]);
      if (node) node.value = command[2];
    }
    if (command[0] === 'snapshot')
      data = {
        snapshot:
          '- paragraph: Readable article body. fixture-secret\n- textbox "Password" [ref=e1]: fixture-secret\n- button "Continue" [ref=e2]',
        refs: {
          e1: { role: 'textbox', name: 'Password' },
          e2: { role: 'button', name: 'Continue' },
        },
      };
    if (command[0] === 'screenshot') await writeFile(command[1], png);
    return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
  };
  return { run, commands, launches, png, dom };
}

test('computer observations retain body text, normalize controls, protect credentials and return screenshot bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-computer-'));
  const fixture = browserFixture();
  const protocol: Record<string, unknown>[] = [];
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => protocol.push(command),
  });
  try {
    const page = await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/' });
    assert.match(page.text, /Readable article body/);
    assert.deepEqual(
      protocol.filter((command) => command.action === 'snapshot'),
      [{ action: 'snapshot', compact: true }],
    );
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      password: 'fixture-secret',
      passwordSelector: '#password',
    });
    assert.equal(
      fixture.dom.window.document.querySelector<HTMLInputElement>('#password')!.value,
      'fixture-secret',
    );
    assert.equal(
      (await computer.act('fixture', { action: 'snapshot' })).text.includes('fixture-secret'),
      false,
    );
    for (const action of ['fill', 'type'] as const)
      await assert.rejects(
        computer.act('fixture', { action, selector: '#password', text: 'other' }),
        /secure credential/,
      );
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    await computer.close('fixture');
    assert.deepEqual(await computer.screenshot('fixture'), fixture.png);
    assert.equal(computer.screenStatus?.('fixture').state, 'last_known');
    assert.equal(fixture.commands.filter((command) => command[0] === 'close').length, 1);
  } finally {
    await computer.dispose();
    fixture.dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function context(directory: string): RuntimeContext {
  return {
    threadId: 'fixture',
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
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
}

test('concurrent turns on one thread take the browser one turn at a time', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-turns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const order: string[] = [];
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queued!: () => void;
  const waiting = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const runtime = createAgentRuntime({
    agent: {
      open: async (input) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async () => {
          order.push(`${input.turnId} started`);
          if (input.turnId === 'schedule') queued();
          await input.tools
            .find((tool) => tool.name === 'browser')!
            .execute({ action: 'snapshot' });
          order.push(`${input.turnId} browser`);
          if (input.turnId === 'conversation') {
            entered();
            await held;
          }
        },
      }),
      dispose() {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    const conversation = runtime.runTurn({ ...context(directory), turnId: 'conversation' });
    await holding;
    const schedule = runtime.runTurn({
      ...context(directory),
      turnId: 'schedule',
      background: true,
    });
    await waiting;
    await setTimeout(50);
    assert.deepEqual(order, ['conversation started', 'conversation browser', 'schedule started']);
    assert.equal(runtime.status().activeTurns, 2);
    release();
    await Promise.all([conversation, schedule]);
    assert.deepEqual(order.slice(3), ['schedule browser']);
  } finally {
    release();
    await runtime.dispose();
  }
});

test('stalled observations release active tasks on cancellation and disposal', async (t) => {
  for (const method of ['cancel', 'dispose'] as const) {
    await t.test(method, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-stalled-observer-'));
      const controller = new AbortController();
      let entered!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let rejectObservation!: (error: Error) => void;
      const stalled = new Promise<void>((_resolve, reject) => {
        rejectObservation = reject;
      });
      let executed = false;
      const runtime = createAgentRuntime({
        agent: {
          open: async (input) => ({
            resumed: false,
            abort: () => {},
            dispose: () => {},
            prompt: async () => {
              await input.tools
                .find((tool) => tool.name === 'apps')!
                .execute({ action: 'FIXTURE_ACTION', args: {} });
              executed = true;
            },
          }),
          dispose: () => {},
        },
        computer: fakeComputer(),
        workspace: fakeWorkspace(),
      });
      const running = runtime
        .runTurn({
          ...context(directory),
          signal: controller.signal,
          observe: async () => {
            entered();
            return stalled;
          },
          integration: async () => {
            executed = true;
            return {};
          },
        })
        .then(
          () => 'succeeded',
          (error: unknown) => error,
        );
      try {
        await observed;
        const disposing =
          method === 'dispose' ? runtime.dispose() : Promise.resolve(controller.abort());
        const completed = await Promise.race([
          Promise.all([running, disposing]),
          setTimeout(250).then(() => null),
        ]);
        assert.ok(completed, 'A stalled optional observer blocked cancellation');
        assert.match(String(completed[0]), /cancelled/);
        assert.equal(runtime.status().activeTurns, 0);
        assert.equal(executed, false);
        rejectObservation(new Error('Late private observer failure'));
        await setTimeout(0);
      } finally {
        rejectObservation(new Error('Fixture observer cleanup'));
        controller.abort();
        await running;
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
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
          events.push('abort');
          finish();
        },
        dispose: () => {
          events.push('session');
        },
      }),
      dispose: () => {
        events.push('agent');
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
  await assert.rejects(disposal, /Some runtime resources could not close/);
  await running;
  assert.equal(runtime.status().activeTurns, 0);
  assert.equal(events.filter((value) => value === 'computer').length, 1);
  assert.equal(events.filter((value) => value === 'workspace').length, 1);
  assert.ok(events.indexOf('session') < events.indexOf('computer'));
  assert.ok(events.indexOf('computer') < events.indexOf('workspace'));
  await assert.rejects(runtime.runTurn(context(directory)), /stopped/);
});

test('turn tool limits fence custom and native execution through the same budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-tool-budget-'));
  let appCalls = 0;
  let nativeCalls = 0;
  let aborts = 0;
  const runtime = createAgentRuntime({
    agent: {
      open: async (options) => ({
        resumed: false,
        prompt: async () => {
          const apps = options.tools.find((tool) => tool.name === 'apps')!;
          await options.runTool('read', { path: 'fixture.txt' }, async () => {
            nativeCalls++;
            return { content: [] };
          });
          await apps.execute({ action: 'FIXTURE_READ', args: {} });
          await assert.rejects(
            apps.execute({ action: 'FIXTURE_READ', args: {} }),
            /tool-call limit/,
          );
          await assert.rejects(
            options.runTool('bash', { command: 'unused' }, async () => {
              nativeCalls++;
              return { content: [] };
            }),
            /tool-call limit/,
          );
        },
        abort: () => {
          aborts++;
        },
        dispose: () => {},
      }),
      dispose: () => {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    await assert.rejects(
      runtime.runTurn({
        ...context(directory),
        limits: { maxToolCalls: 2, timeoutMs: 1000 },
        integration: async () => {
          appCalls++;
          return { items: [] };
        },
      }),
      /tool-call limit/,
    );
    assert.equal(appCalls, 1);
    assert.equal(nativeCalls, 1);
    assert.equal(aborts, 1);
    assert.equal(runtime.status().activeTurns, 0);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('turn deadlines release stalled model, provider, native and disposal operations', async (t) => {
  for (const stalledAt of ['model', 'provider', 'native', 'dispose'] as const) {
    await t.test(stalledAt, { timeout: 1500 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-time-budget-'));
      let aborted = false;
      let providerSignal: AbortSignal | undefined;
      let workspaceSignal: AbortSignal | undefined;
      const stalled = new Promise<never>(() => {});
      const workspace = fakeWorkspace();
      const runtime = createAgentRuntime({
        agent: {
          open: async (options) => ({
            resumed: false,
            prompt: async () => {
              if (stalledAt === 'model') await stalled;
              if (stalledAt === 'provider')
                await options.tools
                  .find((tool) => tool.name === 'apps')!
                  .execute({ action: 'FIXTURE_READ', args: {} });
              if (stalledAt === 'native')
                await options.runTool('read', { path: 'fixture.txt' }, () => stalled);
            },
            abort: () => {
              aborted = true;
            },
            dispose: () => (stalledAt === 'dispose' ? stalled : undefined),
          }),
          dispose: () => {},
        },
        computer: fakeComputer(),
        workspace: {
          ...workspace,
          open: (input) => {
            workspaceSignal = input.signal;
            return workspace.open(input);
          },
        },
      });
      try {
        const running = runtime.runTurn({
          ...context(directory),
          limits: { maxToolCalls: 8, timeoutMs: 30 },
          integration: async (_action, _args, signal) => {
            providerSignal = signal;
            return stalled;
          },
        });
        if (stalledAt === 'dispose') await running;
        else await assert.rejects(running, /time limit/);
        assert.equal(runtime.status().activeTurns, 0);
        assert.equal(workspaceSignal?.aborted, true);
        if (stalledAt !== 'dispose') assert.equal(aborted, true);
        if (stalledAt === 'provider') assert.equal(providerSignal?.aborted, true);
      } finally {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('a delayed instrumentation callback cannot begin a tool after its turn deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-delayed-tool-'));
  let delayed: (() => unknown) | undefined;
  let providerCalls = 0;
  const runtime = createAgentRuntime({
    agent: {
      open: async (options) => ({
        resumed: false,
        prompt: async () => {
          await options.tools
            .find((tool) => tool.name === 'apps')!
            .execute({ action: 'FIXTURE_READ', args: {} });
        },
        abort: () => {},
        dispose: () => {},
      }),
      dispose: () => {},
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
    withTool: <T>(_turnId: string, _toolCallId: string, _toolName: string, action: () => T): T => {
      delayed = action;
      return new Promise<never>(() => {}) as T;
    },
  });
  try {
    await assert.rejects(
      runtime.runTurn({
        ...context(directory),
        limits: { maxToolCalls: 8, timeoutMs: 30 },
        integration: async () => {
          providerCalls++;
          return { items: [] };
        },
      }),
      /time limit/,
    );
    assert.ok(delayed);
    assert.throws(delayed, /time limit/);
    assert.equal(providerCalls, 0);
    assert.equal(runtime.status().activeTurns, 0);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a session that opens after its deadline is aborted and disposed without receiving a prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-late-session-'));
  let finishOpening!: (session: AgentSession) => void;
  const opening = new Promise<AgentSession>((resolve) => {
    finishOpening = resolve;
  });
  const events: string[] = [];
  const runtime = createAgentRuntime({
    agent: { open: () => opening, dispose: () => {} },
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    await assert.rejects(
      runtime.runTurn({ ...context(directory), limits: { maxToolCalls: 8, timeoutMs: 30 } }),
      /time limit/,
    );
    assert.equal(runtime.status().activeTurns, 0);
    finishOpening({
      resumed: false,
      prompt: async () => {
        events.push('prompt');
      },
      abort: () => {
        events.push('abort');
      },
      dispose: () => {
        events.push('dispose');
      },
    });
    await setTimeout(0);
    assert.deepEqual(events, ['abort', 'dispose']);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'completed and failed turns clear their deadline instead of aborting disposed sessions later',
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const directory = await mkdtemp(join(tmpdir(), 'otto-cleared-deadline-'));
    const signals: AbortSignal[] = [];
    let prompts = 0;
    let aborts = 0;
    const workspace = fakeWorkspace();
    const runtime = createAgentRuntime({
      agent: {
        open: async () => ({
          resumed: false,
          prompt: async () => {
            if (++prompts === 2) throw new Error('Synthetic model failure');
          },
          abort: () => {
            aborts++;
          },
          dispose: () => {},
        }),
        dispose: () => {},
      },
      computer: fakeComputer(),
      workspace: {
        ...workspace,
        open: (input) => {
          signals.push(input.signal);
          return workspace.open(input);
        },
      },
    });
    try {
      const input = {
        ...context(directory),
        signal: t.signal,
        limits: { maxToolCalls: 8, timeoutMs: 30 },
      };
      await runtime.runTurn(input);
      await assert.rejects(runtime.runTurn(input), /Synthetic model failure/);
      t.mock.timers.tick(60);
      assert.equal(aborts, 0);
      assert.equal(signals.length, 2);
      assert.equal(
        signals.some((signal) => signal.aborted),
        false,
      );
      assert.equal(runtime.status().activeTurns, 0);
    } finally {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('the memory curator runs on the configured Pi provider, parses JSON and refuses provider failures', async () => {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const provider = faux.provider.id;
  const curator = createPiMemoryCurator({
    provider,
    model: faux.getModel().id,
    apiKey: 'fixture-key',
    runtime,
  });
  const ask = () =>
    curator.curate({ task: 'search', instructions: 'Return JSON.', input: { query: 'sibling' } });
  faux.setResponses([
    fauxAssistantMessage('Here you go:\n```json\n{"paths":["people/ana"]}\n```'),
    fauxAssistantMessage('{"ops":[]}'),
    fauxAssistantMessage('no json here'),
    fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: 'provider down' }),
  ]);
  assert.deepEqual(await ask(), { paths: ['people/ana'] });
  assert.deepEqual(await ask(), { ops: [] });
  assert.equal(await ask(), null);
  await assert.rejects(ask(), /unavailable/);
  assert.equal(faux.state.callCount, 4);
  assert.equal(curator.configured, true);
  assert.equal(createPiMemoryCurator({ provider, runtime }).configured, false);
  await assert.rejects(
    createPiMemoryCurator({ provider, apiKey: 'fixture-key', runtime }).curate({
      task: 'search',
      instructions: 'Return JSON.',
      input: {},
    }),
    /catalog/,
  );
  const real = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  real.completeSimple = async () => {
    throw new Error('unexpected model call');
  };
  await assert.rejects(
    createPiMemoryCurator({
      provider: 'openai',
      apiKey: 'fixture-key',
      model: 'no-such-model',
      runtime: real,
    }).curate({ task: 'search', instructions: 'Return JSON.', input: {} }),
    /catalog/,
  );
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
          threadId: randomUUID(),
          turnId: randomUUID(),
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
            assert.ok(error.message.length <= 160);
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
  for (const tool of inspectToolCatalog()) {
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

function codexFixtureAccess(accountId = 'fixture-owner', claims: Record<string, unknown> = {}) {
  return `fixture.${Buffer.from(JSON.stringify({ ...claims, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.signature`;
}

test('ChatGPT refuses occupied loopback ports before publishing sign-in or requesting tokens', async (t) => {
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
});

test('ChatGPT rejects a wildcard callback host before opening any listener', async (t) => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { Server } = await import('node:http');
  let binds = 0;
  let requests = 0;
  t.mock.method(Server.prototype, 'listen', () => {
    binds++;
    throw new Error('Unexpected listener');
  });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Unexpected network request');
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
  assert.equal(requests, 0);
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
  let metadata: Record<string, unknown> = {
    'https://api.openai.com/profile': { email: 'fixture-profile@example.test' },
  };
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
          access_token: codexFixtureAccess('fixture-owner', metadata),
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
      const nonce = dom.window.document.querySelector('script')!.nonce;
      assert.ok(nonce && nonce.length >= 32);
      const policy = response.headers.get('content-security-policy')!;
      assert.ok(policy.includes(`script-src 'nonce-${nonce}'`));
      assert.ok(policy.includes(`style-src 'nonce-${nonce}'`));
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
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
  assert.equal(authorization.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(authorization.searchParams.get('scope'), 'openid profile email offline_access');
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
  assert.equal(credential.access, codexFixtureAccess('fixture-owner', metadata));
  assert.equal(credential.email, 'fixture-profile@example.test');
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

  for (const [claims, expected] of [
    [{ email: 'fixture-top@example.test' }, 'fixture-top@example.test'],
    [{}, undefined],
    [{ email: { invalid: true }, 'https://api.openai.com/profile': 'invalid' }, undefined],
    [
      {
        email: 'not-an-email',
        'https://api.openai.com/profile': { email: 'fixture-nested@example.test' },
      },
      'fixture-nested@example.test',
    ],
    [{ email: 'a'.repeat(321) + '@example.test' }, undefined],
  ] as const) {
    metadata = claims;
    const flow = await backend.signIn({ signal: controller.signal });
    flow.complete(
      new URL(`http://localhost:1455/auth/callback?state=${flow.state}&code=metadata-code`),
    );
    const saved = await flow.result;
    assert.equal(saved.type, 'oauth');
    if (saved.type !== 'oauth') throw new Error('Expected OAuth.');
    assert.equal(saved.email, expected);
  }

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
  let expectedRefresh = 'fixture-refresh';
  let changed = false;
  let metadata: Record<string, unknown> = { email: 'fixture-refreshed@example.test' };
  let offline = false;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://auth.openai.com/oauth/token');
    assert.ok(init?.signal);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), expectedRefresh);
    assert.equal(body.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    if (offline) throw new Error('Offline fixture-refresh fixture-owner');
    return status === 200
      ? Response.json({
          access_token: codexFixtureAccess(changed ? 'foreign' : 'fixture-owner', metadata),
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
  assert.equal(renewed.email, 'fixture-refreshed@example.test');
  expectedRefresh = 'fixture-rotated';
  for (const claims of [
    {},
    { email: false, 'https://api.openai.com/profile': { email: 'invalid' } },
  ]) {
    metadata = claims;
    const next = await backend.refresh(renewed);
    assert.equal(next.type, 'oauth');
    if (next.type !== 'oauth') throw new Error('Expected OAuth.');
    assert.equal(next.email, 'fixture-refreshed@example.test');
  }
  expectedRefresh = 'fixture-refresh';
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

test('ChatGPT catalog and requests use Codex account access, history and tools without retries', async () => {
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
  let catalogCalls = 0;
  const backend = createPiModelBackend({
    fetch: async (input, init) => {
      catalogCalls++;
      assert.equal(
        String(input),
        'https://chatgpt.com/backend-api/codex/models?client_version=0.155.1',
      );
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access}`);
      assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), 'fixture-owner');
      assert.equal(init?.redirect, 'error');
      return Response.json({
        models: [
          { slug: 'gpt-6.1-sol', visibility: 'list' },
          { slug: 'gpt-6-luna', visibility: 'hidden' },
        ],
      });
    },
  });
  const definitions = await backend.catalog('openai', 'subscription', credential);
  assert.deepEqual(
    definitions.map((model) => model.choice.id),
    ['gpt-6.1-sol'],
  );
  const definition = definitions[0];
  assert.equal(definition.spec.provider, 'openai-codex');
  assert.equal(definition.spec.api, 'openai-codex-responses');
  const old = {
    type: 'oauth',
    access,
    refresh: 'fixture-refresh',
    expires: 1,
    clientId: 'old-direct',
  } as unknown as typeof credential;
  await assert.rejects(backend.catalog('openai', 'subscription', old), /Reconnect/);
  assert.equal(catalogCalls, 1);
  const selection = {
    provider: 'openai' as const,
    method: 'subscription' as const,
    definition,
    effort: 'high' as const,
    read: async () => credential,
  };
  await assert.rejects(
    createPiModelRuntime({
      ...selection,
      definition: { ...definition, spec: { ...definition.spec, api: 'openai-responses' } },
    }),
    /Reconnect/,
  );
  const { runtime, model } = await createPiModelRuntime(selection);
  assert.equal(model.provider, 'openai-codex');
  let calls = 0;
  let payload: Record<string, any>;
  const item = {
    type: 'function_call',
    id: 'fc_fixture',
    call_id: 'call_fixture',
    name: 'read_fixture',
    arguments: '{}',
  };
  const message = await runtime.completeSimple(
    model,
    {
      systemPrompt: 'Fixture system',
      tools: [
        { name: 'read_fixture', description: 'Read synthetic data.', parameters: Type.Object({}) },
      ],
      messages: [
        { role: 'user', content: 'Earlier question', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Earlier answer' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 2,
        },
        { role: 'user', content: 'Read the fixture', timestamp: 3 },
      ],
    },
    {
      reasoning: 'high',
      maxTokens: 100,
      temperature: 0.3,
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), 'https://chatgpt.com/backend-api/codex/responses');
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${access}`);
        assert.equal(new Headers(init?.headers).get('chatgpt-account-id'), 'fixture-owner');
        const raw =
          new Headers(init?.headers).get('content-encoding') === 'zstd'
            ? (await import('node:zlib'))
                .zstdDecompressSync(Buffer.from(init!.body as Uint8Array))
                .toString()
            : String(init?.body);
        payload = JSON.parse(raw);
        return new Response(
          [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, arguments: '' },
            },
            { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{}' },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: 'resp_fixture',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
  );
  assert.equal(calls, 1, message.errorMessage);
  assert.equal(message.stopReason, 'toolUse', message.errorMessage);
  assert.ok(
    message.content.some((block) => block.type === 'toolCall' && block.name === 'read_fixture'),
  );
  assert.equal(payload!.store, false);
  assert.equal(payload!.stream, true);
  assert.equal(payload!.instructions, 'Fixture system');
  assert.equal(payload!.previous_response_id, undefined);
  assert.match(JSON.stringify(payload!.input), /Earlier question/);
  assert.match(JSON.stringify(payload!.input), /Earlier answer/);
  assert.match(JSON.stringify(payload!.input), /Read the fixture/);
  assert.deepEqual(
    payload!.tools.map((tool: any) => tool.type),
    ['function'],
  );
  assert.equal(payload!.reasoning.effort, 'high');
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
  assert.match(failed.errorMessage ?? '', /Synthetic service failure \[redacted\]/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-refresh|fixture-owner/);
  assert.ok(!JSON.stringify(failed).includes(access));
  assert.equal(calls, 2);
  const rejected = await createPiModelRuntime({ ...selection, read: async () => old });
  const rejectedMessage = await rejected.runtime.completeSimple(
    rejected.model,
    { messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }] },
    {
      fetch: async () => {
        calls++;
        throw new Error('Old credentials reached network');
      },
    },
  );
  assert.equal(rejectedMessage.stopReason, 'error');
  assert.match(rejectedMessage.errorMessage ?? '', /Reconnect/);
  assert.equal(calls, 2);
});

test('OpenAI catalog discovery tolerates only model-list permission restrictions', async () => {
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const key = 'synthetic-restricted-catalog-key';
  const credential = { type: 'api_key' as const, key };
  const message =
    'You have insufficient permissions for this operation. Missing scopes: api.model.read. Check your key permissions.';
  const calls: string[] = [];
  let respond = () => Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'fixture-unknown' }] });
  const backend = createPiModelBackend({
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(init?.method ?? 'GET', 'GET');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      if (url === 'https://openrouter.ai/api/v1/key')
        return Response.json({ data: { is_management_key: false } });
      assert.ok(
        ['https://api.openai.com/v1/models', 'https://openrouter.ai/api/v1/models'].includes(url),
      );
      return respond();
    },
  });
  const local = await backend.catalog('openai', 'api_key');
  assert.deepEqual(
    (await backend.catalog('openai', 'api_key', credential)).map((model) => model.choice.id),
    ['gpt-6.1-sol'],
  );
  for (const error of [message, { message }]) {
    calls.length = 0;
    respond = () => Response.json({ error }, { status: 403 });
    assert.deepEqual(await backend.catalog('openai', 'api_key', credential), local);
    assert.deepEqual(calls, ['https://api.openai.com/v1/models']);
  }
  for (const [status, body] of [
    [401, { error: { message } }],
    [403, { error: { message: `Denied ${key}` } }],
    [403, { error: { message: 'Missing scopes: api.responses.write.' } }],
    [403, { error: { message: 'Missing scopes: api.model.read, api.responses.write.' } }],
    [403, { error: { message: 'Missing scopes: api.model.read api.responses.write.' } }],
    [403, { error: { message: 'Missing scopes: api.model.read.extra.' } }],
    [403, { error: { message: 'Missing scopes: api.model.readwrite.' } }],
    [403, { error: { message: message + ' Missing scopes: api.responses.write.' } }],
    [403, { error: { message: null } }],
    [403, { error: { message }, padding: 'x'.repeat(4096) }],
    [429, { error: { message } }],
    [500, { error: { message } }],
  ] as const) {
    respond = () => Response.json(body, { status });
    await assert.rejects(backend.catalog('openai', 'api_key', credential), (error: Error) => {
      assert.ok(!error.message.includes(key));
      assert.ok(!error.message.includes(message));
      return true;
    });
  }
  respond = () => new Response('{"error":', { status: 403 });
  await assert.rejects(backend.catalog('openai', 'api_key', credential));
  let cancelled = false;
  respond = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(' '.repeat(4097)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 403 },
    );
  await assert.rejects(backend.catalog('openai', 'api_key', credential));
  assert.equal(cancelled, true);
  respond = () => Response.json({ error: { message } }, { status: 403 });
  await assert.rejects(
    backend.catalog('openai', 'subscription', {
      type: 'oauth',
      access: key,
      refresh: 'fixture-refresh',
      expires: Date.now() + 60000,
      accountId: 'fixture-owner',
    }),
  );
  await assert.rejects(backend.catalog('openrouter', 'api_key', credential));
  await assert.rejects(
    createPiModelBackend({ fetch: async () => respond() }).catalog(
      'anthropic',
      'api_key',
      credential,
    ),
  );
  respond = () => {
    throw new Error('Synthetic offline');
  };
  await assert.rejects(backend.catalog('openai', 'api_key', credential));
});

test('OpenRouter catalogs and both request formats retain tools, effort and one provider attempt', async () => {
  const { createPiModelBackend, createPiModelRuntime } =
    await import('../src/providers/pi/models.ts');
  const { createPiUsageTracker } = await import('../src/providers/pi/usage.ts');
  const backend = createPiModelBackend({
    fetch: async (input, init) => {
      if (String(input) === 'https://openrouter.ai/api/v1/key') {
        if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-router-key')
          return Response.json({ error: 'Invalid fixture key' }, { status: 401 });
        return Response.json({ data: { is_management_key: false } });
      }
      assert.equal(String(input), 'https://openrouter.ai/api/v1/models');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-router-key');
      return Response.json({
        data: [
          'openai/gpt-6.1-sol',
          'anthropic/claude-opus-5.5',
          'fixture/new-model',
          'fixture/no-tools',
          'openrouter/auto',
        ].map((id) => ({
          id,
          name: id,
          context_length: 100000,
          supported_parameters: id.endsWith('no-tools') ? [] : ['tools', 'reasoning'],
          reasoning: { supported_efforts: ['low', 'medium', 'high'] },
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          pricing:
            id === 'openrouter/auto'
              ? { prompt: '-1', completion: '-1' }
              : { prompt: '0.000002', completion: '0.00001' },
        })),
      });
    },
  });
  await assert.rejects(
    backend.catalog('openrouter', 'api_key', { type: 'api_key', key: 'fixture-invalid-key' }),
  );
  const definitions = await backend.catalog('openrouter', 'api_key', {
    type: 'api_key',
    key: 'fixture-router-key',
  });
  assert.deepEqual(
    definitions.map((definition) => definition.choice.id),
    ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5', 'fixture/new-model', 'openrouter/auto'],
  );
  const router = definitions.find((definition) => definition.choice.id === 'openrouter/auto')!;
  const usage = {
    input: 1000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(router.spec as unknown as Model<Api>, usage);
  const observed = createPiUsageTracker({
    sessionId: 'fixture-session',
    provider: 'openrouter',
    model: 'openrouter/auto',
    history: [],
  })({
    ...fauxAssistantMessage([{ type: 'text', text: 'Synthetic answer' }]),
    provider: 'openrouter',
    model: 'openrouter/auto',
    usage,
  });
  assert.equal(observed?.costUsd, null);
  assert.equal(observed?.costSource, 'unavailable');
  for (const definition of definitions) {
    const { runtime, model } = await createPiModelRuntime({
      provider: 'openrouter',
      method: 'api_key',
      definition,
      effort: 'high',
      read: async () => ({ type: 'api_key', key: 'fixture-router-key' }),
    });
    let calls = 0;
    const failed = await runtime.completeSimple(
      model,
      {
        messages: [
          { role: 'user', content: 'Synthetic fixture', timestamp: 1 },
          {
            role: 'system',
            content: '',
            toolsAdded: [
              { name: 'read_fixture', description: 'Read fixture.', parameters: Type.Object({}) },
            ],
            timestamp: 1,
          },
        ],
      },
      {
        reasoning: 'high',
        maxRetries: 5,
        fetch: async (input, init) => {
          calls++;
          assert.equal(
            new URL(String(input)).pathname,
            model.api === 'anthropic-messages' ? '/api/v1/messages' : '/api/v1/chat/completions',
          );
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, definition.choice.id);
          assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
          assert.ok(body.tools.length);
          assert.equal(
            model.api === 'anthropic-messages' ? body.output_config.effort : body.reasoning.effort,
            'high',
          );
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
});

test('Pi retries a transient provider error and the turn completes with the retried answer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-retry-'));
  let calls = 0;
  const finals: string[] = [];
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (model) => {
        const failed = ++calls === 1;
        const message: AssistantMessage = {
          ...fauxAssistantMessage([{ type: 'text', text: failed ? '' : 'Recovered' }]),
          provider: model.provider,
          model: model.id,
          api: model.api,
          stopReason: failed ? 'error' : 'stop',
          ...(failed ? { errorMessage: '529 overloaded_error: Overloaded' } : {}),
        };
        const stream = createAssistantMessageEventStream();
        stream.push(
          failed
            ? { type: 'error', reason: 'error', error: message }
            : { type: 'done', reason: 'stop', message },
        );
        return stream;
      };
      return result;
    },
  });
  try {
    const session = await agent.open({
      threadId: randomUUID(),
      turnId: randomUUID(),
      systemPrompt: 'Synthetic fixture',
      ...sandbox,
      tools: [],
      shouldStop: () => false,
      onEvent: (event) => {
        if (event.type === 'final') finals.push(event.text);
      },
    });
    await session.prompt('Synthetic question', []);
    await session.dispose();
    assert.equal(calls, 2);
    assert.deepEqual(finals, ['Recovered']);
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('old screenshots leave the model request in steps while the saved session keeps them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-images-'));
  const sent: number[] = [];
  let calls = 0;
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: async (options) => {
      const result = await createAgentSession(options);
      result.session.agent.streamFunction = (model, request) => {
        sent.push(
          request.messages.flatMap((message) =>
            message.role === 'toolResult'
              ? message.content.filter((part) => part.type === 'image')
              : [],
          ).length,
        );
        const more = sent.length <= 30;
        const message: AssistantMessage = {
          ...fauxAssistantMessage(
            more
              ? [{ type: 'toolCall', id: `snap-${sent.length}`, name: 'snap', arguments: {} }]
              : [{ type: 'text', text: 'Done' }],
          ),
          stopReason: more ? 'toolUse' : 'stop',
          provider: model.provider,
          model: model.id,
          api: model.api,
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: 'done', reason: more ? 'toolUse' : 'stop', message });
        return stream;
      };
      return result;
    },
  });
  const threadId = randomUUID();
  try {
    const session = await agent.open({
      threadId,
      turnId: randomUUID(),
      systemPrompt: 'Synthetic fixture',
      ...sandbox,
      tools: [
        {
          name: 'snap',
          description: 'Synthetic screenshot',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({
            content: [
              {
                type: 'image',
                data: Buffer.from(`png-${calls++}`).toString('base64'),
                mimeType: 'image/png',
              },
            ],
          }),
        },
      ],
      shouldStop: () => false,
      onEvent: () => {},
    });
    await session.prompt('Take screenshots', []);
    await session.dispose();
    assert.equal(calls, 30);
    assert.ok(Math.max(...sent) <= 12);
    assert.ok(sent.at(-1)! >= 4);
    assert.ok(sent.filter((count, index) => index && count < sent[index - 1]).length <= 3);
    const saved = await readPiSessionEntries({ threadId, sessionRoot: directory });
    assert.equal(
      saved.filter(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'toolResult' &&
          JSON.stringify(entry.message.content).includes('"image"'),
      ).length,
      30,
    );
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
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
      threadId,
      turnId: randomUUID(),
      systemPrompt: 'Fixture system',
      ...sandbox,
      tools: [],
      background,
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
