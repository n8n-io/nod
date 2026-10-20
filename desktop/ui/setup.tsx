import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupProgress } from '../../src/web/components/setup-progress';
import '../../src/web/theme.css';
import '../../src/web/components/motion.css';
import '../../src/web/components/setup-progress.css';

type RuntimeStatus = {
  phase?: string;
  message?: string;
  error?: string;
  progress?: number;
  needsWsl?: boolean;
  needsRuntimeArchive?: boolean;
};

type Status = RuntimeStatus & {
  unlockingKeys?: boolean;
  platform?: string;
  runtime?: RuntimeStatus;
};

type Preferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme?: 'light' | 'dark';
};

type Desktop = {
  status(): Promise<Status>;
  getPreferences(): Promise<Preferences>;
  prepare(options?: { retry: boolean }): Promise<Status>;
  installWsl(): Promise<Status>;
  importRuntime(): Promise<Status | undefined>;
  onStatus(listener: (status: Status) => void): (() => void) | undefined;
  onPreferences(listener: (preferences: Preferences) => void): (() => void) | undefined;
};

const desktop = (window as Window & { ottoDesktop?: Desktop }).ottoDesktop;
const parameters = new URLSearchParams(location.search);
const firstSetup = parameters.get('firstSetup') === 'true';
document.documentElement.dataset.theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';

function applyPreferences(value: Preferences) {
  document.documentElement.dataset.theme =
    value.theme === 'system'
      ? value.resolvedTheme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : value.theme;
}

function Startup() {
  const [status, setStatus] = useState<Status>(() =>
    !desktop
      ? { phase: 'error', error: 'Open Otto to finish setup.' }
      : parameters.has('unlocking')
        ? { phase: 'starting', unlockingKeys: true, platform: parameters.get('unlocking')! }
        : { phase: 'preparing' },
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let receivedStatus = false;
    const stopStatus = desktop.onStatus((value) => {
      receivedStatus = true;
      if (active) setStatus(value);
    });
    const stopPreferences = desktop.onPreferences(applyPreferences);
    void Promise.all([desktop.getPreferences(), desktop.status()])
      .then(([preferences, value]) => {
        if (!active) return;
        applyPreferences(preferences);
        if (!receivedStatus) setStatus(value);
      })
      .catch(() => {
        if (active && !receivedStatus)
          setStatus({
            phase: 'error',
            error: 'Your saved settings could not be opened. Try again.',
          });
      });
    return () => {
      active = false;
      stopStatus?.();
      stopPreferences?.();
    };
  }, []);

  async function run(action: () => Promise<Status | undefined>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const value = await action();
      if (value) setStatus(value);
    } catch (cause) {
      setStatus((previous) => ({
        ...previous,
        phase: 'error',
        unlockingKeys: false,
        error: cause instanceof Error ? cause.message : 'Otto could not start. Try again.',
      }));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const runtime = status.runtime;
  const failure =
    status.phase === 'error' || status.error
      ? status
      : runtime?.phase === 'error'
        ? runtime
        : undefined;
  const active =
    runtime && runtime.phase !== 'ready' && !['starting', 'ready'].includes(status.phase || '')
      ? runtime
      : status;
  const unlocking = status.unlockingKeys && !failure;
  const error =
    !busy && failure
      ? failure.error || failure.message || 'Otto could not start. Try again.'
      : undefined;
  const progress =
    !failure &&
    !unlocking &&
    Number.isFinite(active.progress) &&
    active.progress! >= 0 &&
    active.progress! <= 1
      ? active.progress
      : undefined;
  const description = unlocking
    ? status.platform === 'darwin'
      ? 'Otto uses your Mac’s Keychain to protect your saved connections. Allow access if macOS asks.'
      : 'Otto uses your system’s secure storage to protect your saved connections.'
    : busy
      ? firstSetup
        ? 'Preparing your workspace and browser.'
        : 'Opening your saved workspace.'
      : error
        ? 'Your progress is saved.'
        : active.message ||
          (firstSetup ? 'Preparing your workspace and browser.' : 'Opening your saved workspace.');

  return (
    <>
      <div className="titlebar" aria-hidden="true" />
      <SetupProgress
        title={
          error
            ? 'Otto needs another try'
            : unlocking
              ? 'Keeping your connections secure'
              : firstSetup
                ? 'Getting Otto ready'
                : 'Opening Otto'
        }
        description={description}
        error={error}
        progress={progress}
      >
        {failure && desktop && (
          <div className="recovery-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => desktop.prepare({ retry: true }))}
            >
              {busy ? 'Trying again…' : 'Try again'}
            </button>
            {(failure.needsWsl || runtime?.needsWsl) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => desktop.installWsl())}
              >
                Install WSL
              </button>
            )}
            {(failure.needsRuntimeArchive || runtime?.needsRuntimeArchive) && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await desktop.importRuntime();
                    return result?.runtime?.phase === 'ready' ? desktop.prepare() : result;
                  })
                }
              >
                Choose runtime file
              </button>
            )}
          </div>
        )}
      </SetupProgress>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Startup />);
