import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentToolResult, RuntimeContext } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

function value(result: AgentToolResult) {
  const content = result.content[0];
  assert.equal(content.type, 'text');
  return JSON.parse(content.text);
}

test('a LinkedIn task pauses for sign-in and reads 50 synthetic offers after reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sk-linkedin-task-'));
  const connectionId = randomUUID();
  const questions: string[] = [];
  const offers = new Set<string>();
  let segment = 0;
  let page = 1;
  const observation = () => ({
    url: `https://www.linkedin.com/messaging/?page=${page}`,
    text: Array.from(
      { length: 10 },
      (_, index) => `Offer ${String((page - 1) * 10 + index + 1).padStart(2, '0')}`,
    ).join('\n'),
    candidates: page < 5 ? [{ id: '@next', label: 'Next' }] : [],
  });
  const agent: Agent = {
    open: async (input) => ({
      resumed: false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {
        const tools = new Map(input.tools.map((entry) => [entry.name, entry]));
        const connection = tools.get('browser_connection')!;
        if (segment++ === 0) {
          await connection.execute({
            action: 'connect',
            url: 'https://www.linkedin.com/messaging/',
          });
          return;
        }
        const result = value(
          await connection.execute({
            action: 'use',
            connectionId,
            url: 'https://www.linkedin.com/messaging/',
          }),
        );
        assert.equal(result.status, 'session_opened');
        let current = result.observation;
        for (;;) {
          for (const offer of current.text.split('\n')) offers.add(offer);
          if (!current.candidates.length) break;
          current = value(
            await tools.get('browser')!.execute({ action: 'click', selector: '@next' }),
          );
        }
      },
    }),
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    workspace: fakeWorkspace(),
    computer: fakeComputer({
      act: async (_taskId, action) => {
        if (action.action === 'click') page += 1;
        return observation();
      },
    }),
  });
  const context = (): RuntimeContext => ({
    taskId: randomUUID(),
    ownerId: 'synthetic-owner',
    prompt: 'Find the last 50 job offers I got on LinkedIn. Send nothing.',
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
      throw new Error('No file is expected.');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
    waitForUser: async (question) => {
      questions.push(question);
    },
    browserConnection: async (request) =>
      request.action === 'connect'
        ? { name: 'linkedin.com', url: `/browser-connect/${'a'.repeat(43)}`, connectionId }
        : { status: 'session_opened', connectionId, observation: observation() },
  });
  try {
    const first = await runtime.runTask(context());
    assert.equal(first.status, 'waiting_user');
    assert.match(questions[0], /Connect website/);
    assert.match(questions[0], /browser-connect/);
    const second = await runtime.runTask(context());
    assert.equal(second.status, 'succeeded');
    assert.equal(offers.size, 50);
    assert.ok(offers.has('Offer 01'));
    assert.ok(offers.has('Offer 50'));
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('website account work asks for a Vault login before a browser connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sk-vault-first-'));
  let supplied: { systemPrompt: string; description: string } | undefined;
  const agent: Agent = {
    open: async (input) => {
      supplied = {
        systemPrompt: input.systemPrompt,
        description: input.tools.find((entry) => entry.name === 'browser_connection')!.description,
      };
      return { resumed: false, abort: () => {}, dispose: () => {}, prompt: async () => {} };
    },
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    workspace: fakeWorkspace(),
    computer: fakeComputer(),
  });
  try {
    await runtime.runTask({
      taskId: randomUUID(),
      ownerId: 'synthetic-owner',
      prompt: 'Sign in to the toll website and get my latest statement.',
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
        throw new Error('No file is expected.');
      },
      requestCredential: async () => ({}),
      integration: async () => ({}),
      manage: async () => ({}),
      browserConnection: async () => ({}),
    });
    const prompt = supplied!.systemPrompt;
    const vault = prompt.indexOf('use inspect_login, and follow the Vault sign-in flow');
    const fallback = prompt.indexOf(
      'Use browser_connection connect only when fresh inspection reports browser_not_supported, a credential request returns sign_in_blocked, or the current user explicitly asks Otto to keep a website session',
    );
    assert.ok(vault > 0);
    assert.ok(fallback > vault);
    assert.match(prompt, /Add login when no login is saved/);
    assert.doesNotMatch(prompt, /use browser_connection connect with the page/);
    assert.match(supplied!.description, /use inspect_login, then request_credentials/);
    assert.match(
      supplied!.description,
      /Use connect only when inspect_login reports browser_not_supported, request_credentials returns sign_in_blocked, or the user explicitly asks to keep a website session/,
    );
    assert.doesNotMatch(supplied!.description, /Use connect when account data is needed/);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
