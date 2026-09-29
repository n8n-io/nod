import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Agent, AgentTool, RuntimeContext, RuntimeObservation } from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const refusal = 'This task can only read. Use app reads, and browser open, snapshot or scroll.';

const refused: Array<[string, Record<string, unknown>]> = [
  ['browser', { action: 'click', selector: '@send' }],
  ['browser', { action: 'fill', selector: '@reply', text: 'Synthetic reply' }],
  ['browser', { action: 'press', key: 'Enter' }],
  ['browser_fast_step', { goal: 'Send the reply' }],
  ['browser_connection', { action: 'connect', url: 'https://mail.example.test/' }],
  ['shell', { command: 'curl https://example.test' }],
  ['write_file', { path: 'notes.txt', content: 'Synthetic note' }],
  ['publish_artifact', { path: 'notes.txt' }],
  ['manage_apps', { action: 'connect', service: 'gmail' }],
  ['manage_personal_context', { action: 'goal_create', args: { title: 'Synthetic goal' } }],
  ['manage_personal_context', { action: 'schedule_create', args: { title: 'Synthetic' } }],
  ['remember', { quote: 'Synthetic fact' }],
  ['inspect_login', {}],
  ['select_login_method', { origin: 'https://mail.example.test', methodId: 'google' }],
  [
    'request_credentials',
    { origin: 'https://mail.example.test', label: 'Sign in', kind: 'password' },
  ],
  ['ask_user', { question: 'Which email should I answer?' }],
  ['send_screenshot', {}],
  ['create_audio', { text: 'Synthetic speech' }],
];

async function run(readOnly: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-welcome-read-only-'));
  const outcomes = new Map<string, string>();
  const browserActions: string[] = [];
  const integrationCalls: string[] = [];
  const manageCalls: string[] = [];
  const replies: string[] = [];
  const observations: RuntimeObservation[] = [];
  let commands = 0;
  let writes = 0;
  let credentials = 0;
  let connections = 0;
  const agent: Agent = {
    open: async (input) => ({
      resumed: false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {
        const tools = new Map<string, AgentTool>(input.tools.map((entry) => [entry.name, entry]));
        const call = async (name: string, args: Record<string, unknown>) => {
          const key = `${name} ${String(args.action ?? '')}`.trim();
          try {
            const result = await tools.get(name)!.execute(args);
            const content = result.content[0];
            outcomes.set(key, content.type === 'text' ? content.text : content.type);
          } catch (error) {
            outcomes.set(key, `error: ${(error as Error).message}`);
          }
        };
        await call('manage_apps', { action: 'list' });
        await call('apps', { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 5 } });
        await call('manage_personal_context', { action: 'history_search', args: { query: 'x' } });
        await call('browser', { action: 'open', url: 'https://mail.example.test/' });
        await call('browser', { action: 'snapshot' });
        await call('browser', { action: 'scroll', direction: 'down' });
        await call('browser_screenshot', {});
        await call('read_file', { path: 'notes.txt' });
        if (!readOnly) {
          await call('browser', { action: 'click', selector: '@send' });
          return;
        }
        for (const [name, args] of refused) await call(name, args);
        await call('send_message', { text: 'You have two threads that wait for your reply.' });
      },
    }),
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    workspace: fakeWorkspace({
      open: () => ({
        path: '/fixture/workspace',
        instructions: 'Fixture workspace only.',
        execute: async () => {
          commands++;
          return 'Fixture output';
        },
        readFile: async () => 'Fixture content',
        writeFile: async () => {
          writes++;
          return 'File saved';
        },
      }),
    }),
    computer: fakeComputer({
      act: async (_taskId, action) => {
        browserActions.push(action.action);
        return { text: 'Synthetic inbox', url: 'https://mail.example.test/', candidates: [] };
      },
    }),
    chooseBrowserAction: async () => ({ outcome: 'DONE', elapsedMs: 1 }),
  });
  const context: RuntimeContext = {
    taskId: randomUUID(),
    ownerId: 'synthetic-owner',
    prompt: 'Synthetic welcome discovery',
    background: true,
    readOnly,
    history: [],
    memories: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async (text) => {
      replies.push(text);
    },
    delta: () => {},
    remember: async () => {},
    publish: async () => {
      throw new Error('No file is expected.');
    },
    requestCredential: async () => {
      credentials++;
      return {};
    },
    integration: async (action) => {
      integrationCalls.push(action);
      return { successful: true, data: { threads: 2 } };
    },
    connections: async (action) => {
      connections++;
      return action === 'list' ? [{ slug: 'gmail', status: 'connected' }] : {};
    },
    browserConnection: async () => {
      connections++;
      return {};
    },
    observe: async (event) => {
      observations.push(event);
    },
    manage: async (action) => {
      manageCalls.push(action);
      return { results: [] };
    },
  };
  try {
    const result = await runtime.runTask(context);
    return {
      result,
      outcomes,
      browserActions,
      integrationCalls,
      manageCalls,
      replies,
      observations,
      commands,
      writes,
      credentials,
      connections,
    };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a read-only task refuses every outside action with a fixed error and still posts its findings', async () => {
  const run1 = await run(true);
  for (const [name, args] of refused)
    assert.equal(
      run1.outcomes.get(`${name} ${String(args.action ?? '')}`.trim()),
      `error: ${refusal}`,
      name,
    );
  assert.match(run1.outcomes.get('manage_apps list')!, /gmail/);
  assert.match(run1.outcomes.get('apps GMAIL_FETCH_EMAILS')!, /threads/);
  assert.match(run1.outcomes.get('manage_personal_context history_search')!, /results/);
  assert.match(run1.outcomes.get('browser open')!, /Synthetic inbox/);
  assert.match(run1.outcomes.get('browser snapshot')!, /Synthetic inbox/);
  assert.match(run1.outcomes.get('browser scroll')!, /Synthetic inbox/);
  assert.equal(run1.outcomes.get('browser_screenshot'), 'Open a browser URL first.');
  assert.equal(run1.outcomes.get('read_file'), 'Fixture content');
  assert.deepEqual(run1.browserActions, ['open', 'snapshot', 'scroll']);
  assert.deepEqual(run1.integrationCalls, ['GMAIL_FETCH_EMAILS']);
  assert.deepEqual(run1.manageCalls, ['history_search']);
  assert.equal(run1.commands, 0);
  assert.equal(run1.writes, 0);
  assert.equal(run1.credentials, 0);
  assert.equal(run1.connections, 1);
  assert.deepEqual(run1.replies, ['You have two threads that wait for your reply.']);
  assert.deepEqual(run1.result, { status: 'succeeded' });
  const failures = run1.observations.filter(
    (event) => event.type === 'tool_end' && event.status === 'failed',
  );
  assert.equal(failures.length, refused.length);
  for (const event of failures) assert.equal(event.type === 'tool_end' && event.error, refusal);
  assert.equal(
    run1.observations.filter((event) => event.type === 'tool_start').length,
    run1.observations.filter((event) => event.type === 'tool_end').length,
  );
});

test('an ordinary task keeps browser clicks', async () => {
  const ordinary = await run(false);
  assert.deepEqual(ordinary.browserActions, ['open', 'snapshot', 'scroll', 'click']);
  assert.match(ordinary.outcomes.get('browser click')!, /Synthetic inbox/);
});
