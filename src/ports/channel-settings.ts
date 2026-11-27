import type { ChannelProvider, ChannelSetupSummary } from '../shared/contracts.ts';

export const telegramUserId = /^[1-9]\d{0,15}$/;
export const telegramSecret = /^[A-Za-z0-9_-]{16,256}$/;
export const nextcloudUserId = /^(?! )[A-Za-z0-9 _.@'-]{1,64}(?<! )$/;
export function nextcloudServer(value: string | undefined) {
  if (!value || /[?#]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
export function nextcloudMissing(values: Record<string, string | undefined>) {
  const missing = [
    'NEXTCLOUD_URL',
    'NEXTCLOUD_USER',
    'NEXTCLOUD_APP_PASSWORD',
    'NEXTCLOUD_ALLOWED_USER',
  ].filter((key) => !values[key]);
  if (values.NEXTCLOUD_URL && !nextcloudServer(values.NEXTCLOUD_URL)) missing.push('NEXTCLOUD_URL');
  for (const key of ['NEXTCLOUD_USER', 'NEXTCLOUD_ALLOWED_USER'])
    if (values[key] && !nextcloudUserId.test(values[key])) missing.push(key);
  if (values.NEXTCLOUD_USER && values.NEXTCLOUD_USER === values.NEXTCLOUD_ALLOWED_USER)
    missing.push('NEXTCLOUD_ALLOWED_USER');
  return [...new Set(missing)];
}
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
    readonly details?: string,
  ) {
    super(reason);
  }
}
