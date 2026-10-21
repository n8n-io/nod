import { useEffect, useId, useState } from 'react';
import { Laptop } from 'lucide-react';
import type { ComputerPermission, ComputerStatus } from '../../shared/computer';
import { api, errorMessage, post } from '../lib/api';
import { Button, Notice, Switch } from './ui';

export const computerPermissions = [
  ['accessibility', 'Accessibility', 'Use your Mac apps'],
  ['screen', 'Screen Recording', 'See app windows'],
] as const;

export function useComputer() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const missing =
    status?.available === true && !(status.permissions.accessibility && status.permissions.screen);

  useEffect(() => {
    let current = true;
    api<ComputerStatus>('/api/computer')
      .then((value) => current && setStatus(value))
      .catch((cause) => current && setError(errorMessage(cause)));
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!missing) return;
    let current = true;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api<ComputerStatus>('/api/computer')
        .then((value) => current && setStatus(value))
        .catch(() => {});
    }, 2000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [missing]);

  async function run(change: () => Promise<ComputerStatus>) {
    setBusy(true);
    setError('');
    try {
      setStatus(await change());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return {
    status,
    error,
    busy,
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
  onAllow(permission: ComputerPermission): void;
}) {
  return (
    <ul className="computer-permissions">
      {computerPermissions.map(([key, name, unlocks]) => (
        <li key={key}>
          <span>
            <strong>{unlocks}</strong>
            <small>{name}</small>
          </span>
          {status.permissions[key] ? (
            <small>Allowed</small>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAllow(key)}>
              Allow
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function YourComputer() {
  const { status, error, busy, allow, remove, setEnabled } = useComputer();
  const id = useId();

  return (
    <section className="your-computer account-region" aria-labelledby={id} data-analytics-public>
      <h4 id={id} data-analytics-public>
        Your computer
      </h4>
      {status && !status.available ? (
        <p className="computer-note">Otto can use your computer only on a Mac.</p>
      ) : (
        status && (
          <>
            <div className="computer-switch">
              <label htmlFor={`${id}-switch`}>
                <Laptop size={16} aria-hidden="true" />
                Let Otto use your computer
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
              Otto asks before it acts unless your request covers it. What Otto reads or sees on
              screen is sent to your selected model.
            </p>
            <ComputerPermissions status={status} busy={busy} onAllow={(key) => void allow(key)} />
            <h5>Mac apps Otto may use</h5>
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
                        aria-label={`Remove ${app.name}`}
                        onClick={() => void remove(app.bundleId)}
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="computer-note">
                None yet. Otto asks the first time it needs a Mac app.
              </p>
            )}
          </>
        )
      )}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}
