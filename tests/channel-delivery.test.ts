import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import type { ChannelAccountRegistry } from '../src/ports/channel-settings.ts';
import type { InboundMessage, MessagingTransport } from '../src/ports/messaging.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import { createChannelAccountRegistry } from '../src/server/channel-account-registry.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createChannels } from '../src/server/channels.ts';
import type { TenantLease } from '../src/server/tenants.ts';
import { registerAnalyticsRoutes, type AnalyticsEvent } from '../src/server/analytics.ts';

const token = '987:fixture-never-live';

async function leaseFixture(t: TestContext) {
  const schema = `test_channel_lease_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `channel-lease-${randomUUID()}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    application_name: applicationName,
    max: 5,
  });
  const blockers: pg.PoolClient[] = [];
  t.after(async () => {
    for (const blocker of blockers) {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.tenants (
    environment text NOT NULL, owner_id uuid NOT NULL,
    lease_holder uuid, lease_generation bigint NOT NULL, lease_expires timestamptz,
    PRIMARY KEY (environment,owner_id)
  )`);
  const registry = createChannelAccountRegistry({
    admin,
    controlSchema: schema,
    environment: 'development',
  });
  await registry.initialize();
  async function createLease(): Promise<TenantLease> {
    const lease = {
      ownerId: randomUUID(),
      environment: 'development',
      holderId: randomUUID(),
      generation: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await admin.query(`INSERT INTO ${schema}.tenants VALUES ($1,$2,$3,$4,$5)`, [
      lease.environment,
      lease.ownerId,
      lease.holderId,
      lease.generation,
      lease.expiresAt,
    ]);
    return lease;
  }
  async function waitForLock() {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
         WHERE application_name=$1 AND wait_event_type='Lock' AND pid<>pg_backend_pid()) AS waiting`,
        [applicationName],
      );
      if (result.rows[0].waiting) return;
      await sleep(5);
    }
    assert.fail('The channel mutation did not wait for the tenant lock.');
  }
  async function connectBlocker() {
    const client = await admin.connect();
    blockers.push(client);
    return client;
  }
  return { admin, schema, registry, createLease, waitForLock, connectBlocker };
}

test(
  'leased channel ownership uses the active SQL lease and preserves another owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { admin, schema, registry, createLease } = await leaseFixture(t);
    const first = await createLease();
    const second = await createLease();
    const account = { provider: 'telegram' as const, accountId: '12345', revision: '1' };
    const identity = { ...account, ownerId: first.ownerId };
    assert.equal(
      await registry.claimWithLease(identity, { ...first, expiresAt: new Date(0).toISOString() }),
      true,
    );
    assert.equal(await registry.claimWithLease(identity, first), true);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    await registry.releaseWithLease({ ...account, ownerId: second.ownerId }, second);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    for (const change of [
      { holderId: randomUUID() },
      { generation: '2' },
      { ownerId: randomUUID() },
    ]) {
      const candidate = { ...first, ...change };
      await assert.rejects(
        registry.claimWithLease({ ...identity, ownerId: candidate.ownerId }, candidate),
        { code: 'invalid_lease' },
      );
      await assert.rejects(
        registry.releaseWithLease({ ...identity, ownerId: candidate.ownerId }, candidate),
        { code: 'invalid_lease' },
      );
    }
    await admin.query(
      `UPDATE ${schema}.tenants SET lease_expires=clock_timestamp()-interval '1 second' WHERE owner_id=$1`,
      [first.ownerId],
    );
    await assert.rejects(registry.releaseWithLease(identity, first), { code: 'invalid_lease' });
    await assert.rejects(registry.claimWithLease({ ...identity, accountId: 'another' }, first), {
      code: 'invalid_lease',
    });
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId }, second),
      false,
    );
    await admin.query(
      `UPDATE ${schema}.tenants SET lease_expires=clock_timestamp()+interval '60 seconds' WHERE owner_id=$1`,
      [first.ownerId],
    );
    await registry.releaseWithLease(identity, first);
    assert.equal(
      await registry.claimWithLease({ ...account, ownerId: second.ownerId, revision: '2' }, second),
      true,
    );
  },
);

test(
  'channel mutations recheck generation after waiting for the tenant row lock',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { admin, schema, registry, createLease, waitForLock, connectBlocker } =
      await leaseFixture(t);
    const lease = await createLease();
    const identity = {
      ownerId: lease.ownerId,
      provider: 'telegram' as const,
      accountId: '12345',
      revision: '1',
    };
    await registry.claimWithLease(identity, lease);
    const blocker = await connectBlocker();
    await blocker.query('BEGIN');
    await blocker.query(
      `UPDATE ${schema}.tenants SET lease_generation=2,lease_holder=$2 WHERE owner_id=$1`,
      [lease.ownerId, randomUUID()],
    );
    const claim = assert.rejects(
      registry.claimWithLease({ ...identity, accountId: 'stale-claim' }, lease),
      { code: 'invalid_lease', statusCode: 401 },
    );
    const release = assert.rejects(registry.releaseWithLease(identity, lease), {
      code: 'invalid_lease',
      statusCode: 401,
    });
    await waitForLock();
    await blocker.query('COMMIT');
    await Promise.all([claim, release]);
    const rows = await admin.query<{ account_id: string; owner_id: string }>(
      `SELECT account_id,owner_id FROM ${schema}.channel_accounts`,
    );
    assert.deepEqual(rows.rows, [{ account_id: identity.accountId, owner_id: lease.ownerId }]);
  },
);

test(
  'channel account claims are atomic, persistent and released only by their owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const controlSchema = `test_channel_owners_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    t.after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS ${controlSchema} CASCADE`);
      await admin.end();
    });
    await admin.query(`CREATE SCHEMA ${controlSchema}`);
    const options = { admin, controlSchema, environment: 'development' };
    const registry = createChannelAccountRegistry(options);
    await Promise.all([registry.initialize(), registry.initialize()]);
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const account = { provider: 'telegram' as const, accountId: '123456', revision: '1' };
    const result = await Promise.all([
      registry.claim({ ...account, ownerId: ownerA }),
      registry.claim({ ...account, ownerId: ownerB }),
    ]);
    assert.equal(result.filter(Boolean).length, 1);
    const winner = result[0] ? ownerA : ownerB;
    const loser = result[0] ? ownerB : ownerA;
    assert.equal(await registry.claim({ ...account, ownerId: winner.toUpperCase() }), true);
    await registry.release({ ...account, ownerId: loser });
    assert.equal(await registry.claim({ ...account, ownerId: loser }), false);
    const restarted = createChannelAccountRegistry(options);
    assert.equal(await restarted.claim({ ...account, ownerId: winner }), true);
    assert.equal(await restarted.claim({ ...account, ownerId: loser }), false);
    assert.equal(await registry.claim({ ...account, ownerId: loser, provider: 'whatsapp' }), true);
    const production = createChannelAccountRegistry({ ...options, environment: 'production' });
    assert.equal(await production.claim({ ...account, ownerId: loser }), true);
    await production.release({ ...account, ownerId: loser });
    assert.equal(await registry.claim({ ...account, ownerId: loser }), false);
    await restarted.release({ ...account, ownerId: winner });
    assert.equal(await registry.claim({ ...account, ownerId: loser, revision: '2' }), true);
    await restarted.release({ ...account, ownerId: winner });
    assert.equal(await registry.claim({ ...account, ownerId: winner }), false);
    const granted = await admin.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.table_privileges
       WHERE table_schema=$1 AND table_name='channel_accounts' AND grantee='PUBLIC'`,
      [controlSchema],
    );
    assert.equal(granted.rows[0].count, '0');
  },
);

async function hostedDatabase() {
  const schema = 'test_hosted_integrations_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'hosted Telegram setup reserves one bot owner, uses fixed tenant webhook paths and binds ciphertext to its owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await hostedDatabase();
    const key = randomBytes(32);
    const claims = new Map<string, string>();
    const registrations: string[] = [];
    const registry: ChannelAccountRegistry = {
      async claim(input) {
        const owner = claims.get(input.accountId);
        if (owner && owner !== input.ownerId) return false;
        claims.set(input.accountId, input.ownerId);
        return true;
      },
      async release(input) {
        if (claims.get(input.accountId) === input.ownerId) claims.delete(input.accountId);
      },
    };
    const apps = [Fastify(), Fastify()];
    const settings = [];
    try {
      for (const [index, ownerId] of ['owner-one', 'owner-two'].entries()) {
        const webhookUrl =
          'https://otto.example/api/webhooks/telegram/' + String(index + 1).repeat(43);
        const verifier = createChatSdkSetupVerifier({
          webhookUrl: () => webhookUrl,
          fetch: async (url, options) => {
            const value = String(url);
            if (value.endsWith('/getMe'))
              return Response.json({
                ok: true,
                result: {
                  id: Number(value.match(/bot(\d+):/)![1]),
                  is_bot: true,
                  first_name: 'Synthetic bot',
                  username: 'synthetic_bot',
                },
              });
            if (value.endsWith('/getWebhookInfo'))
              return Response.json({ ok: true, result: { url: '' } });
            assert.ok(value.endsWith('/setWebhook'));
            const input = JSON.parse(String(options?.body));
            assert.equal(input.url, webhookUrl);
            assert.equal(input.drop_pending_updates, false);
            registrations.push(input.url);
            return Response.json({ ok: true, result: true });
          },
        });
        const service = await createChannelSettings(db.pool, {
          ownerId,
          accounts: registry,
          keyStore: { id: 'fixture', configured: true, getKey: async () => key },
          verifier,
          apply: async () => {},
        });
        service.registerRoutes(apps[index]);
        settings.push(service);
      }
      const save = (index: number, token: string, extra = {}) =>
        apps[index].inject({
          method: 'PUT',
          url: '/api/channel-settings/telegram',
          payload: { botToken: token, ...extra },
        });
      assert.equal(
        (
          await save(0, '987:synthetic_token', {
            webhookUrl: 'https://foreign.example/api/webhooks/telegram',
          })
        ).statusCode,
        400,
      );
      assert.equal(registrations.length, 0);
      assert.equal((await save(0, '987:synthetic_token')).statusCode, 200);
      assert.equal((await save(1, '987:synthetic_token')).statusCode, 400);
      assert.equal(registrations.length, 1);
      assert.equal(claims.get('987'), 'owner-one');
      assert.equal((await settings[1].status()).channels.length, 0);
      assert.equal((await save(1, '988:synthetic_token')).statusCode, 200);
      await db.pool.query(
        "UPDATE channel_settings SET ciphertext=(SELECT ciphertext FROM channel_settings WHERE owner_id='owner-one' AND provider='telegram') WHERE owner_id='owner-two' AND provider='telegram'",
      );
      await assert.rejects(settings[1].environment());
      await apps[0].inject({ method: 'DELETE', url: '/api/channel-settings/telegram' });
      assert.equal(claims.has('987'), false);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    }
  },
);

test(
  'Telegram setup extracts one pasted token without leaking prose or changing saved setup on invalid input',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await hostedDatabase();
    const app = Fastify();
    const key = randomBytes(32);
    const requests: string[] = [];
    let botId = 987;
    const settings = await createChannelSettings(db.pool, {
      ownerId: 'fixture-owner',
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      verifier: createChatSdkSetupVerifier({
        fetch: async (url) => {
          requests.push(String(url));
          if (url === `https://api.telegram.org/bot${token}/getMe`)
            return Response.json({
              ok: true,
              result: {
                id: botId,
                is_bot: true,
                first_name: 'Fixture bot',
                username: 'fixture_bot',
              },
            });
          assert.equal(url, `https://api.telegram.org/bot${token}/getWebhookInfo`);
          return Response.json({ ok: true, result: { url: '' } });
        },
      }),
      apply: async () => {},
    });
    settings.registerRoutes(app);
    const save = (botToken: string) =>
      app.inject({ method: 'PUT', url: '/api/channel-settings/telegram', payload: { botToken } });
    try {
      for (const [index, input] of [
        token,
        `Done! Your synthetic bot is ready.\nUse this token to access the HTTP API:\n${token}\nKeep it secure.`,
        `O teu bot está pronto.\nToken: (${token}).\nGuarda-o em segurança.`,
      ].entries()) {
        const saved = await save(input);
        assert.equal(saved.statusCode, 200, `input ${index}`);
        assert.equal((await settings.environment()).TELEGRAM_BOT_TOKEN, token);
        assert.equal(saved.body.includes(token), false);
        assert.equal(saved.body.includes(input), false);
        const raw = await db.pool.query('SELECT * FROM channel_settings');
        assert.equal(JSON.stringify(raw.rows).includes(token), false);
        assert.equal(JSON.stringify(raw.rows).includes('Your synthetic bot'), false);
      }
      const original = await settings.environment();
      for (const input of [
        'No token in this message.',
        `${token}\n988:another-fixture-token`,
        `987:`,
        `${'x'.repeat(8192)}\n${token}`,
      ]) {
        const before = requests.length;
        const rejected = await save(input);
        assert.equal(rejected.statusCode, 400);
        assert.equal(requests.length, before);
        assert.equal(rejected.body.includes(input), false);
        assert.deepEqual(await settings.environment(), original);
      }
      botId = 988;
      assert.equal((await save(`Synthetic bot: ${token}`)).statusCode, 400);
      assert.deepEqual(await settings.environment(), original);
      const status = await app.inject('/api/channel-settings');
      assert.equal(status.body.includes(token), false);
    } finally {
      await app.close();
      await db.close();
    }
  },
);

test(
  'durable channel revisions fence registry operations that finish after their client timed out',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const db = await hostedDatabase();
    const registry = createChannelAccountRegistry({
      admin: db.pool,
      controlSchema: db.schema,
      environment: 'development',
    });
    try {
      await registry.initialize();
      for (const [index, scenario] of ['claim', 'release'].entries()) {
        await t.test(scenario, async () => {
          const ownerId = randomUUID();
          const accountId = String(1000 + index);
          const key = randomBytes(32);
          let delay = false;
          let finish: (() => Promise<unknown>) | undefined;
          const accounts: ChannelAccountRegistry = {
            async claim(input) {
              if (delay && scenario === 'claim') {
                finish = () => registry.claim(input);
                throw new Error('Synthetic claim response timeout');
              }
              return registry.claim(input);
            },
            async release(input) {
              if (delay && scenario === 'release') {
                finish = () => registry.release(input);
                throw new Error('Synthetic release response timeout');
              }
              return registry.release(input);
            },
          };
          const options = {
            ownerId,
            accounts,
            keyStore: { id: 'fixture', configured: true, getKey: async () => key },
            verifier: {
              async verify(provider: 'telegram' | 'whatsapp') {
                return {
                  environment: {
                    TELEGRAM_ENABLED: 'true',
                    TELEGRAM_BOT_TOKEN: `${accountId}:synthetic-never-live`,
                    TELEGRAM_MODE: 'polling',
                  },
                  summary: {
                    provider,
                    enabled: true,
                    mode: 'polling' as const,
                    accountHandle: '@synthetic_bot',
                  },
                };
              },
            },
            apply: async () => {},
          };
          const app = Fastify();
          const settings = await createChannelSettings(db.pool, options);
          settings.registerRoutes(app);
          const save = () =>
            app.inject({ method: 'PUT', url: '/api/channel-settings/telegram', payload: {} });
          try {
            if (scenario === 'claim') {
              delay = true;
              assert.equal((await save()).statusCode, 503);
              assert.equal(await settings.recover(), true);
              assert.equal(
                (
                  await db.pool.query('SELECT 1 FROM channel_accounts WHERE account_id=$1', [
                    accountId,
                  ])
                ).rowCount,
                0,
              );
            } else {
              assert.equal((await save()).statusCode, 200);
              delay = true;
              assert.equal(
                (await app.inject({ method: 'DELETE', url: '/api/channel-settings/telegram' }))
                  .statusCode,
                200,
              );
            }
            assert.ok(finish);
            delay = false;
            assert.equal((await save()).statusCode, 200);
            const before = (
              await db.pool.query(
                'SELECT owner_id,revision::text FROM channel_accounts WHERE account_id=$1',
                [accountId],
              )
            ).rows;
            assert.equal(before[0].owner_id, ownerId);
            assert.ok(BigInt(before[0].revision) > 1n);
            const result = await finish();
            if (scenario === 'claim') assert.equal(result, false);
            assert.deepEqual(
              (
                await db.pool.query(
                  'SELECT owner_id,revision::text FROM channel_accounts WHERE account_id=$1',
                  [accountId],
                )
              ).rows,
              before,
            );
            const restarted = await createChannelSettings(db.pool, options);
            assert.equal(await restarted.recover(), true);
            assert.equal((await restarted.status()).channels[0].enabled, true);
            assert.equal(
              await registry.claim({
                ownerId: randomUUID(),
                provider: 'telegram',
                accountId,
                revision: '1',
              }),
              false,
            );
          } finally {
            await app.close();
          }
        });
      }
    } finally {
      await db.close();
    }
  },
);

async function createFixtureTables(pool: pg.Pool, owner: string) {
  await pool.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,delivered_channel text,created_at timestamptz NOT NULL DEFAULT now())`);
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
    const captured: AnalyticsEvent[] = [];
    const changed: AnalyticsEvent = {
      event: 'otto_settings_updated',
      properties: { section: 'channels', operation: 'update' },
    };
    registerAnalyticsRoutes(app, (event) => captured.push(event));
    let applied: Record<string, string> = {};
    let failApply = false;
    let loseRegistrationResponse = false;
    let pairingDuringRegistration: string | undefined;
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
          if (pairingDuringRegistration) {
            assert.equal(
              await settings.pair({
                channelId: 'telegram',
                accountId: '987',
                senderId: '123',
                senderName: '@fixture_owner',
                messageId: 'fixture-queued-start',
                threadId: 'telegram:123',
                code: pairingDuringRegistration,
                sentAt: new Date(),
              }),
              true,
            );
            pairingDuringRegistration = undefined;
          }
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
      const retry = () =>
        app.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/pairing',
          payload: {},
        });
      const beforeRetry = captured.length;
      assert.equal((await retry()).statusCode, 503);
      assert.deepEqual(await settings.environment(), pending);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/channel-settings/telegram/user',
            payload: { allowedUserId: '123' },
          })
        ).statusCode,
        503,
      );
      assert.deepEqual(await settings.environment(), pending);
      assert.equal(captured.length, beforeRetry);
      failApply = false;
      const retried = await retry();
      assert.equal(retried.statusCode, 200);
      assert.deepEqual(captured.slice(beforeRetry), [changed]);
      assert.match(retried.json().pairingUrl, /^https:\/\/t\.me\/fixture_bot\?start=[\w-]{32}$/);
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
      await pool.query(
        `UPDATE channel_settings SET summary=jsonb_set(summary,'{webhookStatus}','"registration_pending"') WHERE provider='telegram'`,
      );
      pairingDuringRegistration = new URL(resumed.json().pairingUrl).searchParams.get('start')!;
      const pairedDuringRetry = await retry();
      assert.equal(pairedDuringRetry.statusCode, 200);
      assert.equal(pairedDuringRetry.json().pairingUrl, undefined);
      assert.deepEqual(pairedDuringRetry.json().channel.pairingCandidate, {
        id: '123',
        name: '@fixture_owner',
      });
      assert.equal(pairedDuringRetry.json().channel.webhookStatus, 'registered');
      const beforeConfirm = captured.length;
      const confirmed = await app.inject({
        method: 'POST',
        url: '/api/channel-settings/telegram/confirm',
        payload: {},
      });
      assert.equal(confirmed.statusCode, 200);
      assert.equal(confirmed.json().channel.allowedUserId, '123');
      assert.deepEqual(captured.slice(beforeConfirm), [changed]);
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
      assert.equal((await save(false)).statusCode, 200);
      const beforeManualPairing = captured.length;
      const manualPairing = (allowedUserId: string) =>
        app.inject({
          method: 'POST',
          url: '/api/channel-settings/telegram/user',
          payload: { allowedUserId },
        });
      assert.equal((await manualPairing('invalid-user')).statusCode, 400);
      assert.equal(captured.length, beforeManualPairing);
      assert.equal((await manualPairing('123')).statusCode, 200);
      assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '123');
      assert.deepEqual(captured.slice(beforeManualPairing), [changed]);
      assert.equal((await manualPairing('456')).statusCode, 400);
      assert.deepEqual(captured.slice(beforeManualPairing), [changed]);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Telegram setup retry serializes incoming Start messages with pairing link rotation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 10000 },
  async (t) => {
    for (const first of ['start', 'retry'] as const)
      await t.test(`${first} starts first`, async (t) => {
        const db = await hostedDatabase();
        const app = Fastify();
        const key = randomBytes(32);
        const ownerId = `fixture-${first}`;
        let releaseRead: () => void = () => {};
        const resumeRead = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        let readPaused: () => void = () => {};
        const pausedRead = new Promise<void>((resolve) => {
          readPaused = resolve;
        });
        let activated: () => void = () => {};
        let readsBeforePause: number | undefined;
        const query = db.pool.query.bind(db.pool);
        t.mock.method(db.pool, 'query', async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql.startsWith('UPDATE channel_settings SET summary=jsonb_set')) activated();
          if (
            readsBeforePause !== undefined &&
            sql ===
              "SELECT * FROM channel_settings WHERE owner_id=$1 AND provider='telegram' AND enabled=true" &&
            readsBeforePause-- === 0
          ) {
            readsBeforePause = undefined;
            readPaused();
            await resumeRead;
          }
          return result;
        });
        const settings = await createChannelSettings(db.pool, {
          ownerId,
          keyStore: { id: 'fixture', configured: true, getKey: async () => key },
          verifier: createChatSdkSetupVerifier({
            fetch: async (url) => {
              if (String(url).endsWith('/getMe'))
                return Response.json({
                  ok: true,
                  result: {
                    id: 987,
                    is_bot: true,
                    first_name: 'Fixture bot',
                    username: 'fixture_bot',
                  },
                });
              if (String(url).endsWith('/getWebhookInfo'))
                return Response.json({ ok: true, result: { url: '' } });
              assert.ok(String(url).endsWith('/setWebhook'));
              return Response.json({ ok: true, result: true });
            },
          }),
          apply: async () => {},
        });
        settings.registerRoutes(app);
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
          await query(
            `UPDATE channel_settings SET summary=jsonb_set(summary,'{webhookStatus}','"registration_pending"') WHERE owner_id=$1 AND provider='telegram'`,
            [ownerId],
          );
          const activationFinished = new Promise<void>((resolve) => {
            activated = resolve;
          });
          const pair = (code: string) =>
            settings.pair({
              channelId: 'telegram',
              accountId: '987',
              senderId: '123',
              senderName: '@fixture_owner',
              messageId: 'fixture-concurrent-start',
              threadId: 'telegram:123',
              code,
              sentAt: new Date(),
            });
          const retry = () =>
            app
              .inject({
                method: 'POST',
                url: '/api/channel-settings/telegram/pairing',
                payload: {},
              })
              .then((response) => response);
          const code = new URL(saved.json().pairingUrl).searchParams.get('start')!;
          readsBeforePause = first === 'start' ? 0 : 1;
          let pairing: Promise<boolean>;
          let retrying: ReturnType<typeof retry>;
          if (first === 'start') {
            pairing = pair(code);
            await pausedRead;
            retrying = retry();
            await activationFinished;
          } else {
            retrying = retry();
            await pausedRead;
            pairing = pair(code);
          }
          const completedWhileBlocked = await Promise.race([
            (first === 'start' ? retrying : pairing).then(() => true),
            sleep(250).then(() => false),
          ]);
          releaseRead();
          const [accepted, retried] = await Promise.all([pairing, retrying]);
          assert.equal(completedWhileBlocked, false);
          assert.equal(retried.statusCode, 200);
          assert.equal(accepted, first === 'start');
          if (first === 'start') {
            assert.equal(retried.json().pairingUrl, undefined);
            assert.equal(retried.json().channel.pairingCandidate.id, '123');
          } else {
            const nextCode = new URL(retried.json().pairingUrl).searchParams.get('start')!;
            assert.notEqual(nextCode, code);
            assert.equal(await pair(nextCode), true);
          }
          const confirmed = await app.inject({
            method: 'POST',
            url: '/api/channel-settings/telegram/confirm',
            payload: {},
          });
          assert.equal(confirmed.statusCode, 200);
          assert.equal(confirmed.json().channel.allowedUserId, '123');
          assert.equal(confirmed.json().channel.webhookStatus, 'registered');
        } finally {
          releaseRead();
          await app.close();
          await db.close();
        }
      });
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
    const threadId = await createFixtureTables(pool, 'local-development');
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
      const turn = randomUUID();
      const message = randomUUID();
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,channel,status) VALUES($1,'local-development',$2,'telegram:fixture','succeeded')",
        [turn, threadId],
      );
      await pool.query(
        "INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,turn_id,state,owner_id,channel) VALUES('fixture','telegram','bot','123','telegram:123','Fixture',now(),$1,'submitted','local-development','telegram:fixture')",
        [turn],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments) VALUES($1,'local-development','assistant','Fixture reply',$2,$3,'[]')",
        [message, threadId, turn],
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

async function outboxFixture(t: TestContext, max?: number) {
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
        id: 'telegram',
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
      channelId: 'telegram',
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
        `channel:telegram:bot:${messageId}`,
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
  return { pool, admin, schema, threadId, posts, receive, turnOf, reply, create, transport };
}

test(
  'outbound discovery queues each reply once, sends in creation order and answers the conversation that asked',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const channels = await create();
    await pool.query(`CREATE TABLE outbox_attempts(message_id uuid);
      CREATE FUNCTION count_outbox_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO outbox_attempts VALUES(NEW.message_id); RETURN NEW; END $$;
      CREATE TRIGGER count_outbox_attempt BEFORE INSERT ON channel_outbox
        FOR EACH ROW EXECUTE FUNCTION count_outbox_attempt()`);
    try {
      receive('111', 'a1', 'chat-a1');
      receive('222', 'b1', 'chat-b1');
      receive('111', 'a2', 'chat-a2');
      await channels.drain();
      const [a1, b1, a2] = [await turnOf('a1'), await turnOf('b1'), await turnOf('a2')];
      assert.notEqual(a1.channel, b1.channel);
      assert.equal(a1.channel, a2.channel);
      const resume = randomUUID();
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,channel,channel_source_id) VALUES($1,'local-development',$2,'resume',$3,'channel:telegram:bot:a1')",
        [resume, threadId, a1.channel],
      );
      const background = randomUUID();
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,channel) VALUES($1,'local-development',$2,'schedule',$3)",
        [background, threadId, a1.channel],
      );
      await reply(a1.turn_id, 'first', 'ffffffff-0000-4000-8000-000000000001', 1);
      await reply(b1.turn_id, 'second', 'aaaaaaaa-0000-4000-8000-000000000002', 2);
      await reply(resume, 'third', '55555555-0000-4000-8000-000000000003', 3);
      await reply(a2.turn_id, 'fourth', '33333333-0000-4000-8000-000000000004', 4);
      await reply(background, 'fifth', '00000000-0000-4000-8000-000000000005', 5);
      await channels.drain();
      assert.deepEqual(posts, [
        { threadId: 'chat-a1', text: 'first' },
        { threadId: 'chat-b1', text: 'second' },
        { threadId: 'chat-a1', text: 'third' },
        { threadId: 'chat-a2', text: 'fourth' },
        { threadId: 'chat-a2', text: 'fifth' },
      ]);
      const attempts = (await pool.query('SELECT count(*)::int AS n FROM outbox_attempts')).rows[0]
        .n;
      assert.equal(attempts, 5);
      await channels.drain();
      await channels.drain();
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM outbox_attempts')).rows[0].n,
        attempts,
      );
      assert.equal(posts.length, 5);
    } finally {
      await channels.close();
    }
  },
);

test(
  'channel event presentation runs after its receipt commits with one database connection',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, posts, receive, create } = await outboxFixture(t, 1);
    let presentations = 0;
    let failPresentation = false;
    const channels = await create({
      present: async (_thread, input) => {
        await pool.query('SELECT 1');
        presentations++;
        if (input.kind === 'command') {
          assert.equal(input.attachments, 'none');
          assert.deepEqual(input.data, { count: 2 });
        }
        if (failPresentation) throw new Error('Synthetic presenter unavailable');
        return input.kind === 'paired' ? 'Ligação estabelecida.' : 'Usa a aplicação Otto.';
      },
      commandReply: async (command) => ({
        text: '',
        attachments: [],
        presentation: { kind: 'command', command, data: { count: 2 } },
      }),
      acceptVerification: async () => {
        throw Object.assign(new Error('Synthetic refused code'), { statusCode: 409 });
      },
    });
    const pair = async (messageId: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const notify = await channels.announcePairing(
          {
            senderId: '111',
            accountId: 'bot',
            messageId,
            threadId: 'chat-a1',
            sentAt: new Date().toISOString(),
          },
          client,
        );
        await client.query('COMMIT');
        return notify;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    try {
      const notify = await pair('pair-1');
      assert.equal(presentations, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM channel_inbox')).rows[0].n, 1);
      notify();
      await channels.drain();
      assert.equal(presentations, 1);
      assert.equal(posts.length, 1);
      assert.equal((await pool.query('SELECT text FROM messages')).rows[0].text, posts[0].text);
      (await pair('pair-1'))();
      await channels.drain();
      assert.equal(presentations, 1);
      assert.equal(posts.length, 1);
      failPresentation = true;
      (await pair('pair-2'))();
      await channels.drain();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM channel_inbox')).rows[0].n, 2);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM channel_outbox WHERE state='blocked' AND reason='presentation_unavailable'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(posts.length, 1);
      failPresentation = false;
      receive('111', 'refused-code', 'chat-a1', '111111');
      await channels.drain();
      assert.equal(posts.length, 2);
      receive('111', 'memory-command', 'chat-a1', '/memory');
      await channels.drain();
      assert.equal(posts.length, 3);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM turns')).rows[0].n, 0);
      assert.doesNotMatch(
        JSON.stringify((await pool.query('SELECT text FROM messages')).rows),
        /111111/,
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
      appOrigin: 'https://otto.example',
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
          : 'Continua na aplicação Otto.';
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
      assert.equal(posts.at(-1)!.text, 'Continua na aplicação Otto.');
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
  'reset during ordinary channel presentation blocks the obsolete reply',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    let startGeneration!: () => void;
    let releaseGeneration!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      startGeneration = resolve;
    });
    const generationReleased = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let generations = 0;
    const channels = await create({
      present: async () => {
        generations++;
        startGeneration();
        await generationReleased;
        return 'Continua na aplicação Otto.';
      },
    });
    try {
      receive('111', 'before-reset', 'chat-before-reset');
      await channels.drain();
      const messageId = randomUUID();
      await reply(
        (await turnOf('before-reset')).turn_id,
        '[Continua](/credentials/private-token)',
        messageId,
        0,
      );
      const draining = channels.drain();
      await generationStarted;
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      releaseGeneration();
      await draining;
      assert.deepEqual(posts, []);
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            messageId,
          ])
        ).rows[0],
        { state: 'blocked', reason: 'thread_changed' },
      );
      await channels.drain();
      assert.equal(generations, 1);
      assert.deepEqual(posts, []);
    } finally {
      releaseGeneration();
      await channels.close();
    }
  },
);

test(
  'interrupted send validation remains preparing and recovers without a provider attempt',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, admin, schema, posts, receive, turnOf, reply, create } = await outboxFixture(
      t,
      1,
    );
    let startValidation = () => {};
    let releaseValidation = () => {};
    const validationStarted = new Promise<void>((resolve) => {
      startValidation = resolve;
    });
    const validationReleased = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const original = await create();
    const instances = [original];
    let draining: Promise<void> | undefined;
    try {
      receive('111', 'validation', 'chat-validation');
      await original.drain();
      const messageId = randomUUID();
      await reply((await turnOf('validation')).turn_id, 'Prepared reply', messageId, 0);
      const client = await pool.connect();
      const query = client.query;
      let held = false;
      t.mock.method(client, 'query', (...args: unknown[]) => {
        if (
          held ||
          typeof args[0] !== 'string' ||
          !args[0].startsWith('SELECT 1 FROM messages m JOIN channel_outbox o')
        )
          return Reflect.apply(query, client, args);
        held = true;
        startValidation();
        const interrupted = validationReleased.then(() => {
          throw new Error('Synthetic interrupted validation');
        });
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          void interrupted.catch((cause) => callback(cause));
          return;
        }
        return interrupted;
      });
      client.release();
      const state = async () =>
        (
          await admin.query(
            `SELECT state,reason FROM ${schema}.channel_outbox WHERE message_id=$1`,
            [messageId],
          )
        ).rows[0];
      draining = original.drain();
      await validationStarted;
      assert.deepEqual(await state(), { state: 'preparing', reason: null });
      assert.deepEqual(posts, []);
      releaseValidation();
      await draining;
      assert.deepEqual(await state(), { state: 'preparing', reason: null });
      await original.close();
      const recovered = await create();
      instances.push(recovered);
      await recovered.drain();
      await recovered.drain();
      assert.deepEqual(await state(), { state: 'sent', reason: null });
      assert.deepEqual(posts, [{ threadId: 'chat-validation', text: 'Prepared reply' }]);
    } finally {
      releaseValidation();
      await draining;
      await Promise.all(instances.map((instance) => instance.close()));
    }
  },
);

test(
  'a send claim commits before a concurrent reset can archive its thread',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    const { pool, admin, schema, threadId, posts, receive, turnOf, reply, create } =
      await outboxFixture(t, 1);
    let startCommit = () => {};
    let releaseCommit = () => {};
    const commitStarted = new Promise<void>((resolve) => {
      startCommit = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const channels = await create();
    const resetter = await admin.connect();
    const resetPid = (await resetter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let draining: Promise<void> | undefined;
    let resetting: Promise<unknown> | undefined;
    try {
      receive('111', 'commit', 'chat-commit');
      await channels.drain();
      const messageId = randomUUID();
      await reply((await turnOf('commit')).turn_id, 'Prepared reply', messageId, 0);
      const client = await pool.connect();
      const query = client.query;
      let sending = false;
      t.mock.method(client, 'query', (...args: unknown[]) => {
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith("UPDATE channel_outbox o SET state='sending'")
        )
          sending = true;
        if (args[0] !== 'COMMIT' || !sending) return Reflect.apply(query, client, args);
        sending = false;
        startCommit();
        return commitReleased.then(() => Reflect.apply(query, client, args));
      });
      client.release();
      draining = channels.drain();
      await commitStarted;
      assert.deepEqual(posts, []);
      let resetComplete = false;
      resetting = resetter
        .query(`UPDATE ${schema}.threads SET archived_at=now() WHERE id=$1`, [threadId])
        .then(() => {
          resetComplete = true;
        });
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !resetComplete; attempt++) {
        waiting = (
          await admin.query(
            'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',
            [resetPid],
          )
        ).rows[0].waiting;
        if (waiting) break;
        await sleep(10);
      }
      assert.equal(resetComplete, false);
      assert.equal(waiting, true);
      releaseCommit();
      await Promise.all([draining, resetting]);
      assert.equal(resetComplete, true);
      assert.deepEqual(posts, [{ threadId: 'chat-commit', text: 'Prepared reply' }]);
      await channels.drain();
      assert.equal(posts.length, 1);
    } finally {
      releaseCommit();
      await Promise.all([draining, resetting]);
      resetter.release();
      await channels.close();
    }
  },
);

test(
  'restart delivers a persisted presentation without calling an unavailable model again',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async (t) => {
    for (const kind of ['verification_refused', 'command'] as const)
      await t.test(kind, async (t) => {
        const { pool, posts, receive, turnOf, reply, create, transport } = await outboxFixture(
          t,
          1,
        );
        const fileId = randomUUID();
        let generations = 0;
        const configured = {
          transport: {
            ...transport,
            channels: transport.channels.map((channel) => ({
              ...channel,
              supportsAttachments: true,
            })),
            post: async (input: Parameters<MessagingTransport['post']>[0]) => {
              assert.equal(input.attachments?.length ?? 0, kind === 'command' ? 1 : 0);
              return transport.post(input);
            },
          },
          resolveAttachments: async () => [
            {
              name: 'fixture.txt',
              mimeType: 'text/plain',
              size: 7,
              read: async () => Buffer.from('fixture'),
            },
          ],
          present: async () => {
            generations++;
            if (generations > 1) throw new Error('Synthetic unavailable model after restart');
            return 'Persisted model response';
          },
        };
        const original = await create(configured);
        const instances = [original];
        try {
          receive('111', 'prepared', 'chat-prepared');
          await original.drain();
          const messageId = randomUUID();
          await reply((await turnOf('prepared')).turn_id, '', messageId, 0);
          if (kind === 'command')
            await pool.query('UPDATE messages SET attachments=$2 WHERE id=$1', [
              messageId,
              JSON.stringify([{ id: fileId }]),
            ]);
          await pool.query(
            'INSERT INTO channel_outbox(message_id,source_id,presentation) VALUES($1,$2,$3)',
            [
              messageId,
              'channel:telegram:bot:prepared',
              JSON.stringify(kind === 'command' ? { kind, command: 'memory', data: {} } : { kind }),
            ],
          );
          const client = await pool.connect();
          const query = client.query;
          let interrupted = false;
          t.mock.method(client, 'query', (...args: unknown[]) => {
            if (
              !interrupted &&
              typeof args[0] === 'string' &&
              args[0].startsWith("UPDATE channel_outbox o SET state='sending'")
            ) {
              interrupted = true;
              throw new Error('Synthetic interruption after presentation commit');
            }
            return Reflect.apply(query, client, args);
          });
          client.release();
          await original.drain();
          assert.equal(interrupted, true);
          assert.deepEqual(posts, []);
          assert.equal(generations, 1);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT o.state,m.text FROM channel_outbox o JOIN messages m ON m.id=o.message_id WHERE m.id=$1',
                [messageId],
              )
            ).rows[0],
            { state: 'preparing', text: 'Persisted model response' },
          );
          await original.close();
          const recovered = await create(configured);
          instances.push(recovered);
          await recovered.drain();
          await recovered.drain();
          assert.deepEqual(posts, [
            { threadId: 'chat-prepared', text: 'Persisted model response' },
          ]);
          assert.equal(generations, 1);
          assert.equal(
            (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [messageId]))
              .rows[0].state,
            'sent',
          );
        } finally {
          await Promise.all(instances.map((instance) => instance.close()));
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

test(
  'Telegram task commands keep native reply targets, send receipts once and do not start a model turn',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
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
    } finally {
      await channels.close();
    }
  },
);

test(
  'native replies to every delivered part keep the task target and refuse a foreign conversation',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const targets: Array<string | undefined> = [];
    const channels = await create({
      submit: async (_text, sourceId, client, channel, _messageId, _answer, replyToMessageId) => {
        targets.push(replyToMessageId);
        const id = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
          [id, threadId, sourceId, channel],
        );
        return id;
      },
    });
    try {
      receive('111', 'initial', 'chat-a');
      await channels.drain();
      const anchor = randomUUID();
      await reply((await turnOf('initial')).turn_id, 'Task started', anchor, 0);
      await channels.drain();
      receive('111', 'file-reply', 'chat-a', undefined, 'provider-1-file');
      await channels.drain();
      assert.equal(targets.at(-1), anchor);
      const result = randomUUID();
      await reply((await turnOf('file-reply')).turn_id, 'Task result', result, 0);
      await pool.query('UPDATE messages SET reply_to_message_id=$1 WHERE id=$2', [anchor, result]);
      await channels.drain();
      assert.equal(posts.at(-1)!.replyToMessageId, 'provider-1');
      receive('222', 'foreign', 'chat-a', undefined, 'provider-1-file');
      await channels.drain();
      assert.equal(targets.at(-1), undefined);
      receive('111', 'wrong-chat', 'chat-b', undefined, 'provider-1-file');
      await channels.drain();
      assert.equal(targets.at(-1), undefined);
    } finally {
      await channels.close();
    }
  },
);

test(
  'replies go out between inbound messages so a busy inbox cannot hold them back',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { threadId, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const sentBefore: number[] = [];
    const channels = await create({
      submit: async (_text, sourceId, client, channel) => {
        sentBefore.push(posts.length);
        const turnId = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',$2,$3,$4)",
          [turnId, threadId, sourceId, channel],
        );
        return turnId;
      },
    });
    try {
      receive('111', 'a1', 'chat-a1');
      await channels.drain();
      await reply((await turnOf('a1')).turn_id, 'first reply', randomUUID(), 1);
      receive('222', 'b1', 'chat-b1');
      receive('111', 'a2', 'chat-a2');
      await channels.drain();
      assert.deepEqual(sentBefore, [0, 0, 1]);
      assert.deepEqual(posts, [{ threadId: 'chat-a1', text: 'first reply' }]);
    } finally {
      await channels.close();
    }
  },
);

test(
  'a failing inbound message does not stop replies and a committed one is announced to the web chat',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { pool, posts, receive, turnOf, reply, create } = await outboxFixture(t);
    const logs: string[] = [];
    t.mock.method(console, 'error', (line: string) => logs.push(line));
    let failSubmit = true;
    const states: Promise<string | undefined>[] = [];
    const channels = await create({
      refresh: () => {
        states.push(
          pool
            .query("SELECT state FROM channel_inbox WHERE source_id='channel:telegram:bot:b1'")
            .then((result) => result.rows[0]?.state),
        );
      },
      submit: async (_text, sourceId, client, channel) => {
        if (failSubmit) throw new Error('Synthetic submit failure');
        const turnId = randomUUID();
        await client.query(
          "INSERT INTO turns(id,owner_id,thread_id,source_id,channel) VALUES($1,'local-development',(SELECT id FROM threads),$2,$3)",
          [turnId, sourceId, channel],
        );
        return turnId;
      },
    });
    const app = Fastify();
    channels.registerRoutes(app);
    try {
      failSubmit = false;
      receive('111', 'a1', 'chat-a1');
      await channels.drain();
      failSubmit = true;
      receive('222', 'b1', 'chat-b1');
      await reply((await turnOf('a1')).turn_id, 'still delivered', randomUUID(), 1);
      await channels.drain();
      assert.deepEqual(posts, [{ threadId: 'chat-a1', text: 'still delivered' }]);
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM channel_inbox WHERE source_id='channel:telegram:bot:b1'",
          )
        ).rows[0].state,
        'pending',
      );
      assert.match((await app.inject('/api/channels')).json().error, /needs attention/);
      assert.deepEqual(
        logs.map((line) => JSON.parse(line)),
        [{ event: 'channel_drain_failed', name: 'Error' }],
      );
      assert.equal(logs.join('').includes('Synthetic'), false);
      failSubmit = false;
      states.length = 0;
      await channels.drain();
      assert.deepEqual(await Promise.all(states), ['submitted']);
      assert.equal((await app.inject('/api/channels')).json().error, null);
    } finally {
      await app.close();
    }
  },
);

for (const username of ['fixture_owner', undefined])
  test(
    `Telegram webhook setup preserves identity ${username ? 'with' : 'without'} a username and binds only the confirmed Start sender`,
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
        present: async (thread, input) => {
          assert.equal(thread, threadId);
          assert.deepEqual(input, { kind: 'paired', channel: 'telegram' });
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
      const deliver = async (from: number, text: string, username?: string) => {
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
              last_name: from === 123 ? 'Owner' : 'Stranger',
              ...(username && { username }),
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
        assert.equal((await telegram())?.pairingCandidate?.name, 'Fixture Stranger');
        assert.equal((await telegram())?.pairingCandidate?.username, 'fixture_stranger');
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
        await deliver(123, `/start ${code}`, username);
        assert.equal((await telegram())?.pairingCandidate, undefined);

        await deliver(123, `/start ${secondCode}`, username);
        await waitFor(async () => (await telegram())?.pairingCandidate?.id === '123');
        assert.deepEqual((await telegram())?.pairingCandidate, {
          id: '123',
          name: 'Fixture Owner',
          ...(username ? { username } : {}),
        });
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
        assert.equal(confirmed.json().channel.pairedUser, 'Fixture Owner');
        assert.equal(confirmed.json().channel.pairedUsername, username);
        assert.equal((await telegram())?.pairedUser, 'Fixture Owner');
        assert.equal((await telegram())?.pairedUsername, username);
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
        const notice = await pool.query(
          'SELECT m.text FROM messages m JOIN channel_outbox o ON o.message_id=m.id WHERE m.owner_id=$1',
          ['local-development'],
        );
        assert.equal(notice.rowCount, 1);
        assert.equal(
          sent[0].text ?? (sent[0].rich_message as { markdown: string }).markdown,
          notice.rows[0].text,
        );
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
    const { storeArtifact, readThreadArtifacts } = await import('../src/server/artifacts.ts');
    const files = await import('../src/shared/files.ts');
    const { ownerId, dataRoot } = await import('../src/server/config.ts');
    const { activeThread } = await import('../src/server/thread.ts');
    await initializeDatabase();
    const sent: Array<{
      method: string;
      file: Uint8Array;
      name: string;
      caption: string;
      chat: string;
    }> = [];
    const texts: string[] = [];
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
        if (/\/send(?:Rich)?Message$/.test(target)) {
          const body = JSON.parse(String(init?.body));
          texts.push(String(body.rich_message?.markdown ?? body.text));
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
        assert.match(
          target,
          /^https:\/\/api\.telegram\.org\/bot987:fixture-not-live\/send(?:Photo|Document|Video)$/,
        );
        assert.ok(init?.body instanceof FormData);
        const body = init.body;
        const media = body.get('photo') ?? body.get('document') ?? body.get('video');
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
    let markResolveStarted = () => {};
    let releaseResolve = () => {};
    const resolveStarted = new Promise<void>((resolve) => {
      markResolveStarted = resolve;
    });
    const resolveReleased = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const app = Fastify();
    const presentations: unknown[] = [];
    const attachmentNotice = 'Ficheiro disponível na aplicação.';
    const pendingNotice = 'O ficheiro está disponível no Otto.';
    let presentationOutcome = 'success';
    let markPresentationStarted = () => {};
    let releasePresentation = () => {};
    const presentationStarted = new Promise<void>((resolve) => {
      markPresentationStarted = resolve;
    });
    const presentationReleased = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const channels = await createChannels(pool, {
      ownerId,
      appOrigin: 'https://otto.example',
      transport: createChatSdkTransport(pool, telegramEnvironment),
      present: async (_threadId, input) => {
        presentations.push(input);
        if (input.kind === 'delivery' && input.attachments === 'pending') return pendingNotice;
        if (presentationOutcome === 'failure') throw new Error('Fixture presentation failure');
        if (presentationOutcome === 'hold') {
          markPresentationStarted();
          await presentationReleased;
        }
        return attachmentNotice;
      },
      resolveAttachments: async (threadId, ids) => {
        if (holdResolve) {
          markResolveStarted();
          await resolveReleased;
        }
        return readThreadArtifacts(threadId, ids);
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
    const addReply = async (turnId: string, attachments: unknown[], text = 'Here is the file.') => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments) VALUES($1,$2,'assistant',$3,(SELECT thread_id FROM turns WHERE id=$4),$4,$5)",
        [id, ownerId, text, turnId, JSON.stringify(attachments)],
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
      filePaths.push(
        join(dataRoot, 'artifacts', image.id),
        join(dataRoot, 'artifacts', document.id),
      );
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
      const repeated = await addReply(turnId, [image, image, document], '');
      await channels.drain();
      assert.equal((await state(repeated)).state, 'sent');
      assert.equal(sent.length, 4);
      assert.equal(sent[2].name, 'screenshot.png');
      assert.equal(sent[3].name, 'result.txt');
      assert.deepEqual(Buffer.from(sent[2].file), imageBytes);
      assert.deepEqual(Buffer.from(sent[3].file), fileBytes);
      assert.equal(sent[2].caption, '');
      assert.equal(sent[3].caption, '');
      const videoBytes = Buffer.from('mp4 video fixture');
      const video = await storeArtifact(videoBytes, 'clip.mp4', 'video/mp4', threadId);
      filePaths.push(join(dataRoot, 'artifacts', video.id));
      const clip = await addReply(turnId, [video], '');
      await channels.drain();
      assert.equal((await state(clip)).state, 'sent');
      assert.equal(sent.at(-1)!.method, 'sendVideo');
      assert.deepEqual(Buffer.from(sent.at(-1)!.file), videoBytes);

      failDocument = true;
      const partial = await addReply(turnId, [image, document]);
      await channels.drain();
      assert.equal((await state(partial)).state, 'sent');
      assert.deepEqual(texts.slice(-2), [pendingNotice, attachmentNotice]);
      assert.deepEqual(presentations.at(-1), {
        kind: 'delivery',
        text: '',
        attachments: 'in_otto',
        secureAction: false,
        files: ['result.txt'],
      });
      const partialCount = sent.length;
      await channels.drain();
      assert.equal(sent.length, partialCount);
      presentationOutcome = 'failure';
      const unavailableNotice = await addReply(turnId, [document], 'I attached the file.');
      const beforeNoticeFailure = texts.length;
      await channels.drain();
      assert.deepEqual(await state(unavailableNotice), { state: 'sent', reason: null });
      assert.deepEqual(texts.slice(beforeNoticeFailure), [pendingNotice]);
      assert.deepEqual(presentations.at(-2), {
        kind: 'delivery',
        text: 'I attached the file.',
        attachments: 'pending',
        secureAction: false,
      });
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
      presentationOutcome = 'success';
      const noticeOnly = await addReply(turnId, [document], '');
      await channels.drain();
      assert.deepEqual(await state(noticeOnly), { state: 'sent', reason: null });
      assert.deepEqual(texts.slice(beforeNoReceipt), [attachmentNotice]);
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
      assert.equal(texts.at(-1), attachmentNotice);
      assert.deepEqual(presentations.at(-1), {
        kind: 'delivery',
        text: 'Here is the file.',
        attachments: 'in_otto',
        secureAction: false,
      });
      assert.equal(sent.length, failedCount);
      await pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [image.id, ownerId]);

      const outside = join(dataRoot, `media-fixture-${randomUUID()}`);
      filePaths.push(outside);
      await writeFile(outside, 'private host data');
      await pool.query('UPDATE artifacts SET storage_path=$2 WHERE id=$1', [image.id, outside]);
      await assert.rejects(readThreadArtifacts(threadId, [image.id]), /unavailable/);
      const imagePath = join(dataRoot, 'artifacts', image.id);
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
      assert.equal(sent.length, failedCount);
      const localOnly = await addReply(turnId, [image], '');
      await channels.drain();
      assert.equal((await state(localOnly)).state, 'sent');
      assert.match(fallback[0], /https:\/\/otto\.example\/api\/artifacts\//);
      assert.match(fallback[0], /screenshot\.png/);
      assert.doesNotMatch(fallback[0], /Attachments are available in Otto/);

      await channels.replaceTransport(createChatSdkTransport(pool, telegramEnvironment));
      holdResolve = false;
      failDocument = true;
      presentationOutcome = 'hold';
      const staleNotice = await addReply(turnId, [document]);
      const beforeReset = texts.length;
      const pendingPresentation = channels.drain();
      await presentationStarted;
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      releasePresentation();
      await pendingPresentation;
      assert.deepEqual(texts.slice(beforeReset), [pendingNotice]);
      assert.deepEqual(await state(staleNotice), { state: 'sent', reason: null });
      const deliveredBeforeReset = sent.length;
      const generatedBeforeReset = presentations.length;
      await channels.drain();
      assert.equal(sent.length, deliveredBeforeReset);
      assert.equal(presentations.length, generatedBeforeReset);
    } finally {
      releaseResolve();
      releasePresentation();
      await app.close();
      await Promise.all(filePaths.map((path) => rm(path, { force: true })));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
