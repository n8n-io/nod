import type { ChannelProvider, ChannelSetupSummary } from '../shared/contracts.ts';
export interface ChannelSetupConfiguration {
  environment: Record<string, string>;
  summary: ChannelSetupSummary;
}
export interface ChannelSetupVerifier {
  verify(provider: ChannelProvider, input: unknown): Promise<ChannelSetupConfiguration>;
  register?(provider: ChannelProvider, configuration: ChannelSetupConfiguration): Promise<void>;
}
export class ChannelSetupFailure extends Error {
  constructor(
    readonly reason:
      | 'invalid_input'
      | 'verification_failed'
      | 'existing_webhook'
      | 'webhook_failed'
      | 'activation_pending'
      | 'account_in_use'
      | 'pairing_unavailable',
  ) {
    super(reason);
  }
}

export interface ChannelAccountIdentity {
  ownerId: string;
  provider: ChannelProvider;
  accountId: string;
  revision: string;
}

export interface ChannelAccountRegistry {
  claim(input: ChannelAccountIdentity): Promise<boolean>;
  release(input: ChannelAccountIdentity): Promise<void>;
}
