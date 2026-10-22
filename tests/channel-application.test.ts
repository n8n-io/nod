import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import type { ApplicationAdapters } from '../src/server/composition.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import type { MessagingAttachment } from '../src/ports/messaging.ts';
import { createLedger } from '../src/server/ledger.ts';
import { memoryObjectStore } from './fixtures/object-store.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { createPostHogAnalytics } from '../src/providers/posthog/analytics.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';
import { analyticsRoutes, createAnalytics } from '../src/server/analytics.ts';
import { gunzipSync } from 'node:zlib';
import { createChannelSessionStore } from '../src/server/channel-session.ts';

test('analytics drops revoked owner queues while preserving another owner and rechecks dispatch consent', async (t) => {
  const received: { distinct_id: string; event: string }[] = [];
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
      event: owner === 'sam' ? 'nod_chat_stopped' : 'nod_conversation_reset',
    });
  }
  analytics.setUsageData('alex', false);
  await analytics.shutdown();
  assert.deepEqual(
    received.map((event) => [event.distinct_id, event.event]),
    [[local, 'nod_chat_stopped']],
  );

  received.length = 0;
  const ownerBound = createPostHogAnalytics();
  const signal = new AbortController().signal;
  ownerBound.capture({ distinctId: local, event: 'nod_chat_stopped', properties: {} }, signal);
  ownerBound.capture(
    { distinctId: `local:${randomUUID()}`, event: 'nod_chat_stopped', properties: {} },
    signal,
  );
  await ownerBound.shutdown();
  assert.deepEqual(
    received.map((event) => event.distinct_id),
    [local],
  );
});

test(
  'linked channel keys bind owner and slot, survive restart, and refuse stale writes and deletion',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channel_keys_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const key = randomBytes(32);
    const ownerStore = createChannelSessionStore({ pool, ownerId: 'fixture-owner', keyStore });
    const foreignStore = createChannelSessionStore({ pool, ownerId: 'fixture-other', keyStore });
    try {
      const first = await ownerStore.open();
      const other = await foreignStore.open();
      await first.set({
        creds: 'synthetic-owner-credentials',
        'session:fixture': 'synthetic-session-key',
      });
      await other.set({ creds: 'synthetic-other-credentials' });
      const ciphertext = (
        await pool.query('SELECT owner_id,slot,ciphertext FROM channel_session_keys')
      ).rows;
      assert.equal(JSON.stringify(ciphertext).includes('synthetic-'), false);
      assert.equal(await first.get('creds'), 'synthetic-owner-credentials');
      assert.equal(await other.get('creds'), 'synthetic-other-credentials');
      assert.equal(await other.get('session:fixture'), undefined);
      const resumed = await ownerStore.open();
      assert.equal(await resumed.get('creds'), 'synthetic-owner-credentials');
      await assert.rejects(first.set({ creds: 'stale-write' }), /changed/);
      await assert.rejects(first.clear(), /changed/);
      await first.close();
      assert.equal(await resumed.get('creds'), 'synthetic-owner-credentials');
      await pool.query(
        "UPDATE channel_session_keys SET ciphertext=(SELECT ciphertext FROM channel_session_keys WHERE owner_id='fixture-other' AND slot='creds') WHERE owner_id='fixture-owner' AND slot='creds'",
      );
      await assert.rejects(resumed.get('creds'));
      await resumed.set({ creds: 'synthetic-owner-credentials' });
      await pool.query(
        "UPDATE channel_session_keys SET ciphertext=(SELECT ciphertext FROM channel_session_keys WHERE owner_id='fixture-owner' AND slot='creds') WHERE owner_id='fixture-owner' AND slot='session:fixture'",
      );
      await assert.rejects(resumed.get('session:fixture'));
      await resumed.clear();
      await assert.rejects(resumed.set({ creds: 'late-write' }), /closed/);
      const fresh = await ownerStore.open();
      assert.equal(await fresh.get('creds'), undefined);
      assert.equal(await other.get('creds'), 'synthetic-other-credentials');
      await assert.rejects(fresh.set({ creds: 'x'.repeat(1024 * 1024 + 1) }));
      await assert.rejects(fresh.set({ creds: '€'.repeat(400_000) }));
      const connection = t.mock.method(pool, 'connect', () => {
        throw new Error('The rejected batch reached storage.');
      });
      try {
        await assert.rejects(
          fresh.set(
            Object.fromEntries(
              Array.from({ length: 25 }, (_, index) => [`batch:${index}`, 'x'.repeat(1024 * 1024)]),
            ),
          ),
          /full/,
        );
      } finally {
        connection.mock.restore();
      }
      assert.equal(await fresh.get('creds'), undefined);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM channel_session_keys WHERE owner_id=$1',
            ['fixture-owner'],
          )
        ).rows[0].count,
        0,
      );
      await fresh.close();
      await other.close();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
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
    const { pool } = await import('../src/server/db.ts');
    const { createApplication, createDefaultAdapters } =
      await import('../src/server/composition.ts');
    const { dataRoot, port } = await import('../src/server/config.ts');
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
    const requests: Array<{ url: string; key: string | null; model: string | null }> = [];
    const speechRequest = t.mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.redirect, 'error');
        requests.push({
          url: String(input),
          key: new Headers(init.headers).get('authorization'),
          model: init.body.get('model') as string,
        });
        if (speechFails) throw new Error('Synthetic provider failure.');
        return Response.json({ text: 'Synthetic transcription' });
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
        const adapters = createDefaultAdapters(environment);
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
      await assert.rejects(createSpeech(defaults.speech).transcribe(audio));
    } finally {
      speechRequest.mock.restore();
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
      linkPreviews: {
        metadata: async () => null,
        image: async () => null,
      },
      keyStore,
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
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    try {
      const { createModelService } = await import('../src/server/models.ts');
      createModelService({
        database: pool,
        ownerId: 'route-fixture',
        keyStore,
        backend: {} as never,
        origin: headers.origin,
      }).register(application.app);
      await application.app.ready();
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
          headers: { 'content-type': 'application/json' },
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
