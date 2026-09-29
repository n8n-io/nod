import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { ChannelSetupFailure } from '../src/ports/channel-settings.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createChannels } from '../src/server/channels.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';

const token = '987:fixture-never-live';
test('channel verifier checks the selected accounts and requires an explicit change from an existing Telegram webhook', async () => {
  const calls: string[] = [];
  let existingWebhook = '';
  const verifier = createChatSdkSetupVerifier({
    fetch: async (url, init) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/getMe'))
        return Response.json({
          ok: true,
          result: { id: 987, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' },
        });
      if (path.endsWith('/getWebhookInfo'))
        return Response.json({ ok: true, result: { url: existingWebhook } });
      if (path.endsWith('/setWebhook')) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.url, 'https://webhook.example.com/api/webhooks/telegram');
        assert.deepEqual(body.allowed_updates, ['message']);
        assert.equal(body.drop_pending_updates, false);
        assert.ok(body.secret_token.length >= 32);
        return Response.json({ ok: true, result: true });
      }
      if (path.startsWith('https://graph.facebook.com/v25.0/555')) {
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer whatsapp-fixture-token',
        );
        assert.equal(new URL(path).searchParams.has('appsecret_proof'), true);
        return Response.json({
          id: '555',
          display_phone_number: '+351 910 000 000',
          verified_name: 'Fixture business',
        });
      }
      assert.fail('Unexpected provider call');
    },
  });
  const polling = await verifier.verify('telegram', { botToken: token });
  assert.equal(polling.environment.TELEGRAM_MODE, 'polling');
  assert.equal(polling.summary.accountHandle, '@fixture_bot');
  assert.equal(JSON.stringify(polling.summary).includes(token), false);
  existingWebhook = 'https://old.example.com/handler';
  await assert.rejects(
    verifier.verify('telegram', { botToken: token }),
    (error) => error instanceof ChannelSetupFailure && error.reason === 'existing_webhook',
  );
  const webhook = await verifier.verify('telegram', {
    botToken: token,
    webhookUrl: 'https://webhook.example.com/api/webhooks/telegram',
  });
  assert.equal(webhook.summary.webhookStatus, 'registration_pending');
  assert.equal(
    calls.some((url) => url.endsWith('/setWebhook')),
    false,
  );
  await verifier.register!('telegram', webhook);
  assert.equal(calls.filter((url) => url.endsWith('/setWebhook')).length, 1);
  await assert.rejects(
    verifier.verify('telegram', {
      botToken: token,
      webhookUrl: 'https://127.0.0.1/api/webhooks/telegram',
    }),
  );
  const whatsapp = {
    accessToken: 'whatsapp-fixture-token',
    appSecret: 'a'.repeat(32),
    phoneNumberId: '555',
    allowedNumber: '351910000000',
    verifyToken: 'fixture-verification-token',
    policyConfirmed: true,
  };
  assert.equal(
    (await verifier.verify('whatsapp', whatsapp)).summary.accountName,
    'Fixture business',
  );
  await assert.rejects(verifier.verify('whatsapp', { ...whatsapp, policyConfirmed: false }));
  assert.equal(
    calls.some((url) => url.includes('sendMessage') || url.includes('/messages')),
    false,
  );
});

test(
  'webhook activation persists its secret before remote changes and recovers the same configuration after local or uncertain failures',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_recovery_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const key = randomBytes(32);
    const registrations: string[] = [];
    let applied: Record<string, string> = {};
    let failApply = false;
    let loseRegistrationResponse = false;
    let settings: Awaited<ReturnType<typeof createChannelSettings>>;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: createChatSdkSetupVerifier({
        fetch: async (url, init) => {
          const path = String(url);
          if (path.endsWith('/getMe'))
            return Response.json({
              ok: true,
              result: { id: 987, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' },
            });
          if (path.endsWith('/getWebhookInfo'))
            return Response.json({ ok: true, result: { url: '' } });
          assert.equal(path, `https://api.telegram.org/bot${token}/setWebhook`);
          const body = JSON.parse(String(init?.body));
          const persisted = await settings.environment();
          assert.equal(persisted.TELEGRAM_WEBHOOK_SECRET_TOKEN, body.secret_token);
          assert.equal(applied.TELEGRAM_WEBHOOK_SECRET_TOKEN, body.secret_token);
          assert.equal(
            (await settings.status()).channels[0]?.webhookStatus,
            'registration_pending',
          );
          registrations.push(body.secret_token);
          if (loseRegistrationResponse) throw new Error('fixture response lost after registration');
          return Response.json({ ok: true, result: true });
        },
      }),
      apply: async (environment: Record<string, string>) => {
        if (failApply) throw new Error('fixture local replacement failed');
        applied = environment;
      },
    };
    const save = (webhook = true) =>
      app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: {
          botToken: token,
          ...(webhook ? { webhookUrl: 'https://webhook.example.com/api/webhooks/telegram' } : {}),
        },
      });
    try {
      settings = await createChannelSettings(pool, { ...options, ownerId: 'local-development' });
      settings.registerRoutes(app);
      assert.equal((await save(false)).statusCode, 200);
      const original = await settings.environment();
      await pool.query(
        `CREATE FUNCTION reject_channel_write() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture persistence failure'; END$$`,
      );
      await pool.query(
        'CREATE TRIGGER reject_channel_write BEFORE INSERT OR UPDATE ON channel_settings FOR EACH ROW EXECUTE FUNCTION reject_channel_write()',
      );
      assert.equal((await save()).statusCode, 503);
      assert.equal(registrations.length, 0);
      assert.deepEqual(await settings.environment(), original);
      await pool.query('DROP TRIGGER reject_channel_write ON channel_settings');

      failApply = true;
      const applyFailure = await save();
      assert.equal(applyFailure.statusCode, 503);
      assert.match(applyFailure.json().error, /setup was saved/);
      assert.equal(registrations.length, 0);
      assert.deepEqual(applied, original);
      const pending = await settings.environment();
      assert.notEqual(
        pending.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        original.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      );
      failApply = false;
      settings = await createChannelSettings(pool, { ...options, ownerId: 'local-development' });
      assert.equal(await settings.recover(), true);
      assert.deepEqual(registrations, [pending.TELEGRAM_WEBHOOK_SECRET_TOKEN]);
      assert.equal((await settings.status()).channels[0]?.webhookStatus, 'registered');

      await pool.query(
        `CREATE TRIGGER reject_channel_write BEFORE UPDATE ON channel_settings FOR EACH ROW WHEN (NEW.summary->>'webhookStatus'='registered') EXECUTE FUNCTION reject_channel_write()`,
      );
      assert.equal((await save()).statusCode, 503);
      assert.equal(registrations.length, 2);
      assert.equal((await settings.status()).channels[0]?.webhookStatus, 'registration_pending');
      assert.equal((await settings.environment()).TELEGRAM_WEBHOOK_SECRET_TOKEN, registrations[1]);
      await pool.query('DROP TRIGGER reject_channel_write ON channel_settings');
      settings = await createChannelSettings(pool, { ...options, ownerId: 'local-development' });
      assert.equal(await settings.recover(), true);
      assert.equal(registrations.length, 3);
      assert.equal(registrations[2], registrations[1]);

      loseRegistrationResponse = true;
      const uncertain = await save();
      assert.equal(uncertain.statusCode, 503);
      assert.equal(uncertain.body.includes('fixture response lost'), false);
      settings = await createChannelSettings(pool, { ...options, ownerId: 'local-development' });
      assert.equal(await settings.recover(), false);
      assert.equal(registrations[4], registrations[3]);
      assert.equal((await settings.status()).channels[0]?.webhookStatus, 'registration_pending');
      loseRegistrationResponse = false;
      assert.equal(await settings.recover(), true);
      assert.equal(registrations[5], registrations[3]);
      const metadata = JSON.stringify(await settings.status());
      const raw = JSON.stringify((await pool.query('SELECT * FROM channel_settings')).rows);
      for (const secret of [token, ...registrations]) {
        assert.equal(metadata.includes(secret), false);
        assert.equal(raw.includes(secret), false);
      }

      loseRegistrationResponse = true;
      assert.equal((await save()).statusCode, 503);
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' })).statusCode,
        200,
      );
      assert.deepEqual(await settings.environment(), { TELEGRAM_ENABLED: 'false' });
      const attempts = registrations.length;
      settings = await createChannelSettings(pool, { ...options, ownerId: 'local-development' });
      assert.equal(await settings.recover(), true);
      assert.equal(registrations.length, attempts);
      assert.equal(
        (await pool.query('SELECT ciphertext FROM channel_settings')).rows[0].ciphertext,
        null,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'channel setup encrypts secrets, returns only metadata, preserves previous configuration on verification failure and disables without retaining ciphertext',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_settings_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const key = randomBytes(32);
    let fails = false;
    let applied: Record<string, string> = {};
    let applyCount = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: {
        verify: async () => {
          if (fails) throw new Error('secret-provider-error');
          return {
            environment: {
              TELEGRAM_ENABLED: 'true',
              TELEGRAM_BOT_TOKEN: token,
              TELEGRAM_ALLOWED_USER_ID: '123',
              TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret',
              TELEGRAM_MODE: 'polling',
            },
            summary: { provider: 'telegram' as const, enabled: true, accountName: 'Fixture bot' },
          };
        },
      },
      apply: async (environment: Record<string, string>) => {
        applied = environment;
        applyCount++;
      },
    };
    try {
      const settings = await createChannelSettings(pool, {
        ...options,
        ownerId: 'local-development',
      });
      settings.registerRoutes(app);
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: { botToken: token },
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.body.includes(token), false);
      assert.equal(applied.TELEGRAM_BOT_TOKEN, token);
      const raw = (await pool.query('SELECT * FROM channel_settings')).rows[0];
      assert.equal(JSON.stringify(raw).includes(token), false);
      assert.equal(JSON.stringify(raw).includes('fixture-webhook-secret'), false);
      const status = await app.inject('/api/channel-settings');
      assert.equal(status.body.includes(token), false);
      assert.equal(status.body.includes('TELEGRAM_BOT_TOKEN'), false);
      fails = true;
      const failed = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: { botToken: 'bad-key' },
      });
      assert.equal(failed.statusCode, 503);
      assert.equal(failed.body.includes('secret-provider-error'), false);
      assert.equal(applyCount, 1);
      assert.equal((await settings.environment()).TELEGRAM_BOT_TOKEN, token);
      const restored = await createChannelSettings(pool, {
        ...options,
        ownerId: 'local-development',
      });
      assert.equal((await restored.environment()).TELEGRAM_BOT_TOKEN, token);
      await pool.query("UPDATE channel_settings SET provider='whatsapp'");
      await assert.rejects(settings.environment());
      await pool.query("UPDATE channel_settings SET provider='telegram'");
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' })).statusCode,
        200,
      );
      assert.deepEqual(applied, { TELEGRAM_ENABLED: 'false' });
      assert.equal(
        (await pool.query('SELECT ciphertext FROM channel_settings')).rows[0].ciphertext,
        null,
      );
      assert.deepEqual(await settings.environment(), { TELEGRAM_ENABLED: 'false' });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Telegram polling advances its durable offset only after accepted inbox persistence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_poll_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const offsets: number[] = [];
    const transport = createChatSdkTransport(
      pool,
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_ID: '123',
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-secret-long-enough',
        TELEGRAM_MODE: 'polling',
      },
      {
        fetch: async (url, init) => {
          assert.equal(String(url), `https://api.telegram.org/bot${token}/getUpdates`);
          offsets.push(JSON.parse(String(init?.body)).offset);
          return Response.json({
            ok: true,
            result:
              offsets.at(-1) === 42
                ? []
                : [
                    {
                      update_id: 41,
                      message: {
                        message_id: 8,
                        date: Math.floor(Date.now() / 1000),
                        text: 'Fixture polling request',
                        from: { id: 123, is_bot: false, first_name: 'Fixture' },
                        chat: { id: 123, type: 'private' },
                      },
                    },
                  ],
          });
        },
      },
    );
    try {
      await assert.rejects(
        transport.poll!(async () => {
          throw new Error('database fixture failure');
        }),
      );
      assert.equal((await pool.query('SELECT * FROM channel_poll_offsets')).rowCount, 0);
      let accepted = 0;
      await transport.poll!(async (message) => {
        assert.equal(message.senderId, '123');
        assert.equal(message.text, 'Fixture polling request');
        accepted++;
      });
      await transport.poll!(async () => {
        assert.fail('Already persisted update');
      });
      assert.deepEqual(offsets, [0, 0, 42]);
      assert.equal(accepted, 1);
    } finally {
      await transport.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'transport replacement waits for active delivery and applies the new owner binding to later work',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_replace_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb)',
    );
    let release: () => void = () => {};
    let started: () => void = () => {};
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const sending = new Promise<void>((done) => {
      started = done;
    });
    let closed = false;
    const transport: MessagingTransport = {
      channels: [
        {
          id: 'telegram',
          status: 'configured',
          missing: [],
          accountId: 'bot',
          allowedSenderIds: ['123'],
        },
      ],
      receive: async () => ({ status: 200, body: {} }),
      post: async () => {
        started();
        await blocked;
        return { id: 'provider-message' };
      },
      close: async () => {
        closed = true;
      },
    };
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport,
      subscribe: () => () => {},
      submit: async () => randomUUID(),
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    try {
      const task = randomUUID();
      const message = randomUUID();
      await pool.query(
        "INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,task_id,state,owner_id) VALUES('fixture','telegram','bot','123','telegram:123','Fixture',now(),$1,'submitted','local-development')",
        [task],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,task_id,attachments) VALUES($1,'local-development','assistant','Fixture reply',$2,'[]')",
        [message, task],
      );
      const draining = channels.drain();
      await sending;
      const next: MessagingTransport = {
        ...transport,
        channels: [{ id: 'telegram', status: 'disabled', missing: [], allowedSenderIds: [] }],
        post: async () => {
          assert.fail('Disabled transport cannot send');
        },
        close: async () => {},
      };
      let swapped = false;
      const replacing = channels.replaceTransport(next).then(() => {
        swapped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(swapped, false);
      assert.equal(closed, false);
      release();
      await draining;
      await replacing;
      assert.equal(closed, true);
      assert.equal((await app.inject('/api/channels')).json().channels[0].status, 'disabled');
    } finally {
      release();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

for (const mode of ['polling', 'webhook'] as const)
  test(
    `Telegram ${mode} setup binds only the Start sender that the owner confirms`,
    { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
    async (t) => {
      const schema = `test_channel_pairing_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      await pool.query(
        "CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text,role text,text text,task_id uuid,attachments jsonb DEFAULT '[]')",
      );
      const base = `https://api.telegram.org/bot${token}`;
      const updates: { update_id: number }[] = [];
      const sent: Record<string, unknown>[] = [];
      t.mock.method(
        globalThis,
        'fetch',
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          const body =
            typeof init?.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : {};
          if (url === `${base}/getMe`)
            return Response.json({
              ok: true,
              result: { id: 987, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' },
            });
          if (url === `${base}/getWebhookInfo`)
            return Response.json({ ok: true, result: { url: '' } });
          if (url === `${base}/setWebhook`) return Response.json({ ok: true, result: true });
          if (url === `${base}/getUpdates`)
            return Response.json({
              ok: true,
              result: updates.filter((update) => update.update_id >= Number(body.offset)),
            });
          if (url.startsWith(`${base}/send`)) {
            sent.push(body);
            return Response.json({
              ok: true,
              result: {
                message_id: 500 + sent.length,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 123, type: 'private' },
                text: 'Fixture reply',
              },
            });
          }
          throw new Error('Unexpected fixture provider call.');
        },
      );
      const submitted: string[] = [];
      const app = Fastify();
      const key = randomBytes(32);
      let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
      const settings = await createChannelSettings(pool, {
        ownerId: 'local-development',
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        verifier: createChatSdkSetupVerifier(),
        apply: async (environment) =>
          channels!.replaceTransport(createChatSdkTransport(pool, environment)),
        paired: async (candidate, client) => channels!.announcePairing(candidate, client),
      });
      channels = await createChannels(pool, {
        ownerId: 'local-development',
        transport: createChatSdkTransport(pool, await settings.environment()),
        subscribe: () => () => {},
        intervalMs: 600000,
        pair: settings.pair,
        submit: async (text) => {
          submitted.push(text);
          return randomUUID();
        },
      });
      settings.registerRoutes(app);
      channels.registerRoutes(app);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      const waitFor = async (check: () => Promise<boolean> | boolean) => {
        for (let attempt = 0; attempt < 100 && !(await check()); attempt++) await settle();
        assert.equal(await check(), true);
      };
      const telegram = async () => (await settings.status()).channels[0];
      let updateId = 1;
      const deliver = async (from: number, text: string, username?: string) => {
        const update = {
          update_id: updateId,
          message: {
            message_id: updateId++,
            date: Math.floor(Date.now() / 1000),
            text,
            from: { id: from, is_bot: false, first_name: 'Fixture', ...(username && { username }) },
            chat: { id: from, type: 'private' },
          },
        };
        if (mode === 'polling') {
          updates.push(update);
          await channels!.drain();
        } else {
          const response = await app.inject({
            method: 'POST',
            url: '/api/webhooks/telegram',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': (await settings.environment())
                .TELEGRAM_WEBHOOK_SECRET_TOKEN,
            },
            payload: JSON.stringify(update),
          });
          assert.equal(response.statusCode, 200);
        }
        await settle();
      };
      try {
        const saved = await app.inject({
          method: 'PUT',
          url: '/api/channel-settings/telegram',
          payload: {
            botToken: token,
            ...(mode === 'webhook' && {
              webhookUrl: 'https://webhook.example.com/api/webhooks/telegram',
            }),
          },
        });
        assert.equal(saved.statusCode, 200);
        assert.match(saved.json().pairingUrl, /^https:\/\/t\.me\/fixture_bot\?start=[\w-]{32}$/);
        assert.ok(saved.json().channel.pairingExpiresAt);
        const firstCode = new URL(saved.json().pairingUrl).searchParams.get('start')!;
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/channel-settings/telegram',
              payload: { botToken: token, allowedUserId: '123' },
            })
          ).statusCode,
          400,
        );
        const restarted = await app.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/pairing',
          payload: {},
        });
        assert.equal(restarted.statusCode, 200);
        const code = new URL(restarted.json().pairingUrl).searchParams.get('start')!;
        assert.notEqual(code, firstCode);
        const stored = JSON.stringify((await pool.query('SELECT * FROM channel_settings')).rows);
        assert.equal(stored.includes(code), false);
        assert.equal(JSON.stringify(await settings.environment()).includes(code), false);

        await deliver(555, 'Fixture stranger request');
        await deliver(555, `/start ${'x'.repeat(32)}`);
        await deliver(555, `/start ${firstCode}`);
        const now = Date.now;
        Date.now = () => now() + 16 * 60 * 1000;
        try {
          assert.equal(
            await settings.pair({
              channelId: 'telegram',
              accountId: '987',
              senderId: '555',
              senderName: 'Fixture',
              messageId: 'fixture-expired',
              threadId: 'telegram:555',
              code,
              sentAt: new Date(),
            }),
            false,
          );
        } finally {
          Date.now = now;
        }
        assert.equal((await telegram())?.pairingCandidate, undefined);
        const confirm = () =>
          app.inject({
            method: 'POST',
            url: '/api/channel-settings/telegram/confirm',
            payload: {},
          });
        assert.equal((await confirm()).statusCode, 400);

        await deliver(555, `/start ${code}`, 'fixture_stranger');
        await waitFor(async () => (await telegram())?.pairingCandidate?.id === '555');
        assert.equal((await telegram())?.pairingCandidate?.name, '@fixture_stranger');
        assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '');
        await deliver(555, 'Fixture stranger request after Start');
        const rejected = await app.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/pairing',
          payload: {},
        });
        assert.equal(rejected.statusCode, 200);
        assert.equal(rejected.json().channel.pairingCandidate, undefined);
        const secondCode = new URL(rejected.json().pairingUrl).searchParams.get('start')!;
        assert.equal((await confirm()).statusCode, 400);
        await deliver(123, `/start ${code}`, 'fixture_owner');
        assert.equal((await telegram())?.pairingCandidate, undefined);

        await deliver(123, `/start ${secondCode}`, 'fixture_owner');
        await waitFor(async () => (await telegram())?.pairingCandidate?.id === '123');
        await deliver(123, 'Fixture request before confirmation');
        assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
        assert.equal(sent.length, 0);
        assert.equal(submitted.length, 0);

        await pool.query(`CREATE FUNCTION fail_pairing_notice() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Synthetic pairing notice failure'; END $$`);
        await pool.query(`CREATE TRIGGER fail_pairing_notice BEFORE INSERT ON channel_outbox
          FOR EACH ROW EXECUTE FUNCTION fail_pairing_notice()`);
        assert.equal((await confirm()).statusCode, 503);
        assert.equal((await telegram())?.pairingCandidate?.id, '123');
        assert.equal((await telegram())?.allowedUserId, undefined);
        assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '');
        assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
        assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 0);
        assert.equal(sent.length, 0);
        await pool.query('DROP TRIGGER fail_pairing_notice ON channel_outbox');

        const confirmed = await confirm();
        assert.equal(confirmed.statusCode, 200);
        assert.equal(confirmed.json().channel.allowedUserId, '123');
        assert.equal(confirmed.json().channel.pairedUser, '@fixture_owner');
        assert.equal(confirmed.json().channel.pairingExpiresAt, undefined);
        assert.equal(confirmed.json().channel.pairingCandidate, undefined);
        const bound = await settings.environment();
        assert.equal(bound.TELEGRAM_ALLOWED_USER_ID, '123');
        assert.equal(
          Object.keys(bound).some((key) => key.startsWith('TELEGRAM_PAIRING_')),
          false,
        );
        await waitFor(() => sent.length === 1);
        assert.equal(String(sent[0].chat_id), '123');
        assert.match(JSON.stringify(sent[0]), /Otto is connected/);
        assert.equal((await confirm()).statusCode, 400);

        await deliver(999, `/start ${secondCode}`);
        await deliver(999, 'Fixture intruder request');
        await deliver(123, `/start ${secondCode}`);
        assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '123');
        await deliver(123, 'Fixture owner request');
        await waitFor(() => submitted.length === 1);
        assert.deepEqual(submitted, ['Fixture owner request']);
        const inbox = JSON.stringify((await pool.query('SELECT * FROM channel_inbox')).rows);
        assert.equal(inbox.includes(secondCode), false);
        assert.equal(inbox.includes('Fixture intruder request'), false);
        assert.equal(inbox.includes('before confirmation'), false);
        assert.equal(sent.length, 1);
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/channel-settings/telegram/pairing',
              payload: {},
            })
          ).statusCode,
          400,
        );
      } finally {
        await app.close();
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  );

test(
  'Telegram setup accepts a manually entered positive user ID as the only sender',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_manual_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const key = randomBytes(32);
    let applied: Record<string, string> = {};
    const settings = await createChannelSettings(pool, {
      ownerId: 'local-development',
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: {
        verify: async () => ({
          environment: {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: token,
            TELEGRAM_ALLOWED_USER_ID: '',
            TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-long-enough',
            TELEGRAM_MODE: 'polling',
          },
          summary: {
            provider: 'telegram' as const,
            enabled: true,
            mode: 'polling' as const,
            accountHandle: '@fixture_bot',
          },
        }),
      },
      apply: async (environment) => {
        applied = environment;
      },
    });
    settings.registerRoutes(app);
    const enter = (allowedUserId: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/channel-settings/telegram/user',
        payload: { allowedUserId },
      });
    try {
      assert.equal((await enter('4242')).statusCode, 400);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/channel-settings/telegram',
            payload: { botToken: token },
          })
        ).statusCode,
        200,
      );
      for (const invalid of ['0', '-4', '12.5', 'abc', '@fixture', '12345678901234567', 4242])
        assert.equal((await enter(invalid)).statusCode, 400);
      assert.equal(applied.TELEGRAM_ALLOWED_USER_ID, '');
      const saved = await enter(' 4242 ');
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.json().channel.allowedUserId, '4242');
      assert.equal(saved.json().channel.pairedUser, undefined);
      assert.equal(saved.json().channel.pairingExpiresAt, undefined);
      assert.equal(applied.TELEGRAM_ALLOWED_USER_ID, '4242');
      assert.equal(applied.TELEGRAM_PAIRING_EXPIRES_AT, undefined);
      const transport = createChatSdkTransport(pool, applied);
      assert.deepEqual(transport.channels[0].allowedSenderIds, ['4242']);
      await transport.close();
      assert.equal((await enter('5353')).statusCode, 400);
      assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '4242');
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Telegram polling keeps a Start update until its pairing candidate is stored',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_pair_poll_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const offsets: number[] = [];
    const code = 'fixture-start-code-0123456789abcdef';
    const transport = createChatSdkTransport(
      pool,
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_ID: '',
        TELEGRAM_PAIRING_EXPIRES_AT: String(Date.now() + 600000),
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-secret-long-enough',
        TELEGRAM_MODE: 'polling',
      },
      {
        fetch: async (_url, init) => {
          offsets.push(JSON.parse(String(init?.body)).offset);
          return Response.json({
            ok: true,
            result:
              offsets.at(-1) === 8
                ? []
                : [
                    {
                      update_id: 7,
                      message: {
                        message_id: 3,
                        date: Math.floor(Date.now() / 1000),
                        text: `/start ${code}`,
                        from: { id: 123, is_bot: false, first_name: 'Fixture', username: 'owner' },
                        chat: { id: 123, type: 'private' },
                      },
                    },
                  ],
          });
        },
      },
    );
    try {
      const accepted: string[] = [];
      const paired: string[] = [];
      await assert.rejects(
        transport.poll!(
          async () => {
            accepted.push('message');
          },
          async () => {
            throw new Error('Synthetic pairing write failure');
          },
        ),
      );
      await transport.poll!(
        async () => {
          accepted.push('message');
        },
        async (request) => {
          paired.push(`${request.senderId}:${request.senderName}:${request.code}`);
        },
      );
      await transport.poll!(
        async () => {
          accepted.push('message');
        },
        async () => {
          assert.fail('Already stored pairing update');
        },
      );
      assert.deepEqual(offsets, [0, 0, 8]);
      assert.deepEqual(paired, [`123:@owner:${code}`]);
      assert.deepEqual(accepted, []);
    } finally {
      await transport.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
