import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import type { AccountPreparationResponse, AccountUser } from '../../../shared/account';
import { startupMessage } from '../../../shared/desktop-startup';
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
  desktopRendererReady,
  desktopStatus,
  subscribeDesktopStatus,
  retryDesktopRuntime,
  type DesktopStatus,
} from '../../lib/desktop';
import { DesktopPreferencesSetup } from './steps/desktop-preferences';
import { useBrowserTimeZone } from '../../hooks/use-browser-time-zone';
import { modelReady } from '../../hooks/use-models';
import { api, ApiError, errorMessage } from '../../lib/api';
import { analyticsForCurrentSession, captureAnalytics } from '../../lib/analytics';
import { clearStored, readStep, writeStep } from './storage';
import { Welcome } from './steps/welcome';
import { Introduction } from './steps/intro';
import { Brain } from './steps/brain';
import { Email } from './steps/email';
import { Calendar } from './steps/calendar';
import { Apps } from './steps/apps';
import { desktopOnboardingSteps, OnboardingFrame } from './frame';

export type StepProps = {
  arrived: 'forward' | 'back';
  onNext(): void;
  onBack(): void;
  onSkip?(): void;
  nextLabel?: string;
  onReady?(): void;
  usage?: { enabled: boolean; onChange(enabled: boolean): Promise<void> };
};

const screens: Record<OnboardingStep, ComponentType<StepProps>> = {
  welcome: Welcome,
  intro: Introduction,
  brain: Brain,
  email: Email,
  calendar: Calendar,
  apps: Apps,
};

type SetupStep = OnboardingStep | 'preferences';

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
    const nativePreferences =
      desktop && url.searchParams.get('preferences') === 'required' && !replay;
    const welcomed = desktop && url.searchParams.get('welcome') === 'complete' && !replay;
    if (replay) {
      clearStored();
      url.searchParams.delete('replay');
    }
    if (welcomed) url.searchParams.delete('welcome');
    if (nativePreferences) url.searchParams.delete('preferences');
    if (replay || welcomed || nativePreferences)
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    const stored = readStep<{ owner: string; step: string; version?: number }>();
    const savedStep = ['about', 'telegram', 'messaging'].includes(stored?.step ?? '')
      ? 'apps'
      : stored?.step;
    const step: SetupStep = nativePreferences
      ? 'preferences'
      : stored?.owner === user.id &&
          stored.version === onboardingVersion &&
          (onboardingSteps.includes(savedStep as OnboardingStep) ||
            (desktop && savedStep === 'preferences')) &&
          savedStep !== 'welcome'
        ? (savedStep as SetupStep)
        : welcomed
          ? 'email'
          : 'welcome';
    if (step === 'welcome') clearStored();
    return { step, arrived: 'forward' as StepProps['arrived'] };
  });
  const { step, arrived } = position;
  const index = step === 'preferences' ? onboardingSteps.length : onboardingSteps.indexOf(step);
  const [preparation, setPreparation] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [finishing, setFinishing] = useState(0);
  const [waitingForServices, setWaitingForServices] = useState(false);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<'brain' | 'email' | null>(null);
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
    if (step !== 'email' && step !== 'calendar') desktopRendererReady();
  }, [step]);

  useEffect(() => {
    writeStep({ owner: user.id, step, version: onboardingVersion });
    if (
      step !== 'preferences' &&
      (viewed.current?.owner !== user.id ||
        viewed.current.step !== step ||
        viewed.current.direction !== arrived)
    ) {
      viewed.current = { owner: user.id, step, direction: arrived };
      captureAnalytics('nod_onboarding_step_viewed', {
        step,
        direction: arrived,
      });
    }
  }, [step, user.id]);

  useLayoutEffect(() => {
    if (main.current) {
      main.current.scrollTop = 0;
      main.current.focus({ preventScroll: true });
    }
  }, [step, user.id]);

  useEffect(() => {
    if (index <= onboardingSteps.indexOf('brain')) return;
    let current = true;
    void api<ModelsResponse>('/api/models')
      .then((models) => {
        if (!current || modelReady(models)) return;
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
    if (!finishing || preparation !== 'ready') return;
    const capture = analyticsForCurrentSession();
    onComplete()
      .then(() => {
        clearStored();
      })
      .catch((cause) => {
        capture('nod_ui_error', { area: 'onboarding', action: 'save' });
        if (active.current) {
          setCompletionFailed(true);
          setError(errorMessage(cause));
          setMissing(
            cause instanceof ApiError && (cause.step === 'brain' || cause.step === 'email')
              ? cause.step
              : null,
          );
        }
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
      setRuntimeStatus(status);
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
        capture('nod_ui_error', { area: 'onboarding', action: 'prepare' });
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
        if (completionFailed) {
          setCompletionFailed(false);
          setFinishing((attempt) => attempt + 1);
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
    if (step === 'email' || step === 'calendar')
      captureAnalytics('nod_onboarding_step_skipped', { step });
  }

  function next() {
    if (step !== 'apps' && step !== 'preferences') return void go(1);
    if (desktop && step === 'apps') return setPosition({ step: 'preferences', arrived: 'forward' });
    if (finishing) return;
    setWaitingForServices(preparation !== 'ready' || Boolean(runtimeError));
    setError('');
    setCompletionFailed(false);
    if (preparation === 'failed') void prepare();
    setFinishing((attempt) => attempt + 1);
  }

  if (
    finishing &&
    (waitingForServices || preparation !== 'ready' || completionFailed || runtimeError)
  ) {
    const failure =
      runtimeError || error || (preparation === 'failed' ? 'nod couldn’t finish setup.' : '');
    const runtime = runtimeStatus?.runtime;
    const activeRuntime = runtime && runtime.phase !== 'ready' ? runtime : runtimeStatus;
    const title =
      preparation === 'ready'
        ? startupMessage('ready')
        : startupMessage(activeRuntime?.stage ?? 'workspace');
    return (
      <SetupProgress
        title={failure ? 'Setup needs another try.' : title}
        progress={preparation === 'pending' ? activeRuntime?.progress : undefined}
        description={failure ? 'Your progress is saved.' : undefined}
        error={failure || undefined}
      >
        {failure && missing && (
          <Button
            variant="outline"
            onClick={() => {
              setFinishing(0);
              setCompletionFailed(false);
              setError('');
              setMissing(null);
              setPosition({ step: missing, arrived: 'back' });
            }}
          >
            {missing === 'brain' ? 'Connect an AI provider' : 'Connect Gmail'}
          </Button>
        )}
        {failure && !missing && (
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

  if (step === 'preferences')
    return <DesktopPreferencesSetup notice={recovery} onReady={next} onBack={() => go(-1)} />;

  const Screen = screens[step];
  return (
    <OnboardingFrame
      step={step}
      steps={desktop ? desktopOnboardingSteps : onboardingSteps}
      onFeedback={onFeedback}
      mainRef={main}
    >
      <div className="ob-screen" inert={Boolean(finishing)} aria-busy={Boolean(finishing)}>
        <Screen
          key={step}
          arrived={arrived}
          onReady={desktopRendererReady}
          onNext={next}
          onBack={() => void go(-1)}
          onSkip={skipped}
          nextLabel={!desktop && step === 'apps' ? 'Start chatting' : undefined}
          usage={
            step === 'intro' && onUsageData
              ? { enabled: usageData, onChange: onUsageData }
              : undefined
          }
        />
      </div>
      {recovery}
    </OnboardingFrame>
  );
}
