import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupProgress } from '../../src/web/components/setup-progress';
import { Welcome } from '../../src/web/pages/onboarding/steps/welcome';
import { Introduction } from '../../src/web/pages/onboarding/steps/intro';
import { OnboardingFrame } from '../../src/web/pages/onboarding/frame';
import { startupMessage, type StartupStage } from '../../src/shared/desktop-startup';
import { initializeFocusVisibility } from '../../src/web/lib/focus';
import '../../src/web/theme.css';
import '../../src/web/components/motion.css';
import '../../src/web/components/setup-progress.css';
import '../../src/web/components/controls.css';
import '../../src/web/pages/onboarding/onboarding.css';
import '../../src/web/pages/onboarding/steps/welcome.css';
import '../../src/web/pages/onboarding/steps/intro.css';

type RuntimeStatus = {
  phase?: string;
  stage?: StartupStage;
  message?: string;
  error?: string;
  progress?: number;
  needsWsl?: boolean;
  needsRuntimeArchive?: boolean;
};

type Status = RuntimeStatus & {
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

function Startup() {
  const [status, setStatus] = useState<Status>(() =>
    !desktop
      ? { phase: 'error', error: 'Open nod to finish setup.' }
      : parameters.has('unlocking')
        ? { phase: 'starting', unlockingKeys: true, platform: parameters.get('unlocking')! }
        : { phase: 'preparing' },
  );
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [welcome, setWelcome] = useState<WelcomeChoice | null>(null);
  const currentWelcome = useRef<WelcomeChoice | null>(null);
  const [welcomeStep, setWelcomeStep] = useState<'welcome' | 'waiting' | 'intro'>('welcome');
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
          if (firstSetup) acceptWelcome(settings.welcome ?? { usageData: false, continued: false });
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

  useEffect(() => {
    if (welcomeStep === 'waiting' && status.engineReady) setWelcomeStep('intro');
  }, [welcomeStep, status.engineReady]);

  async function run(action: () => Promise<Status | undefined>) {
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
        error: cause instanceof Error ? cause.message : 'nod could not start. Try again.',
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
        <OnboardingFrame step={welcomeStep}>
          <div className="ob-screen" inert={busy && !handingOff} aria-busy={busy || handingOff}>
            {welcomeStep === 'welcome' ? (
              <Welcome
                arrived="forward"
                onBack={() => {}}
                onNext={() => setWelcomeStep(status.engineReady ? 'intro' : 'waiting')}
              />
            ) : (
              <Introduction
                arrived="forward"
                continuing={handingOff}
                onBack={() => setWelcomeStep('welcome')}
                onNext={() => {
                  if (currentWelcome.current)
                    void saveWelcome({ ...currentWelcome.current, continued: true }).catch(
                      () => {},
                    );
                }}
                usage={{
                  enabled: welcome.usageData,
                  onChange: (usageData) => saveWelcome({ usageData, continued: false }),
                }}
              />
            )}
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
        title={error ? 'nod needs another try' : startupMessage(active.stage)}
        description={unlocking || error ? description : undefined}
        error={error}
        progress={progress}
      >
        {failure && desktop && (
          <div className="recovery-actions">
            <button
              type="button"
              disabled={working}
              onClick={() =>
                void run(async () => {
                  if (settingsError || (firstSetup && !welcome)) {
                    const [preferences, settings] = await Promise.all([
                      desktop.getPreferences(),
                      desktop.getSettings(),
                    ]);
                    applyPreferences(preferences);
                    if (firstSetup)
                      acceptWelcome(settings.welcome ?? { usageData: false, continued: false });
                    setSettingsError('');
                  }
                  return desktop.prepare({ retry: true });
                })
              }
            >
              {working ? 'Trying again…' : 'Try again'}
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

initializeFocusVisibility();
createRoot(document.getElementById('root')!).render(<Startup />);
