import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Eye, EyeOff, Power } from 'lucide-react';
import {
  applyDesktopSettings,
  getDesktopSettings,
  revealDesktopComposioKey,
  saveDesktopSettings,
  subscribeDesktopPreferences,
  type DesktopSettings,
  type DesktopSettingsChange,
} from '../lib/desktop';
import { errorMessage } from '../lib/api';
import { Button, Field, Input, Loading, Notice, Switch } from './ui';

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
    <div className="desktop-options" data-desktop-settings-pending={busy || undefined}>
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

export function ComposioSettings({
  onDirtyChange,
  applyBlocked = false,
}: {
  onDirtyChange?(dirty: boolean): void;
  applyBlocked?: boolean;
}) {
  const state = useDesktopSettings();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const action = useRef(false);
  const blocked = useRef(applyBlocked);
  blocked.current = applyBlocked;
  const revealVersion = useRef(0);
  const hideKey = useCallback(() => {
    revealVersion.current++;
    setRevealed('');
  }, []);
  const dirty = Boolean(key.trim()) || state.busy;
  useEffect(() => {
    active.current = true;
    const visibility = () => {
      if (document.hidden) hideKey();
    };
    window.addEventListener('blur', hideKey);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active.current = false;
      revealVersion.current++;
      window.removeEventListener('blur', hideKey);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [hideKey]);
  useEffect(() => {
    if (!revealed) return;
    const timeout = window.setTimeout(hideKey, 30_000);
    return () => window.clearTimeout(timeout);
  }, [revealed, hideKey]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  async function change(value: string | null) {
    if (action.current) return;
    action.current = true;
    setWorking(true);
    setError('');
    hideKey();
    try {
      const saved = await state.save({ composioApiKey: value });
      if (!active.current) return;
      setKey('');
      setEditing(false);
      if (saved.restartRequired && !blocked.current) await applyDesktopSettings();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      action.current = false;
      if (active.current) setWorking(false);
    }
  }
  async function reveal() {
    if (revealed) {
      hideKey();
      return;
    }
    if (action.current) return;
    action.current = true;
    setWorking(true);
    setError('');
    const version = ++revealVersion.current;
    try {
      const value = await revealDesktopComposioKey();
      if (
        active.current &&
        version === revealVersion.current &&
        !document.hidden &&
        document.hasFocus()
      )
        setRevealed(value);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      action.current = false;
      if (active.current) setWorking(false);
    }
  }
  async function apply() {
    if (action.current || blocked.current) return;
    action.current = true;
    setWorking(true);
    setError('');
    try {
      await applyDesktopSettings();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      action.current = false;
      if (active.current) setWorking(false);
    }
  }
  const saved = state.settings;
  const busy = state.busy || working;
  return (
    <section className="composio-settings" data-desktop-settings-pending={dirty || undefined}>
      <div className="composio-settings-heading" data-analytics-public>
        <span className="composio-logo" aria-hidden="true" />
        <h4>App connections</h4>
        <span>Optional</span>
      </div>
      <p data-analytics-public>Add a Composio key to connect Gmail, Slack and other apps.</p>
      {!saved ? (
        state.loading ? (
          <Loading />
        ) : (
          <Button variant="outline" onClick={() => void state.refresh()}>
            Try again
          </Button>
        )
      ) : editing || !saved.hasComposioKey ? (
        <form
          className="composio-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) void change(key.trim());
          }}
        >
          <Field label="Composio API key">
            <Input
              type="password"
              value={key}
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={16384}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <div className="composio-key-actions">
            <Button type="submit" size="sm" disabled={busy || !key.trim()}>
              {busy ? 'Applying…' : 'Save key'}
            </Button>
            {(editing || key) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setKey('');
                  setError('');
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          <Field label="Composio API key">
            <Input
              readOnly
              value={revealed || `••••••••${saved.keys.composioApiKey.suffix ?? ''}`}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="composio-key-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void reveal()}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
              {revealed ? 'Hide' : 'Show'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                hideKey();
                setEditing(true);
                setError('');
              }}
            >
              Change
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void change(null)}
            >
              Remove
            </Button>
          </div>
        </>
      )}
      {(error || state.error) && <Notice>{error || state.error}</Notice>}
      {saved?.restartRequired && !busy && !dirty && (
        <div className="composio-restart">
          <p>
            {applyBlocked
              ? 'Finish or cancel your model setup before applying your app connection key.'
              : 'Your key change needs to be applied to connect apps.'}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={applyBlocked}
            onClick={() => void apply()}
          >
            Apply changes
          </Button>
        </div>
      )}
    </section>
  );
}
