import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import type { ApplicationAdapters } from '../src/server/composition.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import type { SpeechProvider } from '../src/ports/speech.ts';
import type { MessagingAttachment } from '../src/ports/messaging.ts';
import { createLedger } from '../src/server/ledger.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { createPostHogAnalytics } from '../src/providers/posthog/analytics.ts';
import { posthogConfig } from '../src/shared/analytics.ts';
import { accessCookie } from '../src/server/access.ts';
import { analyticsRoutes, createAnalytics } from '../src/server/analytics.ts';
import { gunzipSync } from 'node:zlib';
import { createSpeech } from '../src/server/speech.ts';
import { createOpenAISpeechProvider } from '../src/providers/openai/speech.ts';
import { createElevenLabsSpeechProvider } from '../src/providers/elevenlabs/speech.ts';
import { registerSpeechSettings } from '../src/server/speech-settings.ts';
import {
  defaultPreferences,
  validatePreferences,
  type createPreferencesStore,
} from '../src/server/preferences.ts';
import { speechVoices } from '../src/shared/speech.ts';
import { runProcess, serviceEnvironment } from '../src/providers/process.ts';

test('speech settings explicitly refresh account voices and keep other voices usable during a provider outage', async (t) => {
  let version = 1;
  let key = 'fixture-private-elevenlabs-key';
  let calls = 0;
  let unavailable = false;
  const provider = createElevenLabsSpeechProvider({
    apiKey: async () => key,
    configured: () => true,
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, '/v2/voices');
      calls++;
      return unavailable
        ? new Response('fixture-private-elevenlabs-key', { status: 503 })
        : Response.json({
            voices: [{ voice_id: `fixture_voice_${version}`, name: `Voice ${version}` }],
            has_more: false,
          });
    },
  });
  const app = Fastify();
  registerSpeechSettings(app, {
    preferences: { get: async () => ({ ...defaultPreferences }) } as ReturnType<
      typeof createPreferencesStore
    >,
    speech: createSpeech({
      ...provider,
      synthesize: (text, signal, report, options) =>
        options?.voice === 'openai:coral'
          ? Promise.resolve({
              bytes: Buffer.from('synthetic preview'),
              mimeType: 'audio/mpeg',
              fileName: 'preview.mp3',
            })
          : provider.synthesize(text, signal, report, options),
      get voices() {
        return [
          ...speechVoices.filter((voice) => voice.id === 'openai:coral'),
          ...(provider.voices ?? []),
        ];
      },
    }),
  });
  t.after(() => app.close());
  const first = await app.inject('/api/speech');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.json().voices[1].id, 'elevenlabs-direct:fixture_voice_1');
  assert.doesNotMatch(first.body, /fixture-private-elevenlabs-key/);
  version = 2;
  await app.inject('/api/speech');
  assert.equal(calls, 1);
  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/speech/voices/refresh',
    payload: {},
  });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(refreshed.json().voices[1].id, 'elevenlabs-direct:fixture_voice_2');
  assert.equal(
    validatePreferences({ speechVoice: 'elevenlabs-direct:fixture_voice_2' }).speechVoice,
    'elevenlabs-direct:fixture_voice_2',
  );
  unavailable = true;
  const failed = await app.inject({
    method: 'POST',
    url: '/api/speech/voices/refresh',
    payload: {},
  });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().synthesis, true);
  assert.equal(failed.json().voices[0].id, 'openai:coral');
  assert.match(failed.json().voicesError, /ElevenLabs/);
  assert.doesNotMatch(failed.body, /fixture-private-elevenlabs-key/);
  assert.equal(calls, 3);
  key = 'fixture-rotated-elevenlabs-key';
  const healthyPreview = await app.inject({
    method: 'POST',
    url: '/api/speech/preview',
    payload: { voice: 'openai:coral' },
  });
  assert.equal(healthyPreview.statusCode, 200);
  assert.equal(healthyPreview.body, 'synthetic preview');
  assert.equal(calls, 3);
});

test('speech previews reject unavailable voices, serialize generation and release cancelled requests', async (t) => {
  let calls = 0;
  let started!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const signals: AbortSignal[] = [];
  const requests: Array<{ text: string; voice: string | undefined }> = [];
  let defaultVoice: string | undefined = 'openai:coral';
  const app = Fastify();
  registerSpeechSettings(app, {
    preferences: { get: async () => ({ locale: 'pt-PT' }) } as ReturnType<
      typeof createPreferencesStore
    >,
    speech: createSpeech({
      id: 'fixture',
      configured: true,
      get defaultVoice() {
        return defaultVoice;
      },
      voices: [
        { id: 'openai:coral', name: 'Coral', description: 'Synthetic voice', engine: 'OpenAI' },
        {
          id: 'local:pf_dora',
          name: 'Dora',
          description: 'Synthetic voice',
          engine: 'Local',
          language: 'pt-BR',
        },
      ],
      synthesize: async (text, signal, _report, options) => {
        calls++;
        signals.push(signal!);
        requests.push({ text, voice: options?.voice });
        if (calls === 1) {
          started();
          await held;
        }
        return {
          bytes: Buffer.from('synthetic-audio'),
          mimeType: 'audio/wav',
          fileName: 'preview.wav',
        };
      },
    }),
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    finish();
    await app.close();
  });
  const send = (voice: string | null, signal?: AbortSignal, extra: Record<string, unknown> = {}) =>
    fetch(origin + '/api/speech/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice, ...extra }),
      signal,
    });
  assert.equal((await send('elevenlabs:sarah')).status, 400);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const first = send('openai:coral', controller.signal).catch(() => undefined);
  await ready;
  assert.equal((await send('openai:coral')).status, 409);
  controller.abort();
  await first;
  for (let attempt = 0; attempt < 100 && !signals[0].aborted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signals[0].aborted, true);
  const next = await send('openai:coral');
  assert.equal(next.status, 200);
  assert.equal(next.headers.get('cache-control'), 'no-store');
  assert.equal(next.headers.get('content-type'), 'audio/wav');
  assert.equal(await next.text(), 'synthetic-audio');
  assert.deepEqual(
    requests.map((request) => request.voice),
    ['openai:coral', 'openai:coral'],
  );
  await t.test('custom preview text is rejected before generation', async () => {
    const before = calls;
    for (const text of ['Olá! Posso ajudar com o teu próximo projeto.', '', '   ', 42, null]) {
      assert.equal((await send('openai:coral', undefined, { text })).ok, false);
      assert.equal(calls, before);
    }
  });
  await t.test('preview samples follow voice language before browser locale', async () => {
    const english = requests[0].text;
    for (const [locale, script] of [
      ['ar-SA', /\p{Script=Arabic}/u],
      ['ko-KR', /\p{Script=Hangul}/u],
      ['ru-RU', /\p{Script=Cyrillic}/u],
      ['ja-JP', /\p{Script=Hiragana}/u],
      ['hi-IN', /\p{Script=Devanagari}/u],
    ] as const) {
      const response = await send('openai:coral', undefined, { locale });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(requests.at(-1)?.voice, 'openai:coral');
      assert.match(requests.at(-1)!.text, script);
    }
    assert.equal((await send('openai:coral', undefined, { locale: 'pt-PT' })).status, 200);
    const portuguese = requests.at(-1)!.text;
    assert.notEqual(portuguese, english);
    assert.equal((await send('local:pf_dora', undefined, { locale: 'ar-SA' })).status, 200);
    assert.deepEqual(requests.at(-1), { text: portuguese, voice: 'local:pf_dora' });
    for (const locale of ['en-GB', 'zz-ZZ']) {
      assert.equal((await send('openai:coral', undefined, { locale })).status, 200);
      assert.equal(requests.at(-1)?.text, english);
    }
  });
  await t.test('default previews pass the resolved default voice explicitly', async () => {
    assert.equal((await send(null)).status, 200);
    assert.equal(requests.at(-1)?.voice, 'openai:coral');
  });
  await t.test('unavailable default voices never reach synthesis', async () => {
    const before = calls;
    for (const missing of [undefined, 'openai:missing']) {
      defaultVoice = missing;
      assert.equal((await send(null)).status, 400);
      assert.equal(calls, before);
    }
  });
  await t.test(
    'local preparation preserves automatic and explicit voice choices independently of browser language',
    async () => {
      const localApp = Fastify();
      let ready = false;
      let saved = { ...defaultPreferences };
      registerSpeechSettings(localApp, {
        speech: createSpeech({
          id: 'local-fixture',
          configured: true,
          voices: speechVoices.filter((voice) => voice.engine === 'Local'),
          synthesize: async () => assert.fail('Preparing voices must not generate audio.'),
        }),
        preferences: {
          validate: validatePreferences,
          get: async () => saved,
          update: async (change) => {
            assert.equal(ready, true);
            saved = { ...saved, ...validatePreferences(change) };
            return saved;
          },
        },
        local: {
          prepare: async () => {
            ready = true;
          },
          prepareTranscription: async () => {
            ready = true;
          },
          status: () => ({ state: ready ? 'ready' : 'not_downloaded' }),
          transcriptionStatus: () => ({ state: ready ? 'ready' : 'not_downloaded' }),
          close: async () => {},
        },
      });
      try {
        for (const locale of ['en-GB', 'EN-gb', 'en-AU', 'pt-PT', 'zz-ZZ']) {
          ready = false;
          saved.speechVoice = null;
          const response = await localApp.inject({
            method: 'POST',
            url: '/api/speech/prepare',
            payload: { locale },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(saved.speechVoice, null, locale);
        }
        saved.speechVoice = 'local:bm_george';
        assert.equal(
          (
            await localApp.inject({
              method: 'POST',
              url: '/api/speech/prepare',
              payload: { locale: 'fr-FR' },
            })
          ).statusCode,
          200,
        );
        assert.equal(saved.speechVoice, 'local:bm_george');
      } finally {
        await localApp.close();
      }
    },
  );
});

test('input preparation reuses cloud transcription and preserves an explicit local speech choice', async (t) => {
  const app = Fastify();
  let voice: string | null = null;
  let inputReady = false;
  let inputPreparations = 0;
  let fullPreparations = 0;
  registerSpeechSettings(app, {
    speech: createSpeech({
      id: 'synthetic-cloud',
      configured: true,
      transcriptionConfigured: true,
      synthesize: async () => assert.fail('Input preparation must not synthesize audio.'),
      transcribe: async () => assert.fail('Preparation must not receive a recording.'),
    }),
    preferences: { get: async () => ({ ...defaultPreferences, speechVoice: voice }) } as ReturnType<
      typeof createPreferencesStore
    >,
    local: {
      prepare: async () => {
        fullPreparations++;
      },
      prepareTranscription: async () => {
        inputPreparations++;
        inputReady = true;
      },
      status: () => ({ state: 'not_downloaded' }),
      transcriptionStatus: () => ({ state: inputReady ? 'ready' : 'not_downloaded' }),
      close: async () => {},
    },
    inputFormat: (selected) => (selected?.startsWith('local:') ? 'wav' : undefined),
  });
  t.after(() => app.close());
  const prepare = () =>
    app.inject({ method: 'POST', url: '/api/speech/prepare', payload: { inputOnly: true } });
  assert.equal((await prepare()).json().transcription, true);
  assert.equal(inputPreparations, 0);
  voice = 'local:af_heart';
  assert.equal((await app.inject('/api/speech')).json().transcription, false);
  const local = await prepare();
  assert.equal(local.statusCode, 200);
  assert.equal(local.json().transcriptionFormat, 'wav');
  assert.equal(local.json().local.state, 'not_downloaded');
  assert.equal(local.json().localInput.state, 'ready');
  assert.equal(inputPreparations, 1);
  assert.equal(fullPreparations, 0);
  assert.equal(voice, 'local:af_heart');
  assert.equal((await app.inject('/api/speech')).json().transcription, true);
});

test('OpenAI previews preserve configured voices and enforce the selected speech model', async (t) => {
  const requests: unknown[] = [];
  let keyRequests = 0;
  const endpoint = Fastify();
  endpoint.post('/v1/audio/speech', async (request, reply) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-speech-key');
    requests.push(request.body);
    return reply.type('audio/ogg').send(Buffer.from('synthetic-preview'));
  });
  const origin = await endpoint.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => endpoint.close());
  for (const [model, configuredVoice, expectedVoice] of [
    ['gpt-4o-mini-tts', 'alloy', 'alloy'],
    ['tts-1', 'alloy', 'alloy'],
    ['tts-1-hd', 'alloy', 'alloy'],
    ['gpt-4o-mini-tts', '', 'coral'],
  ] as const) {
    await t.test(`${model} (${configuredVoice || 'empty default'})`, async () => {
      const provider = createOpenAISpeechProvider({
        apiKey: async () => {
          keyRequests++;
          return 'synthetic-speech-key';
        },
        speechModel: model,
        voice: configuredVoice,
        fetch: async (input, init) => {
          assert.equal(String(input), 'https://api.openai.com/v1/audio/speech');
          return fetch(origin + '/v1/audio/speech', init);
        },
      });
      const app = Fastify();
      registerSpeechSettings(app, {
        speech: createSpeech(provider),
        preferences: {
          get: async () => ({ speechVoice: null, speechReply: 'voice' }),
        } as ReturnType<typeof createPreferencesStore>,
      });
      try {
        const preview = (voice: string | null) =>
          app.inject({
            method: 'POST',
            url: '/api/speech/preview',
            payload: { voice, locale: 'ja-JP' },
          });
        const response = await preview(null);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.body, 'synthetic-preview');
        const text = (requests.at(-1) as { input: string }).input;
        assert.match(text, /\p{Script=Hiragana}/u);
        assert.deepEqual(requests.at(-1), {
          model,
          input: text,
          voice: expectedVoice,
          response_format: 'opus',
        });
        const before = requests.length;
        const keysBefore = keyRequests;
        if (model === 'gpt-4o-mini-tts') {
          assert.equal((await preview('openai:marin')).statusCode, 200);
          assert.deepEqual(requests.at(-1), {
            model,
            input: text,
            voice: 'marin',
            response_format: 'opus',
          });
        } else {
          assert.equal((await preview('openai:marin')).statusCode, 400);
          await assert.rejects(
            provider.synthesize(text, undefined, undefined, { voice: 'openai:marin' }),
            /unavailable/,
          );
          assert.equal(requests.length, before);
          assert.equal(keyRequests, keysBefore);
        }
      } finally {
        await app.close();
      }
    });
  }
});

test('analytics drops revoked owner queues while preserving another owner and rechecks dispatch consent', async (t) => {
  const received: { distinct_id: string; event: string; properties: Record<string, unknown> }[] =
    [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const raw =
      typeof options.body === 'string'
        ? options.body
        : gunzipSync(options.body as Uint8Array).toString();
    received.push(...JSON.parse(raw).batch);
    return Response.json({ status: 1 });
  });
  const installationId = randomUUID();
  const local = `local:${installationId}`;
  const analytics = await createAnalytics({
    provider: createPostHogAnalytics(),
    environment: 'production',
    dataRoot: '.',
    installationId,
  });
  t.after(() => analytics.shutdown());
  for (const owner of ['alex', 'sam', 'never']) {
    if (owner !== 'never') analytics.setUsageData(owner, true);
    analytics.capture(owner, {
      event: owner === 'sam' ? 'chat_stopped' : 'conversation_reset',
    });
  }
  analytics.setUsageData('alex', false);
  await analytics.shutdown();
  assert.deepEqual(
    received.map((event) => [event.distinct_id, event.event]),
    [[local, 'chat_stopped']],
  );
  assert.equal(received[0]?.properties.$process_person_profile, false);

  received.length = 0;
  const ownerBound = createPostHogAnalytics();
  const signal = new AbortController().signal;
  ownerBound.capture({ distinctId: local, event: 'chat_stopped', properties: {} }, signal);
  ownerBound.capture(
    { distinctId: `local:${randomUUID()}`, event: 'chat_stopped', properties: {} },
    signal,
  );
  await ownerBound.shutdown();
  assert.deepEqual(
    received.map((event) => event.distinct_id),
    [local],
  );
});

test('person properties use an awaited PostHog update independent of event capture', async (t) => {
  const requests: { url: string; options: RequestInit }[] = [];
  let status = 200;
  let responseBody = '{"status":"Ok"}';
  let waitForAbort = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url: String(url), options });
    if (waitForAbort)
      return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    return new Response(responseBody, { status });
  });
  const analytics = createPostHogAnalytics();
  t.after(() => analytics.shutdown());
  assert.ok(analytics.setPersonProperties);
  const profile = {
    distinctId: 'local:synthetic-installation',
    properties: { email: 'owner@example.test', onboarding_focus: 'mostly_work' },
  };
  assert.equal(await analytics.setPersonProperties(profile, new AbortController().signal), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, `${posthogConfig.host}/i/v0/e/`);
  assert.equal(requests[0]?.options.method, 'POST');
  assert.equal(new Headers(requests[0]?.options.headers).get('content-type'), 'application/json');
  assert.equal(requests[0]?.options.redirect, 'error');
  assert.deepEqual(JSON.parse(String(requests[0]?.options.body)), {
    api_key: posthogConfig.key,
    event: '$set',
    distinct_id: profile.distinctId,
    properties: { $set: profile.properties, $geoip_disable: true },
  });

  status = 503;
  assert.equal(await analytics.setPersonProperties(profile, new AbortController().signal), false);
  assert.equal(requests.length, 2);

  status = 200;
  responseBody = '{"status":"Ok","quota_limited":["events"]}';
  assert.equal(await analytics.setPersonProperties(profile, new AbortController().signal), false);
  responseBody = '{"status":"Failed"}';
  assert.equal(await analytics.setPersonProperties(profile, new AbortController().signal), false);
  responseBody = '{"status":';
  assert.equal(await analytics.setPersonProperties(profile, new AbortController().signal), false);
  assert.equal(requests.length, 5);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await analytics.setPersonProperties(profile, aborted.signal), false);
  assert.equal(requests.length, 5);

  waitForAbort = true;
  const inFlight = new AbortController();
  const update = analytics.setPersonProperties(profile, inFlight.signal);
  inFlight.abort();
  assert.equal(await update, false);
  assert.equal(requests.length, 6);
});

test(
  'saved voice changes reach the next explicit and automatic audio delivery',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
      timeoutMs: 25_000,
      env: { ...serviceEnvironment(), TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
      input: String.raw`
        import assert from 'node:assert/strict';
        import { randomUUID } from 'node:crypto';
        import { mkdtemp, rm } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { setTimeout as delay } from 'node:timers/promises';
        import pg from 'pg';
        const repo = process.cwd();
        const db = process.env.TEST_DATABASE_URL;
        const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
        const schema = 'test_voice_selection_' + suffix;
        const bossSchema = 'test_voice_selection_boss_' + suffix;
        const admin = new pg.Pool({ connectionString: db });
        await admin.query('CREATE SCHEMA ' + schema);
        const url = new URL(db);
        url.searchParams.set('options', '-c search_path=' + schema);
        process.env.DATABASE_URL = url.href;
        process.env.PGBOSS_SCHEMA = bossSchema;
        const data = await mkdtemp(join(tmpdir(), 'nod-voice-selection-'));
        process.env.NOD_DATA_ROOT = data;
        const { createApplication } = await import(repo + '/src/server/composition.ts');
        const { pool } = await import(repo + '/src/server/db.ts');
        const { port } = await import(repo + '/src/server/config.ts');
        const { accessCookie, accessKey } = await import(repo + '/src/server/access.ts');
        const { fakeComputer, fakeWorkspace } = await import(repo + '/tests/runtime-fixtures.ts');
        const { createIntegrationFixture } = await import(repo + '/scripts/e2e-fixtures.ts');
        const { createElevenLabsSpeechProvider } = await import(repo + '/src/providers/elevenlabs/speech.ts');
        const calls = [];
        let release;
        let entered;
        let gate;
        const provider = createElevenLabsSpeechProvider({
          apiKey: async () => 'synthetic-only-key',
          configured: () => true,
          fetch: async (input, options) => {
            const url = new URL(String(input));
            assert.equal(url.origin, 'https://api.elevenlabs.io');
            if (url.pathname === '/v2/voices') return Response.json({ voices: [{ voice_id: 'fixture_alpha', name: 'Alpha' }, { voice_id: 'fixture_beta', name: 'Beta' }], has_more: false });
            assert.match(url.pathname, /^\/v1\/text-to-speech\/fixture_(alpha|beta)$/);
            calls.push({ voice: url.pathname.split('/').at(-1), text: JSON.parse(options.body).text });
            return new Response(Buffer.from('synthetic-generated-audio'), { headers: { 'Content-Type': 'audio/mpeg' } });
          },
        });
        let application;
        try {
          application = await createApplication({
            agent: { open: async (options) => ({ resumed: false, abort() {}, dispose() {}, prompt: async (text) => {
              const request = JSON.parse(text.split('Request data (JSON):\n')[1].split('\n')[0]).currentInstruction;
              if (request === 'held') { entered(); await gate; }
              const name = request === 'automatic' ? 'send_message' : 'create_audio';
              const tool = options.tools.find(tool => tool.name === name);
              assert.ok(tool);
              await tool.execute({ text: 'Synthetic ' + request, ...(request === 'stale-extra' ? { voice: 'elevenlabs-direct:fixture_alpha' } : {}) });
              options.onEvent({ type: 'final', text: '' });
            } }), dispose() {} },
            computer: fakeComputer(), workspace: fakeWorkspace(),
            integrations: createIntegrationFixture('http://localhost:4320').provider,
            memoryCurator: { id: 'fixture', configured: true, curate: async () => ({}) },
            speech: provider,
            keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 7) },
            model: { provider: 'fixture', name: 'fixture', configured: true },
          }, { channels: false, heartbeat: false });
          const headers = { host: 'localhost:' + port, origin: 'http://localhost:' + port, cookie: accessCookie(port) + '=' + await accessKey(data) };
          const save = async (speechVoice, speechReply = 'auto') => {
            const response = await application.app.inject({ method: 'PATCH', url: '/api/preferences', headers, payload: { speechVoice, speechReply } });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().speechVoice, speechVoice);
          };
          const send = async (text) => {
            const response = await application.app.inject({ method: 'POST', url: '/api/messages', headers, payload: { clientMessageId: randomUUID(), text } });
            assert.equal(response.statusCode, 200, response.body);
            const id = response.json().turnId;
            return id;
          };
          const settle = async (id) => {
            for (let index = 0; index < 400; index++) {
              const row = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
              assert.notEqual(row.status, 'failed', row.error);
              if (row.status === 'succeeded') {
                const messages = (await pool.query("SELECT attachments FROM messages WHERE turn_id=$1 AND role='assistant'", [id])).rows;
                assert.ok(messages.some(row => row.attachments.some(file => file.mimeType === 'audio/mpeg')));
                return;
              }
              await delay(20);
            }
            assert.fail('Synthetic turn did not finish.');
          };
          for (const [text, voice] of [['first', 'fixture_alpha'], ['next', 'fixture_beta'], ['stale-extra', 'fixture_beta']]) {
            await save('elevenlabs-direct:' + voice);
            const id = await send(text);
            await settle(id);
            assert.equal(calls.at(-1).voice, voice);
          }
          await save('elevenlabs-direct:fixture_alpha');
          const held = new Promise(resolve => { entered = resolve; });
          gate = new Promise(resolve => { release = resolve; });
          const pending = await send('held');
          await held;
          await save('elevenlabs-direct:fixture_beta');
          release();
          await settle(pending);
          assert.equal(calls.at(-1).voice, 'fixture_beta');
          await save('elevenlabs-direct:fixture_alpha', 'always');
          await settle(await send('automatic'));
          assert.equal(calls.at(-1).voice, 'fixture_alpha');
        } finally {
          release?.();
          await application?.app.close();
          await pool.end();
          await admin.query('DROP SCHEMA IF EXISTS ' + bossSchema + ' CASCADE; DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
          await admin.end();
          await rm(data, { recursive: true, force: true });
        }
      `,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  },
);

test(
  'application loads encrypted channel setup, replaces transports, and continues replies within their channel',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_app_${suffix}`;
    const bossSchema = `test_channel_app_boss_${suffix}`;
    const objects = await mkdtemp(join(tmpdir(), 'channel-memory-'));
    t.after(() => rm(objects, { recursive: true, force: true }));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.NOD_DATA_ROOT = join(objects, 'runtime');
    const authToken = randomBytes(32).toString('base64url');
    const previousAuthToken = process.env.NOD_AUTH_TOKEN;
    process.env.NOD_AUTH_TOKEN = authToken;
    t.after(() => {
      if (previousAuthToken === undefined) delete process.env.NOD_AUTH_TOKEN;
      else process.env.NOD_AUTH_TOKEN = previousAuthToken;
    });
    const { pool, initializeDatabase } = await import('../src/server/db.ts');
    await initializeDatabase();
    const { createApplication, createDefaultAdapters } =
      await import('../src/server/composition.ts');
    const { dataRoot, port, ownerId } = await import('../src/server/config.ts');
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const defaults = createDefaultAdapters({
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_MODE: 'bot',
      WHATSAPP_POLICY_CONFIRMED: 'true',
      WHATSAPP_ALLOWED_NUMBER: '34600000000',
    });
    const audio = {
      bytes: Buffer.from('Synthetic speech'),
      mimeType: 'audio/ogg',
      name: 'voice.ogg',
    };
    const { createSpeech } = await import('../src/server/speech.ts');
    let speechFails = false;
    const rejectedKeys = new Set<string>();
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const openAIModels = await createPiModelBackend().catalog('openai', 'api_key');
    const requests: Array<{ url: string; key: string | null; model: string | null }> = [];
    const checks: Array<{ model: string; reasoning?: { effort?: string } }> = [];
    const speechRequest = t.mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = new Headers(init?.headers).get('authorization');
        if (url.pathname.endsWith('/responses')) {
          assert.equal(url.origin, 'https://api.openai.com');
          assert.equal(key, 'Bearer fixture-openai');
          assert.ok(init && typeof init.body === 'string');
          checks.push(JSON.parse(init.body as string));
          return Response.json(
            { error: { message: 'Synthetic check unavailable.' } },
            { status: 400 },
          );
        }
        if (url.pathname.endsWith('/models') || url.pathname.endsWith('/key')) {
          if (key && rejectedKeys.has(key)) return new Response(null, { status: 401 });
          if (url.pathname.endsWith('/key')) return Response.json({ data: {} });
          return Response.json({
            data:
              url.hostname === 'api.openai.com'
                ? openAIModels.map((model) => ({ id: model.choice.id }))
                : [
                    {
                      id: 'openai/fixture-model',
                      name: 'Synthetic model',
                      context_length: 32000,
                      supported_parameters: ['tools'],
                      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
                      pricing: { prompt: '0', completion: '0' },
                    },
                  ],
          });
        }
        assert.ok(init?.body instanceof FormData || typeof init?.body === 'string');
        assert.equal(init.redirect, 'error');
        requests.push({
          url: String(input),
          key,
          model:
            init.body instanceof FormData
              ? (init.body.get('model') as string)
              : JSON.parse(init.body).model,
        });
        if (speechFails) throw new Error('Synthetic provider failure.');
        return url.pathname.endsWith('/speech')
          ? new Response(Buffer.from('Synthetic spoken reply'), {
              headers: { 'Content-Type': 'audio/mpeg' },
            })
          : Response.json({ text: 'Synthetic transcription' });
      },
    );
    try {
      for (const [environment, provider, model] of [
        [{ OPENROUTER_API_KEY: 'fixture-router' }, 'openrouter', 'openai/gpt-transcribe'],
        [
          { OPENROUTER_API_KEY: 'fixture-router', STT_MODEL: 'gpt-transcribe' },
          'openrouter',
          'openai/gpt-transcribe',
        ],
        [
          { OPENROUTER_API_KEY: 'fixture-router', STT_MODEL: 'qwen/qwen3-asr-1.7b' },
          'openrouter',
          'qwen/qwen3-asr-1.7b',
        ],
        [{ OPENAI_API_KEY: 'fixture-openai' }, 'openai', 'gpt-transcribe'],
        [
          { OPENAI_API_KEY: 'fixture-openai', OPENROUTER_API_KEY: 'fixture-router' },
          'openai',
          'gpt-transcribe',
        ],
      ] as const) {
        const adapters = createDefaultAdapters({
          ...environment,
          NOD_VAULT_KEY: key.toString('base64'),
        });
        await adapters.models!.initialize();
        const speech = createSpeech(adapters.speech);
        speechFails = false;
        assert.equal(await speech.transcribe(audio), 'Synthetic transcription');
        assert.deepEqual(requests.at(-1), {
          url:
            provider === 'openai'
              ? 'https://api.openai.com/v1/audio/transcriptions'
              : 'https://openrouter.ai/api/v1/audio/transcriptions',
          key: provider === 'openai' ? 'Bearer fixture-openai' : 'Bearer fixture-router',
          model,
        });
        const beforeFailure = requests.length;
        speechFails = true;
        await assert.rejects(speech.transcribe(audio));
        assert.equal(requests.length, beforeFailure + 1);
        if (provider === 'openrouter') await assert.rejects(speech.synthesize('Synthetic reply'));
        await adapters.models!.close();
      }
      const localChoice = createDefaultAdapters({
        OPENAI_API_KEY: 'fixture-openai',
        OPENROUTER_API_KEY: 'fixture-router',
        NOD_VAULT_KEY: key.toString('base64'),
      });
      await localChoice.models!.initialize();
      const { createPreferencesStore } = await import('../src/server/preferences.ts');
      const preferences = createPreferencesStore(pool, ownerId);
      const localProvider = localChoice.localSpeech as typeof localChoice.localSpeech &
        SpeechProvider & { transcribe: NonNullable<SpeechProvider['transcribe']> };
      let localCalls = 0;
      const localTranscribe = t.mock.method(
        localProvider,
        'transcribe',
        async (recording: Parameters<NonNullable<SpeechProvider['transcribe']>>[0]) => {
          localCalls++;
          assert.deepEqual(recording, audio);
          return 'Synthetic local transcription';
        },
      );
      const settings = Fastify();
      registerSpeechSettings(settings, {
        speech: createSpeech(localChoice.speech),
        preferences,
        inputFormat: localChoice.speechInputFormat,
      });
      try {
        await preferences.update({ speechVoice: 'local:bf_emma' });
        const beforeLocal = requests.length;
        assert.equal(
          await createSpeech(localChoice.speech).transcribe(audio),
          'Synthetic local transcription',
        );
        assert.equal(localCalls, 1);
        assert.equal(requests.length, beforeLocal);
        const localSettings = (await settings.inject('/api/speech')).json();
        assert.equal(localSettings.speechVoice, 'local:bf_emma');
        assert.equal(localSettings.transcriptionFormat, 'wav');
        await preferences.update({ speechVoice: null });
        speechFails = false;
        assert.equal(
          await createSpeech(localChoice.speech).transcribe(audio),
          'Synthetic transcription',
        );
        assert.equal(localCalls, 1);
        assert.equal(requests.length, beforeLocal + 1);
        assert.equal(requests.at(-1)?.url, 'https://api.openai.com/v1/audio/transcriptions');
        assert.equal((await settings.inject('/api/speech')).json().transcriptionFormat, undefined);
        const models = localChoice.models!.view();
        const audioConnection = models.connections.find((connection) =>
          connection.models.some((model) => model.audio),
        )!;
        const audioModel = audioConnection.models.find((model) => model.audio)!;
        await localChoice.models!.select({
          connectionId: audioConnection.id,
          modelId: audioModel.id,
          effort: audioModel.efforts[0],
        });
        assert.equal((await settings.inject('/api/speech')).json().transcriptionFormat, 'wav');
        await assert.rejects(
          localChoice.onboardingCurator!.curate({
            task: 'access',
            instructions: 'Check the synthetic owner request.',
            input: { request: 'Read the synthetic record.' },
          }),
          /memory model is unavailable/i,
        );
        assert.equal(checks.length, 3);
        assert.ok(checks.every((request) => request.model === 'gpt-6.1-sol'));
        assert.deepEqual(
          checks.map((request) => request.reasoning?.effort),
          ['low', 'low', 'low'],
        );
        assert.equal(localChoice.models!.view().selection?.modelId, audioModel.id);
        await localChoice.models!.select(models.selection!);
        assert.equal((await settings.inject('/api/speech')).json().transcriptionFormat, undefined);
      } finally {
        localTranscribe.mock.restore();
        await preferences.update({ speechVoice: null });
        await settings.close();
        await localChoice.localSpeech!.close();
        await localChoice.models!.close();
      }
      speechFails = false;
      rejectedKeys.add('Bearer fixture-rejected');
      const reconnect = createDefaultAdapters({
        OPENAI_API_KEY: 'fixture-rejected',
        OPENROUTER_API_KEY: 'fixture-router',
        NOD_VAULT_KEY: key.toString('base64'),
      });
      try {
        await reconnect.models!.initialize();
        assert.equal(
          reconnect.models!.view().connections.find((item) => item.provider === 'openai')?.status,
          'reconnect',
        );
        assert.equal(
          await createSpeech(reconnect.speech).transcribe(audio),
          'Synthetic transcription',
        );
        assert.equal(requests.at(-1)?.key, 'Bearer fixture-router');
        assert.equal(
          reconnect.speech.voices?.some((voice) => voice.engine === 'OpenAI'),
          false,
        );
      } finally {
        await reconnect.localSpeech!.close();
        await reconnect.models!.close();
      }
      for (const provider of ['openai', 'openrouter'] as const) {
        const environment =
          provider === 'openai'
            ? { OPENAI_API_KEY: 'fixture-rejected' }
            : { OPENROUTER_API_KEY: 'fixture-rejected' };
        const unavailable = createDefaultAdapters({
          ...environment,
          NOD_VAULT_KEY: key.toString('base64'),
        });
        try {
          await unavailable.models!.initialize();
          assert.equal(unavailable.speech.configured, false);
          assert.equal(unavailable.speech.transcriptionConfigured, false);
          const before = requests.length;
          await assert.rejects(createSpeech(unavailable.speech).transcribe(audio));
          assert.equal(requests.length, before);
        } finally {
          await unavailable.localSpeech!.close();
          await unavailable.models!.close();
        }
        const connected = createDefaultAdapters({
          ...(provider === 'openai'
            ? { OPENAI_API_KEY: 'fixture-openai' }
            : { OPENROUTER_API_KEY: 'fixture-router' }),
          NOD_VAULT_KEY: key.toString('base64'),
        });
        let connection: string | undefined;
        try {
          await connected.models!.initialize();
          connection = await connected.models!.addKey(provider, `fixture-saved-${provider}`);
          const model = connected.models!.view().connections.find((item) => item.id === connection)!
            .models[0];
          await connected.models!.select({
            connectionId: connection,
            modelId: model.id,
            effort: model.efforts[0],
          });
          const service = createSpeech(connected.speech);
          assert.equal(await service.transcribe(audio), 'Synthetic transcription');
          assert.equal(requests.at(-1)?.key, `Bearer fixture-saved-${provider}`);
          await service.synthesize('Synthetic spoken reply');
          assert.equal(requests.at(-1)?.key, `Bearer fixture-saved-${provider}`);
        } finally {
          if (connection) await connected.models!.remove(connection);
          await connected.localSpeech!.close();
          await connected.models!.close();
        }
      }
      await assert.rejects(createSpeech(defaults.speech).transcribe(audio));
    } finally {
      speechRequest.mock.restore();
    }
    const directRequests: string[] = [];
    const directRequest = t.mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://api.elevenlabs.io');
        assert.equal(new Headers(init?.headers).get('xi-api-key'), 'fixture-persisted-speech-key');
        directRequests.push(url.pathname);
        if (url.pathname === '/v2/voices')
          return Response.json({
            voices: [{ voice_id: 'fixture_persisted_voice', name: 'Saved account voice' }],
            has_more: false,
          });
        if (url.pathname === '/v1/speech-to-text')
          return Response.json({ text: 'Synthetic headless voice message' });
        assert.equal(url.pathname, '/v1/text-to-speech/fixture_persisted_voice');
        return new Response(Buffer.from('synthetic headless reply'), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      },
    );
    const savedSpeech = createDefaultAdapters({ NOD_VAULT_KEY: key.toString('base64') });
    const { createPreferencesStore } = await import('../src/server/preferences.ts');
    const speechPreferences = createPreferencesStore(pool, ownerId);
    let directConnection: string | undefined;
    try {
      await savedSpeech.models!.initialize();
      directConnection = await savedSpeech.models!.addKey(
        'elevenlabs',
        'fixture-persisted-speech-key',
      );
      await speechPreferences.update({ speechVoice: 'elevenlabs-direct:fixture_persisted_voice' });
      await savedSpeech.models!.close();
      for (const explicit of [true, false]) {
        const restarted = createDefaultAdapters({ NOD_VAULT_KEY: key.toString('base64') });
        try {
          const beforeRestart = directRequests.length;
          await restarted.models!.initialize();
          assert.equal(directRequests.length, beforeRestart);
          const speech = createSpeech(restarted.speech);
          assert.equal(speech.configured, true);
          assert.equal(speech.transcriptionConfigured, true);
          assert.deepEqual(speech.voices, []);
          assert.equal(speech.defaultVoice, undefined);
          assert.equal(await speech.transcribe(audio), 'Synthetic headless voice message');
          assert.deepEqual(directRequests.slice(beforeRestart), ['/v1/speech-to-text']);
          const voice = explicit ? (await speechPreferences.get()).speechVoice : null;
          const reply = await speech.synthesize(
            'Synthetic headless reply',
            undefined,
            voice ? { voice } : undefined,
          );
          assert.equal(reply.bytes.toString(), 'synthetic headless reply');
          assert.deepEqual(directRequests.slice(beforeRestart), [
            '/v1/speech-to-text',
            '/v2/voices',
            '/v1/text-to-speech/fixture_persisted_voice',
          ]);
        } finally {
          await restarted.localSpeech!.close();
          await restarted.models!.close();
        }
      }
    } finally {
      await speechPreferences.update({ speechVoice: null });
      if (directConnection) await savedSpeech.models!.remove(directConnection);
      await savedSpeech.localSpeech!.close();
      await savedSpeech.models!.close();
      directRequest.mock.restore();
    }
    for (const mode of [undefined, 'cloud']) {
      const cloud = await defaults.messagingSetup!.create({
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_POLICY_CONFIRMED: 'true',
        WHATSAPP_ALLOWED_NUMBER: '34600000000',
        WHATSAPP_ACCESS_TOKEN: 'synthetic-meta-token',
        WHATSAPP_APP_SECRET: 'a'.repeat(32),
        WHATSAPP_PHONE_NUMBER_ID: '555000',
        WHATSAPP_VERIFY_TOKEN: 'synthetic-verify-token',
        ...(mode ? { WHATSAPP_MODE: mode } : {}),
      });
      assert.equal(cloud.pairing, undefined);
      assert.equal(cloud.channels.find((item) => item.id === 'whatsapp')?.accountId, '555000');
      await cloud.close();
    }
    const verifier = {
      verify: async () => {
        return {
          environment: {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: '42:private-fixture',
            TELEGRAM_ALLOWED_USER_ID: '123',
          },
          summary: {
            provider: 'telegram' as const,
            enabled: true,
            accountName: 'Fixture bot',
            mode: 'polling' as const,
          },
        };
      },
    };
    const seedApp = Fastify();
    const saved = await createChannelSettings(pool, {
      ownerId: 'local-development',
      keyStore,
      verifier,
      apply: async () => {},
    });
    saved.registerRoutes(seedApp);
    assert.equal(
      (
        await seedApp.inject({
          method: 'PUT',
          url: '/api/channel-settings/telegram',
          payload: { botToken: 'fixture' },
        })
      ).statusCode,
      200,
    );
    await seedApp.close();
    const applied: Record<string, string>[] = [];
    const sent: string[] = [];
    let incomingFile: MessagingAttachment | undefined;
    let voiceCalls = 0;
    let modelConfigured = false;
    const { createModelService } = await import('../src/server/models.ts');
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    await createDatabaseModelStore({
      database: pool,
      ownerId: 'route-fixture',
      keyStore,
    }).initialize();
    const models = createModelService({
      database: pool,
      ownerId: 'route-fixture',
      keyStore,
      backend: {} as never,
      origin: `http://localhost:${port}`,
    });
    let publishSecrets: (values: string[]) => void;
    const onSecrets = models.onSecrets;
    t.mock.method(models, 'onSecrets', (observer: (values: string[]) => void) => {
      publishSecrets = observer;
      return onSecrets(observer);
    });
    const voiceUsageId = randomUUID();
    const adapters: ApplicationAdapters = {
      onboardingCurator: {
        id: 'fixture',
        configured: true,
        curate: async () => undefined,
      },
      agent: {
        open: async () => {
          throw new Error('No agent in fixture');
        },
        dispose: () => {},
      },
      computer: fakeComputer(),
      workspace: fakeWorkspace({
        open: () => {
          throw new Error('No workspace in fixture');
        },
      }),
      speech: {
        id: 'fixture',
        configured: true,
        transcribe: async (_audio, _signal, report) => {
          voiceCalls++;
          report?.({
            id: voiceUsageId,
            provider: 'fixture',
            category: 'agent',
            operation: 'transcribe',
            model: 'fixture',
            status: 'succeeded',
            durationMs: 1,
            costUsd: 0.4,
          });
          return 'Synthetic voice task answer';
        },
        synthesize: async () => ({
          bytes: Buffer.alloc(0),
          mimeType: 'audio/mpeg',
          fileName: 'fixture.mp3',
        }),
      },
      keyStore,
      models,
      model: {
        provider: 'fixture',
        name: 'fixture',
        get configured() {
          return modelConfigured;
        },
      },
      integrations: {
        id: 'fixture',
        configured: false,
        webhooksConfigured: false,
        supportsSubscriptions: [],
        createSession: async () => {
          throw new Error('No integration');
        },
        deleteSession: async () => {},
        inspectAccount: async () => ({ active: false, service: 'gmail' }),
        deleteAccount: async () => {},
        parseCallback: () => {
          throw new Error('No integration');
        },
        subscribe: async () => ({ id: 'unused' }),
        unsubscribe: async () => {},
        verifyWebhook: async () => {
          throw new Error('No integration');
        },
        matchesSubscription: () => false,
      },
      messagingSetup: {
        verifier,
        create: (environment) => {
          applied.push(environment);
          const transport: MessagingTransport = {
            channels: [
              {
                id: 'telegram',
                status: environment.TELEGRAM_ENABLED === 'true' ? 'configured' : 'disabled',
                missing: [],
                accountId: '42',
                allowedSenderIds: ['123'],
              },
            ],
            receive: async (request) => {
              const body = JSON.parse(Buffer.from(request.body).toString());
              return {
                status: 200,
                body: { ok: true },
                messages: [
                  {
                    channelId: 'telegram',
                    accountId: '42',
                    senderId: '123',
                    messageId: String(body.id),
                    threadId: 'telegram:123',
                    text: body.text,
                    attachments: incomingFile ? [incomingFile] : undefined,
                    replyToMessageId: body.replyTo,
                    sentAt: new Date(),
                  },
                ],
              };
            },
            post: async (message) => {
              sent.push(message.text);
              return { id: 'fixture-sent-' + sent.length };
            },
            close: async () => {},
          };
          return transport;
        },
      },
    };
    const application = await createApplication(adapters, { workers: false });
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${authToken}`,
    };
    try {
      const { logFailure } = await import('../src/server/failure-log.ts');
      let failureText = 'Synthetic burst failed';
      application.app.get('/api/diagnostics-burst', async () => {
        for (let index = 0; index < 20; index++)
          logFailure('fixture_burst', new Error(failureText));
        return { ok: true };
      });
      application.app.get('/api/diagnostics-fixture/:id', async () => {
        throw new Error(`Synthetic app render failed ${authToken} for example.person@example.com`);
      });
      await application.app.ready();
      const failedRequest = await application.app.inject({
        url: '/api/diagnostics-fixture/synthetic-private-record?email=other.person@example.com',
        headers,
      });
      assert.equal(failedRequest.statusCode, 500);
      assert.equal(failedRequest.body.includes(authToken), false);
      const diagnostics = await application.app.inject({
        method: 'POST',
        url: '/api/feedback/report',
        headers,
        payload: {
          errors: [
            {
              type: 'render',
              ageMs: 100,
              message: 'View failed for example.person@example.com',
              stack: 'Error: synthetic renderer stack',
            },
          ],
        },
      });
      assert.equal(diagnostics.statusCode, 200);
      const diagnosticReport = JSON.parse(diagnostics.json().content);
      assert.equal(diagnosticReport.coverage.contentIncluded, true);
      const failure = diagnosticReport.logs.find(
        (entry: any) => entry.data?.event === 'request_failed',
      );
      assert.ok(failure);
      assert.match(failure.data.error.message, /Synthetic app render failed/);
      assert.equal(failure.data.context.status, 500);
      assert.equal(failure.data.context.operation, 'api diagnostics-fixture :id');
      assert.match(diagnosticReport.clientErrors[0].data.message, /View failed/);
      assert.doesNotMatch(
        diagnostics.json().content,
        /example.person@example.com|other.person@example.com|synthetic-private-record/,
      );
      assert.equal(diagnostics.json().content.includes(authToken), false);
      for (const [name, section] of Object.entries(diagnosticReport.coverage.sections))
        assert.equal((section as { status: string }).status, 'collected', name);
      const logDirectory = join(
        dataRoot,
        'feedback-logs',
        createHash('sha256').update('local-development').digest('hex'),
      );
      const journal = async () =>
        (
          await Promise.all(
            (await readdir(logDirectory))
              .filter((name) => name.endsWith('.jsonl'))
              .map((name) => readFile(join(logDirectory, name), 'utf8')),
          )
        )
          .join('')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      const persisted = await journal();
      assert.ok(persisted.some((entry) => entry.data?.event === 'request_failed'));
      assert.equal(JSON.stringify(persisted).includes(authToken), false);
      const flushJournal = async () => {
        assert.equal(
          (
            await application.app.inject({
              method: 'POST',
              url: '/api/feedback/report',
              headers,
              payload: {},
            })
          ).statusCode,
          200,
        );
      };
      let profileReads = 0;
      let releaseProfile!: () => void;
      const profileGate = new Promise<void>((resolve) => {
        releaseProfile = resolve;
      });
      const query = pool.query.bind(pool);
      const profileQuery = t.mock.method(pool, 'query', async (...args: any[]) => {
        if (String(args[0]).includes('FROM preferences WHERE owner_id=$1')) {
          profileReads++;
          await profileGate;
        }
        return (query as any)(...args);
      });
      try {
        assert.equal(
          (await application.app.inject({ url: '/api/diagnostics-burst', headers })).statusCode,
          200,
        );
        assert.equal(profileReads, 1);
      } finally {
        releaseProfile();
        profileQuery.mock.restore();
      }
      await flushJournal();
      assert.equal(
        (await journal()).filter((entry) => entry.data?.event === 'fixture_burst').length,
        20,
      );
      adapters.integrations.configured = true;
      const connectionId = randomUUID();
      await pool.query(
        `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_name)
         VALUES($1,'local-development','gmail','fixture-account','fixture','Maribel Exampleton')`,
        [connectionId],
      );
      await application.triage.updatePreferences({ locale: 'en-US' });
      publishSecrets!(['synthetic-updated-key']);
      failureText = 'Synthetic updated failure for Maribel Exampleton: synthetic-updated-key';
      assert.equal(
        (await application.app.inject({ url: '/api/diagnostics-burst', headers })).statusCode,
        200,
      );
      await flushJournal();
      const updatedEntries = (await journal()).filter((entry) =>
        entry.data?.error?.message?.includes('Synthetic updated failure'),
      );
      assert.equal(updatedEntries.length, 20);
      assert.doesNotMatch(
        JSON.stringify(updatedEntries),
        /Maribel|Exampleton|synthetic-updated-key/,
      );
      publishSecrets!(['synthetic-newest-key']);
      failureText =
        'Synthetic credential update failure for Maribel Exampleton: synthetic-updated-key synthetic-newest-key';
      assert.equal(
        (await application.app.inject({ url: '/api/diagnostics-burst', headers })).statusCode,
        200,
      );
      await flushJournal();
      const credentialEntries = (await journal()).filter((entry) =>
        entry.data?.error?.message?.includes('Synthetic credential update failure'),
      );
      assert.equal(credentialEntries.length, 20);
      assert.doesNotMatch(
        JSON.stringify(credentialEntries),
        /Maribel|Exampleton|synthetic-updated-key|synthetic-newest-key/,
      );
      await pool.query('DELETE FROM app_connections WHERE id=$1', [connectionId]);
      adapters.integrations.configured = false;
      assert.equal(
        (
          await application.app.inject({
            url: '/api/channel-settings/whatsapp/pairing',
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await application.app.inject({
            url: '/api/channel-settings/whatsapp/pairing',
            headers: { host: headers.host },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await application.app.inject({
            method: 'POST',
            url: '/api/channel-settings/whatsapp/pairing',
            headers: { ...headers, origin: 'https://attacker.example' },
            payload: {},
          })
        ).statusCode,
        403,
      );
      for (const route of analyticsRoutes.keys()) {
        const [method, url] = route.split(' ');
        assert.ok(application.app.hasRoute({ method: method as 'GET', url }), route);
      }
      assert.equal(applied[0].TELEGRAM_BOT_TOKEN, '42:private-fixture');
      const send = async (id: number, text: string, replyTo?: string) =>
        application.app.inject({
          method: 'POST',
          url: '/api/webhooks/telegram',
          headers: { host: headers.host, 'content-type': 'application/json' },
          payload: { id, text, replyTo },
        });
      assert.equal((await send(1, 'Fixture request')).statusCode, 200);
      await application.channels!.drain();
      const first = (await pool.query('SELECT id,thread_id,channel FROM turns')).rows[0];
      assert.match(first.channel, /^telegram:[a-f0-9]{32}$/);
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='question',finished_at=now() WHERE id=$1",
        [first.id],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) SELECT $1,owner_id,'assistant','Which city?',thread_id,id FROM turns WHERE id=$2",
        [randomUUID(), first.id],
      );
      await application.channels!.drain();
      assert.deepEqual(sent, ['Which city?']);
      assert.equal((await send(2, 'I live in Lisbon')).statusCode, 200);
      await application.channels!.drain();
      const turns = (
        await pool.query(
          "SELECT id,thread_id,channel FROM turns WHERE source='user' ORDER BY created_at",
        )
      ).rows;
      assert.equal(turns.length, 2);
      assert.equal(turns[1].thread_id, first.thread_id);
      assert.equal(turns[1].channel, first.channel);
      assert.equal(
        (await pool.query('SELECT turn_id FROM channel_inbox WHERE source_id LIKE $1', ['%:2']))
          .rows[0].turn_id,
        turns[1].id,
      );
      const taskTurn = randomUUID();
      const taskSession = randomUUID();
      await pool.query(
        `INSERT INTO turns(id,owner_id,thread_id,session_id,parent_turn_id,source,prompt,status,waiting_reason,background,channel,channel_source_id)
         VALUES($1,'local-development',$2,$3,$4,'task','Synthetic task','waiting','question',true,$5,'channel:telegram:42:2')`,
        [taskTurn, first.thread_id, taskSession, first.id, first.channel],
      );
      await pool.query(
        `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
         VALUES($1,'local-development','assistant','Synthetic task question',$2,$3)`,
        [randomUUID(), first.thread_id, taskTurn],
      );
      await application.channels!.drain();
      incomingFile = {
        name: 'voice.ogg',
        mimeType: 'audio/ogg',
        size: 1,
        voice: true,
        read: async () => new Uint8Array([1]),
      };
      modelConfigured = true;
      assert.equal((await send(9, '', `fixture-sent-${sent.length}`)).statusCode, 200);
      await application.channels!.drain();
      assert.equal((await send(9, '', `fixture-sent-${sent.length}`)).statusCode, 200);
      const voiceUsage = (
        await pool.query(
          `SELECT m.turn_id,m.session_id,m.created_at<u.created_at AS before_turn FROM model_usage m
         JOIN turns u ON u.id=m.turn_id WHERE m.id=$1 AND m.owner_id='local-development'`,
          [voiceUsageId],
        )
      ).rows[0];
      assert.equal(voiceCalls, 1);
      assert.equal(voiceUsage.session_id, taskSession);
      assert.equal(voiceUsage.before_turn, true);
      assert.deepEqual(
        await createLedger({ pool, ownerId: 'local-development' }).checkIn(
          taskSession,
          voiceUsage.turn_id,
        ),
        { budgetUsd: 5, spentUsd: 0.4 },
      );
      let resetThreadId = first.thread_id;
      for (const [id, voice] of [
        [10, false],
        [11, true],
      ] as const) {
        let releaseUpload!: () => void;
        let startUpload!: () => void;
        const heldUpload = new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        const uploadStarted = new Promise<void>((resolve) => {
          startUpload = resolve;
        });
        let uploadReads = 0;
        const name = voice ? 'reset-voice.ogg' : 'reset-image.png';
        incomingFile = {
          name,
          mimeType: voice ? 'audio/ogg' : 'image/png',
          size: 1,
          voice,
          read: async () => {
            uploadReads++;
            startUpload();
            await heldUpload;
            return new Uint8Array([1]);
          },
        };
        const intake = send(id, 'Media before reset');
        await uploadStarted;
        try {
          const reset = await application.app.inject({
            method: 'POST',
            url: '/api/conversation/reset',
            headers,
            payload: { threadId: resetThreadId },
          });
          assert.equal(reset.statusCode, 200, reset.body);
          resetThreadId = reset.json().threadId;
        } finally {
          releaseUpload();
        }
        assert.equal((await intake).statusCode, 200);
        await application.channels!.drain();
        assert.equal((await send(id, 'Media before reset')).statusCode, 200);
        assert.equal(uploadReads, 1);
        const source = `channel:telegram:42:${id}`;
        assert.equal(
          (await pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [source])).rows[0]
            .state,
          'discarded',
        );
        assert.equal(
          (await pool.query('SELECT id FROM artifacts WHERE name=$1', [name])).rowCount,
          0,
        );
        assert.equal(
          (await pool.query('SELECT id FROM turns WHERE channel_source_id=$1', [source])).rowCount,
          0,
        );
        assert.equal(voiceCalls, 1);
      }
      incomingFile = undefined;
      const disabled = await application.app.inject({
        method: 'DELETE',
        url: '/api/channel-settings/telegram',
        headers,
      });
      assert.equal(disabled.statusCode, 200);
      assert.deepEqual(applied.at(-1), { TELEGRAM_ENABLED: 'false' });
      assert.equal((await send(3, 'New task')).statusCode, 404);
    } finally {
      try {
        await application.app.close();
      } finally {
        try {
          await pool.end();
        } finally {
          try {
            await admin.query(
              `DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`,
            );
          } finally {
            await admin.end();
          }
        }
      }
    }
  },
);
