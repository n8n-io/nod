import { useState } from 'react';
import { ChevronUp, KeyRound, LogOut, Monitor, Moon, Settings, Sun, UserRound } from 'lucide-react';
import type { AccountTheme, AccountUser } from '../../shared/account';
import { AccountAvatar } from './account-avatar';
import { ConnectionMenu } from './connection-menu';
import { desktopSettingsAvailable } from '../lib/desktop';

export type AccountTab = 'Profile' | 'General' | 'Appearance' | 'Preferences' | 'Models';
export interface AccountControls {
  user: AccountUser;
  local: boolean;
  theme: AccountTheme;
  saving: boolean;
  canLogout: boolean;
  onSettings(tab: AccountTab, trigger?: HTMLElement): void;
  onTheme(theme: AccountTheme): Promise<void>;
  onLogout(): void;
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
      {!account.local && (
        <>
          <div className="account-menu-identity" role="group" aria-label="Signed-in account">
            <AccountAvatar user={account.user} />
            <div>
              <strong>{account.user.name}</strong>
              {account.user.email && <span>{account.user.email}</span>}
            </div>
          </div>
          <button
            type="button"
            role={menu ? 'menuitem' : undefined}
            onClick={(event) => openSettings('Profile', event.currentTarget)}
          >
            <UserRound size={18} aria-hidden="true" />
            Profile
          </button>
        </>
      )}
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        aria-keyshortcuts={shortcuts ? 'Meta+, Control+,' : undefined}
        onClick={(event) =>
          openSettings(
            desktop ? 'General' : account.local ? 'Appearance' : 'Preferences',
            event.currentTarget,
          )
        }
      >
        <Settings size={18} aria-hidden="true" />
        Settings
        {shortcuts && (
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
        <KeyRound size={18} aria-hidden="true" />
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
      {account.canLogout && (
        <>
          <div className="mobile-menu-separator" role="separator" />
          <button
            type="button"
            role={menu ? 'menuitem' : undefined}
            onClick={() => {
              close();
              account.onLogout();
            }}
          >
            <LogOut size={18} aria-hidden="true" />
            Sign out
          </button>
        </>
      )}
    </>
  );
}

export function AccountMenu({ account }: { account: AccountControls }) {
  return (
    <div className="sidebar-account-menu">
      <ConnectionMenu
        label="Account menu"
        compact
        triggerClassName="nav-link account-menu-trigger"
        trigger={
          <>
            <AccountAvatar user={account.user} />
            <span className="nav-label">{account.user.name}</span>
            <span className="account-menu-chevron" aria-hidden="true">
              <ChevronUp size={18} strokeWidth={1.75} />
            </span>
          </>
        }
      >
        {(close) => <AccountMenuItems account={account} close={close} />}
      </ConnectionMenu>
    </div>
  );
}
