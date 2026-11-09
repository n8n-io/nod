import type { ReactNode, Ref } from 'react';
import { MessageSquare } from '../../components/icons';
import { onboardingSteps, type OnboardingStep } from '../../../shared/onboarding';
import { NodGlyph } from '../../components/motion';
import { Button } from '../../components/ui';

const stepNames: Record<OnboardingStep, string> = {
  welcome: 'Welcome to Nod',
  about: 'About you',
  email: 'Connect your email',
  brain: 'Connect an AI provider',
  privacy: 'Help improve Nod',
  join: 'Stay up to date',
};

export function OnboardingFrame({
  step,
  steps = onboardingSteps,
  onFeedback,
  mainRef,
  footer,
  children,
}: {
  step: OnboardingStep;
  steps?: readonly OnboardingStep[];
  onFeedback?(): void;
  mainRef?: Ref<HTMLElement>;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const welcome = step === 'welcome';
  const progressSteps = steps.filter((item) => item !== 'welcome');
  const index = progressSteps.findIndex((item) => item === step);
  return (
    <div className="ob" data-step={step}>
      {!welcome && (
        <header className="ob-header">
          <div className="ob-brand">
            <NodGlyph mode="still" />
            <span>Nod</span>
          </div>
          <div
            className="ob-dots"
            role="img"
            aria-label={`Step ${index + 1} of ${progressSteps.length}`}
          >
            {progressSteps.map((dot, at) => (
              <span
                key={dot}
                data-state={at < index ? 'done' : at === index ? 'current' : 'next'}
              />
            ))}
          </div>
          <div className="ob-header-end">
            {onFeedback && (
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
      )}
      <main className="ob-main" ref={mainRef} tabIndex={-1} aria-label={stepNames[step]}>
        {children}
      </main>
      {footer && <footer className="ob-frame-footer">{footer}</footer>}
    </div>
  );
}
