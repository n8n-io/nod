import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Chat,
  ConsoleLogger,
  markdownToPlainText,
  parseMarkdown,
  type AdapterPostableMessage,
} from 'chat';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';
import { createPostgresState } from '@chat-adapter/state-pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  MessagingPartialSend,
  MessagingRetryLater,
  type InboundMessage,
  type InboundPress,
  type MessagingButton,
  type MessagingChannel,
  type MessagingTransport,
  type MessagingWebhookResult,
} from '../../ports/messaging.ts';

type Environment = Record<string, string | undefined>;

const logger = new ConsoleLogger('silent');
const telegramMessage = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().positive(),
  text: z.string().trim().min(1).max(24000),
  from: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
    first_name: z.string().max(256),
    last_name: z.string().max(256).optional(),
    username: z.string().max(256).optional(),
  }),
  chat: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: z.literal('private'),
  }),
  reply_to_message: z.object({ message_id: z.number().int().nonnegative() }).optional(),
});
const telegramPress = z.object({
  id: z.string().min(1).max(256),
  from: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_bot: z.literal(false),
  }),
  message: z.object({
    chat: z.object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      type: z.literal('private'),
    }),
  }),
  data: z.string().min(1).max(64),
});
const telegramReply = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});
const whatsappPress = z.object({
  id: z.string().min(1).max(256),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.literal('interactive'),
  interactive: z.object({
    type: z.literal('button_reply'),
    button_reply: z.object({ id: z.string().min(1).max(256) }),
  }),
});
const whatsappMessage = z.object({
  id: z.string().min(1).max(256),
  from: z.string().regex(/^\d{7,15}$/),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.literal('text'),
  text: z.object({ body: z.string().trim().min(1).max(24000) }),
  context: z.object({ id: z.string().min(1).max(256).optional() }).optional(),
});
const whatsappEnvelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                messages: z.array(z.unknown()).max(100).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});

function declined(error: unknown) {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return code === 'VALIDATION_ERROR' || (status === 400 && code !== 'RATE_LIMITED');
}

function keyboard(buttons: MessagingButton[]) {
  return {
    inline_keyboard: buttons.length
      ? [buttons.map((button) => ({ text: button.title, callback_data: button.id }))]
      : [],
  };
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
  if (env.TELEGRAM_ALLOWED_USER_ID && !/^\d{1,16}$/.test(env.TELEGRAM_ALLOWED_USER_ID))
    telegramMissing.push('TELEGRAM_ALLOWED_USER_ID');
  if (
    env.TELEGRAM_WEBHOOK_SECRET_TOKEN &&
    !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET_TOKEN)
  )
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
      : { supportsAttachments: true, edits: true }),
  }));
  const ready = (channelId: string, accountId: string) =>
    channels.some(
      (channel) =>
        channel.id === channelId &&
        channel.status === 'configured' &&
        channel.accountId === accountId,
    );
  async function telegramCall(method: string, body: Record<string, unknown>) {
    const response = await request(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const reply = telegramReply
      .catch({ ok: false, result: undefined })
      .parse(await response.json().catch(() => undefined));
    if (reply.ok) return reply.result;
    if ((reply.error_code ?? response.status) === 429)
      throw new MessagingRetryLater((reply.parameters?.retry_after ?? 1) * 1000);
    throw Object.assign(new Error(`Telegram ${method} failed.`), {
      status: reply.error_code ?? response.status,
      description: reply.description ?? '',
    });
  }
  async function whatsappButtons(input: {
    threadId: string;
    text: string;
    replyTo?: string;
    buttons: MessagingButton[];
  }) {
    const interactive = {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: input.text },
        action: {
          buttons: input.buttons.slice(0, 3).map((button) => ({
            type: 'reply',
            reply: { id: button.id, title: button.title.slice(0, 20) },
          })),
        },
      },
    };
    const send = (context?: string) =>
      request(`https://graph.facebook.com/v25.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: whatsapp!.decodeThreadId(input.threadId).userWaId,
          ...(context ? { context: { message_id: context } } : {}),
          ...interactive,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    let response = await send(input.replyTo);
    if (response.status === 400 && input.replyTo) response = await send();
    if (!response.ok) throw new Error('WhatsApp declined the message.');
    return z
      .object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) })
      .parse(await response.json()).messages[0].id;
  }
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
    pollingEnabled: Boolean(telegram && env.TELEGRAM_MODE === 'polling'),
    async poll(accept, pair, press) {
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
              allowed_updates: ['message', 'callback_query'],
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
          for (const item of parsed.presses ?? []) await press?.(item);
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
          .object({
            update_id: z.number().int().nonnegative(),
            message: z.unknown().optional(),
            callback_query: z.unknown().optional(),
          })
          .safeParse(payload);
        const pressed = telegramPress.safeParse(
          update.success ? update.data.callback_query : undefined,
        );
        if (pressed.success) {
          const { id, from, message, data } = pressed.data;
          if (!env.TELEGRAM_ALLOWED_USER_ID || from.id !== message.chat.id) return accepted();
          return {
            ...accepted(),
            presses: [
              {
                channelId: 'telegram',
                accountId: env.TELEGRAM_BOT_TOKEN!.split(':')[0],
                senderId: String(from.id),
                pressId: id,
                threadId: telegram.encodeThreadId({ chatId: String(message.chat.id) }),
                data,
                sentAt: new Date(),
              },
            ],
          };
        }
        const parsed = telegramMessage.safeParse(update.success ? update.data.message : undefined);
        if (!parsed.success || String(parsed.data.from.id) !== String(parsed.data.chat.id))
          return accepted();
        const start = /^\/start(?:\s+(\S+))?$/.exec(parsed.data.text);
        if (env.TELEGRAM_ALLOWED_USER_ID && start) return accepted();
        const { reply_to_message: replied, ...raw } = parsed.data;
        const message = telegram.parseMessage(raw);
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
            ...(replied ? { replyTo: `${raw.chat.id}:${replied.message_id}` } : {}),
          },
        ]);
      }
      const messages: InboundMessage[] = [];
      const presses: InboundPress[] = [];
      const envelope = whatsappEnvelope.safeParse(payload);
      if (envelope.success && whatsapp)
        for (const entry of envelope.data.entry)
          for (const change of entry.changes) {
            if (change.field !== 'messages' || !change.value.metadata?.phone_number_id) continue;
            for (const raw of change.value.messages ?? []) {
              const accountId = change.value.metadata.phone_number_id;
              const pressed = whatsappPress.safeParse(raw);
              if (pressed.success) {
                presses.push({
                  channelId: 'whatsapp',
                  accountId,
                  senderId: pressed.data.from,
                  pressId: pressed.data.id,
                  threadId: whatsapp.encodeThreadId({
                    phoneNumberId: accountId,
                    userWaId: pressed.data.from,
                  }),
                  data: pressed.data.interactive.button_reply.id,
                  sentAt: new Date(Number(pressed.data.timestamp) * 1000),
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
                threadId: message.threadId,
                text: message.text,
                sentAt: message.metadata.dateSent,
                ...(parsed.data.context?.id ? { replyTo: parsed.data.context.id } : {}),
              });
            }
          }
      return { ...accepted(messages), presses };
    },
    async post(input) {
      if (!ready(input.channelId, input.accountId)) throw new Error('Channel is not configured.');
      const attachments = input.attachments ?? [];
      if (input.buttons && !attachments.length) {
        if (input.channelId === 'telegram' && telegram) {
          const text = markdownToPlainText(input.text);
          if (text.trim() && text.length <= 4096) {
            const sent = z
              .object({ message_id: z.number().int(), chat: z.object({ id: z.number().int() }) })
              .parse(
                await telegramCall('sendMessage', {
                  chat_id: telegram.decodeThreadId(input.threadId).chatId,
                  text,
                  ...(input.buttons.length ? { reply_markup: keyboard(input.buttons) } : {}),
                  ...(input.replyTo
                    ? {
                        reply_parameters: {
                          message_id: Number(input.replyTo.split(':').at(-1)),
                          allow_sending_without_reply: true,
                        },
                      }
                    : {}),
                }),
              );
            return { ids: [`${sent.chat.id}:${sent.message_id}`], editable: true };
          }
        }
        if (input.channelId === 'whatsapp' && whatsapp && input.buttons.length) {
          const text = whatsapp.renderFormatted(parseMarkdown(input.text));
          if (text.trim() && text.length <= 1024)
            return {
              ids: [await whatsappButtons({ ...input, text, buttons: input.buttons })],
            };
        }
      }
      if (attachments.length && input.channelId !== 'telegram')
        throw new Error('This channel does not support attachment delivery.');
      if (
        attachments.length > 10 ||
        attachments.reduce((total, file) => total + file.bytes.byteLength, 0) > 15 * 1024 * 1024 ||
        attachments.some((file) => !file.bytes.byteLength)
      )
        throw new Error('Attachments exceed the delivery limit.');
      await bot.initialize();
      const thread = bot.thread(input.threadId);
      const separateText =
        input.text.length > 900 || Boolean(input.filesReplyToText && input.text.trim());
      const messages: AdapterPostableMessage[] = attachments.length
        ? [
            ...(separateText ? [{ markdown: input.text }] : []),
            ...attachments.map((file, index): AdapterPostableMessage => ({
              markdown: index === 0 && !separateText ? input.text : '',
              attachments: [
                {
                  type:
                    ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType) &&
                    file.bytes.byteLength <= 10 * 1024 * 1024
                      ? 'image'
                      : file.mimeType === 'video/mp4'
                        ? 'video'
                        : 'file',
                  data: Buffer.from(file.bytes),
                  name: file.name,
                  mimeType: file.mimeType,
                  size: file.bytes.byteLength,
                },
              ],
            })),
          ]
        : input.channelId === 'whatsapp' && whatsapp
          ? whatsapp
              .splitMessage(whatsapp.renderFormatted(parseMarkdown(input.text)))
              .map((raw) => ({ raw }))
          : [{ markdown: input.text }];
      const ids: string[] = [];
      try {
        for (const message of messages) {
          const replyTo = !ids.length
            ? input.replyTo
            : input.filesReplyToText && separateText
              ? ids[0]
              : undefined;
          const sent = replyTo
            ? await thread.reply(replyTo, message).catch((error: unknown) => {
                if (!declined(error)) throw error;
                return thread.post(message);
              })
            : await thread.post(message);
          ids.push(sent.id);
        }
      } catch (error) {
        const { code, retryAfter } = (error ?? {}) as { code?: unknown; retryAfter?: unknown };
        if (ids.length) throw new MessagingPartialSend(ids, { cause: error });
        if (input.channelId === 'telegram' && code === 'RATE_LIMITED')
          throw new MessagingRetryLater((typeof retryAfter === 'number' ? retryAfter : 1) * 1000);
        throw error;
      }
      return { ids };
    },
    async edit(input) {
      if (input.channelId !== 'telegram' || !telegram || !ready(input.channelId, input.accountId))
        throw new Error('This channel cannot edit messages.');
      await telegramCall('editMessageText', {
        chat_id: telegram.decodeThreadId(input.threadId).chatId,
        message_id: Number(input.messageId.split(':').at(-1)),
        text: markdownToPlainText(input.text).slice(0, 4096),
        reply_markup: keyboard(input.buttons),
      }).catch((error: unknown) => {
        if (
          !/message is not modified/i.test(String((error as { description?: unknown }).description))
        )
          throw error;
      });
    },
    async ack(input) {
      if (input.channelId !== 'telegram' || !telegram || !ready(input.channelId, input.accountId))
        return false;
      await telegramCall('answerCallbackQuery', {
        callback_query_id: input.pressId,
        ...(input.text ? { text: input.text.slice(0, 200) } : {}),
      }).catch(() => undefined);
      return true;
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
