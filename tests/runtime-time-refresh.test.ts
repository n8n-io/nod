import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from '@earendil-works/pi-ai';
import type { Agent, PromptSnapshot, RuntimeContext } from '../src/ports/agent.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

function context(directory: string, overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    taskId: `test-${randomUUID()}`,
    ownerId: 'clock-fixture',
    prompt: 'Continue the fixture request.',
    timeZone: 'Europe/Lisbon',
    history: [],
    memories: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async () => {},
    delta: () => {},
    remember: async () => {},
    publish: async () => {
      throw new Error('Unused fixture artifact.');
    },
    requestCredential: async () => ({ url: '/vault/clock-fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
    ...overrides,
  };
}

test('secure continuation refreshes the trusted clock and its Inspector snapshot across DST', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-clock-continuation-'));
  const before =
    'Current UTC time: 2026-10-25T00:59:59.000Z. Current local time: 2026-10-25T01:59:59+01:00. User time zone: Europe/Lisbon.';
  const after =
    'Current UTC time: 2026-10-25T01:00:01.000Z. Current local time: 2026-10-25T01:00:01+00:00. User time zone: Europe/Lisbon.';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-25T00:59:59Z') });
  const prompts: string[] = [];
  const snapshots: PromptSnapshot[] = [];
  const replies: string[] = [];
  let requests = 0;
  const agent: Agent = {
    open: async (options) => ({
      resumed: false,
      prompt: async (text) => {
        prompts.push(text);
        options.onEvent({
          type: 'final',
          text: prompts.length === 1 ? "What's your username?" : 'The fixture is complete.',
        });
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer({
      inspectLogin: async () => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [{ kind: 'identifier', selector: '#login', label: 'Email' }],
        methods: [],
      }),
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTask(
      context(directory, {
        inspectPrompt: async (snapshot) => {
          snapshots.push(snapshot);
        },
        reply: async (text) => {
          replies.push(text);
        },
        requestCredential: async () => {
          requests++;
          t.mock.timers.setTime(Date.parse('2026-10-25T01:00:01Z'));
          return { filled: true };
        },
      }),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(requests, 1);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].split('\n')[0], before);
    assert.equal(prompts[1].split('\n')[0], after);
    assert.ok(!prompts[1].includes(before));
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.instruction),
      prompts,
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.reason),
      ['user', 'secure_resume'],
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.resumed),
      [false, true],
    );
    assert.ok(snapshots[1].system.includes(before));
    assert.match(snapshots[1].system, /use the latest request's clock when this session continues/);
    assert.deepEqual(replies, ['The fixture is complete.']);
  } finally {
    await runtime.dispose();
    t.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reopening a persisted Pi session sends the current date and owner time zone to the model', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-clock-pi-'));
  const before =
    'Current UTC time: 2026-09-25T23:59:00.000Z. Current local time: 2026-09-26T00:59:00+01:00. User time zone: Europe/Lisbon.';
  const after =
    'Current UTC time: 2026-09-26T00:01:00.000Z. Current local time: 2026-09-25T17:01:00-07:00. User time zone: America/Los_Angeles.';
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-25T23:59:00Z') });
  const requests: Message[][] = [];
  const snapshots: PromptSnapshot[] = [];
  const factory: typeof createAgentSession = async (options) => {
    const result = await createAgentSession(options);
    result.session.agent.streamFunction = (model, request) => {
      requests.push(structuredClone(request.messages));
      const output: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        responseId: `clock-fixture-${requests.length}`,
        stopReason: 'stop',
        content: [{ type: 'text', text: `Fixture response ${requests.length}.` }],
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
      stream.push({ type: 'start', partial: output });
      stream.push({ type: 'done', reason: 'stop', message: output });
      return stream;
    };
    return result;
  };
  const openRuntime = () =>
    createAgentRuntime({
      agent: createPiAgent({
        provider: 'openai',
        apiKey: 'clock-fixture-key',
        sessionRoot: join(directory, 'sessions'),
        createSession: factory,
      }),
      computer: fakeComputer(),
      workspace: fakeWorkspace(),
    });
  const task = context(directory, {
    prompt: 'Remember the first fixture request.',
    inspectPrompt: async (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  let runtime = openRuntime();
  try {
    assert.equal((await runtime.runTask(task)).status, 'succeeded');
    await runtime.dispose();
    t.mock.timers.setTime(Date.parse('2026-09-26T00:01:00Z'));
    runtime = openRuntime();
    assert.equal(
      (
        await runtime.runTask({
          ...task,
          timeZone: 'America/Los_Angeles',
          prompt: 'Continue the fixture after the time zone changed.',
        })
      ).status,
      'succeeded',
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.resumed),
      [false, true],
    );
    assert.ok(snapshots[0].system.includes(before));
    assert.ok(snapshots[1].system.includes(after));
    assert.ok(!snapshots[1].system.includes(before));
    assert.equal(snapshots[1].instruction.split('\n')[0], after);
    const lastUser = requests[1].findLast((message) => message.role === 'user');
    assert.ok(lastUser);
    const lastUserText =
      typeof lastUser.content === 'string'
        ? lastUser.content
        : lastUser.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    assert.equal(lastUserText, snapshots[1].instruction);
    assert.equal(lastUserText.split('\n')[0], after);
    const lastSystem = requests[1].findLast((message) => message.role === 'system');
    assert.ok(lastSystem);
    assert.ok(JSON.stringify(lastSystem).includes(after));
    assert.ok(!JSON.stringify(lastSystem).includes(before));
    assert.equal(requests[1].filter((message) => message.role === 'user').length, 2);
    assert.ok(JSON.stringify(requests[1]).includes('Remember the first fixture request.'));
    assert.ok(JSON.stringify(requests[1]).includes('Fixture response 1.'));
  } finally {
    await runtime.dispose();
    t.mock.timers.reset();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the signed-in profile, region and clock reach the model but not observations or task events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-account-context-'));
  const prompts: string[] = [];
  const observed: unknown[] = [];
  const events: string[] = [];
  const agent: Agent = {
    open: async (options) => {
      prompts.push(options.systemPrompt);
      return {
        resumed: false,
        prompt: async () => {
          await options.tools
            .find((tool) => tool.name === 'manage_personal_context')!
            .execute({ action: 'history_search', args: { query: 'dentist' } });
          options.onEvent({
            type: 'model_usage',
            id: randomUUID(),
            provider: 'fixture',
            model: 'fixture-model',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            costUsd: null,
            costSource: 'unavailable',
            createdAt: new Date().toISOString(),
          });
          options.onEvent({ type: 'final', text: 'Hello again.' });
        },
        abort() {},
        dispose() {},
      };
    },
    dispose() {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer(),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTask(
      context(directory, {
        locale: 'pt-PT',
        hourCycle: 'h12',
        account: {
          preferredName: 'Sam',
          fullName: 'Samantha Synthetic',
          email: 'sam.synthetic@example.test',
        },
        observe: async (event) => {
          observed.push(event);
        },
        emit: async (type, summary) => {
          events.push(`${type}:${summary}`);
        },
      }),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(prompts.length, 1);
    assert.ok(
      prompts[0].includes(
        '"preferredName":"Sam","fullName":"Samantha Synthetic","email":"sam.synthetic@example.test","region":"Portugal","clock":"h12","timeZone":"Europe/Lisbon"',
      ),
    );
    assert.match(prompts[0], /Call the user by preferredName naturally/);
    assert.match(
      prompts[0],
      /Write dates and times in English in the same format as the app, for example [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2,3} \d{4}, \d{1,2}:\d{2} [ap]m\. If the user writes in another language, use that language for dates too\./,
    );
    assert.deepEqual(
      observed.map((item) => (item as { type: string }).type),
      ['tool_start', 'tool_end', 'model_usage'],
    );
    assert.deepEqual(events, [
      'tool_start:manage personal context',
      'tool_complete:manage personal context',
    ]);
    for (const value of [...observed.map((item) => JSON.stringify(item)), ...events])
      assert.doesNotMatch(value, /Samantha|sam\.synthetic|Sam\b/);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
