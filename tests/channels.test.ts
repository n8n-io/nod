import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createVault } from '../src/server/vault.ts';
import { channelConfiguration, createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { MessagingRetryLater, type MessagingTransport } from '../src/ports/messaging.ts';

const fixtureEnv = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
  TELEGRAM_ALLOWED_USER_ID: '123456',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN: 'fixture-not-live',
  WHATSAPP_APP_SECRET: 'fixture-app-secret',
  WHATSAPP_PHONE_NUMBER_ID: '555000',
  WHATSAPP_VERIFY_TOKEN: 'fixture-verify-token',
  WHATSAPP_ALLOWED_NUMBER: '351910000000',
  WHATSAPP_POLICY_CONFIRMED: 'true',
};

async function createFixtureTables(pool: pg.Pool, owner: string) {
  await pool.query(`CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,created_at timestamptz NOT NULL DEFAULT now())`);
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  return threadId;
}

async function fixtureTurn(
  client: Pick<pg.PoolClient, 'query'>,
  threadId: string,
  owner: string,
  channel: string,
  sourceId: string | null = null,
  status = 'queued',
) {
  const result = await client.query(
    'INSERT INTO turns(id,owner_id,thread_id,source_id,channel,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [randomUUID(), owner, threadId, sourceId, channel, status],
  );
  return result.rows[0].id as string;
}

test(
  'channel lifecycle changes roll back receipts and preserve provider retries',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_channel_lifecycle_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      application_name: schema,
    });
    const threadId = await createFixtureTables(pool, 'fixture-owner');
    const submitted: string[] = [];
    const verificationIds = new Set<string>();
    const turnId = await fixtureTurn(pool, threadId, 'fixture-owner', 'web');
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId,
            allowedSenderIds: ['fixture-owner'],
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: 'fixture-owner',
              threadId: 'fixture-thread',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async () => {
          throw new Error('This fixture must not send a message.');
        },
        close: async () => {},
      };
    }
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'fixture-owner',
      transport: transport(),
      acceptVerification: async (text, input) => {
        if (text === '483729') {
          verificationIds.add(input.clientMessageId);
          return { turnId, messageText: 'Verification code sent securely.' };
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await input.persistOrdinary(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      submit: async (_text, sourceId, client, channel) => {
        submitted.push(sourceId);
        return fixtureTurn(client, threadId, 'fixture-owner', channel, sourceId);
      },
      subscribe: () => () => {},
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    const send = (messageId: string, text: string) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text },
      });
    const gate = await pool.connect();
    const gateId = Math.floor(Math.random() * 1000000000);
    await pool.query(`CREATE FUNCTION hold_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateId}); RETURN NEW; END $$;
      CREATE TRIGGER hold_fixture_receipt BEFORE INSERT ON channel_inbox FOR EACH ROW EXECUTE FUNCTION hold_fixture_receipt()`);
    try {
      for (const [messageId, text] of [
        ['ordinary', 'Continue the fixture task'],
        ['verification', '483729'],
        ['transaction', '2026'],
      ]) {
        const sourceId = `channel:telegram:fixture-account:${messageId}`;
        await gate.query('SELECT pg_advisory_lock($1)', [gateId]);
        const pending = send(messageId, text);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting = Boolean(
            (
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO channel_inbox%'",
                [schema],
              )
            ).rowCount,
          );
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(waiting, true, messageId);
        await channels.replaceTransport(transport('revoked-account'));
        await gate.query('SELECT pg_advisory_unlock($1)', [gateId]);
        const response = await pending;
        assert.equal(response.statusCode, 503, messageId);
        assert.doesNotMatch(response.body, /483729|Channel configuration changed/);
        await channels.drain();
        assert.equal(
          (await pool.query('SELECT 1 FROM channel_inbox WHERE source_id=$1', [sourceId])).rowCount,
          0,
          messageId,
        );
        await channels.replaceTransport(transport());
        assert.equal((await send(messageId, text)).statusCode, 200, messageId);
        await channels.drain();
        assert.equal((await send(messageId, text)).statusCode, 200, messageId);
        await channels.drain();
        assert.equal(
          submitted.filter((id) => id === sourceId).length,
          messageId === 'verification' ? 0 : 1,
          messageId,
        );
        const receipt = (
          await pool.query('SELECT text,state FROM channel_inbox WHERE source_id=$1', [sourceId])
        ).rows[0];
        assert.deepEqual(receipt, {
          text: messageId === 'verification' ? 'Verification code sent securely.' : text,
          state: 'submitted',
        });
      }
      assert.equal(verificationIds.size, 1);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()');
      gate.release();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'channel verification codes are applied only for a waiting sign-in and never stored as text',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_channel_otp_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 71) };
    let injections = 0;
    const vault = await createVault(pool, {
      keyStore,
      page: async () => ({ url: 'https://1.1.1.1/login', origin: 'https://1.1.1.1' }),
      inject: async (input) => {
        assert.equal(input.code, '481927');
        injections++;
      },
      resume: async () => {},
      retry: async () => {},
    });
    const verification = await createChatVerification(pool, {
      ownerId: 'local-development',
      keyStore,
      submitCode: vault.submitChatCode,
      refresh() {},
    });
    const channel = `telegram:${createHash('sha256')
      .update(JSON.stringify(['fixture-account', 'local-development']))
      .digest('hex')
      .slice(0, 32)}`;
    const ordinaryTurnId = await fixtureTurn(
      pool,
      threadId,
      'local-development',
      channel,
      null,
      'succeeded',
    );
    const submitted: string[] = [];
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: 'fixture-account',
            allowedSenderIds: ['local-development'],
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: 'local-development',
              threadId: 'fixture-thread',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async () => ({ ids: ['fixture-reply'] }),
        close: async () => {},
      },
      acceptVerification: (text, input) => verification.accept(text, input),
      submit: async (text) => {
        submitted.push(text);
        return ordinaryTurnId;
      },
      subscribe: () => () => {},
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    const send = (messageId: string, text: string) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text },
      });
    const stored = async () =>
      JSON.stringify(
        (await pool.query('SELECT text FROM channel_inbox UNION ALL SELECT text FROM messages'))
          .rows,
      );
    try {
      assert.equal((await send('year', '2026')).statusCode, 200);
      await channels.drain();
      assert.deepEqual(submitted, ['2026']);
      const codeTurnId = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        channel,
        null,
        'running',
      );
      await pool.query('UPDATE turns SET started_at=now() WHERE id=$1', [codeTurnId]);
      await vault.request({ threadId, turnId: codeTurnId }, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Fixture sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await send('early-code', 'The code is 481 927');
      await channels.drain();
      assert.equal(injections, 0);
      assert.deepEqual(submitted, ['2026']);
      assert.doesNotMatch(await stored(), /481927/);
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [codeTurnId],
      );
      for (const [messageId, text] of [
        ['ambiguous-code', 'Code: 481927 or 739126'],
        ['malformed-code', 'Code: +481927'],
        ['empty-code', 'Código ='],
      ]) {
        assert.equal((await send(messageId, text)).statusCode, 200);
        await channels.drain();
        assert.equal(injections, 0);
        assert.deepEqual(submitted, ['2026']);
        assert.doesNotMatch(await stored(), /481927|739126/);
      }
      assert.equal((await send('code', 'Código: 481 927')).statusCode, 200);
      await channels.drain();
      assert.equal(injections, 1);
      assert.deepEqual(submitted, ['2026']);
      assert.doesNotMatch(await stored(), /481927/);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'channel verification stays private before inbox persistence and fences duplicate delivery across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_codes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'fixture-owner');
    const turnId = await fixtureTurn(pool, threadId, 'fixture-owner', 'web');
    const accepted: Array<{ clientMessageId: string; channel: string }> = [];
    const submitted: string[] = [];
    const sent: Array<{ channelId: string; accountId: string; threadId: string; text: string }> =
      [];
    let injections = 0;
    let beginHeld!: () => void;
    let releaseHeld!: () => void;
    const heldStarted = new Promise<void>((resolve) => {
      beginHeld = resolve;
    });
    const heldReleased = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: ['telegram', 'whatsapp'].map((id) => ({
          id,
          status: 'configured',
          missing: [],
          accountId,
          allowedSenderIds: ['fixture-owner'],
        })),
        receive: async (request) => {
          const input = JSON.parse(Buffer.from(request.body).toString('utf8'));
          return {
            status: 200,
            body: 'accepted',
            messages: [
              {
                channelId: request.channelId,
                accountId: 'fixture-account',
                senderId: 'fixture-owner',
                threadId: 'fixture-thread',
                ...input,
                sentAt: new Date(),
              },
            ],
          };
        },
        post: async (message) => {
          sent.push(message);
          return { ids: [`fixture-reply-${sent.length}`] };
        },
        close: async () => {},
      };
    }
    async function open() {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId: 'fixture-owner',
        transport: transport(),
        intervalMs: 600000,
        subscribe: () => () => {},
        acceptVerification: async (text, input) => {
          accepted.push(input);
          if (text === '111111')
            throw Object.assign(new Error('Ambiguous fixture code 111111.'), { statusCode: 409 });
          if (text === '222222') throw new Error('Provider failed with code 222222.');
          if (text !== '483729' && text !== '123456') {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await input.persistOrdinary(client);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
            return;
          }
          if (text === '123456') {
            beginHeld();
            await heldReleased;
          }
          const stored = await pool.query(
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'fixture-owner','user','Verification code sent securely.',$2,$3) ON CONFLICT(id) DO NOTHING",
            [input.clientMessageId, threadId, turnId],
          );
          if (stored.rowCount) injections++;
          return { turnId, messageText: 'Verification code sent securely.' };
        },
        submit: async (text, sourceId, client, channel) => {
          submitted.push(text);
          return fixtureTurn(client, threadId, 'fixture-owner', channel, sourceId);
        },
      });
      channels.registerRoutes(app);
      return { app, channels };
    }
    let fixture = await open();
    const send = (messageId: string, text: string, provider = 'telegram', extra = {}) =>
      fixture.app.inject({
        method: 'POST',
        url: `/api/webhooks/${provider}`,
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text, ...extra },
      });
    try {
      await send('foreign', '483729', 'telegram', { senderId: 'someone-else' });
      await send('foreign-account', '483729', 'telegram', { accountId: 'another-account' });
      assert.equal(accepted.length, 0);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);

      await pool.query(
        "ALTER TABLE channel_inbox ADD CONSTRAINT fixture_insert_failure CHECK(provider <> 'telegram')",
      );
      const interrupted = await send('private-code', '483729');
      assert.equal(interrupted.statusCode, 503);
      assert.doesNotMatch(interrupted.body, /483729/);
      assert.equal(injections, 1);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      await fixture.app.close();
      await pool.query('ALTER TABLE channel_inbox DROP CONSTRAINT fixture_insert_failure');
      fixture = await open();
      const retried = await Promise.all([
        send('private-code', '483729'),
        send('private-code', '483729'),
      ]);
      assert.ok(retried.every((response) => response.statusCode === 200));
      await fixture.channels.drain();
      assert.equal(injections, 1);
      assert.equal(new Set(accepted.map((input) => input.clientMessageId)).size, 1);
      const row = (await pool.query('SELECT * FROM channel_inbox')).rows[0];
      assert.equal(row.text, 'Verification code sent securely.');
      assert.equal(row.state, 'submitted');
      assert.equal(row.turn_id, turnId);
      assert.equal(row.message_id, accepted[0].clientMessageId);
      assert.match(accepted[0].channel, /^telegram:[a-f0-9]{32}$/);
      assert.deepEqual(submitted, []);
      const calls = accepted.length;
      await send('private-code', 'changed duplicate body');
      assert.equal(accepted.length, calls);

      assert.equal((await send('private-code', '483729', 'whatsapp')).statusCode, 200);
      assert.match(accepted.at(-1)!.channel, /^whatsapp:[a-f0-9]{32}$/);
      assert.notEqual(accepted.at(-1)!.clientMessageId, accepted[0].clientMessageId);
      assert.equal(injections, 2);

      const ambiguous = await send('ambiguous-code', '111111');
      assert.equal(ambiguous.statusCode, 200);
      assert.doesNotMatch(ambiguous.body, /111111|Ambiguous fixture/);
      await fixture.channels.drain();
      assert.deepEqual(sent, [
        {
          channelId: 'telegram',
          accountId: 'fixture-account',
          threadId: 'fixture-thread',
          text: 'Otto didn’t use that code. Sign-in codes go in the conversation that asked for them, and payments are approved only in the Otto app.',
        },
      ]);
      const guidance = (
        await pool.query(
          "SELECT i.text,i.state,i.turn_id,m.role,m.turn_id AS reply_turn_id FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id='channel:telegram:fixture-account:ambiguous-code'",
        )
      ).rows[0];
      assert.deepEqual(guidance, {
        text: 'Code not applied.',
        state: 'discarded',
        turn_id: null,
        role: 'assistant',
        reply_turn_id: null,
      });
      await fixture.app.close();
      fixture = await open();
      const acceptedBeforeDuplicate = accepted.length;
      await Promise.all([
        send('ambiguous-code', '111111'),
        send('ambiguous-code', 'changed duplicate body'),
      ]);
      await fixture.channels.drain();
      assert.equal(accepted.length, acceptedBeforeDuplicate);
      assert.equal(sent.length, 1);
      const unavailable = await send('unavailable-code', '222222');
      assert.equal(unavailable.statusCode, 503);
      assert.doesNotMatch(unavailable.body, /222222|Provider failed/);
      await fixture.channels.drain();
      const privateRows = (await pool.query('SELECT text FROM channel_inbox')).rows;
      assert.equal(privateRows.length, 3);
      assert.doesNotMatch(JSON.stringify(privateRows), /483729|111111|222222/);
      assert.deepEqual(submitted, []);

      assert.equal((await send('ordinary-number', '2026')).statusCode, 200);
      await fixture.channels.drain();
      assert.deepEqual(submitted, ['2026']);
      assert.equal(
        (
          await pool.query(
            "SELECT text FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:ordinary-number'",
          )
        ).rows[0].text,
        '2026',
      );

      const held = send('revoked-code', '123456');
      await Promise.race([
        heldStarted,
        held.then(() => {
          throw new Error('Expected pending verification.');
        }),
      ]);
      await fixture.channels.replaceTransport(transport('new-account'));
      releaseHeld();
      assert.equal((await held).statusCode, 503);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:revoked-code'",
          )
        ).rowCount,
        0,
      );
    } finally {
      releaseHeld();
      await fixture.app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'memory and usage commands get a digest from the outbox without a turn and only for the paired sender',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_channel_memory_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'fixture-owner');
    const submitted: string[] = [];
    const posted: Array<{ text: string; files: string[] }> = [];
    const fileId = randomUUID();
    const resolved: string[][] = [];
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'fixture-owner',
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId: 'fixture-account',
            allowedSenderIds: ['fixture-owner'],
            supportsAttachments: true,
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: 'fixture-owner',
              threadId: 'fixture-thread',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async (input) => {
          posted.push({
            text: input.text,
            files: (input.attachments ?? []).map((file) => file.name),
          });
          return { ids: [randomUUID()] };
        },
        close: async () => {},
      },
      commandReply: async (command, _client, thread) => ({
        text: `Synthetic ${command} digest`,
        attachments: [
          { id: fileId, name: `otto-${command}.md`, mimeType: 'text/markdown', size: 9, url: '' },
        ].filter(() => thread === threadId),
      }),
      resolveAttachments: async (thread, ids) => {
        resolved.push([thread, ...ids]);
        return [
          { name: 'otto-memory.md', mimeType: 'text/markdown', bytes: Buffer.from('# Memory\n') },
        ];
      },
      submit: async (_text, sourceId) => {
        submitted.push(sourceId);
        throw new Error('A memory command must not start a turn.');
      },
      subscribe: () => () => {},
      intervalMs: 600000,
    });
    channels.registerRoutes(app);
    const send = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload,
      });
    try {
      assert.equal((await send({ messageId: 'memory', text: '/memory' })).statusCode, 200);
      assert.equal((await send({ messageId: 'memory', text: '/memory' })).statusCode, 200);
      assert.equal((await send({ messageId: 'usage', text: '/usage' })).statusCode, 200);
      assert.equal(
        (await send({ messageId: 'stranger', text: '/context', senderId: 'stranger' })).statusCode,
        200,
      );
      await channels.drain();
      assert.deepEqual(submitted, []);
      assert.deepEqual(posted, [
        { text: 'Synthetic memory digest', files: ['otto-memory.md'] },
        { text: 'Synthetic usage digest', files: ['otto-memory.md'] },
      ]);
      assert.deepEqual(resolved, [
        [threadId, fileId],
        [threadId, fileId],
      ]);
      assert.deepEqual(
        (await pool.query('SELECT source_id,state FROM channel_inbox ORDER BY source_id')).rows,
        [
          { source_id: 'channel:telegram:fixture-account:memory', state: 'discarded' },
          { source_id: 'channel:telegram:fixture-account:usage', state: 'discarded' },
        ],
      );
    } finally {
      await app.close();
      await channels.close?.();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('channels stay disabled without explicit enablement and require a single owner and WhatsApp eligibility review', () => {
  assert.deepEqual(
    channelConfiguration({}).map((channel) => channel.status),
    ['disabled', 'disabled'],
  );
  const missing = channelConfiguration({
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
    WHATSAPP_ENABLED: 'true',
  });
  assert.ok(missing[0].missing.includes('TELEGRAM_ALLOWED_USER_ID'));
  assert.ok(missing[0].missing.includes('TELEGRAM_WEBHOOK_SECRET_TOKEN'));
  assert.ok(missing[1].missing.includes('WHATSAPP_POLICY_CONFIRMED'));
  assert.deepEqual(
    channelConfiguration(fixtureEnv).map((channel) => channel.status),
    ['configured', 'configured'],
  );
  assert.equal(
    JSON.stringify(channelConfiguration(fixtureEnv)).includes('fixture-not-live'),
    false,
  );
  assert.equal(
    channelConfiguration({ ...fixtureEnv, TELEGRAM_WEBHOOK_SECRET_TOKEN: 'short' })[0].status,
    'setup_required',
  );
});

test('channel replies keep secure credential and approval links in the local app', () => {
  const reply = channelReply(
    'Continue [Add credentials](/credentials/secret-id?token=secret-token) and [Approve](http://localhost:4310/approvals/private-id). Read https://example.com/docs.',
    true,
  );
  assert.equal(reply.includes('secret-token'), false);
  assert.equal(reply.includes('private-id'), false);
  assert.match(reply, /https:\/\/example.com\/docs/);
  const paymentReply = channelReply(
    '[Approve](/payments/private-id) [Owned](https://otto.example/payments/private-id) [HTTP](http://otto.example/payments/private-id) [Invoice](https://merchant.example/payments/invoice)',
    false,
    false,
    [],
    'https://otto.example',
  );
  assert.equal(paymentReply.includes('private-id'), false);
  assert.match(paymentReply, /https:\/\/merchant\.example\/payments\/invoice/);
  const imageReply = channelReply(
    '[Image](http://localhost:4310/api/artifacts/private-file)',
    false,
    true,
  );
  assert.equal(imageReply.includes('private-file'), false);
  assert.match(imageReply, /Attached file/);
  assert.equal(channelReply('', false, true), '');
  assert.ok(channelReply('', true).trim());
  assert.ok(channelReply('').trim());
});

test('text-only channel replies show verified private file links when an app address is available', () => {
  const reply = channelReply(
    'Research is ready. [Report](/api/artifacts/00000000-0000-4000-8000-000000000001)',
    true,
    false,
    [
      {
        name: 'report.csv',
        url: 'https://otto.example/api/artifacts/00000000-0000-4000-8000-000000000001',
      },
    ],
  );
  assert.match(reply, /Research is ready/);
  assert.match(reply, /report\.csv/);
  assert.match(
    reply,
    /https:\/\/otto\.example\/api\/artifacts\/00000000-0000-4000-8000-000000000001/,
  );
  assert.equal((reply.match(/https:\/\/otto\.example\/api\/artifacts\//g) ?? []).length, 1);
});

test(
  'a webhook received during an outbound send is submitted before the active drain finishes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_overlap_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    let releaseSend = () => {};
    let markSendStarted = () => {};
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
        return Response.json({
          ok: true,
          result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
        });
      if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
        sends++;
        markSendStarted();
        await sendReleased;
        return Response.json({
          ok: true,
          result: {
            message_id: 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture reply',
          },
        });
      }
      throw new Error('Unexpected fixture provider call.');
    });
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: createChatSdkTransport(pool, { ...fixtureEnv, WHATSAPP_ENABLED: 'false' }),
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client, channel) =>
        fixtureTurn(client, threadId, 'local-development', channel, sourceId),
    });
    channels.registerRoutes(app);
    const send = (id: number) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        },
        payload: {
          update_id: id,
          message: {
            message_id: id,
            date: Math.floor(Date.now() / 1000),
            text: `Fixture request ${id}`,
            from: { id: 123456, is_bot: false, first_name: 'Fixture' },
            chat: { id: 123456, type: 'private' },
          },
        },
      });
    try {
      assert.equal((await send(1)).statusCode, 200);
      await channels.drain();
      const turn = (await pool.query('SELECT id FROM turns')).rows[0];
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Fixture reply',$2,$3)",
        [randomUUID(), threadId, turn.id],
      );
      const activeDrain = channels.drain();
      await Promise.race([
        sendStarted,
        activeDrain.then(() => {
          throw new Error('The fixture reply did not reach the provider transport.');
        }),
      ]);
      assert.equal((await send(2)).statusCode, 200);
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 1);
      releaseSend();
      await activeDrain;
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 2);
      assert.equal(
        (await pool.query("SELECT * FROM channel_inbox WHERE state='pending'")).rowCount,
        0,
      );
      assert.equal(sends, 1);
    } finally {
      releaseSend();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Chat SDK channel fixture authenticates owner messages, commits turn dedupe, and routes replies by turn channel',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    const sent: { provider: string; body: Record<string, unknown> }[] = [];
    const whatsappFileId = randomUUID();
    let providerCalls = 0;
    let failSend = false;
    let failSubmit = false;
    const targets = new Map<string, string | undefined>();
    const rejectedTarget = 'wamid.fixture-out-3';
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        providerCalls++;
        const url = input instanceof Request ? input.url : String(input);
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
          sent.push({ provider: 'telegram', body });
          if (failSend) throw new Error('Fixture transport interrupted after possible acceptance.');
          return Response.json({
            ok: true,
            result: {
              message_id: sent.length + 100,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123456, type: 'private' },
              text: 'Fixture reply',
            },
          });
        }
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/messages$/.test(url)) {
          sent.push({ provider: 'whatsapp', body });
          if ((body.context as { message_id?: string } | undefined)?.message_id === rejectedTarget)
            return Response.json(
              { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } },
              { status: 400 },
            );
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      appOrigin: 'https://otto.example',
      transport: createChatSdkTransport(pool, fixtureEnv),
      resolveAttachments: async (resolvedThreadId, ids) => {
        assert.equal(resolvedThreadId, threadId);
        if (ids.length !== 1 || ids[0] !== whatsappFileId)
          throw new Error('Attachment unavailable.');
        return [{ name: 'research.csv', mimeType: 'text/csv', bytes: Buffer.from('A,B\n1,2\n') }];
      },
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client, channel, messageId, _answer, replyToMessageId) => {
        const turnId = await fixtureTurn(client, threadId, 'local-development', channel, sourceId);
        if (failSubmit) throw new Error('Fixture turn queue unavailable.');
        await client.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','user','Fixture request',$2,$3)",
          [messageId, threadId, turnId],
        );
        targets.set(sourceId, replyToMessageId);
        return turnId;
      },
    });
    channels.registerRoutes(app);
    const telegramPayload = (id: number, from = 123456, type = 'private', replyTo?: number) => ({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        text: 'Help with a fixture task',
        from: { id: from, is_bot: false, first_name: 'Fixture' },
        chat: { id: from, type },
        ...(replyTo
          ? {
              reply_to_message: {
                message_id: replyTo,
                date: Math.floor(Date.now() / 1000),
                text: 'Fixture reply',
                from: { id: 987, is_bot: true, first_name: 'Fixture' },
                chat: { id: from, type },
              },
            }
          : {}),
      },
    });
    const whatsappPayload = (
      id: string,
      from = '351910000000',
      phone = '555000',
      timestamp = Math.floor(Date.now() / 1000),
      replyTo?: string,
    ) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phone },
                messages: [
                  {
                    id,
                    from,
                    timestamp: String(timestamp),
                    type: 'text',
                    text: { body: 'A WhatsApp fixture request' },
                    ...(replyTo ? { context: { from: '555000', id: replyTo } } : {}),
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sendTelegram = (payload: unknown, secret = fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        payload: JSON.stringify(payload),
      });
    const sendWhatsApp = (payload: unknown, valid = true) => {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', fixtureEnv.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': valid ? signature : 'sha256=invalid',
        },
        payload: body,
      });
    };
    const addReply = async (
      sourceId: string,
      text = 'The fixture task is done.',
      attachments: { id: string }[] = [],
      replyTo: string | null = null,
    ) => {
      const row = (
        await pool.query('SELECT turn_id FROM channel_inbox WHERE source_id=$1', [sourceId])
      ).rows[0];
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments,reply_to_message_id) VALUES($1,'local-development','assistant',$2,$3,$4,$5,$6)",
        [id, text, threadId, row.turn_id, JSON.stringify(attachments), replyTo],
      );
      return id;
    };
    try {
      assert.equal((await sendTelegram(telegramPayload(1), 'invalid')).statusCode, 401);
      assert.equal((await sendWhatsApp(whatsappPayload('wamid.bad'), false)).statusCode, 401);
      await sendTelegram(telegramPayload(2, 456789));
      await sendTelegram(telegramPayload(3, 123456, 'group'));
      await sendWhatsApp(whatsappPayload('wamid.other-user', '351920000000'));
      await sendWhatsApp(whatsappPayload('wamid.other-business', undefined, '999000'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal(providerCalls, 0);
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fixture-verify-token&hub.challenge=123',
          )
        ).body,
        '123',
      );

      failSubmit = true;
      await sendTelegram(telegramPayload(10));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 0);
      assert.equal((await pool.query('SELECT state FROM channel_inbox')).rows[0].state, 'pending');
      failSubmit = false;
      await channels.drain();
      await Promise.all([sendTelegram(telegramPayload(10)), sendTelegram(telegramPayload(10))]);
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 2);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 2);
      await addReply(
        'channel:telegram:987:123456:10',
        'Finish [securely](/credentials/private-token), [approve payment](/payments/private-token) or [add a card](/vault?add=card).',
      );
      const whatsappReply = await addReply('channel:whatsapp:555000:wamid.good');
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Unrelated web-only reply',$2,$3)",
        [randomUUID(), threadId, await fixtureTurn(pool, threadId, 'local-development', 'web')],
      );
      await channels.drain();
      assert.equal(sent.length, 2);

      const fileReply = await addReply(
        'channel:whatsapp:555000:wamid.good',
        `Research is ready. [File](/api/artifacts/${whatsappFileId})`,
        [{ id: whatsappFileId }],
      );
      await channels.drain();
      assert.equal(sent.length, 3);
      const fileText = JSON.stringify(sent[2].body);
      assert.match(fileText, /https:\/\/otto\.example\/api\/artifacts\//);
      assert.match(fileText, /research\.csv/);
      assert.equal((fileText.match(/https:\/\/otto\.example\/api\/artifacts\//g) ?? []).length, 1);
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [fileReply]))
          .rows[0].state,
        'sent',
      );

      const missingReply = await addReply('channel:whatsapp:555000:wamid.good', 'Missing file.', [
        { id: randomUUID() },
      ]);
      await channels.drain();
      assert.equal(sent.length, 3);
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            missingReply,
          ])
        ).rows[0],
        { state: 'blocked', reason: 'attachment_unavailable' },
      );
      assert.equal(sent.find((message) => message.provider === 'telegram')?.body.chat_id, '123456');
      assert.equal(
        sent.find((message) => message.provider === 'whatsapp')?.body.to,
        '351910000000',
      );
      assert.equal(JSON.stringify(sent).includes('private-token'), false);
      assert.equal(JSON.stringify(sent).includes('/vault?add='), false);
      assert.equal(JSON.stringify(sent).includes('Unrelated web-only'), false);
      await channels.drain();
      assert.equal(sent.length, 3);

      const ownerMessage = (
        await pool.query(
          "SELECT message_id FROM channel_inbox WHERE source_id='channel:telegram:987:123456:10'",
        )
      ).rows[0].message_id;
      await sendTelegram(telegramPayload(11, 123456, 'private', 101));
      await sendTelegram(telegramPayload(12, 123456, 'private', 10));
      await sendTelegram(telegramPayload(13, 123456, 'private', 999));
      await sendWhatsApp(
        whatsappPayload('wamid.reply', undefined, undefined, undefined, 'wamid.fixture-out-2'),
      );
      await sendWhatsApp(
        whatsappPayload('wamid.cross', undefined, undefined, undefined, '123456:101'),
      );
      await channels.drain();
      const telegramReply = (
        await pool.query(
          "SELECT message_id FROM channel_outbox WHERE provider_message_ids=ARRAY['123456:101']",
        )
      ).rows[0].message_id;
      assert.deepEqual(Object.fromEntries(targets), {
        'channel:telegram:987:123456:10': undefined,
        'channel:whatsapp:555000:wamid.good': undefined,
        'channel:telegram:987:123456:11': telegramReply,
        'channel:telegram:987:123456:12': ownerMessage,
        'channel:telegram:987:123456:13': undefined,
        'channel:whatsapp:555000:wamid.reply': whatsappReply,
        'channel:whatsapp:555000:wamid.cross': undefined,
      });

      await addReply('channel:telegram:987:123456:11', 'Threaded.', [], ownerMessage);
      await addReply('channel:whatsapp:555000:wamid.reply', 'Threaded.', [], whatsappReply);
      const long = await addReply(
        'channel:whatsapp:555000:wamid.reply',
        'Long fixture line.\n'.repeat(300),
      );
      await channels.drain();
      assert.deepEqual(
        sent.slice(3, 5).map(({ body }) => body.reply_parameters ?? body.context),
        [
          { message_id: 10, allow_sending_without_reply: true },
          { message_id: 'wamid.fixture-out-2' },
        ],
      );
      assert.equal(sent.length, 7);
      await sendWhatsApp(
        whatsappPayload('wamid.chunk', undefined, undefined, undefined, 'wamid.fixture-out-6'),
      );
      await channels.drain();
      assert.equal(targets.get('channel:whatsapp:555000:wamid.chunk'), long);
      const fallback = await addReply(
        'channel:whatsapp:555000:wamid.chunk',
        'Unthreaded.',
        [],
        fileReply,
      );
      await channels.drain();
      assert.deepEqual(
        sent.slice(7).map(({ body }) => body.context ?? null),
        [{ message_id: rejectedTarget }, null],
      );
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [fallback]))
          .rows[0].state,
        'sent',
      );
      const delivered = sent.length;

      await sendWhatsApp(
        whatsappPayload('wamid.old', undefined, undefined, Math.floor(Date.now() / 1000) - 172800),
      );
      await channels.drain();
      await pool.query(
        "UPDATE channel_inbox SET received_at=now()-interval '2 days' WHERE provider='whatsapp'",
      );
      const expiredId = await addReply('channel:whatsapp:555000:wamid.old');
      await channels.drain();
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            expiredId,
          ])
        ).rows[0],
        { state: 'blocked', reason: 'reply_window_closed' },
      );
      assert.equal(sent.length, delivered);

      failSend = true;
      const uncertainId = await addReply('channel:telegram:987:123456:10');
      await channels.drain();
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [uncertainId]))
          .rows[0].state,
        'uncertain',
      );
      const attempts = sent.length;
      await channels.drain();
      assert.equal(sent.length, attempts);
      const status = (await app.inject('/api/channels')).json();
      assert.equal(status.channels[0].status, 'configured');
      assert.equal(JSON.stringify(status).includes('fixture-app-secret'), false);
      assert.equal(JSON.stringify(status).includes('allowedSenderIds'), false);
      assert.equal(JSON.stringify(status).includes('accountId'), false);
      await pool.query("UPDATE channel_outbox SET state='sending' WHERE message_id=$1", [
        uncertainId,
      ]);
      const revokedId = await addReply('channel:telegram:987:123456:10');
      await app.close();
      const restarted = await createChannels(pool, {
        ownerId: 'local-development',
        resolveAttachments: async (_threadId, ids) => {
          if (ids.length !== 1 || ids[0] !== whatsappFileId)
            throw new Error('Attachment unavailable.');
          return [{ name: 'research.csv', mimeType: 'text/csv', bytes: Buffer.from('A,B\n1,2\n') }];
        },
        transport: createChatSdkTransport(pool, {
          ...fixtureEnv,
          TELEGRAM_ALLOWED_USER_ID: '999999',
        }),
        subscribe: () => () => {},
        intervalMs: 600000,
        submit: async () => {
          throw new Error('No new turn should be submitted.');
        },
      });
      try {
        await restarted.drain();
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              uncertainId,
            ])
          ).rows[0],
          { state: 'uncertain', reason: 'interrupted_send' },
        );
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              revokedId,
            ])
          ).rows[0],
          { state: 'blocked', reason: 'channel_access_changed' },
        );
        assert.equal(sent.length, attempts);
        await pool.query(
          "UPDATE channel_inbox SET received_at=now() WHERE source_id='channel:whatsapp:555000:wamid.good'",
        );
        await addReply('channel:whatsapp:555000:wamid.good', 'Research is ready.', [
          { id: whatsappFileId },
        ]);
        await restarted.drain();
        assert.equal(sent.length, attempts + 1);
        const fallbackText = JSON.stringify(sent.at(-1)?.body);
        assert.match(fallbackText, /Attachments are available in Otto/);
        assert.doesNotMatch(fallbackText, /api\/artifacts/);
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'button presses pass the owner checks of messages, answer by approval ID without a turn, and edits survive "not modified" and 429',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channel_press_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await createFixtureTables(pool, 'local-development');
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const edits: Response[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url, body });
        const method = url.split('/').at(-1);
        if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/')) {
          if (method === 'getMe')
            return Response.json({
              ok: true,
              result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
            });
          if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
          if (method === 'editMessageText') return edits.shift()!;
          return Response.json({
            ok: true,
            result: {
              message_id: 200 + calls.length,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123456, type: 'private' },
              text: 'Fixture reply',
            },
          });
        }
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/messages$/.test(url))
          return Response.json({ messages: [{ id: `wamid.fixture-out-${calls.length}` }] });
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const known = randomUUID();
    const stale = randomUUID();
    const taskId = randomUUID();
    const broken = randomUUID();
    const pressed: unknown[] = [];
    let hold: Promise<void> | undefined;
    const transport = createChatSdkTransport(pool, fixtureEnv);
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport,
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async () => {
        throw new Error('A button press never submits a message.');
      },
      press: async (action, channel) => {
        pressed.push({ action, channel: channel.split(':')[0] });
        await hold;
        if ('taskId' in action && action.taskId === broken)
          throw new Error('Synthetic press failure.');
        if ('approvalId' in action && action.approvalId !== known)
          throw Object.assign(new Error('This confirmation is already handled.'), {
            statusCode: 409,
          });
      },
    });
    channels.registerRoutes(app);
    const callback = (
      id: number,
      data: string,
      from = 123456,
      chat: { id: number; type: string } = { id: from, type: 'private' },
    ) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        },
        payload: JSON.stringify({
          update_id: id,
          callback_query: {
            id: `callback-${id}`,
            from: { id: from, is_bot: false, first_name: 'Fixture' },
            chat_instance: 'fixture',
            data,
            message: {
              message_id: 101,
              date: Math.floor(Date.now() / 1000),
              chat,
              from: { id: 987, is_bot: true, first_name: 'Fixture' },
              text: 'Fixture question',
            },
          },
        }),
      });
    const tap = (id: string, data: string, from = '351910000000') => {
      const body = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '555000' },
                  messages: [
                    {
                      id,
                      from,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'interactive',
                      context: { from: '555000', id: 'wamid.fixture-question' },
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: data, title: 'Yes' },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', fixtureEnv.WHATSAPP_APP_SECRET).update(body).digest('hex')}`,
        },
        payload: body,
      });
    };
    const acks = () =>
      calls.filter((call) => call.url.endsWith('/answerCallbackQuery')).map((call) => call.body);
    try {
      assert.equal((await callback(1, `a:${known}:y`, 456789)).statusCode, 200);
      await callback(2, `a:${known}:y`, 123456, { id: 123456, type: 'group' });
      await tap('wamid.fixture-stranger', `a:${known}:y`, '351920000000');
      assert.equal(pressed.length, 0);
      assert.equal(calls.length, 0);

      await callback(3, `a:${known}:y`);
      await callback(4, `a:${stale}:n`);
      await callback(5, `s:${taskId}`);
      await callback(6, 'a:not-an-approval:y');
      assert.deepEqual(pressed, [
        { action: { approvalId: known, approved: true }, channel: 'telegram' },
        { action: { approvalId: stale, approved: false }, channel: 'telegram' },
        { action: { taskId }, channel: 'telegram' },
      ]);
      const answered = acks();
      assert.deepEqual(answered[0], { callback_query_id: 'callback-3' });
      assert.match(String(answered[1].text), /already handled/);
      assert.deepEqual(answered[2], { callback_query_id: 'callback-5' });
      assert.equal(answered[3].callback_query_id, 'callback-6');
      assert.ok(answered[3].text);
      assert.equal((await callback(5, `s:${taskId}`)).statusCode, 200);
      assert.equal(pressed.length, 3);
      assert.deepEqual(acks().at(-1), { callback_query_id: 'callback-5' });
      for (let attempt = 0; attempt < 2; attempt++)
        assert.equal((await callback(7, `s:${broken}`)).statusCode, 200);
      assert.equal(pressed.length, 4);
      assert.equal(acks().at(-2)?.callback_query_id, 'callback-7');
      assert.ok(acks().at(-2)?.text);
      assert.deepEqual(acks().at(-1), { callback_query_id: 'callback-7' });

      await tap('wamid.fixture-stale', `a:${stale}:y`);
      await tap('wamid.fixture-stale', `a:${stale}:y`);
      let release!: () => void;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      const first = tap('wamid.fixture-twice', `a:${known}:n`);
      while (pressed.length < 6) await delay(5);
      const repeat = tap('wamid.fixture-twice', `a:${known}:n`);
      await Promise.race([repeat, delay(200)]);
      release();
      await Promise.all([first, repeat]);
      assert.equal((await tap('wamid.fixture-broken', `s:${broken}`)).statusCode, 200);
      await channels.drain();
      assert.equal(pressed.length, 7);
      const notes = calls.filter((call) => call.url.includes('graph.facebook.com'));
      assert.equal(notes.length, 2);
      assert.match(JSON.stringify(notes[0].body), /already handled/);
      assert.equal((await pool.query('SELECT 1 FROM turns')).rowCount, 0);

      const buttons = [
        { id: `a:${known}:y`, title: 'Yes' },
        { id: `a:${known}:n`, title: 'No' },
      ];
      const sent = await transport.post({
        channelId: 'telegram',
        accountId: '987',
        threadId: 'telegram:123456',
        text: 'Send the **email** with the [report](https://example.test/report)?',
        replyTo: '123456:101',
        buttons,
      });
      assert.equal(sent.editable, true);
      const question = calls.at(-1)!.body;
      assert.match(String(question.text), /\[report\]\(https:\/\/example\.test\/report\)/);
      assert.equal(question.parse_mode, 'MarkdownV2');
      assert.deepEqual(question.reply_markup, {
        inline_keyboard: [buttons.map(({ id, title }) => ({ text: title, callback_data: id }))],
      });
      assert.deepEqual(question.reply_parameters, {
        message_id: 101,
        allow_sending_without_reply: true,
      });
      await transport.post({
        channelId: 'whatsapp',
        accountId: '555000',
        threadId: 'whatsapp:555000:351910000000',
        text: 'Send the email?',
        buttons,
      });
      assert.deepEqual((calls.at(-1)!.body.interactive as { action: unknown }).action, {
        buttons: buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } })),
      });

      const edit = {
        channelId: 'telegram',
        accountId: '987',
        threadId: 'telegram:123456',
        messageId: sent.ids[0],
        text: 'On it.',
        buttons: [],
      };
      edits.push(
        Response.json(
          { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
          { status: 400 },
        ),
        Response.json(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 7',
            parameters: { retry_after: 7 },
          },
          { status: 429 },
        ),
      );
      await transport.edit!(edit);
      await assert.rejects(
        transport.edit!(edit),
        (error: unknown) => error instanceof MessagingRetryLater && error.retryAfterMs === 7000,
      );
      await assert.rejects(
        transport.edit!({ ...edit, channelId: 'whatsapp', accountId: '555000' }),
      );
      assert.equal(calls.filter((call) => call.url.endsWith('/editMessageText')).length, 2);
      edits.push(
        Response.json(
          { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
          { status: 400 },
        ),
        Response.json({ ok: true, result: true }),
      );
      await transport.edit!({ ...edit, text: 'See the [report](https://example.test/report).' });
      const [formatted, plain] = calls
        .filter((call) => call.url.endsWith('/editMessageText'))
        .slice(2)
        .map((call) => call.body);
      assert.match(String(formatted.text), /\[report\]\(https:\/\/example\.test\/report\)/);
      assert.equal(formatted.parse_mode, 'MarkdownV2');
      assert.equal(plain.text, 'See the report (https://example.test/report).');
      assert.equal(plain.parse_mode, undefined);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
