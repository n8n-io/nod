import { useEffect, useState } from 'react';
import { Button } from './ui';
import {
  chooseDesktopComputerFolder,
  desktopStatus,
  importDesktopRuntime,
  installDesktopWsl,
  retryDesktopComputer,
  subscribeDesktopStatus,
  type DesktopStatus,
} from '../lib/desktop';

export function ComputerNotice() {
  const [status, setStatus] = useState<DesktopStatus>();
  const [dismissed, setDismissed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let received = false;
    const unsubscribe = subscribeDesktopStatus((value) => {
      received = true;
      setStatus(value);
    });
    void desktopStatus()
      ?.then((value) => {
        if (!received) setStatus(value);
      })
      .catch(() => {});
    return unsubscribe;
  }, []);

  const runtime = status?.runtime;
  const message = runtime?.message ?? '';
  if (status?.phase !== 'ready' || runtime?.phase !== 'error' || dismissed === message) return null;

  const [label, action] = runtime.needsWsl
    ? ['Install WSL', installDesktopWsl]
    : runtime.needsStorage
      ? ['Choose folder', chooseDesktopComputerFolder]
      : runtime.needsRuntimeArchive
        ? ['Choose Runtime pack', importDesktopRuntime]
        : ['Try again', retryDesktopComputer];

  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(undefined);
    void action()
      .catch((error: Error) => setFailed(error.message))
      .finally(() => setBusy(false));
  };

  return (
    <aside className="desktop-update-toast" role="status" aria-label="Private computer">
      <div className="desktop-update-toast-content">
        <strong>Nod’s browser and workspace aren’t available</strong>
        <p role="alert">{message}</p>
        <p>Chat, your apps and schedules keep working.</p>
        {failed && <p role="alert">{failed}</p>}
        <div className="desktop-update-toast-actions">
          <Button type="button" size="sm" disabled={busy} onClick={() => act(action)}>
            {busy ? 'Please wait…' : label}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setDismissed(message)}
          >
            Not now
          </Button>
        </div>
      </div>
    </aside>
  );
}
