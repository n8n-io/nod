import { useState } from 'react';
import { KeyRound, Monitor, Moon, Settings, Sun } from './icons';
import type { AccountTheme, AccountUser } from '../../shared/account';
import { desktopSettingsAvailable } from '../lib/desktop';

export type AccountTab = 'General' | 'Models' | 'Memory';
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

export function AccountMenuItems({
  account,
  close,
  shortcuts = true,
  menu = true,
}: {
  account: AccountControls;
  close(): void;
  shortcuts?: boolean;
  menu?: boolean;
}) {
  const [error, setError] = useState('');
  const desktop = desktopSettingsAvailable();
  const openSettings = (tab: AccountTab, trigger: HTMLElement) => {
    close();
    queueMicrotask(() => account.onSettings(tab, trigger));
  };
  return (
    <>
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        aria-keyshortcuts={
          shortcuts && desktop
            ? `${/Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'}+,`
            : undefined
        }
        data-analytics-public
        onClick={(event) => openSettings('General', event.currentTarget)}
      >
        <Settings size={16} aria-hidden="true" />
        Settings
        {shortcuts && desktop && (
          <kbd className="account-settings-shortcut">
            {/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘,' : 'Ctrl+,'}
          </kbd>
        )}
      </button>
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        onClick={(event) => openSettings('Models', event.currentTarget)}
      >
        <KeyRound size={16} aria-hidden="true" />
        Models
      </button>
      {!desktop && (
        <div className="account-menu-themes" role="group" aria-label="Theme">
          <span>Theme</span>
          <div>
            {(['light', 'dark', 'system'] as AccountTheme[]).map((theme) => {
              const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
              const label = `${theme[0].toUpperCase()}${theme.slice(1)} theme`;
              return (
                <button
                  key={theme}
                  type="button"
                  role={menu ? 'menuitemradio' : undefined}
                  aria-checked={menu ? account.theme === theme : undefined}
                  aria-pressed={menu ? undefined : account.theme === theme}
                  aria-label={label}
                  title={label}
                  disabled={account.saving}
                  onClick={() => {
                    setError('');
                    void account
                      .onTheme(theme)
                      .catch(() => setError('Theme could not be saved. Try again.'));
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      )}
      {error && (
        <p className="account-menu-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
