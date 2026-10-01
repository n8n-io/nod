import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import type { WorkAdmission } from './work-admission.ts';
import type {
  ChannelPairingRequest,
  InboundMessage,
  MessagingAttachment,
  MessagingTransport,
} from '../ports/messaging.ts';

interface ChannelOptions {
  admission?: WorkAdmission;
  ownerId: string;
  transport: MessagingTransport;
  acceptVerification?: (
    text: string,
    input: {
      clientMessageId: string;
      channel: string;
      persistOrdinary: (client: PoolClient) => Promise<void>;
    },
  ) => Promise<{ turnId?: string | null; messageText?: string } | undefined>;
  submit: (
    text: string,
    sourceId: string,
    client: PoolClient,
    channel: string,
    messageId: string,
  ) => Promise<string>;
  subscribe: (listener: () => void) => () => void;
  intervalMs?: number;
  resolveAttachments?: (threadId: string, ids: string[]) => Promise<MessagingAttachment[]>;
  appOrigin?: string;
  pair?: (request: ChannelPairingRequest) => Promise<unknown>;
}
interface ChannelIdentity {
  provider: string;
  account_id: string;
  sender_id: string;
}
interface InboxRow extends ChannelIdentity {
  source_id: string;
  text: string;
  message_id: string | null;
}
interface OutboxRow extends ChannelIdentity {
  message_id: string;
  owner_id: string;
  message_thread_id: string | null;
  thread_id: string;
  text: string;
  attachments: unknown[];
}
const messageSchema = z.object({
  channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  accountId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(1024),
  text: z.string().trim().min(1).max(24000),
  sentAt: z.date(),
});

function conversationChannel(row: ChannelIdentity) {
  const identity = createHash('sha256')
    .update(JSON.stringify([row.account_id, row.sender_id]))
    .digest('hex')
    .slice(0, 32);
  return `${row.provider}:${identity}`;
}

function inboundMessageId(ownerId: string, sourceId: string) {
  const bytes = createHash('sha256')
    .update(JSON.stringify([ownerId, sourceId]))
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = bytes.subarray(0, 16).toString('hex');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function channelReply(
  text: string,
  hasAttachments = false,
  deliversAttachments = false,
  privateLinks: { name: string; url: string }[] = [],
) {
  const securePath = '(?:https?:\\/\\/[^\\s)]+)?\\/(?:vault|credentials|approvals)\\/[^\\s)]+';
  const safe = text
    .replace(
      /\[[^\]]*\]\((?:https?:\/\/[^\s)]+)?\/api\/artifacts\/[^\s)]+\)|(?:https?:\/\/[^\s)]+)?\/api\/artifacts\/[^\s)]+/g,
      deliversAttachments
        ? 'Attached file.'
        : privateLinks.length
          ? 'See the file link below.'
          : 'Open Otto to view this file.',
    )
    .replace(
      new RegExp(`\\[[^\\]]*\\]\\(${securePath}\\)|${securePath}`, 'g'),
      'Open Otto to continue securely.',
    );
  const files = privateLinks.length
    ? `Files:\n${privateLinks.map(({ name, url }) => `${name.replace(/[\r\n]/g, ' ')}: ${url}`).join('\n')}`
    : hasAttachments
      ? 'Attachments are available in Otto.'
      : '';
  return (
    `${safe}${files ? `\n\n${files}` : ''}`.trim() ||
    (deliversAttachments ? '' : 'A reply is available in Otto.')
  );
}

export async function createChannels(pool: Pool, options: ChannelOptions) {
  const { ownerId } = options;
  const appOrigin = (() => {
    try {
      const url = new URL(options.appOrigin ?? '');
      return url.protocol === 'https:' ? url.origin : undefined;
    } catch {
      return undefined;
    }
  })();
  let transport = options.transport;
  let channels = transport.channels.map((channel) => ({
    ...channel,
    allowedSenderIds: [...channel.allowedSenderIds],
  }));
  let configuration = channels.map((channel) => ({
    provider: channel.id,
    status: channel.status,
    missing: channel.missing,
  }));
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_inbox (
    source_id text PRIMARY KEY, provider text NOT NULL, account_id text NOT NULL, sender_id text NOT NULL,
    thread_id text NOT NULL, text text NOT NULL, received_at timestamptz NOT NULL,
    turn_id uuid REFERENCES turns(id), state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(),
    message_id uuid, owner_id text NOT NULL, channel text
  );
  CREATE TABLE IF NOT EXISTS channel_outbox (
    message_id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES channel_inbox(source_id),
    state text NOT NULL DEFAULT 'pending', provider_message_id text, reason text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS channel_inbox_pending ON channel_inbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_outbox_pending ON channel_outbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_inbox_turn ON channel_inbox(turn_id);
  CREATE INDEX IF NOT EXISTS channel_inbox_channel ON channel_inbox(owner_id,channel,state,received_at DESC)`);
  await pool.query(
    "UPDATE channel_outbox o SET state='uncertain',reason='interrupted_send',updated_at=now() FROM channel_inbox i WHERE o.source_id=i.source_id AND i.owner_id=$1 AND o.state='sending'",
    [ownerId],
  );
  let closed = false;
  let replacing = false;
  let running: Promise<void> | undefined;
  let drainRequested = false;
  let lastError: string | null = null;

  function permitted(row: ChannelIdentity) {
    return channels.some(
      (channel) =>
        channel.id === row.provider &&
        channel.status === 'configured' &&
        channel.accountId === row.account_id &&
        channel.allowedSenderIds.includes(row.sender_id),
    );
  }

  async function accept(message: InboundMessage, channelId: string) {
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success || parsed.data.channelId !== channelId) return;
    const { accountId, senderId, messageId, threadId, text, sentAt } = parsed.data;
    const identity = { provider: channelId, account_id: accountId, sender_id: senderId };
    if (closed || replacing || !permitted(identity) || sentAt.getTime() > Date.now() + 300000)
      return;
    try {
      const sourceId = `channel:${channelId}:${accountId}:${messageId}`;
      if (
        (
          await pool.query('SELECT 1 FROM channel_inbox WHERE source_id=$1 AND owner_id=$2', [
            sourceId,
            ownerId,
          ])
        ).rowCount
      )
        return;
      const acceptedMessageId = inboundMessageId(ownerId, sourceId);
      let verification: Awaited<ReturnType<NonNullable<ChannelOptions['acceptVerification']>>>;
      let ordinaryPersisted = false;
      const persist = async (database: PoolClient) => {
        if (closed || replacing || !permitted(identity))
          throw new Error('Channel configuration changed.');
        await database.query(
          `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,turn_id,owner_id,channel)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(source_id) DO NOTHING`,
          [
            sourceId,
            channelId,
            accountId,
            senderId,
            threadId,
            verification ? (verification.messageText ?? 'Verification code sent securely.') : text,
            sentAt,
            acceptedMessageId,
            verification ? 'submitted' : 'pending',
            verification?.turnId ?? null,
            ownerId,
            conversationChannel(identity),
          ],
        );
        if (closed || replacing || !permitted(identity))
          throw new Error('Channel configuration changed.');
      };
      if (classifyVerificationReply(text).kind !== 'ordinary' && options.acceptVerification) {
        try {
          verification = await options.acceptVerification(text, {
            clientMessageId: acceptedMessageId,
            channel: conversationChannel(identity),
            persistOrdinary: async (client) => {
              await persist(client);
              ordinaryPersisted = true;
            },
          });
          if (!verification && !ordinaryPersisted)
            throw new Error('Verification did not persist its receipt.');
        } catch (cause) {
          const conflict =
            cause instanceof Error && 'statusCode' in cause && cause.statusCode === 409;
          if (!conflict) throw cause;
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            if (closed || replacing || !permitted(identity))
              throw new Error('Channel configuration changed.');
            const receipt = await client.query(
              `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,owner_id,channel)
             VALUES($1,$2,$3,$4,$5,'Verification code not applied.',$6,$7,'discarded',$8,$9)
             ON CONFLICT(source_id) DO NOTHING`,
              [
                sourceId,
                channelId,
                accountId,
                senderId,
                threadId,
                sentAt,
                acceptedMessageId,
                ownerId,
                conversationChannel(identity),
              ],
            );
            if (receipt.rowCount) {
              const replyId = randomUUID();
              await client.query(
                "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,$2,'assistant',$3,(SELECT id FROM threads WHERE owner_id=$2 AND archived_at IS NULL))",
                [
                  replyId,
                  ownerId,
                  'The code could not be matched to a sign-in. Open the corresponding sign-in conversation in Otto web chat to continue.',
                ],
              );
              await client.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
                replyId,
                sourceId,
              ]);
            }
            if (closed || replacing || !permitted(identity))
              throw new Error('Channel configuration changed.');
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
          return;
        }
      }
      if (!ordinaryPersisted) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await persist(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    } catch {
      throw Object.assign(new Error('Channel processing is temporarily unavailable. Try again.'), {
        statusCode: 503,
      });
    }
  }

  async function completePairing(request: ChannelPairingRequest) {
    if (closed || !options.pair) return;
    try {
      await options.pair(request);
    } catch {
      throw Object.assign(new Error('Channel processing is temporarily unavailable. Try again.'), {
        statusCode: 503,
      });
    }
  }

  async function announcePairing(
    request: {
      senderId: string;
      accountId: string;
      messageId: string;
      threadId: string;
      sentAt: string;
    },
    client: PoolClient,
  ) {
    const identity = {
      provider: 'telegram',
      account_id: request.accountId,
      sender_id: request.senderId,
    };
    const sourceId = `channel:telegram:${request.accountId}:${request.messageId}`;
    if (closed || replacing || !permitted(identity))
      throw new Error('Channel configuration changed.');
    const receipt = await client.query(
      `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,owner_id,channel)
       VALUES($1,'telegram',$2,$3,$4,'/start',$5,$6,'discarded',$7,$8) ON CONFLICT(source_id) DO NOTHING`,
      [
        sourceId,
        request.accountId,
        request.senderId,
        request.threadId,
        request.sentAt,
        inboundMessageId(ownerId, sourceId),
        ownerId,
        conversationChannel(identity),
      ],
    );
    if (receipt.rowCount) {
      const replyId = randomUUID();
      await client.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,$2,'assistant',$3,(SELECT id FROM threads WHERE owner_id=$2 AND archived_at IS NULL))",
        [replyId, ownerId, 'Otto is connected. Send a message to start.'],
      );
      await client.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
        replyId,
        sourceId,
      ]);
    }
    return () => {
      void drain();
    };
  }

  async function drainInbox() {
    for (let index = 0; index < 25 && !closed && !replacing; index++) {
      const pending = (
        await pool.query<InboxRow>(
          "SELECT * FROM channel_inbox WHERE state='pending' AND owner_id=$1 ORDER BY created_at LIMIT 1",
          [ownerId],
        )
      ).rows[0];
      if (!pending) break;
      const channel = conversationChannel(pending);
      if (closed || replacing) break;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<InboxRow>(
          "SELECT * FROM channel_inbox WHERE state='pending' AND source_id=$1 AND owner_id=$2 FOR UPDATE SKIP LOCKED",
          [pending.source_id, ownerId],
        );
        const row = result.rows[0];
        if (!row) {
          await client.query('COMMIT');
          continue;
        }
        if (!permitted(row)) {
          await client.query(
            "UPDATE channel_inbox SET state='discarded' WHERE source_id=$1 AND owner_id=$2",
            [row.source_id, ownerId],
          );
        } else {
          const messageId = row.message_id ?? randomUUID();
          const turnId = await options.submit(row.text, row.source_id, client, channel, messageId);
          await client.query(
            "UPDATE channel_inbox SET state='submitted',turn_id=$2,message_id=$3,channel=$5 WHERE source_id=$1 AND owner_id=$4",
            [row.source_id, turnId, messageId, ownerId, channel],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async function drainOutbox() {
    await pool.query(
      `INSERT INTO channel_outbox(message_id,source_id)
      SELECT DISTINCT ON (m.id) m.id,i.source_id FROM messages m
      JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
      JOIN channel_inbox i ON i.channel=u.channel AND i.owner_id=m.owner_id AND i.created_at<=m.created_at
        AND (u.channel_source_id IS NULL OR i.source_id=u.channel_source_id)
      WHERE m.role='assistant' AND m.owner_id=$1 AND i.state='submitted'
      ORDER BY m.id,(i.turn_id IS NOT DISTINCT FROM m.turn_id) DESC,i.received_at DESC,i.source_id
      ON CONFLICT(message_id) DO NOTHING`,
      [ownerId],
    );
    for (let index = 0; index < 25 && !closed && !replacing; index++) {
      const result = await pool.query<OutboxRow>(
        `WITH claimed AS (
        UPDATE channel_outbox SET state='sending',updated_at=now() WHERE message_id=(
          SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id JOIN messages m ON m.id=o.message_id WHERE o.state='pending' AND i.owner_id=$1 AND m.owner_id=$1 ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
        ) RETURNING message_id,source_id
      ) SELECT c.message_id,m.owner_id,m.thread_id AS message_thread_id,i.provider,i.account_id,i.sender_id,i.thread_id,m.text,m.attachments
        FROM claimed c JOIN channel_inbox i ON i.source_id=c.source_id JOIN messages m ON m.id=c.message_id`,
        [ownerId],
      );
      const row = result.rows[0];
      if (!row) break;
      let reason: string | null =
        row.owner_id !== ownerId
          ? 'message_owner_changed'
          : permitted(row)
            ? null
            : 'channel_access_changed';
      const replyWindowMs = channels.find((channel) => channel.id === row.provider)?.replyWindowMs;
      if (!reason && replyWindowMs !== undefined) {
        const latest = await pool.query(
          `SELECT max(received_at) AS at FROM channel_inbox
          WHERE provider=$1 AND account_id=$2 AND sender_id=$3 AND owner_id=$4`,
          [row.provider, row.account_id, row.sender_id, ownerId],
        );
        if (
          !latest.rows[0]?.at ||
          Date.now() - new Date(latest.rows[0].at).getTime() >= replyWindowMs
        )
          reason = 'reply_window_closed';
      }
      if (reason) {
        await pool.query(
          "UPDATE channel_outbox SET state='blocked',reason=$2,updated_at=now() WHERE message_id=$1",
          [row.message_id, reason],
        );
        continue;
      }
      let attachments: MessagingAttachment[] | undefined;
      let privateLinks: { name: string; url: string }[] = [];
      const canDeliverAttachments = channels.find(
        (channel) => channel.id === row.provider,
      )?.supportsAttachments;
      if (row.attachments?.length) {
        try {
          const requested = z
            .array(z.object({ id: z.uuid() }))
            .min(1)
            .max(10)
            .parse(row.attachments);
          const unique = [...new Map(requested.map((item) => [item.id, item])).values()];
          if (!options.resolveAttachments || !row.message_thread_id)
            throw new Error('Attachment delivery is unavailable.');
          const resolved = await options.resolveAttachments(
            row.message_thread_id,
            unique.map(({ id }) => id),
          );
          if (resolved.length !== unique.length)
            throw new Error('Attachment delivery is unavailable.');
          if (canDeliverAttachments) attachments = resolved;
          else if (appOrigin)
            privateLinks = unique.map(({ id }, index) => ({
              name: resolved[index].name,
              url: `${appOrigin}/api/artifacts/${id}`,
            }));
        } catch {
          await pool.query(
            "UPDATE channel_outbox SET state='blocked',reason='attachment_unavailable',updated_at=now() WHERE message_id=$1",
            [row.message_id],
          );
          continue;
        }
      }
      if (closed || replacing || !permitted(row)) {
        await pool.query(
          "UPDATE channel_outbox SET state='blocked',reason='channel_access_changed',updated_at=now() WHERE message_id=$1",
          [row.message_id],
        );
        continue;
      }
      try {
        const sent = await transport.post({
          channelId: row.provider,
          accountId: row.account_id,
          threadId: row.thread_id,
          text: channelReply(
            row.text,
            Boolean(row.attachments?.length) && !attachments,
            Boolean(attachments),
            privateLinks,
          ),
          ...(attachments ? { attachments } : {}),
        });
        await pool.query(
          "UPDATE channel_outbox SET state='sent',provider_message_id=$2,updated_at=now() WHERE message_id=$1",
          [row.message_id, sent.id],
        );
      } catch {
        await pool.query(
          "UPDATE channel_outbox SET state='uncertain',reason='send_not_confirmed',updated_at=now() WHERE message_id=$1",
          [row.message_id],
        );
      }
    }
  }

  function drain() {
    if (closed || replacing || options.admission?.paused || options.admission?.closed)
      return Promise.resolve();
    drainRequested = true;
    if (running) return running;
    const release = options.admission?.enter();
    if (options.admission && !release) return Promise.resolve();
    running = (async () => {
      let pollingFailed = false;
      try {
        while (drainRequested && !closed && !replacing && !options.admission?.paused) {
          drainRequested = false;
          try {
            await transport.poll?.(
              (message) => accept(message, message.channelId),
              completePairing,
            );
          } catch {
            pollingFailed = true;
          }
          await drainInbox();
          await drainOutbox();
        }
        lastError = pollingFailed
          ? 'Telegram could not check for new messages. Check its channel setup.'
          : null;
      } catch {
        lastError =
          'Channel processing needs attention. Check the local database and thread service.';
      } finally {
        running = undefined;
        release?.();
      }
    })();
    return running;
  }
  const unsubscribe = options.subscribe(() => {
    void drain();
  });
  const timer = setInterval(() => {
    void drain();
  }, options.intervalMs ?? 2000);
  timer.unref();

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    await running;
    await transport.close();
  }

  async function replaceTransport(next: MessagingTransport) {
    if (closed || replacing) {
      await next.close();
      throw new Error('Channel configuration is unavailable.');
    }
    replacing = true;
    try {
      await running;
      await transport.close();
      transport = next;
      channels = next.channels.map((channel) => ({
        ...channel,
        allowedSenderIds: [...channel.allowedSenderIds],
      }));
      configuration = channels.map((channel) => ({
        provider: channel.id,
        status: channel.status,
        missing: channel.missing,
      }));
      lastError = null;
    } finally {
      replacing = false;
    }
    void drain();
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', close);
    app.get('/api/channels', async () => ({
      channels: configuration,
      error: lastError,
      inbox: (
        await pool.query(
          'SELECT state,count(*)::int AS count FROM channel_inbox WHERE owner_id=$1 GROUP BY state',
          [ownerId],
        )
      ).rows,
      deliveries: (
        await pool.query(
          'SELECT o.state,count(*)::int AS count FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id WHERE i.owner_id=$1 GROUP BY o.state',
          [ownerId],
        )
      ).rows,
    }));
    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        '*',
        { parseAs: 'buffer', bodyLimit: 256 * 1024 },
        (_request, body, done) => done(null, body),
      );
      scope.route<{ Params: { provider: string } }>({
        method: ['GET', 'POST'],
        url: '/api/webhooks/:provider',
        async handler(request, reply) {
          if (replacing || closed)
            return reply.code(503).send({ error: 'Channel configuration is changing. Try again.' });
          const channelId = request.params.provider;
          if (
            !channels.some((channel) => channel.id === channelId && channel.status === 'configured')
          )
            return reply.code(404).send({ error: 'Channel is not configured.' });
          const currentTransport = transport;
          const result = await currentTransport.receive({
            channelId,
            method: request.method,
            headers: request.headers,
            query: request.query,
            body: Buffer.isBuffer(request.body) ? request.body : new Uint8Array(),
          });
          if (replacing || currentTransport !== transport)
            return reply.code(503).send({ error: 'Channel configuration changed. Try again.' });
          if (result.status >= 200 && result.status < 300) {
            for (const message of result.messages ?? []) await accept(message, channelId);
            if (result.messages?.length) void drain();
            if (result.pairing?.channelId === channelId) await completePairing(result.pairing);
          }
          if (result.contentType) reply.type(result.contentType);
          return reply.code(result.status).send(result.body);
        },
      });
    });
  }

  return { registerRoutes, drain, close, replaceTransport, announcePairing };
}
