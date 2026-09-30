import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  Agent,
  AgentEvent,
  AgentSessionOptions,
  AgentTool,
  RuntimeContext,
} from '../src/ports/agent.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import type { Computer, Workspace } from '../src/ports/computer.ts';

async function fixture(
  run: (
    tools: Map<string, AgentTool>,
    emit: (event: AgentEvent) => void,
    options: AgentSessionOptions,
  ) => Promise<void>,
  overrides: Partial<RuntimeContext> = {},
  runtimeOptions: {
    observationTimeoutMs?: number;
    computer?: Computer;
    workspace?: Workspace;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-session-'));
  const replies: string[] = [];
  const deltas: string[] = [];
  let aborted = false;
  let supplied: AgentSessionOptions | undefined;
  let userPrompt = '';
  const context: RuntimeContext = {
    threadId: 'test-' + randomUUID(),
    turnId: randomUUID(),
    prompt: 'Help with a fixture',
    history: [],
    workspacePath: directory,
    signal: new AbortController().signal,
    attachments: [],
    emit: async () => {},
    reply: async (text) => {
      replies.push(text);
    },
    delta: (text, _id, done) => {
      if (!done) deltas.push(text);
    },
    publish: async () => {
      throw new Error('Not used');
    },
    requestCredential: async () => ({ url: '/credentials/fixture' }),
    integration: async () => ({}),
    manage: async () => ({}),
    ...overrides,
  };
  const agent: Agent = {
    open: async (options) => {
      supplied = options;
      return {
        resumed: false,
        prompt: async (text) => {
          userPrompt = text;
          await run(
            new Map(options.tools.map((tool) => [tool.name, tool])),
            options.onEvent,
            options,
          );
        },
        abort: () => {
          aborted = true;
        },
        dispose: () => {},
      };
    },
    dispose: () => {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer({
      inspectLogin: async () => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [{ kind: 'password', selector: '#password', label: 'Password' }],
        methods: [{ id: 'credentials', kind: 'credentials', label: 'Password', supported: true }],
      }),
    }),
    workspace: fakeWorkspace(),
    ...runtimeOptions,
  });
  try {
    const result = await runtime.runTurn(context);
    return {
      result,
      replies,
      deltas,
      aborted,
      supplied: supplied!,
      userPrompt,
    };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call(tools: Map<string, AgentTool>, name: string, args: Record<string, unknown>) {
  return tools.get(name)!.execute(args);
}

test('long foreground work keeps both useful progress messages', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const computer = fakeComputer({
    act: async () => ({ url: 'https://example.test/jobs', text: 'Synthetic jobs', candidates: [] }),
  });
  try {
    const result = await fixture(
      async (tools) => {
        await call(tools, 'browser', { action: 'open', url: 'https://example.test/jobs' });
        await call(tools, 'browser', { action: 'snapshot' });
        now += 60_000;
        await call(tools, 'browser', { action: 'snapshot' });
        await call(tools, 'send_message', { text: 'I found the first source.' });
        await call(tools, 'browser', { action: 'snapshot' });
        await call(tools, 'send_message', { text: 'I checked another source.' });
      },
      {},
      { computer },
    );
    assert.equal(result.result.status, 'succeeded');
    assert.equal(result.replies.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('chat login solicitations are withheld without inspecting or opening Vault', async () => {
  for (const method of ['ask_user', 'send_message', 'final']) {
    let requests = 0;
    let inspections = 0;
    let prompts = 0;
    const outputs: string[] = [];
    const result = await fixture(
      async (tools, emit) => {
        prompts++;
        const text = "What's your X username?";
        if (prompts > 1) emit({ type: 'final', text: 'I will use secure sign-in instead.' });
        else if (method === 'final') {
          emit({ type: 'text_delta', text: "What's your X " });
          emit({ type: 'text_delta', text: 'username?' });
          emit({ type: 'final', text });
        } else {
          const output = await call(
            tools,
            method,
            method === 'ask_user' ? { question: text } : { text },
          );
          outputs.push(JSON.stringify(output.content));
        }
      },
      {
        requestCredential: async () => {
          requests++;
          return { url: '/vault/fixture' };
        },
      },
      {
        computer: fakeComputer({
          inspectLogin: async () => {
            inspections++;
            throw new Error('Unused fixture inspection.');
          },
        }),
      },
    );
    assert.equal(result.result.status, 'succeeded', method);
    assert.equal(requests, 0, method);
    assert.equal(inspections, 0, method);
    assert.equal(result.deltas.join('').includes('username'), false);
    if (method === 'final') {
      assert.equal(prompts, 2);
      assert.match(result.userPrompt, /Not sent: never ask for passwords/);
      assert.deepEqual(result.replies, ['I will use secure sign-in instead.']);
    } else {
      assert.equal(prompts, 1);
      assert.deepEqual(result.replies, []);
      assert.match(outputs[0], /withheld/);
    }
  }
});

test('a continuation repeating the same private-input request fails instead of being deduplicated', async () => {
  let prompts = 0;
  await assert.rejects(
    fixture(async (_tools, emit) => {
      prompts++;
      emit({ type: 'final', text: "What's your username?" });
    }),
    /The reply kept asking for private sign-in details/,
  );
  assert.equal(prompts, 2);
});

test('PIN and semantic login identifier requests never reach chat', async () => {
  for (const text of [
    'Qual é o teu PIN da Chave Móvel Digital?',
    'Envia-me o teu código PIN.',
    'Preciso do seu PIN de autenticação.',
    'What is your sign-in PIN?',
    'Podes indicar o PIN da CMD?',
    'Please enter the PIN.',
    'Fornece o teu número de telemóvel para iniciar sessão.',
    'Qual é o código de segurança?',
    'Qual é o código que recebeste por SMS?',
    'What is the code you received?',
    'Can you send the code?',
    'Indica o código recebido no telemóvel.',
    'Enter your tax identification number to sign in.',
    'Qual é o teu NIF para entrar?',
    'Envía tu contraseña para iniciar sesión.',
    'Indiquez votre mot de passe pour vous connecter.',
    'Quel est votre mot de passe?',
    'Quel est votre code de vérification?',
    '¿Cuál es tu contraseña?',
    '¿Cuál es el código de verificación?',
    'Enter the code to continue.',
    'Introduz o código para continuar.',
    'What is your phone number for signing in?',
    'What is your email for logging in?',
    'Email, please, to continue logging in.',
    'O teu email, por favor, para iniciar sessão.',
    'Your phone number, please, to sign in.',
    'Sign in: your email, please.',
  ]) {
    for (const method of ['ask_user', 'send_message', 'final']) {
      let prompts = 0;
      const result = await fixture(async (tools, emit) => {
        prompts++;
        if (prompts > 1) emit({ type: 'final', text: 'I will use secure sign-in instead.' });
        else if (method === 'final') {
          emit({ type: 'text_delta', text });
          emit({ type: 'final', text });
        } else await call(tools, method, method === 'ask_user' ? { question: text } : { text });
      });
      assert.equal(result.result.status, 'succeeded', `${method}: ${text}`);
      assert.equal(result.replies.includes(text), false, `${method}: ${text}`);
      assert.equal(result.deltas.join('').includes(text), false, `${method}: ${text}`);
    }
  }
});

test('sign-in method questions remain available without requesting credential values', async () => {
  for (const question of [
    'Queres usar Cartão de Cidadão ou Chave Móvel Digital?',
    'Preferes Telemóvel ou Código QR?',
    'Qual é o método de autenticação: NIF ou EORI?',
    'Can you send the code snippet?',
    'What is the code that calculates tax?',
    'Can you share the QR code image?',
    'Sign in with email to continue.',
    'Continua com email para iniciar sessão.',
  ]) {
    const result = await fixture(async (tools) => {
      await call(tools, 'ask_user', { question });
    });
    assert.equal(result.result.status, 'waiting_user');
    assert.deepEqual(result.replies, [question]);
  }
});

test('secure credential pause prevents subsequent tools in the same execution segment', async () => {
  for (const input of [
    {
      origin: 'https://example.com',
      label: 'Example',
      kind: 'password' as const,
      passwordSelector: '@password',
    },
    {
      origin: 'https://example.com',
      label: 'Example',
      kind: 'otp' as const,
      passwordSelector: '@verification',
      emailCode: true,
    },
  ]) {
    let managed = false;
    let requested = false;
    const result = await fixture(
      async (tools) => {
        await call(tools, 'get_credential', { ...input });
        await assert.rejects(
          call(tools, 'manage_personal_context', {
            action: 'goal_create',
            args: { title: 'must not run' },
          }),
          /stopped/,
        );
      },
      {
        requestCredential: async (request) => {
          assert.deepEqual(request, input);
          requested = true;
          return { url: '/credentials/fixture' };
        },
        manage: async () => {
          managed = true;
          return {};
        },
      },
    );
    assert.equal(result.result.status, 'waiting_credentials');
    assert.equal(result.aborted, true);
    assert.equal(requested, true);
    assert.equal(managed, false);
    assert.equal(result.replies.length, 1);
  }
});

test('a chosen saved login reaches the credential broker without pausing the turn', async () => {
  const input = {
    origin: 'https://example.com',
    label: 'Example',
    kind: 'password' as const,
    usernameSelector: '@account',
    passwordSelector: '@password',
    savedLoginId: randomUUID(),
  };
  let requested = false;
  const result = await fixture(
    async (tools) => {
      await call(tools, 'get_credential', { ...input });
    },
    {
      requestCredential: async (request) => {
        assert.deepEqual(request, input);
        requested = true;
        return { filled: true };
      },
    },
  );
  assert.equal(requested, true);
  assert.equal(result.result.status, 'succeeded');
  assert.equal(result.aborted, false);
  assert.deepEqual(result.replies, []);
});

test('Pi can get an owned Vault login without putting its value in runtime observations', async () => {
  const secret = 'synthetic-vault-password';
  const observations: unknown[] = [];
  const id = randomUUID();
  await fixture(
    async (tools) => {
      assert.deepEqual(
        await call(tools, 'get_credential', { id, origin: 'https://example.test' }),
        {
          content: [
            { type: 'text', text: JSON.stringify({ username: 'fixture', password: secret }) },
          ],
          details: {},
        },
      );
      await call(tools, 'browser', {
        action: 'fill',
        selector: '#search',
        text: 'private fixture text',
      });
    },
    {
      observe: async (event) => {
        observations.push(event);
      },
      requestCredential: async () => ({ credential: { username: 'fixture', password: secret } }),
    },
  );
  assert.equal(JSON.stringify(observations).includes(secret), false);
  assert.equal(JSON.stringify(observations).includes('private fixture text'), false);
});

const refusal = 'This turn can only read. Use app reads, and browser open, snapshot or scroll.';

const refused: Array<[string, Record<string, unknown>]> = [
  ['browser', { action: 'click', selector: '@send' }],
  ['browser', { action: 'fill', selector: '@reply', text: 'Synthetic reply' }],
  ['browser', { action: 'share_screenshot' }],
  [
    'browser_session',
    { action: 'use', url: 'https://mail.example.test/', connectionId: randomUUID() },
  ],
  ['bash', { command: 'curl https://example.test' }],
  ['write', { path: 'notes.txt', content: 'Synthetic note' }],
  ['share_file', { path: 'notes.txt' }],
  ['manage_apps', { action: 'connect', service: 'gmail' }],
  ['manage_personal_context', { action: 'schedule_create', args: { title: 'Synthetic' } }],
  [
    'get_credential',
    { action: 'request', origin: 'https://mail.example.test', label: 'Sign in', kind: 'password' },
  ],
  ['ask_user', { question: 'Which email should I answer?' }],
];

test('a read-only turn refuses every outside action with a fixed error and still posts its findings', async () => {
  let sideEffects = 0;
  const result = await fixture(
    async (tools, _emit, options) => {
      for (const [name, args] of refused)
        await assert.rejects(
          tools.has(name)
            ? call(tools, name, args)
            : options.runTool(name, args, async () => {
                sideEffects++;
                return { content: [] };
              }),
          (error: Error) => error.message === refusal,
          name,
        );
      await call(tools, 'apps', { action: 'GMAIL_FETCH_EMAILS', args: {} });
      await options.runTool(
        'fetch_content',
        { urls: ['https://example.test/source'] },
        async () => ({
          content: [{ type: 'text', text: 'Synthetic source' }],
        }),
      );
      await call(tools, 'send_message', { text: 'You have two threads to answer.' });
    },
    {
      readOnly: true,
      background: true,
      requestCredential: async () => {
        sideEffects++;
        return {};
      },
      manage: async () => {
        sideEffects++;
        return {};
      },
      integration: async (action) => {
        assert.equal(action, 'GMAIL_FETCH_EMAILS');
        return {};
      },
    },
    {
      computer: fakeComputer({
        act: async () => {
          sideEffects++;
          return { text: '', url: 'https://mail.example.test/', candidates: [] };
        },
      }),
    },
  );
  assert.equal(sideEffects, 0);
  assert.deepEqual(result.replies, ['You have two threads to answer.']);
  assert.deepEqual(result.result, { status: 'succeeded' });
});

test('activity checks scope reads to one account, deny other tools and record exactly once without chat', async () => {
  const connectionId = randomUUID();
  const otherConnectionId = randomUUID();
  const records: unknown[] = [];
  const reads: string[] = [];
  let forbiddenCalls = 0;
  const result = await fixture(
    async (tools, emit, options) => {
      assert.deepEqual([...tools.keys()].sort(), ['apps', 'record_activity_check']);
      for (const [name, args] of [
        ...refused,
        ['send_message', { text: 'Unnecessary check update' }],
        ['web_search', { query: 'Synthetic query' }],
        ['read', { path: '/fixture/workspace/private.txt' }],
        ['read', { path: '.otto/skills/connected-apps/../../private.txt' }],
        ['read', { path: '.otto/skills/unknown/SKILL.md' }],
        ['find', { pattern: '*' }],
        ['ls', { path: '.' }],
      ] as Array<[string, Record<string, unknown>]>)
        await assert.rejects(
          options.runTool(name, args, async () => {
            forbiddenCalls++;
            return { content: [] };
          }),
          /Activity checks can only/,
        );
      for (const args of [
        {},
        { connectionId: otherConnectionId },
        { connectionId, nested: { connectionId: otherConnectionId } },
      ])
        await assert.rejects(
          call(tools, 'apps', { action: 'FIXTURE_READ', args }),
          /selected account/,
        );
      await assert.rejects(
        call(tools, 'apps', { action: 'SEARCH_TOOLS', args: { connectionId: otherConnectionId } }),
        /selected account/,
      );
      await assert.rejects(
        call(tools, 'apps', { action: 'GMAIL_GET_ATTACHMENT', args: { connectionId } }),
        /selected account/,
      );
      await options.runTool(
        'read',
        { path: '/fixture/workspace/.otto/skills/connected-apps/SKILL.md' },
        async () => ({ content: [{ type: 'text', text: 'Synthetic skill' }] }),
      );
      await call(tools, 'apps', { action: 'SEARCH_TOOLS', args: { query: 'Recent activity' } });
      await assert.rejects(
        call(tools, 'record_activity_check', {
          status: 'verified',
          value: 'none',
          summary: 'No change',
        }),
        /successful app read/,
      );
      await call(tools, 'apps', { action: 'FIXTURE_READ', args: { connectionId } });
      const recorded = await Promise.allSettled([
        call(tools, 'record_activity_check', {
          status: 'verified',
          value: 'item-1',
          summary: 'One new request',
          finding: {
            id: 'item-1',
            url: 'https://example.test/item-1',
            summary: 'A reply is needed',
          },
        }),
        call(tools, 'record_activity_check', {
          status: 'verified',
          value: 'duplicate',
          summary: 'Duplicate',
        }),
      ]);
      assert.equal(recorded.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(options.shouldStop(), true);
      await assert.rejects(
        call(tools, 'apps', { action: 'FIXTURE_READ', args: { connectionId } }),
        /stopped/,
      );
      emit({ type: 'text_delta', text: 'Routine check finished.' });
      emit({ type: 'final', text: 'Routine check finished.' });
    },
    {
      readOnly: true,
      activityCheck: {
        connectionId,
        record: async (result) => {
          records.push(result);
        },
      },
      integration: async (action, args, signal) => {
        assert.ok(signal);
        assert.equal(signal.aborted, false);
        if (action !== 'SEARCH_TOOLS') assert.equal(args.connectionId, connectionId);
        reads.push(action);
        return action === 'SEARCH_TOOLS'
          ? { tools: ['FIXTURE_READ'] }
          : { successful: true, data: { items: [{ id: 'item-1', text: 'Synthetic request' }] } };
      },
    },
  );
  assert.equal(forbiddenCalls, 0);
  assert.deepEqual(reads, ['SEARCH_TOOLS', 'FIXTURE_READ']);
  assert.equal(records.length, 1);
  assert.deepEqual(result.replies, []);
  assert.deepEqual(result.deltas, []);
  assert.equal(result.result.status, 'succeeded');
});

test('failed, approval and omitted app results cannot verify an activity check', async () => {
  for (const response of [
    { successful: false, data: { items: [] } },
    { success: false, data: { items: [] } },
    { isError: true, content: [{ type: 'text', text: 'Unavailable' }] },
    { error: 'Unavailable' },
    { data: { status: 'rejected' } },
    { requiresConfirmation: true, question: 'Allow a write?' },
    { requiresApproval: true },
    { truncated: true, resultOmitted: true, message: 'Response omitted' },
    { truncated: true, message: 'Response omitted' },
    { workspaceFile: 'download.txt', id: 'artifact' },
    {},
  ]) {
    const connectionId = randomUUID();
    const records: unknown[] = [];
    const result = await fixture(
      async (tools) => {
        await call(tools, 'apps', { action: 'FIXTURE_READ', args: { connectionId } });
        await assert.rejects(
          call(tools, 'record_activity_check', {
            status: 'verified',
            value: 'none',
            summary: 'No change',
          }),
          /successful app read/,
        );
        await call(tools, 'record_activity_check', {
          status: 'unavailable',
          summary: 'Could not inspect the source',
        });
      },
      {
        readOnly: true,
        background: true,
        activityCheck: {
          connectionId,
          record: async (record) => {
            records.push(record);
          },
        },
        integration: async () => response,
      },
    );
    assert.deepEqual(records, [{ status: 'unavailable', summary: 'Could not inspect the source' }]);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.replies, []);
  }
});

test('an activity check can report unavailable without a read but cannot silently omit its record', async () => {
  let records = 0;
  await fixture(
    async (tools) => {
      await call(tools, 'record_activity_check', {
        status: 'unavailable',
        summary: 'No suitable read is available',
      });
    },
    {
      activityCheck: {
        connectionId: randomUUID(),
        record: async () => {
          records++;
        },
      },
    },
  );
  await assert.rejects(
    fixture(async () => {}, {
      activityCheck: {
        connectionId: randomUUID(),
        record: async () => {
          records++;
        },
      },
    }),
    /did not record a result/,
  );
  assert.equal(records, 1);
});
