import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createIntegrations } from '../src/server/integrations.ts';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import { createChannelAccountRegistry } from '../src/server/channel-account-registry.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import type { IntegrationProvider } from '../src/ports/integrations.ts';
import type { ChannelAccountRegistry } from '../src/ports/channel-settings.ts';
import type { ChannelSetupVerifier } from '../src/ports/channel-settings.ts';

async function database() {
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
  'hosted app consent returns to its owned screen and tenant event workers cannot consume each other',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const db = await database();
    const apps = [Fastify(), Fastify()];
    const owners = ['owner-one', 'owner-two'];
    const callbacks = new Map<string, string>();
    const accounts = new Map<string, string>();
    const delivered = new Map<string, string[]>();
    let inspectCount = 0;
    const provider: IntegrationProvider = {
      id: 'fixture',
      configured: true,
      webhooksConfigured: true,
      supportsSubscriptions: ['gmail'],
      async createSession(owner) {
        return {
          id: 'session-' + owner,
          authorize: async (_service, callback) => {
            const accountId = randomUUID();
            accounts.set(accountId, owner);
            callbacks.set(owner, callback + '&account=' + accountId + '&success=true');
            return { accountId, url: 'https://provider.example/consent' };
          },
          execute: async () => ({}),
          search: async () => ({ tools: {}, suggestions: [] }),
        };
      },
      restoreSession: async () => {
        throw new Error();
      },
      deleteSession: async () => {},
      deleteAccount: async () => {},
      inspectAccount: async (id, owner) => {
        inspectCount++;
        assert.equal(accounts.get(id), owner);
        return { active: true, service: 'gmail' };
      },
      parseCallback: (input) => {
        const query = input as Record<string, string>;
        return { state: query.state, accountId: query.account, success: query.success === 'true' };
      },
      subscribe: async (_owner, _service, account) => ({ id: 'trigger-' + account }),
      unsubscribe: async () => {},
      verifyWebhook: async (body) => JSON.parse(String(body)),
      matchesSubscription: () => true,
    };
    const services = [];
    try {
      for (const [index, ownerId] of owners.entries()) {
        delivered.set(ownerId, []);
        const service = await createIntegrations(db.pool, {
          ownerId,
          provider,
          baseUrl: 'https://otto.example',
          wake: async (_text, id) => {
            delivered.get(ownerId)!.push(id);
          },
        });
        service.registerRoutes(apps[index]);
        services.push(service);
      }
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'https://foreign.example' },
          })
        ).statusCode,
        400,
      );
      assert.equal(callbacks.size, 0);
      assert.equal(
        (
          await apps[0].inject({
            method: 'POST',
            url: '/api/apps/gmail/connect',
            payload: { returnTo: 'onboarding' },
          })
        ).statusCode,
        200,
      );
      const callback = new URL(callbacks.get(owners[0])!);
      const before = inspectCount;
      assert.equal(
        (await apps[1].inject(callback.pathname + callback.search)).headers.location,
        'https://otto.example/apps?connection=expired',
      );
      assert.equal(inspectCount, before);
      assert.equal(
        (await apps[0].inject(callback.pathname + callback.search)).headers.location,
        'https://otto.example/onboarding?connection=connected',
      );
      await assert.rejects(services[1].list(owners[0]), { statusCode: 403 });
      assert.equal(
        (await services[1].list()).some((connection) => connection.status === 'connected'),
        false,
      );
      await apps[1].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'apps' },
      });
      const second = new URL(callbacks.get(owners[1])!);
      assert.equal(
        (await apps[1].inject(second.pathname + second.search)).headers.location,
        'https://otto.example/apps?connection=connected',
      );
      for (const [account, owner] of accounts) {
        await db.pool.query(
          'INSERT INTO integration_events(id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            'event-' + owner,
            owner,
            'Synthetic event',
            'gmail',
            account,
            'trigger-' + account,
            'fixture',
          ],
        );
      }
      await services[0].drain();
      assert.deepEqual(delivered.get(owners[0]), ['event-' + owners[0]]);
      assert.deepEqual(delivered.get(owners[1]), []);
      assert.equal(
        (await db.pool.query('SELECT state FROM integration_events WHERE owner_id=$1', [owners[1]]))
          .rows[0].state,
        'queued',
      );
      await services[1].drain();
      assert.deepEqual(delivered.get(owners[1]), ['event-' + owners[1]]);
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const cancelled = new URL(callbacks.get(owners[0])!);
      cancelled.searchParams.set('success', 'false');
      assert.equal(
        (await apps[0].inject(cancelled.pathname + cancelled.search)).headers.location,
        'https://otto.example/onboarding?connection=cancelled',
      );
      await apps[0].inject({
        method: 'POST',
        url: '/api/apps/gmail/connect',
        payload: { returnTo: 'onboarding' },
      });
      const expired = new URL(callbacks.get(owners[0])!);
      await db.pool.query(
        "UPDATE app_connections SET callback_expires=now()-interval '1 minute' WHERE owner_id=$1 AND callback_hash IS NOT NULL",
        [owners[0]],
      );
      assert.equal(
        (await apps[0].inject(expired.pathname + expired.search)).headers.location,
        'https://otto.example/onboarding?connection=expired',
      );
    } finally {
      await Promise.all(apps.map((app) => app.close()));
      await db.close();
    }
  },
);

test(
  'hosted Telegram setup reserves one bot owner, uses fixed tenant webhook paths and binds ciphertext to its owner',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const db = await database();
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
  'channel ownership cleanup survives failed saves, uncertain claims and committed changes',
  {
    skip: !process.env.TEST_DATABASE_URL,
  },
  async (t) => {
    const db = await database();
    try {
      for (const scenario of ['remove', 'replace', 'failed-save', 'uncertain-claim'] as const) {
        await t.test(scenario, async () => {
          const ownerId = randomUUID();
          const key = randomBytes(32);
          const claims = new Map<string, string>();
          let failRelease = false;
          let failSave = false;
          let uncertainClaim = false;
          const registry: ChannelAccountRegistry = {
            async claim(input) {
              const current = claims.get(input.accountId);
              if (current && current !== input.ownerId) return false;
              claims.set(input.accountId, input.ownerId);
              if (uncertainClaim && input.accountId === '200')
                throw new Error('Synthetic lost claim response');
              return true;
            },
            async release(input) {
              if (failRelease) throw new Error('Synthetic release interruption');
              if (claims.get(input.accountId) === input.ownerId) claims.delete(input.accountId);
            },
          };
          const verifier: ChannelSetupVerifier = {
            async verify(provider, input) {
              return {
                environment: {
                  TELEGRAM_ENABLED: 'true',
                  TELEGRAM_BOT_TOKEN: `${String(input)}:synthetic-never-live`,
                  TELEGRAM_MODE: 'polling',
                },
                summary: {
                  provider,
                  enabled: true,
                  mode: 'polling',
                  accountHandle: '@synthetic_bot',
                },
              };
            },
          };
          const options = {
            ownerId,
            accounts: registry,
            verifier,
            keyStore: { id: 'fixture', configured: true, getKey: async () => key },
            apply: async (environment: Record<string, string>) => {
              if (failSave && environment.TELEGRAM_BOT_TOKEN?.startsWith('200:'))
                throw new Error('Synthetic apply failure');
            },
          };
          const app = Fastify();
          try {
            const settings = await createChannelSettings(db.pool, options);
            settings.registerRoutes(app);
            assert.equal(
              (
                await app.inject({
                  method: 'PUT',
                  url: '/api/channel-settings/telegram',
                  payload: '100',
                  headers: { 'content-type': 'application/json' },
                })
              ).statusCode,
              200,
            );
            failRelease = true;
            failSave = scenario === 'failed-save';
            uncertainClaim = scenario === 'uncertain-claim';
            const response = await app.inject(
              scenario === 'remove'
                ? {
                    method: 'DELETE',
                    url: '/api/channel-settings/telegram',
                  }
                : {
                    method: 'PUT',
                    url: '/api/channel-settings/telegram',
                    payload: '200',
                    headers: { 'content-type': 'application/json' },
                  },
            );
            assert.equal(response.statusCode, failSave || uncertainClaim ? 503 : 200);
            assert.ok(claims.has(scenario === 'remove' || scenario === 'replace' ? '100' : '200'));
            assert.equal(await settings.recover(), false);
          } finally {
            await app.close();
          }
          failRelease = false;
          failSave = false;
          uncertainClaim = false;
          const restarted = await createChannelSettings(db.pool, options);
          assert.equal(await restarted.recover(), true);
          const expected = scenario === 'remove' ? [] : [scenario === 'replace' ? '200' : '100'];
          assert.deepEqual([...claims.keys()], expected);
          assert.deepEqual(
            (
              await db.pool.query(
                'SELECT account_id FROM channel_account_claims WHERE owner_id=$1 AND pending=true ORDER BY account_id',
                [ownerId],
              )
            ).rows.map((row) => row.account_id),
            expected,
          );
          const environment = await restarted.environment();
          assert.equal(environment.TELEGRAM_ENABLED, scenario === 'remove' ? 'false' : 'true');
          if (expected.length)
            assert.ok(environment.TELEGRAM_BOT_TOKEN.startsWith(`${expected[0]}:`));
        });
      }
    } finally {
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
    const db = await database();
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
