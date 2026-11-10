import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupProgress } from '../../src/web/components/setup-progress';
import { PasswordInput } from '../../src/web/components/password-input';
import { Welcome } from '../../src/web/pages/onboarding/steps/welcome';
import { OnboardingFrame } from '../../src/web/pages/onboarding/frame';
import { startupMessage, type StartupStage } from '../../src/shared/desktop-startup';
import { initializeFocusVisibility } from '../../src/web/lib/focus';
import '../../src/web/theme.css';
import '../../src/web/components/motion.css';
import '../../src/web/components/setup-progress.css';
import '../../src/web/components/controls.css';
import '../../src/web/components/dialog.css';
import '../../src/web/components/data-sharing.css';
import '../../src/web/pages/onboarding/onboarding.css';
import '../../src/web/pages/onboarding/steps/welcome.css';

type RuntimeStatus = {
  phase?: string;
  stage?: StartupStage;
  message?: string;
  error?: string;
  details?: string;
  progress?: number;
  secondsLeft?: number;
  needsWsl?: boolean;
  needsRuntimeArchive?: boolean;
  needsServerConnection?: boolean;
};

type Status = RuntimeStatus & {
  remote?: boolean;
  engineReady?: boolean;
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
  continueOnboarding(): Promise<void>;
  prepare(options?: { retry: boolean }): Promise<Status>;
  warmup?(): Promise<void>;
  installWsl(): Promise<Status>;
  showStartupLog(): Promise<void>;
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

function OnboardingSetup() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop
      .getPreferences()
      .then((value) => {
        if (active) applyPreferences(value);
      })
      .catch(() => {});
    const unsubscribe = desktop.onPreferences(applyPreferences);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not be opened. Try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="titlebar" aria-hidden="true" />
      <OnboardingFrame
        step="welcome"
        footer={
          <div className="setup-entry-actions">
            <button
              className="server-entry"
              type="button"
              disabled={busy || !desktop}
              onClick={() => void run(() => desktop!.closeConnectionSettings())}
            >
              Back to Nod
            </button>
            <button
              className="server-entry"
              type="button"
              disabled={busy || !desktop}
              onClick={() => void run(() => desktop!.openConnectionSettings())}
            >
              {parameters.get('remote') === 'true' ? 'Change server' : 'Connect to a server'}
            </button>
          </div>
        }
      >
        <div className="ob-screen" inert={busy || !desktop} aria-busy={busy}>
          <Welcome
            arrived="forward"
            local={parameters.get('remote') !== 'true'}
            actionLabel="Continue setup"
            onNext={() => {
              if (desktop) void run(() => desktop.continueOnboarding());
            }}
            onBack={() => {
              if (desktop) void run(() => desktop.closeConnectionSettings());
            }}
          />
        </div>
        {error && (
          <p className="ob-native-error" role="alert">
            {error}
          </p>
        )}
      </OnboardingFrame>
    </>
  );
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
        if (active) setLoading(false);
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
          <PasswordInput
            id="server-token"
            revealLabel="authentication token"
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
            Enter your server’s NOD_AUTH_TOKEN. Nod saves it in your computer’s secure storage.
          </p>
          {error && (
            <p className="server-error" role="alert">
              {error}
            </p>
          )}
          <button className="server-connect" type="submit" disabled={busy || loading}>
            {busy ? 'Connecting…' : 'Connect and restart app'}
          </button>
          <p className="server-help">
            Your local chats and files are kept. You can switch back anytime.
          </p>
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
      ? { phase: 'error', error: 'Open Nod to finish setup.' }
      : parameters.has('unlocking')
        ? { phase: 'starting', unlockingKeys: true, platform: parameters.get('unlocking')! }
        : { phase: 'preparing' },
  );
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [welcome, setWelcome] = useState<WelcomeChoice | null>(null);
  const currentWelcome = useRef<WelcomeChoice | null>(null);
  const localChoiceSaved = useRef(false);
  const [welcomeStep, setWelcomeStep] = useState<'welcome' | 'waiting'>('welcome');
  const [handingOff, setHandingOff] = useState(false);
  const [welcomeError, setWelcomeError] = useState('');
  const pending = useRef(false);
  const recoveryPending = useRef(false);

  function acceptWelcome(choice: WelcomeChoice) {
    currentWelcome.current = choice;
    setWelcome(choice);
  }

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let receivedStatus = false;
    const stopStatus = desktop.onStatus((value) => {
      receivedStatus = true;
      if (active) setStatus(value);
    });
    const stopPreferences = desktop.onPreferences(applyPreferences);
    void desktop.status().then(
      (value) => {
        if (active && !receivedStatus) setStatus(value);
      },
      () => {
        if (active && !receivedStatus)
          setStatus({ phase: 'error', error: 'Nod could not start. Try again.' });
      },
    );
    void Promise.all([desktop.getPreferences(), desktop.getSettings()])
      .then(([preferences, settings]) => {
        if (!active) return;
        applyPreferences(preferences);
        if (firstSetup) {
          localChoiceSaved.current = Boolean(settings.welcome);
          acceptWelcome(settings.welcome ?? { usageData: true, continued: false });
          void desktop.warmup?.().catch(() => {});
        }
      })
      .catch(() => {
        if (active) setSettingsError('Your saved settings could not be opened. Try again.');
      });
    return () => {
      active = false;
      stopStatus?.();
      stopPreferences?.();
    };
  }, []);

  useEffect(() => {
    if (welcomeStep !== 'waiting' || !status.engineReady || !currentWelcome.current) return;
    void saveWelcome({ ...currentWelcome.current, continued: true }).catch(() => {});
  }, [welcomeStep, status.engineReady]);

  async function run(action: () => Promise<Status | void>) {
    if (recoveryPending.current) return;
    recoveryPending.current = true;
    setRecovering(true);
    try {
      const value = await action();
      if (value) setStatus(value);
    } catch (cause) {
      setStatus((previous) => ({
        ...previous,
        phase: 'error',
        unlockingKeys: false,
        error: cause instanceof Error ? cause.message : 'Nod could not start. Try again.',
      }));
    } finally {
      recoveryPending.current = false;
      setRecovering(false);
    }
  }

  async function saveWelcome(choice: WelcomeChoice) {
    if (!desktop || pending.current) return;
    pending.current = true;
    setBusy(true);
    setWelcomeError('');
    if (choice.continued) setHandingOff(true);
    try {
      const saved = await desktop.saveSettings({ welcome: choice });
      localChoiceSaved.current = true;
      acceptWelcome(saved.welcome ?? choice);
      if (choice.continued) await desktop.prepare();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Your choice could not be saved. Try again.';
      setHandingOff(false);
      setWelcomeError(message);
      if (choice.continued) setStatus({ phase: 'error', error: message });
      throw cause;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  if (status.phase === 'updating')
    return (
      <>
        <div className="titlebar" aria-hidden="true" />
        <SetupProgress
          local={!status.remote}
          title="Updating Nod…"
          description="Nod reopens when it’s done."
        />
      </>
    );

  if (
    firstSetup &&
    welcome &&
    welcomeStep !== 'waiting' &&
    (!welcome.continued ||
      (handingOff &&
        status.engineReady &&
        status.phase !== 'error' &&
        status.runtime?.phase !== 'error' &&
        !status.windowError))
  )
    return (
      <>
        <div className="titlebar" aria-hidden="true" />
        <OnboardingFrame
          step={welcomeStep}
          footer={
            <button
              className="server-entry"
              type="button"
              onClick={() => void desktop?.openConnectionSettings()}
            >
              Connect to a server
            </button>
          }
        >
          <div className="ob-screen" inert={busy && !handingOff} aria-busy={busy || handingOff}>
            <Welcome
              local
              usageShared={welcome.usageData}
              traces={{ enabled: false, onChange: () => Promise.resolve() }}
              arrived="forward"
              onBack={() => {}}
              onNext={() =>
                void run(async () => {
                  if (!currentWelcome.current) return;
                  await saveWelcome({ ...currentWelcome.current, continued: false });
                  setWelcomeStep('waiting');
                  return desktop?.prepare();
                })
              }
            />
          </div>
          {welcomeError && (
            <p className="ob-native-error" role="alert">
              {welcomeError}
            </p>
          )}
        </OnboardingFrame>
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
  const working = busy || recovering;
  const error =
    !working && failure
      ? failure.error || failure.message || 'Nod could not start. Try again.'
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
      ? 'Nod uses your Mac’s Keychain to protect your saved connections. Allow access if macOS asks.'
      : 'Nod uses your system’s secure storage to protect your saved connections.'
    : working
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
        local={!status.remote}
        footer={
          <button
            className="server-entry"
            type="button"
            onClick={() => void desktop?.openConnectionSettings()}
          >
            Server connection
          </button>
        }
        title={
          error
            ? 'Nod needs another try'
            : status.remote
              ? 'Connecting to your server…'
              : active.message || startupMessage(active.stage)
        }
        description={unlocking || error ? description : undefined}
        error={error}
        details={error ? failure?.details : undefined}
        progress={progress}
        secondsLeft={progress === undefined ? undefined : active.secondsLeft}
      >
        {failure && desktop && (
          <div className="recovery-actions">
            <button
              type="button"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  if (failure.needsServerConnection) {
                    await desktop.openConnectionSettings();
                    return;
                  }
                  if (settingsError || (firstSetup && !welcome)) {
                    const [preferences, settings] = await Promise.all([
                      desktop.getPreferences(),
                      desktop.getSettings(),
                    ]);
                    applyPreferences(preferences);
                    if (firstSetup) {
                      localChoiceSaved.current = Boolean(settings.welcome);
                      acceptWelcome(settings.welcome ?? { usageData: true, continued: false });
                    }
                    setSettingsError('');
                  }
                  if (firstSetup && !localChoiceSaved.current) return;
                  return desktop.prepare({ retry: true });
                })
              }
            >
              {working
                ? 'Trying again…'
                : failure.needsServerConnection
                  ? 'Reconnect to server'
                  : 'Try again'}
            </button>
            <button
              type="button"
              disabled={working}
              onClick={() => void run(() => desktop.showStartupLog())}
            >
              Show startup log
            </button>
            {(failure.needsWsl || runtime?.needsWsl) && (
              <button
                type="button"
                disabled={working}
                onClick={() => void run(() => desktop.installWsl())}
              >
                Install WSL
              </button>
            )}
            {(failure.needsRuntimeArchive || runtime?.needsRuntimeArchive) && (
              <button
                type="button"
                disabled={working}
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

function Setup() {
  useEffect(() => {
    void desktop?.ready?.();
  }, []);
  return parameters.get('server') === 'true' ? (
    <ConnectionSetup />
  ) : parameters.get('onboarding') === 'true' ? (
    <OnboardingSetup />
  ) : (
    <Startup />
  );
}

initializeFocusVisibility();
createRoot(document.getElementById('root')!).render(<Setup />);
