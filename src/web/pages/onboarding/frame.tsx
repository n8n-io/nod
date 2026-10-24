import type { ReactNode, Ref } from 'react';
import { MessageSquare } from '../../components/icons';
import { onboardingSteps, type OnboardingStep } from '../../../shared/onboarding';
import { NodGlyph } from '../../components/motion';
import { Button } from '../../components/ui';

type DisplayStep = OnboardingStep | 'launchAtLogin';

const stepNames: Record<DisplayStep, string> = {
  welcome: 'Welcome to nod',
  intro: 'Meet nod',
  email: 'Connect your email',
  calendar: 'Connect your calendar',
  brain: 'Connect an AI provider',
  apps: 'Connect your tools',
  launchAtLogin: 'Open at login',
};

export const desktopOnboardingSteps: readonly DisplayStep[] = [...onboardingSteps, 'launchAtLogin'];

export function OnboardingFrame({
  step,
  steps = onboardingSteps,
  onFeedback,
  mainRef,
  children,
}: {
  step: DisplayStep;
  steps?: readonly DisplayStep[];
  onFeedback?(): void;
  mainRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  const welcome = step === 'welcome' || step === 'intro';
  const progressSteps = steps.filter((item) => item !== 'welcome' && item !== 'intro');
  const index = progressSteps.findIndex((item) => item === step);
  return (
    <div className="ob" data-step={step}>
      <header className="ob-header">
        <div className="ob-brand" data-analytics-public>
          {!welcome && (
            <>
              <NodGlyph mode="still" />
              <span>nod</span>
            </>
          )}
        </div>
        <div
          className="ob-dots"
          role={welcome ? undefined : 'img'}
          aria-label={welcome ? undefined : `Step ${index + 1} of ${progressSteps.length}`}
        >
          {!welcome &&
            progressSteps.map((dot, at) => (
              <span
                key={dot}
                data-state={at < index ? 'done' : at === index ? 'current' : 'next'}
              />
            ))}
        </div>
        <div className="ob-header-end" data-analytics-public>
          {!welcome && onFeedback && (
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
      <main className="ob-main" ref={mainRef} tabIndex={-1} aria-label={stepNames[step]}>
        {children}
      </main>
    </div>
  );
}
