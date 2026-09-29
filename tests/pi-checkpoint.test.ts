import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createPiCheckpoint } from '../src/providers/pi/checkpoint.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import type { PrivateObjectStore } from '../src/ports/object-storage.ts';
import type { RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'otto-durable-pi-'));
  const store = createFilesystemObjectStore(join(directory, 'objects'));
  return {
    directory,
    store,
    taskId: randomUUID(),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('Pi restores durable tool results after losing the entire actor disk without repeating an action', async () => {
  const f = await fixture();
  let executions = 0;
  try {
    const checkpoint = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'old'),
    });
    checkpoint.manager.appendMessage({
      role: 'user',
      content: 'Do the fixture action',
      timestamp: Date.now(),
    });
    await checkpoint.execute('call-one', 'fixture_action', async () => {
      executions++;
      const saved = await f.store.read(`sessions/${f.taskId}.jsonl`, 1024 * 1024);
      assert.match(saved!.bytes.toString(), /otto_tool_pending/);
      return { content: [{ type: 'text', text: 'action receipt' }] };
    });
    const resumed = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'new'),
    });
    assert.equal(
      resumed.manager
        .getEntries()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult').length,
      1,
    );
    assert.match(JSON.stringify(resumed.manager.buildSessionContext().messages), /action receipt/);
    await assert.rejects(
      resumed.execute('call-one', 'fixture_action', async () => {
        executions++;
        return { content: [] };
      }),
      /could not be saved/,
    );
    assert.equal(executions, 1);
    const reopened = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'newer'),
    });
    assert.equal(
      reopened.manager
        .getEntries()
        .filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult').length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('a missing action receipt fences restart and a failed pre-action checkpoint prevents execution', async () => {
  const f = await fixture();
  let writes = 0;
  let executions = 0;
  const store: PrivateObjectStore = {
    ...f.store,
    write: async (...args) => {
      writes++;
      if (writes === 2) throw new Error('private failure');
      return f.store.write(...args);
    },
  };
  try {
    const checkpoint = await createPiCheckpoint({
      store,
      taskId: f.taskId,
      directory: f.directory,
    });
    await assert.rejects(
      checkpoint.execute('call', 'action', async () => {
        executions++;
        return { content: [] };
      }),
      /could not be saved/,
    );
    assert.equal(executions, 0);
    const interruptedTaskId = randomUUID();
    const second = await createPiCheckpoint({
      store: f.store,
      taskId: interruptedTaskId,
      directory: f.directory,
    });
    await assert.rejects(
      second.execute('call', 'action', async () => {
        executions++;
        throw new Error('unknown external outcome');
      }),
      /result could be confirmed/,
    );
    assert.equal(executions, 1);
    const pending = second.manager.getEntries().find((entry) => entry.type === 'custom');
    assert.ok(pending);
    await assert.rejects(
      createPiCheckpoint({ store: f.store, taskId: interruptedTaskId, directory: f.directory }),
      /interrupted before its result/,
    );
    await assert.rejects(second.checkpoint(), /could not be saved/);
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
      taskId: f.taskId,
      systemPrompt: 'fixture',
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
      taskId: f.taskId,
      systemPrompt: 'fixture',
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

test('real Pi persists its user message and tool intent before a side effect and records the result before continuing', async () => {
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
      taskId: f.taskId,
      systemPrompt: 'fixture',
      shouldStop: () => false,
      onEvent() {},
      tools: [
        {
          name: 'effect',
          description: 'fixture',
          parameters: { type: 'object', properties: {} },
          async execute() {
            const saved = await f.store.read(`sessions/${f.taskId}.jsonl`, 1024 * 1024);
            assert.match(saved!.bytes.toString(), /synthetic user request/);
            assert.match(saved!.bytes.toString(), /otto_tool_pending/);
            assert.match(saved!.bytes.toString(), /toolCall/);
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
      taskId: f.taskId,
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

test('the real runtime error wrapper leaves an uncertain browser action fenced across restart', async () => {
  const f = await fixture();
  let effects = 0;
  let turns = 0;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model) => {
      const first = turns++ === 0;
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: first ? 'toolUse' : 'stop',
        content: first
          ? [
              {
                type: 'toolCall',
                id: 'uncertain-click',
                name: 'browser',
                arguments: { action: 'click', selector: '@e1' },
              },
            ]
          : [{ type: 'text', text: 'must not continue' }],
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
      stream.push({ type: 'done', reason: first ? 'toolUse' : 'stop', message });
      return stream;
    };
    return result;
  };
  const runtime = createAgentRuntime({
    agent: createPiAgent({
      provider: 'openai',
      apiKey: 'fixture',
      sessionRoot: join(f.directory, 'cache'),
      objectStore: f.store,
      createSession: factory,
    }),
    computer: fakeComputer({
      act: async () => {
        effects++;
        throw new Error('accepted fixture effect lost acknowledgement');
      },
    }),
    workspace: fakeWorkspace(),
  });
  const context: RuntimeContext = {
    taskId: f.taskId,
    ownerId: 'fixture',
    prompt: 'Run the fixture action',
    history: [],
    memories: [],
    attachments: [],
    workspacePath: join(f.directory, 'workspace'),
    signal: new AbortController().signal,
    emit: async () => {},
    reply: async () => {},
    delta() {},
    remember: async () => {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  try {
    await assert.rejects(runtime.runTask(context), /could not be saved/);
    assert.equal(effects, 1);
    assert.equal(turns, 1);
    const saved = await f.store.read(`sessions/${f.taskId}.jsonl`, 1024 * 1024);
    assert.match(saved!.bytes.toString(), /otto_tool_pending/);
    assert.doesNotMatch(saved!.bytes.toString(), /otto_tool_completed/);
    await assert.rejects(
      createPiCheckpoint({
        store: f.store,
        taskId: f.taskId,
        directory: join(f.directory, 'replacement'),
      }),
      /interrupted before its result/,
    );
  } finally {
    await runtime.dispose();
    await f.close();
  }
});

test('a fresh Pi session replaces an interrupted checkpoint only when requested', async () => {
  const f = await fixture();
  try {
    const first = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'first'),
    });
    await assert.rejects(
      first.execute('call', 'browser', async () => {
        throw new Error('fixture read failure');
      }),
      /result could be confirmed/,
    );
    await assert.rejects(
      createPiCheckpoint({ store: f.store, taskId: f.taskId, directory: join(f.directory, 'a') }),
      /interrupted before its result/,
    );
    const fresh = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'fresh'),
      fresh: true,
    });
    assert.equal(
      fresh.manager.getEntries().some((entry) => entry.type === 'custom'),
      false,
    );
    const saved = await f.store.read(`sessions/${f.taskId}.jsonl`, 1024 * 1024);
    assert.doesNotMatch(saved!.bytes.toString(), /otto_tool_pending/);
    const resumed = await createPiCheckpoint({
      store: f.store,
      taskId: f.taskId,
      directory: join(f.directory, 'resumed'),
    });
    assert.ok(resumed.manager);
  } finally {
    await f.close();
  }
});
