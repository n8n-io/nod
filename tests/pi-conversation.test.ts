import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type {
  ConversationRouteDecision,
  ConversationRoutingContext,
} from '../src/ports/conversation.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { createPiConversationRouter } from '../src/providers/pi/conversation.ts';

const catalog = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const context = (): ConversationRoutingContext => ({
  text: 'Continue planning the trip.',
  hasAttachments: false,
  channel: 'web',
  conversationRevision: 3,
  signal: new AbortController().signal,
  candidates: [
    {
      outcomeId: 'outcome-one',
      title: 'Plan a trip',
      objective: 'Prepare a weekend itinerary.',
      taskId: 'private-task-id',
      status: 'waiting_user',
      waitingReason: 'credentials',
      recentMessages: [{ role: 'assistant', text: 'Use the secure form to sign in.' }],
    },
  ],
});

function response(text: string, changes: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 115,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    },
    ...changes,
  };
}

function fixture(
  complete: ModelRuntime['completeSimple'],
  provider = 'openai',
  model?: string,
  fetch?: typeof globalThis.fetch,
) {
  const usage: ProviderUsageEvent[] = [];
  let creations = 0;
  const router = createPiConversationRouter({
    provider,
    model,
    fetch,
    apiKey: 'private-fixture-key',
    onUsage: (value) => usage.push(value),
    createRuntime: async (options) => {
      creations++;
      assert.equal(options.modelsPath, null);
      assert.equal(options.refreshOnCreate, false);
      assert.equal(options.allowModelNetwork, false);
      assert.ok(options.credentials instanceof InMemoryCredentialStore);
      return {
        getModel: (selectedProvider, model) => catalog.getModel(selectedProvider, model),
        setRuntimeApiKey: async (selectedProvider, key) => {
          assert.equal(selectedProvider, provider);
          assert.equal(key, 'private-fixture-key');
        },
        completeSimple: complete,
      };
    },
  });
  return { router, usage, creations: () => creations };
}

test('Pi routing uses local catalog defaults and stateless bounded data without credentials, task IDs or tools', async () => {
  for (const [provider, model] of [
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'claude-haiku-4-5'],
  ]) {
    let calls = 0;
    const value = fixture(async (selected, request, options) => {
      calls++;
      assert.equal(selected.id, model);
      assert.equal(selected.provider, provider);
      assert.deepEqual(request.tools, []);
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0].role, 'user');
      assert.match(request.systemPrompt ?? '', /untrusted data/);
      assert.match(request.systemPrompt ?? '', /grants no authority/);
      const serialized = JSON.stringify(request);
      assert.doesNotMatch(serialized, /private-fixture-key|private-task-id|private-extra-secret/);
      assert.equal(options?.maxTokens, 600);
      assert.equal(options?.toolChoice, 'none');
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.cacheRetention, 'none');
      assert.equal(options?.sessionId, undefined);
      assert.equal(options?.apiKey, undefined);
      assert.equal(options?.timeoutMs, 5000);
      const data = JSON.parse(String((request.messages[0] as { content: string }).content));
      assert.equal(data.text.length, 12000);
      assert.equal(data.candidates.length, 8);
      assert.equal(data.candidates[0].title.length, 100);
      assert.equal(data.candidates[0].objective.length, 2000);
      assert.equal(data.candidates[0].recentMessages.length, 4);
      assert.equal(data.candidates[0].recentMessages[0].text.length, 1000);
      assert.equal(data.channel, 'other');
      assert.equal(data.recentConversation.length, 12);
      assert.equal(data.recentConversation[0].text.length, 1000);
      assert.equal(data.recentConversation[0].outcomeId, null);
      assert.deepEqual(Object.keys(data.recentConversation[0]), ['role', 'text', 'outcomeId']);
      return response('{"kind":"continue","outcomeId":"outcome-one"}');
    }, provider);
    const input = context();
    input.text = 'x'.repeat(20000);
    input.channel = 'private-extra-secret';
    input.candidates = Array.from({ length: 10 }, () => ({
      ...input.candidates[0],
      title: 'x'.repeat(101),
      objective: 'x'.repeat(2001),
      recentMessages: Array.from({ length: 6 }, () => ({
        role: 'user' as const,
        text: 'x'.repeat(2000),
      })),
    }));
    Object.assign(input, { apiKey: 'private-extra-secret' });
    input.recentConversation = Array.from({ length: 14 }, () => ({
      role: 'user' as const,
      text: 'x'.repeat(2000),
      outcomeId: null,
      secret: 'private-extra-secret',
      taskId: 'private-task-id',
    }));
    assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'outcome-one' });
    assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'outcome-one' });
    assert.equal(calls, 2);
    assert.equal(value.creations(), 1);
    assert.equal(value.usage.length, 2);
    assert.notEqual(value.usage[0].id, value.usage[1].id);
    assert.equal(value.usage[0].provider, provider);
    assert.equal(value.usage[0].operation, 'conversation_route');
    assert.equal(value.usage[0].inputTokens, 100);
    assert.equal(value.usage[0].outputTokens, 10);
    assert.equal(value.usage[0].cacheReadTokens, 5);
    assert.equal(value.usage[0].costUsd, 0.031);
    assert.equal(value.usage[0].pricing, 'sdk_estimate');
    assert.equal(value.usage[0].routingFailure, undefined);
    assert.doesNotMatch(JSON.stringify(value.usage), /private-|trip|credentials/);
  }
});

test('Pi routing preserves an explicit model override and reports the actual selected model', async () => {
  const value = fixture(
    async (model) => {
      assert.equal(model.id, 'gpt-4.1-nano');
      return response('{"kind":"conversation"}', { model: model.id });
    },
    'openai',
    'gpt-4.1-nano',
  );
  assert.deepEqual(await value.router(context()), { kind: 'conversation' });
  assert.equal(value.usage[0].model, 'gpt-4.1-nano');
});

test('Pi routing carries bounded blocked context without making it executable or exposing private fields', async () => {
  const input = context();
  input.text = 'Continue the earlier action';
  input.candidates = Array.from({ length: 2 }, (_, index) => ({
    ...input.candidates[0],
    outcomeId: `eligible-${index}`,
  }));
  input.blockedCandidates = Array.from({ length: 10 }, (_, index) => ({
    ...input.candidates[0],
    outcomeId: `blocked-${index}`,
    taskId: 'private-blocked-task-id',
    title: 'x'.repeat(150),
    objective: 'y'.repeat(2500),
    status: index % 2 ? 'waiting_user' : 'failed',
    waitingReason: index % 2 ? 'recovery' : null,
    recentMessages: Array.from({ length: 6 }, () => ({
      role: 'user' as const,
      text: 'z'.repeat(1500),
      secret: 'private-blocked-extra',
    })),
    secret: 'private-blocked-extra',
  }));
  let decision = { kind: 'continue', outcomeId: 'blocked-0' };
  const value = fixture(async (_model, request) => {
    const data = JSON.parse(String((request.messages[0] as { content: string }).content));
    assert.equal(data.candidates.length, 2);
    assert.equal(data.blockedCandidates.length, 6);
    assert.deepEqual(
      data.candidates.map((candidate: { outcomeId: string }) => candidate.outcomeId),
      ['eligible-0', 'eligible-1'],
    );
    assert.equal(data.blockedCandidates[0].title.length, 100);
    assert.equal(data.blockedCandidates[0].objective.length, 2000);
    assert.equal(data.blockedCandidates[0].recentMessages.length, 4);
    assert.equal(data.blockedCandidates[0].recentMessages[0].text.length, 1000);
    assert.equal(data.blockedCandidates[0].status, 'failed');
    assert.equal(data.blockedCandidates[1].waitingReason, 'recovery');
    assert.doesNotMatch(
      JSON.stringify(request),
      /private-blocked|private-fixture-key|private-task-id/,
    );
    assert.match(
      request.systemPrompt ?? '',
      /Never convert that continuation into conversation or new_outcome/,
    );
    assert.match(request.systemPrompt ?? '', /fully specified read or inspection/);
    return response(JSON.stringify(decision));
  });
  assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'blocked-0' });
  decision = { kind: 'continue', outcomeId: 'blocked-6' };
  await assert.rejects(value.router(input), { message: 'Conversation routing is unavailable.' });
});

test('Pi routing preserves identical blocked read context for fresh observations and explicit retry decisions', async () => {
  const input = context();
  input.candidates = [];
  input.text = 'Open https://example.com and tell me the page title.';
  input.blockedCandidates = [
    {
      outcomeId: 'blocked-browser',
      taskId: 'private-blocked-browser',
      title: 'Read Example Domain',
      objective: input.text,
      status: 'failed',
      waitingReason: null,
      recentMessages: [
        { role: 'user', text: input.text },
        { role: 'assistant', text: 'I couldn’t finish that. You can ask me to continue.' },
      ],
    },
    {
      outcomeId: 'blocked-email',
      taskId: 'private-blocked-email',
      title: 'Send confirmation',
      objective: 'Send the confirmation email to sam@example.test.',
      status: 'waiting_user',
      waitingReason: 'recovery',
      recentMessages: [],
    },
  ];
  input.recentConversation = [
    { role: 'user', text: 'What is 17 times 23?', outcomeId: null },
    { role: 'assistant', text: '391.', outcomeId: null },
  ];
  let decision: ConversationRouteDecision = {
    kind: 'new_outcome',
    title: 'Read the current page title',
    objective: input.text,
  };
  const value = fixture(async (_model, request) => {
    const data = JSON.parse(String((request.messages[0] as { content: string }).content));
    assert.equal(data.text, input.text);
    assert.deepEqual(data.candidates, []);
    assert.deepEqual(
      data.blockedCandidates.map((candidate: { outcomeId: string; status: string }) => [
        candidate.outcomeId,
        candidate.status,
      ]),
      [
        ['blocked-browser', 'failed'],
        ['blocked-email', 'waiting_user'],
      ],
    );
    assert.equal(
      data.blockedCandidates[0].objective,
      'Open https://example.com and tell me the page title.',
    );
    assert.equal(data.blockedCandidates[1].waitingReason, 'recovery');
    assert.deepEqual(data.recentConversation, input.recentConversation);
    assert.doesNotMatch(JSON.stringify(request), /private-blocked|private-fixture-key/);
    assert.match(request.systemPrompt ?? '', /Matching the earlier request is not itself a retry/);
    assert.match(request.systemPrompt ?? '', /Repeating an uncertain side effect is also continue/);
    return response(JSON.stringify(decision));
  });
  assert.deepEqual(await value.router(input), decision);
  input.text = 'Retry opening https://example.com and getting the title.';
  decision = { kind: 'continue', outcomeId: 'blocked-browser' };
  assert.deepEqual(await value.router(input), decision);
  input.text = 'Send the confirmation email to sam@example.test.';
  decision = { kind: 'continue', outcomeId: 'blocked-email' };
  assert.deepEqual(await value.router(input), decision);
});

test('Pi routing marks retryable failures apart from blocked outside actions', async () => {
  const input = context();
  input.text = 'Try again';
  input.candidates = [
    {
      outcomeId: 'retryable-read',
      taskId: 'private-retryable-read',
      title: 'Read the weather',
      objective: 'Read the current weather.',
      status: 'failed',
      waitingReason: null,
      recency: 2,
      recentMessages: [{ role: 'assistant', text: 'I couldn’t finish that.' }],
    },
    { ...context().candidates[0], recency: 3 },
  ];
  input.blockedCandidates = [
    {
      outcomeId: 'blocked-send',
      taskId: 'private-blocked-send',
      title: 'Send confirmation',
      objective: 'Send the confirmation email.',
      status: 'failed',
      waitingReason: null,
      recency: 1,
      recentMessages: [],
    },
  ];
  const value = fixture(async (_model, request) => {
    const data = JSON.parse(String((request.messages[0] as { content: string }).content));
    assert.deepEqual(
      data.candidates.map((item: { outcomeId: string; retryable: boolean }) => [
        item.outcomeId,
        item.retryable,
      ]),
      [
        ['retryable-read', true],
        ['outcome-one', false],
      ],
    );
    assert.equal(data.blockedCandidates[0].retryable, false);
    assert.deepEqual(
      [...data.candidates, ...data.blockedCandidates].map(
        (item: { recency: number }) => item.recency,
      ),
      [2, 3, 1],
    );
    assert.match(request.systemPrompt ?? '', /retryable true failed before Otto took any outside/);
    assert.match(request.systemPrompt ?? '', /may have already taken an outside action/);
    assert.doesNotMatch(JSON.stringify(request), /private-retryable-read|private-blocked-send/);
    return response('{"kind":"continue","outcomeId":"retryable-read"}');
  });
  assert.deepEqual(await value.router(input), { kind: 'continue', outcomeId: 'retryable-read' });
});

test('Pi routing accepts only strict decisions and rejects foreign IDs, extra authority and malformed output', async () => {
  let text = '{"kind":"conversation"}';
  let stopReason: AssistantMessage['stopReason'] = 'stop';
  let content: AssistantMessage['content'] | undefined;
  const value = fixture(async () =>
    response(text, { stopReason, ...(content ? { content } : {}) }),
  );
  assert.deepEqual(await value.router(context()), { kind: 'conversation' });
  text = '{"kind":"new_outcome","title":" Plan trip ","objective":" Prepare an itinerary. "}';
  assert.deepEqual(await value.router(context()), {
    kind: 'new_outcome',
    title: 'Plan trip',
    objective: 'Prepare an itinerary.',
  });
  for (text of [
    '{"kind":"continue","outcomeId":"foreign-outcome"}',
    '{"kind":"continue","outcomeId":"outcome-one","bypassWait":true}',
    '{"kind":"conversation","title":"unexpected"}',
    '{"kind":"new_outcome","title":"","objective":"not blank"}',
    JSON.stringify({ kind: 'new_outcome', title: 'x'.repeat(101), objective: 'work' }),
    JSON.stringify({ kind: 'new_outcome', title: 'work', objective: 'x'.repeat(2001) }),
    '```json\n{"kind":"conversation"}\n```',
    'private-provider-secret',
    ' '.repeat(4001),
  ])
    await assert.rejects(value.router(context()), {
      message: 'Conversation routing is unavailable.',
    });
  text = '{"kind":"conversation"}';
  stopReason = 'length';
  await assert.rejects(value.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  stopReason = 'stop';
  content = [
    { type: 'toolCall', id: 'tool', name: 'write_file', arguments: { secret: 'fixture' } },
  ];
  await assert.rejects(value.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  assert.equal(value.usage.filter((event) => event.status === 'succeeded').length, 2);
  assert.equal(value.usage.at(-1)?.status, 'failed');
  assert.equal(value.usage.at(-1)?.costUsd, 0.031);
});

test('Pi routing cancels promptly, forwards the signal and records late reported usage once without accepting its decision', async () => {
  let finish: ((value: AssistantMessage) => void) | undefined;
  let providerSignal: AbortSignal | undefined;
  const value = fixture(async (_model, _request, options) => {
    providerSignal = options?.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const controller = new AbortController();
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(value.router({ ...context(), signal: controller.signal }), {
    name: 'AbortError',
    message: 'Conversation routing cancelled.',
  });
  assert.equal(value.creations(), 0);
  assert.equal(value.usage.length, 1);
  assert.deepEqual(value.usage[0].routingFailure, { code: 'cancelled' });
  assert.equal(value.usage[0].costUsd, null);
  const live = new AbortController();
  const pending = value.router({ ...context(), signal: live.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finish);
  live.abort(new Error('private-abort-reason'));
  await assert.rejects(pending, { name: 'AbortError', message: 'Conversation routing cancelled.' });
  assert.equal(providerSignal?.aborted, true);
  finish(response('{"kind":"continue","outcomeId":"outcome-one"}'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.usage.length, 2);
  assert.equal(value.usage[1].status, 'cancelled');
  assert.equal(value.usage[1].costUsd, 0.031);
  assert.deepEqual(value.usage[1].routingFailure, { code: 'cancelled' });
  assert.doesNotMatch(JSON.stringify(value.usage), /private-abort-reason|outcome-one/);
});

test('Pi routing reports unavailable costs honestly and masks configuration and provider failures', async () => {
  const absentUsage: ProviderUsageEvent[] = [];
  const absent = createPiConversationRouter({
    provider: 'openai',
    onUsage: (value) => absentUsage.push(value),
  });
  await assert.rejects(absent(context()), { message: 'Conversation routing is not configured.' });
  assert.equal(absentUsage.length, 1);
  assert.deepEqual(absentUsage[0].routingFailure, { code: 'initialization' });
  assert.equal(absentUsage[0].costUsd, null);
  const failed = fixture(async () => {
    throw new Error('private-fixture-key: raw upstream error');
  });
  await assert.rejects(failed.router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  assert.equal(failed.usage.length, 1);
  assert.equal(failed.usage[0].status, 'failed');
  assert.equal(failed.usage[0].pricing, 'unavailable');
  assert.equal(failed.usage[0].costUsd, null);
  assert.deepEqual(failed.usage[0].routingFailure, { code: 'completion_setup' });
  const noCost = response('{"kind":"conversation"}');
  noCost.usage.cost.total = Number.NaN;
  const unpriced = fixture(async () => noCost);
  assert.deepEqual(await unpriced.router(context()), { kind: 'conversation' });
  assert.equal(unpriced.usage[0].pricing, 'unavailable');
  assert.equal(unpriced.usage[0].costUsd, null);
  assert.equal(unpriced.usage[0].inputTokens, 100);
});

test('Pi routing records initialization and model failures once and includes setup time', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const phase of ['create', 'credentials', 'model', 'missing', 'success'] as const) {
    const usage: ProviderUsageEvent[] = [];
    let calls = 0;
    const router = createPiConversationRouter({
      provider: 'openai',
      apiKey: 'private-fixture-key',
      onUsage: (value) => usage.push(value),
      createRuntime: async () => {
        now += 40;
        if (phase === 'create') throw new Error('private-initialization-error');
        return {
          setRuntimeApiKey: async () => {
            now += 30;
            if (phase === 'credentials') throw new Error('private-credential-error');
          },
          getModel: () => {
            now += 20;
            if (phase === 'model') throw new Error('private-model-error');
            return phase === 'missing' ? undefined : catalog.getModel('openai', 'gpt-6-luna');
          },
          completeSimple: async () => {
            calls++;
            now += 10;
            return response('{"kind":"conversation"}');
          },
        };
      },
    });
    if (phase === 'success') assert.deepEqual(await router(context()), { kind: 'conversation' });
    else
      await assert.rejects(router(context()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-/);
        assert.equal(error.cause, undefined);
        return true;
      });
    assert.equal(calls, phase === 'success' ? 1 : 0);
    assert.equal(usage.length, 1);
    assert.equal(
      usage[0].durationMs,
      phase === 'create' ? 40 : phase === 'credentials' ? 70 : phase === 'success' ? 100 : 90,
    );
    assert.equal(usage[0].model, 'gpt-6-luna');
    assert.deepEqual(
      usage[0].routingFailure,
      phase === 'success'
        ? undefined
        : {
            code: ['create', 'credentials'].includes(phase)
              ? 'initialization'
              : 'model_unavailable',
          },
    );
    assert.doesNotMatch(JSON.stringify(usage), /private-/);
  }
});

test('Pi routing records fixed validation failures without retaining provider content or foreign IDs', async () => {
  const cases = [
    [response('private-output', { stopReason: 'length' }), 'output_limit'],
    [response('private-output', { stopReason: 'toolUse' }), 'unexpected_tool'],
    [
      response('', {
        content: [{ type: 'toolCall', id: 'private-call', name: 'private-tool', arguments: {} }],
      }),
      'unexpected_tool',
    ],
    [response('private-output'.repeat(400)), 'text_limit'],
    [response('private-output'), 'invalid_json'],
    [response('{"kind":"conversation","private-field":"private-output"}'), 'invalid_decision'],
    [response('{"kind":"continue","outcomeId":"private-foreign-outcome"}'), 'unknown_outcome'],
  ] as const;
  for (const [message, code] of cases) {
    const value = fixture(async () => message);
    await assert.rejects(value.router(context()), {
      message: 'Conversation routing is unavailable.',
    });
    assert.equal(value.usage.length, 1);
    assert.equal(value.usage[0].status, 'failed');
    assert.equal(value.usage[0].costUsd, 0.031);
    assert.deepEqual(value.usage[0].routingFailure, { code });
    assert.doesNotMatch(JSON.stringify(value.usage), /private-/);
  }
});

test('Pi routing forwards identical fetch inputs and responses and records only bounded HTTP status', async () => {
  const request = new Request('https://provider.invalid/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer private-fixture-key' },
    body: 'private-request-body',
  });
  const init = { headers: { 'x-private-header': 'private-header-value' } };
  for (const status of [429, 200, 0, 99, 600, 200.5, Number.NaN]) {
    const reply = new Response('private-response-body', { status: 200 });
    Object.defineProperty(reply, 'status', { value: status });
    let calls = 0;
    const value = fixture(
      async (_model, _request, options) => {
        assert.ok(options?.fetch);
        const observed = await options.fetch(request, init);
        assert.equal(observed, reply);
        assert.equal(observed.bodyUsed, false);
        throw new Error('private-provider-error');
      },
      'openai',
      undefined,
      async (input, options) => {
        calls++;
        assert.equal(input, request);
        assert.equal(options, init);
        return reply;
      },
    );
    await assert.rejects(value.router(context()), {
      message: 'Conversation routing is unavailable.',
    });
    assert.equal(calls, 1);
    assert.equal(value.usage.length, 1);
    assert.deepEqual(value.usage[0].routingFailure, {
      code: 'response_processing',
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    });
    assert.doesNotMatch(JSON.stringify(value.usage), /private-|authorization|provider.invalid/);
  }
});

test('Pi routing preserves actual SDK success and classifies HTTP, transport and incomplete SSE failures without retries', async () => {
  for (const kind of ['http', 'transport', 'sse', 'success'] as const) {
    let calls = 0;
    const usage: ProviderUsageEvent[] = [];
    const router = createPiConversationRouter({
      provider: 'openai',
      apiKey: 'private-fixture-key',
      onUsage: (value) => usage.push(value),
      createRuntime: async (options) => {
        const runtime = await ModelRuntime.create(options);
        return {
          getModel: (...args) => runtime.getModel(...args),
          setRuntimeApiKey: (...args) => runtime.setRuntimeApiKey(...args),
          completeSimple: (...args) => {
            assert.equal(typeof args[2]?.fetch, 'function');
            return runtime.completeSimple(...args);
          },
        };
      },
      fetch: async (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'gpt-6-luna');
        assert.equal(body.max_output_tokens, 600);
        assert.equal(body.tool_choice, 'none');
        assert.deepEqual(body.reasoning, { effort: 'none' });
        if (kind === 'transport') throw new TypeError('private-transport-error');
        if (kind === 'http')
          return new Response(JSON.stringify({ error: { message: 'private-provider-error' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          });
        if (kind === 'success') {
          const item = {
            id: 'private-message-id',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"kind":"conversation"}' }],
          };
          const events = [
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: 'private-response-id',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
            },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        }
        return new Response(
          'data: {"type":"response.created","response":{"id":"private-id"}}\n\n',
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });
    if (kind === 'success') assert.deepEqual(await router(context()), { kind: 'conversation' });
    else
      await assert.rejects(router(context()), { message: 'Conversation routing is unavailable.' });
    assert.equal(calls, 1);
    assert.equal(usage.length, 1);
    if (kind === 'success') {
      assert.equal(usage[0].routingFailure, undefined);
      assert.equal(usage[0].inputTokens, 100);
      assert.equal(usage[0].outputTokens, 10);
    } else
      assert.deepEqual(usage[0].routingFailure, {
        code: kind === 'transport' ? 'transport' : 'response_processing',
        ...(kind === 'transport' ? {} : { httpStatus: kind === 'http' ? 429 : 200 }),
      });
    assert.doesNotMatch(JSON.stringify(usage), /private-|retry-after|response.created/);
  }
});

test('Pi routing records a response-processing phase when an HTTP 200 SSE body fails after headers', async () => {
  let calls = 0;
  let reads = 0;
  const usage: ProviderUsageEvent[] = [];
  const reply = new Response(
    new ReadableStream(
      {
        pull(controller) {
          reads++;
          if (reads === 1)
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.created","response":{"id":"private-response-id"}}\n\n',
              ),
            );
          else
            controller.error(
              new TypeError('private-body-transport-error', {
                cause: new Error('private-body-transport-cause'),
              }),
            );
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const router = createPiConversationRouter({
    provider: 'openai',
    apiKey: 'private-fixture-key',
    onUsage: (value) => usage.push(value),
    createRuntime: async (options) => {
      const runtime = await ModelRuntime.create(options);
      return {
        getModel: (...args) => runtime.getModel(...args),
        setRuntimeApiKey: (...args) => runtime.setRuntimeApiKey(...args),
        completeSimple: (model, request, options) => {
          assert.ok(options?.fetch);
          const forward = options.fetch;
          return runtime.completeSimple(model, request, {
            ...options,
            fetch: async (...args) => {
              const observed = await forward(...args);
              assert.equal(observed, reply);
              assert.equal(observed.bodyUsed, false);
              assert.equal(reads, 0);
              return observed;
            },
          });
        },
      };
    },
    fetch: async () => {
      calls++;
      return reply;
    },
  });
  await assert.rejects(router(context()), {
    message: 'Conversation routing is unavailable.',
  });
  assert.equal(calls, 1);
  assert.equal(reads, 2);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, 'failed');
  assert.deepEqual(usage[0].routingFailure, {
    code: 'response_processing',
    httpStatus: 200,
  });
  assert.doesNotMatch(JSON.stringify(usage), /private-|response.created/);
});

test('Pi routing keeps late HTTP success and failure cancelled with one usage event', async () => {
  for (const failed of [false, true]) {
    let finish!: (response: Response) => void;
    const controller = new AbortController();
    const value = fixture(
      async (_model, _request, options) => {
        await options!.fetch!('https://provider.invalid/responses');
        if (failed) throw new Error('private-late-provider-error');
        return response('{"kind":"conversation"}');
      },
      'openai',
      undefined,
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = value.router({ ...context(), signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(finish);
    controller.abort(new Error('private-abort-reason'));
    await assert.rejects(pending, {
      name: 'AbortError',
      message: 'Conversation routing cancelled.',
    });
    assert.equal(value.usage.length, 0);
    finish(new Response('private-body', { status: failed ? 503 : 200 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(value.usage.length, 1);
    assert.equal(value.usage[0].status, 'cancelled');
    assert.equal(value.usage[0].costUsd, failed ? null : 0.031);
    assert.deepEqual(value.usage[0].routingFailure, {
      code: 'cancelled',
      httpStatus: failed ? 503 : 200,
    });
    assert.doesNotMatch(JSON.stringify(value.usage), /private-|provider.invalid/);
  }
});

test('Pi routing cancellation during initialization never starts a late completion or emits twice', async () => {
  let finish!: () => void;
  let completionCalls = 0;
  const usage: ProviderUsageEvent[] = [];
  const router = createPiConversationRouter({
    provider: 'openai',
    apiKey: 'private-fixture-key',
    onUsage: (value) => usage.push(value),
    createRuntime: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        getModel: () => catalog.getModel('openai', 'gpt-6-luna'),
        setRuntimeApiKey: async () => {},
        completeSimple: async () => {
          completionCalls++;
          return response('{"kind":"conversation"}');
        },
      };
    },
  });
  const controller = new AbortController();
  const pending = router({ ...context(), signal: controller.signal });
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(pending, { name: 'AbortError', message: 'Conversation routing cancelled.' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].routingFailure, { code: 'cancelled' });
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(usage.length, 1);
  assert.equal(completionCalls, 0);
  assert.doesNotMatch(JSON.stringify(usage), /private-/);
});
