import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import type { AccountPreparationResponse, AccountUser } from '../../../shared/account';
import type { ModelsResponse } from '../../../shared/models';
import {
  onboardingSteps,
  onboardingVersion,
  type OnboardingStep,
} from '../../../shared/onboarding';
import { OttoGlyph } from '../../components/motion';
import { Button, Notice } from '../../components/ui';
import { useBrowserTimeZone } from '../../hooks/use-browser-time-zone';
import { api, errorMessage } from '../../lib/api';
import {
  analyticsForCurrentSession,
  captureAnalytics,
  type AnalyticsProperties,
} from '../../lib/analytics';
import { clearStored, readStep, writeStep } from './storage';
import { Welcome } from './steps/welcome';
import { Brain } from './steps/brain';
import { About } from './steps/about';
import { Email } from './steps/email';
import { Telegram } from './steps/telegram';
import { OpenSource } from './steps/open-source';

export type StepProps = {
  arrived: 'forward' | 'back';
  onNext(): void;
  onBack(): void;
  onSkip?(): void;
  busy?: boolean;
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
  onFeedback(): void;
  usageData?: boolean;
  onUsageData?(enabled: boolean): Promise<void>;
}) {
  useBrowserTimeZone();
  const [position, setPosition] = useState(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('replay') === '1') {
      clearStored();
      url.searchParams.delete('replay');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    const stored = readStep<{ owner: string; step: OnboardingStep; version?: number }>();
    const step =
      stored?.owner === user.id && onboardingSteps.includes(stored.step)
        ? stored.version === undefined && stored.step === 'about'
          ? 'email'
          : stored.step
        : 'welcome';
    if (step === 'welcome') clearStored();
    return { step, arrived: 'forward' as StepProps['arrived'] };
  });
  const { step, arrived } = position;
  const index = onboardingSteps.indexOf(step);
  const [preparation, setPreparation] = useState<'pending' | 'ready' | 'failed'>('pending');
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const preparationRequest = useRef<AbortController | null>(null);
  const active = useRef(false);
  const main = useRef<HTMLElement>(null);
  const recap = useRef<AnalyticsProperties<'otto_onboarding_recap'> | null>({
    steps_viewed: [],
    steps_skipped: [],
    went_back: false,
  });

  useEffect(() => {
    writeStep({ owner: user.id, step, version: onboardingVersion });
    const viewed = step === 'open' ? 'open_source' : step;
    if (recap.current && !recap.current.steps_viewed.includes(viewed))
      recap.current.steps_viewed.push(viewed);
    if (main.current) main.current.scrollTop = 0;
  }, [step, user.id]);

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
    if (usageData && recap.current) {
      capture('otto_onboarding_recap', recap.current);
      recap.current = null;
    }
    onComplete()
      .then(clearStored)
      .catch((cause) => {
        capture('otto_ui_error', { area: 'onboarding', action: 'save' });
        if (active.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active.current) setFinishing(false);
      });
  }, [finishing, preparation]);

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

  function go(offset: 1 | -1) {
    const next = onboardingSteps[index + offset];
    if (!next) return;
    if (offset < 0 && recap.current) recap.current.went_back = true;
    setPosition({ step: next, arrived: offset > 0 ? 'forward' : 'back' });
  }

  function skipped() {
    if (
      (step === 'welcome' || step === 'email' || step === 'telegram') &&
      recap.current &&
      !recap.current.steps_skipped.includes(step)
    )
      recap.current.steps_skipped.push(step);
  }

  async function changeUsage(enabled: boolean) {
    await onUsageData!(enabled);
    if (!enabled || !recap.current) return;
    captureAnalytics('otto_onboarding_recap', recap.current);
    recap.current = null;
  }

  function next() {
    if (step !== 'open') return go(1);
    if (finishing) return;
    setError('');
    if (preparation === 'failed') void prepare();
    setFinishing(true);
  }

  const Screen = screens[step];
  const welcome = step === 'welcome';
  return (
    <div className="ob" data-step={step}>
      <header className="ob-header">
        <div className="ob-brand" data-analytics-public>
          {!welcome && (
            <>
              <OttoGlyph mode="still" />
              <span>otto</span>
            </>
          )}
        </div>
        <div
          className="ob-dots"
          role={welcome ? undefined : 'img'}
          aria-label={welcome ? undefined : `Step ${index} of ${onboardingSteps.length - 1}`}
        >
          {!welcome &&
            onboardingSteps
              .slice(1)
              .map((dot, at) => (
                <span
                  key={dot}
                  data-state={at + 1 < index ? 'done' : at + 1 === index ? 'current' : 'next'}
                />
              ))}
        </div>
        <div className="ob-header-end" data-analytics-public>
          {!welcome && (
            <Button
              id="feedback-launcher"
              variant="ghost"
              size="sm"
              className="ob-feedback"
              onClick={onFeedback}
              aria-label="Feedback"
            >
              <MessageSquare size={16} aria-hidden="true" />
              <span className="ob-header-label">Feedback</span>
            </Button>
          )}
        </div>
      </header>
      <main className="ob-main" ref={main}>
        <Screen
          key={step}
          arrived={arrived}
          onNext={next}
          onBack={() => go(-1)}
          onSkip={skipped}
          busy={step === 'open' && finishing}
          notice={
            step === 'open' &&
            (preparation === 'failed' || !!error) && (
              <Notice>
                {error || 'Something went wrong while I was getting set up.'}{' '}
                {preparation === 'failed' && (
                  <Button variant="ghost" onClick={() => void prepare()}>
                    Try again
                  </Button>
                )}
              </Notice>
            )
          }
          usage={
            step === 'open' && onUsageData
              ? { enabled: usageData, onChange: changeUsage }
              : undefined
          }
        />
      </main>
    </div>
  );
}
