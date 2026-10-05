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
}

export interface SessionResponse {
  analytics?: AnalyticsConfiguration;
  auth: { mode: 'local' | 'google'; googleAvailable: boolean };
  user: AccountUser | null;
  settings: AccountSettings | null;
  capabilities: { developer: boolean };
}

export interface AccountUpdate {
  name?: string;
  theme?: AccountTheme;
  onboardingCompleted?: boolean;
}

export interface AccountPreparationResponse {
  ok: true;
}

export type AccountPreferences = Preferences;
