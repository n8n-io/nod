import { useState } from 'react';
import { KeepOutList } from './keep-out-list';
import { Button, Notice, Switch } from './ui';
import { api, errorMessage, post } from '../lib/api';
import { usePageData } from '../hooks/use-page-data';

type Permission = 'granted' | 'denied' | 'not_required' | 'unknown';
type Status = {
  available: boolean;
  paired?: boolean;
  connected?: boolean;
  platform: string;
  enabled: boolean;
  keptOut: string[];
  permissions: {
    accessibility: Permission;
    screen: Permission;
    ready: boolean;
    sandboxed: boolean;
  };
};
const path = '/api/computer-use';
const permissionText = {
  accessibility: {
    label: 'Accessibility',
    hint: 'Lets Nod read app windows and press their controls.',
  },
  screen: {
    label: 'Screen Recording',
    hint: 'Lets Nod take a picture of one app window when its controls aren’t enough.',
  },
} as const;

export function ComputerUseSettings() {
  const { data, error: loadError, update, refresh } = usePageData<Status>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!data)
    return loadError ? (
      <section className="account-region">
        <Notice>{loadError}</Notice>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          Try again
        </Button>
      </section>
    ) : null;
  if (!data.available)
    return (
      <section className="account-region">
        <p className="field-hint">Computer use works in the Nod desktop app.</p>
      </section>
    );

  async function save(request: () => Promise<Status>) {
    setBusy(true);
    setError('');
    try {
      const saved = await request();
      update(() => saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const mac = data.platform === 'darwin';
  const label = mac ? 'Let Nod use apps on this Mac' : 'Let Nod use apps on this computer';
  const fileManager = mac
    ? 'Finder'
    : data.platform === 'win32'
      ? 'File Explorer'
      : 'file managers';
  const permissions = (['accessibility', 'screen'] as const).filter(
    (which) => data.permissions[which] !== 'not_required' && (mac || which === 'accessibility'),
  );

  return (
    <>
      <section className="account-region">
        {data.paired && (
          <p className="field-hint">
            {data.connected
              ? 'A Windows desktop is being shared with this server.'
              : 'On your Windows PC, open the Nod tray menu and start desktop sharing. End sharing there at any time.'}
          </p>
        )}
        <div className="account-preference-row">
          <span>{label}</span>
          <Switch
            checked={data.enabled}
            disabled={busy}
            aria-label={label}
            onCheckedChange={(enabled) =>
              void save(() =>
                api<Status>(path, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
              )
            }
          />
        </div>
        <p className="field-hint">
          Experimental. Nod opens an app only when your request names it or needs it, and asks
          before a step that sends, saves over, deletes or buys anything. Browsers and code editors
          stay view-only; known terminals, system settings, {fileManager} and password managers are
          never used. To keep Nod out of any other app, tell Nod.
        </p>
      </section>
      {data.enabled && data.platform === 'linux' && !data.permissions.ready && (
        <section className="account-region">
          <p className="field-hint">
            {data.permissions.sandboxed
              ? 'Computer use doesn’t work in the Flatpak app yet: its sandbox can’t reach other apps.'
              : 'Nod can’t reach the accessibility service on this computer. On Linux, install at-spi2-core, turn on assistive technologies in your desktop’s accessibility settings, then sign out and back in.'}
          </p>
        </section>
      )}
      {data.enabled &&
        permissions.map((which) => (
          <section key={which} className="account-region">
            <div className="account-preference-row">
              <span>{permissionText[which].label}</span>
              {data.permissions[which] === 'granted' ? (
                <span className="field-hint">Allowed</span>
              ) : !mac ? (
                <span className="field-hint">Not available</span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void save(() => post<Status>(`${path}/permission`, { which }))}
                >
                  Allow
                </Button>
              )}
            </div>
            <p className="field-hint">
              {permissionText[which].hint}
              {mac && data.permissions[which] !== 'granted' && (
                <>
                  {
                    ' macOS opens System Settings, Privacy & Security; turn on Nod there, then come back.'
                  }
                  {which === 'screen' &&
                    ' If you already turned it on, quit and reopen Nod; macOS applies it only after a restart.'}
                </>
              )}
            </p>
          </section>
        ))}
      {data.keptOut.length > 0 && (
        <section className="account-region">
          <KeepOutList
            title="Kept out of computer use"
            hint="Nod never uses these apps. Tell Nod to add one; only you can remove it here."
            items={data.keptOut}
            removeLabel={(bundle) => `Let Nod use ${bundle} again`}
            disabled={busy}
            onRemove={(bundle) =>
              void save(() =>
                api<Status>(`${path}/keep-out`, {
                  method: 'DELETE',
                  body: JSON.stringify({ bundle }),
                }),
              )
            }
          />
        </section>
      )}
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
    </>
  );
}
