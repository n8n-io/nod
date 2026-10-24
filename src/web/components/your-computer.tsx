import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Laptop } from 'lucide-react';
import type { ComputerPermission, ComputerStatus } from '../../shared/computer';
import { api, errorMessage, post } from '../lib/api';
import { Button, Notice, Switch } from './ui';

export const computerPermissions = [
  ['accessibility', 'Accessibility', 'Click and type'],
  ['screen', 'Screen Recording', 'See app windows'],
] as const;

export function useComputer() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState<ComputerPermission | null>(null);
  const [requested, setRequested] = useState<ComputerPermission | null>(null);
  const [checking, setChecking] = useState(false);
  const active = useRef(false);
  const writing = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const missing =
    status?.appControlAvailable === true &&
    (Boolean(status.permissionError) ||
      !(status.permissions.accessibility && status.permissions.screen));

  const refresh = useCallback(async (quiet = false) => {
    if (writing.current || reading.current) return;
    const request = new AbortController();
    reading.current = request;
    if (!quiet) {
      setChecking(true);
    }
    try {
      const value = await api<ComputerStatus>('/api/computer', { signal: request.signal });
      if (active.current && reading.current === request) {
        setStatus(value);
        setError(value.permissionError ?? '');
      }
    } catch (cause) {
      if (active.current && reading.current === request && !request.signal.aborted) {
        const message = errorMessage(cause);
        setStatus((current) =>
          current
            ? {
                ...current,
                permissions: { accessibility: false, screen: false },
                permissionError: message,
              }
            : null,
        );
        setError(message);
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

  async function run(
    change: () => Promise<ComputerStatus>,
    permission: ComputerPermission | null = null,
  ) {
    if (writing.current) return null;
    writing.current = true;
    reading.current?.abort();
    reading.current = null;
    setBusy(true);
    setRequesting(permission);
    if (permission) setRequested(permission);
    setChecking(false);
    setMutationError('');
    try {
      const value = await change();
      if (!active.current) return null;
      setStatus(value);
      setError(value.permissionError ?? '');
      return value;
    } catch (cause) {
      if (active.current) setMutationError(errorMessage(cause));
      return null;
    } finally {
      writing.current = false;
      if (active.current) {
        setBusy(false);
        setRequesting(null);
      }
    }
  }

  return {
    status,
    error: error || mutationError,
    busy,
    requesting,
    requested,
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
      run(() => post<ComputerStatus>('/api/computer/permissions', { permission }), permission),
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
  requesting,
  requested,
  checking,
  onAllow,
}: {
  status: ComputerStatus;
  busy: boolean;
  requesting: ComputerPermission | null;
  requested: ComputerPermission | null;
  checking: boolean;
  onAllow(permission: ComputerPermission): void;
}) {
  const id = useId();
  if (!status.appControlAvailable) return null;
  return (
    <ul className="computer-permissions">
      {computerPermissions.map(([key, name, unlocks]) => (
        <li key={key}>
          <div className="computer-permission-label">
            <strong>
              <label htmlFor={`${id}-${key}`}>{name}</label>
            </strong>
            <small id={`${id}-${key}-reason`}>{unlocks}</small>
          </div>
          <span className="computer-permission-control">
            {status.permissionError ? (
              <small id={`${id}-${key}-state`}>Not checked</small>
            ) : status.permissions[key] ? (
              <small className="computer-permission-allowed">Allowed</small>
            ) : requesting === key ? (
              <small role="status">Opening…</small>
            ) : requested === key && checking ? (
              <small role="status">Checking…</small>
            ) : null}
            <Switch
              id={`${id}-${key}`}
              checked={!status.permissionError && status.permissions[key]}
              disabled={busy || Boolean(status.permissionError) || status.permissions[key]}
              aria-busy={requesting === key}
              aria-describedby={`${id}-${key}-reason${status.permissionError ? ` ${id}-${key}-state` : ''}`}
              onCheckedChange={(checked) => {
                if (checked) onAllow(key);
              }}
            />
          </span>
          {requested === key && !status.permissions[key] && !status.permissionError && (
            <p className="computer-permission-hint" aria-live="polite">
              Allow this app in System Settings.
              {key === 'screen' && ' If macOS asks you to quit, reopen nod.'}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function YourComputer() {
  const {
    status,
    error,
    busy,
    requesting,
    requested,
    checking,
    allow,
    remove,
    setEnabled,
    refresh,
  } = useComputer();
  const id = useId();

  return (
    <section className="your-computer account-region" aria-labelledby={id} data-analytics-public>
      <h2 id={id} data-analytics-public>
        Your computer
      </h2>
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
              What nod reads or sees goes to your model.
            </p>
            {status.appControlAvailable ? (
              <ComputerPermissions
                status={status}
                busy={busy}
                requesting={requesting}
                requested={requested}
                checking={checking}
                onAllow={(key) => void allow(key)}
              />
            ) : (
              <p className="computer-note">
                Files and commands are available. Mac app control isn't available in this
                installation.
              </p>
            )}
            {status.apps.length > 0 && <h5>Allowed apps</h5>}
            {status.apps.length > 0 && (
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
            )}
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
