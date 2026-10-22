import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createAgentReactionService } from '../src/server/agent-reactions.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createVault } from '../src/server/vault.ts';
import { locksTable } from '../src/server/locks.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';

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
  await pool.query(`${locksTable};
    CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,delivered_channel text,assistant_reaction text,assistant_reacted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
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
    const threadId = await createFixtureTables(pool, 'local-development');
    const turnId = await fixtureTurn(pool, threadId, 'local-development', 'web');
    const accepted: Array<{ clientMessageId: string; channel: string }> = [];
    const submitted: string[] = [];
    const sent: Array<{ channelId: string; accountId: string; threadId: string; text: string }> =
      [];
    let injections = 0;
    let verification: Awaited<ReturnType<typeof createChatVerification>> | undefined;
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
        ownerId: 'local-development',
        transport: transport(),
        present: async (thread) => {
          assert.equal(thread, threadId);
          return 'Usa o pedido de verificação na conversa correspondente.';
        },
        intervalMs: 600000,
        subscribe: () => () => {},
        acceptVerification: async (text, input) => {
          if (verification) return verification.accept(text, input);
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
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','user','Verification code sent securely.',$2,$3) ON CONFLICT(id) DO NOTHING",
            [input.clientMessageId, threadId, turnId],
          );
          if (stored.rowCount) injections++;
          return { turnId, messageText: 'Verification code sent securely.' };
        },
        submit: async (text, sourceId, client, channel) => {
          submitted.push(text);
          return fixtureTurn(client, threadId, 'local-development', channel, sourceId);
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
      assert.equal(sent.length, 1);
      assert.deepEqual(
        { channelId: sent[0].channelId, accountId: sent[0].accountId, threadId: sent[0].threadId },
        { channelId: 'telegram', accountId: 'fixture-account', threadId: 'fixture-thread' },
      );
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

      const keyStore = {
        id: 'fixture',
        configured: true,
        getKey: async () => Buffer.alloc(32, 71),
      };
      let vaultInjections = 0;
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore,
        page: async () => ({ url: 'https://1.1.1.1/login', origin: 'https://1.1.1.1' }),
        inject: async (input) => {
          assert.equal(input.code, '481927');
          vaultInjections++;
        },
        resume: async () => {},
        retry: async () => {},
      });
      verification = await createChatVerification(pool, {
        ownerId: 'local-development',
        keyStore,
        submitCode: vault.submitChatCode,
        refresh() {},
      });
      const codeTurnId = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        accepted[0].channel,
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
      await fixture.channels.drain();
      assert.equal(vaultInjections, 0);
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [codeTurnId],
      );
      assert.equal((await send('vault-code', 'Código: 481 927')).statusCode, 200);
      await fixture.channels.drain();
      assert.equal(vaultInjections, 1);
      assert.deepEqual(submitted, ['2026']);
      assert.doesNotMatch(
        JSON.stringify(
          (await pool.query('SELECT text FROM channel_inbox UNION ALL SELECT text FROM messages'))
            .rows,
        ),
        /481927/,
      );
      verification = undefined;

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

test('channel presentation isolates private links from the model and rejects unsafe generated output', async () => {
  const presentation: unknown[] = [];
  const present = async (threadId: string | null, input: unknown) => {
    presentation.push({ threadId, input });
    return 'Continua na aplicação Otto.';
  };
  await channelReply(
    'Continua [em segurança](/credentials/secret-id?token=secret-token) ou [aprova](http://localhost:4310/payments/private-id). Consulta https://example.com/docs.',
    { threadId: 'owned-thread', present },
  );
  assert.equal(presentation.length, 1);
  assert.doesNotMatch(JSON.stringify(presentation), /secret-id|secret-token|private-id/);
  assert.match(JSON.stringify(presentation), /https:\/\/example\.com\/docs/);
  const ordinary = 'Consulta [a fatura](https://merchant.example/payments/invoice).';
  assert.equal(await channelReply(ordinary, { threadId: 'owned-thread', present }), ordinary);
  assert.equal(presentation.length, 1);
  await channelReply('Save it in Otto: /trust?add=login', { threadId: 'owned-thread', present });
  assert.doesNotMatch(JSON.stringify(presentation), /trust\?add/);
  for (const generated of [
    '',
    'http://localhost:4310/credentials/secret-id',
    '[Continua](/payments/private-id)',
    '[Ficheiro](/api/artifacts/private-id)',
  ]) {
    await assert.rejects(
      channelReply('/credentials/request-id', {
        threadId: 'owned-thread',
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
    let failReaction = false;
    const reacting: { provider: string; body: Record<string, unknown> }[] = [];
    const reactedTo: [string, string | null][] = [];
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
        if (url === 'https://api.telegram.org/bot987:fixture-not-live/setMessageReaction') {
          reacting.push({ provider: 'telegram', body });
          if (failReaction) throw new Error('Fixture reaction delivery is uncertain.');
          return Response.json({ ok: true, result: true });
        }
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
          if (body.type === 'reaction') {
            reacting.push({ provider: 'whatsapp', body });
            return Response.json({
              messages: [{ id: `wamid.fixture-reaction-${reacting.length}` }],
            });
          }
          sent.push({ provider: 'whatsapp', body });
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      present: async (_thread, input) => {
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
      reacted: async (messageId, reaction) => {
        reactedTo.push([messageId, reaction]);
      },
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
        'Finish [securely](/credentials/private-token), [approve payment](/payments/private-token) or [add a card](/trust?add=card).',
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
      assert.doesNotMatch(fileText, /api\/artifacts/);
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
      assert.equal(JSON.stringify(sent).includes('/trust?add='), false);
      assert.equal(JSON.stringify(sent).includes('Unrelated web-only'), false);
      await channels.drain();
      assert.equal(sent.length, 4);

      const idOf = async (query: string) => (await pool.query(query)).rows[0].message_id;
      const ownerMessage = await idOf(
        "SELECT message_id FROM channel_inbox WHERE source_id='channel:telegram:987:123456:10'",
      );
      const telegramReply = await idOf(
        "SELECT message_id FROM channel_outbox WHERE provider_message_id='123456:101'",
      );
      const whatsappReply = await idOf(
        "SELECT message_id FROM channel_outbox WHERE provider_message_id='wamid.fixture-out-2'",
      );
      const telegramReaction = (messageId: number, emoji: string[], from = 123456) => ({
        update_id: 500 + reactedTo.length,
        message_reaction: {
          chat: { id: from, type: 'private' },
          message_id: messageId,
          user: { id: from, is_bot: false, first_name: 'Fixture' },
          date: Math.floor(Date.now() / 1000),
          old_reaction: [],
          new_reaction: emoji.map((value) => ({ type: 'emoji', emoji: value })),
        },
      });
      const whatsappReaction = (target: string, emoji: string, from = '351910000000') => ({
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
                      id: `wamid.reaction-${randomUUID()}`,
                      from,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'reaction',
                      reaction: { message_id: target, emoji },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      await pool.query(
        'UPDATE channel_outbox SET provider_message_ids=ARRAY[provider_message_id,$2] WHERE message_id=$1',
        [telegramReply, '123456:102'],
      );
      await sendTelegram(telegramReaction(102, ['👍']));
      await sendTelegram(telegramReaction(101, ['🔥'], 456789));
      await sendTelegram(telegramReaction(10, ['👍']));
      await sendTelegram(telegramReaction(101, []));
      await sendTelegram(telegramReaction(101, ['❤']));
      await sendTelegram(telegramReaction(101, ['🤷‍♂']));
      await sendTelegram(telegramReaction(101, ['🤷‍♀']));
      await sendWhatsApp(whatsappReaction('wamid.fixture-out-2', '❤️'));
      await sendWhatsApp(whatsappReaction('wamid.fixture-out-2', '😂', '351920000000'));
      await sendWhatsApp(whatsappReaction('123456:101', '😂'));
      assert.deepEqual(reactedTo, [
        [telegramReply, '👍'],
        [telegramReply, null],
        [telegramReply, '❤️'],
        [telegramReply, '🤷‍♂️'],
        [telegramReply, '🤷‍♀️'],
        [whatsappReply, '❤️'],
      ]);
      const whatsappOwnerMessage = await idOf(
        "SELECT message_id FROM channel_inbox WHERE source_id='channel:whatsapp:555000:wamid.good'",
      );
      assert.equal(await channels.react(ownerMessage, '👍'), 'sent');
      assert.equal(await channels.react(ownerMessage, '🫠'), 'unsupported');
      assert.equal(await channels.react(ownerMessage, null), 'sent');
      assert.equal(await channels.react(whatsappOwnerMessage, '❤️'), 'sent');
      assert.equal(await channels.react(randomUUID(), '👍'), 'absent');
      assert.deepEqual(
        reacting.map(({ provider, body }) => [provider, body.message_id ?? body.reaction]),
        [
          ['telegram', 10],
          ['telegram', 10],
          ['whatsapp', { message_id: 'wamid.good', emoji: '❤️' }],
        ],
      );
      assert.deepEqual(
        reacting.slice(0, 2).map(({ body }) => body.reaction),
        [[{ type: 'emoji', emoji: '👍' }], []],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,'local-development','user','Synthetic request',$2)",
        [ownerMessage, threadId],
      );
      const reactions = createAgentReactionService({
        pool,
        ownerId: 'local-development',
        refresh() {},
        deliver: channels.react,
      });
      const reactionTurn = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        'telegram',
        null,
        'running',
      );
      const react = (reaction: string | null) =>
        reactions.react({ threadId, turnId: reactionTurn, messageId: ownerMessage, reaction });
      const storedReaction = async () =>
        (
          await pool.query(
            'SELECT assistant_reaction,assistant_reacted_at FROM messages WHERE id=$1',
            [ownerMessage],
          )
        ).rows[0];
      assert.deepEqual(await react('🫠'), { status: 'skipped', reason: 'unsupported' });
      assert.deepEqual(await storedReaction(), {
        assistant_reaction: null,
        assistant_reacted_at: null,
      });
      failReaction = true;
      assert.deepEqual(await react('👍'), { status: 'skipped', reason: 'delivery_failed' });
      assert.equal((await storedReaction()).assistant_reaction, '👍');
      assert.ok((await storedReaction()).assistant_reacted_at);
      const reactionAttempts = reacting.length;
      assert.deepEqual(await react('👍'), { status: 'unchanged' });
      assert.equal(reacting.length, reactionAttempts);
      failReaction = false;
      await pool.query(
        'UPDATE messages SET assistant_reaction=NULL,assistant_reacted_at=NULL WHERE id=$1',
        [ownerMessage],
      );
      assert.deepEqual(await react('👍'), { status: 'updated' });
      failReaction = true;
      assert.deepEqual(await react(null), { status: 'skipped', reason: 'delivery_failed' });
      assert.equal((await storedReaction()).assistant_reaction, '👍');
      failReaction = false;
      assert.deepEqual(await react(null), { status: 'updated' });
      const aborted = new AbortController();
      aborted.abort();
      const beforeCancel = reacting.length;
      await assert.rejects(channels.react(ownerMessage, '👍', aborted.signal));
      assert.equal(reacting.length, beforeCancel);

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
        present: async () => 'Consulta os ficheiros na aplicação Otto.',
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
        assert.doesNotMatch(JSON.stringify(sent.at(-1)?.body), /api\/artifacts/);
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
