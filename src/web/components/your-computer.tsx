import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Laptop } from 'lucide-react';
import type { ComputerPermission, ComputerStatus } from '../../shared/computer';
import { api, errorMessage, post } from '../lib/api';
import { Button, Notice, Switch } from './ui';

export const computerPermissions = [
  ['accessibility', 'Accessibility', 'Click and type in your apps'],
  ['screen', 'Screen Recording', 'Take screenshots of app windows'],
] as const;

export function useComputer() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const active = useRef(false);
  const writing = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const missing =
    status?.appControlAvailable === true &&
    !(status.permissions.accessibility && status.permissions.screen);

  const refresh = useCallback(async (quiet = false) => {
    if (writing.current || reading.current) return;
    const request = new AbortController();
    reading.current = request;
    if (!quiet) {
      setError('');
      setChecking(true);
    }
    try {
      const value = await api<ComputerStatus>('/api/computer', { signal: request.signal });
      if (active.current && reading.current === request) {
        setStatus(value);
        setError('');
      }
    } catch (cause) {
      if (active.current && reading.current === request && !request.signal.aborted) {
        setStatus(null);
        setError(errorMessage(cause));
      }
    } finally {
      if (reading.current === request) {
        reading.current = null;
        if (active.current) setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active.current = false;
      reading.current?.abort();
      reading.current = null;
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!missing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [missing, refresh]);

  async function run(change: () => Promise<ComputerStatus>) {
    if (writing.current) return null;
    writing.current = true;
    reading.current?.abort();
    reading.current = null;
    setBusy(true);
    setChecking(false);
    setError('');
    try {
      const value = await change();
      if (!active.current) return null;
      setStatus(value);
      return value;
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
      return null;
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  }

  return {
    status,
    error,
    busy,
    checking,
    refresh,
    setEnabled: (enabled: boolean) =>
      run(() =>
        api<ComputerStatus>('/api/computer', {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        }),
      ),
    allow: (permission: ComputerPermission) =>
      run(() => post<ComputerStatus>('/api/computer/permissions', { permission })),
    remove: (bundleId: string) =>
      run(() =>
        api<ComputerStatus>(`/api/computer/apps/${encodeURIComponent(bundleId)}`, {
          method: 'DELETE',
        }),
      ),
  };
}

export function ComputerPermissions({
  status,
  busy,
  onAllow,
}: {
  status: ComputerStatus;
  busy: boolean;
  onAllow?(permission: ComputerPermission): void;
}) {
  if (!status.appControlAvailable) return null;
  const next = computerPermissions.find(([key]) => !status.permissions[key])?.[0];
  return (
    <ul className="computer-permissions" data-guided={!onAllow || undefined} aria-live="polite">
      {computerPermissions.map(([key, name, unlocks]) => (
        <li key={key}>
          <span>
            <strong>{name}</strong>
            <small>{unlocks}</small>
          </span>
          {status.permissions[key] ? (
            <span className="computer-permission-state" data-allowed>
              <Check size={15} aria-hidden="true" />
              Allowed
            </span>
          ) : onAllow ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Allow ${name}`}
              onClick={() => onAllow(key)}
            >
              Allow {name}
            </Button>
          ) : (
            <span className="computer-permission-state" data-next={key === next || undefined}>
              {key === next ? 'Next' : 'Needed'}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function YourComputer() {
  const { status, error, busy, allow, remove, setEnabled, refresh } = useComputer();
  const id = useId();

  return (
    <section className="your-computer account-region" aria-labelledby={id} data-analytics-public>
      <h4 id={id} data-analytics-public>
        Your computer
      </h4>
      {!status && !error && (
        <p className="computer-note" role="status">
          Checking computer permissions…
        </p>
      )}
      {status && !status.available ? (
        <p className="computer-note">nod can use your computer only on a Mac.</p>
      ) : (
        status && (
          <>
            <div className="computer-switch">
              <label htmlFor={`${id}-switch`}>
                <Laptop size={16} aria-hidden="true" />
                Let nod use your computer
              </label>
              <Switch
                id={`${id}-switch`}
                checked={status.enabled}
                disabled={busy}
                aria-describedby={`${id}-note`}
                onCheckedChange={(value) => void setEnabled(value)}
              />
            </div>
            <p id={`${id}-note`} className="computer-note">
              nod asks before it acts unless your request covers it. What nod reads or sees on
              screen is sent to your selected model.
            </p>
            {status.appControlAvailable ? (
              <ComputerPermissions status={status} busy={busy} onAllow={(key) => void allow(key)} />
            ) : (
              <p className="computer-note">
                Files and commands are available. Mac app control isn't available in this
                installation.
              </p>
            )}
            {(status.appControlAvailable || status.apps.length > 0) && (
              <h5>Mac apps nod may use</h5>
            )}
            {status.apps.length ? (
              <ul className="computer-apps">
                {status.apps.map((app) => {
                  const ambiguous =
                    status.apps.filter(
                      (other) => other.name.toLowerCase() === app.name.toLowerCase(),
                    ).length > 1;
                  return (
                    <li key={app.bundleId}>
                      <span data-analytics-private>
                        {app.name}
                        {ambiguous && <small>{app.bundleId}</small>}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove ${app.name}${ambiguous ? ` (${app.bundleId})` : ''}`}
                        onClick={() => void remove(app.bundleId)}
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : status.appControlAvailable ? (
              <p className="computer-note">
                None yet. nod asks before using an app your request doesn't cover.
              </p>
            ) : null}
          </>
        )
      )}
      {error && (
        <Notice>
          {error}{' '}
          <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Try again
          </Button>
        </Notice>
      )}
    </section>
  );
}
