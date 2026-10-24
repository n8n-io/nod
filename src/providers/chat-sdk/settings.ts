import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  ChannelSetupFailure,
  telegramSecret,
  type ChannelSetupVerifier,
} from '../../ports/channel-settings.ts';

const webhookUrl = z.url().max(2048).optional();
const telegramInput = z
  .object({
    botToken: z
      .string()
      .max(8192)
      .transform((value) => {
        const tokens = value.match(/(?<![\w:-])\d+:[\w-]+(?![\w:-])/g);
        return tokens?.length === 1 ? tokens[0] : '';
      })
      .pipe(
        z
          .string()
          .regex(/^\d+:[A-Za-z0-9_-]+$/)
          .max(512),
      ),
    webhookUrl,
  })
  .strict();
const whatsappInput = z
  .object({
    accessToken: z.string().trim().min(10).max(4096),
    appSecret: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{32}$/),
    phoneNumberId: z
      .string()
      .trim()
      .regex(/^\d{1,30}$/),
    allowedNumber: z
      .string()
      .trim()
      .regex(/^\d{7,15}$/),
    verifyToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
    webhookUrl,
    policyConfirmed: z.literal(true),
  })
  .strict();

function publicWebhook(value: string | undefined, provider: string, expected?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) ||
    (expected
      ? url.href !== expected ||
        !new RegExp(`^/api/webhooks/${provider}/[A-Za-z0-9_-]{32,256}$`).test(url.pathname)
      : url.pathname !== `/api/webhooks/${provider}`)
  )
    throw new ChannelSetupFailure('invalid_input');
  return url.href;
}

export function createChatSdkSetupVerifier(
  options: {
    fetch?: typeof fetch;
    webhookUrl?: (provider: 'telegram' | 'whatsapp') => string;
  } = {},
): ChannelSetupVerifier {
  const request = options.fetch ?? fetch;
  function endpoint(value: string | undefined, provider: 'telegram' | 'whatsapp') {
    const expected = options.webhookUrl?.(provider);
    if (expected && value && new URL(value).href !== new URL(expected).href)
      throw new ChannelSetupFailure('invalid_input');
    return publicWebhook(
      expected ?? value,
      provider,
      expected ? new URL(expected).href : undefined,
    );
  }
  async function json(url: string, init: RequestInit = {}) {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ChannelSetupFailure('verification_failed');
    return z.record(z.string(), z.unknown()).parse(await response.json());
  }
  return {
    async verify(provider, input): ReturnType<ChannelSetupVerifier['verify']> {
      try {
        if (provider === 'telegram') {
          const parsed = telegramInput.safeParse(input);
          if (!parsed.success) throw new ChannelSetupFailure('invalid_input');
          const value = parsed.data;
          const webhookEndpoint = endpoint(value.webhookUrl, provider);
          const base = `https://api.telegram.org/bot${value.botToken}`;
          const me = await json(`${base}/getMe`);
          const account = z
            .object({
              id: z.number().int().positive(),
              is_bot: z.literal(true),
              first_name: z.string().max(200),
              username: z.string().max(100),
            })
            .parse(me.result);
          if (me.ok !== true || String(account.id) !== value.botToken.split(':')[0])
            throw new ChannelSetupFailure('verification_failed');
          const existing = await json(`${base}/getWebhookInfo`);
          const webhook = z.object({ url: z.string() }).parse(existing.result);
          if (existing.ok !== true) throw new ChannelSetupFailure('verification_failed');
          if (!webhookEndpoint && webhook.url) throw new ChannelSetupFailure('existing_webhook');
          const secret = randomBytes(32).toString('base64url');
          return {
            environment: {
              TELEGRAM_ENABLED: 'true',
              TELEGRAM_BOT_TOKEN: value.botToken,
              TELEGRAM_ALLOWED_USER_ID: '',
              TELEGRAM_WEBHOOK_SECRET_TOKEN: secret,
              TELEGRAM_MODE: webhookEndpoint ? 'webhook' : 'polling',
            },
            summary: {
              provider,
              enabled: true,
              accountName: account.first_name,
              accountHandle: `@${account.username}`,
              mode: webhookEndpoint ? 'webhook' : 'polling',
              ...(webhookEndpoint
                ? { webhookUrl: webhookEndpoint, webhookStatus: 'registration_pending' as const }
                : {}),
            },
          };
        }
        const linked = z
          .object({
            mode: z.enum(['bot', 'self-chat']),
            allowedNumber: z
              .string()
              .trim()
              .regex(/^\d{7,15}$/)
              .optional(),
            policyConfirmed: z.literal(true),
          })
          .strict()
          .safeParse(input);
        if (linked.success) {
          if (linked.data.mode === 'bot' && !linked.data.allowedNumber)
            throw new ChannelSetupFailure('invalid_input');
          return {
            environment: {
              WHATSAPP_ENABLED: 'true',
              WHATSAPP_MODE: linked.data.mode,
              WHATSAPP_ALLOWED_NUMBER: linked.data.allowedNumber ?? '',
              WHATSAPP_POLICY_CONFIRMED: 'true',
            },
            summary: { provider, enabled: true, mode: 'linked', linkMode: linked.data.mode },
          };
        }
        const parsed = whatsappInput.safeParse(input);
        if (!parsed.success) throw new ChannelSetupFailure('invalid_input');
        const value = parsed.data;
        const webhookEndpoint = endpoint(value.webhookUrl, provider);
        const url = new URL(`https://graph.facebook.com/v25.0/${value.phoneNumberId}`);
        url.searchParams.set('fields', 'id,display_phone_number,verified_name');
        url.searchParams.set(
          'appsecret_proof',
          createHmac('sha256', value.appSecret).update(value.accessToken).digest('hex'),
        );
        const data = await json(url.href, {
          headers: { Authorization: `Bearer ${value.accessToken}` },
        });
        const account = z
          .object({
            id: z.string(),
            display_phone_number: z.string().max(100),
            verified_name: z.string().max(200).optional(),
          })
          .parse(data);
        if (account.id !== value.phoneNumberId)
          throw new ChannelSetupFailure('verification_failed');
        return {
          environment: {
            WHATSAPP_ENABLED: 'true',
            WHATSAPP_MODE: 'cloud',
            WHATSAPP_POLICY_CONFIRMED: 'true',
            WHATSAPP_ACCESS_TOKEN: value.accessToken,
            WHATSAPP_APP_SECRET: value.appSecret,
            WHATSAPP_PHONE_NUMBER_ID: value.phoneNumberId,
            WHATSAPP_ALLOWED_NUMBER: value.allowedNumber,
            WHATSAPP_VERIFY_TOKEN: value.verifyToken,
          },
          summary: {
            provider,
            enabled: true,
            ...(account.verified_name ? { accountName: account.verified_name } : {}),
            accountHandle: account.display_phone_number,
            mode: 'webhook',
            webhookStatus: 'manual_setup',
            ...(webhookEndpoint ? { webhookUrl: webhookEndpoint } : {}),
          },
        };
      } catch (error) {
        if (error instanceof ChannelSetupFailure) throw error;
        throw new ChannelSetupFailure('verification_failed');
      }
    },
    async register(provider, { environment, summary }) {
      try {
        if (provider !== 'telegram' || summary.mode !== 'webhook')
          throw new ChannelSetupFailure('invalid_input');
        const value = telegramInput.parse({
          botToken: environment.TELEGRAM_BOT_TOKEN,
          webhookUrl: summary.webhookUrl,
        });
        const webhookEndpoint = endpoint(value.webhookUrl, provider);
        const secret = z
          .string()
          .regex(telegramSecret)
          .parse(environment.TELEGRAM_WEBHOOK_SECRET_TOKEN);
        if (!webhookEndpoint) throw new ChannelSetupFailure('invalid_input');
        const registered = await json(`https://api.telegram.org/bot${value.botToken}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: webhookEndpoint,
            secret_token: secret,
            allowed_updates: ['message', 'message_reaction'],
            drop_pending_updates: false,
          }),
        });
        if (registered.ok !== true || registered.result !== true)
          throw new ChannelSetupFailure('webhook_failed');
      } catch {
        throw new ChannelSetupFailure('webhook_failed');
      }
    },
    async unregister(provider, environment) {
      if (provider !== 'telegram' || environment.TELEGRAM_MODE !== 'webhook') return;
      const { botToken } = telegramInput.pick({ botToken: true }).parse({
        botToken: environment.TELEGRAM_BOT_TOKEN,
      });
      await json(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true }),
      });
    },
  };
}
