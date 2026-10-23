import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupProgress } from '../../src/web/components/setup-progress';
import { Welcome } from '../../src/web/pages/onboarding/steps/welcome';
import { OnboardingFrame } from '../../src/web/pages/onboarding/frame';
import { initializeFocusVisibility } from '../../src/web/lib/focus';
import '../../src/web/theme.css';
import '../../src/web/components/motion.css';
import '../../src/web/components/setup-progress.css';
import '../../src/web/components/controls.css';
import '../../src/web/pages/onboarding/onboarding.css';
import '../../src/web/pages/onboarding/steps/welcome.css';

type RuntimeStatus = {
  phase?: string;
  message?: string;
  error?: string;
  progress?: number;
  needsWsl?: boolean;
  needsRuntimeArchive?: boolean;
};

type Status = RuntimeStatus & {
  windowError?: string;
  unlockingKeys?: boolean;
  platform?: string;
  runtime?: RuntimeStatus;
};

type Preferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme?: 'light' | 'dark';
};

type WelcomeChoice = { usageData: boolean; continued: boolean };

type Desktop = {
  ready?(): Promise<void>;
  getSettings(): Promise<{ welcome?: WelcomeChoice }>;
  saveSettings(change: { welcome: WelcomeChoice }): Promise<{ welcome?: WelcomeChoice }>;
  status(): Promise<Status>;
  getPreferences(): Promise<Preferences>;
  getConnection(): Promise<{ url: string }>;
  saveConnection(connection: { url: string; token: string } | null): Promise<void>;
  openConnectionSettings(): Promise<void>;
  closeConnectionSettings(): Promise<void>;
  prepare(options?: { retry: boolean }): Promise<Status>;
  installWsl(): Promise<Status>;
  importRuntime(): Promise<Status | undefined>;
  onStatus(listener: (status: Status) => void): (() => void) | undefined;
  onPreferences(listener: (preferences: Preferences) => void): (() => void) | undefined;
};

const desktop = (window as Window & { nodDesktop?: Desktop }).nodDesktop;
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

function ConnectionSetup() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void Promise.all([desktop.getConnection(), desktop.getPreferences()])
      .then(([connection, preferences]) => {
        if (!active) return;
        setUrl(connection.url);
        setConnected(Boolean(connection.url));
        applyPreferences(preferences);
      })
      .catch(() => {
        if (active) setError('Your saved connection could not be opened.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          void desktop.ready?.();
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function connect(local = false) {
    if (!desktop || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await desktop.saveConnection(local ? null : { url, token });
      setToken('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your connection could not be saved.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="titlebar" aria-hidden="true" />
      <main className="server-setup">
        <form
          className="server-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <h1>Connect to your server</h1>
          <p>Use the same assistant in this app, your browser and your chat apps.</p>
          <label htmlFor="server-address">Server address</label>
          <input
            id="server-address"
            type="url"
            placeholder="https://nod.example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="url"
            spellCheck={false}
            required
            disabled={busy || loading}
          />
          <label htmlFor="server-token">Authentication token</label>
          <input
            id="server-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy || loading}
            aria-describedby="server-token-help"
          />
          <p id="server-token-help" className="server-help">
            Enter your server’s NOD_AUTH_TOKEN. nod saves it in your computer’s secure storage.
          </p>
          {error && (
            <p className="server-error" role="alert">
              {error}
            </p>
          )}
          <button className="server-connect" type="submit" disabled={busy || loading}>
            {busy ? 'Connecting…' : 'Connect and restart app'}
          </button>
          <p className="server-help">Your local assistant stays saved on this computer.</p>
          <div className="server-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void desktop?.closeConnectionSettings()}
            >
              Back
            </button>
            {connected && (
              <button type="button" disabled={busy || loading} onClick={() => void connect(true)}>
                Use this computer
              </button>
            )}
          </div>
        </form>
      </main>
    </>
  );
}

function Startup() {
  const [status, setStatus] = useState<Status>(() =>
    !desktop
      ? { phase: 'error', error: 'Open nod to finish setup.' }
      : parameters.has('unlocking')
        ? { phase: 'starting', unlockingKeys: true, platform: parameters.get('unlocking')! }
        : { phase: 'preparing' },
  );
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [welcome, setWelcome] = useState<WelcomeChoice | null>(null);
  const [welcomeError, setWelcomeError] = useState('');
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
    void Promise.all([
      desktop.status().then(
        (value) => {
          if (active && !receivedStatus) setStatus(value);
        },
        () => {
          if (active && !receivedStatus)
            setStatus({ phase: 'error', error: 'nod could not start. Try again.' });
        },
      ),
      Promise.all([desktop.getPreferences(), desktop.getSettings()])
        .then(([preferences, settings]) => {
          if (!active) return;
          applyPreferences(preferences);
          if (firstSetup) setWelcome(settings.welcome ?? { usageData: false, continued: false });
        })
        .catch(() => {
          if (active) setSettingsError('Your saved settings could not be opened. Try again.');
        }),
    ]).then(() => {
      if (active) setInitialized(true);
    });
    return () => {
      active = false;
      stopStatus?.();
      stopPreferences?.();
    };
  }, []);

  useEffect(() => {
    if (initialized) void desktop?.ready?.();
  }, [initialized]);

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
        error: cause instanceof Error ? cause.message : 'nod could not start. Try again.',
      }));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function saveWelcome(choice: WelcomeChoice) {
    if (!desktop || pending.current) return;
    pending.current = true;
    setBusy(true);
    setWelcomeError('');
    try {
      const saved = await desktop.saveSettings({ welcome: choice });
      setWelcome(saved.welcome ?? choice);
      if (choice.continued) await desktop.prepare();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Your choice could not be saved. Try again.';
      setWelcomeError(message);
      if (choice.continued) setStatus({ phase: 'error', error: message });
      throw cause;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (firstSetup && welcome && !welcome.continued)
    return (
      <>
        <div className="titlebar" aria-hidden="true" />
        <OnboardingFrame step="welcome">
          <div className="ob-screen" inert={busy}>
            <Welcome
              arrived="forward"
              onBack={() => {}}
              onNext={() => void saveWelcome({ ...welcome, continued: true }).catch(() => {})}
              usage={{
                enabled: welcome.usageData,
                onChange: (usageData) => saveWelcome({ usageData, continued: false }),
              }}
            />
          </div>
          {welcomeError && (
            <p className="ob-native-error" role="alert">
              {welcomeError}
            </p>
          )}
        </OnboardingFrame>
        <button
          className="server-entry"
          type="button"
          onClick={() => void desktop?.openConnectionSettings()}
        >
          Connect to a server
        </button>
      </>
    );

  const runtime = status.runtime;
  const failure: RuntimeStatus | undefined = settingsError
    ? { phase: 'error', error: settingsError }
    : status.windowError
      ? { phase: 'error', error: status.windowError }
      : status.phase === 'error' || status.error
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
      ? failure.error || failure.message || 'nod could not start. Try again.'
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
      ? 'nod uses your Mac’s Keychain to protect your saved connections. Allow access if macOS asks.'
      : 'nod uses your system’s secure storage to protect your saved connections.'
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
            ? 'nod needs another try'
            : unlocking
              ? 'Keeping your connections secure'
              : firstSetup
                ? 'Getting nod ready'
                : 'Opening nod'
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
              onClick={() =>
                void run(async () => {
                  if (settingsError || (firstSetup && !welcome)) {
                    const [preferences, settings] = await Promise.all([
                      desktop.getPreferences(),
                      desktop.getSettings(),
                    ]);
                    applyPreferences(preferences);
                    if (firstSetup)
                      setWelcome(settings.welcome ?? { usageData: false, continued: false });
                    setSettingsError('');
                  }
                  return desktop.prepare({ retry: true });
                })
              }
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
      <button
        className="server-entry"
        type="button"
        onClick={() => void desktop?.openConnectionSettings()}
      >
        Server connection
      </button>
    </>
  );
}

initializeFocusVisibility();
createRoot(document.getElementById('root')!).render(
  parameters.get('server') === 'true' ? <ConnectionSetup /> : <Startup />,
);
