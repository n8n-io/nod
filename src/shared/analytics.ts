import posthogHost from './posthog-host.json' with { type: 'json' };

export const posthogConfig = {
  key: posthogHost.key,
  host: posthogHost.host,
  schemaVersion: posthogHost.schemaVersion,
} as const;

export interface AnalyticsConfiguration {
  enabled: boolean;
  distinctId: string | null;
  environment: 'development' | 'production';
  appVersion?: string;
  surveys?: boolean;
}
