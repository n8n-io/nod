import type { ChannelProvider, ChannelSetupSummary } from '../shared/contracts.ts';

export const telegramUserId = /^[1-9]\d{0,15}$/;
export const telegramSecret = /^[A-Za-z0-9_-]{16,256}$/;
export interface ChannelSetupConfiguration {
  environment: Record<string, string>;
  summary: ChannelSetupSummary;
}
export interface ChannelSetupVerifier {
  verify(provider: ChannelProvider, input: unknown): Promise<ChannelSetupConfiguration>;
  register?(provider: ChannelProvider, configuration: ChannelSetupConfiguration): Promise<void>;
  unregister?(provider: ChannelProvider, environment: Record<string, string>): Promise<void>;
}
export class ChannelSetupFailure extends Error {
  constructor(
    readonly reason:
      | 'invalid_input'
      | 'verification_failed'
      | 'existing_webhook'
      | 'webhook_failed'
      | 'activation_pending'
      | 'server_managed'
      | 'pairing_unavailable',
  ) {
    super(reason);
  }
}
