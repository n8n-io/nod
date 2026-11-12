import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiModelBackend, createPiModelRuntime } from '../src/providers/pi/models.ts';
import { createOpenAISpeechProvider } from '../src/providers/openai/speech.ts';
import { openAIBaseUrl, openAIRequestError } from '../src/providers/openai/api.ts';
import { createDecisionModel } from '../src/providers/decisions.ts';
import { modelKeyCredential } from '../src/server/models.ts';
import { createDefaultAdapters, modelEnvironment } from '../src/server/composition.ts';
import { keyConnection, noKeySettings } from '../src/web/hooks/use-models.ts';
import type { OpenAIRegion } from '../src/shared/models.ts';

const geography = 'Attempted to access resource from outside project geography EU';
const question = { name: 'answer', choices: [{ value: false, description: 'Ask.' }] };
const plan = { instructions: 'Apply the synthetic rule.', input: {}, question };

test('OpenAI regions reach the server and reject arbitrary destinations before a request', () => {
  const key = 'fixture-openai-key';
  for (const region of ['global', 'eu', 'us'] as const) {
    const payload = keyConnection('openai', key, { ...noKeySettings, region });
    const credential = modelKeyCredential('openai', key, payload);
    assert.deepEqual(credential, {
      type: 'api_key',
      key,
      ...(region === 'global' ? {} : { region }),
    });
    assert.deepEqual(
      modelEnvironment({ OPENAI_API_KEY: key, OPENAI_API_REGION: region }).credentials.openai,
      credential,
    );
  }
  for (const region of [
    'EU',
    'constructor',
    '__proto__',
    'eu.example.test',
    'https://example.test',
  ]) {
    assert.throws(() => modelKeyCredential('openai', key, { region }), /OpenAI API region/);
    assert.throws(() => openAIBaseUrl(region as OpenAIRegion), /OpenAI API region/);
    assert.throws(
      () => modelEnvironment({ OPENAI_API_KEY: key, OPENAI_API_REGION: region }),
      /OpenAI API region/,
    );
  }
});

test('the OpenAI key form labels its region control and submits the chosen region', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const { CloudKeyFields } = await import('../src/web/components/models.tsx');
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, original] of originals)
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
  });
  let settings = noKeySettings;
  await act(async () =>
    root.render(
      createElement(CloudKeyFields, {
        provider: 'openai',
        value: settings,
        onChange: (value) => (settings = value),
      }),
    ),
  );
  const select = dom.window.document.querySelector('select')!;
  assert.equal(select.value, 'global');
  assert.equal(dom.window.document.querySelector('label')?.htmlFor, select.id);
  assert.equal(dom.window.document.querySelector('label')?.textContent, 'API region');
  select.value = 'eu';
  await act(async () => select.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  assert.deepEqual(keyConnection('openai', 'fixture-form-key', settings), {
    provider: 'openai',
    key: 'fixture-form-key',
    region: 'eu',
  });
});

test('native OpenAI model discovery and requests keep each connection in its region', async () => {
  const backend = createPiModelBackend({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const region = url.hostname === 'api.openai.com' ? 'global' : url.hostname.split('.')[0];
      assert.equal(url.pathname, '/v1/models');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer fixture-${region}`);
      assert.equal(init?.redirect, 'error');
      return Response.json({
        data: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-audio-1.5'].map((id) => ({ id })),
      });
    },
  });
  await Promise.all(
    (['global', 'eu', 'us'] as const).map(async (region) => {
      const credential = modelKeyCredential('openai', `fixture-${region}`, { region });
      const definitions = await backend.catalog('openai', 'api_key', credential);
      assert.equal(definitions.length, 3);
      for (const definition of definitions) {
        assert.equal(definition.spec.baseUrl, openAIBaseUrl(region));
        assert.equal(definition.spec.provider, 'openai');
        const audio = definition.choice.id === 'gpt-audio-1.5';
        assert.equal(definition.spec.api, audio ? 'openai-completions' : 'openai-responses');
        assert.ok((definition.spec.cost as { input: number }).input > 0);
        if (!audio) assert.ok(definition.choice.efforts.includes('low'));
        const { runtime, model } = await createPiModelRuntime({
          provider: 'openai',
          method: 'api_key',
          definition,
          effort: audio ? 'off' : 'low',
          read: async () => credential,
        });
        let calls = 0;
        const result = await runtime.completeSimple(
          model,
          { messages: [{ role: 'user', content: 'Synthetic request.', timestamp: 1 }] },
          {
            maxRetries: 5,
            fetch: async (input, init) => {
              calls++;
              assert.equal(
                String(input),
                `${openAIBaseUrl(region)}/${audio ? 'chat/completions' : 'responses'}`,
              );
              assert.equal(
                new Headers(init?.headers).get('authorization'),
                `Bearer fixture-${region}`,
              );
              return Response.json({ error: { message: geography } }, { status: 401 });
            },
          },
        );
        assert.equal(calls, 1);
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage!, /outside project geography EU/);
      }
    }),
  );
});

test('OpenAI discovery keeps the provider reason and only permits the model-list scope exception', async () => {
  const key = 'fixture-"error-key';
  for (const status of [401, 403, 429, 503]) {
    let calls = 0;
    const backend = createPiModelBackend({
      fetch: async () => {
        calls++;
        return Response.json(
          { error: { message: `${geography} ${key}`, code: 'synthetic_code', param: 'model' } },
          { status },
        );
      },
    });
    await assert.rejects(
      backend.catalog('openai', 'api_key', { type: 'api_key', key, region: 'eu' }),
      (error: Error) => {
        assert.match(error.message, /outside project geography EU/);
        assert.ok(error.message.includes(String(status)));
        assert.match(error.message, /synthetic_code/);
        assert.ok(!error.message.includes(key));
        assert.ok(!error.message.includes(JSON.stringify(key).slice(1, -1)));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  for (const scopes of ['api.model.read', 'api.model.read api.responses.write']) {
    const backend = createPiModelBackend({
      fetch: async () =>
        Response.json({ error: { message: `Missing scopes: ${scopes}` } }, { status: 403 }),
    });
    const models = backend.catalog('openai', 'api_key', { type: 'api_key', key, region: 'eu' });
    if (scopes === 'api.model.read')
      assert.ok((await models).every(({ spec }) => spec.baseUrl === openAIBaseUrl('eu')));
    else await assert.rejects(models, /api.responses.write/);
  }
  let cancelled = false;
  const failure = await openAIRequestError(
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(Buffer.alloc(16_385, 65));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
    key,
  );
  assert.equal(cancelled, true);
  assert.match(failure.message, /401/);
  assert.ok(failure.message.length < 100);
});

test('an EU OpenAI connection completes a native Responses request with priced usage', async () => {
  const definition = (await createPiModelBackend().catalog('openai', 'api_key')).find(
    ({ choice }) => choice.id === 'gpt-6-luna',
  )!;
  const { runtime, model } = await createPiModelRuntime({
    provider: 'openai',
    method: 'api_key',
    effort: 'low',
    definition: { ...definition, spec: { ...definition.spec, baseUrl: openAIBaseUrl('eu') } },
    read: async () => ({ type: 'api_key', key: 'fixture-eu-key', region: 'eu' }),
  });
  const item = {
    type: 'message',
    id: 'msg_fixture',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Synthetic answer.', annotations: [] }],
  };
  const result = await runtime.completeSimple(
    model,
    { messages: [{ role: 'user', content: 'Synthetic request.', timestamp: 1 }] },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://eu.api.openai.com/v1/responses');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-eu-key');
        const events = [
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Synthetic answer.' },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fixture',
              status: 'completed',
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    },
  );
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(result.content[0].type, 'text');
  assert.equal((result.content[0] as { text: string }).text, 'Synthetic answer.');
  assert.equal(result.usage.totalTokens, 8);
  assert.ok(result.usage.cost.total > 0);
});

test('OpenAI speech and decisions use the current key and region together and preserve failures', async () => {
  let connection = { key: 'fixture-eu', region: 'eu' as OpenAIRegion };
  let failed = false;
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith(`${openAIBaseUrl(connection.region)}/`));
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${connection.key}`);
    assert.equal(init?.redirect, 'error');
    requests.push(url);
    if (failed)
      return Response.json(
        { error: { message: `${geography} ${connection.key}` } },
        { status: 401 },
      );
    if (url.endsWith('/decisions'))
      return Response.json({
        answers: [{ type: 'choice', name: 'answer', choice: false }],
        usage: { input_tokens: 1 },
      });
    if (url.endsWith('/transcriptions')) return Response.json({ text: 'Synthetic transcript.' });
    return new Response(Buffer.from('synthetic-audio'));
  };
  const speech = createOpenAISpeechProvider({ connection: async () => connection, fetch: request });
  const decisions = createDecisionModel({
    resolve: async () => ({ provider: 'openai', ...connection }),
    fetch: request,
  });
  const audio = { bytes: Buffer.from('fixture'), mimeType: 'audio/wav', name: 'fixture.wav' };
  for (const region of ['eu', 'us', 'global'] as const) {
    connection = { key: `fixture-${region}`, region };
    assert.equal(await speech.transcribe!(audio), 'Synthetic transcript.');
    assert.equal((await speech.synthesize('Synthetic text.')).bytes.toString(), 'synthetic-audio');
    assert.deepEqual(await decisions.check(plan), { answer: false });
  }
  failed = true;
  for (const run of [
    () => speech.transcribe!(audio),
    () => speech.synthesize('Synthetic text.'),
    () => decisions.check(plan),
  ]) {
    const before = requests.length;
    await assert.rejects(run, (error: Error) => {
      assert.match(error.message, /outside project geography EU/);
      assert.match(error.message, /401/);
      assert.ok(!error.message.includes(connection.key));
      return true;
    });
    assert.equal(requests.length, before + 1);
  }
});

test('OpenAI decision adapters retain the region for the selected connection and trust checks', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), 'https://eu.api.openai.com/v1/decisions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-eu');
    return Response.json({
      answers: [{ type: 'choice', name: 'answer', choice: false }],
      usage: { input_tokens: 1 },
    });
  });
  const adapters = createDefaultAdapters({ NOD_FEEDBACK_ENABLED: 'false' });
  const credential = { type: 'api_key' as const, key: 'fixture-eu', region: 'eu' as const };
  Object.defineProperty(adapters.models!, 'configured', { get: () => true });
  adapters.models!.hasApiKey = (provider) => provider === 'openai';
  adapters.models!.apiCredential = async () => credential;
  adapters.models!.resolve = async () => ({
    provider: 'openai',
    method: 'api_key',
    effort: 'off',
    definition: { choice: {} as never, spec: {} },
    read: async () => credential,
  });
  assert.deepEqual(await adapters.decisions!.check(plan), { answer: false });
  assert.deepEqual(await adapters.trustDecisions!.check(plan), { answer: false });
  assert.equal(calls, 2);
});
