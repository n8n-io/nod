import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import type { AccountUser } from '../../../shared/account';
import type { ModelsResponse } from '../../../shared/models';
import {
  onboardingSteps,
  onboardingVersion,
  type OnboardingStep,
} from '../../../shared/onboarding';
import { Button, Notice } from '../../components/ui';
import { SetupProgress } from '../../components/setup-progress';
import { desktopRuntimeAvailable, desktopRendererReady } from '../../lib/desktop';
import { DesktopPreferencesSetup } from './steps/desktop-preferences';
import { useBrowserTimeZone } from '../../hooks/use-browser-time-zone';
import { modelReady } from '../../hooks/use-models';
import { usePageData } from '../../hooks/use-page-data';
import { api, ApiError, errorMessage } from '../../lib/api';
import { subscribeAppEvents } from '../../lib/app-events';
import { pageDataCache } from '../../lib/page-data-cache';
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
  const privacy = usageShared || (traces !== undefined && Boolean(onTraces));
  const models = usePageData<ModelsResponse>('/api/models');
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
  const { arrived } = position;
  const step = position.step === 'privacy' && !privacy ? 'join' : position.step;
  const index = step === 'preferences' ? onboardingSteps.length : onboardingSteps.indexOf(step);
  const [finishing, setFinishing] = useState(0);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<'brain' | 'email' | null>(null);
  const [skipModelStep, setSkipModelStep] = useState<boolean | null>(null);
  const steps = onboardingSteps.filter(
    (item) => (item !== 'brain' || skipModelStep !== true) && (item !== 'privacy' || privacy),
  );
  const [mining, setMining] = useState(false);
  const emailSkipped = useRef(false);
  const active = useRef(false);
  const initialModelsChecked = useRef(false);
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
    if (step !== position.step) setPosition({ step, arrived });
  }, [step]);

  useEffect(
    () =>
      subscribeAppEvents(user.id, {
        open: () => pageDataCache.revalidateActive('/api/models'),
        error() {},
        message: (event) => {
          if (JSON.parse(event.data).type === 'refresh')
            pageDataCache.revalidateActive('/api/models');
        },
      }),
    [user.id],
  );

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
    void pageDataCache
      .refresh('/api/models')
      .then(() => {
        if (!current) return;
        const latest = pageDataCache.getSnapshot<ModelsResponse>('/api/models');
        const ready = !latest.error && modelReady(latest.data) && !latest.data?.selectionIssue;
        initialModelsChecked.current = true;
        setSkipModelStep(ready);
        if (!ready && index > onboardingSteps.indexOf('brain'))
          setPosition({ step: 'brain', arrived: 'forward' });
        if (ready)
          setPosition((position) =>
            position.step === 'brain' ? { step: 'privacy', arrived: 'forward' } : position,
          );
      })
      .catch(() => {
        if (current) setSkipModelStep(false);
      });
    return () => {
      current = false;
    };
  }, [user.id]);

  useEffect(() => {
    if (!initialModelsChecked.current || !models.data) return;
    const ready = modelReady(models.data) && !models.data.selectionIssue;
    setSkipModelStep((previous) => previous !== false && ready);
  }, [models.data]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [user.id]);

  useEffect(() => {
    if (!finishing) return;
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
  }, [finishing]);

  function retry() {
    setError('');
    setCompletionFailed(false);
    setFinishing((attempt) => attempt + 1);
  }

  function go(offset: 1 | -1) {
    let at = index + offset;
    while (onboardingSteps[at] && !steps.includes(onboardingSteps[at])) at += offset;
    const next = onboardingSteps[at];
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
    retry();
  }

  if (finishing && !completionFailed) return <SetupProgress title="Getting ready…" />;

  if (finishing) {
    return (
      <SetupProgress
        title="Setup needs another try."
        description="Your progress is saved."
        error={error}
      >
        {missing ? (
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
        ) : (
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </SetupProgress>
    );
  }

  if (step === 'preferences') return <DesktopPreferencesSetup onReady={next} steps={steps} />;

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
    </OnboardingFrame>
  );
}
