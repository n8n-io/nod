import type { Presentation } from '../src/shared/presentation.ts';
import { choiceAnswerText, type AnswerChoices } from '../src/shared/answer-choices.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { ChannelSetupConfiguration } from '../src/ports/channel-settings.ts';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import {
  channelConnectionObservations,
  createChannelSettings,
  managedChannelEnvironment,
  type ChannelConnectionObservation,
} from '../src/server/channel-settings.ts';
import { createChannels } from '../src/server/channels.ts';
import { transaction } from '../src/server/transaction.ts';
import type { LiveWork } from '../src/server/activity.ts';

const token = '987:fixture-never-live';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!(await check())) {
    if (performance.now() >= deadline) assert.fail('The channel did not reach the expected state.');
    await sleep(10);
  }
}

test('channel observations require pairing or a live link and omit private account details', () => {
  const channels = [
    {
      provider: 'telegram',
      enabled: true,
      mode: 'webhook',
      webhookStatus: 'registered',
      accountHandle: '@private_bot',
      pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      provider: 'whatsapp',
      enabled: true,
      mode: 'webhook',
      webhookStatus: 'manual_setup',
      accountHandle: 'private-number',
    },
  ] as const;
  assert.deepEqual(channelConnectionObservations([...channels]), [
    { channel: 'telegram', state: 'setup_pending' },
    { channel: 'whatsapp', state: 'configured_unverified' },
  ]);
  const paired = channelConnectionObservations([
    { ...channels[0], pairingExpiresAt: undefined, allowedUserId: '123' },
    { ...channels[1], mode: 'linked', connectionState: 'connected' },
  ]);
  assert.deepEqual(paired, [
    { channel: 'telegram', state: 'connected' },
    { channel: 'whatsapp', state: 'connected' },
  ]);
  assert.equal(JSON.stringify(paired).includes('private'), false);
  assert.equal(JSON.stringify(paired).includes('123'), false);
});

test('managed connection observations require usable channel configuration', () => {
  const telegram = {
    provider: 'telegram',
    enabled: true,
    managed: true,
    mode: 'polling',
    allowedUserId: '42',
  } as const;
  for (const environment of [
    { TELEGRAM_ALLOWED_USER_ID: '42' },
    { TELEGRAM_ALLOWED_USER_ID: '42', TELEGRAM_BOT_TOKEN: 'invalid' },
  ])
    assert.deepEqual(
      channelConnectionObservations([telegram], managedChannelEnvironment(environment))[0],
      { channel: 'telegram', state: 'setup_pending' },
    );
  assert.deepEqual(
    channelConnectionObservations(
      [telegram],
      managedChannelEnvironment({
        TELEGRAM_ALLOWED_USER_ID: '42',
        TELEGRAM_BOT_TOKEN: '987:fixture-never-live',
      }),
    )[0],
    { channel: 'telegram', state: 'connected' },
  );
  assert.deepEqual(
    channelConnectionObservations(
      [{ provider: 'whatsapp', enabled: true, managed: true, mode: 'webhook' }],
      managedChannelEnvironment({ WHATSAPP_ENABLED: 'true' }),
    )[1],
    { channel: 'whatsapp', state: 'setup_pending' },
  );
});

test('a newer unchanged channel status suppresses an older observation that finishes later', async () => {
  const pool = {
    async query(statement: string) {
      assert.match(
        statement,
        /^(CREATE TABLE IF NOT EXISTS channel_settings|SELECT \* FROM channel_settings)/,
      );
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  let linkState: 'connected' | 'disconnected' = 'connected';
  let holdNext = false;
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const observations: ChannelConnectionObservation[][] = [];
  let lastSignature: string | undefined;
  const settings = await createChannelSettings(pool, {
    ownerId: 'synthetic-owner',
    keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32) },
    verifier: createChatSdkSetupVerifier({
      fetch: async () => {
        throw new Error('Channel verification was not expected.');
      },
    }),
    managed: managedChannelEnvironment({
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_MODE: 'self-chat',
      WHATSAPP_POLICY_CONFIRMED: 'true',
    }),
    apply: async () => {},
    linkStatus: async () => {
      const state = linkState;
      if (holdNext) {
        holdNext = false;
        reached();
        await held;
      }
      return { state };
    },
    observed: () => (states) => {
      const signature = JSON.stringify(states);
      if (signature === lastSignature) return;
      lastSignature = signature;
      observations.push(states);
    },
  });
  await settings.status();
  assert.deepEqual(observations[0]?.[1], { channel: 'whatsapp', state: 'connected' });
  linkState = 'disconnected';
  holdNext = true;
  const stale = settings.status();
  await waiting;
  linkState = 'connected';
  await settings.status();
  assert.equal(observations.length, 1);
  release();
  assert.equal((await stale).channels[0]?.connectionState, 'disconnected');
  assert.equal(observations.length, 1);
});

test(
  'managed channels shadow saved credentials, refuse changes and restore saved configuration when removed',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channel_managed_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const apps: ReturnType<typeof Fastify>[] = [];
    t.after(async () => {
      await Promise.all(apps.map((app) => app.close()));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const key = randomBytes(32);
    let verified = 0;
    const options = {
      ownerId: 'managed-fixture',
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: createChatSdkSetupVerifier({
        fetch: async (url) => {
          verified++;
          if (String(url).endsWith('/getMe'))
            return Response.json({
              ok: true,
              result: { id: 987, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' },
            });
          assert.equal(String(url), `https://api.telegram.org/bot${token}/getWebhookInfo`);
          return Response.json({ ok: true, result: { url: '' } });
        },
      }),
      apply: async () => {},
    };
    const original = await createChannelSettings(pool, options);
    const originalApp = Fastify();
    apps.push(originalApp);
    original.registerRoutes(originalApp);
    assert.equal(
      (
        await originalApp.inject({
          method: 'PUT',
          url: '/api/channel-settings/telegram',
          payload: { botToken: token },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await originalApp.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/user',
          payload: { allowedUserId: '99' },
        })
      ).statusCode,
      200,
    );
    const saved = await original.environment();
    await pool.query(
      `UPDATE channel_settings SET summary=summary || '{"webhookStatus":"registration_pending"}'::jsonb`,
    );
    const rows = (await pool.query('SELECT * FROM channel_settings')).rows;
    const serverToken = '654:server-fixture-never-live';
    const managed = managedChannelEnvironment({
      TELEGRAM_BOT_TOKEN: serverToken,
      TELEGRAM_ALLOWED_USER_ID: '42',
      WHATSAPP_ENABLED: 'false',
      WHATSAPP_ACCESS_TOKEN: 'synthetic-server-meta-token',
    });
    const managedObservations: ChannelConnectionObservation[][] = [];
    const settings = await createChannelSettings(pool, {
      ...options,
      managed,
      observed: () => (states) => {
        managedObservations.push(states);
      },
      keyStore: {
        id: 'fixture',
        configured: true,
        getKey: async () => {
          throw new Error('Managed settings must not decrypt old credentials.');
        },
      },
    });
    const app = Fastify();
    apps.push(app);
    settings.registerRoutes(app);
    const environment = await settings.environment();
    assert.equal(environment.TELEGRAM_BOT_TOKEN, serverToken);
    assert.equal(environment.TELEGRAM_ALLOWED_USER_ID, '42');
    assert.equal(environment.TELEGRAM_PAIRING_CODE_HASH, undefined);
    assert.equal(environment.WHATSAPP_ENABLED, 'false');
    const before = verified;
    assert.equal(await settings.recover(), true);
    for (const provider of ['telegram', 'whatsapp'])
      for (const method of ['PUT', 'DELETE'] as const)
        assert.equal(
          (
            await app.inject({
              method,
              url: `/api/channel-settings/${provider}`,
              ...(method === 'PUT' ? { payload: {} } : {}),
            })
          ).statusCode,
          409,
        );
    for (const action of ['pairing', 'confirm', 'user'])
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/channel-settings/telegram/${action}`,
            payload: { allowedUserId: '11' },
          })
        ).statusCode,
        409,
      );
    assert.equal(verified, before);
    const status = await settings.status();
    assert.equal(status.channels.find((channel) => channel.provider === 'telegram')?.managed, true);
    assert.equal(
      status.channels.find((channel) => channel.provider === 'whatsapp')?.enabled,
      false,
    );
    assert.deepEqual(managedObservations.at(-1), [
      { channel: 'telegram', state: 'connected' },
      { channel: 'whatsapp', state: 'disabled' },
    ]);
    for (const secret of [serverToken, 'synthetic-server-meta-token'])
      assert.equal(JSON.stringify(status).includes(secret), false);
    assert.deepEqual((await pool.query('SELECT * FROM channel_settings')).rows, rows);
    const observeManaged = async (
      environment: Record<string, string | undefined>,
      provider: 'telegram' | 'whatsapp',
    ) => {
      let last: ChannelConnectionObservation[] = [];
      const candidate = await createChannelSettings(pool, {
        ...options,
        managed: managedChannelEnvironment(environment),
        observed: () => (states) => {
          last = states;
        },
      });
      await candidate.status();
      return last.find((state) => state.channel === provider);
    };
    for (const environment of [
      { TELEGRAM_ALLOWED_USER_ID: '42' },
      { TELEGRAM_ALLOWED_USER_ID: '42', TELEGRAM_BOT_TOKEN: 'invalid' },
      {
        TELEGRAM_ALLOWED_USER_ID: '42',
        TELEGRAM_BOT_TOKEN: serverToken,
        TELEGRAM_MODE: 'webhook',
      },
      {
        TELEGRAM_ALLOWED_USER_ID: '42',
        TELEGRAM_BOT_TOKEN: serverToken,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: 'invalid',
      },
    ])
      assert.deepEqual(await observeManaged(environment, 'telegram'), {
        channel: 'telegram',
        state: 'setup_pending',
      });
    assert.deepEqual(
      await observeManaged(
        {
          TELEGRAM_ALLOWED_USER_ID: '42',
          TELEGRAM_BOT_TOKEN: serverToken,
          TELEGRAM_MODE: 'webhook',
          TELEGRAM_WEBHOOK_SECRET_TOKEN: 'abcdefghijklmnop',
        },
        'telegram',
      ),
      { channel: 'telegram', state: 'configured_unverified' },
    );
    assert.deepEqual(await observeManaged({ WHATSAPP_ENABLED: 'true' }, 'whatsapp'), {
      channel: 'whatsapp',
      state: 'setup_pending',
    });
    assert.deepEqual(
      await observeManaged(
        {
          WHATSAPP_ENABLED: 'true',
          WHATSAPP_POLICY_CONFIRMED: 'true',
          WHATSAPP_ACCESS_TOKEN: 'synthetic-access-token',
          WHATSAPP_APP_SECRET: 'synthetic-app-secret',
          WHATSAPP_PHONE_NUMBER_ID: '123',
          WHATSAPP_ALLOWED_NUMBER: '123456789',
          WHATSAPP_VERIFY_TOKEN: 'synthetic-verify-token',
        },
        'whatsapp',
      ),
      { channel: 'whatsapp', state: 'configured_unverified' },
    );
    const restored = await createChannelSettings(pool, options);
    assert.deepEqual(await restored.environment(), saved);
    assert.equal((await restored.status()).channels[0]?.managed, undefined);
    let pairingId = randomUUID();
    let restarts = 0;
    let linkedState: 'awaiting_scan' | 'connected' | 'disconnected' = 'awaiting_scan';
    const linkedObservations: ChannelConnectionObservation[][] = [];
    const linked = await createChannelSettings(pool, {
      ...options,
      managed: managedChannelEnvironment({
        WHATSAPP_MODE: 'self-chat',
        WHATSAPP_POLICY_CONFIRMED: 'true',
      }),
      linkStatus: async () => ({
        state: linkedState,
        pairingId,
        qr: 'synthetic-pairing-qr',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      observed: () => (states) => {
        linkedObservations.push(states);
      },
      cancelPairing: async (candidate, restart) => candidate === pairingId && restart === true,
      apply: async (environment) => {
        assert.equal(environment.WHATSAPP_MODE, 'self-chat');
        assert.equal(environment.WHATSAPP_POLICY_CONFIRMED, 'true');
        pairingId = randomUUID();
        restarts++;
      },
    });
    const linkedApp = Fastify();
    apps.push(linkedApp);
    linked.registerRoutes(linkedApp);
    const qr = await linkedApp.inject('/api/channel-settings/whatsapp/pairing');
    assert.equal(qr.statusCode, 200);
    assert.equal(qr.json().qr, 'synthetic-pairing-qr');
    assert.equal(JSON.stringify(await linked.status()).includes('synthetic-pairing-qr'), false);
    assert.deepEqual(linkedObservations.at(-1)?.[1], {
      channel: 'whatsapp',
      state: 'setup_pending',
    });
    linkedState = 'connected';
    await linked.status();
    assert.deepEqual(linkedObservations.at(-1)?.[1], {
      channel: 'whatsapp',
      state: 'connected',
    });
    linkedState = 'disconnected';
    await linked.status();
    assert.deepEqual(linkedObservations.at(-1)?.[1], {
      channel: 'whatsapp',
      state: 'setup_pending',
    });
    assert.equal(JSON.stringify(linkedObservations).includes('synthetic-pairing-qr'), false);
    assert.equal(
      (
        await linkedApp.inject({
          method: 'POST',
          url: '/api/channel-settings/whatsapp/pairing',
          payload: { pairingId: randomUUID() },
        })
      ).statusCode,
      400,
    );
    assert.equal(restarts, 0);
    assert.equal(
      (
        await linkedApp.inject({
          method: 'DELETE',
          url: '/api/channel-settings/whatsapp/pairing',
          payload: { pairingId },
        })
      ).statusCode,
      409,
    );
    const refreshed = await linkedApp.inject({
      method: 'POST',
      url: '/api/channel-settings/whatsapp/pairing',
      payload: { pairingId },
    });
    assert.equal(refreshed.statusCode, 200);
    assert.notEqual(refreshed.json().pairingId, qr.json().pairingId);
    assert.equal(restarts, 1);
    assert.deepEqual((await pool.query('SELECT * FROM channel_settings')).rows, rows);
  },
);

async function createFixtureTables(pool: pg.Pool, owner: string) {
  await pool.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),session_id uuid GENERATED ALWAYS AS (thread_id) STORED,message_id uuid,source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,handoff_browser_id text,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',presentation jsonb,answer_choices jsonb,reply_to_message_id uuid,delivered_channel text,hidden_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  return threadId;
}

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
    let removals = 0;
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
          if (path === `https://api.telegram.org/bot${token}/deleteWebhook`) {
            removals += 1;
            return Response.json({ ok: true, result: true });
          }
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
      assert.equal(registrations.length, 0);
      assert.deepEqual(applied, original);
      const pending = await settings.environment();
      assert.notEqual(
        pending.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        original.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      );
      const retry = () =>
        app.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/pairing',
          payload: {},
        });
      assert.equal((await retry()).statusCode, 503);
      assert.deepEqual(await settings.environment(), pending);
      failApply = false;
      const retried = await retry();
      assert.equal(retried.statusCode, 200);
      assert.equal(retried.json().channel.webhookStatus, 'registered');
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
      const interrupted = await settings.environment();
      const failedRetry = await retry();
      assert.equal(failedRetry.statusCode, 503);
      assert.equal(failedRetry.json().pairingUrl, undefined);
      assert.deepEqual(await settings.environment(), interrupted);
      loseRegistrationResponse = false;
      const resumed = await retry();
      assert.equal(resumed.statusCode, 200);
      assert.equal(
        (await settings.environment()).TELEGRAM_WEBHOOK_SECRET_TOKEN,
        interrupted.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      );
      assert.equal((await settings.status()).channels[0]?.webhookStatus, 'registered');
      loseRegistrationResponse = true;
      assert.equal((await save()).statusCode, 503);
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' })).statusCode,
        200,
      );
      assert.deepEqual(await settings.environment(), { TELEGRAM_ENABLED: 'false' });
      const linkedApp = Fastify();
      let link = {
        state: 'awaiting_scan' as import('../src/shared/contracts.ts').ChannelLinkStatus['state'],
        pairingId: randomUUID(),
        qr: 'synthetic-private-qr',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      let unlinks = 0;
      const unlink = async () => {
        if (link.state !== 'logged_out') unlinks++;
        link = { ...link, state: 'logged_out' };
      };
      const linked = await createChannelSettings(pool, {
        ownerId: 'local-development',
        keyStore: options.keyStore,
        verifier: createChatSdkSetupVerifier({
          fetch: async () => {
            throw new Error('No network for QR setup.');
          },
        }),
        apply: async (environment) => {
          applied = environment;
          if (environment.WHATSAPP_ENABLED === 'true' && link.state === 'logged_out')
            link = { ...link, state: 'awaiting_scan', pairingId: randomUUID() };
        },
        linkStatus: async () => link,
        unlink,
        cancelPairing: async (id) => {
          if (id !== link.pairingId || link.state === 'connected') return false;
          await unlink();
          return true;
        },
      });
      linked.registerRoutes(linkedApp);
      try {
        const save = (payload: object) =>
          linkedApp.inject({ method: 'PUT', url: '/api/channel-settings/whatsapp', payload });
        assert.equal((await save({ mode: 'bot', policyConfirmed: true })).statusCode, 400);
        assert.equal(
          (await save({ mode: 'bot', allowedNumber: '34600000000', policyConfirmed: false }))
            .statusCode,
          400,
        );
        assert.equal(
          (await save({ mode: 'bot', allowedNumber: '34600000000', policyConfirmed: true }))
            .statusCode,
          200,
        );
        assert.equal(applied.WHATSAPP_MODE, 'bot');
        const qr = await linkedApp.inject('/api/channel-settings/whatsapp/pairing');
        assert.equal(qr.headers['cache-control'], 'no-store');
        assert.equal(qr.json().qr, link.qr);
        const metadata = await linkedApp.inject('/api/channel-settings');
        assert.doesNotMatch(metadata.body, /synthetic-private-qr|pairingId/);
        assert.doesNotMatch(
          JSON.stringify((await pool.query('SELECT * FROM channel_settings')).rows),
          /synthetic-private-qr|34600000000/,
        );
        const cancel = (pairingId: string) =>
          linkedApp.inject({
            method: 'DELETE',
            url: '/api/channel-settings/whatsapp/pairing',
            payload: { pairingId },
          });
        link.state = 'connected';
        assert.equal((await cancel(link.pairingId)).json().channel.enabled, true);
        assert.equal(unlinks, 0);
        const oldId = link.pairingId;
        assert.equal(
          (
            await linkedApp.inject({
              method: 'POST',
              url: '/api/channel-settings/whatsapp/pairing',
              payload: { pairingId: oldId },
            })
          ).statusCode,
          400,
        );
        assert.equal(unlinks, 0);
        link.state = 'logged_out';
        const restarted = await linkedApp.inject({
          method: 'POST',
          url: '/api/channel-settings/whatsapp/pairing',
          payload: { pairingId: oldId },
        });
        assert.equal(restarted.statusCode, 200);
        assert.equal(restarted.headers['cache-control'], 'no-store');
        assert.equal(restarted.json().pairingId, link.pairingId);
        assert.notEqual(link.pairingId, oldId);
        const replacementId = link.pairingId;
        const staleRestart = await linkedApp.inject({
          method: 'POST',
          url: '/api/channel-settings/whatsapp/pairing',
          payload: { pairingId: oldId },
        });
        assert.equal(staleRestart.statusCode, 400);
        assert.equal(link.pairingId, replacementId);
        assert.equal((await cancel(oldId)).json().channel.enabled, true);
        assert.equal((await cancel(link.pairingId)).json().channel.enabled, false);
        assert.equal(unlinks, 1);
        assert.equal(
          (await pool.query("SELECT ciphertext FROM channel_settings WHERE provider='whatsapp'"))
            .rows[0].ciphertext,
          null,
        );
        const foreign = await createChannelSettings(pool, { ownerId: 'other-owner', ...options });
        assert.deepEqual((await foreign.status()).channels, []);
      } finally {
        await linkedApp.close();
      }
      assert.equal(removals, 1);
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
    let unlinks = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: {
        verify: async (provider: 'telegram' | 'whatsapp'): Promise<ChannelSetupConfiguration> => {
          if (fails) throw new Error('secret-provider-error');
          if (provider === 'whatsapp')
            return {
              environment: {
                WHATSAPP_ENABLED: 'true',
                WHATSAPP_MODE: 'bot',
                WHATSAPP_POLICY_CONFIRMED: 'true',
                WHATSAPP_ALLOWED_NUMBER: '12025550100',
              },
              summary: {
                provider: 'whatsapp' as const,
                enabled: true,
                mode: 'linked' as const,
                linkMode: 'bot' as const,
              },
            };
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
      unlink: async () => {
        unlinks++;
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
      fails = false;
      assert.equal(
        (await app.inject({ method: 'PUT', url: '/api/channel-settings/whatsapp', payload: {} }))
          .statusCode,
        200,
      );
      await pool.query(
        "CREATE FUNCTION reject_unlink_save() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Synthetic settings failure'; END$$",
      );
      await pool.query(
        'CREATE TRIGGER reject_unlink_save BEFORE UPDATE ON channel_settings FOR EACH ROW EXECUTE FUNCTION reject_unlink_save()',
      );
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/whatsapp' })).statusCode,
        503,
      );
      assert.equal(unlinks, 0);
      assert.equal((await settings.environment()).WHATSAPP_ENABLED, 'true');
      await pool.query('DROP TRIGGER reject_unlink_save ON channel_settings');
      assert.equal(
        (await app.inject({ method: 'DELETE', url: '/api/channel-settings/whatsapp' })).statusCode,
        200,
      );
      assert.equal(unlinks, 1);
      assert.equal((await settings.environment()).WHATSAPP_ENABLED, 'false');
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
  'Telegram progress edits a replyable message without generation drafts, and both channels keep typing',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channel_presence_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const calls: unknown[] = [];
    let editFailure: string | undefined;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target.endsWith('/getMe'))
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        const method = /(sendChatAction|sendMessageDraft|editMessageText|\/messages)$/.exec(
          target,
        )?.[1];
        if (method) {
          const body = JSON.parse(String(init?.body));
          calls.push([
            method,
            { ...body, ...(body.chat_id ? { chat_id: String(body.chat_id) } : {}) },
          ]);
          if (method === 'editMessageText' && editFailure)
            return Response.json(
              { ok: false, error_code: 400, description: `Bad Request: ${editFailure}` },
              { status: 400 },
            );
        }
        return Response.json({ ok: true, result: true, success: true });
      },
    );
    const transport = createChatSdkTransport(pool, {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_USER_ID: '123456',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-secret-long-enough',
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_ACCESS_TOKEN: 'fixture-not-live',
      WHATSAPP_APP_SECRET: 'fixture-app-secret',
      WHATSAPP_PHONE_NUMBER_ID: '555000',
      WHATSAPP_VERIFY_TOKEN: 'fixture-verify-token',
      WHATSAPP_ALLOWED_NUMBER: '351910000000',
      WHATSAPP_POLICY_CONFIRMED: 'true',
    });
    try {
      const telegram = { channelId: 'telegram', accountId: '987', threadId: 'telegram:123456' };
      await transport.presence!({ ...telegram, messageId: '8', status: 'Trip: Checking seats.' });
      await transport.presence!({ ...telegram, messageId: '8' });
      await transport.presence!({
        channelId: 'whatsapp',
        accountId: '555000',
        threadId: 'whatsapp:555000:351910000000',
        messageId: 'wamid.fixture',
      });
      assert.equal(
        calls.some((call) => (call as unknown[])[0] === 'sendMessageDraft'),
        false,
      );
      const edits = {
        ...telegram,
        messageId: '123456:42',
        text: 'I will check the train options.',
        signal: new AbortController().signal,
      };
      await transport.progress!({ ...edits, status: 'Prüfe Plätze & Preise.' });
      await transport.progress!({ ...edits, status: null });
      assert.deepEqual(calls.slice(0, 3), [
        ['sendChatAction', { chat_id: '123456', action: 'typing' }],
        ['sendChatAction', { chat_id: '123456', action: 'typing' }],
        [
          '/messages',
          {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: 'wamid.fixture',
            typing_indicator: { type: 'text' },
          },
        ],
      ]);
      assert.equal(calls.length, 5);
      for (const call of calls.slice(3) as Array<[string, Record<string, unknown>]>) {
        const [method, { text, ...body }] = call;
        assert.equal(method, 'editMessageText');
        assert.deepEqual(body, {
          chat_id: '123456',
          message_id: 42,
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
        assert.ok(typeof text === 'string' && text.startsWith('I will check the train options\\.'));
      }
      const liveText = (calls[3] as [string, { text: string }])[1].text;
      const restoredText = (calls[4] as [string, { text: string }])[1].text;
      assert.equal(liveText, `${restoredText}\n\n>Prüfe Plätze & Preise\\.`);
      assert.equal(restoredText, 'I will check the train options\\.');
      for (const failure of ['message is not modified', 'message to edit not found']) {
        editFailure = failure;
        await transport.progress!({ ...edits, status: 'Prüfe Plätze & Preise.' });
        await transport.progress!({ ...edits, status: null });
      }
      editFailure = 'message identifier is not specified';
      await assert.rejects(transport.progress!({ ...edits, status: null }));
    } finally {
      await transport.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Telegram progress bounds escaped quotes while preserving the original message and reply target',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channel_progress_size_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const sent: Array<{ text: string }> = [];
    const edited: Array<{ text: string; message_id: number; parse_mode: string }> = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target.endsWith('/getMe'))
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        if (target.endsWith('/sendRichMessage'))
          return Response.json(
            { ok: false, error_code: 400, description: 'Bad Request: rich message unsupported' },
            { status: 400 },
          );
        const body = JSON.parse(String(init?.body));
        assert.ok(body.text.length <= 4096);
        if (target.endsWith('/editMessageText')) {
          edited.push(body);
          return Response.json({ ok: true, result: true });
        }
        assert.ok(target.endsWith('/sendMessage'));
        sent.push(body);
        return Response.json({
          ok: true,
          result: {
            message_id: 500 + sent.length,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture accepted',
          },
        });
      },
    );
    const transport = createChatSdkTransport(pool, {
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_USER_ID: '123456',
      TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-secret-long-enough',
    });
    const telegram = { channelId: 'telegram', accountId: '987', threadId: 'telegram:123456' };
    try {
      for (const fixture of [
        { name: 'escaped text', text: '!'.repeat(1900), status: 'Prüfe! '.repeat(120).trim() },
        { name: 'whole graphemes', text: '!'.repeat(2033), status: '👩🏽‍💻!'.repeat(100) },
        { name: 'no remaining room', text: '!'.repeat(2048), status: 'Prüfe Preise.' },
      ])
        await t.test(fixture.name, async () => {
          const before = sent.length;
          const message = await transport.post({ ...telegram, text: fixture.text });
          assert.equal(sent.length, before + 1);
          assert.equal(message.ids?.length, 1);
          const original = sent.at(-1)!.text;
          const input = {
            ...telegram,
            messageId: message.id,
            text: fixture.text,
            signal: new AbortController().signal,
          };
          await transport.progress!({ ...input, status: fixture.status });
          await transport.progress!({ ...input, status: null });
          const [live, restored] = edited.slice(-2);
          assert.equal(sent.length, before + 1);
          assert.equal(live.message_id, 500 + sent.length);
          assert.equal(restored.message_id, live.message_id);
          assert.equal(live.parse_mode, 'MarkdownV2');
          assert.equal(restored.text, original);
          if (fixture.name === 'no remaining room') assert.equal(live.text, original);
          else {
            assert.ok(live.text.startsWith(`${original}\n\n>`));
            const quote = live.text.slice(original.length + 3);
            assert.ok(quote.endsWith('…'));
            if (fixture.name === 'whole graphemes') assert.match(quote, /^(?:👩🏽‍💻\\!)*(?:👩🏽‍💻)?…$/);
            else assert.ok(quote.startsWith('Prüfe\\! '));
          }
        });
    } finally {
      await transport.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

async function outboxFixture(t: TestContext, max?: number, provider = 'telegram') {
  const schema = `test_channel_outbox_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    ...(max ? { max, connectionTimeoutMillis: 1000 } : {}),
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const threadId = await createFixtureTables(pool, 'local-development');
  const posts: { threadId: string; text: string; replyToMessageId?: string }[] = [];
  let incoming: InboundMessage[] = [];
  let sequence = 0;
  const transport: MessagingTransport = {
    channels: [
      {
        id: provider,
        status: 'configured',
        missing: [],
        accountId: 'bot',
        allowedSenderIds: ['111', '222'],
      },
    ],
    poll: async (accept) => {
      const batch = incoming;
      incoming = [];
      for (const message of batch) await accept(message);
    },
    receive: async () => ({ status: 200, body: {} }),
    post: async (input) => {
      posts.push({
        threadId: input.threadId,
        text: input.text,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      });
      return {
        id: `provider-${posts.length}`,
        ids: [`provider-${posts.length}`, `provider-${posts.length}-file`],
      };
    },
    close: async () => {},
  };
  const receive = (
    senderId: string,
    messageId: string,
    chat: string,
    text = `Fixture request ${messageId}`,
    replyToMessageId?: string,
  ) => {
    incoming.push({
      channelId: provider,
      accountId: 'bot',
      senderId,
      messageId,
      threadId: chat,
      text,
      replyToMessageId,
      sentAt: new Date(Date.now() - 60_000 + 1000 * sequence++),
    });
  };
  const turnOf = async (messageId: string) =>
    (
      await pool.query('SELECT turn_id,channel FROM channel_inbox WHERE source_id=$1', [
        `channel:${provider}:bot:${messageId}`,
      ])
    ).rows[0] as { turn_id: string; channel: string };
  const reply = async (turnId: string, text: string, id: string, offsetSeconds: number) => {
    await pool.query(
      `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,created_at)
       VALUES($1,'local-development','assistant',$2,$3,$4,now()+make_interval(secs=>$5))`,
      [id, text, threadId, turnId, offsetSeconds],
    );
  };
  const create = (extra: Partial<Parameters<typeof createChannels>[1]> = {}) =>
    createChannels(pool, {
      ownerId: 'local-development',
      transport,
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client, channel) => {
        const turnId = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
          [turnId, threadId, sourceId, channel],
        );
        return turnId;
      },
      ...extra,
    });
  return { pool, threadId, posts, receive, turnOf, reply, create, transport };
}

test(
  'channel answer choices preserve the question and option meaning without changing stored text',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const channels = await create();
    try {
      receive('111', 'choice-question', 'choice-chat');
      await channels.drain();
      const { turn_id: turnId } = await turnOf('choice-question');
      const id = randomUUID();
      const question = 'Which mailbox should I use?';
      const choices: AnswerChoices = {
        multiple: false,
        options: [
          { id: randomUUID(), label: 'Work', description: 'Shared project mailbox' },
          { id: randomUUID(), label: 'Personal', description: 'Personal' },
        ],
      };
      await reply(turnId, question, id, 0);
      await pool.query('UPDATE messages SET answer_choices=$2 WHERE id=$1', [
        id,
        JSON.stringify(choices),
      ]);
      await pool.query("UPDATE turns SET status='waiting',waiting_reason='question' WHERE id=$1", [
        turnId,
      ]);
      await channels.drain();
      await until(() => posts.length === 1);
      assert.equal(
        posts[0]!.text,
        `${question}\n\n1. ${choiceAnswerText([choices.options[0]!])}\n2. Personal`,
      );
      assert.equal(
        (await pool.query('SELECT text FROM messages WHERE id=$1', [id])).rows[0].text,
        question,
      );
      assert.ok(!posts[0]!.text.includes(choices.options[0]!.id));
      const cancelled = randomUUID();
      await reply(turnId, question, cancelled, 1);
      await pool.query('UPDATE messages SET answer_choices=$2 WHERE id=$1', [
        cancelled,
        JSON.stringify(choices),
      ]);
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turnId]);
      await channels.drain();
      assert.equal(posts.length, 1);
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            cancelled,
          ])
        ).rows,
        [{ state: 'blocked', reason: 'question_closed' }],
      );
    } finally {
      await channels.close();
    }
  },
);

test(
  'retired schedule confirmations do not reach connected channels',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const provider of ['telegram', 'whatsapp'])
      await t.test(provider, async (t) => {
        const { pool, posts, receive, turnOf, reply, create } = await outboxFixture(
          t,
          undefined,
          provider,
        );
        const channels = await create();
        try {
          const inboundId = `retired-${provider}`;
          receive('111', inboundId, `chat-${provider}`);
          await channels.drain();
          const { turn_id: turnId } = await turnOf(inboundId);
          await pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='question' WHERE id=$1",
            [turnId],
          );

          const hiddenBeforeEnqueue = randomUUID();
          await reply(turnId, 'Cancel the synthetic schedule?', hiddenBeforeEnqueue, 0);
          await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [
            hiddenBeforeEnqueue,
          ]);
          await channels.drain();
          assert.deepEqual(posts, []);
          assert.equal(
            (
              await pool.query('SELECT 1 FROM channel_outbox WHERE message_id=$1', [
                hiddenBeforeEnqueue,
              ])
            ).rowCount,
            0,
          );

          const hiddenAfterEnqueue = randomUUID();
          await reply(turnId, 'Cancel the synthetic schedule?', hiddenAfterEnqueue, 1);
          await pool.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
            hiddenAfterEnqueue,
            `channel:${provider}:bot:${inboundId}`,
          ]);
          await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [hiddenAfterEnqueue]);
          await channels.drain();
          assert.deepEqual(posts, []);
          assert.equal(
            (
              await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                hiddenAfterEnqueue,
              ])
            ).rows[0]?.state,
            'blocked',
          );
        } finally {
          await channels.close();
        }
      });
  },
);

test(
  'a failed schedule confirmation lookup retries before channel delivery',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const messageId = randomUUID();
    let lookups = 0;
    const channels = await create({
      isRetirableScheduleConfirmation: async (id) => {
        assert.equal(id, messageId);
        if (++lookups === 1) throw new Error('Synthetic confirmation lookup failed.');
        return true;
      },
    });
    try {
      receive('111', 'lookup-retry', 'chat-lookup-retry');
      await channels.drain();
      await reply((await turnOf('lookup-retry')).turn_id, 'Cancel the schedule?', messageId, 0);
      await channels.drain();
      assert.equal(lookups, 1);
      assert.deepEqual(posts, []);
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason,claim_id FROM channel_outbox WHERE message_id=$1', [
            messageId,
          ])
        ).rows,
        [{ state: 'pending', reason: null, claim_id: null }],
      );
      await channels.drain();
      assert.equal(lookups, 2);
      assert.deepEqual(posts, [{ threadId: 'chat-lookup-retry', text: 'Cancel the schedule?' }]);
      assert.deepEqual(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [messageId]))
          .rows,
        [{ state: 'sent' }],
      );
    } finally {
      await channels.close();
    }
  },
);

test(
  'in-flight schedule confirmations finish before their retirement commits',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, posts, receive, turnOf, reply, create, transport } = await outboxFixture(t, 1);
    const control = new pg.Pool({ ...pool.options, password: pool.options.password, max: 1 });
    const messageId = randomUUID();
    const originalPost = transport.post;
    let postEntered = false;
    let releasePost = () => {};
    const postReleased = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    transport.post = async (input) => {
      postEntered = true;
      await postReleased;
      await pool.query('SELECT 1');
      return originalPost(input);
    };
    const channels = await create({
      isRetirableScheduleConfirmation: async (id) => id === messageId,
    });
    let sending: Promise<void> | undefined;
    let update: Promise<unknown> | undefined;
    let updaterPid: number | undefined;
    try {
      receive('111', 'retire-during-send', 'chat-retire-during-send');
      await channels.drain();
      await reply(
        (await turnOf('retire-during-send')).turn_id,
        'Cancel the schedule?',
        messageId,
        0,
      );
      sending = channels.drain();
      await until(() => postEntered);
      update = transaction(async (client) => {
        updaterPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await client.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [messageId]);
      }, control);
      await until(() => updaterPid !== undefined);
      await until(async () => {
        const { rows } = await pool.query<{ waiting: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',
          [updaterPid],
        );
        return rows[0]?.waiting ?? false;
      });
      assert.deepEqual(posts, []);
      releasePost();
      await Promise.all([sending, update]);
      assert.deepEqual(posts, [
        { threadId: 'chat-retire-during-send', text: 'Cancel the schedule?' },
      ]);
      assert.deepEqual(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [messageId]))
          .rows,
        [{ state: 'sent' }],
      );
    } finally {
      releasePost();
      await Promise.allSettled([sending, update]);
      await channels.close();
      await control.end();
    }
  },
);

test(
  'presence follows live work in the conversation that asked, after its queued replies, and repeats only on a change or its cadence',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { posts, receive, turnOf, reply, create, transport } = await outboxFixture(t);
    transport.channels[0]!.presenceMs = 60_000;
    const shown: Array<{ after: number; threadId: string; messageId: string; status?: string }> =
      [];
    transport.presence = async (input) => {
      shown.push({
        after: posts.length,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.status ? { status: input.status } : {}),
      });
    };
    let live: LiveWork[] = [];
    const channels = await create({ activity: async () => live });
    const work = (channel: string, step: string | null, title: string | null = null) => ({
      turnId: randomUUID(),
      taskId: title ? randomUUID() : null,
      title,
      step,
      site: null,
      since: new Date().toISOString(),
      doing: 'model' as const,
      quietSince: new Date().toISOString(),
      channel,
    });
    try {
      receive('111', 'a1', 'chat-a1');
      receive('222', 'b1', 'chat-b1');
      await channels.drain();
      const [a1, b1] = [await turnOf('a1'), await turnOf('b1')];
      await reply(a1.turn_id, 'On it.', 'ffffffff-0000-4000-8000-0000000000a1', 1);
      live = [work('web', 'A synthetic web step.'), work(a1.channel, 'Checking synthetic seats.')];
      await channels.drain();
      await until(() => shown.length === 1);
      assert.deepEqual(posts, [{ threadId: 'chat-a1', text: 'On it.' }]);
      assert.deepEqual(shown, [
        { after: 1, threadId: 'chat-a1', messageId: 'a1', status: 'Checking synthetic seats.' },
      ]);
      await channels.drain();
      assert.equal(shown.length, 1);
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(61_000);
      await channels.drain();
      await until(() => shown.length === 2);
      t.mock.timers.reset();
      assert.deepEqual(shown.at(-1), {
        after: 1,
        threadId: 'chat-a1',
        messageId: 'a1',
        status: 'Checking synthetic seats.',
      });
      live = [
        work(a1.channel, 'Comparing two synthetic fares.', 'Synthetic trip'),
        work(b1.channel, null),
      ];
      await channels.drain();
      await until(() => shown.length === 4);
      assert.deepEqual(shown.slice(2), [
        {
          after: 1,
          threadId: 'chat-a1',
          messageId: 'a1',
          status: 'Synthetic trip: Comparing two synthetic fares.',
        },
        { after: 1, threadId: 'chat-b1', messageId: 'b1' },
      ]);
      live = [work(a1.channel, 'Opening http://localhost:5678/home to build it.')];
      await channels.drain();
      await until(() => shown.length === 5);
      assert.deepEqual(shown.at(-1), { after: 1, threadId: 'chat-a1', messageId: 'a1' });
      live = [];
      await channels.drain();
      live = [work(b1.channel, null)];
      await channels.drain();
      await until(() => shown.length === 6);
      assert.equal(shown.length, 6);
    } finally {
      await channels.close();
    }
  },
);

test(
  'replyable Telegram progress preserves independent task targets and restores only finished work',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await outboxFixture(t);
    const { pool, posts, receive, turnOf, reply, create, transport } = fixture;
    const post = transport.post;
    transport.post = async (input) => {
      const result = await post(input);
      return { id: result.id, ids: [result.id] };
    };
    const edits: Array<Parameters<NonNullable<MessagingTransport['progress']>>[0]> = [];
    transport.progress = async (input) => {
      edits.push(input);
    };
    const submitted: Array<{ text: string; target?: string }> = [];
    let live: LiveWork[] = [];
    const channels = await create({
      activity: async () => live,
      submit: async (text, sourceId, client, channel, _messageId, _answer, target) => {
        submitted.push({ text, target });
        const id = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
          [id, fixture.threadId, sourceId, channel],
        );
        return id;
      },
    });
    const work = (turnId: string, channel: string, messageId: string, step: string): LiveWork => ({
      turnId,
      channel,
      messageId,
      taskId: randomUUID(),
      title: 'Fixture task',
      step,
      site: null,
      since: new Date().toISOString(),
      doing: 'model' as const,
      quietSince: new Date().toISOString(),
    });
    try {
      receive('111', 'first', 'chat-owner');
      receive('111', 'second', 'chat-owner');
      receive('222', 'other', 'chat-other');
      await channels.drain();
      const first = await turnOf('first');
      const second = await turnOf('second');
      const other = await turnOf('other');
      const firstMessage = randomUUID();
      const secondMessage = randomUUID();
      const otherMessage = randomUUID();
      await reply(first.turn_id, 'I will compare the trains.', firstMessage, 1);
      await reply(second.turn_id, 'I will check the warranty.', secondMessage, 2);
      await reply(other.turn_id, 'I will check the calendar.', otherMessage, 3);
      await channels.drain();
      live = [
        work(first.turn_id, first.channel, firstMessage, 'Checking fares.'),
        work(second.turn_id, second.channel, secondMessage, 'Reading the warranty.'),
      ];
      await channels.drain();
      await until(() => edits.length === 2);
      assert.deepEqual(
        edits.map((edit) => edit.messageId),
        ['provider-1', 'provider-2'],
      );
      assert.ok(edits.every((edit) => edit.threadId === 'chat-owner' && edit.status));
      assert.equal(posts.length, 3);
      receive('111', 'correction', 'chat-owner', 'Use the later train.', 'provider-1');
      receive('111', 'unrelated', 'chat-owner', 'What is tomorrow’s weather?');
      await channels.drain();
      assert.deepEqual(submitted.slice(-2), [
        { text: 'Use the later train.', target: firstMessage },
        { text: 'What is tomorrow’s weather?', target: undefined },
      ]);
      await reply(first.turn_id, 'The train options are ready.', randomUUID(), 4);
      await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [first.turn_id]);
      live = live.slice(1);
      await channels.drain();
      await until(() => edits.length === 3);
      assert.equal(edits[2]!.messageId, 'provider-1');
      assert.equal(edits[2]!.status, null);
      assert.equal(edits[2]!.text, 'I will compare the trains.');
      assert.equal(posts.length, 4);
      const boundedStatus = `${'a'.repeat(999)}👩🏽‍💻`;
      live = [{ ...live[0]!, title: null, step: `${boundedStatus} more status` }];
      await channels.drain();
      await until(() => edits.length === 4);
      assert.equal(edits[3]!.messageId, 'provider-2');
      assert.equal(edits[3]!.status, boundedStatus);
      live = [];
      await channels.drain();
      await until(() => edits.length === 5);
      assert.equal(edits[4]!.messageId, 'provider-2');
      assert.equal(edits[4]!.status, null);
      assert.equal(
        (await pool.query('SELECT 1 FROM channel_outbox WHERE live_status IS NOT NULL')).rowCount,
        0,
      );
    } finally {
      await channels.close();
    }
  },
);

test(
  'a pending Telegram status edit never blocks corrections, and stopping aborts it before cleanup',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, receive, turnOf, reply, create, transport } = await outboxFixture(t);
    const post = transport.post;
    transport.post = async (input) => ({ id: (await post(input)).id });
    let editing: AbortSignal | undefined;
    const edits: Array<string | null> = [];
    transport.progress = async (input) => {
      edits.push(input.status);
      if (!input.status) return;
      editing = input.signal;
      await new Promise<never>((_, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    };
    let live: LiveWork[] = [];
    const channels = await create({ activity: async () => live });
    try {
      receive('111', 'start', 'chat-owner');
      await channels.drain();
      const start = await turnOf('start');
      const messageId = randomUUID();
      await reply(start.turn_id, 'I will compare options.', messageId, 1);
      await channels.drain();
      live = [
        {
          turnId: start.turn_id,
          channel: start.channel,
          messageId,
          taskId: null,
          title: null,
          step: 'Reading the options.',
          site: null,
          since: new Date().toISOString(),
          doing: 'model' as const,
          quietSince: new Date().toISOString(),
        },
      ];
      await channels.drain();
      await until(() => Boolean(editing));
      receive('111', 'correction', 'chat-owner', 'Use the other date.', 'provider-1');
      await channels.drain();
      assert.ok((await turnOf('correction')).turn_id);
      assert.equal(editing!.aborted, false);
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [start.turn_id]);
      live = [];
      await channels.drain();
      await until(() => editing!.aborted && edits.at(-1) === null);
      assert.equal(edits.length, 2);
      await channels.drain();
      assert.equal(edits.length, 2);
    } finally {
      await channels.close();
    }
  },
);

test(
  'channel close and replacement abort pending Telegram edits and preserve cleanup for the same account',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const mode of ['close', 'replace'])
      await t.test(mode, async (t) => {
        const { pool, receive, turnOf, reply, create, transport } = await outboxFixture(t);
        const post = transport.post;
        transport.post = async (input) => ({ id: (await post(input)).id });
        let editing: AbortSignal | undefined;
        transport.progress = async (input) => {
          editing = input.signal;
          await new Promise<never>((_, reject) => {
            input.signal.addEventListener('abort', () => reject(input.signal.reason), {
              once: true,
            });
          });
        };
        let live: LiveWork[] = [];
        const channels = await create({ activity: async () => live });
        const restored: string[] = [];
        try {
          receive('111', 'start', 'chat-owner');
          await channels.drain();
          const start = await turnOf('start');
          const messageId = randomUUID();
          await reply(start.turn_id, 'I will check the options.', messageId, 1);
          await channels.drain();
          live = [
            {
              turnId: start.turn_id,
              channel: start.channel,
              messageId,
              taskId: null,
              title: null,
              step: 'Reading options.',
              site: null,
              since: new Date().toISOString(),
              doing: 'model' as const,
              quietSince: new Date().toISOString(),
            },
          ];
          await channels.drain();
          await until(() => Boolean(editing));
          if (mode === 'close') await channels.close();
          else {
            live = [];
            await channels.replaceTransport({
              ...transport,
              progress: async (input) => {
                assert.equal(input.status, null);
                restored.push(input.messageId);
              },
            });
            await until(
              async () =>
                restored.length === 1 &&
                (
                  await pool.query('SELECT live_status FROM channel_outbox WHERE message_id=$1', [
                    messageId,
                  ])
                ).rows[0]?.live_status === null,
            );
            assert.deepEqual(restored, ['provider-1']);
          }
          assert.equal(editing!.aborted, true);
          const saved = (
            await pool.query('SELECT live_status FROM channel_outbox WHERE message_id=$1', [
              messageId,
            ])
          ).rows[0];
          assert.equal(saved.live_status === null, mode === 'replace');
        } finally {
          await channels.close();
        }
      });
  },
);

test(
  'Telegram retries an unconfirmed unchanged status in place, including after restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const restart of [false, true])
      await t.test(restart ? 'restart' : 'transient failure', async (t) => {
        const { pool, posts, receive, turnOf, reply, create, transport } = await outboxFixture(t);
        const post = transport.post;
        transport.post = async (input) => ({ id: (await post(input)).id });
        const edits: Array<{ id: string; status: string | null }> = [];
        let unavailable = true;
        let successfulUpdates = 0;
        transport.progress = async (input) => {
          edits.push({ id: input.messageId, status: input.status });
          if (unavailable) throw new Error('Fixture progress connection failed.');
          if (input.status) successfulUpdates++;
        };
        let live: LiveWork[] = [];
        let channels = await create({ activity: async () => live });
        try {
          receive('111', 'start', 'chat-owner');
          await channels.drain();
          const start = await turnOf('start');
          const messageId = randomUUID();
          await reply(start.turn_id, 'I will compare the options.', messageId, 1);
          await channels.drain();
          live = [
            {
              turnId: start.turn_id,
              channel: start.channel,
              messageId,
              taskId: null,
              title: null,
              step: 'Comparing the options.',
              site: null,
              since: new Date().toISOString(),
              doing: 'model' as const,
              quietSince: new Date().toISOString(),
            },
          ];
          await channels.drain();
          await until(() => edits.length >= 1);
          assert.equal(
            (
              await pool.query('SELECT live_status FROM channel_outbox WHERE message_id=$1', [
                messageId,
              ])
            ).rows[0].live_status,
            live[0]!.step,
          );
          if (restart) {
            await channels.close();
            channels = await create({ activity: async () => live });
          }
          unavailable = false;
          await channels.drain();
          await until(() => successfulUpdates === 1);
          assert.ok(edits.length >= 2);
          assert.ok(
            edits.every((edit) => edit.id === 'provider-1' && edit.status === live[0]!.step),
          );
          const confirmedAttempts = edits.length;
          for (let attempt = 0; attempt < 3; attempt++) await channels.drain();
          assert.equal(edits.length, confirmedAttempts);
          live = [];
          await channels.drain();
          await until(
            async () =>
              (
                await pool.query('SELECT live_status FROM channel_outbox WHERE message_id=$1', [
                  messageId,
                ])
              ).rows[0].live_status === null,
          );
          assert.deepEqual(edits.at(-1), { id: 'provider-1', status: null });
          assert.equal(posts.length, 1);
        } finally {
          await channels.close();
        }
      });
  },
);

test(
  'Telegram cleanup remains recoverable until the original message is restored',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, receive, turnOf, reply, create, transport } = await outboxFixture(t);
    const post = transport.post;
    transport.post = async (input) => ({ id: (await post(input)).id });
    let restoring: AbortSignal | undefined;
    transport.progress = async (input) => {
      assert.equal(input.status, null);
      restoring = input.signal;
      await new Promise<never>((_, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    };
    let channels = await create({ activity: async () => [] });
    try {
      receive('111', 'start', 'chat-owner');
      await channels.drain();
      const start = await turnOf('start');
      const messageId = randomUUID();
      await reply(start.turn_id, 'I will check the options.', messageId, 1);
      await channels.drain();
      await pool.query('UPDATE channel_outbox SET live_status=$2 WHERE message_id=$1', [
        messageId,
        'Checking options.',
      ]);
      await channels.drain();
      await until(() => Boolean(restoring));
      const savedStatus = async () =>
        (
          await pool.query('SELECT live_status FROM channel_outbox WHERE message_id=$1', [
            messageId,
          ])
        ).rows[0].live_status;
      assert.equal(await savedStatus(), 'Checking options.');
      await channels.close();
      assert.equal(restoring!.aborted, true);
      assert.equal(await savedStatus(), 'Checking options.');
      const restored: string[] = [];
      transport.progress = async (input) => {
        assert.equal(input.status, null);
        assert.equal(await savedStatus(), 'Checking options.');
        restored.push(input.messageId);
      };
      channels = await create({ activity: async () => [] });
      await channels.drain();
      await until(async () => (await savedStatus()) === null);
      assert.deepEqual(restored, ['provider-1']);
    } finally {
      await channels.close();
    }
  },
);

test(
  'Telegram progress skips uncertain sends, split messages and attachments, and restores a persisted status after restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, receive, turnOf, reply, create, transport } = await outboxFixture(t);
    const post = transport.post;
    transport.post = async (input) => {
      if (input.text === 'Uncertain acknowledgement.') throw new Error('Fixture lost response.');
      const result = await post(input);
      return input.text === 'Split acknowledgement.' ? result : { id: result.id };
    };
    const edits: Array<{ id: string; status: string | null }> = [];
    transport.progress = async (input) => {
      edits.push({ id: input.messageId, status: input.status });
    };
    let live: LiveWork[] = [];
    let channels = await create({ activity: async () => live });
    try {
      receive('111', 'start', 'chat-owner');
      await channels.drain();
      const start = await turnOf('start');
      const ids = Array.from({ length: 4 }, () => randomUUID());
      for (const [index, text] of [
        'Uncertain acknowledgement.',
        'Split acknowledgement.',
        'An attachment.',
        'An ordinary acknowledgement.',
      ].entries())
        await reply(start.turn_id, text, ids[index]!, index + 1);
      await pool.query('UPDATE messages SET attachments=$2 WHERE id=$1', [
        ids[2],
        JSON.stringify([{ id: randomUUID() }]),
      ]);
      await channels.drain();
      live = ids.map((messageId) => ({
        turnId: start.turn_id,
        channel: start.channel,
        messageId,
        taskId: null,
        title: null,
        step: 'Checking a source.',
        site: null,
        since: new Date().toISOString(),
        doing: 'model' as const,
        quietSince: new Date().toISOString(),
      }));
      await channels.drain();
      await until(() => edits.length === 1);
      assert.equal(edits[0]!.id, 'provider-2');
      await channels.close();
      live = [];
      channels = await create({ activity: async () => live });
      await channels.drain();
      await until(() => edits.length === 2);
      assert.equal(edits[1]!.id, edits[0]!.id);
      assert.equal(edits[1]!.status, null);
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [ids[0]])).rows[0]
          .state,
        'uncertain',
      );
    } finally {
      await channels.close();
    }
  },
);

test(
  'outbox presentation failures and revocation never send private URLs or replay a claimed reply',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const inputs: unknown[] = [];
    let startGeneration!: () => void;
    let releaseGeneration!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      startGeneration = resolve;
    });
    const generationReleased = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let response = 'generated';
    const channels = await create({
      present: async (thread, input) => {
        assert.equal(thread, threadId);
        inputs.push(input);
        assert.doesNotMatch(JSON.stringify(input), /private-token|credential-request/);
        if (response === 'failure') throw new Error('Synthetic presentation failure');
        if (response === 'hold') {
          startGeneration();
          await generationReleased;
        }
        return response === 'unsafe'
          ? '/credentials/credential-request'
          : 'Continua na aplicação Nod.';
      },
    });
    const state = async (id: string) =>
      (await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [id]))
        .rows[0];
    try {
      receive('111', 'a1', 'chat-a1');
      await channels.drain();
      const { turn_id: turnId } = await turnOf('a1');
      await reply(turnId, 'Resposta pronta.', randomUUID(), 0);
      await channels.drain();
      assert.equal(inputs.length, 0);
      assert.deepEqual(posts, [{ threadId: 'chat-a1', text: 'Resposta pronta.' }]);
      const privateReply = '[Continua](/credentials/private-token)';
      const accepted = randomUUID();
      await reply(turnId, privateReply, accepted, 1);
      await channels.drain();
      assert.equal((await state(accepted)).state, 'sent');
      for (const outcome of ['failure', 'unsafe']) {
        response = outcome;
        const blocked = randomUUID();
        await reply(turnId, privateReply, blocked, 2);
        await channels.drain();
        assert.deepEqual(await state(blocked), {
          state: 'blocked',
          reason: 'presentation_unavailable',
        });
        const generationCount: number = inputs.length;
        await channels.drain();
        assert.equal(inputs.length, generationCount);
        assert.equal(posts.length, 2);
      }
      response = 'hold';
      const revoked = randomUUID();
      await reply(turnId, privateReply, revoked, 3);
      const draining = channels.drain();
      await generationStarted;
      const replacement = channels.replaceTransport({
        channels: [],
        receive: async () => ({ status: 200, body: {} }),
        post: async () => {
          throw new Error('Revoked channel cannot send');
        },
        close: async () => {},
      });
      releaseGeneration();
      await Promise.all([draining, replacement]);
      assert.deepEqual(await state(revoked), {
        state: 'blocked',
        reason: 'channel_access_changed',
      });
      assert.equal(posts.length, 2);
      assert.doesNotMatch(JSON.stringify(posts), /private-token|credential-request/);
    } finally {
      releaseGeneration();
      await channels.close();
    }
  },
);

test(
  'a lost provider reply never sends a committed message twice',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const provider of ['telegram', 'whatsapp'])
      await t.test(provider, async (t) => {
        const { pool, posts, receive, turnOf, reply, create, transport } = await outboxFixture(
          t,
          undefined,
          provider,
        );
        const post = transport.post;
        transport.post = async (input) => {
          await post(input);
          throw new Error('Synthetic lost provider reply after acceptance');
        };
        const original = await create();
        try {
          receive('111', 'nudge', 'chat-nudge');
          await original.drain();
          const { turn_id: turnId } = await turnOf('nudge');
          const id = randomUUID();
          await reply(turnId, 'A synthetic decision changed. A reply is ready.', id, 0);
          await original.drain();
          await original.close();
          const restarted = await create();
          try {
            await Promise.all([restarted.drain(), restarted.drain(), original.drain()]);
            assert.equal(posts.length, 1);
            assert.deepEqual(
              (
                await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
                  id,
                ])
              ).rows,
              [{ state: 'uncertain', reason: 'send_not_confirmed' }],
            );
          } finally {
            await restarted.close();
          }
        } finally {
          await original.close();
        }
      });
  },
);

test(
  'restart reclaims presentation without replaying an interrupted provider send',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, posts, receive, turnOf, reply, create, transport } = await outboxFixture(t, 1);
    let startPresentation = () => {};
    let releasePresentation = () => {};
    const presentationStarted = new Promise<void>((resolve) => {
      startPresentation = resolve;
    });
    const presentationReleased = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    let startSend = () => {};
    let releaseSend = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      startSend = resolve;
    });
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const instances: Awaited<ReturnType<typeof create>>[] = [];
    const original = await create({
      present: async () => {
        await pool.query('SELECT 1');
        startPresentation();
        await presentationReleased;
        return 'Stale prepared reply';
      },
    });
    instances.push(original);
    const state = async (id: string) =>
      (await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [id]))
        .rows[0];
    try {
      receive('111', 'restart', 'chat-restart');
      await original.drain();
      const { turn_id: turnId } = await turnOf('restart');
      const preparedReply = randomUUID();
      await reply(turnId, '', preparedReply, 0);
      await pool.query(
        'INSERT INTO channel_outbox(message_id,source_id,presentation) VALUES($1,$2,$3)',
        [
          preparedReply,
          'channel:telegram:bot:restart',
          JSON.stringify({ kind: 'verification_refused' }),
        ],
      );
      const preparing = original.drain();
      await presentationStarted;
      assert.deepEqual(await state(preparedReply), { state: 'preparing', reason: null });
      assert.deepEqual(posts, []);
      const restarted = await create({ present: async () => 'Current prepared reply' });
      instances.push(restarted);
      await restarted.drain();
      releasePresentation();
      await preparing;
      assert.deepEqual(posts, [{ threadId: 'chat-restart', text: 'Current prepared reply' }]);
      assert.deepEqual(await state(preparedReply), { state: 'sent', reason: null });
      assert.equal(
        (await pool.query('SELECT text FROM messages WHERE id=$1', [preparedReply])).rows[0].text,
        'Current prepared reply',
      );
      await restarted.replaceTransport({
        ...transport,
        post: async (input) => {
          const result = await transport.post(input);
          startSend();
          await sendReleased;
          return result;
        },
      });
      const interruptedReply = randomUUID();
      await reply(turnId, 'Provider send started', interruptedReply, 1);
      const sending = restarted.drain();
      await sendStarted;
      assert.deepEqual(await state(interruptedReply), { state: 'sending', reason: null });
      const recovered = await create();
      instances.push(recovered);
      await recovered.drain();
      releaseSend();
      await sending;
      await Promise.all(instances.map((instance) => instance.drain()));
      assert.deepEqual(await state(interruptedReply), {
        state: 'uncertain',
        reason: 'interrupted_send',
      });
      assert.deepEqual(posts, [
        { threadId: 'chat-restart', text: 'Current prepared reply' },
        { threadId: 'chat-restart', text: 'Provider send started' },
      ]);
    } finally {
      releasePresentation();
      releaseSend();
      await Promise.all(instances.map((instance) => instance.close()));
    }
  },
);

test(
  'reset and revocation during the send transition prevent a provider attempt',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    for (const change of ['reset', 'replace'])
      await t.test(change, async (t) => {
        const { pool, threadId, posts, receive, turnOf, reply, create, transport } =
          await outboxFixture(t);
        const channels = await create();
        const blocker = await pool.connect();
        const lockId = (randomBytes(4).readUInt32BE(0) % 2147483646) + 1;
        try {
          receive('111', 'transition', 'chat-transition');
          await channels.drain();
          const messageId = randomUUID();
          await reply((await turnOf('transition')).turn_id, 'Prepared reply', messageId, 0);
          await pool.query(`CREATE FUNCTION hold_send_transition() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.state='sending' AND OLD.state='preparing' THEN
                PERFORM pg_advisory_xact_lock(${lockId});
              END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER hold_send_transition BEFORE UPDATE ON channel_outbox
              FOR EACH ROW EXECUTE FUNCTION hold_send_transition()`);
          await blocker.query('SELECT pg_advisory_lock($1)', [lockId]);
          const draining = channels.drain();
          let waiting = false;
          for (let attempt = 0; attempt < 200; attempt++) {
            waiting = (
              await pool.query(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1::oid AND NOT granted) AS waiting",
                [lockId],
              )
            ).rows[0].waiting;
            if (waiting) break;
            await sleep(10);
          }
          assert.equal(waiting, true);
          const changed =
            change === 'reset'
              ? pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId])
              : channels.replaceTransport({ ...transport, channels: [] });
          if (change === 'reset') await changed;
          await blocker.query('SELECT pg_advisory_unlock($1)', [lockId]);
          await Promise.all([draining, changed]);
          assert.deepEqual(posts, []);
          assert.deepEqual(
            (
              await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
                messageId,
              ])
            ).rows[0],
            {
              state: 'blocked',
              reason: change === 'reset' ? 'thread_changed' : 'channel_access_changed',
            },
          );
          await channels.drain();
          assert.deepEqual(posts, []);
        } finally {
          await blocker.query('SELECT pg_advisory_unlock($1)', [lockId]);
          blocker.release();
          await channels.close();
        }
      });
  },
);

for (const provider of ['telegram', 'whatsapp'])
  test(
    `${provider} task commands keep native reply targets, send receipts once and do not start a model turn`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(
        t,
        undefined,
        provider,
      );
      const anchor = randomUUID();
      const calls: Array<{ command: string; target?: string; hasReply?: boolean }> = [];
      let commits = 0;
      const channels = await create({
        taskCommand: async (_client, command, target, hasReply) => {
          calls.push({ command, target, hasReply });
          return {
            threadId,
            replies: [{ text: 'Fixture task status', replyToMessageId: target }],
            afterCommit: async () => {
              assert.equal(
                (await pool.query("SELECT state FROM channel_inbox WHERE text='/stop'")).rows[0]
                  .state,
                'submitted',
              );
              commits++;
            },
          };
        },
      });
      try {
        receive('111', 'initial', 'chat-a');
        await channels.drain();
        await reply((await turnOf('initial')).turn_id, 'Task started', anchor, 0);
        await channels.drain();
        receive('111', 'stop-task', 'chat-a', '/stop', 'provider-1-file');
        await channels.drain();
        assert.deepEqual(calls, [{ command: 'stop', target: anchor, hasReply: true }]);
        assert.equal((await turnOf('stop-task')).turn_id, null);
        assert.equal(posts.at(-1)!.replyToMessageId, 'provider-1');
        assert.equal(
          (
            await pool.query(
              "SELECT m.delivered_channel=i.channel AS same_channel FROM messages m JOIN channel_outbox o ON o.message_id=m.id JOIN channel_inbox i USING(source_id) WHERE i.text='/stop'",
            )
          ).rows[0].same_channel,
          true,
        );
        assert.equal(commits, 1);
        await channels.drain();
        assert.equal(commits, 1);
        receive('222', 'foreign-stop', 'chat-a', '/stop', 'provider-1');
        await channels.drain();
        assert.deepEqual(calls.at(-1), { command: 'stop', target: undefined, hasReply: true });
        receive('111', 'list-tasks', 'chat-a', '/tasks@fixture_bot');
        await channels.drain();
        assert.deepEqual(calls.at(-1), { command: 'tasks', target: undefined, hasReply: false });
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM turns')).rows[0].n, 1);
        const beforeRetired = calls.length;
        await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [anchor]);
        receive('111', 'retired-stop', 'chat-a', '/stop', 'provider-1');
        receive('111', 'after-retired', 'chat-a', 'Start a new task');
        await channels.drain();
        assert.equal(calls.length, beforeRetired);
        assert.deepEqual(
          (
            await pool.query('SELECT state,turn_id FROM channel_inbox WHERE source_id=$1', [
              `channel:${provider}:bot:retired-stop`,
            ])
          ).rows[0],
          { state: 'discarded', turn_id: null },
        );
        assert.ok((await turnOf('after-retired')).turn_id);
      } finally {
        await channels.close();
      }
    },
  );

for (const provider of ['telegram', 'whatsapp'])
  test(
    `${provider} consumes replies to hidden confirmations and drains later messages`,
    { skip: !process.env.TEST_DATABASE_URL },
    async (t) => {
      const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(
        t,
        undefined,
        provider,
      );
      const firstConfirmation = randomUUID();
      const racedConfirmation = randomUUID();
      const lateConfirmation = randomUUID();
      const lateReplacementConfirmation = randomUUID();
      const hiddenAfterLookup = randomUUID();
      const unrelatedHidden = randomUUID();
      const activeConfirmation = randomUUID();
      const scheduleConfirmations = new Set<string>([
        firstConfirmation,
        racedConfirmation,
        lateConfirmation,
        lateReplacementConfirmation,
        hiddenAfterLookup,
        activeConfirmation,
      ]);
      const submitted: Array<{ text: string; target?: string }> = [];
      const submittedAnswers: Array<{
        text: string;
        answer?: { approvalId: string; approved?: boolean };
      }> = [];
      const answered: string[] = [];
      const classified: Array<{ text: string; confirmation: string }> = [];
      const commands: Array<{ command: string; target?: string; hasReply?: boolean }> = [];
      const query = pool.query.bind(pool) as (
        text: string,
        values?: unknown[],
      ) => Promise<pg.QueryResult>;
      let retireAfterNativeReply = false;
      let retireAfterHiddenLookup = false;
      t.mock.method(pool, 'query', async (text: string, values?: unknown[]) => {
        const result = await query(text, values);
        if (
          retireAfterNativeReply &&
          text.includes('SELECT o.message_id FROM channel_outbox') &&
          result.rows[0]?.message_id === racedConfirmation
        ) {
          retireAfterNativeReply = false;
          await query('UPDATE messages SET hidden_at=now() WHERE id=$1', [racedConfirmation]);
        }
        if (
          retireAfterHiddenLookup &&
          text ===
            'SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND hidden_at IS NOT NULL' &&
          values?.[0] === hiddenAfterLookup &&
          !result.rowCount
        ) {
          retireAfterHiddenLookup = false;
          await query('UPDATE messages SET hidden_at=now() WHERE id=$1', [hiddenAfterLookup]);
        }
        return result;
      });
      const channels = await create({
        isRetirableScheduleConfirmation: async (id) => scheduleConfirmations.has(id),
        classifyRetiredReply: async (text, confirmation) => {
          classified.push({ text, confirmation });
          if (text === 'Why is this happening?') throw new Error('Synthetic classifier failure.');
          if (
            text === 'Why did you ask?' ||
            text === 'Yes, move the reminder to tomorrow' ||
            text === 'Yes, move the fifth task to tomorrow' ||
            text === 'Why is the fourth task still here?'
          )
            return 'new';
          return text === 'Maybe' ? 'uncertain' : 'stale';
        },
        answer: async (text, _channel, target) => {
          answered.push(text);
          return target ? { approvalId: 'synthetic-approval', approved: true } : undefined;
        },
        submit: async (text, sourceId, client, channel, _messageId, answer, target) => {
          submitted.push({ text, target });
          submittedAnswers.push({ text, answer });
          const turnId = randomUUID();
          await client.query(
            "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
            [turnId, threadId, sourceId, channel],
          );
          if (text === 'Yes, cancel the third task') {
            assert.equal(target, lateConfirmation);
            await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [lateConfirmation]);
            throw Object.assign(new Error('The reply is unavailable in this conversation.'), {
              statusCode: 404,
            });
          }
          if (text === 'Yes, move the fifth task to tomorrow' && target) {
            assert.equal(target, lateReplacementConfirmation);
            await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [
              lateReplacementConfirmation,
            ]);
            throw Object.assign(new Error('The reply is unavailable in this conversation.'), {
              statusCode: 404,
            });
          }
          return turnId;
        },
        taskCommand: async (_client, command, target, hasReply) => {
          commands.push({ command, target, hasReply });
          return { threadId, replies: [{ text: `Fixture ${command}` }] };
        },
      });
      try {
        receive('111', 'initial', 'chat-a');
        await channels.drain();
        const initial = (await turnOf('initial')).turn_id;
        await reply(initial, 'Cancel the first task?', firstConfirmation, 0);
        await channels.drain();
        assert.equal(posts.length, 1);
        await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [firstConfirmation]);
        receive('111', 'stale-first', 'chat-a', 'Yes, cancel the first task', 'provider-1');
        receive('111', 'following-first', 'chat-a', 'Start something new');
        await channels.drain();
        assert.equal(
          submitted.some((item) => item.text === 'Yes, cancel the first task'),
          false,
        );
        assert.equal(answered.includes('Yes, cancel the first task'), false);
        assert.deepEqual(
          classified.find((item) => item.text === 'Yes, cancel the first task'),
          {
            text: 'Yes, cancel the first task',
            confirmation: 'Cancel the first task?',
          },
        );
        await reply(initial, 'Cancel the second task?', racedConfirmation, 1);
        await channels.drain();
        assert.equal(posts.length, 2);
        retireAfterNativeReply = true;
        receive('111', 'stale-race', 'chat-a', 'Yes, cancel the second task', 'provider-2');
        receive('111', 'following-race', 'chat-a', 'Check the weather');
        await channels.drain();
        assert.equal(retireAfterNativeReply, false);
        assert.equal(
          submitted.some((item) => item.text === 'Yes, cancel the second task'),
          false,
        );
        assert.equal(answered.includes('Yes, cancel the second task'), false);
        assert.deepEqual(
          classified.find((item) => item.text === 'Yes, cancel the second task'),
          {
            text: 'Yes, cancel the second task',
            confirmation: 'Cancel the second task?',
          },
        );
        await reply(initial, 'Cancel the third task?', lateConfirmation, 2);
        await channels.drain();
        assert.equal(posts.length, 3);
        receive('111', 'stale-late', 'chat-a', 'Yes, cancel the third task', 'provider-3');
        receive('111', 'following-late', 'chat-a', 'Summarize my calendar');
        await channels.drain();
        assert.equal(answered.includes('Yes, cancel the third task'), true);
        assert.deepEqual(
          submitted.find((item) => item.text === 'Yes, cancel the third task'),
          { text: 'Yes, cancel the third task', target: lateConfirmation },
        );
        assert.deepEqual(
          classified.find((item) => item.text === 'Yes, cancel the third task'),
          {
            text: 'Yes, cancel the third task',
            confirmation: 'Cancel the third task?',
          },
        );
        const inbox = (
          await pool.query(
            'SELECT source_id,state,turn_id FROM channel_inbox WHERE source_id=ANY($1::text[]) ORDER BY source_id',
            [
              [
                'stale-first',
                'following-first',
                'stale-race',
                'following-race',
                'stale-late',
                'following-late',
              ].map((id) => `channel:${provider}:bot:${id}`),
            ],
          )
        ).rows;
        assert.deepEqual(
          inbox.map(({ source_id, state, turn_id }) => ({
            source: source_id.split(':').at(-1),
            state,
            hasTurn: Boolean(turn_id),
          })),
          [
            { source: 'following-first', state: 'submitted', hasTurn: true },
            { source: 'following-late', state: 'submitted', hasTurn: true },
            { source: 'following-race', state: 'submitted', hasTurn: true },
            { source: 'stale-first', state: 'discarded', hasTurn: false },
            { source: 'stale-late', state: 'discarded', hasTurn: false },
            { source: 'stale-race', state: 'discarded', hasTurn: false },
          ],
        );
        assert.deepEqual(
          (await pool.query('SELECT source_id FROM turns ORDER BY source_id')).rows.map(
            ({ source_id }) => source_id,
          ),
          ['following-first', 'following-late', 'following-race', 'initial'].map(
            (id) => `channel:${provider}:bot:${id}`,
          ),
        );
        assert.equal(
          submitted.find((item) => item.text === 'Check the weather')?.target,
          undefined,
        );
        await reply(initial, 'Cancel the active task?', activeConfirmation, 3);
        await channels.drain();
        receive('111', 'active-yes', 'chat-a', 'Yes', `provider-${posts.length}`);
        await channels.drain();
        assert.deepEqual(
          submitted.find((item) => item.text === 'Yes'),
          {
            text: 'Yes',
            target: activeConfirmation,
          },
        );
        assert.deepEqual(submittedAnswers.find((item) => item.text === 'Yes')?.answer, {
          approvalId: 'synthetic-approval',
          approved: true,
        });
        assert.equal(
          classified.some((item) => item.text === 'Yes'),
          false,
        );

        await reply(initial, 'Unrelated hidden message', unrelatedHidden, 4);
        await channels.drain();
        const unrelatedProviderId = `provider-${posts.length}`;
        await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [unrelatedHidden]);
        receive('111', 'unrelated-hidden', 'chat-a', 'Why is this gone?', unrelatedProviderId);
        await channels.drain();
        assert.equal(
          (
            await pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [
              `channel:${provider}:bot:unrelated-hidden`,
            ])
          ).rows[0]?.state,
          'discarded',
        );
        assert.equal(
          classified.some((item) => item.text === 'Why is this gone?'),
          false,
        );

        receive('111', 'retired-question', 'chat-a', 'Why did you ask?', 'provider-1');
        receive(
          '111',
          'retired-replacement',
          'chat-a',
          'Yes, move the reminder to tomorrow',
          'provider-1',
        );
        receive('111', 'retired-bare-yes', 'chat-a', 'Yes', 'provider-1');
        receive('111', 'retired-no', 'chat-a', 'No', 'provider-1');
        receive('111', 'retired-uncertain', 'chat-a', 'Maybe', 'provider-1');
        receive(
          '111',
          'retired-classifier-failure',
          'chat-a',
          'Why is this happening?',
          'provider-1',
        );
        receive('111', 'retired-tasks', 'chat-a', '/tasks', 'provider-1');
        receive('111', 'retired-status', 'chat-a', '/status', 'provider-1');
        receive('111', 'retired-stop', 'chat-a', '/stop', 'provider-1');
        receive('111', 'after-classifier-failure', 'chat-a', 'Create a fresh task');
        await channels.drain();
        for (const text of ['Why did you ask?', 'Yes, move the reminder to tomorrow']) {
          assert.deepEqual(
            submitted.find((item) => item.text === text),
            {
              text,
              target: undefined,
            },
          );
          assert.equal(submittedAnswers.find((item) => item.text === text)?.answer, undefined);
          assert.equal(answered.includes(text), false);
          assert.deepEqual(
            classified.find((item) => item.text === text),
            {
              text,
              confirmation: 'Cancel the first task?',
            },
          );
        }
        assert.deepEqual(commands, [
          { command: 'tasks', target: undefined, hasReply: false },
          { command: 'status', target: undefined, hasReply: false },
          { command: 'stop', target: undefined, hasReply: true },
        ]);
        for (const id of ['retired-bare-yes', 'retired-no']) {
          assert.deepEqual(
            (
              await pool.query('SELECT state,turn_id FROM channel_inbox WHERE source_id=$1', [
                `channel:${provider}:bot:${id}`,
              ])
            ).rows[0],
            { state: 'discarded', turn_id: null },
          );
        }
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM channel_outbox WHERE source_id=ANY($1::text[])',
              [
                ['stale-first', 'stale-race', 'stale-late', 'retired-bare-yes', 'retired-no'].map(
                  (id) => `channel:${provider}:bot:${id}`,
                ),
              ],
            )
          ).rows[0].n,
          0,
        );
        for (const text of ['Yes', 'No', 'Maybe', 'Why is this happening?'])
          assert.deepEqual(
            classified.find((item) => item.text === text),
            {
              text,
              confirmation: 'Cancel the first task?',
            },
          );
        const notices: string[] = [];
        for (const id of ['retired-uncertain', 'retired-classifier-failure']) {
          const rows = (
            await pool.query(
              `SELECT i.state,i.turn_id,m.owner_id,m.thread_id,m.role,m.text,m.reply_to_message_id,o.state AS delivery
               FROM channel_inbox i JOIN channel_outbox o ON o.source_id=i.source_id
               JOIN messages m ON m.id=o.message_id WHERE i.source_id=$1`,
              [`channel:${provider}:bot:${id}`],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].state, 'submitted');
          assert.equal(rows[0].turn_id, null);
          assert.equal(rows[0].owner_id, 'local-development');
          assert.equal(rows[0].thread_id, threadId);
          assert.equal(rows[0].role, 'assistant');
          assert.equal(rows[0].reply_to_message_id, null);
          assert.equal(rows[0].delivery, 'sent');
          assert.ok(rows[0].text);
          notices.push(rows[0].text);
        }
        assert.equal(notices[0], notices[1]);
        assert.equal(posts.filter((post) => post.text === notices[0]).length, 2);
        await channels.drain();
        assert.equal(posts.filter((post) => post.text === notices[0]).length, 2);
        assert.ok((await turnOf('after-classifier-failure')).turn_id);
        assert.equal(
          submitted.some((item) => item.text === 'Why is this happening?'),
          false,
        );

        await reply(initial, 'Cancel the fourth task?', hiddenAfterLookup, 5);
        await channels.drain();
        retireAfterHiddenLookup = true;
        receive(
          '111',
          'retired-after-lookup',
          'chat-a',
          'Why is the fourth task still here?',
          `provider-${posts.length}`,
        );
        receive('111', 'following-lookup-race', 'chat-a', 'Summarize the weather');
        await channels.drain();
        assert.equal(retireAfterHiddenLookup, false);
        assert.deepEqual(
          submitted.filter((item) => item.text === 'Why is the fourth task still here?'),
          [{ text: 'Why is the fourth task still here?', target: undefined }],
        );
        assert.equal(
          submittedAnswers.find((item) => item.text === 'Why is the fourth task still here?')
            ?.answer,
          undefined,
        );
        assert.ok(answered.includes('Why is the fourth task still here?'));
        assert.ok((await turnOf('retired-after-lookup')).turn_id);
        assert.ok((await turnOf('following-lookup-race')).turn_id);

        await reply(initial, 'Cancel the fifth task?', lateReplacementConfirmation, 6);
        await channels.drain();
        receive(
          '111',
          'retired-late-replacement',
          'chat-a',
          'Yes, move the fifth task to tomorrow',
          `provider-${posts.length}`,
        );
        receive('111', 'following-late-replacement', 'chat-a', 'Summarize my tasks');
        await channels.drain();
        assert.deepEqual(
          submitted.filter((item) => item.text === 'Yes, move the fifth task to tomorrow'),
          [
            { text: 'Yes, move the fifth task to tomorrow', target: lateReplacementConfirmation },
            { text: 'Yes, move the fifth task to tomorrow', target: undefined },
          ],
        );
        assert.deepEqual(
          submittedAnswers
            .filter((item) => item.text === 'Yes, move the fifth task to tomorrow')
            .map((item) => item.answer),
          [{ approvalId: 'synthetic-approval', approved: true }, undefined],
        );
        assert.deepEqual(
          classified.find((item) => item.text === 'Yes, move the fifth task to tomorrow'),
          {
            text: 'Yes, move the fifth task to tomorrow',
            confirmation: 'Cancel the fifth task?',
          },
        );
        assert.equal(
          (
            await pool.query('SELECT count(*)::int AS count FROM turns WHERE source_id=$1', [
              `channel:${provider}:bot:retired-late-replacement`,
            ])
          ).rows[0].count,
          1,
        );
        assert.ok((await turnOf('following-late-replacement')).turn_id);
      } finally {
        await channels.close();
      }
    },
  );

test(
  'Telegram webhook setup binds only the confirmed Start sender',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_pairing_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    const base = `https://api.telegram.org/bot${token}`;
    const updates: { update_id: number }[] = [];
    const sent: Record<string, unknown>[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
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
    const observedChannels: ChannelConnectionObservation[][] = [];
    const settings = await createChannelSettings(pool, {
      ownerId: 'local-development',
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: createChatSdkSetupVerifier(),
      apply: async (environment) =>
        channels!.replaceTransport(createChatSdkTransport(pool, environment)),
      paired: async (candidate, client) => channels!.announcePairing(candidate, client),
      observed: () => (states) => {
        observedChannels.push(states);
      },
    });
    channels = await createChannels(pool, {
      ownerId: 'local-development',
      present: async (thread) => {
        assert.equal(thread, threadId);
        return 'Ligação estabelecida.';
      },
      transport: createChatSdkTransport(pool, await settings.environment()),
      subscribe: () => () => {},
      intervalMs: 600000,
      pair: settings.pair,
      submit: async (text, sourceId, client, channel) => {
        submitted.push(text);
        const turnId = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
          [turnId, threadId, sourceId, channel],
        );
        return turnId;
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
    const deliver = async (from: number, text: string) => {
      const update = {
        update_id: updateId,
        message: {
          message_id: updateId++,
          date: Math.floor(Date.now() / 1000),
          text,
          from: {
            id: from,
            is_bot: false,
            first_name: 'Fixture',
          },
          chat: { id: from, type: 'private' },
        },
      };
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
      await settle();
    };
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/channel-settings/telegram',
        payload: {
          botToken: token,
          webhookUrl: 'https://webhook.example.com/api/webhooks/telegram',
        },
      });
      assert.equal(saved.statusCode, 200);
      await settings.status();
      assert.deepEqual(observedChannels.at(-1), [
        { channel: 'telegram', state: 'setup_pending' },
        { channel: 'whatsapp', state: 'disabled' },
      ]);
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

      await deliver(555, `/start ${code}`);
      await waitFor(async () => (await telegram())?.pairingCandidate?.id === '555');
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
      await deliver(123, `/start ${code}`);
      assert.equal((await telegram())?.pairingCandidate, undefined);

      await deliver(123, `/start ${secondCode}`);
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
      assert.deepEqual(observedChannels.at(-1)?.[0], {
        channel: 'telegram',
        state: 'setup_pending',
      });
      assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '');
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 0);
      assert.equal(sent.length, 0);
      await pool.query('DROP TRIGGER fail_pairing_notice ON channel_outbox');

      const confirmed = await confirm();
      assert.equal(confirmed.statusCode, 200);
      await settings.status();
      assert.deepEqual(observedChannels.at(-1)?.[0], {
        channel: 'telegram',
        state: 'connected',
      });
      assert.equal(JSON.stringify(observedChannels).includes(token), false);
      assert.equal(JSON.stringify(observedChannels).includes('123'), false);
      assert.equal(confirmed.json().channel.allowedUserId, '123');
      const bound = await settings.environment();
      assert.equal(bound.TELEGRAM_ALLOWED_USER_ID, '123');
      assert.equal(
        Object.keys(bound).some((key) => key.startsWith('TELEGRAM_PAIRING_')),
        false,
      );
      await waitFor(() => sent.length === 1);
      assert.equal(String(sent[0].chat_id), '123');
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

const telegramEnvironment = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
  TELEGRAM_ALLOWED_USER_ID: '123456',
};

test(
  'Telegram sends owned artifact bytes through Chat SDK and does not replay partial delivery or read foreign paths',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_media_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const { initializeDatabase, pool } = await import('../src/server/db.ts');
    const { storeArtifact, readThreadArtifacts } = (await import('../src/server/artifacts.ts'))
      .localArtifacts;
    const files = await import('../src/shared/files.ts');
    const { ownerId, dataRoot } = await import('../src/server/config.ts');
    const { activeThread, insertAssistantMessage, withTurnLock } =
      await import('../src/server/thread.ts');
    await initializeDatabase();
    const sent: Array<{
      method: string;
      file: Uint8Array;
      name: string;
      caption: string;
      chat: string;
    }> = [];
    const texts: string[] = [];
    const native: { method: string; data: Record<string, unknown> }[] = [];
    let failDocument = false;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = input instanceof Request ? input.url : String(input);
        if (target.endsWith('/getMe'))
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        if (target.endsWith('/sendMessage')) {
          const body = JSON.parse(String(init?.body));
          texts.push(String(body.text).replace(/\\([^\p{L}\p{N}\s])/gu, '$1'));
          return Response.json({
            ok: true,
            result: {
              message_id: texts.length + 500,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123456, type: 'private' },
              text: 'Fixture accepted',
            },
          });
        }
        if (/\/send(?:Contact|Location|Venue)$/.test(target)) {
          const data = JSON.parse(String(init?.body));
          native.push({ method: target.split('/').at(-1)!, data });
          assert.equal(String(data.chat_id), '123456');
          assert.equal(init?.redirect, 'error');
          return Response.json({ ok: true, result: { message_id: 2000 + native.length } });
        }
        assert.match(
          target,
          /^https:\/\/api\.telegram\.org\/bot987:fixture-not-live\/send(?:Photo|Document|Video|Voice)$/,
        );
        assert.ok(init?.body instanceof FormData);
        const body = init.body;
        const media =
          body.get('photo') ?? body.get('document') ?? body.get('video') ?? body.get('voice');
        assert.ok(media instanceof File);
        const method = target.split('/').at(-1)!;
        sent.push({
          method,
          file: new Uint8Array(await media.arrayBuffer()),
          name: media.name,
          caption: String(body.get('caption') ?? ''),
          chat: String(body.get('chat_id')),
        });
        if (method === 'sendDocument' && failDocument)
          throw new Error('Possibly accepted by provider');
        return Response.json({
          ok: true,
          result: {
            message_id: sent.length + 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture accepted',
          },
        });
      },
    );
    let holdResolve = false;
    let failRead = false;
    let markResolveStarted = () => {};
    let releaseResolve = () => {};
    const resolveStarted = new Promise<void>((resolve) => {
      markResolveStarted = resolve;
    });
    const resolveReleased = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const app = Fastify();
    let presentationFails = false;
    const channels = await createChannels(pool, {
      ownerId,
      transport: createChatSdkTransport(pool, telegramEnvironment),
      present: async (_threadId, input) => {
        if (input.kind === 'delivery' && input.attachments === 'pending')
          return 'O ficheiro está disponível no Nod.';
        if (presentationFails) throw new Error('Fixture presentation failure');
        return 'Ficheiro disponível na aplicação.';
      },
      resolveAttachments: async (threadId, ids) => {
        if (holdResolve) {
          markResolveStarted();
          await resolveReleased;
        }
        const files = await readThreadArtifacts(threadId, ids);
        return failRead
          ? files.map((file) => ({
              ...file,
              read: async () => {
                throw new Error('Synthetic file read failure.');
              },
            }))
          : files;
      },
      subscribe: () => () => {},
      intervalMs: 600_000,
      submit: async (text, sourceId, client, channel, messageId) => {
        const thread = await activeThread(client, ownerId);
        const turnId = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id,message_id,prompt,channel) VALUES($1,$2,$3,'user',$4,$5,$6,$7)",
          [turnId, ownerId, thread.id, sourceId, messageId, text, channel],
        );
        await client.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'user',$3,$4,$5)",
          [messageId, ownerId, text, thread.id, turnId],
        );
        return turnId;
      },
    });
    channels.registerRoutes(app);
    const filePaths: string[] = [];
    const artifactRoot = join(
      dataRoot,
      'artifacts',
      createHash('sha256').update(ownerId).digest('hex'),
    );
    const addReply = async (
      turnId: string,
      attachments: unknown[],
      text = 'Here is the file.',
      presentation?: unknown,
    ) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments,presentation) VALUES($1,$2,'assistant',$3,(SELECT thread_id FROM turns WHERE id=$4),$4,$5,$6)",
        [
          id,
          ownerId,
          text,
          turnId,
          JSON.stringify(attachments),
          presentation ? JSON.stringify(presentation) : null,
        ],
      );
      return id;
    };
    const state = async (id: string) =>
      (await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [id]))
        .rows[0];
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/webhooks/telegram',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': telegramEnvironment.TELEGRAM_WEBHOOK_SECRET_TOKEN,
            },
            payload: {
              update_id: 1,
              message: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                text: 'Send a screenshot and file',
                from: { id: 123456, is_bot: false, first_name: 'Fixture' },
                chat: { id: 123456, type: 'private' },
              },
            },
          })
        ).statusCode,
        200,
      );
      await channels.drain();
      const inbound = (
        await pool.query(
          'SELECT i.turn_id,u.thread_id FROM channel_inbox i JOIN turns u ON u.id=i.turn_id',
        )
      ).rows[0];
      const turnId = inbound.turn_id as string;
      const threadId = inbound.thread_id as string;
      const imageBytes = Buffer.from('masked image fixture');
      const fileBytes = Buffer.from('completed document fixture');
      const image = await storeArtifact(imageBytes, 'screenshot.png', 'image/png', threadId);
      const document = await storeArtifact(fileBytes, 'result.txt', 'text/plain', threadId);
      filePaths.push(join(artifactRoot, image.id), join(artifactRoot, document.id));
      const reply = await addReply(
        turnId,
        [{ ...image, url: 'https://attacker.invalid/ignored', name: 'spoof.png' }, document],
        `[Screenshot](${image.url})`,
      );
      await channels.drain();
      assert.deepEqual(
        sent.map(({ method }) => method),
        ['sendPhoto', 'sendDocument'],
      );
      assert.deepEqual(Buffer.from(sent[0].file), imageBytes);
      assert.deepEqual(Buffer.from(sent[1].file), fileBytes);
      assert.equal(sent[0].name, 'screenshot.png');
      assert.equal(sent[1].name, 'result.txt');
      assert.ok(
        sent.every(
          ({ chat, caption }) =>
            chat === '123456' &&
            !caption.includes('/api/artifacts') &&
            !caption.includes('localhost'),
        ),
      );
      assert.equal((await state(reply)).state, 'sent');
      await channels.drain();
      assert.equal(sent.length, 2);

      const voiceBytes = Buffer.from('synthetic Ogg voice fixture');
      const voice = await storeArtifact(voiceBytes, 'reply.ogg', 'audio/ogg', threadId);
      filePaths.push(join(artifactRoot, voice.id));
      const voiceReply = await addReply(turnId, [voice]);
      await channels.drain();
      assert.equal(sent.at(-1)!.method, 'sendVoice');
      assert.equal(sent.at(-1)!.name, 'reply.ogg');
      assert.deepEqual(Buffer.from(sent.at(-1)!.file), voiceBytes);
      assert.equal((await state(voiceReply)).state, 'sent');
      assert.deepEqual(
        (
          await pool.query('SELECT provider_message_ids FROM channel_outbox WHERE message_id=$1', [
            voiceReply,
          ])
        ).rows[0].provider_message_ids.at(-1),
        '123456:103',
      );

      const contactText =
        'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Contact\r\nTEL:+34600000000\r\nEND:VCARD';
      for (const [name, mimeType, text] of [
        ['contact.vcf', 'text/vcard', contactText],
        ['location.json', 'application/json', JSON.stringify({ latitude: 41.4, longitude: 2.17 })],
      ]) {
        const artifact = await storeArtifact(Buffer.from(text), name, mimeType, threadId);
        filePaths.push(join(artifactRoot, artifact.id));
        const reply = await addReply(turnId, [artifact]);
        await channels.drain();
        assert.equal((await state(reply)).state, 'sent');
      }
      assert.deepEqual(
        native.map((message) => message.method),
        ['sendContact', 'sendLocation'],
      );
      assert.equal(native[0].data.vcard, contactText);
      assert.equal(native[1].data.latitude, 41.4);
      for (const details of [
        { name: 'Synthetic park', address: 'Synthetic address' },
        { name: 'Synthetic park' },
        { address: 'Synthetic address' },
      ]) {
        const artifact = await storeArtifact(
          Buffer.from(JSON.stringify({ latitude: 41.4, longitude: 2.17, ...details })),
          'location.json',
          'application/json',
          threadId,
        );
        filePaths.push(join(artifactRoot, artifact.id));
        const reply = await addReply(turnId, [artifact]);
        await channels.drain();
        assert.equal((await state(reply)).state, 'sent');
        assert.equal(native.at(-1)!.method, 'sendVenue');
        assert.equal(native.at(-1)!.data.title, details.name || details.address);
        assert.equal(native.at(-1)!.data.address, details.address || details.name);
      }
      const grouped = await storeArtifact(
        Buffer.from(`${contactText}\r\n${contactText}`),
        'group.vcf',
        'text/vcard',
        threadId,
      );
      filePaths.push(join(artifactRoot, grouped.id));
      const groupedReply = await addReply(turnId, [grouped]);
      await channels.drain();
      assert.equal((await state(groupedReply)).state, 'sent');
      assert.equal(sent.at(-1)!.method, 'sendDocument');
      assert.equal(native.length, 5);
      const sizedContact = (size: number) => {
        const card = contactText.replace('END:VCARD', 'NOTE:\r\nEND:VCARD');
        return card.replace('NOTE:', `NOTE:${'a'.repeat(size - Buffer.byteLength(card))}`);
      };
      for (const [name, text, nativeExpected] of [
        [
          'line-endings.vcf',
          `${contactText.replaceAll('\r\n', '\n').replace('END:VCARD', '')}${'NOTE:a\n'.repeat(280)}END:VCARD`,
          false,
        ],
        ['location.json', sizedContact(2200), false],
        ['exact.vcf', sizedContact(2048), true],
        ['over.vcf', sizedContact(2049), false],
      ] as const) {
        const bytes = Buffer.from(text);
        const artifact = await storeArtifact(bytes, name, 'text/vcard', threadId);
        filePaths.push(join(artifactRoot, artifact.id));
        const beforeNative: number = native.length;
        const beforeFiles: number = sent.length;
        const reply = await addReply(turnId, [artifact]);
        await channels.drain();
        assert.equal((await state(reply)).state, 'sent');
        assert.equal(native.length, beforeNative + Number(nativeExpected));
        if (nativeExpected) {
          assert.equal(Buffer.byteLength(native.at(-1)!.data.vcard as string), 2048);
          assert.equal(sent.length, beforeFiles);
        } else {
          assert.equal(sent.length, beforeFiles + 1);
          assert.equal(sent.at(-1)!.method, 'sendDocument');
          assert.deepEqual(Buffer.from(sent.at(-1)!.file), bytes);
        }
      }
      failDocument = true;
      const captionedImage = await addReply(turnId, [image], '**Image result**');
      const beforeCaption = texts.length;
      await channels.drain();
      assert.ok(sent.at(-1)!.caption.trim());
      assert.equal(texts.length, beforeCaption);
      assert.equal((await state(captionedImage)).state, 'sent');
      const captionFailure = await addReply(turnId, [document], 'Document result');
      await channels.drain();
      assert.equal((await state(captionFailure)).state, 'uncertain');
      const captionAttempts = sent.length;
      await channels.drain();
      assert.equal(sent.length, captionAttempts);
      failRead = true;
      const readFailure = await addReply(turnId, [image], 'A caption with an unavailable file.');
      const beforeReadFailure = texts.length;
      await channels.drain();
      assert.equal(sent.length, captionAttempts);
      assert.ok(texts.length >= beforeReadFailure + 2);
      assert.equal((await state(readFailure)).state, 'sent');
      failRead = false;
      const partial = await addReply(turnId, [image, document]);
      await channels.drain();
      assert.equal((await state(partial)).state, 'sent');
      const partialCount = sent.length;
      await channels.drain();
      assert.equal(sent.length, partialCount);
      presentationFails = true;
      const noReceipt = await addReply(turnId, [document], '');
      const beforeNoReceipt = texts.length;
      await channels.drain();
      assert.deepEqual(await state(noReceipt), {
        state: 'uncertain',
        reason: 'send_not_confirmed',
      });
      assert.equal(texts.length, beforeNoReceipt);
      const unconfirmedAttempts = sent.length;
      await channels.drain();
      assert.equal(sent.length, unconfirmedAttempts);
      presentationFails = false;
      const noticeOnly = await addReply(turnId, [document], '');
      await channels.drain();
      assert.deepEqual(await state(noticeOnly), { state: 'sent', reason: null });
      assert.ok(
        (
          await pool.query('SELECT provider_message_id FROM channel_outbox WHERE message_id=$1', [
            noticeOnly,
          ])
        ).rows[0].provider_message_id,
      );
      const failedCount = sent.length;
      await channels.drain();
      assert.equal(sent.length, failedCount);
      failDocument = false;

      const anotherThread = randomUUID();
      await pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,now())', [
        anotherThread,
        ownerId,
      ]);
      await assert.rejects(readThreadArtifacts(anotherThread, [image.id]), /unavailable/);
      await pool.query("UPDATE artifacts SET owner_id='foreign-owner' WHERE id=$1", [image.id]);
      const foreign = await addReply(turnId, [image]);
      await channels.drain();
      assert.deepEqual(await state(foreign), { state: 'sent', reason: null });
      assert.equal(sent.length, failedCount);
      await pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [image.id, ownerId]);

      const outside = join(dataRoot, `media-fixture-${randomUUID()}`);
      filePaths.push(outside);
      await writeFile(outside, 'private host data');
      await pool.query('UPDATE artifacts SET storage_path=$2 WHERE id=$1', [image.id, outside]);
      await assert.rejects(readThreadArtifacts(threadId, [image.id]), /unavailable/);
      const imagePath = join(artifactRoot, image.id);
      await pool.query('UPDATE artifacts SET storage_path=$2 WHERE id=$1', [image.id, imagePath]);
      await rm(imagePath);
      await symlink(outside, imagePath);
      await assert.rejects((await readThreadArtifacts(threadId, [image.id]))[0].read());
      await rm(imagePath);
      await writeFile(imagePath, imageBytes);
      await pool.query('UPDATE artifacts SET size=$2 WHERE id=$1', [image.id, files.fileBytes + 1]);
      await assert.rejects(readThreadArtifacts(threadId, [image.id]), /unavailable/);
      await pool.query('UPDATE artifacts SET size=$2 WHERE id=$1', [image.id, imageBytes.length]);
      await assert.rejects(readThreadArtifacts(threadId, ['https://attacker.invalid/file']));
      const forged = await addReply(turnId, [{ url: 'http://localhost:4310/private' }]);
      await channels.drain();
      assert.equal((await state(forged)).state, 'sent');
      assert.doesNotMatch(texts.at(-1)!, /localhost/);
      assert.equal(sent.length, failedCount);
      const flight: Presentation = {
        version: 1,
        type: 'flights',
        title: 'Synthetic flight comparison',
        caption: 'Prices include one traveler.',
        asOf: '2026-10-24 10:00 UTC',
        sources: [{ label: 'Synthetic fare source', url: 'https://example.com/fares' }],
        options: [
          {
            id: 'connecting',
            label: 'Flexible fare',
            journeys: [
              {
                id: 'outbound',
                label: 'Outbound',
                duration: '19h 50m',
                segments: [
                  {
                    airline: 'Synthetic Air',
                    flightNumber: 'ND123',
                    operatedBy: 'Fixture Regional',
                    aircraft: 'Synthetic narrow-body',
                    cabin: 'Economy',
                    duration: '2h 50m',
                    departure: {
                      airport: 'LIS',
                      date: '2026-11-02',
                      time: '09:00',
                      timeZone: 'Europe/Lisbon',
                      terminal: '1',
                    },
                    arrival: {
                      airport: 'LHR',
                      date: '2026-11-02',
                      time: '11:50',
                      timeZone: 'Europe/London',
                      terminal: '2',
                    },
                    technicalStops: [],
                    connectionAfter: {
                      duration: '4h 10m',
                      airportChange: 'yes',
                      selfTransfer: 'yes',
                      details: 'Ground transfer not included; recheck baggage',
                    },
                  },
                  {
                    airline: 'Fixture Air',
                    flightNumber: 'ND456',
                    aircraft: 'Synthetic wide-body',
                    cabin: 'Premium economy',
                    departure: {
                      airport: 'LGW',
                      date: '2026-11-02',
                      time: '16:00',
                      timeZone: 'Europe/London',
                    },
                    arrival: {
                      airport: 'SIN',
                      date: '2026-11-03',
                      time: '12:50',
                      timeZone: 'Asia/Singapore',
                    },
                    technicalStops: [
                      {
                        airport: 'BKK',
                        duration: '45m',
                        details: 'Same flight; boarding instructions not supplied',
                      },
                    ],
                  },
                ],
              },
            ],
            price: 'EUR 124 return',
            baggage: 'One cabin bag',
            recommended: true,
            url: 'https://example.com/fares/connection',
          },
          {
            id: 'nonstop',
            label: 'Flexible fare',
            journeys: [
              {
                id: 'outbound',
                label: 'Outbound',
                duration: '13h 45m',
                segments: [
                  {
                    airline: 'Synthetic Air',
                    flightNumber: 'ND789',
                    aircraft: 'Synthetic long-range aircraft',
                    cabin: 'Business',
                    departure: {
                      airport: 'LIS',
                      date: '2026-11-04',
                      time: '10:00',
                      timeZone: 'Europe/Lisbon',
                    },
                    arrival: {
                      airport: 'SIN',
                      date: '2026-11-05',
                      time: '07:45',
                      timeZone: 'Asia/Singapore',
                    },
                    technicalStops: [],
                  },
                ],
              },
            ],
            price: 'EUR 219 return',
            baggage: 'Two checked bags',
            url: 'https://example.com/fares/nonstop',
          },
        ],
      };
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turnId]);
      const visualReply = await withTurnLock(turnId, (client) =>
        insertAssistantMessage(client, { threadId, turnId }, '', [], undefined, undefined, flight),
      );
      const beforeVisual = texts.length;
      presentationFails = true;
      try {
        await channels.drain();
      } finally {
        presentationFails = false;
      }
      assert.equal((await state(visualReply)).state, 'sent');
      const deliveredVisual = texts.slice(beforeVisual).join('\n\n');
      for (const detail of [
        'Prices include one traveler.',
        'LIS',
        'LHR',
        '09:00',
        '11:50',
        'ND123',
        '19h 50m',
        '2h 50m',
        '4h 10m',
        '1 connection',
        '1 technical stop',
        'LGW',
        'SIN',
        'ND456',
        'BKK',
        '45m',
        'Ground transfer not included',
        'recheck baggage',
        'Airport change: yes',
        'Self-transfer: yes',
        'Operated by Fixture Regional',
        'Terminal 1',
        'Terminal 2',
        'Synthetic narrow-body',
        'Synthetic wide-body',
        'Premium economy',
        '2026-11-02',
        '2026-11-03',
        '16:00',
        '12:50',
        'Europe/Lisbon',
        'Europe/London',
        'Asia/Singapore',
        'Same flight; boarding instructions not supplied',
        'EUR 124 return',
        'One cabin bag',
        '2026-10-24',
        'https://example.com/fares',
      ])
        assert.ok(deliveredVisual.includes(detail), detail);
      const alternatives = deliveredVisual.split(/\n\n(?=Flexible fare ·)/).slice(1);
      assert.equal(alternatives.length, 2);
      const distinctFacts = [
        [
          'ND123',
          'ND456',
          'BKK',
          'EUR 124 return',
          'One cabin bag',
          'Airport change: yes',
          'Ground transfer not included',
          'https://example.com/fares/connection',
        ],
        [
          'ND789',
          '13h 45m',
          'Business',
          'EUR 219 return',
          'Two checked bags',
          '2026-11-04',
          '2026-11-05',
          '10:00',
          '07:45',
          'https://example.com/fares/nonstop',
        ],
      ];
      for (const [index, alternative] of alternatives.entries()) {
        assert.ok(alternative.includes('Synthetic Air'));
        for (const fact of distinctFacts[index]!) assert.ok(alternative.includes(fact), fact);
        for (const fact of distinctFacts[1 - index]!) assert.ok(!alternative.includes(fact), fact);
      }
      assert.doesNotMatch(deliveredVisual, /artifactId|"version"|"options"|api\/artifacts/);
      assert.equal(
        (await pool.query('SELECT text FROM messages WHERE id=$1', [visualReply])).rows[0].text,
        '',
      );
      const map: Presentation = {
        version: 1,
        type: 'map',
        title: 'Synthetic workspaces',
        sources: [],
        places: [
          {
            id: 'harbour',
            name: 'Harbour workspace',
            latitude: -33.865,
            longitude: 151.209,
            url: 'https://example.com/harbour',
          },
          { id: 'annex', name: 'Island annex', latitude: 0, longitude: -179.98 },
        ],
      };
      const mapReply = await addReply(turnId, [], 'Compare these two workspaces.', map);
      const beforeMap = texts.length;
      await channels.drain();
      assert.equal((await state(mapReply)).state, 'sent');
      const deliveredMap = texts
        .slice(beforeMap)
        .join('\n')
        .replace(/\\([^\p{L}\p{N}\s])/gu, '$1');
      for (const place of map.places) {
        const line = deliveredMap.split('\n').find((line) => line.includes(place.name));
        assert.ok(line, place.name);
        const links = [...line.matchAll(/https:\/\/[^\s)>]+/g)].map(([url]) => new URL(url));
        const locations = links.filter((url) => url.hostname === 'www.openstreetmap.org');
        assert.equal(locations.length, 1);
        assert.equal(locations[0]!.searchParams.get('mlat'), String(place.latitude));
        assert.equal(locations[0]!.searchParams.get('mlon'), String(place.longitude));
        assert.equal(locations[0]!.hash, `#map=15/${place.latitude}/${place.longitude}`);
        assert.equal(links.length, place.url ? 2 : 1);
        if (place.url) assert.ok(links.some((url) => url.href === place.url));
      }
      const venue: Presentation = {
        version: 1,
        type: 'booking',
        title: 'Synthetic venue comparison',
        sources: [],
        name: 'Courtyard',
        status: 'option',
        facts: [{ label: 'Total', value: 'EUR 120' }],
        photos: [{ artifactId: image.id, alt: 'The courtyard entrance' }],
        notes: ['Step-free entry reported by the venue'],
        rating: {
          value: 4.2,
          scale: 5,
          count: 93,
          sourceLabel: 'Fixture reviews',
          url: 'https://example.com/reviews',
          summary: 'Visitors report a quiet courtyard.',
        },
        alternatives: [
          {
            name: 'Terrace',
            status: 'option',
            facts: [{ label: 'Total', value: 'EUR 140' }],
            notes: ['Outdoor tables only'],
            url: 'https://example.com/terrace',
          },
        ],
      };
      const venueReply = await addReply(
        turnId,
        [image],
        'Compare these two sourced venues.',
        venue,
      );
      const beforeVenue = sent.length;
      const beforeVenueText = texts.length;
      await channels.drain();
      assert.equal((await state(venueReply)).state, 'sent');
      assert.equal(sent.length, beforeVenue + 1);
      assert.deepEqual(Buffer.from(sent.at(-1)!.file), imageBytes);
      const deliveredVenue = [
        ...texts.slice(beforeVenueText),
        ...sent.slice(beforeVenue).map((message) => message.caption),
      ]
        .join('\n')
        .replace(/\\([^\p{L}\p{N}\s])/gu, '$1');
      for (const detail of [
        'Courtyard',
        'Terrace',
        'EUR 120',
        'EUR 140',
        '4.2/5',
        '93 reviews',
        'https://example.com/reviews',
        'Visitors report a quiet courtyard.',
        'Step-free entry',
        'Outdoor tables only',
        'The courtyard entrance',
        'https://example.com/terrace',
      ])
        assert.ok(deliveredVenue.includes(detail), detail);
      assert.doesNotMatch(deliveredVenue, /artifactId|"photos"|api\/artifacts/);
      const chart: Presentation = {
        version: 1,
        type: 'chart',
        chart: 'bar',
        title: 'Synthetic net',
        sources: [],
        unit: 'EUR',
        series: [
          {
            id: 'net',
            label: 'Net',
            points: [
              { label: 'January', value: -12.5 },
              { label: 'February', value: 0 },
            ],
          },
        ],
      };
      const chartReply = await withTurnLock(turnId, (client) =>
        insertAssistantMessage(client, { threadId, turnId }, '', [], undefined, undefined, chart),
      );
      presentationFails = true;
      try {
        await channels.drain();
      } finally {
        presentationFails = false;
      }
      assert.equal((await state(chartReply)).state, 'sent');
      assert.match(texts.at(-1)!, /January: -12.5 EUR; February: 0 EUR/);
      const storedChart = (
        await pool.query('SELECT text,presentation FROM messages WHERE id=$1', [chartReply])
      ).rows[0];
      assert.equal(storedChart.text, '');
      assert.deepEqual(storedChart.presentation, chart);
      const invalidVisual = await addReply(turnId, [], 'Plain fallback survives.', {
        ...flight,
        version: 2,
      });
      await channels.drain();
      assert.equal((await state(invalidVisual)).state, 'sent');
      assert.equal(texts.at(-1), 'Plain fallback survives.');
      const beforeAccountChange = sent.length;
      holdResolve = true;
      const changedAccount = await addReply(turnId, [image]);
      const pending = channels.drain();
      await resolveStarted;
      const fallback: string[] = [];
      const replacement = channels.replaceTransport({
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: '987',
            allowedSenderIds: ['123456'],
          },
        ],
        receive: async () => ({ status: 200, body: 'Accepted' }),
        post: async (input) => {
          assert.equal(input.attachments, undefined);
          fallback.push(input.text);
          return { id: 'fallback-fixture' };
        },
        close: async () => {},
      });
      releaseResolve();
      await Promise.all([pending, replacement]);
      assert.deepEqual(await state(changedAccount), {
        state: 'blocked',
        reason: 'channel_access_changed',
      });
      assert.equal(sent.length, beforeAccountChange);
      const localOnly = await addReply(turnId, [image], '');
      await channels.drain();
      assert.equal((await state(localOnly)).state, 'sent');
      assert.doesNotMatch(fallback[0], /api\/artifacts/);
    } finally {
      releaseResolve();
      await app.close();
      await Promise.all(filePaths.map((path) => rm(path, { force: true })));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'live work keeps task status through tool calls and clears finished or stopped work without exposing another owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { createActivity } = await import('../src/server/activity.ts');
    const { pool, threadId, receive, turnOf, reply, create } = await outboxFixture(t);
    await pool.query(`CREATE TABLE tasks(id uuid,owner_id text,session_id uuid,title text,now_text text,message_id uuid,created_at timestamptz);
      CREATE TABLE turn_events(id uuid DEFAULT gen_random_uuid(),turn_id uuid,type text,summary text,site text,call_id uuid,created_at timestamptz DEFAULT clock_timestamp());`);
    const channels = await create();
    const activity = createActivity({ pool, ownerId: 'local-development' });
    const emit = (turnId: string, type: string, summary = '') =>
      pool.query('INSERT INTO turn_events(turn_id,type,summary) VALUES($1,$2,$3)', [
        turnId,
        type,
        summary,
      ]);
    try {
      receive('111', 'live-work', 'chat-live');
      await channels.drain();
      const { turn_id: turnId } = await turnOf('live-work');
      const foreignThread = randomUUID();
      const foreignTurn = randomUUID();
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [foreignThread, 'other']);
      await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
        foreignTurn,
        'other',
        foreignThread,
      ]);
      await emit(foreignTurn, 'step', 'Private work from another owner');
      await emit(turnId, 'step', 'Finding flights back from Copenhagen');
      await emit(turnId, 'tool_start', 'web search');
      assert.deepEqual(
        (await activity.read()).map(({ turnId, step }) => ({ turnId, step })),
        [{ turnId, step: 'Finding flights back from Copenhagen' }],
      );
      await emit(turnId, 'step', 'Comparing flight prices');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      const milestoneId = randomUUID();
      await reply(turnId, 'Two direct flights meet your budget.', milestoneId, 0);
      assert.equal((await activity.read())[0]?.messageId, milestoneId);
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await emit(turnId, 'tool_start', 'fetch content');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await emit(turnId, 'tool_complete', 'fetch content');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await emit(turnId, 'tool_start', 'synthetic unknown tool with private input');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await emit(turnId, 'tool_failed', 'synthetic unknown tool with private input');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await emit(turnId, 'final');
      assert.deepEqual(await activity.read(), []);
      await emit(turnId, 'tool_start', 'apps');
      assert.equal((await activity.read())[0]?.step, 'Comparing flight prices');
      await pool.query("UPDATE turns SET status='waiting' WHERE id=$1", [turnId]);
      assert.deepEqual(await activity.read(), []);
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turnId]);
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      assert.deepEqual(await activity.read(), []);
      await pool.query('UPDATE threads SET archived_at=NULL WHERE id=$1', [threadId]);
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turnId]);
      assert.deepEqual(await activity.read(), []);
    } finally {
      activity.close();
      await channels.close();
    }
  },
);
