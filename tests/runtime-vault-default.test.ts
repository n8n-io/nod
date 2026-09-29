import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Agent, RuntimeContext } from '../src/ports/agent.ts';
import { BrowserActionError, type Computer } from '../src/ports/computer.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { requestsManualSignIn, userRequestsManualSignIn } from '../src/runtime/communication.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const manualSignIn =
  'Please use Sign in in browser under the browser controls, sign in to X in that separate window, then choose Continue in Otto.';

for (const [prompt, solicitation] of [
  ['Get my bookmarks on x.com.', manualSignIn],
  ['I want a Vault link instead of Sign in in browser.', manualSignIn],
  ['Do not ask me to sign in manually; use Vault.', manualSignIn],
  ['Get my bookmarks on x.com.', 'Please provide your login credentials so I can continue.'],
  ['Get my bookmarks on x.com.', 'Please share your sign-in details to continue.'],
] as const)
  for (const method of ['ask_user', 'send_message', 'final'])
    test(`${method} uses the current Vault step for ${prompt}: ${solicitation}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'otto-vault-default-'));
      const replies: string[] = [];
      const deltas: string[] = [];
      const requests: Array<Parameters<RuntimeContext['requestCredential']>[0]> = [];
      let inspections = 0;
      let holds = 0;
      const agent: Agent = {
        open: async (options) => ({
          resumed: false,
          prompt: async () => {
            await assert.rejects(
              options.tools
                .find((tool) => tool.name === 'browser')!
                .execute({
                  action: 'open',
                  url: 'https://x.com/i/bookmarks',
                }),
            );
            if (method === 'final') {
              options.onEvent({ type: 'text_delta', text: solicitation });
              options.onEvent({ type: 'final', text: solicitation });
            } else
              await options.tools
                .find((tool) => tool.name === method)!
                .execute(
                  method === 'ask_user' ? { question: solicitation } : { text: solicitation },
                );
          },
          abort() {},
          dispose() {},
        }),
        dispose() {},
      };
      const runtime = createAgentRuntime({
        agent,
        workspace: fakeWorkspace(),
        computer: fakeComputer({
          act: async () => {
            throw new BrowserActionError('browser_navigation_failed');
          },
          inspectLogin: async () => {
            inspections++;
            return {
              origin: 'https://x.com',
              url: 'https://x.com/i/flow/login',
              fields: [{ kind: 'identifier', selector: '#username', label: 'Username' }],
              methods: [],
              submitSelector: '#next',
            };
          },
          hold: async () => {
            holds++;
          },
        }),
      });
      try {
        const result = await runtime.runTask({
          taskId: randomUUID(),
          ownerId: 'fixture-owner',
          prompt,
          history: [],
          memories: [],
          workspacePath: directory,
          signal: new AbortController().signal,
          attachments: [],
          emit: async () => {},
          reply: async (text) => {
            replies.push(text);
          },
          delta: (text) => {
            deltas.push(text);
          },
          remember: async () => {},
          publish: async () => {
            throw new Error('Unused fixture artifact.');
          },
          requestCredential: async (input) => {
            requests.push(input);
            return { url: '/vault/current-x-login' };
          },
          integration: async () => ({}),
          manage: async () => ({}),
        });
        assert.equal(result.status, 'waiting_credentials');
        assert.equal(result.waitingFor, 'credentials');
        assert.equal(inspections, 1);
        assert.equal(holds, 0);
        assert.deepEqual(requests, [
          {
            origin: 'https://x.com',
            label: 'Sign in',
            kind: 'identifier',
            passwordSelector: '#username',
            submitSelector: '#next',
          },
        ]);
        assert.deepEqual(replies, [
          'https://x.com needs you to sign in. [Enter login details](/vault/current-x-login) and I will continue the task.',
        ]);
        assert.doesNotMatch(
          deltas.join(''),
          /Sign in in browser|Continue in Otto|login credentials|sign-in details/,
        );
      } finally {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });

async function signInFailureFixture(options: {
  method?: 'ask_user' | 'send_message' | 'final';
  computer: Partial<Computer>;
  prompt?: string;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-vault-failure-'));
  const replies: string[] = [];
  const waits: string[] = [];
  const prompts: string[] = [];
  let requests = 0;
  let holds = 0;
  let resultFromTool: unknown;
  const recoveredReply = 'The website did not load. I could not reach its login page.';
  const agent: Agent = {
    open: async (session) => ({
      resumed: false,
      prompt: async (text) => {
        prompts.push(text);
        const method = options.method ?? 'final';
        if (method === 'final')
          session.onEvent({
            type: 'final',
            text: prompts.length === 1 ? manualSignIn : recoveredReply,
          });
        else {
          resultFromTool = await session.tools
            .find((tool) => tool.name === method)!
            .execute(method === 'ask_user' ? { question: manualSignIn } : { text: manualSignIn });
          session.onEvent({ type: 'final', text: recoveredReply });
        }
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({
    agent,
    computer: fakeComputer({
      hold: async () => {
        holds++;
      },
      ...options.computer,
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTask({
      taskId: randomUUID(),
      ownerId: 'fixture-owner',
      prompt: options.prompt ?? 'Get my bookmarks on x.com.',
      history: [],
      memories: [],
      workspacePath: directory,
      signal: new AbortController().signal,
      attachments: [],
      emit: async () => {},
      reply: async (text) => {
        replies.push(text);
      },
      waitForUser: async (text) => {
        waits.push(text);
      },
      delta() {},
      remember: async () => {},
      publish: async () => {
        throw new Error('Unused fixture artifact.');
      },
      requestCredential: async () => {
        requests++;
        return { url: '/vault/fixture' };
      },
      integration: async () => ({}),
      manage: async () => ({}),
    });
    return { result, replies, waits, prompts, requests, holds, resultFromTool, recoveredReply };
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const method of ['ask_user', 'send_message', 'final'] as const)
  test(`${method} does not convert unavailable browser inspection into a manual sign-in wait`, async () => {
    const result = await signInFailureFixture({
      method,
      computer: {
        inspectLogin: async () => {
          throw new BrowserActionError('browser_navigation_failed');
        },
      },
    });
    assert.equal(result.result.status, 'succeeded');
    assert.equal(result.requests, 0);
    assert.equal(result.holds, 0);
    assert.deepEqual(result.waits, []);
    assert.deepEqual(result.replies, [result.recoveredReply]);
    if (method === 'final') {
      assert.equal(result.prompts.length, 2);
      assert.match(result.prompts[1], /sign_in_unavailable/);
      assert.match(result.prompts[1], /Recover browser navigation/);
    } else assert.match(JSON.stringify(result.resultFromTool), /sign_in_unavailable/);
  });

test('manual sign-in instructions remain available when the current user explicitly asks for them', async () => {
  let inspections = 0;
  const result = await signInFailureFixture({
    prompt: 'How do I use Sign in in browser to sign in myself?',
    computer: {
      inspectLogin: async () => {
        inspections++;
        throw new Error('No inspection needed for requested instructions.');
      },
    },
  });
  assert.equal(inspections, 0);
  assert.equal(result.prompts.length, 1);
  assert.deepEqual(result.replies, [manualSignIn]);
});

test('fresh verified browser rejection can request native sign-in without creating a Vault form', async () => {
  let inspections = 0;
  const result = await signInFailureFixture({
    method: 'ask_user',
    computer: {
      inspectLogin: async () => {
        inspections++;
        return {
          origin: 'https://example.com',
          url: 'https://example.com/login',
          fields: [],
          methods: [],
          issue: 'browser_not_supported',
        };
      },
    },
  });
  assert.equal(inspections, 1);
  assert.equal(result.result.status, 'waiting_user');
  assert.equal(result.requests, 0);
  assert.deepEqual(result.waits, [manualSignIn]);
});

test('manual sign-in detection covers browser-control wording without classifying ordinary site work', () => {
  for (const text of [
    manualSignIn,
    'Please take control of the browser and log in to X.',
    'Finish signing in manually before continuing.',
    'Please log into X in a separate browser window.',
    'Use the browser controls to sign in to your account.',
  ])
    assert.equal(requestsManualSignIn(text), true, text);
  for (const text of [
    'I will open the bookmarks page.',
    'The browser could not load X.',
    'I found the sign-in form. I can continue securely.',
  ])
    assert.equal(requestsManualSignIn(text), false, text);
  assert.equal(userRequestsManualSignIn('Get my bookmarks on x.com.'), false);
  assert.equal(userRequestsManualSignIn('Open X and sign in using Vault.'), false);
  assert.equal(userRequestsManualSignIn('How do I use Sign in in browser?'), true);
  for (const text of [
    'I want a Vault link instead of Sign in in browser.',
    'Do not ask me to sign in manually; use Vault.',
    'I prefer Vault rather than a separate browser for sign-in.',
    'Please stop asking me to use Sign in in browser.',
  ])
    assert.equal(userRequestsManualSignIn(text), false, text);
});
