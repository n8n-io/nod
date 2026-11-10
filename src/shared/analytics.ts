import posthogHost from './posthog-host.json' with { type: 'json' };

export const posthogConfig = {
  key: 'phc_tLmmvBasQMKWVJ2BiwhEzVVDD3Rh9qDq2VTmw3qTm6EV',
  host: posthogHost.host,
  schemaVersion: 'v4',
} as const;

export interface AnalyticsConfiguration {
  enabled: boolean;
  distinctId: string | null;
  environment: 'development' | 'production';
  appVersion?: string;
  surveys?: boolean;
}
