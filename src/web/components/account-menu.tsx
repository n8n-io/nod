import type { AccountTheme, AccountUser } from '../../shared/account';

export type AccountTab =
  'General' | 'Notifications' | 'Models' | 'Voice & audio' | 'Memory' | 'Privacy & data';
export interface AccountControls {
  user: AccountUser;
  theme: AccountTheme;
  usageData: boolean;
  traces?: boolean;
  saving: boolean;
  onSettings(tab: AccountTab, trigger?: HTMLElement): void;
  onTheme(theme: AccountTheme): Promise<void>;
  onUsageData(usageData: boolean): Promise<void>;
  onTraces(traces: boolean): Promise<void>;
}
