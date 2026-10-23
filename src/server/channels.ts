import { createHash, randomUUID } from 'node:crypto';
import type { Artifact, SubmitMessageResponse } from '../shared/contracts.ts';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { classifyVerificationReply, securityCodeIn } from '../shared/verification-code.ts';
import { isMessageReaction } from '../shared/emoji.ts';
import { transaction } from './transaction.ts';
import { logFailure } from './failure-log.ts';
import { ChannelMediaFailure, type ChannelMedia } from './channel-media.ts';
import type { WorkAdmission } from './work-admission.ts';
import type { LiveWork } from './activity.ts';
import type {
  ChannelPairingRequest,
  InboundMessage,
  InboundReaction,
  MessagingAttachment,
  MessagingTransport,
} from '../ports/messaging.ts';
import { loopbackHost } from '../shared/loopback.ts';
import type { ChatConfirmationInput } from './approvals.ts';
import { appPagePath, appPages, appPageUrl } from '../shared/app-links.ts';

const replyCommand = /^\/(memory|context|usage)(?:@[A-Za-z0-9_]+)?$/i;
const taskCommand = /^\/(tasks|status|stop)(?:@[A-Za-z0-9_]+)?$/i;

export type ChannelPresentation =
  | {
      kind: 'delivery';
      text: string;
      attachments: 'none' | 'pending' | 'in_nod';
      secureAction: boolean;
      files?: string[];
    }
  | { kind: 'verification_refused' }
  | { kind: 'media_failure'; reason: ChannelMediaFailure['reason']; fileLimitMb?: number }
  | { kind: 'verification_failure'; verification: 'otp' }
  | { kind: 'paired'; channel: string }
  | {
      kind: 'command';
      command: 'memory' | 'usage' | 'tasks' | 'status' | 'stop';
      data: object;
      attachments?: 'none' | 'pending' | 'in_nod';
    };

interface ChannelOptions {
  present?: (threadId: string | null, input: ChannelPresentation) => Promise<string>;
  admission?: WorkAdmission;
  ownerId: string;
  transport: MessagingTransport;
  acceptVerification?: (
    text: string,
    input: {
      clientMessageId: string;
      channel: string;
      threadId?: string;
      replyToMessageId?: string;
      receiptOnly?: boolean;
      persistOrdinary: (client: PoolClient) => Promise<void>;
      persistVerification?: (client: PoolClient, response: SubmitMessageResponse) => Promise<void>;
    },
  ) => Promise<
    | {
        turnId?: string | null;
        threadId?: string;
        messageText?: string;
        verificationStatus?: SubmitMessageResponse['verificationStatus'];
      }
    | undefined
  >;
  submit: (
    text: string,
    sourceId: string,
    client: PoolClient,
    channel: string,
    messageId: string,
    answer?: ChatConfirmationInput['answer'],
    replyToMessageId?: string,
    attachments?: Artifact[],
  ) => Promise<string>;
  answer?: (
    text: string,
    channel: string,
    replyToMessageId?: string,
  ) => Promise<ChatConfirmationInput['answer']>;
  reacted?: (messageId: string, reaction: string | null) => Promise<unknown>;
  subscribe: (listener: () => void) => () => void;
  refresh?: () => void;
  intervalMs?: number;
  resolveAttachments?: (threadId: string, ids: string[]) => Promise<MessagingAttachment[]>;
  media?: ChannelMedia;
  modelConfigured?: () => boolean;
  verificationPending?: (channel: string) => Promise<boolean>;
  attributeMediaUsage?(client: PoolClient, ids: string[], turnId: string): Promise<void>;
  pair?: (request: ChannelPairingRequest) => Promise<unknown>;
  activeThread?: (client: PoolClient) => Promise<{ id: string }>;
  activity?: () => Promise<LiveWork[]>;
  commandReply?: (
    command: 'memory' | 'usage',
    client: PoolClient,
    threadId: string | null,
  ) => Promise<{ text: string; attachments: Artifact[]; presentation?: ChannelPresentation }>;
  taskCommand?: (
    client: PoolClient,
    command: 'tasks' | 'status' | 'stop',
    replyToMessageId?: string,
    hasReply?: boolean,
  ) => Promise<{
    threadId: string;
    replies: Array<{ text: string; replyToMessageId?: string; presentation?: ChannelPresentation }>;
    afterCommit?: () => Promise<void>;
  }>;
}
interface ChannelIdentity {
  provider: string;
  account_id: string;
  sender_id: string;
}
interface InboxRow extends ChannelIdentity {
  source_id: string;
  thread_id: string;
  provider_reply_id: string | null;
  text: string;
  message_id: string | null;
  attachments: Artifact[];
  conversation_thread_id: string | null;
  media_usage_ids: string[];
}
interface OutboxRow extends ChannelIdentity {
  message_id: string;
  owner_id: string;
  message_thread_id: string | null;
  thread_id: string;
  text: string;
  attachments: unknown[];
  reply_to_message_id: string | null;
  presentation: ChannelPresentation | null;
}
const messageSchema = z
  .object({
    channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
    accountId: z.string().min(1),
    senderId: z.string().min(1),
    messageId: z.string().min(1),
    threadId: z.string().min(1),
    text: z.string().trim().max(100_000),
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(200),
          size: z.number().int().nonnegative(),
          voice: z.boolean().optional(),
          source: z.enum(['sticker', 'sticker-preview', 'location', 'contact']).optional(),
          read: z.custom<MessagingAttachment['read']>((value) => typeof value === 'function'),
        }),
      )
      .max(10)
      .optional(),
    sentAt: z.date(),
    replyToMessageId: z.string().min(1).optional(),
  })
  .refine((message) => Boolean(message.text || message.attachments?.length));
const reactionSchema = z.object({
  channelId: z.string().regex(/^[a-z][a-z0-9_-]{0,50}$/),
  accountId: z.string().min(1).max(256),
  senderId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  reaction: z.string().max(64).refine(isMessageReaction).nullable(),
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

function channelText(text: string) {
  let secureAction = false;
  let artifact = false;
  const privateUrl = (value: string) => {
    let url: URL;
    try {
      url = new URL(value, 'https://nod.invalid');
    } catch {
      return false;
    }
    if (url.pathname.startsWith('/api/artifacts/')) {
      artifact = true;
      return true;
    }
    if (loopbackHost(url.hostname)) {
      secureAction = true;
      return true;
    }
    if (
      /^\/(?:vault|credentials|payments|approvals)\//.test(url.pathname) ||
      (['/vault', '/trust'].includes(url.pathname) && url.searchParams.has('add'))
    ) {
      if (!/^https?:\/\//.test(value)) {
        secureAction = true;
        return true;
      }
    }
    return false;
  };
  const safe = text
    .replace(
      /\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g,
      (match, label: string, url: string) => {
        const path = appPagePath(url);
        if (path)
          return `${label === appPages[path] ? label : `${label} (${appPages[path]})`}: ${appPageUrl(path)}`;
        return privateUrl(url) ? label : match;
      },
    )
    .replace(
      /https?:\/\/[^\s)]+|\/(?:api\/artifacts|vault|trust|credentials|payments|approvals)[^\s)]*/g,
      (url) => (privateUrl(url) ? '' : url),
    );
  return { text: safe.trim(), secureAction, artifact };
}

async function presentChannelText(
  threadId: string | null,
  input: ChannelPresentation,
  present: ChannelOptions['present'],
) {
  if (!present) throw new Error('Channel presentation is unavailable.');
  const text = z
    .string()
    .trim()
    .min(1)
    .parse(await present(threadId, input));
  const safe = channelText(text);
  if (safe.secureAction || safe.artifact)
    throw new Error('Channel presentation contains a private link.');
  return safe.text;
}

export async function channelReply(
  text: string,
  options: {
    threadId: string | null;
    hasAttachments?: boolean;
    deliversAttachments?: boolean;
    present?: ChannelOptions['present'];
  },
) {
  const safe = channelText(text);
  const attachments = options.deliversAttachments
    ? 'pending'
    : options.hasAttachments || safe.artifact
      ? 'in_nod'
      : 'none';
  const needsPresentation =
    safe.secureAction ||
    attachments === 'in_nod' ||
    (attachments === 'pending' && Boolean(safe.text)) ||
    (!safe.text && attachments === 'none');
  return needsPresentation
    ? await presentChannelText(
        options.threadId,
        { kind: 'delivery', text: safe.text, attachments, secureAction: safe.secureAction },
        options.present,
      )
    : safe.text;
}

export async function createChannels(pool: Pool, options: ChannelOptions) {
  const { ownerId } = options;
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
  function updateConfiguration() {
    channels = transport.channels.map((channel) => ({
      ...channel,
      allowedSenderIds: [...channel.allowedSenderIds],
    }));
    configuration = channels.map((channel) => ({
      provider: channel.id,
      status: channel.status,
      missing: channel.missing,
    }));
  }
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
  ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS provider_reply_id text;
  ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS conversation_thread_id uuid;
  ALTER TABLE channel_inbox ADD COLUMN IF NOT EXISTS media_usage_ids text[] NOT NULL DEFAULT '{}';
  ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS provider_message_ids text[] NOT NULL DEFAULT '{}';
  ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS presentation jsonb;
  ALTER TABLE channel_outbox ADD COLUMN IF NOT EXISTS claim_id uuid;
  CREATE INDEX IF NOT EXISTS channel_inbox_pending ON channel_inbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_outbox_pending ON channel_outbox(state,created_at);
  CREATE INDEX IF NOT EXISTS channel_inbox_turn ON channel_inbox(turn_id);
  CREATE INDEX IF NOT EXISTS channel_inbox_channel ON channel_inbox(owner_id,channel,state,received_at DESC)`);
  await pool.query(
    `UPDATE messages m SET delivered_channel=i.channel FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id
    WHERE m.id=o.message_id AND m.owner_id=$1 AND i.owner_id=$1 AND m.turn_id IS NULL AND m.delivered_channel IS NULL AND o.state='sent'`,
    [ownerId],
  );
  await pool.query(
    `UPDATE channel_outbox o SET
       state=CASE WHEN o.state='sending' THEN 'uncertain' ELSE 'pending' END,
       reason=CASE WHEN o.state='sending' THEN 'interrupted_send' ELSE NULL END,
       claim_id=NULL,updated_at=now()
     FROM channel_inbox i WHERE o.source_id=i.source_id AND i.owner_id=$1
       AND o.state IN ('preparing','sending')`,
    [ownerId],
  );
  let closed = false;
  let replacing = false;
  let running: Promise<void> | undefined;
  let drainRequested = false;
  let lastError: string | null = null;
  let receiving = new AbortController();
  const pendingMedia = new Map<string, Promise<void>>();
  async function saveReply(
    client: PoolClient,
    sourceId: string,
    threadId: string | null,
    reply: {
      text: string;
      attachments?: Artifact[];
      replyToMessageId?: string;
      presentation?: ChannelPresentation;
    },
  ) {
    const replyId = randomUUID();
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,attachments,reply_to_message_id) VALUES($1,$2,'assistant',$3,$4,$5,$6)",
      [
        replyId,
        ownerId,
        reply.text,
        threadId,
        JSON.stringify(reply.attachments ?? []),
        reply.replyToMessageId ?? null,
      ],
    );
    await client.query(
      'INSERT INTO channel_outbox(message_id,source_id,presentation) VALUES($1,$2,$3)',
      [replyId, sourceId, reply.presentation ? JSON.stringify(reply.presentation) : null],
    );
  }

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
      | Promise<{ text: string; attachments?: Artifact[]; presentation?: ChannelPresentation }>
      | { text: string; attachments?: Artifact[]; presentation?: ChannelPresentation },
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
    await saveReply(client, inbox.sourceId, thread, reply);
    if (closed || replacing || !permitted(inbox)) throw new Error('Channel configuration changed.');
  }

  async function acceptReaction(input: InboundReaction, channelId: string) {
    const parsed = reactionSchema.safeParse(input);
    if (!parsed.success || parsed.data.channelId !== channelId || !options.reacted) return;
    const { accountId, senderId, messageId, reaction } = parsed.data;
    const identity = { provider: channelId, account_id: accountId, sender_id: senderId };
    if (closed || replacing || !permitted(identity)) return;
    try {
      const target = await pool.query<{ id: string }>(
        `SELECT m.id FROM messages m JOIN threads th ON th.id=m.thread_id
         WHERE m.owner_id=$5 AND th.owner_id=$5 AND th.archived_at IS NULL AND m.role='assistant' AND m.id IN (
           SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id
           WHERE $4=ANY(o.provider_message_ids) AND o.state='sent'
             AND i.provider=$1 AND i.account_id=$2 AND i.sender_id=$3 AND i.owner_id=$5)
         LIMIT 1`,
        [channelId, accountId, senderId, messageId, ownerId],
      );
      if (target.rows[0]) await options.reacted(target.rows[0].id, reaction);
    } catch (cause) {
      logFailure('channel_reaction_failed', cause);
    }
  }

  async function react(messageId: string, reaction: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row = (
      await pool.query<ChannelIdentity & { source_id: string; thread_id: string; at: Date }>(
        'SELECT provider,account_id,sender_id,source_id,thread_id,received_at AS at FROM channel_inbox WHERE message_id=$1 AND owner_id=$2',
        [messageId, ownerId],
      )
    ).rows[0];
    if (!row) return 'absent' as const;
    const prefix = `channel:${row.provider}:${row.account_id}:`;
    const replyWindowMs = channels.find((channel) => channel.id === row.provider)?.replyWindowMs;
    if (
      closed ||
      replacing ||
      !transport.react ||
      !permitted(row) ||
      !row.source_id.startsWith(prefix) ||
      (replyWindowMs !== undefined && Date.now() - row.at.getTime() >= replyWindowMs)
    )
      return 'unsupported' as const;
    signal?.throwIfAborted();
    return transport.react({
      channelId: row.provider,
      accountId: row.account_id,
      threadId: row.thread_id,
      messageId: row.source_id.slice(prefix.length),
      reaction,
      signal,
    });
  }

  function permitted(row: ChannelIdentity) {
    updateConfiguration();
    return channels.some(
      (channel) =>
        channel.id === row.provider &&
        channel.status === 'configured' &&
        channel.accountId === row.account_id &&
        channel.allowedSenderIds.includes(row.sender_id),
    );
  }

  async function accept(message: InboundMessage, channelId: string) {
    if (!message.attachments?.length) return acceptMessage(message, channelId);
    const source = `${channelId}:${message.accountId}:${message.messageId}`;
    const existing = pendingMedia.get(source);
    if (existing) return existing;
    if (pendingMedia.size >= 4)
      throw Object.assign(new Error('Channel media is busy. Try again.'), { statusCode: 503 });
    const pending = acceptMessage(message, channelId);
    pendingMedia.set(source, pending);
    try {
      await pending;
    } finally {
      if (pendingMedia.get(source) === pending) pendingMedia.delete(source);
    }
  }

  async function nativeReply(
    identity: { provider: string; account_id: string; sender_id: string },
    threadId: string,
    providerId: string,
  ): Promise<string | undefined> {
    return (
      await pool.query(
        `SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id
         JOIN messages m ON m.id=o.message_id AND m.owner_id=i.owner_id
         WHERE i.owner_id=$1 AND i.provider=$2 AND i.account_id=$3 AND i.sender_id=$4
           AND i.thread_id=$5 AND $6=ANY(o.provider_message_ids) AND o.state='sent'
         UNION ALL
         SELECT message_id FROM channel_inbox WHERE owner_id=$1 AND provider=$2 AND account_id=$3
           AND sender_id=$4 AND thread_id=$5 AND source_id=$7 AND state='submitted'
         LIMIT 1`,
        [
          ownerId,
          identity.provider,
          identity.account_id,
          identity.sender_id,
          threadId,
          providerId,
          `channel:${identity.provider}:${identity.account_id}:${providerId}`,
        ],
      )
    ).rows[0]?.message_id;
  }

  async function acceptMessage(message: InboundMessage, channelId: string) {
    const receiveSignal = receiving.signal;
    const parsed = messageSchema.safeParse(message);
    if (!parsed.success || parsed.data.channelId !== channelId) return;
    const { accountId, senderId, messageId, threadId, sentAt, replyToMessageId } = parsed.data;
    let { text } = parsed.data;
    const identity = { provider: channelId, account_id: accountId, sender_id: senderId };
    if (closed || replacing || !permitted(identity) || sentAt.getTime() > Date.now() + 300000)
      return;
    let media: Awaited<ReturnType<ChannelMedia['prepare']>> | undefined;
    try {
      const sourceId = `channel:${channelId}:${accountId}:${messageId}`;
      const recorded = (
        await pool.query('SELECT state FROM channel_inbox WHERE source_id=$1 AND owner_id=$2', [
          sourceId,
          ownerId,
        ])
      ).rows[0];
      const hasMedia = Boolean(parsed.data.attachments?.length);
      const modelMissingAtIntake = hasMedia && options.modelConfigured?.() === false;
      if (recorded && hasMedia) return;
      const mediaThreadId = hasMedia
        ? (await transaction(async (client) => options.activeThread?.(client), pool))?.id
        : undefined;
      async function currentConversation(client: PoolClient) {
        if (!mediaThreadId || (await options.activeThread?.(client))?.id === mediaThreadId)
          return true;
        await client.query(
          `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,state,owner_id,channel,conversation_thread_id)
           VALUES($1,$2,$3,$4,$5,'',$6,'discarded',$7,$8,$9) ON CONFLICT(source_id) DO NOTHING`,
          [
            sourceId,
            channelId,
            accountId,
            senderId,
            threadId,
            sentAt,
            ownerId,
            conversationChannel(identity),
            mediaThreadId,
          ],
        );
        return false;
      }
      if (closed || replacing || receiveSignal.aborted || !permitted(identity)) return;
      const requestModelSetup = async () => {
        await transaction(async (client) => {
          if (!(await currentConversation(client))) return;
          await replyWithoutTurn(
            client,
            { ...identity, sourceId, threadId, sentAt, text: '' },
            () => ({ text: 'Connect a model service and choose a model in Settings → Models.' }),
          );
        }, pool);
        options.refresh?.();
      };
      if (
        hasMedia &&
        modelMissingAtIntake &&
        !(
          parsed.data.attachments?.some((file) => file.voice) &&
          (await options.verificationPending?.(conversationChannel(identity)))
        )
      ) {
        await requestModelSetup();
        return;
      }
      if (hasMedia) {
        try {
          if (!options.media) throw new ChannelMediaFailure('unavailable');
          media = await options.media.prepare(
            parsed.data.attachments!,
            AbortSignal.any([receiveSignal, AbortSignal.timeout(120_000)]),
            async () => {
              if (!(await transaction(currentConversation, pool)))
                throw new ChannelMediaFailure('unavailable');
            },
          );
          text = [text, media.text].filter(Boolean).join('\n\n');
          if (text.length > 100_000) throw new ChannelMediaFailure('text_too_long');
        } catch (error) {
          if (closed || replacing || receiveSignal.aborted || !permitted(identity)) return;
          if (modelMissingAtIntake || options.modelConfigured?.() === false) {
            await requestModelSetup();
            return;
          }
          await transaction(async (client) => {
            if (!(await currentConversation(client))) return;
            return replyWithoutTurn(
              client,
              { ...identity, sourceId, threadId, sentAt, text: '' },
              () => ({
                text: '',
                presentation: {
                  kind: 'media_failure',
                  reason: error instanceof ChannelMediaFailure ? error.reason : 'unavailable',
                  ...(error instanceof ChannelMediaFailure && error.fileLimitMb
                    ? { fileLimitMb: error.fileLimitMb }
                    : {}),
                },
              }),
            );
          }, pool);
          options.refresh?.();
          return;
        }
      }
      const verificationReply =
        classifyVerificationReply(text).kind !== 'ordinary' || Boolean(securityCodeIn(text));
      if (
        recorded &&
        (recorded.state === 'discarded' || !verificationReply || !options.acceptVerification)
      )
        return;
      const acceptedMessageId = inboundMessageId(ownerId, sourceId);
      let verification: Awaited<ReturnType<NonNullable<ChannelOptions['acceptVerification']>>>;
      let ordinaryPersisted = false;
      let verificationPersisted = false;
      const persist = async (database: PoolClient, strict = true) => {
        if (closed || replacing || receiveSignal.aborted || !permitted(identity)) {
          if (!strict) return false;
          throw new Error('Channel configuration changed.');
        }
        if (!(await currentConversation(database))) return true;
        let attachments: Artifact[] = [];
        let conversationThreadId: string | undefined;
        if (media && !verification) {
          await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [sourceId]);
          if (
            (
              await database.query(
                'SELECT 1 FROM channel_inbox WHERE source_id=$1 AND owner_id=$2',
                [sourceId, ownerId],
              )
            ).rowCount
          )
            return true;
          conversationThreadId = mediaThreadId;
          attachments = await media.save(database, mediaThreadId);
        }
        if (verification?.turnId && media?.usageIds.length)
          await options.attributeMediaUsage?.(database, media.usageIds, verification.turnId);
        await database.query(
          `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,message_id,state,turn_id,owner_id,channel,provider_reply_id,attachments,conversation_thread_id,media_usage_ids)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(source_id) DO NOTHING`,
          [
            sourceId,
            channelId,
            accountId,
            senderId,
            threadId,
            verification ? (verification.messageText ?? '') : text,
            sentAt,
            acceptedMessageId,
            verification ? 'submitted' : 'pending',
            verification?.turnId ?? null,
            ownerId,
            conversationChannel(identity),
            replyToMessageId ?? null,
            JSON.stringify(attachments),
            conversationThreadId ?? null,
            media?.usageIds ?? [],
          ],
        );
        if (strict && (closed || replacing || receiveSignal.aborted || !permitted(identity)))
          throw new Error('Channel configuration changed.');
        return true;
      };
      const commandReply = options.commandReply;
      const command = replyCommand.exec(text.trim())?.[1]?.toLowerCase();
      if (command && commandReply && !hasMedia) {
        const name = command === 'usage' ? 'usage' : 'memory';
        await transaction(
          (client) =>
            replyWithoutTurn(client, { ...identity, sourceId, threadId, sentAt, text }, (thread) =>
              commandReply(name, client, thread),
            ),
          pool,
        );
        options.refresh?.();
        void drain();
        return;
      }
      if (verificationReply && options.acceptVerification) {
        try {
          const target = replyToMessageId
            ? await nativeReply(identity, threadId, replyToMessageId)
            : undefined;
          if (replyToMessageId && !target)
            throw Object.assign(new Error('The verification reply is unavailable.'), {
              statusCode: 409,
            });
          verification = await options.acceptVerification(text, {
            clientMessageId: acceptedMessageId,
            channel: conversationChannel(identity),
            ...(mediaThreadId ? { threadId: mediaThreadId } : {}),
            ...(target ? { replyToMessageId: target } : {}),
            ...(recorded ? { receiptOnly: true } : {}),
            persistOrdinary: async (client) => {
              if (
                recorded ||
                (hasMedia && (modelMissingAtIntake || options.modelConfigured?.() === false))
              )
                return;
              await persist(client);
              ordinaryPersisted = true;
            },
            persistVerification: async (client, response) => {
              verification = response;
              verificationPersisted = true;
              if (
                closed ||
                replacing ||
                !permitted(identity) ||
                response.messageId !== acceptedMessageId
              )
                return;
              if (!(await currentConversation(client))) return;
              const current = await client.query(
                `SELECT 1 FROM messages m JOIN turns u ON u.id=m.turn_id JOIN threads th ON th.id=m.thread_id
                 WHERE m.id=$1 AND m.owner_id=$2 AND m.thread_id=$3 AND m.turn_id=$4
                   AND u.owner_id=$2 AND u.thread_id=m.thread_id AND u.channel=$5
                   AND th.owner_id=$2 AND th.archived_at IS NULL FOR SHARE OF th`,
                [
                  acceptedMessageId,
                  ownerId,
                  response.threadId,
                  response.turnId,
                  conversationChannel(identity),
                ],
              );
              if (!current.rowCount) return;
              await client.query('SAVEPOINT channel_verification_receipt');
              const persisted = await persist(client, false);
              if (
                persisted &&
                response.verificationStatus === 'unavailable' &&
                !closed &&
                !replacing &&
                permitted(identity)
              ) {
                const noticeId = inboundMessageId(
                  ownerId,
                  `verification-failure:${acceptedMessageId}`,
                );
                await client.query(
                  `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id)
                   VALUES($1,$2,'assistant','',$3,$4) ON CONFLICT(id) DO NOTHING`,
                  [noticeId, ownerId, response.threadId, response.turnId],
                );
                await client.query(
                  `INSERT INTO channel_outbox(message_id,source_id,presentation)
                   SELECT id,$2,$3 FROM messages WHERE id=$1 AND owner_id=$4 AND thread_id=$5 AND turn_id=$6
                   ON CONFLICT(message_id) DO NOTHING`,
                  [
                    noticeId,
                    sourceId,
                    JSON.stringify({ kind: 'verification_failure', verification: 'otp' }),
                    ownerId,
                    response.threadId,
                    response.turnId,
                  ],
                );
              }
              if (closed || replacing || !permitted(identity))
                await client.query('ROLLBACK TO SAVEPOINT channel_verification_receipt');
              await client.query('RELEASE SAVEPOINT channel_verification_receipt');
            },
          });
          if (!verification && !ordinaryPersisted && !recorded) {
            if (hasMedia && (modelMissingAtIntake || options.modelConfigured?.() === false)) {
              await requestModelSetup();
              return;
            }
            throw new Error('Verification did not persist its receipt.');
          }
        } catch (cause) {
          const conflict =
            cause instanceof Error && 'statusCode' in cause && cause.statusCode === 409;
          if (!conflict) throw cause;
          if (recorded) return;
          if (hasMedia && (modelMissingAtIntake || options.modelConfigured?.() === false)) {
            await requestModelSetup();
            return;
          }
          await transaction(async (client) => {
            if (!(await currentConversation(client))) return;
            return replyWithoutTurn(
              client,
              { ...identity, sourceId, threadId, sentAt, text: '' },
              () => ({ text: '', presentation: { kind: 'verification_refused' } }),
            );
          }, pool);
          return;
        }
      }
      if (recorded) return;
      if (
        !verification &&
        !ordinaryPersisted &&
        hasMedia &&
        (modelMissingAtIntake || options.modelConfigured?.() === false)
      ) {
        await requestModelSetup();
        return;
      }
      if (!ordinaryPersisted && !verificationPersisted) await transaction(persist, pool);
    } catch (cause) {
      logFailure('channel_accept_failed', cause);
      throw Object.assign(new Error('Channel processing is temporarily unavailable. Try again.'), {
        statusCode: 503,
      });
    } finally {
      await media?.dispose().catch((error) => logFailure('channel_media_cleanup_failed', error));
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
      () => ({ text: '', presentation: { kind: 'paired', channel: 'telegram' } }),
    );
    return () => {
      void drain();
    };
  }

  async function inboxStep() {
    if (closed || replacing) return false;
    const pending = (
      await pool.query<InboxRow>(
        "SELECT * FROM channel_inbox WHERE state='pending' AND owner_id=$1 ORDER BY created_at LIMIT 1",
        [ownerId],
      )
    ).rows[0];
    if (!pending) return false;
    const channel = conversationChannel(pending);
    if (closed || replacing) return false;
    const replyToMessageId = pending.provider_reply_id
      ? await nativeReply(pending, pending.thread_id, pending.provider_reply_id)
      : undefined;
    const command =
      !pending.attachments?.length && options.taskCommand
        ? (taskCommand.exec(pending.text.trim())?.[1]?.toLowerCase() as
            'tasks' | 'status' | 'stop' | undefined)
        : undefined;
    const answer =
      command || pending.attachments?.length || (pending.provider_reply_id && !replyToMessageId)
        ? undefined
        : await options.answer?.(pending.text, channel, replyToMessageId).catch(() => undefined);
    let afterCommit: (() => Promise<void>) | undefined;
    const submitted = await transaction(async (client) => {
      const result = await client.query<InboxRow>(
        "SELECT * FROM channel_inbox WHERE state='pending' AND source_id=$1 AND owner_id=$2 FOR UPDATE SKIP LOCKED",
        [pending.source_id, ownerId],
      );
      const row = result.rows[0];
      if (!row) return;
      const currentThread = row.conversation_thread_id
        ? await options.activeThread?.(client)
        : undefined;
      if (
        !permitted(row) ||
        (row.conversation_thread_id && currentThread?.id !== row.conversation_thread_id)
      ) {
        await client.query(
          "UPDATE channel_inbox SET state='discarded' WHERE source_id=$1 AND owner_id=$2",
          [row.source_id, ownerId],
        );
        return false;
      }
      if (command) {
        const reply = await options.taskCommand!(
          client,
          command,
          replyToMessageId,
          Boolean(row.provider_reply_id),
        );
        for (const message of reply.replies)
          await saveReply(client, row.source_id, reply.threadId, message);
        await client.query(
          "UPDATE channel_inbox SET state='submitted',channel=$3 WHERE source_id=$1 AND owner_id=$2",
          [row.source_id, ownerId, channel],
        );
        afterCommit = reply.afterCommit;
        return true;
      }
      const messageId = row.message_id ?? randomUUID();
      const turnId = await options.submit(
        row.text,
        row.source_id,
        client,
        channel,
        messageId,
        answer,
        replyToMessageId,
        row.attachments ?? [],
      );
      await options.attributeMediaUsage?.(client, row.media_usage_ids ?? [], turnId);
      await client.query(
        "UPDATE channel_inbox SET state='submitted',turn_id=$2,message_id=$3,channel=$5 WHERE source_id=$1 AND owner_id=$4",
        [row.source_id, turnId, messageId, ownerId, channel],
      );
      return true;
    }, pool);
    if (submitted === undefined) return false;
    await afterCommit?.();
    if (submitted) options.refresh?.();
    return true;
  }

  async function enqueueOutbox() {
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
  }

  async function currentMessage(
    row: OutboxRow,
    claimId: string,
    state: 'preparing' | 'sending',
    database: Pool | PoolClient = pool,
  ) {
    const result = await database.query(
      `SELECT 1 FROM messages m JOIN channel_outbox o ON o.message_id=m.id
       WHERE m.id=$1 AND m.owner_id=$2 AND o.claim_id=$4 AND o.state=$5
       AND m.thread_id IS NOT DISTINCT FROM $3::uuid
       AND (m.thread_id IS NULL OR EXISTS (
         SELECT 1 FROM threads th WHERE th.id=m.thread_id AND th.owner_id=$2 AND th.archived_at IS NULL FOR SHARE))`,
      [row.message_id, ownerId, row.message_thread_id, claimId, state],
    );
    return Boolean(result.rowCount);
  }

  async function outboxStep() {
    if (closed || replacing) return false;
    updateConfiguration();
    const unavailable = channels
      .filter((channel) => channel.available === false)
      .map((channel) => channel.id);
    const claimId = randomUUID();
    const result = await pool.query<OutboxRow>(
      `WITH claimed AS (
      UPDATE channel_outbox SET state='preparing',claim_id=$2,updated_at=now() WHERE message_id=(
        SELECT o.message_id FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id JOIN messages m ON m.id=o.message_id WHERE o.state='pending' AND i.owner_id=$1 AND m.owner_id=$1 AND NOT(i.provider=ANY($3::text[])) ORDER BY m.created_at,m.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
      ) RETURNING message_id,source_id,presentation
    ) SELECT c.message_id,m.owner_id,m.thread_id AS message_thread_id,i.provider,i.account_id,i.sender_id,i.thread_id,m.text,m.attachments,m.reply_to_message_id,c.presentation
      FROM claimed c JOIN channel_inbox i ON i.source_id=c.source_id JOIN messages m ON m.id=c.message_id`,
      [ownerId, claimId, unavailable],
    );
    const row = result.rows[0];
    if (!row) return false;
    const block = (
      reason: string,
      state: 'preparing' | 'sending' = 'preparing',
      database: Pool | PoolClient = pool,
    ) =>
      database.query(
        `UPDATE channel_outbox SET state='blocked',reason=$2,claim_id=NULL,updated_at=now()
         WHERE message_id=$1 AND claim_id=$3 AND state=$4`,
        [row.message_id, reason, claimId, state],
      );
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
      await block(reason);
      return true;
    }
    let attachments: MessagingAttachment[] | undefined;
    const canDeliverAttachments = channels.find(
      (channel) => channel.id === row.provider,
    )?.supportsAttachments;
    if (row.attachments?.length) {
      try {
        const requested = z
          .array(z.object({ id: z.uuid() }))
          .min(1)
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
      } catch (cause) {
        logFailure('channel_attachment_unavailable', cause);
        attachments = undefined;
      }
    }
    let text: string;
    let generated: string | undefined;
    try {
      if (row.presentation && !row.text.trim()) {
        const input =
          row.presentation.kind === 'command'
            ? {
                ...row.presentation,
                attachments: attachments
                  ? ('pending' as const)
                  : row.attachments?.length
                    ? ('in_nod' as const)
                    : ('none' as const),
              }
            : row.presentation;
        generated = await presentChannelText(row.message_thread_id, input, options.present);
      }
      text = await channelReply(generated ?? row.text, {
        threadId: row.message_thread_id,
        hasAttachments: !row.presentation && Boolean(row.attachments?.length),
        deliversAttachments: !row.presentation && Boolean(attachments),
        present: options.present,
      });
    } catch (cause) {
      logFailure('channel_presentation_failed', cause);
      await block('presentation_unavailable');
      return true;
    }
    if (generated && !closed && !replacing && permitted(row)) {
      const saved = await transaction(async (client) => {
        const current = await client.query(
          `SELECT 1 FROM channel_outbox WHERE message_id=$1 AND claim_id=$2
           AND state='preparing' FOR UPDATE`,
          [row.message_id, claimId],
        );
        if (!current.rowCount) return false;
        const result = await client.query(
          `UPDATE messages m SET text=$2 WHERE m.id=$1 AND m.owner_id=$3
           AND (m.thread_id IS NULL OR EXISTS (
             SELECT 1 FROM threads th WHERE th.id=m.thread_id AND th.owner_id=$3 AND th.archived_at IS NULL))`,
          [row.message_id, generated, ownerId],
        );
        return Boolean(result.rowCount);
      }, pool);
      if (!saved) {
        await block('thread_changed');
        return true;
      }
      options.refresh?.();
    }
    if (closed || replacing || !permitted(row)) {
      await block('channel_access_changed');
      return true;
    }
    const sending = await transaction(async (client) => {
      const result = await client.query(
        `UPDATE channel_outbox o SET state='sending',updated_at=now() FROM messages m
         WHERE o.message_id=$1 AND o.claim_id=$2 AND o.state='preparing'
           AND m.id=o.message_id AND m.owner_id=$3
           AND m.thread_id IS NOT DISTINCT FROM $4::uuid
           AND (m.thread_id IS NULL OR EXISTS (
             SELECT 1 FROM threads th WHERE th.id=m.thread_id AND th.owner_id=$3 AND th.archived_at IS NULL))
         RETURNING o.message_id`,
        [row.message_id, claimId, ownerId, row.message_thread_id],
      );
      if (!result.rowCount) {
        await block('thread_changed', 'preparing', client);
        return false;
      }
      if (!(await currentMessage(row, claimId, 'sending', client))) {
        await block('thread_changed', 'sending', client);
        return false;
      }
      if (closed || replacing || !permitted(row)) {
        await block('channel_access_changed', 'sending', client);
        return false;
      }
      return true;
    }, pool);
    if (!sending) return true;
    if (closed || replacing || !permitted(row)) {
      await block('channel_access_changed', 'sending');
      return true;
    }
    try {
      const target = row.reply_to_message_id
        ? ((
            await pool.query(
              `SELECT o.provider_message_id,m.text FROM channel_outbox o JOIN channel_inbox i ON i.source_id=o.source_id JOIN messages m ON m.id=o.message_id AND m.owner_id=i.owner_id
         WHERE o.message_id=$1 AND o.state='sent' AND i.owner_id=$2 AND i.provider=$3 AND i.account_id=$4 AND i.sender_id=$5 AND i.thread_id=$6`,
              [
                row.reply_to_message_id,
                ownerId,
                row.provider,
                row.account_id,
                row.sender_id,
                row.thread_id,
              ],
            )
          ).rows[0] as { provider_message_id: string; text: string } | undefined)
        : undefined;
      const sent = await transport.post({
        ...(target
          ? {
              replyToMessageId: target.provider_message_id,
              ...(row.provider === 'whatsapp'
                ? { replyToText: channelText(target.text).text }
                : {}),
            }
          : {}),
        channelId: row.provider,
        accountId: row.account_id,
        threadId: row.thread_id,
        text,
        ...(attachments
          ? {
              attachments,
              attachmentFailure: async (names: string[]) => {
                const notice = await presentChannelText(
                  row.message_thread_id,
                  {
                    kind: 'delivery',
                    text: '',
                    attachments: 'in_nod',
                    secureAction: false,
                    files: names.map((name) => channelText(name).text),
                  },
                  options.present,
                );
                if (
                  !(await currentMessage(row, claimId, 'sending')) ||
                  closed ||
                  replacing ||
                  !permitted(row)
                )
                  return undefined;
                return notice;
              },
            }
          : {}),
      });
      await pool.query(
        `WITH sent AS (UPDATE channel_outbox SET state='sent',provider_message_id=$2,provider_message_ids=$3,claim_id=NULL,updated_at=now()
           WHERE message_id=$1 AND claim_id=$4 AND state='sending' RETURNING message_id)
         UPDATE messages m SET delivered_channel=$5 FROM sent WHERE m.id=sent.message_id AND m.owner_id=$6 AND m.turn_id IS NULL`,
        [
          row.message_id,
          sent.id,
          sent.ids ?? [sent.id],
          claimId,
          conversationChannel(row),
          ownerId,
        ],
      );
    } catch (cause) {
      logFailure('channel_send_failed', cause);
      await pool.query(
        `UPDATE channel_outbox SET state='uncertain',reason='send_not_confirmed',claim_id=NULL,updated_at=now()
         WHERE message_id=$1 AND claim_id=$2 AND state='sending'`,
        [row.message_id, claimId],
      );
    }
    return true;
  }

  const presence = new Map<string, { at: number; status: string }>();
  async function presenceStep() {
    if (
      closed ||
      replacing ||
      !transport.presence ||
      !options.activity ||
      !channels.some((channel) => channel.status === 'configured' && channel.presenceMs)
    )
      return;
    const live = new Map<string, string>();
    for (const item of await options.activity())
      if (item.channel !== 'web')
        live.set(item.channel, [item.title, item.step].filter(Boolean).join(': '));
    for (const channel of presence.keys()) if (!live.has(channel)) presence.delete(channel);
    for (const [channel, text] of live) {
      const safe = channelText(text);
      const status = safe.secureAction || safe.artifact ? '' : safe.text;
      const row = (
        await pool.query<ChannelIdentity & { source_id: string; thread_id: string; at: Date }>(
          `SELECT provider,account_id,sender_id,source_id,thread_id,received_at AS at FROM channel_inbox
           WHERE owner_id=$1 AND channel=$2 AND state='submitted' ORDER BY received_at DESC LIMIT 1`,
          [ownerId, channel],
        )
      ).rows[0];
      if (!row || !permitted(row)) continue;
      const settings = channels.find((item) => item.id === row.provider);
      const prefix = `channel:${row.provider}:${row.account_id}:`;
      const last = presence.get(channel);
      if (
        !settings?.presenceMs ||
        !row.source_id.startsWith(prefix) ||
        (settings.replyWindowMs !== undefined &&
          Date.now() - row.at.getTime() >= settings.replyWindowMs) ||
        (last?.status === status && Date.now() - last.at < settings.presenceMs)
      )
        continue;
      if (closed || replacing) return;
      presence.set(channel, { at: Date.now(), status });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.presence({
            channelId: row.provider,
            accountId: row.account_id,
            threadId: row.thread_id,
            messageId: row.source_id.slice(prefix.length),
            ...(status ? { status } : {}),
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Presence did not answer in time.')), 5000);
          }),
        ]);
      } catch (cause) {
        logFailure('channel_presence_failed', cause);
      } finally {
        clearTimeout(timer);
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
              (reaction) => acceptReaction(reaction, reaction.channelId),
            );
          } catch (cause) {
            pollingFailed = true;
            logFailure('channel_poll_failed', cause);
          }
          const attempt = async (step: () => Promise<unknown>) => {
            try {
              return Boolean(await step());
            } catch (cause) {
              processingFailed = true;
              logFailure('channel_drain_failed', cause);
              return false;
            }
          };
          await attempt(enqueueOutbox);
          let inbox = true;
          let outbox = true;
          while ((inbox || outbox) && !closed && !replacing) {
            if (inbox && (inbox = await attempt(inboxStep))) {
              await attempt(enqueueOutbox);
              outbox = true;
            }
            if (outbox) outbox = await attempt(outboxStep);
          }
          try {
            await presenceStep();
          } catch (cause) {
            logFailure('channel_presence_failed', cause);
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
    receiving.abort();
    clearInterval(timer);
    unsubscribe();
    await running;
    await Promise.allSettled(pendingMedia.values());
    await transport.close();
  }

  async function replaceTransport(next: MessagingTransport) {
    if (closed || replacing) {
      await next.close();
      throw new Error('Channel configuration is unavailable.');
    }
    replacing = true;
    receiving.abort();
    try {
      await running;
      await Promise.allSettled(pendingMedia.values());
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
      receiving = new AbortController();
      replacing = false;
    }
    void drain();
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', close);
    app.get('/api/channels', async () => {
      updateConfiguration();
      return {
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
      };
    });
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
            for (const reaction of result.reactions ?? [])
              await acceptReaction(reaction, channelId);
            if (result.messages?.length) void drain();
            if (result.pairing?.channelId === channelId) await completePairing(result.pairing);
          }
          if (result.contentType) reply.type(result.contentType);
          return reply.code(result.status).send(result.body);
        },
      });
    });
  }

  return {
    registerRoutes,
    drain,
    close,
    replaceTransport,
    announcePairing,
    react,
    async pairing() {
      if (closed || replacing || !transport.pairing) throw new Error('QR pairing is unavailable.');
      return transport.pairing();
    },
    async unlink() {
      if (closed || replacing) throw new Error('Channel configuration is unavailable.');
      await transport.unlink?.();
    },
    async cancelPairing(pairingId: string, restart = false) {
      if (closed || replacing) return false;
      return (await transport.cancelPairing?.(pairingId, restart)) ?? false;
    },
  };
}
