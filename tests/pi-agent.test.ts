import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createAgentSession, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentEvent, ModelUsageObservation, RuntimeContext } from '../src/ports/agent.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createPiUsageTracker } from '../src/providers/pi/usage.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

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
        taskId: randomUUID(),
        systemPrompt: 'fixture',
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
        taskId: randomUUID(),
        systemPrompt: 'fixture',
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
  const usage: ModelUsageObservation[] = [];
  let remembered = 0;
  let phase = 0;
  const context: RuntimeContext = {
    taskId: id,
    ownerId: 'fixture',
    prompt: 'Sign in to the fixture',
    history: [{ role: 'user', text: 'Older fixture context' }],
    memories: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    observe: async (event) => {
      if (event.type === 'model_usage') usage.push(event);
    },
    reply: async (text) => {
      replies.push(text);
    },
    delta: () => {},
    remember: async () => {
      remembered += 1;
    },
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => {
      remembered += 1;
      return {};
    },
  };
  const factory: typeof createAgentSession = async (options) => {
    assert.equal(options?.tools?.includes('bash'), false);
    assert.equal(options?.tools?.includes('read'), false);
    assert.deepEqual(options?.resourceLoader?.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(options?.resourceLoader?.getExtensions().extensions, []);
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
                  name: 'request_credentials',
                  arguments: {
                    origin: 'https://example.com',
                    label: 'Example',
                    kind: 'password',
                    passwordSelector: '#password',
                  },
                },
                {
                  type: 'toolCall',
                  id: 'later-call',
                  name: 'remember',
                  arguments: { text: 'This should not execute' },
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
      inspectLogin: async () => ({
        origin: 'https://example.com',
        url: phase === 0 ? 'https://example.com/login' : 'https://example.com/account',
        fields: phase === 0 ? [{ kind: 'password', selector: '#password', label: 'Password' }] : [],
        methods:
          phase === 0
            ? [{ id: 'credentials', kind: 'credentials', label: 'Password', supported: true }]
            : [],
      }),
    }),
    workspace: fakeWorkspace(),
  });
  try {
    assert.equal((await runtime.runTask(context)).status, 'waiting_credentials');
    assert.equal(remembered, 0);
    phase = 1;
    assert.equal(
      (
        await runtime.runTask({
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
    assert.equal(prompts[1].includes('New context from the continuous conversation'), true);
    assert.match(
      prompts[1],
      /Earlier assistant messages asking for private values outside that trusted request are obsolete/,
    );
    assert.match(prompts[1], /The broker handles that reply privately/);
    assert.equal(
      JSON.parse(prompts[1]).filter(
        (item: { role: string; content: unknown }) =>
          item.role === 'user' && JSON.stringify(item.content).includes('Older fixture context'),
      ).length,
      1,
    );
    assert.equal(prompts[1].includes('runtime-fixture-key'), false);
    assert.deepEqual(replies, [
      'https://example.com needs you to sign in. [Enter login details](/credentials/fixture) and I will continue the task.',
      'Resumed successfully.',
    ]);
    assert.deepEqual(
      usage.map((event) => event.inputTokens),
      [100, 200],
    );
    assert.deepEqual(
      usage.map((event) => event.totalTokens),
      [135, 235],
    );
    assert.equal(new Set(usage.map((event) => event.id)).size, 2);
    assert.ok(
      usage.every((event) => event.costSource === 'sdk_estimate' && event.costUsd === 0.002),
    );
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('token-limited Pi replies are not completed messages and retain prior tool commentary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-truncated-'));
  const events: AgentEvent[] = [];
  const replies: Array<{ text: string; id?: string }> = [];
  const deltas: Array<{ text: string; id?: string; done?: boolean }> = [];
  const update = 'I will inspect the fixture.';
  const truncated = 'The fixture contains these unfinished';
  let turns = 0;
  let commands = 0;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model) => {
      assert.ok(++turns <= 2);
      const first = turns === 1;
      const output = usageMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseId: `truncated-turn-${turns}`,
        stopReason: first ? 'toolUse' : 'length',
        content: [],
      });
      const text = first ? update : truncated;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: structuredClone(output) });
        output.content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: structuredClone(output) });
        output.content[0] = { type: 'text', text };
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: structuredClone(output),
        });
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: text,
          partial: structuredClone(output),
        });
        if (first)
          output.content.push({
            type: 'toolCall',
            id: 'fixture-inspection',
            name: 'shell',
            arguments: { command: 'fixture inspection' },
          });
        stream.push({ type: 'done', reason: first ? 'toolUse' : 'length', message: output });
      });
      return stream;
    };
    return result;
  };
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'fixture-key',
    sessionRoot: directory,
    createSession: factory,
  });
  const workspace = fakeWorkspace();
  const runtime = createAgentRuntime({
    agent: {
      ...agent,
      open: (options) =>
        agent.open({
          ...options,
          onEvent: (event) => {
            events.push(event);
            options.onEvent(event);
          },
        }),
    },
    computer: fakeComputer(),
    workspace: fakeWorkspace({
      open: (taskId) => ({
        ...workspace.open(taskId),
        execute: async () => {
          commands += 1;
          assert.deepEqual(
            replies.map(({ text }) => text),
            [update],
          );
          return 'Fixture inspected';
        },
      }),
    }),
  });
  try {
    await assert.rejects(
      runtime.runTask({
        taskId: `test-${randomUUID()}`,
        ownerId: 'fixture-owner',
        prompt: 'Inspect the fixture',
        history: [],
        memories: [],
        workspacePath: directory,
        signal: new AbortController().signal,
        attachments: [],
        emit: async () => {},
        reply: async (text, id) => {
          replies.push({ text, id });
        },
        delta: (text, id, done) => {
          deltas.push({ text, id, done });
        },
        remember: async () => {},
        publish: async () => {
          throw new Error('Not used');
        },
        requestCredential: async () => ({ url: '/credentials/fixture' }),
        integration: async () => ({}),
        manage: async () => ({}),
      }),
      /model response was incomplete/,
    );
    assert.equal(commands, 1);
    assert.equal(turns, 2);
    assert.deepEqual(
      replies.map(({ text }) => text),
      [update],
    );
    assert.deepEqual(
      events.filter((event) => event.type === 'message_end').map((event) => event.status),
      ['succeeded', 'incomplete'],
    );
    assert.equal(
      events.some((event) => event.type === 'final'),
      false,
    );
    assert.equal(events.filter((event) => event.type === 'model_usage').length, 2);
    const partial = deltas.find(({ text }) => text === truncated);
    assert.ok(partial?.id);
    assert.deepEqual(deltas.at(-1), { text: '', id: partial.id, done: true });
    assert.notEqual(replies[0].id, partial.id);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Responses commentary and final answer remain separate visible messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-phases-'));
  const events: Array<import('../src/ports/agent.ts').AgentEvent> = [];
  const answer = 'Your file is ready. Go, go.';
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model) => {
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: output });
        for (const [contentIndex, phase] of ['commentary', 'final_answer'].entries()) {
          output.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex, partial: structuredClone(output) });
          const block = output.content[contentIndex];
          if (block.type !== 'text') throw new Error('Unexpected fixture block');
          block.text = answer;
          stream.push({
            type: 'text_delta',
            contentIndex,
            delta: answer,
            partial: structuredClone(output),
          });
          block.textSignature = JSON.stringify({ v: 1, id: `msg_${contentIndex}`, phase });
          stream.push({
            type: 'text_end',
            contentIndex,
            content: answer,
            partial: structuredClone(output),
          });
        }
        stream.push({ type: 'done', reason: 'stop', message: output });
      });
      return stream;
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
    const session = await agent.open({
      taskId: `test-${randomUUID()}`,
      systemPrompt: 'Fixture',
      tools: [],
      onEvent: (event) => events.push(event),
      shouldStop: () => false,
    });
    await session.prompt('Create the fixture file', []);
    assert.deepEqual(
      events.filter((event) => event.type === 'final'),
      [{ type: 'final', text: answer }],
    );
    const streamed: string[] = [];
    for (const event of events) {
      if (event.type === 'message_start') streamed.push('');
      if (event.type === 'text_delta') streamed[streamed.length - 1] += event.text;
    }
    assert.deepEqual(streamed.filter(Boolean), [answer, answer]);
    assert.equal(events.filter((event) => event.type === 'model_usage').length, 1);
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function usageMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    responseId: 'synthetic-response',
    timestamp: Date.parse('2026-09-24T12:00:00Z'),
    content: [{ type: 'text', text: 'Private fixture content' }],
    stopReason: 'stop',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
      reasoning: 8,
      totalTokens: 160,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0004, total: 0.0037 },
    },
    ...overrides,
  };
}

function usageTracker(history: AssistantMessage[] = []) {
  return createPiUsageTracker({
    sessionId: 'synthetic-session',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    history,
  });
}

test('Pi usage preserves cache categories without double counting reasoning, callbacks, or resumed history', () => {
  const message = usageMessage();
  const track = usageTracker();
  const result = track(message)!;
  assert.equal(z.uuid().safeParse(result.id).success, true);
  assert.deepEqual(
    { ...result, id: 'opaque-id' },
    {
      type: 'model_usage',
      id: 'opaque-id',
      status: 'succeeded',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      totalTokens: 160,
      costUsd: 0.0037,
      costSource: 'sdk_estimate',
      createdAt: '2026-09-24T12:00:00.000Z',
    },
  );
  assert.equal(track(message), undefined);
  assert.equal(track(structuredClone(message)), undefined);
  assert.equal(usageTracker([message])(structuredClone(message)), undefined);
  assert.equal(usageTracker()(structuredClone(message))?.id, result.id);
  assert.notEqual(
    createPiUsageTracker({
      sessionId: 'another-session',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      history: [],
    })(message)?.id,
    result.id,
  );
  const withoutResponseId = usageMessage({ responseId: undefined });
  const anonymous = usageTracker();
  assert.ok(anonymous(withoutResponseId));
  assert.equal(anonymous(structuredClone(withoutResponseId)), undefined);
  assert.ok(anonymous({ ...withoutResponseId, timestamp: withoutResponseId.timestamp + 1 }));
  assert.equal(usageTracker([withoutResponseId])(structuredClone(withoutResponseId)), undefined);
  assert.equal(JSON.stringify(result).includes('Private fixture content'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-response'), false);
});

test('Pi usage rejects absent or malformed cost and skips empty failed attempts', () => {
  const message = usageMessage();
  for (const cost of [
    undefined,
    null,
    {},
    { total: 4 },
    { ...message.usage.cost, total: NaN },
    { ...message.usage.cost, input: -1 },
    { ...message.usage.cost, output: Infinity },
    { ...message.usage.cost, total: 40 },
  ]) {
    const output = usageTracker()({
      ...message,
      usage: { ...message.usage, cost },
    } as unknown as AssistantMessage)!;
    assert.equal(output.costUsd, null);
    assert.equal(output.costSource, 'unavailable');
    assert.equal(output.totalTokens, 160);
  }
  const malformed = usageTracker()({
    ...message,
    provider: 'private\nprovider',
    model: 'private model',
    usage: {
      ...message.usage,
      input: -1,
      output: NaN,
      cacheRead: 3,
      cacheWrite: 4.5,
      totalTokens: Infinity,
      cost: undefined,
    },
  } as unknown as AssistantMessage)!;
  assert.equal(malformed.provider, 'openai');
  assert.equal(malformed.model, 'gpt-5.4-mini');
  assert.deepEqual(
    [
      malformed.inputTokens,
      malformed.outputTokens,
      malformed.cacheReadTokens,
      malformed.cacheWriteTokens,
      malformed.totalTokens,
    ],
    [0, 0, 3, 0, 3],
  );
  assert.equal(malformed.costSource, 'unavailable');
  assert.equal(
    usageTracker()({ ...message, usage: undefined } as unknown as AssistantMessage),
    undefined,
  );
  const empty = usageMessage({
    stopReason: 'error',
    errorMessage: 'sensitive upstream exception',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  assert.equal(usageTracker()(empty), undefined);
  assert.equal(
    usageTracker()({
      ...empty,
      usage: { input: NaN, output: Infinity, cacheRead: -1 },
    } as unknown as AssistantMessage),
    undefined,
  );
  const track = usageTracker();
  const reportedFailure = usageMessage({
    responseId: 'failed-attempt',
    stopReason: 'error',
    errorMessage: 'sensitive upstream exception',
  });
  const failed = track(reportedFailure)!;
  assert.equal(failed.costUsd, 0.0037);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
  assert.equal(track(structuredClone(reportedFailure)), undefined);
  assert.notEqual(track(usageMessage({ responseId: 'successful-retry' }))?.id, failed.id);
});

test('real Pi retry followed by a tool pause reports only new usage despite repeated completion callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-retry-usage-'));
  const events: AgentEvent[] = [];
  let attempts = 0;
  let paused = false;
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession({
      ...options,
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
        compaction: { enabled: false },
      }),
    });
    const subscribe = result.session.subscribe.bind(result.session);
    result.session.subscribe = (listener) =>
      subscribe((event) => {
        listener(event);
        if (event.type === 'message_end' && event.message.role === 'assistant')
          listener(structuredClone(event));
      });
    result.session.agent.streamFunction = (model) => {
      attempts += 1;
      const output = usageMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseId: `attempt-${attempts}`,
      });
      const stream = createAssistantMessageEventStream();
      if (attempts === 1) {
        output.stopReason = 'error';
        output.errorMessage = '429 rate limit; private fixture error';
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        stream.push({ type: 'error', reason: 'error', error: output });
      } else {
        output.stopReason = 'toolUse';
        output.content = [{ type: 'toolCall', id: 'pause-call', name: 'pause', arguments: {} }];
        stream.push({ type: 'start', partial: output });
        stream.push({ type: 'done', reason: 'toolUse', message: output });
      }
      return stream;
    };
    return result;
  };
  const agent = createPiAgent({
    provider: 'openai',
    apiKey: 'private-fixture-key',
    sessionRoot: directory,
    createSession: factory,
  });
  try {
    const session = await agent.open({
      taskId: `test-${randomUUID()}`,
      systemPrompt: 'Fixture',
      shouldStop: () => paused,
      onEvent: (event) => events.push(event),
      tools: [
        {
          name: 'pause',
          description: 'Pause this fixture',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            paused = true;
            return { content: [{ type: 'text', text: 'Paused' }] };
          },
        },
      ],
    });
    await session.prompt('Pause after retry', []);
    const usage = events.filter((event) => event.type === 'model_usage');
    assert.equal(attempts, 2);
    assert.equal(paused, true);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].totalTokens, 160);
    assert.equal(usage[0].costUsd, 0.0037);
    assert.ok(events.some((event) => event.type === 'message_end' && event.status === 'succeeded'));
    assert.equal(JSON.stringify(events).includes('private fixture error'), false);
    assert.equal(JSON.stringify(events).includes('private-fixture-key'), false);
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi reports compaction and cache warming usage without private summaries or duplicate entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-pi-auxiliary-'));
  const events: AgentEvent[] = [];
  let emit!: Parameters<Awaited<ReturnType<typeof createAgentSession>>['session']['subscribe']>[0];
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.subscribe = (listener) => {
      emit = listener;
      return () => {};
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
    const session = await agent.open({
      taskId: randomUUID(),
      systemPrompt: 'fixture',
      tools: [],
      shouldStop: () => false,
      onEvent: (event) => events.push(event),
    });
    const usage = usageMessage().usage;
    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'private summary', firstKeptEntryId: 'entry', tokensBefore: 1000, usage },
      aborted: false,
      willRetry: false,
    });
    const entry = {
      type: 'usage' as const,
      id: 'cache-entry',
      parentId: null,
      timestamp: new Date().toISOString(),
      kind: 'cache_warm',
      provider: 'openai',
      model: 'fixture',
      usage,
      note: 'private note',
    };
    emit({ type: 'entry_appended', entry });
    emit({ type: 'entry_appended', entry });
    emit({ type: 'compaction_start', reason: 'threshold' });
    emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: 'private provider error',
    });
    const captured = events.flatMap((event) =>
      event.type === 'provider_usage' ? [event.usage] : [],
    );
    assert.deepEqual(
      captured.map((event) => event.operation),
      ['compaction', 'cache_warm', 'compaction'],
    );
    assert.equal(captured[0]?.inputTokens, 100);
    assert.equal(captured[0]?.costUsd, 0.0037);
    assert.equal(captured[2]?.status, 'failed');
    assert.equal(captured[2]?.costUsd, undefined);
    assert.doesNotMatch(JSON.stringify(captured), /private/);
    await session.dispose();
  } finally {
    await agent.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
