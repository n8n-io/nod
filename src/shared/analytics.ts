export const posthogConfig = {
  key: 'phc_tLmmvBasQMKWVJ2BiwhEzVVDD3Rh9qDq2VTmw3qTm6EV',
  host: 'https://eu.i.posthog.com',
  schemaVersion: 'otto_v3',
  docsUrl: 'https://otto-docs.pages.dev/deploy/analytics/',
} as const;

export interface AnalyticsConfiguration {
  enabled: boolean;
  distinctId: string | null;
  environment: 'development' | 'production';
  appVersion?: string;
}
