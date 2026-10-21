import type { ReactNode, Ref } from 'react';
import { MessageSquare } from 'lucide-react';
import { onboardingSteps, type OnboardingStep } from '../../../shared/onboarding';
import { OttoGlyph } from '../../components/motion';
import { Button } from '../../components/ui';

type DisplayStep = OnboardingStep | 'notifications' | 'launchAtLogin';

export const desktopOnboardingSteps: readonly DisplayStep[] = onboardingSteps.flatMap<DisplayStep>(
  (step) => (step === 'open' ? ['notifications', 'launchAtLogin', step] : [step]),
);

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
  const welcome = step === 'welcome';
  const index = steps.indexOf(step);
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
          aria-label={welcome ? undefined : `Step ${index} of ${steps.length - 1}`}
        >
          {!welcome &&
            steps
              .slice(1)
              .map((dot, at) => (
                <span
                  key={dot}
                  data-state={at + 1 < index ? 'done' : at + 1 === index ? 'current' : 'next'}
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
      <main className="ob-main" ref={mainRef}>
        {children}
      </main>
    </div>
  );
}
