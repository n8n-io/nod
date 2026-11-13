import { createHmac, timingSafeEqual } from 'node:crypto';
import { Chat, ConsoleLogger, convertEmojiPlaceholders, type Root } from 'chat';
import { TelegramAdapter, TelegramFormatConverter } from '@chat-adapter/telegram';
import { WhatsAppAdapter, WhatsAppApiError, splitMessage } from '@chat-adapter/whatsapp';
import { createPostgresState } from '@chat-adapter/state-pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  InboundMessage,
  InboundReaction,
  MessagingChannel,
  MessagingTransport,
  MessagingWebhookResult,
} from '../../ports/messaging.ts';
import { telegramSecret, telegramUserId } from '../../ports/channel-settings.ts';
import { MessagingConnectionError } from '../../ports/messaging.ts';
import { telegramMessage, telegramPairing, telegramAttachments } from './telegram.ts';
import { telegramText, whatsappText } from './format.ts';
import { contactCards, sharedLocation } from '../../shared/channel-content.ts';

type Environment = Record<string, string | undefined>;

const logger = new ConsoleLogger('silent');
const telegramFileBytes = 50 * 1024 * 1024;
const whatsappImageBytes = 5 * 1024 * 1024;
const telegramTextLimit = 3500;
const telegramReaction = z.object({
  message_id: z.number().int().nonnegative(),
  user: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
  }),
  chat: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('private'),
  }),
  new_reaction: z
    .array(z.object({ type: z.string(), emoji: z.string().min(1).max(64).optional() }))
    .max(10),
});
class TelegramMarkdown extends TelegramFormatConverter {
  override fromMarkdown(markdown: string) {
    return telegramText(markdown);
  }

  override fromAst(ast: Root) {
    return telegramText(ast);
  }
}

class Telegram extends TelegramAdapter {
  protected override readonly formatConverter = new TelegramMarkdown();

  constructor(...options: ConstructorParameters<typeof TelegramAdapter>) {
    super(...options);
    Reflect.set(this, 'richMessagesAvailable', false);
  }

  protected override telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
    request?: { signal?: AbortSignal },
  ) {
    return super.telegramFetch<TResult>(
      method,
      payload && !(payload instanceof FormData) && 'text' in payload
        ? { ...payload, link_preview_options: { is_disabled: true } }
        : payload,
      request,
    );
  }

  fits(text: string, limit: number) {
    return [
      text,
      this.formatConverter.fromMarkdown(text),
      this.renderPlainTextMessage({ markdown: text }, null),
    ].every((value) => convertEmojiPlaceholders(value, 'gchat').length <= limit);
  }

  chunks(text: string): string[] {
    const fit = (part: string): string[] =>
      this.fits(part, 4096) ? [part] : chunks(part, Math.floor(part.length / 2)).flatMap(fit);
    return chunks(text).flatMap(fit);
  }

  typing(threadId: string, signal?: AbortSignal) {
    return this.telegramFetch(
      'sendChatAction',
      { chat_id: this.decodeThreadId(threadId).chatId, action: 'typing' },
      { signal },
    );
  }

  async progress(input: Parameters<NonNullable<MessagingTransport['progress']>>[0]) {
    const chatId = this.decodeThreadId(input.threadId).chatId;
    const { messageId } = this.decodeCompositeMessageId(input.messageId, chatId);
    const quote = (status: string) => `${input.text}\n\n> ${status.replaceAll('\n', '\n> ')}`;
    let markdown = input.status ? quote(input.status) : input.text;
    if (input.status && !this.fits(markdown, 4096)) {
      const graphemes = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.status),
        ({ segment }) => segment,
      );
      let low = 1;
      let high = graphemes.length - 1;
      markdown = input.text;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const candidate = quote(`${graphemes.slice(0, count).join('').trimEnd()}…`);
        if (this.fits(candidate, 4096)) {
          markdown = candidate;
          low = count + 1;
        } else high = count - 1;
      }
    }
    if (!this.fits(markdown, 4096)) throw new Error('The Telegram status is too long.');
    input.signal.throwIfAborted();
    try {
      await this.telegramFetch(
        'editMessageText',
        {
          chat_id: chatId,
          message_id: messageId,
          text: convertEmojiPlaceholders(this.formatConverter.fromMarkdown(markdown), 'gchat'),
          parse_mode: 'MarkdownV2',
        },
        { signal: input.signal },
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        /message is not modified|message to edit not found/i.test(error.message)
      ))
        throw error;
    }
  }
}

class WhatsAppUploadError extends Error {}

class WhatsApp extends WhatsAppAdapter {
  protected override async uploadMedia(file: { data: Buffer; filename: string; mimeType: string }) {
    try {
      return await super.uploadMedia(file);
    } catch (cause) {
      throw new WhatsAppUploadError('The image could not be uploaded.', { cause });
    }
  }

  chunks(text: string) {
    return splitMessage(convertEmojiPlaceholders(whatsappText(text), 'whatsapp'));
  }

  async typing(messageId: string) {
    const result = await this.graphApiRequest<{ success?: boolean }>(
      `/${this.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
    );
    if (result.success === false) throw new Error('WhatsApp did not show typing.');
  }
}

const telegramReactions = new Set(
  '❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡'.split(
    ' ',
  ),
);
const whatsappReaction = z.object({
  id: z.string().min(1).max(256),
  from: z.string().regex(/^\d{7,15}$/),
  type: z.literal('reaction'),
  reaction: z.object({
    message_id: z.string().min(1).max(256),
    emoji: z.string().max(64).optional(),
  }),
});
const whatsappMessage = z.object({
  id: z.string().min(1),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  context: z.object({ id: z.string().min(1) }).optional(),
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

function chunks(text: string, limit = telegramTextLimit) {
  const parts: string[] = [];
  let rest = text;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = slice.lastIndexOf('\n');
    if (cut < limit / 2) cut = limit;
    let boundary = 0;
    for (const { index, segment } of graphemes.segment(rest)) {
      if (index + segment.length > cut) break;
      boundary = index + segment.length;
    }
    cut = boundary || cut;
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
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

function channelConfiguration(env: Environment) {
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
  const mediaRequest = request;
  const configuration = channelConfiguration(env);
  const configured = (provider: string) =>
    configuration.some(
      (channel) => channel.provider === provider && channel.status === 'configured',
    );
  const telegram = configured('telegram')
    ? new Telegram({
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
    ? new WhatsApp({
        userName: 'nod',
        accessToken: env.WHATSAPP_ACCESS_TOKEN!,
        appSecret: env.WHATSAPP_APP_SECRET!,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
        apiUrl: 'https://graph.facebook.com',
        logger,
      })
    : undefined;
  const state = createPostgresState({ client: pool, keyPrefix: 'nod-channels', logger });
  const bot = new Chat({
    userName: 'nod',
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
      ? { supportsAttachments: true, replyWindowMs: 86400000, presenceMs: 20000 }
      : { supportsAttachments: true, presenceMs: 3000 }),
  }));
  const error = (status: number, message: string): MessagingWebhookResult => ({
    status,
    body: { error: message },
  });
  const accepted = (
    messages: InboundMessage[] = [],
    reactions: InboundReaction[] = [],
  ): MessagingWebhookResult => ({
    status: 200,
    body: { ok: true },
    messages,
    ...(reactions.length ? { reactions } : {}),
  });
  let closed = false;
  let polling = false;
  let offsetsReady: Promise<unknown> | undefined;
  const transport: MessagingTransport = {
    channels,
    async poll(accept, pair, react) {
      if (closed || polling || !telegram || env.TELEGRAM_MODE !== 'polling') return;
      polling = true;
      let requesting = false;
      try {
        offsetsReady ??= pool
          .query(
            `CREATE TABLE IF NOT EXISTS channel_poll_offsets(provider text NOT NULL,account_id text NOT NULL,next_offset bigint NOT NULL,PRIMARY KEY(provider,account_id));
             ALTER TABLE channel_poll_offsets ADD COLUMN IF NOT EXISTS updated_at timestamptz`,
          )
          .catch((error) => {
            offsetsReady = undefined;
            throw error;
          });
        await offsetsReady;
        const accountId = env.TELEGRAM_BOT_TOKEN!.split(':')[0];
        const saved = await pool.query<{ next_offset: string }>(
          "SELECT CASE WHEN updated_at > now() - interval '24 hours' THEN next_offset ELSE 0 END AS next_offset FROM channel_poll_offsets WHERE provider='telegram' AND account_id=$1",
          [accountId],
        );
        requesting = true;
        const response = await request(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              offset: Number(saved.rows[0]?.next_offset ?? 0),
              limit: 100,
              timeout: 0,
              allowed_updates: ['message', 'message_reaction'],
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok || (body as { ok?: unknown } | null)?.ok === false) {
          const failure = z
            .object({
              description: z.string().max(2000).optional(),
              error_code: z.number().optional(),
            })
            .safeParse(body);
          let reason = failure.success
            ? (failure.data.description ?? response.statusText)
            : response.statusText;
          for (const secret of [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET_TOKEN])
            if (secret)
              for (const value of [secret, encodeURIComponent(secret)])
                reason = reason.replaceAll(value, '[redacted]');
          throw new MessagingConnectionError(
            `Telegram polling failed (HTTP ${response.status}${failure.success && failure.data.error_code ? `, code ${failure.data.error_code}` : ''})${reason ? `: ${reason}` : '.'}`,
          );
        }
        const updates = z
          .object({
            ok: z.literal(true),
            result: z
              .array(z.object({ update_id: z.number().int().nonnegative() }).passthrough())
              .max(100),
          })
          .parse(body);
        requesting = false;
        const channel = channels.find((channel) => channel.id === 'telegram')!;
        channel.available = true;
        channel.error = undefined;
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
          for (const reaction of parsed.reactions ?? []) await react?.(reaction);
          if (parsed.pairing) await pair?.(parsed.pairing);
          await pool.query(
            `INSERT INTO channel_poll_offsets(provider,account_id,next_offset,updated_at) VALUES('telegram',$1,$2,now())
            ON CONFLICT(provider,account_id) DO UPDATE SET next_offset=CASE WHEN channel_poll_offsets.updated_at > now() - interval '24 hours' THEN GREATEST(channel_poll_offsets.next_offset,EXCLUDED.next_offset) ELSE EXCLUDED.next_offset END,updated_at=now()`,
            [accountId, update.update_id + 1],
          );
        }
      } catch (cause) {
        const channel = channels.find((channel) => channel.id === 'telegram')!;
        const source = cause as { code?: unknown; cause?: { code?: unknown } } | undefined;
        const code = source?.code ?? source?.cause?.code;
        const detail =
          typeof code === 'string' && /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{0,31})$/.test(code)
            ? ` (${code})`
            : '';
        const failure =
          cause instanceof MessagingConnectionError
            ? cause
            : new MessagingConnectionError(
                requesting
                  ? `Telegram could not receive messages${detail}. Select Reconnect.`
                  : `Telegram message processing failed${detail}.`,
              );
        if (requesting) {
          channel.available = false;
          channel.error = failure.message;
        }
        throw failure;
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
          .object({
            update_id: z.number().int().nonnegative(),
            message: z.unknown().optional(),
            message_reaction: z.unknown().optional(),
          })
          .safeParse(payload);
        const reacted = telegramReaction.safeParse(
          update.success ? update.data.message_reaction : undefined,
        );
        if (reacted.success) {
          const { chat, user, message_id, new_reaction } = reacted.data;
          const emoji = new_reaction.filter((item) => item.type === 'emoji' && item.emoji).at(-1);
          if (
            !env.TELEGRAM_ALLOWED_USER_ID ||
            user.id !== chat.id ||
            (new_reaction.length && !emoji)
          )
            return accepted();
          return accepted(
            [],
            [
              {
                channelId: 'telegram',
                accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
                senderId: String(user.id),
                messageId: `${chat.id}:${message_id}`,
                reaction: emoji?.emoji
                  ? emoji.emoji.replace(
                      /(\p{Extended_Pictographic})(?!\uFE0F)(?<!\p{Emoji_Presentation})/gu,
                      '$1\uFE0F',
                    )
                  : null,
              },
            ],
          );
        }
        const parsed = telegramMessage.safeParse(update.success ? update.data.message : undefined);
        if (!parsed.success || String(parsed.data.from.id) !== String(parsed.data.chat.id))
          return accepted();
        if (
          env.TELEGRAM_ALLOWED_USER_ID &&
          String(parsed.data.from.id) !== env.TELEGRAM_ALLOWED_USER_ID
        )
          return accepted();
        const attachments = telegramAttachments(parsed.data, env.TELEGRAM_BOT_TOKEN!, mediaRequest);
        const text = parsed.data.text || parsed.data.caption || '';
        if (!text && !attachments.length) return accepted();
        const start = /^\/start(?:\s+(\S+))?$/.exec(parsed.data.text);
        if (env.TELEGRAM_ALLOWED_USER_ID && start) return accepted();
        const replied = parsed.data.reply_to_message;
        const message = telegram.parseMessage({
          message_id: parsed.data.message_id,
          date: parsed.data.date,
          chat: parsed.data.chat,
          from: parsed.data.from,
          text,
        });
        const replyId = replied
          ? telegram.parseMessage({
              message_id: replied.message_id,
              chat: parsed.data.chat,
              date: parsed.data.date,
            }).id
          : undefined;
        if (!env.TELEGRAM_ALLOWED_USER_ID) {
          const pairing = telegramPairing(
            parsed.data,
            env.TELEGRAM_BOT_TOKEN!.split(':')[0],
            () => message,
          );
          return { ...accepted(), ...(pairing ? { pairing } : {}) };
        }
        return accepted([
          {
            channelId: 'telegram',
            accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
            senderId: String(parsed.data.from.id),
            messageId: message.id,
            replyToMessageId: replyId,
            threadId: message.threadId,
            text,
            ...(attachments.length ? { attachments } : {}),
            sentAt: message.metadata.dateSent,
          },
        ]);
      }
      const messages: InboundMessage[] = [];
      const reactions: InboundReaction[] = [];
      const envelope = whatsappEnvelope.safeParse(payload);
      if (envelope.success && whatsapp)
        for (const entry of envelope.data.entry)
          for (const change of entry.changes) {
            if (change.field !== 'messages' || !change.value.metadata?.phone_number_id) continue;
            for (const raw of change.value.messages ?? []) {
              const accountId = change.value.metadata.phone_number_id;
              const reacted = whatsappReaction.safeParse(raw);
              if (reacted.success) {
                reactions.push({
                  channelId: 'whatsapp',
                  accountId,
                  senderId: reacted.data.from,
                  messageId: reacted.data.reaction.message_id,
                  reaction: reacted.data.reaction.emoji || null,
                });
                continue;
              }
              const parsed = whatsappMessage.safeParse(raw);
              if (!parsed.success) continue;
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
                replyToMessageId: parsed.data.context?.id,
                threadId: message.threadId,
                text: message.text,
                sentAt: message.metadata.dateSent,
              });
            }
          }
      return accepted(messages, reactions);
    },
    async react(input) {
      input.signal?.throwIfAborted();
      if (
        !channels.some(
          (channel) =>
            channel.id === input.channelId &&
            channel.status === 'configured' &&
            channel.accountId === input.accountId,
        )
      )
        throw new Error('Channel is not configured.');
      const adapter =
        input.channelId === 'telegram'
          ? telegram
          : input.channelId === 'whatsapp'
            ? whatsapp
            : null;
      if (!adapter) return 'unsupported';
      const emoji =
        input.channelId === 'telegram' ? input.reaction?.replaceAll('\uFE0F', '') : input.reaction;
      if (input.channelId === 'telegram' && emoji && !telegramReactions.has(emoji))
        return 'unsupported';
      await bot.initialize();
      input.signal?.throwIfAborted();
      if (emoji) await adapter.addReaction(input.threadId, input.messageId, emoji);
      else await adapter.removeReaction(input.threadId, input.messageId, '');
      return 'sent';
    },
    async presence(input) {
      if (
        !channels.some(
          (channel) =>
            channel.id === input.channelId &&
            channel.status === 'configured' &&
            channel.accountId === input.accountId,
        )
      )
        throw new Error('Channel is not configured.');
      await bot.initialize();
      if (input.channelId === 'telegram' && telegram) {
        await telegram.typing(input.threadId, input.signal);
      }
      if (input.channelId === 'whatsapp' && whatsapp) await whatsapp.typing(input.messageId);
    },
    async progress(input) {
      if (
        !telegram ||
        input.channelId !== 'telegram' ||
        input.accountId !== env.TELEGRAM_BOT_TOKEN!.split(':')[0]
      )
        throw new Error('Channel is not configured.');
      await telegram.progress(input);
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
      await bot.initialize();
      const thread = bot.thread(input.threadId);
      const unsent = attachments.filter((file) =>
        input.channelId === 'whatsapp'
          ? !['image/png', 'image/jpeg'].includes(file.mimeType) ||
            !file.size ||
            file.size > whatsappImageBytes
          : !file.size || file.size > telegramFileBytes,
      );
      const caption =
        input.channelId === 'telegram' &&
        attachments.length === 1 &&
        !unsent.length &&
        !attachments[0].mimeType.startsWith('audio/') &&
        !/^(?:text\/(?:x-)?vcard)$/.test(attachments[0].mimeType) &&
        attachments[0].name !== 'location.json' &&
        input.text.trim() &&
        telegram!.fits(input.text, 1024)
          ? input.text
          : '';
      let id = '';
      const ids: string[] = [];
      const post = (message: Parameters<typeof thread.reply>[1]) =>
        input.replyToMessageId
          ? thread.reply(input.replyToMessageId, message)
          : thread.post(message);
      const messages =
        input.channelId === 'telegram'
          ? telegram!.chunks(caption ? '' : input.text).map((markdown) => ({ markdown }))
          : whatsapp!.chunks(input.text).map((raw) => ({ raw }));
      for (const message of messages) {
        const sent = await post(message);
        id ||= sent.id;
        ids.push(sent.id);
      }
      for (const file of attachments) {
        if (unsent.includes(file)) continue;
        if (input.channelId === 'telegram' && /^audio\/(ogg|mpeg|mp4)$/.test(file.mimeType)) {
          const decoded = telegram!.decodeThreadId(input.threadId);
          const body = new FormData();
          body.set('chat_id', decoded.chatId);
          if (decoded.messageThreadId)
            body.set('message_thread_id', String(decoded.messageThreadId));
          if (input.replyToMessageId)
            body.set(
              'reply_parameters',
              JSON.stringify({ message_id: Number(input.replyToMessageId.split(':').at(-1)) }),
            );
          let bytes: Uint8Array;
          try {
            bytes = await file.read();
          } catch {
            unsent.push(file);
            continue;
          }
          body.set('voice', new Blob([Uint8Array.from(bytes)], { type: file.mimeType }), file.name);
          const response = await request(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`,
            { method: 'POST', body, signal: AbortSignal.timeout(60_000), redirect: 'error' },
          );
          if (!response.ok) throw new Error('Voice delivery was not confirmed.');
          const sent = z
            .object({
              ok: z.literal(true),
              result: z.object({ message_id: z.number().int().positive() }),
            })
            .parse(await response.json());
          const voiceId = `${decoded.chatId}:${sent.result.message_id}`;
          id ||= voiceId;
          ids.push(voiceId);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await file.read();
        } catch {
          if (caption)
            for (const part of telegram!.chunks(input.text)) {
              const sent = await post({ markdown: part });
              id ||= sent.id;
              ids.push(sent.id);
            }
          unsent.push(file);
          continue;
        }
        if (input.channelId === 'whatsapp') {
          if (bytes.length !== file.size || bytes.length > whatsappImageBytes) {
            unsent.push(file);
            continue;
          }
          try {
            const sent = await post({
              markdown: '',
              attachments: [
                {
                  type: 'image',
                  data: Buffer.from(bytes),
                  name: file.name,
                  mimeType: file.mimeType,
                  size: file.size,
                },
              ],
            });
            id ||= sent.id;
            ids.push(sent.id);
          } catch (cause) {
            if (
              cause instanceof WhatsAppUploadError ||
              (cause instanceof WhatsAppApiError &&
                cause.errorCode !== undefined &&
                cause.status >= 400 &&
                cause.status < 500 &&
                cause.status !== 408 &&
                cause.status !== 499)
            ) {
              unsent.push(file);
              continue;
            }
            throw cause;
          }
          continue;
        }
        if (
          input.channelId === 'telegram' &&
          bytes.length === file.size &&
          ((/^(?:text\/(?:x-)?vcard)$/.test(file.mimeType) && bytes.length <= 2048) ||
            (file.name === 'location.json' && bytes.length <= 4096))
        ) {
          const text = new TextDecoder().decode(bytes);
          const contacts = /^(?:text\/(?:x-)?vcard)$/.test(file.mimeType) ? contactCards(text) : [];
          let location;
          try {
            if (file.name === 'location.json')
              location = sharedLocation.safeParse(JSON.parse(text));
          } catch {}
          const native =
            contacts.length === 1 &&
            Buffer.byteLength(contacts[0].vcard) <= 2048 &&
            /^\+?(?:[\s().-]*\d)+[\s().-]*$/.test(contacts[0].phones[0] ?? '')
              ? contacts.map((contact) => ({
                  method: 'sendContact',
                  data: {
                    phone_number: contact.phones[0],
                    first_name: contact.name,
                    vcard: contact.vcard,
                  },
                }))
              : location?.success
                ? [
                    {
                      method:
                        location.data.name || location.data.address ? 'sendVenue' : 'sendLocation',
                      data: {
                        latitude: location.data.latitude,
                        longitude: location.data.longitude,
                        ...(location.data.name || location.data.address
                          ? {
                              title: location.data.name || location.data.address,
                              address: location.data.address || location.data.name,
                            }
                          : {}),
                      },
                    },
                  ]
                : [];
          const decoded = telegram!.decodeThreadId(input.threadId);
          for (const message of native) {
            const response = await request(
              `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${message.method}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: decoded.chatId,
                  ...(decoded.messageThreadId
                    ? { message_thread_id: decoded.messageThreadId }
                    : {}),
                  ...(input.replyToMessageId
                    ? {
                        reply_parameters: {
                          message_id: Number(input.replyToMessageId.split(':').at(-1)),
                        },
                      }
                    : {}),
                  ...message.data,
                }),
                signal: AbortSignal.timeout(60_000),
                redirect: 'error',
              },
            );
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              throw new Error('Message delivery was not confirmed.');
            }
            const sent = z
              .object({
                ok: z.literal(true),
                result: z.object({ message_id: z.number().int().positive() }),
              })
              .parse(await response.json());
            const nativeId = `${decoded.chatId}:${sent.result.message_id}`;
            id ||= nativeId;
            ids.push(nativeId);
          }
          if (native.length) continue;
        }
        await post({
          markdown: caption,
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
        }).then(
          (sent) => {
            id ||= sent.id;
            ids.push(sent.id);
          },
          () => {
            if (caption) throw new Error('Media delivery was not confirmed.');
            unsent.push(file);
          },
        );
      }
      if (unsent.length) {
        const notice = await input
          .attachmentFailure?.(unsent.map((file) => file.name))
          .catch(() => undefined);
        const notices =
          input.channelId === 'telegram'
            ? telegram!.chunks(notice ?? '').map((markdown) => ({ markdown }))
            : whatsapp!.chunks(notice ?? '').map((raw) => ({ raw }));
        for (const notice of notices) {
          const sent = await post(notice).catch(() => undefined);
          if (sent) {
            id ||= sent.id;
            ids.push(sent.id);
          }
        }
      }
      if (!id) throw new Error('Channel delivery was not confirmed.');
      return { id, ids };
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
