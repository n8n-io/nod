import { useEffect, useState } from 'react';
import { ArrowUp } from './icons';
import { Button } from './ui';
import {
  desktopUpdateStatus,
  dismissDesktopUpdate,
  restartDesktopUpdate,
  subscribeDesktopUpdateStatus,
  type DesktopUpdateStatus,
} from '../lib/desktop';

export function DesktopUpdateToast() {
  const [status, setStatus] = useState<DesktopUpdateStatus>();
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let received = false;
    const unsubscribe = subscribeDesktopUpdateStatus((value) => {
      received = true;
      setStatus(value);
    });
    void desktopUpdateStatus()
      ?.then((value) => {
        if (!received) setStatus(value);
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  if (!status?.readyVersion || status.readyVersion === status.dismissedVersion) return null;
  const version = status.readyVersion;

  return (
    <aside className="desktop-update-toast" role="status" aria-label="Nod update">
      <span className="desktop-update-toast-icon" aria-hidden="true">
        <ArrowUp size={14} />
      </span>
      <div className="desktop-update-toast-content">
        <strong>Nod {version} is ready</strong>
        <p>Restart to use the new version.</p>
        {failed && <p role="alert">Nod could not restart. Try again.</p>}
        <div className="desktop-update-toast-actions">
          <Button
            type="button"
            size="sm"
            disabled={restarting || status.checking || status.phase !== 'ready'}
            onClick={() => {
              setRestarting(true);
              setFailed(false);
              void restartDesktopUpdate()
                .catch(() => setFailed(true))
                .finally(() => setRestarting(false));
            }}
          >
            {restarting ? 'Restarting…' : 'Restart to update'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={restarting}
            onClick={() => {
              setFailed(false);
              void dismissDesktopUpdate(version).catch(() => {});
            }}
          >
            Later
          </Button>
        </div>
      </div>
    </aside>
  );
}
