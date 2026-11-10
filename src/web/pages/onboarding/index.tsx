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
  desktopRuntimeAvailable,
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
import { Brain } from './steps/brain';
import { Email } from './steps/email';
import { Privacy } from './steps/privacy';
import { About } from './steps/about';
import { Join } from './steps/join';
import { OnboardingFrame } from './frame';

export type StepProps = {
  arrived: 'forward' | 'back';
  quiet?: boolean;
  onNext(): void;
  onBack(): void;
  onSkip?(): void;
  nextLabel?: string;
  usageShared?: boolean;
  updatesEmail?: boolean;
  traces?: { enabled: boolean; onChange(enabled: boolean): Promise<void> };
};

const screens: Record<OnboardingStep, ComponentType<StepProps>> = {
  welcome: Welcome,
  about: About,
  email: Email,
  brain: Brain,
  privacy: Privacy,
  join: Join,
};

function mineEmail() {
  void api('/api/onboarding/suggestions', { method: 'POST', body: '{}' }).catch(() => {});
}

type SetupStep = OnboardingStep | 'preferences';

export function Onboarding({
  user,
  onComplete,
  onFeedback,
  usageShared = false,
  updatesEmail = false,
  traces,
  onTraces,
}: {
  user: AccountUser;
  onComplete(): Promise<void>;
  onFeedback?(): void;
  usageShared?: boolean;
  updatesEmail?: boolean;
  traces?: boolean;
  onTraces?(enabled: boolean): Promise<void>;
}) {
  useBrowserTimeZone();
  const desktop = desktopRuntimeAvailable();
  const [position, setPosition] = useState<{
    step: SetupStep;
    arrived: StepProps['arrived'];
    quiet?: boolean;
  }>(() => {
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
    const savedStep = stored?.step;
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
    return {
      step,
      arrived: 'forward',
      quiet: welcomed && step === 'email',
    };
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
  const [modelOk, setModelOk] = useState<boolean | null>(null);
  const [mining, setMining] = useState(false);
  const emailSkipped = useRef(false);
  const started = useRef(false);
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
    desktopRendererReady();
  }, []);

  useEffect(() => {
    writeStep({ owner: user.id, step, version: onboardingVersion });
    if (
      step !== 'preferences' &&
      (viewed.current?.owner !== user.id ||
        viewed.current.step !== step ||
        viewed.current.direction !== arrived)
    ) {
      viewed.current = { owner: user.id, step, direction: arrived };
      captureAnalytics('onboarding_step_viewed', {
        step,
        direction: arrived,
      });
    }
  }, [step, user.id]);

  useEffect(() => {
    if (step !== 'privacy') return;
    void api('/api/account/model-setup', { method: 'POST', body: '{}' }).catch(() => {});
  }, [step, user.id, usageShared]);

  useLayoutEffect(() => {
    if (main.current) {
      main.current.scrollTop = 0;
      main.current.focus({ preventScroll: true });
    }
  }, [step, user.id]);

  useEffect(() => {
    let current = true;
    void api<ModelsResponse>('/api/models')
      .then((models) => {
        if (!current) return;
        const ready = modelReady(models);
        setModelOk(ready);
        if (!ready && index > onboardingSteps.indexOf('brain'))
          setPosition({ step: 'brain', arrived: 'forward' });
        if (ready)
          setPosition((position) =>
            position.step === 'brain' ? { step: 'privacy', arrived: 'forward' } : position,
          );
      })
      .catch(() => {
        if (current) setModelOk(false);
      });
    return () => {
      current = false;
    };
  }, [user.id]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      started.current = false;
      preparationRequest.current?.abort();
    };
  }, [user.id]);

  useEffect(() => {
    if (step === 'welcome' || started.current) return;
    started.current = true;
    void prepare();
  }, [step, user.id]);

  useEffect(() => {
    if (!finishing || preparation !== 'ready') return;
    const capture = analyticsForCurrentSession();
    onComplete()
      .then(() => {
        clearStored();
      })
      .catch((cause) => {
        capture('ui_error', { area: 'onboarding', action: 'save' });
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
        capture('ui_error', { area: 'onboarding', action: 'prepare' });
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
    let next = onboardingSteps[index + offset];
    if (next === 'brain' && modelOk === true) next = onboardingSteps[index + offset * 2];
    if (next) {
      setError('');
      setCompletionFailed(false);
      setPosition({ step: next, arrived: offset > 0 ? 'forward' : 'back' });
    }
  }

  function skipped() {
    if (step === 'email') {
      emailSkipped.current = true;
      captureAnalytics('onboarding_step_skipped', { step });
    }
  }

  function next() {
    if (step === 'email') {
      setMining(!emailSkipped.current);
      emailSkipped.current = false;
    }
    if (step === 'about' && mining) mineEmail();
    if (step === 'brain' && mining) mineEmail();
    if (step !== 'join' && step !== 'preferences') return void go(1);
    if (desktop && step === 'join') return setPosition({ step: 'preferences', arrived: 'forward' });
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
      runtimeError || error || (preparation === 'failed' ? 'Nod couldn’t finish setup.' : '');
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
        secondsLeft={preparation === 'pending' ? activeRuntime?.secondsLeft : undefined}
        description={
          failure
            ? 'Your progress is saved.'
            : mining
              ? 'Meanwhile, I’m reading your recent email to find things I can take off your plate.'
              : 'Your workspace and browser are getting ready. This only happens once.'
        }
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

  const steps = onboardingSteps.filter((item) => item !== 'brain' || modelOk !== true);
  if (step === 'preferences')
    return <DesktopPreferencesSetup notice={recovery} onReady={next} steps={steps} />;

  const Screen = screens[step];
  return (
    <OnboardingFrame step={step} steps={steps} onFeedback={onFeedback} mainRef={main}>
      <div className="ob-screen" inert={Boolean(finishing)} aria-busy={Boolean(finishing)}>
        <Screen
          key={step}
          arrived={arrived}
          quiet={position.quiet}
          onNext={next}
          onBack={() => void go(-1)}
          onSkip={skipped}
          nextLabel={!desktop && step === 'join' ? 'Start chatting' : undefined}
          usageShared={usageShared}
          updatesEmail={updatesEmail}
          traces={
            (step === 'privacy' || step === 'welcome') && traces !== undefined && onTraces
              ? { enabled: traces, onChange: onTraces }
              : undefined
          }
        />
      </div>
      {recovery}
    </OnboardingFrame>
  );
}
