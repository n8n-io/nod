import { createHmac, timingSafeEqual } from 'node:crypto';
import { Chat, ConsoleLogger } from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';
import { createPostgresState } from '@chat-adapter/state-pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  InboundMessage,
  MessagingChannel,
  MessagingTransport,
  MessagingWebhookResult,
} from '../../ports/messaging.ts';
import { telegramSecret, telegramUserId } from '../../ports/channel-settings.ts';

type Environment = Record<string, string | undefined>;

const logger = new ConsoleLogger('silent');
const telegramFileBytes = 50 * 1024 * 1024;
const telegramTextLimit = 3500;
const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().positive(),
  text: z.string().trim().min(1),
  from: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  }),
  chat: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('private'),
  }),
});
const whatsappMessage = z.object({
  id: z.string().min(1),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.literal('text'),
  text: z.object({ body: z.string().trim().min(1) }),
});
const whatsappEnvelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            metadata: z.object({ phone_number_id: z.string() }).optional(),
            messages: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});

function chunks(text: string) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > telegramTextLimit) {
    const slice = rest.slice(0, telegramTextLimit);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < telegramTextLimit / 2) cut = slice.lastIndexOf('\n');
    if (cut < telegramTextLimit / 2) cut = telegramTextLimit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return rest ? [...parts, rest] : parts;
}

function sameSecret(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function channelConfiguration(env: Environment) {
  const telegramMissing = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET_TOKEN',
    ...(env.TELEGRAM_PAIRING_EXPIRES_AT ? [] : ['TELEGRAM_ALLOWED_USER_ID']),
  ].filter((key) => !env[key]);
  if (env.TELEGRAM_ALLOWED_USER_ID && !telegramUserId.test(env.TELEGRAM_ALLOWED_USER_ID))
    telegramMissing.push('TELEGRAM_ALLOWED_USER_ID');
  if (env.TELEGRAM_WEBHOOK_SECRET_TOKEN && !telegramSecret.test(env.TELEGRAM_WEBHOOK_SECRET_TOKEN))
    telegramMissing.push('TELEGRAM_WEBHOOK_SECRET_TOKEN');
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN))
    telegramMissing.push('TELEGRAM_BOT_TOKEN');
  const whatsappMissing = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_ALLOWED_NUMBER',
  ].filter((key) => !env[key]);
  if (env.WHATSAPP_ALLOWED_NUMBER && !/^\d{7,15}$/.test(env.WHATSAPP_ALLOWED_NUMBER))
    whatsappMissing.push('WHATSAPP_ALLOWED_NUMBER');
  if (env.WHATSAPP_PHONE_NUMBER_ID && !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID))
    whatsappMissing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (env.WHATSAPP_POLICY_CONFIRMED !== 'true') whatsappMissing.push('WHATSAPP_POLICY_CONFIRMED');
  return (['telegram', 'whatsapp'] as const).map((provider) => {
    const enabled = env[`${provider.toUpperCase()}_ENABLED`] === 'true';
    const missing = provider === 'telegram' ? telegramMissing : whatsappMissing;
    return {
      provider,
      status: (!enabled
        ? 'disabled'
        : missing.length
          ? 'setup_required'
          : 'configured') as MessagingChannel['status'],
      missing: enabled ? missing : [],
    };
  });
}

export function createChatSdkTransport(
  pool: Pool,
  environment: Environment,
  options: { fetch?: typeof fetch } = {},
): MessagingTransport {
  const env = { ...environment };
  const request = options.fetch ?? fetch;
  const configuration = channelConfiguration(env);
  const configured = (provider: string) =>
    configuration.some(
      (channel) => channel.provider === provider && channel.status === 'configured',
    );
  const telegram = configured('telegram')
    ? createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN!,
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
        allowedUserIds: [env.TELEGRAM_ALLOWED_USER_ID ?? ''],
        mode: 'webhook',
        allowUnverifiedWebhooks: false,
        apiUrl: 'https://api.telegram.org',
        logger,
      })
    : undefined;
  const whatsapp = configured('whatsapp')
    ? createWhatsAppAdapter({
        accessToken: env.WHATSAPP_ACCESS_TOKEN!,
        appSecret: env.WHATSAPP_APP_SECRET!,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
        apiUrl: 'https://graph.facebook.com',
        logger,
      })
    : undefined;
  const state = createPostgresState({ client: pool, keyPrefix: 'otto-channels', logger });
  const bot = new Chat({
    userName: 'Otto',
    adapters: { ...(telegram ? { telegram } : {}), ...(whatsapp ? { whatsapp } : {}) },
    state,
    logger,
  });
  const channels: MessagingChannel[] = configuration.map((channel) => ({
    id: channel.provider,
    status: channel.status,
    missing: channel.missing,
    accountId:
      channel.provider === 'telegram'
        ? env.TELEGRAM_BOT_TOKEN?.split(':')[0]
        : env.WHATSAPP_PHONE_NUMBER_ID,
    allowedSenderIds: [
      channel.provider === 'telegram' ? env.TELEGRAM_ALLOWED_USER_ID : env.WHATSAPP_ALLOWED_NUMBER,
    ].filter((value): value is string => Boolean(value)),
    ...(channel.provider === 'whatsapp'
      ? { replyWindowMs: 86400000 }
      : { supportsAttachments: true }),
  }));
  const error = (status: number, message: string): MessagingWebhookResult => ({
    status,
    body: { error: message },
  });
  const accepted = (messages: InboundMessage[] = []): MessagingWebhookResult => ({
    status: 200,
    body: { ok: true },
    messages,
  });
  let closed = false;
  let polling = false;
  let offsetsReady: Promise<unknown> | undefined;
  const transport: MessagingTransport = {
    channels,
    async poll(accept, pair) {
      if (closed || polling || !telegram || env.TELEGRAM_MODE !== 'polling') return;
      polling = true;
      try {
        offsetsReady ??= pool
          .query(
            'CREATE TABLE IF NOT EXISTS channel_poll_offsets(provider text NOT NULL,account_id text NOT NULL,next_offset bigint NOT NULL,PRIMARY KEY(provider,account_id))',
          )
          .catch((error) => {
            offsetsReady = undefined;
            throw error;
          });
        await offsetsReady;
        const accountId = env.TELEGRAM_BOT_TOKEN!.split(':')[0];
        const saved = await pool.query<{ next_offset: string }>(
          "SELECT next_offset FROM channel_poll_offsets WHERE provider='telegram' AND account_id=$1",
          [accountId],
        );
        const response = await request(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              offset: Number(saved.rows[0]?.next_offset ?? 0),
              limit: 100,
              timeout: 0,
              allowed_updates: ['message'],
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) throw new Error('Telegram polling is unavailable.');
        const updates = z
          .object({
            ok: z.literal(true),
            result: z
              .array(z.object({ update_id: z.number().int().nonnegative() }).passthrough())
              .max(100),
          })
          .parse(await response.json());
        for (const update of updates.result) {
          if (closed) break;
          const parsed = await transport.receive({
            channelId: 'telegram',
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': env.TELEGRAM_WEBHOOK_SECRET_TOKEN },
            query: {},
            body: Buffer.from(JSON.stringify(update)),
          });
          if (parsed.status < 200 || parsed.status >= 300)
            throw new Error('Telegram update could not be accepted.');
          for (const message of parsed.messages ?? []) await accept(message);
          if (parsed.pairing) await pair?.(parsed.pairing);
          await pool.query(
            `INSERT INTO channel_poll_offsets(provider,account_id,next_offset) VALUES('telegram',$1,$2)
            ON CONFLICT(provider,account_id) DO UPDATE SET next_offset=GREATEST(channel_poll_offsets.next_offset,EXCLUDED.next_offset)`,
            [accountId, update.update_id + 1],
          );
        }
      } catch {
        throw new Error('Telegram polling is unavailable. Check the bot configuration.');
      } finally {
        polling = false;
      }
    },
    async receive(request) {
      if (!configured(request.channelId)) return error(404, 'Channel is not configured.');
      if (request.channelId === 'whatsapp' && request.method === 'GET') {
        const query = z
          .object({
            'hub.mode': z.literal('subscribe'),
            'hub.verify_token': z.string(),
            'hub.challenge': z.string().regex(/^\d{1,256}$/),
          })
          .safeParse(request.query);
        if (
          !query.success ||
          !sameSecret(query.data['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN!)
        )
          return error(403, 'Invalid webhook.');
        return { status: 200, body: query.data['hub.challenge'], contentType: 'text/plain' };
      }
      if (request.method !== 'POST') return error(405, 'This webhook method is unavailable.');
      if (request.channelId === 'telegram') {
        const secret = request.headers['x-telegram-bot-api-secret-token'];
        if (
          !sameSecret(
            typeof secret === 'string' ? secret : undefined,
            env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
          )
        )
          return error(401, 'Invalid webhook.');
      } else {
        const signature = request.headers['x-hub-signature-256'];
        const expected = `sha256=${createHmac('sha256', env.WHATSAPP_APP_SECRET!).update(request.body).digest('hex')}`;
        if (!sameSecret(typeof signature === 'string' ? signature : undefined, expected))
          return error(401, 'Invalid webhook.');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(request.body).toString());
      } catch {
        return error(400, 'Invalid JSON.');
      }
      if (request.channelId === 'telegram' && telegram) {
        const update = z
          .object({ update_id: z.number().int().nonnegative(), message: z.unknown() })
          .safeParse(payload);
        const parsed = telegramMessage.safeParse(update.success ? update.data.message : undefined);
        if (!parsed.success || String(parsed.data.from.id) !== String(parsed.data.chat.id))
          return accepted();
        const start = /^\/start(?:\s+(\S+))?$/.exec(parsed.data.text);
        if (env.TELEGRAM_ALLOWED_USER_ID && start) return accepted();
        const message = telegram.parseMessage(parsed.data);
        if (!env.TELEGRAM_ALLOWED_USER_ID) {
          const code = start?.[1];
          if (!code || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return accepted();
          const { username, first_name, last_name } = parsed.data.from;
          return {
            ...accepted(),
            pairing: {
              channelId: 'telegram',
              accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
              senderId: String(parsed.data.from.id),
              senderName:
                [first_name, last_name].filter(Boolean).join(' ').trim().slice(0, 200) ||
                'your Telegram account',
              ...(username && /^[A-Za-z0-9_]{1,64}$/.test(username)
                ? { senderUsername: username }
                : {}),
              messageId: message.id,
              threadId: message.threadId,
              code,
              sentAt: message.metadata.dateSent,
            },
          };
        }
        return accepted([
          {
            channelId: 'telegram',
            accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
            senderId: String(parsed.data.from.id),
            messageId: message.id,
            threadId: message.threadId,
            text: message.text,
            sentAt: message.metadata.dateSent,
          },
        ]);
      }
      const messages: InboundMessage[] = [];
      const envelope = whatsappEnvelope.safeParse(payload);
      if (envelope.success && whatsapp)
        for (const entry of envelope.data.entry)
          for (const change of entry.changes) {
            if (change.field !== 'messages' || !change.value.metadata?.phone_number_id) continue;
            for (const raw of change.value.messages ?? []) {
              const parsed = whatsappMessage.safeParse(raw);
              if (!parsed.success) continue;
              const accountId = change.value.metadata.phone_number_id;
              const message = whatsapp.parseMessage({
                message: parsed.data,
                phoneNumberId: accountId,
                userId: parsed.data.from,
              });
              messages.push({
                channelId: 'whatsapp',
                accountId,
                senderId: parsed.data.from,
                messageId: message.id,
                threadId: message.threadId,
                text: message.text,
                sentAt: message.metadata.dateSent,
              });
            }
          }
      return accepted(messages);
    },
    async post(input) {
      if (
        !channels.some(
          (channel) =>
            channel.id === input.channelId &&
            channel.status === 'configured' &&
            channel.accountId === input.accountId,
        )
      )
        throw new Error('Channel is not configured.');
      const attachments = input.attachments ?? [];
      if (attachments.length && input.channelId !== 'telegram')
        throw new Error('This channel does not support attachment delivery.');
      await bot.initialize();
      const thread = bot.thread(input.threadId);
      const unsent = attachments.filter((file) => !file.size || file.size > telegramFileBytes);
      let id = '';
      for (const part of input.channelId === 'telegram' ? chunks(input.text) : [input.text]) {
        const sent = await thread.post({ markdown: part });
        id ||= sent.id;
      }
      for (const file of attachments) {
        if (unsent.includes(file)) continue;
        await file
          .read()
          .then((bytes) =>
            thread.post({
              markdown: '',
              attachments: [
                {
                  type:
                    ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType) &&
                    file.size <= 10 * 1024 * 1024
                      ? 'image'
                      : file.mimeType === 'video/mp4'
                        ? 'video'
                        : 'file',
                  data: Buffer.from(bytes),
                  name: file.name,
                  mimeType: file.mimeType,
                  size: file.size,
                },
              ],
            }),
          )
          .then(
            (sent) => {
              id ||= sent.id;
            },
            () => {
              unsent.push(file);
            },
          );
      }
      if (unsent.length) {
        const notice = await input
          .attachmentFailure?.(unsent.map((file) => file.name))
          .catch(() => undefined);
        for (const part of chunks(notice ?? '')) {
          const sent = await thread.post({ markdown: part }).catch(() => undefined);
          id ||= sent?.id ?? '';
        }
      }
      if (!id) throw new Error('Channel delivery was not confirmed.');
      return { id };
    },
    async close() {
      if (!closed) {
        closed = true;
        await bot.shutdown();
      }
    },
  };
  return transport;
}
