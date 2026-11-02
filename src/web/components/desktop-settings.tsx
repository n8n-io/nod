import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDesktopSettings,
  saveDesktopSettings,
  subscribeDesktopPreferences,
  type DesktopSettings,
  type DesktopSettingsChange,
} from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { analyticsForCurrentSession } from '../lib/analytics';

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
    const previous = settings;
    const capture = analyticsForCurrentSession();
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await saveDesktopSettings(change);
      if (active.current) setSettings(value);
      if (active.current && previous) {
        if (
          change.theme !== undefined &&
          value.theme === change.theme &&
          previous.theme !== value.theme
        )
          capture('local_setting_changed', { setting: 'theme', value: value.theme });
        for (const [key, setting] of [
          ['launchAtLogin', 'launch_at_login'],
          ['notifications', 'desktop_notifications'],
        ] as const)
          if (
            typeof change[key] === 'boolean' &&
            value[key] === change[key] &&
            previous[key] !== value[key]
          )
            capture('local_setting_changed', {
              setting,
              value: value[key] ? 'enabled' : 'disabled',
            });
      }
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
