import { z } from 'zod';
import { ChannelSetupFailure, type ChannelSetupVerifier } from '../src/ports/channel-settings.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';

export const fixtureChannelCredentials = {
  telegram: {
    botToken: '777000111:synthetic-channel-fixture',
  },
  whatsapp: {
    phoneNumberId: '987654321',
    allowedNumber: '15555550123',
    accessToken: 'synthetic-whatsapp-access-token',
    appSecret: 'synthetic-whatsapp-app-secret',
    verifyToken: 'synthetic-verify-token-2026',
    policyConfirmed: true,
  },
} as const;

const telegramInput = z
  .object({
    botToken: z.literal(fixtureChannelCredentials.telegram.botToken),
    webhookUrl: z.literal('https://channels.example.test/api/webhooks/telegram').optional(),
  })
  .strict();
const whatsappInput = z
  .object({
    phoneNumberId: z.literal(fixtureChannelCredentials.whatsapp.phoneNumberId),
    allowedNumber: z.literal(fixtureChannelCredentials.whatsapp.allowedNumber),
    accessToken: z.literal(fixtureChannelCredentials.whatsapp.accessToken),
    appSecret: z.literal(fixtureChannelCredentials.whatsapp.appSecret),
    verifyToken: z.literal(fixtureChannelCredentials.whatsapp.verifyToken),
    policyConfirmed: z.literal(true),
    webhookUrl: z.literal('https://channels.example.test/api/webhooks/whatsapp').optional(),
  })
  .strict();

export function createFixtureMessagingSetup(): {
  verifier: ChannelSetupVerifier;
  create(environment: Record<string, string>): MessagingTransport;
} {
  const verifier: ChannelSetupVerifier = {
    async verify(provider, raw): ReturnType<ChannelSetupVerifier['verify']> {
      if (provider === 'telegram') {
        const parsed = telegramInput.safeParse(raw);
        if (!parsed.success) throw new ChannelSetupFailure('invalid_input');
        const input = parsed.data;
        return {
          environment: {
            TELEGRAM_ENABLED: 'true',
            TELEGRAM_BOT_TOKEN: input.botToken,
            TELEGRAM_ALLOWED_USER_ID: '',
            TELEGRAM_MODE: input.webhookUrl ? 'webhook' : 'polling',
          },
          summary: {
            provider,
            enabled: true,
            accountName: 'Synthetic Telegram bot (UI only)',
            accountHandle: '@nod_synthetic_fixture_bot',
            mode: input.webhookUrl ? 'webhook' : 'polling',
            ...(input.webhookUrl && {
              webhookUrl: input.webhookUrl,
              webhookStatus: 'registered' as const,
            }),
          },
        };
      }
      const parsed = whatsappInput.safeParse(raw);
      if (!parsed.success) throw new ChannelSetupFailure('invalid_input');
      const input = parsed.data;
      return {
        environment: {
          WHATSAPP_ENABLED: 'true',
          WHATSAPP_POLICY_CONFIRMED: 'true',
          WHATSAPP_PHONE_NUMBER_ID: input.phoneNumberId,
          WHATSAPP_ALLOWED_NUMBER: input.allowedNumber,
          WHATSAPP_ACCESS_TOKEN: input.accessToken,
          WHATSAPP_APP_SECRET: input.appSecret,
          WHATSAPP_VERIFY_TOKEN: input.verifyToken,
        },
        summary: {
          provider,
          enabled: true,
          accountName: 'Synthetic WhatsApp business (UI only)',
          mode: 'webhook',
          webhookStatus: 'manual_setup',
          ...(input.webhookUrl && { webhookUrl: input.webhookUrl }),
        },
      };
    },
  };
  return {
    verifier,
    create(environment) {
      return {
        channels: [
          {
            id: 'telegram',
            status: environment.TELEGRAM_ENABLED === 'true' ? 'configured' : 'disabled',
            missing: [],
            accountId: '777000111',
            allowedSenderIds: [],
          },
          {
            id: 'whatsapp',
            status: environment.WHATSAPP_ENABLED === 'true' ? 'configured' : 'disabled',
            missing: [],
            accountId: fixtureChannelCredentials.whatsapp.phoneNumberId,
            allowedSenderIds: [fixtureChannelCredentials.whatsapp.allowedNumber],
            replyWindowMs: 24 * 60 * 60 * 1000,
          },
        ],
        receive: async () => ({
          status: 404,
          body: { error: 'Inbound messages are disabled in this UI fixture.' },
        }),
        post: async () => {
          throw new Error('Delivery is disabled in this UI fixture.');
        },
        close: async () => {},
      };
    },
  };
}
