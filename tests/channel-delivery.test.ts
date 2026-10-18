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
    const contested = { ...account, accountId: '67890' };
    const claims = await Promise.all([
      registry.claimWithLease({ ...contested, ownerId: first.ownerId }, first),
      registry.claimWithLease({ ...contested, ownerId: second.ownerId }, second),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const granted = await admin.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.table_privileges
       WHERE table_schema=$1 AND table_name='channel_accounts' AND grantee='PUBLIC'`,
      [schema],
    );
    assert.equal(granted.rows[0].count, '0');
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
  return { pool, threadId, posts, receive, turnOf, reply, create, transport };
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
      assert.equal((await settings.environment()).TELEGRAM_ALLOWED_USER_ID, '');
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM messages')).rowCount, 0);
      assert.equal(sent.length, 0);
      await pool.query('DROP TRIGGER fail_pairing_notice ON channel_outbox');

      const confirmed = await confirm();
      assert.equal(confirmed.statusCode, 200);
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
    let presentationFails = false;
    const channels = await createChannels(pool, {
      ownerId,
      appOrigin: 'https://otto.example',
      transport: createChatSdkTransport(pool, telegramEnvironment),
      present: async (_threadId, input) => {
        if (input.kind === 'delivery' && input.attachments === 'pending')
          return 'O ficheiro está disponível no Otto.';
        if (presentationFails) throw new Error('Fixture presentation failure');
        return 'Ficheiro disponível na aplicação.';
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

      failDocument = true;
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
