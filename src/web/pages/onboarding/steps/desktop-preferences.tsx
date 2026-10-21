import { useEffect, useRef, useState, type ReactNode } from 'react';
import { desktopOnboardingSteps, OnboardingFrame } from '../frame';
import { Button, Notice } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { captureAnalytics } from '../../../lib/analytics';
import {
  getDesktopSettings,
  saveDesktopSettings,
  type DesktopSettings,
} from '../../../lib/desktop';
import { Footer, Messages, PreferenceBubble, useReveal } from '../motion';

type PreferenceStep = Exclude<DesktopSettings['onboardingPreferenceStep'], 'complete'>;

const sequence = [{ typing: 550 }, { wait: 250 }];

export function DesktopPreferencesSetup({
  onReady,
  notice,
}: {
  onReady(): void;
  notice?: ReactNode;
}) {
  const [step, setStep] = useState<PreferenceStep | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const active = useRef(false);
  const writing = useRef(false);
  const ready = useRef(onReady);
  ready.current = onReady;

  function accept(value: DesktopSettings) {
    if (value.onboardingPreferenceStep === 'complete') ready.current();
    else if (
      value.onboardingPreferenceStep === 'notifications' ||
      value.onboardingPreferenceStep === 'launchAtLogin'
    ) {
      setStep(value.onboardingPreferenceStep);
      setEnabled(value[value.onboardingPreferenceStep]);
    } else throw new Error('Your desktop preferences could not be loaded. Try again.');
  }

  useEffect(() => {
    active.current = true;
    let current = true;
    void Promise.resolve()
      .then(getDesktopSettings)
      .then((value) => {
        if (current) {
          accept(value);
          setError('');
        }
      })
      .catch((cause) => {
        if (current) setError(errorMessage(cause));
      });
    return () => {
      active.current = false;
      current = false;
    };
  }, [retry]);

  useEffect(() => {
    if (step)
      captureAnalytics('otto_onboarding_step_viewed', {
        step: step === 'notifications' ? 'notifications' : 'launch_at_login',
        direction: 'forward',
      });
  }, [step]);

  async function choose(enabled: boolean, advance = false) {
    if (!step || writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await saveDesktopSettings({
        [step]: enabled,
        ...(advance
          ? {
              onboardingPreferenceStep:
                step === 'notifications' ? ('launchAtLogin' as const) : ('complete' as const),
            }
          : {}),
      });
      if (active.current) accept(saved);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      writing.current = false;
      if (active.current) setSaving(false);
    }
  }

  return (
    <OnboardingFrame step={step ?? 'notifications'} steps={desktopOnboardingSteps}>
      {step ? (
        <DesktopPreferenceQuestion
          key={step}
          step={step}
          saving={saving}
          enabled={enabled}
          error={error}
          choose={choose}
        />
      ) : (
        <section className="ob-step">
          <Messages items={[]} typing={!error} />
          {error && (
            <Notice>
              {error}{' '}
              <Button
                variant="ghost"
                onClick={() => {
                  setError('');
                  setRetry((value) => value + 1);
                }}
              >
                Try again
              </Button>
            </Notice>
          )}
          <Footer show={false} onNext={() => void choose(enabled, true)} />
        </section>
      )}
      {notice}
    </OnboardingFrame>
  );
}

function DesktopPreferenceQuestion({
  step,
  saving,
  enabled,
  error,
  choose,
}: {
  step: PreferenceStep;
  saving: boolean;
  enabled: boolean;
  error: string;
  choose(enabled: boolean, advance?: boolean): Promise<void>;
}) {
  const { revealed, typing } = useReveal(sequence);
  const question = useRef<HTMLElement>(null);
  const notifications = step === 'notifications';

  useEffect(() => {
    question.current?.focus();
  }, []);

  return (
    <section
      className="ob-step ob-desktop-preference"
      aria-label={notifications ? 'Notifications' : 'Open at login'}
      ref={question}
      tabIndex={-1}
      data-analytics-public
    >
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <PreferenceBubble
            label={notifications ? 'Desktop notifications' : 'Open at login'}
            checked={enabled}
            saving={saving}
            disabled={saving}
            error={error}
            onChange={(value) => void choose(value)}
          >
            {notifications
              ? 'I can let you know when setup is ready, a task finishes, or I need your attention — even when you’re using another app.'
              : 'I can open when you sign in to your computer, so I’m ready when you need me.'}
          </PreferenceBubble>,
        ]}
      />
      <Footer
        show={revealed >= sequence.length}
        busy={saving}
        onNext={() => void choose(enabled, true)}
      />
    </section>
  );
}
