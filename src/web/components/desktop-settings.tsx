import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Power } from './icons';
import {
  getDesktopSettings,
  saveDesktopSettings,
  subscribeDesktopPreferences,
  type DesktopSettings,
  type DesktopSettingsChange,
} from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { Switch } from './ui';

export function useDesktopSettings(enabled = true) {
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError('');
    try {
      const value = await getDesktopSettings();
      if (active.current) setSettings(value);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      if (active.current) setLoading(false);
    }
  }, [enabled]);
  useEffect(() => {
    active.current = enabled;
    if (!enabled) return;
    void refresh();
    const unsubscribe = subscribeDesktopPreferences((value) => {
      setSettings((current) => (current ? { ...current, ...value } : current));
    });
    return () => {
      active.current = false;
      unsubscribe();
    };
  }, [enabled, refresh]);
  async function save(change: DesktopSettingsChange) {
    if (pending.current) throw new Error('Wait for your settings to finish saving.');
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await saveDesktopSettings(change);
      if (active.current) setSettings(value);
      return value;
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
      throw cause;
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return { settings, loading, busy, error, refresh, save };
}

export function DesktopOptions({
  settings,
  busy,
  onChange,
}: {
  settings: DesktopSettings;
  busy: boolean;
  onChange(change: DesktopSettingsChange): Promise<unknown>;
}) {
  return (
    <div className="desktop-options">
      {(
        [
          ['launchAtLogin', 'Open at login', Power],
          ['notifications', 'Desktop notifications', Bell],
        ] as const
      ).map(([key, label, Icon]) => (
        <div className="account-preference-row" key={key}>
          <span data-analytics-public>
            <Icon size={16} aria-hidden="true" />
            {label}
          </span>
          <Switch
            checked={settings[key]}
            disabled={busy}
            aria-label={label}
            onCheckedChange={(value) => void onChange({ [key]: value }).catch(() => {})}
          />
        </div>
      ))}
    </div>
  );
}
