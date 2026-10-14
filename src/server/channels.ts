import { createHash, randomUUID } from 'node:crypto';
import type { Artifact, Task } from '../shared/contracts.ts';
import { completedSteps, isOpenTask, taskLabels, taskSummary } from '../shared/tasks.ts';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { classifyVerificationReply, securityCodeIn } from '../shared/verification-code.ts';
import { logFailure } from './failure-log.ts';
import { markdownPdf } from './pdf.ts';
import type { WorkAdmission } from './work-admission.ts';
import {
  MessagingPartialSend,
  MessagingRetryLater,
  type ChannelPairingRequest,
  type InboundMessage,
  type InboundPress,
  type MessagingAttachment,
  type MessagingButton,
  type MessagingTransport,
} from '../ports/messaging.ts';
import { loopbackHost } from '../shared/loopback.ts';
import type { ChatConfirmationInput } from './approvals.ts';

const replyCommand = /^\/(memory|context|usage)(?:@[A-Za-z0-9_]+)?$/i;
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const pressData = new RegExp(`^(?:a:(${uuid}):([yn])|s:(${uuid}))$`);

interface TaskMessages {
  tasks: Task[];
  confirmations: { id: string; messageId: string }[];
}

interface ChannelOptions {
  admission?: WorkAdmission;
  ownerId: string;
  transport: MessagingTransport;
  acceptVerification?: (
    text: string,
    input: {
      clientMessageId: string;
      channel: string;
      replyToMessageId?: string;
      persistOrdinary: (client: PoolClient) => Promise<void>;
    },
  ) => Promise<{ turnId?: string | null; messageText?: string } | undefined>;
  submit: (
    text: string,
    sourceId: string,
    client: PoolClient,
    channel: string,
    messageId: string,
    answer?: ChatConfirmationInput['answer'],
    replyToMessageId?: string,
  ) => Promise<string>;
  answer?: (
    text: string,
    channel: string,
    replyToMessageId?: string,
  ) => Promise<ChatConfirmationInput['answer']>;
  subscribe: (listener: () => void) => () => void;
  refresh?: () => void;
  intervalMs?: number;
  resolveAttachments?: (threadId: string, ids: string[]) => Promise<MessagingAttachment[]>;
  appOrigin?: string;
  pair?: (request: ChannelPairingRequest) => Promise<unknown>;
  activeThread?: (client: PoolClient) => Promise<{ id: string }>;
  commandReply?: (
    command: 'memory' | 'usage',
    client: PoolClient,
    threadId: string | null,
    link: string | null,
  ) => Promise<{ text: string; attachments: Artifact[] }>;
  press?: (
    action: { approvalId: string; approved: boolean } | { taskId: string },
    channel: string,
  ) => Promise<unknown>;
  taskMessages?: (messageIds: string[]) => Promise<TaskMessages>;
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
  reply_provider_id: string | null;
}
interface OutboxRow extends ChannelIdentity {
  message_id: string;
  owner_id: string;
  message_thread_id: string | null;
  thread_id: string;
  text: string;
  attachments: unknown[];
  reply_to: string | null;
}
interface EditRow extends ChannelIdentity {
  message_id: string;
  original: string;
  text: string;
  buttons: MessagingButton[];
  revision: number;
  state: string;
  final: boolean;
  due: boolean;
  thread_id: string;
  provider_id: string;
}
const messageSchema = z.object({
  channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  accountId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(1024),
  text: z.string().trim().min(1).max(24000),
  sentAt: z.date(),
  replyTo: z.string().min(1).max(256).optional(),
});
const pressSchema = z.object({
  channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  accountId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  pressId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(1024),
  data: z.string().min(1).max(256),
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

function liveMessage(messageId: string, text: string, previews: boolean, view: TaskMessages) {
  const task = previews ? view.tasks.find((item) => item.onItMessageId === messageId) : undefined;
  if (task) {
    const open = isOpenTask(task);
    const steps = task.steps.length
      ? `\n${completedSteps(task)} of ${task.steps.length} steps`
      : '';
    return {
      text: `${text}\n\n${task.title} · ${taskLabels[task.status]}\n${taskSummary(task)}${steps}`,
      buttons: open ? [{ id: `s:${task.id}`, title: 'Stop task' }] : [],
      final: !open,
    };
  }
  const asking = view.confirmations.find((item) => item.messageId === messageId);
  return asking
    ? {
        text,
        buttons: [
          { id: `a:${asking.id}:y`, title: 'Yes' },
          { id: `a:${asking.id}:n`, title: 'No' },
        ],
        final: false,
      }
    : undefined;
}

async function documentPdf(file: MessagingAttachment): Promise<MessagingAttachment> {
  const bytes =
    file.mimeType === 'text/markdown'
      ? await markdownPdf(Buffer.from(file.bytes).toString('utf8'))
      : undefined;
  return bytes
    ? {
        name: `${file.name.replace(/\.(?:md|markdown)$/i, '')}.pdf`,
        mimeType: 'application/pdf',
        bytes,
      }
    : file;
}

export function channelReply(
  text: string,
  hasAttachments = false,
  deliversAttachments = false,
  privateLinks: { name: string; url: string }[] = [],
  appOrigin?: string,
) {
  const securePath =
    '(?:https?:\\/\\/[^\\s)]+)?\\/(?:vault\\?add=(?:login|card)[^\\s)]*|(?:vault|credentials|payments|approvals)\\/[^\\s)]+)';
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
      new RegExp(`\\[[^\\]]*\\]\\((${securePath})\\)|(${securePath})`, 'g'),
      (match, linked: string | undefined, plain: string | undefined) => {
        try {
          const url = new URL(linked ?? plain!);
          if (
            url.host !== (appOrigin ? new URL(appOrigin).host : undefined) &&
            !loopbackHost(url.hostname)
          )
            return match;
        } catch {}
        return 'Open Otto to continue securely.';
      },
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
    state text NOT NULL DEFAULT 'pending', reason text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS channel_inbox_pending ON channel_inbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_outbox_pending ON channel_outbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_inbox_turn ON channel_inbox(turn_id);
  CREATE INDEX IF NOT EXISTS channel_inbox_channel ON channel_inbox(owner_id,channel,state,received_at DESC);
  CREATE INDEX IF NOT EXISTS channel_inbox_message ON channel_inbox(message_id);
  ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS reply_provider_id text;
  ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS provider_message_ids text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS retry_at timestamptz;
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='channel_outbox'::regclass
      AND attname='provider_message_id' AND NOT attisdropped) THEN
      UPDATE channel_outbox SET provider_message_ids=ARRAY[provider_message_id]
        WHERE provider_message_id IS NOT NULL AND provider_message_ids='{}';
      ALTER TABLE channel_outbox DROP COLUMN provider_message_id;
    END IF;
  END $$;
  CREATE INDEX IF NOT EXISTS channel_outbox_provider_ids ON channel_outbox USING gin(provider_message_ids);
  CREATE TABLE IF NOT EXISTS channel_edits (
    message_id uuid PRIMARY KEY REFERENCES channel_outbox(message_id), owner_id text NOT NULL,
    text text NOT NULL, buttons jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 0,
    state text NOT NULL DEFAULT 'sent', final boolean NOT NULL DEFAULT false, retry_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS channel_edits_live ON channel_edits(owner_id) WHERE NOT final OR state='pending'`);
  await pool.query(
    "UPDATE channel_outbox o SET state='uncertain',reason='interrupted_send',updated_at=now() FROM channel_inbox i WHERE o.source_id=i.source_id AND i.owner_id=$1 AND o.state='sending'",
    [ownerId],
  );
  let closed = false;
  let replacing = false;
  let running: Promise<void> | undefined;
  let drainRequested = false;
  let lastError: string | null = null;

  async function replyWithoutTurn(
    client: PoolClient,
    inbox: ChannelIdentity & {
      sourceId: string;
      threadId: string;
      sentAt: Date | string;
      text: string;
    },
    compose: (
      threadId: string | null,
    ) =>
      | Promise<{ text: string; attachments?: Artifact[] }>
      | { text: string; attachments?: Artifact[] }
      | undefined,
  ) {
    if (closed || replacing || !permitted(inbox)) throw new Error('Channel configuration changed.');
    const receipt = await client.query(
      `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,owner_id,channel)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'discarded',$9,$10) ON CONFLICT(source_id) DO NOTHING`,
      [
        inbox.sourceId,
        inbox.provider,
        inbox.account_id,
        inbox.sender_id,
        inbox.threadId,
        inbox.text,
        inbox.sentAt,
        inboundMessageId(ownerId, inbox.sourceId),
        ownerId,
        conversationChannel(inbox),
      ],
    );
    if (!receipt.rowCount) return;
    const thread: string | null = options.activeThread
      ? (await options.activeThread(client)).id
      : ((
          await client.query('SELECT id FROM threads WHERE owner_id=$1 AND archived_at IS NULL', [
            ownerId,
          ])
        ).rows[0]?.id ?? null);
    const reply = await compose(thread);
    if (!reply) return;
    const replyId = randomUUID();
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,attachments) VALUES($1,$2,'assistant',$3,$4,$5)",
      [replyId, ownerId, reply.text, thread, JSON.stringify(reply.attachments ?? [])],
    );
    await client.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
      replyId,
      inbox.sourceId,
    ]);
    if (closed || replacing || !permitted(inbox)) throw new Error('Channel configuration changed.');
  }

  async function inTransaction(operation: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await operation(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function replyTarget(row: ChannelIdentity, providerId: string | null | undefined) {
    if (!providerId) return undefined;
    const target = await pool.query<{ id: string }>(
      `SELECT m.id FROM messages m JOIN threads th ON th.id=m.thread_id
       WHERE m.owner_id=$5 AND th.owner_id=$5 AND th.archived_at IS NULL AND m.id IN (
         SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id
         WHERE o.provider_message_ids @> ARRAY[$4::text]
           AND i.provider=$1 AND i.account_id=$2 AND i.sender_id=$3 AND i.owner_id=$5
         UNION ALL SELECT message_id FROM channel_inbox
         WHERE source_id='channel:'||$1||':'||$2||':'||$4 AND sender_id=$3 AND owner_id=$5)
       LIMIT 1`,
      [row.provider, row.account_id, row.sender_id, providerId, ownerId],
    );
    return target.rows[0]?.id;
  }

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
    const { accountId, senderId, messageId, threadId, text, sentAt, replyTo } = parsed.data;
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
          `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,turn_id,owner_id,channel,reply_provider_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(source_id) DO NOTHING`,
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
            replyTo ?? null,
          ],
        );
        if (closed || replacing || !permitted(identity))
          throw new Error('Channel configuration changed.');
      };
      const commandReply = options.commandReply;
      const command = replyCommand.exec(text.trim())?.[1]?.toLowerCase();
      if (command && commandReply) {
        const name = command === 'usage' ? 'usage' : 'memory';
        await inTransaction((client) =>
          replyWithoutTurn(client, { ...identity, sourceId, threadId, sentAt, text }, (thread) =>
            commandReply(
              name,
              client,
              thread,
              appOrigin ? `${appOrigin}/${name === 'usage' ? 'trust' : 'memory'}` : null,
            ),
          ),
        );
        options.refresh?.();
        void drain();
        return;
      }
      if (
        (classifyVerificationReply(text).kind !== 'ordinary' || securityCodeIn(text)) &&
        options.acceptVerification
      ) {
        try {
          verification = await options.acceptVerification(text, {
            clientMessageId: acceptedMessageId,
            channel: conversationChannel(identity),
            replyToMessageId: await replyTarget(identity, replyTo),
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
          await inTransaction((client) =>
            replyWithoutTurn(
              client,
              { ...identity, sourceId, threadId, sentAt, text: 'Code not applied.' },
              () => ({
                text: 'Otto didn’t use that code. Sign-in codes go in the conversation that asked for them, and payments are approved only in the Otto app.',
              }),
            ),
          );
          return;
        }
      }
      if (!ordinaryPersisted) await inTransaction(persist);
    } catch (cause) {
      logFailure('channel_accept_failed', cause);
      throw Object.assign(new Error('Channel processing is temporarily unavailable. Try again.'), {
        statusCode: 503,
      });
    }
  }

  async function press(input: InboundPress, channelId: string) {
    const parsed = pressSchema.safeParse(input);
    if (!parsed.success || parsed.data.channelId !== channelId) return;
    const { accountId, senderId, pressId, threadId, data, sentAt } = parsed.data;
    const identity = { provider: channelId, account_id: accountId, sender_id: senderId };
    if (closed || replacing || !permitted(identity) || sentAt.getTime() > Date.now() + 300000)
      return;
    const sourceId = `channel:${channelId}:${accountId}:${pressId}`;
    try {
      if (
        (
          await pool.query('SELECT 1 FROM channel_inbox WHERE source_id=$1 AND owner_id=$2', [
            sourceId,
            ownerId,
          ])
        ).rowCount
      )
        return;
      const match = pressData.exec(data);
      let note = match && options.press ? undefined : 'This button no longer works.';
      if (match && options.press)
        try {
          await options.press(
            match[3] ? { taskId: match[3] } : { approvalId: match[1], approved: match[2] === 'y' },
            conversationChannel(identity),
          );
        } catch (cause) {
          const status = (cause as { statusCode?: unknown }).statusCode;
          if (typeof status !== 'number' || status >= 500 || !(cause instanceof Error)) throw cause;
          note = cause.message;
        }
      if (await transport.ack?.({ channelId, accountId, pressId, ...(note ? { text: note } : {}) }))
        return;
      await inTransaction((client) =>
        replyWithoutTurn(client, { ...identity, sourceId, threadId, sentAt, text: data }, () =>
          note ? { text: note } : undefined,
        ),
      );
      if (note) void drain();
    } catch (cause) {
      logFailure('channel_press_failed', cause);
      throw Object.assign(new Error('Channel processing is temporarily unavailable. Try again.'), {
        statusCode: 503,
      });
    }
  }

  async function completePairing(request: ChannelPairingRequest) {
    if (closed || !options.pair) return;
    try {
      await options.pair(request);
    } catch (cause) {
      logFailure('channel_pairing_failed', cause);
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
    await replyWithoutTurn(
      client,
      {
        ...identity,
        sourceId: `channel:telegram:${request.accountId}:${request.messageId}`,
        threadId: request.threadId,
        sentAt: request.sentAt,
        text: '/start',
      },
      () => ({ text: 'You’re connected! You can now chat with me on Telegram.' }),
    );
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
      const replyToMessageId = await replyTarget(pending, pending.reply_provider_id);
      const answer = await options
        .answer?.(pending.text, channel, replyToMessageId)
        .catch(() => undefined);
      const client = await pool.connect();
      let submitted = false;
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
          const submit = (target?: string, decided?: typeof answer) =>
            options.submit(row.text, row.source_id, client, channel, messageId, decided, target);
          await client.query('SAVEPOINT reply_target');
          const turnId = await submit(replyToMessageId, answer).catch(async (error: unknown) => {
            if (!replyToMessageId || (error as { statusCode?: number }).statusCode !== 404)
              throw error;
            await client.query('ROLLBACK TO SAVEPOINT reply_target');
            const target = await client.query(
              'SELECT 1 FROM messages m JOIN threads th ON th.id=m.thread_id WHERE m.id=$1 AND m.owner_id=$2 AND th.owner_id=$2 AND th.archived_at IS NULL',
              [replyToMessageId, ownerId],
            );
            if (target.rowCount) throw error;
            return submit();
          });
          await client.query(
            "UPDATE channel_inbox SET state='submitted',turn_id=$2,message_id=$3,channel=$5 WHERE source_id=$1 AND owner_id=$4",
            [row.source_id, turnId, messageId, ownerId, channel],
          );
          submitted = true;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (submitted) options.refresh?.();
    }
  }

  async function drainOutbox() {
    await pool.query(
      `INSERT INTO channel_outbox(message_id,source_id)
      SELECT DISTINCT ON (m.id) m.id,i.source_id FROM messages m
      JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
      JOIN channel_inbox i ON i.channel=u.channel AND i.owner_id=m.owner_id AND i.created_at<=m.created_at
        AND (u.channel_source_id IS NULL OR i.source_id=u.channel_source_id)
      WHERE m.role='assistant' AND m.owner_id=$1 AND i.state='submitted' AND u.channel<>'web'
        AND NOT EXISTS (SELECT 1 FROM channel_outbox q WHERE q.message_id=m.id)
      ORDER BY m.id,(i.turn_id IS NOT DISTINCT FROM m.turn_id) DESC,i.received_at DESC,i.source_id
      ON CONFLICT(message_id) DO NOTHING`,
      [ownerId],
    );
    for (let index = 0; index < 25 && !closed && !replacing; index++) {
      const result = await pool.query<OutboxRow>(
        `WITH claimed AS (
        UPDATE channel_outbox SET state='sending',updated_at=now() WHERE message_id=(
          SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id JOIN messages m ON m.id=o.message_id
          WHERE o.state='pending' AND i.owner_id=$1 AND m.owner_id=$1 AND NOT EXISTS (
            SELECT 1 FROM channel_outbox w JOIN channel_inbox v ON v.source_id=w.source_id
            WHERE w.state='pending' AND w.retry_at>now() AND v.owner_id=$1
              AND v.provider=i.provider AND v.account_id=i.account_id AND v.sender_id=i.sender_id)
          ORDER BY m.created_at,m.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
        ) RETURNING message_id,source_id
      ) SELECT c.message_id,m.owner_id,m.thread_id AS message_thread_id,i.provider,i.account_id,i.sender_id,i.thread_id,m.text,m.attachments,
        (SELECT r.id FROM (
          SELECT o.provider_message_ids[1] AS id FROM channel_outbox o JOIN channel_inbox t ON t.source_id=o.source_id
          WHERE o.message_id=m.reply_to_message_id AND t.provider=i.provider AND t.account_id=i.account_id
            AND t.sender_id=i.sender_id AND t.owner_id=$1
          UNION ALL SELECT substr(t.source_id,length('channel:'||t.provider||':'||t.account_id||':')+1) FROM channel_inbox t
          WHERE t.message_id=m.reply_to_message_id AND t.provider=i.provider AND t.account_id=i.account_id
            AND t.sender_id=i.sender_id AND t.owner_id=$1
        ) r WHERE r.id IS NOT NULL LIMIT 1) AS reply_to
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
      const view = await options.taskMessages?.([row.message_id]).catch(() => undefined);
      const taskResult = Boolean(
        view?.tasks.some((task) => task.resultMessageId === row.message_id),
      );
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
          if (canDeliverAttachments) {
            const documents: MessagingAttachment[] = [];
            for (const file of resolved)
              documents.push(taskResult ? await documentPdf(file) : file);
            attachments =
              documents.reduce((total, file) => total + file.bytes.byteLength, 0) > 15 * 1024 * 1024
                ? resolved
                : documents;
          } else if (appOrigin && !taskResult)
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
      const live =
        view && !row.attachments?.length
          ? liveMessage(
              row.message_id,
              row.text,
              Boolean(channels.find((channel) => channel.id === row.provider)?.edits),
              view,
            )
          : undefined;
      const text = channelReply(
        live?.text ?? row.text,
        Boolean(row.attachments?.length) && !attachments,
        Boolean(attachments),
        privateLinks,
        options.appOrigin,
      );
      try {
        const sent = await transport.post({
          channelId: row.provider,
          accountId: row.account_id,
          threadId: row.thread_id,
          text,
          ...(attachments ? { attachments } : {}),
          ...(attachments && taskResult ? { filesReplyToText: true } : {}),
          ...(row.reply_to ? { replyTo: row.reply_to } : {}),
          ...(live ? { buttons: live.buttons } : {}),
        });
        await pool.query(
          `WITH sent AS (
             UPDATE channel_outbox SET state='sent',provider_message_ids=$2,reason=NULL,retry_at=NULL,updated_at=now()
             WHERE message_id=$1 RETURNING message_id)
           INSERT INTO channel_edits(message_id,owner_id,text,buttons,final)
           SELECT message_id,$3,$4,$5,$6 FROM sent WHERE $7 ON CONFLICT(message_id) DO NOTHING`,
          [
            row.message_id,
            sent.ids,
            ownerId,
            text,
            JSON.stringify(live?.buttons ?? []),
            live?.final ?? true,
            Boolean(live && sent.editable),
          ],
        );
      } catch (cause) {
        if (cause instanceof MessagingRetryLater) {
          await pool.query(
            "UPDATE channel_outbox SET state='pending',reason='rate_limited',retry_at=now()+make_interval(secs=>$2),updated_at=now() WHERE message_id=$1",
            [row.message_id, cause.retryAfterMs / 1000],
          );
          continue;
        }
        logFailure('channel_send_failed', cause);
        await pool.query(
          "UPDATE channel_outbox SET state='uncertain',reason='send_not_confirmed',provider_message_ids=$2,updated_at=now() WHERE message_id=$1",
          [row.message_id, cause instanceof MessagingPartialSend ? cause.ids : []],
        );
      }
    }
  }

  async function drainEdits() {
    if (
      !options.taskMessages ||
      !transport.edit ||
      !channels.some((channel) => channel.edits && channel.status === 'configured')
    )
      return;
    const select = (where: string, values: unknown[] = []) =>
      pool.query<EditRow>(
        `SELECT e.message_id,e.text,e.buttons,e.revision,e.state,e.final,
           e.retry_at IS NULL OR e.retry_at<=now() AS due,m.text AS original,
           i.provider,i.account_id,i.sender_id,i.thread_id,o.provider_message_ids[1] AS provider_id
         FROM channel_edits e JOIN messages m ON m.id=e.message_id AND m.owner_id=e.owner_id
         JOIN channel_outbox o ON o.message_id=e.message_id
         JOIN channel_inbox i ON i.source_id=o.source_id AND i.owner_id=e.owner_id
         WHERE e.owner_id=$1 AND ${where} ORDER BY e.updated_at,e.message_id`,
        [ownerId, ...values],
      );
    const rows = (await select(`(NOT e.final OR e.state='pending')`)).rows;
    const view = await options.taskMessages(rows.map((row) => row.message_id));
    const reopened = view.tasks.flatMap((task) =>
      task.onItMessageId &&
      isOpenTask(task) &&
      !rows.some((row) => row.message_id === task.onItMessageId)
        ? [task.onItMessageId]
        : [],
    );
    if (reopened.length)
      rows.push(...(await select('e.message_id=ANY($2::uuid[])', [reopened])).rows);
    for (const row of rows) {
      if (closed || replacing) break;
      const live = liveMessage(row.message_id, row.original, true, view);
      const text = channelReply(live?.text ?? row.original, false, false, [], options.appOrigin);
      const buttons = live?.buttons ?? [];
      const final = live?.final ?? true;
      let { revision, state } = row;
      if (text !== row.text || JSON.stringify(buttons) !== JSON.stringify(row.buttons)) {
        revision = (
          await pool.query<{ revision: number }>(
            `UPDATE channel_edits SET text=$2,buttons=$3,final=$4,revision=revision+1,state='pending',
               updated_at=now() WHERE message_id=$1 RETURNING revision`,
            [row.message_id, text, JSON.stringify(buttons), final],
          )
        ).rows[0]!.revision;
        state = 'pending';
      } else if (final !== row.final)
        await pool.query('UPDATE channel_edits SET final=$2 WHERE message_id=$1', [
          row.message_id,
          final,
        ]);
      if (state !== 'pending' || !row.due) continue;
      if (!permitted(row)) {
        await pool.query(
          "UPDATE channel_edits SET state='failed',final=true,updated_at=now() WHERE message_id=$1",
          [row.message_id],
        );
        continue;
      }
      try {
        await transport.edit({
          channelId: row.provider,
          accountId: row.account_id,
          threadId: row.thread_id,
          messageId: row.provider_id,
          text,
          buttons,
        });
        await pool.query(
          "UPDATE channel_edits SET state='sent',retry_at=NULL,updated_at=now() WHERE message_id=$1 AND revision=$2",
          [row.message_id, revision],
        );
      } catch (cause) {
        if (cause instanceof MessagingRetryLater) {
          await pool.query(
            'UPDATE channel_edits SET retry_at=now()+make_interval(secs=>$2),updated_at=now() WHERE message_id=$1',
            [row.message_id, cause.retryAfterMs / 1000],
          );
          continue;
        }
        logFailure('channel_edit_failed', cause);
        await pool.query(
          "UPDATE channel_edits SET state='failed',updated_at=now() WHERE message_id=$1 AND revision=$2",
          [row.message_id, revision],
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
      let processingFailed = false;
      try {
        while (drainRequested && !closed && !replacing && !options.admission?.paused) {
          drainRequested = false;
          try {
            await transport.poll?.(
              (message) => accept(message, message.channelId),
              completePairing,
              (item) => press(item, item.channelId),
            );
          } catch (cause) {
            pollingFailed = true;
            logFailure('channel_poll_failed', cause);
          }
          for (const step of [drainInbox, drainOutbox, drainEdits])
            try {
              await step();
            } catch (cause) {
              processingFailed = true;
              logFailure('channel_drain_failed', cause);
            }
        }
      } finally {
        lastError = processingFailed
          ? 'Channel processing needs attention. Check the local database and thread service.'
          : pollingFailed
            ? 'Telegram could not check for new messages. Check its channel setup.'
            : null;
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
            for (const item of result.presses ?? []) await press(item, channelId);
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
