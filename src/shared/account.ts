import type { Preferences } from './contracts';
import type { AnalyticsConfiguration } from './analytics';

export type AccountTheme = 'system' | 'light' | 'dark';

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AccountSettings {
  theme: AccountTheme;
  onboardingCompleted: boolean;
  usageData: boolean;
  traces: boolean;
}

export interface SessionResponse {
  analytics?: AnalyticsConfiguration;
  user: AccountUser | null;
  settings: (AccountSettings & { usageDataRevision?: string }) | null;
  capabilities: { developer: boolean; traces: boolean; updatesEmail: boolean };
}

export interface AccountUpdate {
  theme?: AccountTheme;
  onboardingCompleted?: true;
  usageData?: boolean;
  traces?: boolean;
}

export interface AccountPreparationResponse {
  ok: true;
}

export type AccountPreferences = Preferences;
