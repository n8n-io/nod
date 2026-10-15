import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createVault } from '../src/server/vault.ts';
import { channelConfiguration, createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';

const attachment = (name: string, mimeType: string, text: string) => ({
  name,
  mimeType,
  size: Buffer.byteLength(text),
  read: async () => Buffer.from(text),
});

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
    CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,delivered_channel text,created_at timestamptz NOT NULL DEFAULT now())`);
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
      present: async (_thread, input) => {
        assert.deepEqual(input, { kind: 'verification_refused' });
        return 'Usa o pedido de verificação na conversa correspondente.';
      },
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
        post: async () => ({ id: 'fixture-reply' }),
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
        ['leading-code', '739126 ist der Code'],
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
          return { id: `fixture-reply-${sent.length}` };
        },
        close: async () => {},
      };
    }
    async function open() {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId: 'fixture-owner',
        transport: transport(),
        present: async (thread, input) => {
          assert.equal(thread, threadId);
          assert.deepEqual(input, { kind: 'verification_refused' });
          return 'Usa o pedido de verificação na conversa correspondente.';
        },
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
          text: 'Usa o pedido de verificação na conversa correspondente.',
        },
      ]);
      const guidance = (
        await pool.query(
          "SELECT i.text,i.state,i.turn_id,m.role,m.turn_id AS reply_turn_id FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id='channel:telegram:fixture-account:ambiguous-code'",
        )
      ).rows[0];
      assert.deepEqual(guidance, {
        text: '',
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
  'unavailable channel verification persists one private failure notice across duplicates and restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_failure_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const ownerId = 'fixture-owner';
    const threadId = await createFixtureTables(pool, ownerId);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 37) };
    const vault = await createVault(pool, {
      keyStore,
      page: async () => ({ url: 'https://1.1.1.1/login', origin: 'https://1.1.1.1' }),
      inject: async () => assert.fail('The synthetic provider owns code submission.'),
      resume: async () => {},
      retry: async () => {},
    });
    let held: { start: () => void; released: Promise<void> } | undefined;
    const releases: Array<() => void> = [];
    function holdOutcome() {
      let start = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { start, released };
      releases.push(release);
      return { started, release };
    }
    let submissions = 0;
    let inlinePresentations = 0;
    const verification = await createChatVerification(pool, {
      ownerId,
      keyStore,
      submitCode: async (owner, _turnId, code, requestId) => {
        assert.equal(owner, ownerId);
        assert.equal(code, '481927');
        submissions++;
        const pending = held;
        held = undefined;
        pending?.start();
        await pending?.released;
        await pool.query("UPDATE credential_requests SET status='failed' WHERE id=$1", [requestId]);
        return { status: 'unavailable' };
      },
      present: async () => {
        inlinePresentations++;
        throw new Error('Inline presentation is unavailable.');
      },
      refresh() {},
    });
    const channel = `telegram:${createHash('sha256')
      .update(JSON.stringify(['fixture-account', ownerId]))
      .digest('hex')
      .slice(0, 32)}`;
    async function requestCode() {
      const turnId = await fixtureTurn(pool, threadId, ownerId, channel, null, 'running');
      await pool.query('UPDATE turns SET started_at=now() WHERE id=$1', [turnId]);
      await vault.request({ threadId, turnId }, ownerId, {
        origin: 'https://1.1.1.1',
        label: 'Fixture sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [turnId],
      );
      return turnId;
    }
    const posted: string[] = [];
    const presentations: unknown[] = [];
    let ordinarySubmissions = 0;
    let closing: { start: () => void; released: Promise<void> } | undefined;
    let modelDown = false;
    const modelNotice = 'Verifica o estado do acesso antes de tentares novamente.';
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            missing: [],
            accountId,
            allowedSenderIds: [ownerId],
          },
        ],
        receive: async (request) => ({
          status: 200,
          body: 'accepted',
          messages: [
            {
              channelId: 'telegram',
              accountId: 'fixture-account',
              senderId: ownerId,
              threadId: 'fixture-thread',
              text: '481927',
              sentAt: new Date(),
              ...JSON.parse(Buffer.from(request.body).toString('utf8')),
            },
          ],
        }),
        post: async (input) => {
          posted.push(input.text);
          return { id: `fixture-${posted.length}` };
        },
        close: () => {
          const pending = closing;
          closing = undefined;
          pending?.start();
          return pending?.released ?? Promise.resolve();
        },
      };
    }
    async function open() {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId,
        transport: transport(),
        acceptVerification: (text, input) => verification.accept(text, input),
        present: async (thread, input) => {
          assert.equal(thread, threadId);
          presentations.push(input);
          await pool.query('SELECT 1');
          if (modelDown) throw new Error('Synthetic unavailable model');
          return modelNotice;
        },
        submit: async (text, sourceId, client, channel, messageId) => {
          assert.equal(text, '2026');
          ordinarySubmissions++;
          const turnId = await fixtureTurn(
            client,
            threadId,
            ownerId,
            channel,
            sourceId,
            'succeeded',
          );
          await client.query(
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'user',$3,$4,$5)",
            [messageId, ownerId, text, threadId, turnId],
          );
          return turnId;
        },
        subscribe: () => () => {},
        intervalMs: 600000,
      });
      channels.registerRoutes(app);
      return { app, channels };
    }
    let fixture = await open();
    const send = (messageId: string, text?: string) =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json' },
        payload: { messageId, ...(text ? { text } : {}) },
      });
    const notices = async () =>
      (
        await pool.query(
          `SELECT o.state,o.reason,o.presentation,m.thread_id,m.turn_id FROM channel_outbox o
           JOIN messages m ON m.id=o.message_id ORDER BY m.created_at,m.id`,
        )
      ).rows;
    try {
      const firstTurn = await requestCode();
      const outcome = holdOutcome();
      const original = send('duplicate').then((response) => response);
      await outcome.started;
      assert.equal((await send('duplicate')).statusCode, 200);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 1);
      assert.equal((await notices()).length, 0);
      assert.equal(submissions, 1);
      await pool.query('ALTER TABLE channel_outbox ADD CONSTRAINT fail_notice CHECK(false)');
      outcome.release();
      assert.equal((await original).statusCode, 503);
      assert.equal(
        (await pool.query('SELECT status FROM chat_verification_submissions')).rows[0].status,
        'unavailable',
      );
      assert.equal((await notices()).length, 0);
      await pool.query('ALTER TABLE channel_outbox DROP CONSTRAINT fail_notice');
      assert.equal((await send('duplicate')).statusCode, 200);
      await fixture.channels.drain();
      assert.deepEqual(posted, [modelNotice]);
      assert.deepEqual(presentations, [{ kind: 'verification_failure', verification: 'otp' }]);
      assert.deepEqual(await notices(), [
        {
          state: 'sent',
          reason: null,
          presentation: { kind: 'verification_failure', verification: 'otp' },
          thread_id: threadId,
          turn_id: firstTurn,
        },
      ]);
      await fixture.app.close();
      fixture = await open();
      await Promise.all([send('duplicate'), send('duplicate')]);
      await fixture.channels.drain();
      assert.equal(submissions, 1);
      assert.equal(posted.length, 1);
      assert.equal((await send('ordinary-number', '2026')).statusCode, 200);
      await fixture.channels.drain();
      const waitingTurn = await requestCode();
      assert.equal((await send('ordinary-number', '2026')).statusCode, 200);
      await fixture.channels.drain();
      assert.equal(submissions, 1);
      assert.equal(ordinarySubmissions, 1);
      assert.equal(
        (await pool.query('SELECT status FROM credential_requests WHERE turn_id=$1', [waitingTurn]))
          .rows[0].status,
        'pending',
      );
      modelDown = true;
      assert.equal((await send('model-down')).statusCode, 200);
      await fixture.channels.drain();
      const blocked = (await notices()).find((notice) => notice.state === 'blocked');
      assert.equal(blocked?.reason, 'presentation_unavailable');
      assert.deepEqual(blocked?.presentation, {
        kind: 'verification_failure',
        verification: 'otp',
      });
      await fixture.app.close();
      fixture = await open();
      await send('model-down');
      await fixture.channels.drain();
      assert.equal(submissions, 2);
      assert.equal(presentations.length, 2);
      assert.equal(posted.length, 1);
      modelDown = false;
      const replacedTurn = await requestCode();
      let startClose = () => {};
      let releaseClose = () => {};
      const closeStarted = new Promise<void>((resolve) => {
        startClose = resolve;
      });
      const closeReleased = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      closing = { start: startClose, released: closeReleased };
      releases.push(releaseClose);
      const client = await pool.connect();
      const query = client.query;
      let replaceOnSavepoint = true;
      let replacement: Promise<void> | undefined;
      t.mock.method(client, 'query', async (...args: unknown[]) => {
        const result = await Reflect.apply(query, client, args);
        if (args[0] !== 'SAVEPOINT channel_verification_receipt' || !replaceOnSavepoint)
          return result;
        replaceOnSavepoint = false;
        replacement = fixture.channels.replaceTransport(transport());
        await closeStarted;
        queueMicrotask(releaseClose);
        return result;
      });
      client.release();
      const replaced = await send('same-account-replacement');
      await replacement;
      assert.deepEqual(
        {
          http: replaced.statusCode,
          status: (
            await pool.query(
              `SELECT v.status FROM chat_verification_submissions v JOIN messages m ON m.id=v.message_id
               WHERE m.turn_id=$1`,
              [replacedTurn],
            )
          ).rows[0].status,
          receipts: (
            await pool.query('SELECT 1 FROM channel_inbox WHERE source_id=$1', [
              'channel:telegram:fixture-account:same-account-replacement',
            ])
          ).rowCount,
          notices: (await notices()).length,
        },
        { http: 200, status: 'unavailable', receipts: 0, notices: 2 },
      );
      await requestCode();
      const revoked = holdOutcome();
      const revoking = send('revoked').then((response) => response);
      await revoked.started;
      await fixture.channels.replaceTransport(transport('new-account'));
      revoked.release();
      assert.equal((await revoking).statusCode, 200);
      await fixture.channels.replaceTransport(transport());
      await requestCode();
      const reset = holdOutcome();
      const resetting = send('reset').then((response) => response);
      await reset.started;
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      reset.release();
      assert.equal((await resetting).statusCode, 200);
      await fixture.channels.drain();
      assert.equal(submissions, 5);
      assert.equal(inlinePresentations, 0);
      assert.equal((await notices()).length, 2);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 3);
      assert.equal(
        (await pool.query("SELECT * FROM chat_verification_submissions WHERE status='unavailable'"))
          .rowCount,
        5,
      );
      assert.equal(posted.length, 1);
      assert.doesNotMatch(
        JSON.stringify(
          (await pool.query('SELECT text FROM messages UNION ALL SELECT text FROM channel_inbox'))
            .rows,
        ),
        /481927/,
      );
    } finally {
      for (const release of releases) release();
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
      present: async (thread, input) => {
        assert.equal(thread, threadId);
        assert.equal(input.kind, 'command');
        if (input.kind !== 'command') throw new Error('Expected command presentation');
        assert.equal(input.attachments, 'pending');
        return input.command === 'memory' ? 'Synthetic memory digest' : 'Synthetic usage digest';
      },
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
          return { id: randomUUID() };
        },
        close: async () => {},
      },
      commandReply: async (command, _client, thread) => ({
        text: '',
        presentation: { kind: 'command', command, data: {} },
        attachments: [
          { id: fileId, name: `otto-${command}.md`, mimeType: 'text/markdown', size: 9, url: '' },
        ].filter(() => thread === threadId),
      }),
      resolveAttachments: async (thread, ids) => {
        resolved.push([thread, ...ids]);
        return [attachment('otto-memory.md', 'text/markdown', '# Memory\n')];
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

test('channel presentation isolates private links from the model and preserves owned attachment delivery', async () => {
  const privateFileId = '00000000-0000-4000-8000-000000000001';
  const presentation: unknown[] = [];
  const present = async (threadId: string | null, input: unknown) => {
    presentation.push({ threadId, input });
    return 'Continua na aplicação Otto.';
  };
  const reply = await channelReply(
    'Continua [em segurança](/credentials/secret-id?token=secret-token) ou [aprova](http://localhost:4310/payments/private-id). Consulta https://example.com/docs.',
    { threadId: 'owned-thread', present, appOrigin: 'https://otto.example' },
  );
  assert.equal(reply, 'Continua na aplicação Otto.');
  assert.equal(presentation.length, 1);
  assert.doesNotMatch(JSON.stringify(presentation), /secret-id|secret-token|private-id/);
  assert.match(JSON.stringify(presentation), /https:\/\/example\.com\/docs/);
  assert.deepEqual(presentation[0], {
    threadId: 'owned-thread',
    input: {
      kind: 'delivery',
      text: 'Continua em segurança ou aprova. Consulta https://example.com/docs.',
      attachments: 'none',
      secureAction: true,
    },
  });
  const ordinary = 'Consulta [a fatura](https://merchant.example/payments/invoice).';
  assert.equal(await channelReply(ordinary, { threadId: 'owned-thread', present }), ordinary);
  assert.equal(presentation.length, 1);
  const imageReply = await channelReply(
    'O ficheiro está anexado. [Imagem](http://localhost:4310/api/artifacts/private-file)',
    { threadId: 'owned-thread', present, deliversAttachments: true },
  );
  assert.equal(imageReply, 'Continua na aplicação Otto.');
  assert.deepEqual(presentation[1], {
    threadId: 'owned-thread',
    input: {
      kind: 'delivery',
      text: 'O ficheiro está anexado. Imagem',
      attachments: 'pending',
      secureAction: false,
    },
  });
  assert.equal(
    await channelReply('', { threadId: 'owned-thread', present, deliversAttachments: true }),
    '',
  );
  const fileReply = await channelReply(
    `Relatório pronto. [Relatório](/api/artifacts/${privateFileId})`,
    {
      threadId: 'owned-thread',
      present,
      hasAttachments: true,
      privateLinks: [
        { name: 'report.csv', url: `https://otto.example/api/artifacts/${privateFileId}` },
      ],
    },
  );
  assert.match(fileReply, /report\.csv/);
  assert.equal((fileReply.match(/https:\/\/otto\.example\/api\/artifacts\//g) ?? []).length, 1);
  assert.equal(presentation.length, 2);
  await channelReply('Relatório pronto.', {
    threadId: 'owned-thread',
    present,
    hasAttachments: true,
  });
  assert.equal(presentation.length, 3);
  assert.equal(
    (presentation[2] as { input: { attachments: string } }).input.attachments,
    'in_otto',
  );
  const memoryReply = await channelReply(
    '[Memória](https://otto.example/memory) e https://otto.example/usage. Consulta https://merchant.example/memory.',
    { threadId: 'owned-thread', present, appOrigin: 'https://otto.example' },
  );
  assert.equal(memoryReply, 'Continua na aplicação Otto.');
  const memoryPresentation = presentation.at(-1) as { input: { secureAction: boolean } };
  assert.equal(memoryPresentation.input.secureAction, true);
  assert.doesNotMatch(JSON.stringify(memoryPresentation), /otto\.example/);
  assert.match(JSON.stringify(memoryPresentation), /Memória/);
  assert.match(JSON.stringify(memoryPresentation), /https:\/\/merchant\.example\/memory/);
});

test('channel presentation rejects failed or unsafe generated output before provider delivery', async () => {
  for (const generated of [
    '',
    'https://otto.example/credentials/secret-id',
    '[Memória](https://otto.example/memory)',
    'https://otto.example/usage',
    '[Continua](/payments/private-id)',
    '[Ficheiro](/api/artifacts/private-id)',
  ]) {
    await assert.rejects(
      channelReply('/credentials/request-id', {
        threadId: 'owned-thread',
        appOrigin: 'https://otto.example',
        present: async () => generated,
      }),
    );
  }
  await assert.rejects(
    channelReply('/credentials/request-id', {
      threadId: 'owned-thread',
      present: async () => {
        throw new Error('Synthetic generation failure');
      },
    }),
  );
  await assert.rejects(channelReply('/credentials/request-id', { threadId: 'owned-thread' }));
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
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      appOrigin: 'https://otto.example',
      present: async (_thread, input) => {
        assert.equal(input.kind, 'delivery');
        assert.doesNotMatch(JSON.stringify(input), /private-token|api\/artifacts/);
        return 'Continua na aplicação Otto.';
      },
      transport: createChatSdkTransport(pool, fixtureEnv),
      resolveAttachments: async (resolvedThreadId, ids) => {
        assert.equal(resolvedThreadId, threadId);
        if (ids.length !== 1 || ids[0] !== whatsappFileId)
          throw new Error('Attachment unavailable.');
        return [attachment('research.csv', 'text/csv', 'A,B\n1,2\n')];
      },
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client, channel) => {
        const turnId = await fixtureTurn(client, threadId, 'local-development', channel, sourceId);
        if (failSubmit) throw new Error('Fixture turn queue unavailable.');
        return turnId;
      },
    });
    channels.registerRoutes(app);
    const telegramPayload = (id: number, from = 123456, type = 'private') => ({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        text: 'Help with a fixture task',
        from: { id: from, is_bot: false, first_name: 'Fixture' },
        chat: { id: from, type },
      },
    });
    const whatsappPayload = (
      id: string,
      from = '351910000000',
      phone = '555000',
      timestamp = Math.floor(Date.now() / 1000),
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
    ) => {
      const row = (
        await pool.query('SELECT turn_id FROM channel_inbox WHERE source_id=$1', [sourceId])
      ).rows[0];
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments) VALUES($1,'local-development','assistant',$2,$3,$4,$5)",
        [id, text, threadId, row.turn_id, JSON.stringify(attachments)],
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
      await addReply('channel:whatsapp:555000:wamid.good');
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
      assert.equal(sent.length, 4);
      assert.equal((sent[3].body.text as { body: string }).body, 'Continua na aplicação Otto.');
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            missingReply,
          ])
        ).rows[0],
        { state: 'sent', reason: null },
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
      assert.equal(sent.length, 4);

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
      assert.equal(sent.length, 4);

      const paragraphs = Array.from({ length: 30 }, (_, index) =>
        `Paragraph ${index} ${'detail '.repeat(40)}`.trim(),
      );
      await addReply('channel:telegram:987:123456:10', paragraphs.join('\n\n'));
      await channels.drain();
      const parts = sent
        .slice(4)
        .map((message) =>
          String(
            (message.body.rich_message as { markdown?: string })?.markdown ?? message.body.text,
          ),
        );
      assert.ok(parts.length > 1 && parts.every((part) => part.length <= 4096));
      assert.ok(paragraphs.every((paragraph) => parts.some((part) => part.includes(paragraph))));

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
        present: async (_thread, input) => {
          assert.equal(input.kind, 'delivery');
          assert.equal(input.attachments, 'in_otto');
          return 'Consulta os ficheiros na aplicação Otto.';
        },
        resolveAttachments: async (_threadId, ids) => {
          if (ids.length !== 1 || ids[0] !== whatsappFileId)
            throw new Error('Attachment unavailable.');
          return [attachment('research.csv', 'text/csv', 'A,B\n1,2\n')];
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
        assert.match(fallbackText, /Consulta os ficheiros na aplicação Otto/);
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
