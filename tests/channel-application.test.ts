import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { createChannelSettings } from '../src/server/channel-settings.ts';
import type { ApplicationAdapters } from '../src/server/composition.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import { fakeComputer } from './runtime-fixtures.ts';

test(
  'application loads encrypted channel setup, replaces transports, and continues replies within their channel',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_app_${suffix}`;
    const bossSchema = `test_channel_app_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const { pool } = await import('../src/server/db.ts');
    const { createApplication } = await import('../src/server/composition.ts');
    const { port } = await import('../src/server/config.ts');
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    let verified = 0;
    const verifier = {
      verify: async () => {
        verified++;
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
    let closed = 0;
    let failClose = false;
    let agentDisposed = false;
    const adapters: ApplicationAdapters = {
      agent: {
        open: async () => {
          throw new Error('No agent in fixture');
        },
        dispose: () => {
          agentDisposed = true;
        },
      },
      computer: fakeComputer(),
      workspace: {
        status: () => '',
        open: () => {
          throw new Error('No workspace in fixture');
        },
        dispose: () => {},
      },
      speech: {
        id: 'fixture',
        configured: false,
        transcribe: async () => '',
        synthesize: async () => ({
          bytes: Buffer.alloc(0),
          mimeType: 'audio/mpeg',
          fileName: 'fixture.mp3',
        }),
      },
      keyStore,
      relevance: { id: 'fixture', configured: false, classify: async () => 'ignore' },
      model: { provider: 'fixture', name: 'fixture', configured: false },
      integrations: {
        id: 'fixture',
        configured: false,
        webhooksConfigured: false,
        supportsSubscriptions: [],
        createSession: async () => {
          throw new Error('No integration');
        },
        restoreSession: async () => {
          throw new Error('No integration');
        },
        readOnly: async () => false,
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
                    sentAt: new Date(),
                  },
                ],
              };
            },
            post: async (message) => {
              sent.push(message.text);
              return { id: 'fixture-sent-' + sent.length };
            },
            close: async () => {
              closed++;
              if (failClose) throw new Error('Synthetic transport shutdown failure.');
            },
          };
          return transport;
        },
      },
    };
    const application = await createApplication(adapters, { workers: false });
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    try {
      assert.equal(applied[0].TELEGRAM_BOT_TOKEN, '42:private-fixture');
      const status = await application.app.inject({ url: '/api/channel-settings', headers });
      assert.equal(status.statusCode, 200);
      assert.equal(status.body.includes('private-fixture'), false);
      assert.equal(
        (
          await application.app.inject({
            method: 'PUT',
            url: '/api/channel-settings/telegram',
            headers: { ...headers, origin: 'https://attacker.example' },
            payload: { botToken: 'attack' },
          })
        ).statusCode,
        403,
      );
      assert.equal(verified, 1);
      const send = async (id: number, text: string) =>
        application.app.inject({
          method: 'POST',
          url: '/api/webhooks/telegram',
          headers: { 'content-type': 'application/json' },
          payload: { id, text },
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
      assert.equal((await send(2, 'Lisbon')).statusCode, 200);
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
      const disabled = await application.app.inject({
        method: 'DELETE',
        url: '/api/channel-settings/telegram',
        headers,
      });
      assert.equal(disabled.statusCode, 200);
      assert.ok(closed >= 1);
      assert.deepEqual(applied.at(-1), { TELEGRAM_ENABLED: 'false' });
      assert.equal((await send(3, 'New task')).statusCode, 404);
      assert.equal(
        (await pool.query('SELECT ciphertext FROM channel_settings')).rows[0].ciphertext,
        null,
      );
    } finally {
      try {
        failClose = true;
        await assert.rejects(application.app.close(), /Some application resources could not close/);
        assert.equal(agentDisposed, true);
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
