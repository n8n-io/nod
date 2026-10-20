import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { AccountPreparationResponse, AccountUser } from '../../../shared/account';
import type { ModelsResponse } from '../../../shared/models';
import {
  onboardingSteps,
  onboardingVersion,
  type OnboardingStep,
} from '../../../shared/onboarding';
import { Button, Notice } from '../../components/ui';
import { SetupProgress } from '../../components/setup-progress';
import {
  desktopSettingsAvailable,
  desktopStatus,
  subscribeDesktopStatus,
  retryDesktopRuntime,
  type DesktopStatus,
} from '../../lib/desktop';
import { DesktopPreferencesSetup } from './steps/desktop-preferences';
import { useBrowserTimeZone } from '../../hooks/use-browser-time-zone';
import { api, errorMessage } from '../../lib/api';
import { analyticsForCurrentSession, captureAnalytics } from '../../lib/analytics';
import { clearStored, readStep, writeStep } from './storage';
import { Welcome } from './steps/welcome';
import { Brain } from './steps/brain';
import { About } from './steps/about';
import { Email } from './steps/email';
import { Telegram } from './steps/telegram';
import { OpenSource } from './steps/open-source';
import { desktopOnboardingSteps, OnboardingFrame } from './frame';

export type StepProps = {
  arrived: 'forward' | 'back';
  onNext(): void;
  onBack(): void;
  onSkip?(): void;
  busy?: boolean;
  preparing?: boolean;
  notice?: ReactNode;
  usage?: { enabled: boolean; onChange(enabled: boolean): Promise<void> };
};

const screens: Record<OnboardingStep, ComponentType<StepProps>> = {
  welcome: Welcome,
  brain: Brain,
  about: About,
  email: Email,
  telegram: Telegram,
  open: OpenSource,
};

export function Onboarding({
  user,
  onComplete,
  onFeedback,
  usageData = false,
  onUsageData,
}: {
  user: AccountUser;
  onComplete(): Promise<void>;
  onFeedback?(): void;
  usageData?: boolean;
  onUsageData?(enabled: boolean): Promise<void>;
}) {
  useBrowserTimeZone();
  const desktop = desktopSettingsAvailable();
  const [position, setPosition] = useState(() => {
    const url = new URL(window.location.href);
    const replay = url.searchParams.get('replay') === '1';
    const welcomed = desktop && url.searchParams.get('welcome') === 'complete' && !replay;
    if (replay) {
      clearStored();
      url.searchParams.delete('replay');
    }
    if (welcomed) url.searchParams.delete('welcome');
    if (replay || welcomed)
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const stored = readStep<{ owner: string; step: OnboardingStep; version?: number }>();
    const step: OnboardingStep =
      stored?.owner === user.id &&
      stored.version === onboardingVersion &&
      onboardingSteps.includes(stored.step) &&
      stored.step !== 'welcome'
        ? stored.step
        : welcomed
          ? 'brain'
          : 'welcome';
    if (step === 'welcome') clearStored();
    return { step, arrived: 'forward' as StepProps['arrived'] };
  });
  const { step, arrived } = position;
  const index = onboardingSteps.indexOf(step);
  const [preparation, setPreparation] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [finishing, setFinishing] = useState(false);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(!desktop);
  const [runtimeError, setRuntimeError] = useState('');
  const [error, setError] = useState('');
  const preparationRequest = useRef<AbortController | null>(null);
  const active = useRef(false);
  const retrying = useRef(false);
  const main = useRef<HTMLElement>(null);
  const viewed = useRef<{
    owner: string;
    step: OnboardingStep;
    direction: StepProps['arrived'];
  } | null>(null);

  useEffect(() => {
    writeStep({ owner: user.id, step, version: onboardingVersion });
    if (
      (step !== 'open' || preferencesReady) &&
      (viewed.current?.owner !== user.id ||
        viewed.current.step !== step ||
        viewed.current.direction !== arrived)
    ) {
      viewed.current = { owner: user.id, step, direction: arrived };
      captureAnalytics('otto_onboarding_step_viewed', {
        step: step === 'open' ? 'open_source' : step,
        direction: arrived,
      });
    }
  }, [step, user.id, preferencesReady]);

  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [step, user.id, preferencesReady]);

  useEffect(() => {
    if (index <= onboardingSteps.indexOf('brain')) return;
    let current = true;
    void api<ModelsResponse>('/api/models')
      .then((models) => {
        if (!current || models.connections.some((item) => item.status !== 'reconnect')) return;
        setPosition({ step: 'brain', arrived: 'forward' });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [user.id]);

  useEffect(() => {
    active.current = true;
    void prepare();
    return () => {
      active.current = false;
      preparationRequest.current?.abort();
    };
  }, [user.id]);

  useEffect(() => {
    if (!finishing || preparation === 'pending') return;
    if (preparation === 'failed') {
      setFinishing(false);
      return;
    }
    const capture = analyticsForCurrentSession();
    onComplete()
      .then(() => {
        clearStored();
      })
      .catch((cause) => {
        capture('otto_ui_error', { area: 'onboarding', action: 'save' });
        if (active.current) {
          setCompletionFailed(true);
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (active.current) setFinishing(false);
      });
  }, [finishing, preparation]);

  useEffect(() => {
    if (!desktop) return;
    let current = true;
    let received = false;
    function accept(status: DesktopStatus) {
      if (!current) return;
      const failure =
        status.error ||
        (status.phase === 'error' ? status.message : undefined) ||
        status.runtime?.error ||
        (status.runtime?.phase === 'error' ? status.runtime.message : undefined);
      setRuntimeError(failure || '');
    }
    const stop = subscribeDesktopStatus((status) => {
      received = true;
      accept(status);
    });
    void desktopStatus()
      ?.then((status) => {
        if (!received) accept(status);
      })
      .catch(() => {});
    return () => {
      current = false;
      stop();
    };
  }, [desktop]);

  async function prepare() {
    const capture = analyticsForCurrentSession();
    preparationRequest.current?.abort();
    const request = new AbortController();
    preparationRequest.current = request;
    setPreparation('pending');
    try {
      const response = await api<AccountPreparationResponse>('/api/account/prepare', {
        method: 'POST',
        body: '{}',
        signal: request.signal,
      });
      if (response.ok !== true) throw new Error('Setup could not be completed.');
      if (!request.signal.aborted) setPreparation('ready');
    } catch {
      if (!request.signal.aborted) {
        setPreparation('failed');
        capture('otto_ui_error', { area: 'onboarding', action: 'prepare' });
      }
    } finally {
      if (preparationRequest.current === request) preparationRequest.current = null;
    }
  }

  async function retry() {
    if (retrying.current) return;
    retrying.current = true;
    setSaving(true);
    setError('');
    try {
      if (runtimeError) await retryDesktopRuntime();
      if (active.current) {
        setRuntimeError('');
        if (completionFailed && step === 'open') {
          setCompletionFailed(false);
          setFinishing(true);
          if (preparation !== 'ready') void prepare();
        } else void prepare();
      }
    } catch (cause) {
      if (active.current) {
        const message = errorMessage(cause);
        setError(message);
        if (runtimeError) setRuntimeError(message);
      }
    } finally {
      retrying.current = false;
      if (active.current) setSaving(false);
    }
  }

  function go(offset: 1 | -1) {
    const next = onboardingSteps[index + offset];
    if (next) {
      setError('');
      setCompletionFailed(false);
      setPosition({ step: next, arrived: offset > 0 ? 'forward' : 'back' });
    }
  }

  function skipped() {
    if (step === 'telegram') captureAnalytics('otto_onboarding_step_skipped', { step });
  }

  function next() {
    if (step !== 'open') return void go(1);
    if (finishing) return;
    setError('');
    setCompletionFailed(false);
    if (preparation === 'failed') void prepare();
    setFinishing(true);
  }

  if (finishing) {
    const failure = runtimeError || error;
    return (
      <SetupProgress
        title={failure ? 'Setup needs another try.' : 'Finishing setting up your environment…'}
        description={failure ? 'Your progress is saved.' : undefined}
        error={failure || undefined}
      >
        {failure && (
          <Button variant="outline" disabled={saving} onClick={() => void retry()}>
            Try again
          </Button>
        )}
      </SetupProgress>
    );
  }

  const recovery = desktop && (runtimeError || error || saving || preparation === 'failed') && (
    <div className="ob-runtime">
      <Notice>
        {runtimeError || error || (saving ? 'Trying setup again…' : 'Setup needs another try.')}{' '}
        <Button variant="ghost" disabled={saving} onClick={() => void retry()}>
          Try again
        </Button>
      </Notice>
    </div>
  );

  if (desktop && step === 'open' && !preferencesReady)
    return <DesktopPreferencesSetup notice={recovery} onReady={() => setPreferencesReady(true)} />;

  const Screen = screens[step];
  return (
    <OnboardingFrame
      step={step}
      steps={desktop ? desktopOnboardingSteps : onboardingSteps}
      onFeedback={onFeedback}
      mainRef={main}
    >
      <div className="ob-screen">
        <Screen
          key={step}
          arrived={arrived}
          onNext={next}
          onBack={() => void go(-1)}
          onSkip={skipped}
          busy={step === 'open' && finishing}
          preparing={preparation !== 'ready'}
          notice={
            !desktop &&
            step === 'open' &&
            (preparation === 'failed' || !!error) && (
              <Notice>
                {error || 'Something went wrong while I was getting set up.'}{' '}
                {(preparation === 'failed' || completionFailed) && (
                  <Button variant="ghost" disabled={saving} onClick={() => void retry()}>
                    Try again
                  </Button>
                )}
              </Notice>
            )
          }
          usage={
            step === 'welcome' && onUsageData
              ? { enabled: usageData, onChange: onUsageData }
              : undefined
          }
        />
      </div>
      {recovery}
      {!desktop && step !== 'open' && error && <Notice>{error}</Notice>}
    </OnboardingFrame>
  );
}
