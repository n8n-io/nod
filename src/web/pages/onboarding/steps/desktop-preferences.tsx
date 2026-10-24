import { LoaderCircle, Power } from '../../../components/icons';
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
import { Bubble, Footer, Messages, useReveal } from '../motion';

type PreferenceStep = Exclude<DesktopSettings['onboardingPreferenceStep'], 'complete'>;

const sequence = [{ typing: 550 }, { wait: 250 }];

export function DesktopPreferencesSetup({
  onReady,
  onBack,
  notice,
}: {
  onReady(): void;
  onBack(): void;
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
    else if (value.onboardingPreferenceStep === 'launchAtLogin') {
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
      captureAnalytics('nod_onboarding_step_viewed', {
        step: 'launch_at_login',
        direction: 'forward',
      });
  }, [step]);

  async function choose(enabled: boolean, advance = false) {
    if (!step || writing.current || (advance && !enabled)) return;
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await saveDesktopSettings({
        [step]: enabled,
        ...(advance
          ? {
              onboardingPreferenceStep: 'complete' as const,
            }
          : {}),
      });
      if (!advance && !saved[step])
        throw new Error('Open at login could not be enabled. Try again.');
      if (active.current) accept(saved);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      writing.current = false;
      if (active.current) setSaving(false);
    }
  }

  return (
    <OnboardingFrame step="launchAtLogin" steps={desktopOnboardingSteps}>
      {step ? (
        <DesktopPreferenceQuestion
          key={step}
          saving={saving}
          enabled={enabled}
          error={error}
          choose={choose}
          onBack={onBack}
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
          <Footer show={false} onBack={onBack} onNext={() => void choose(enabled, true)} />
        </section>
      )}
      {notice}
    </OnboardingFrame>
  );
}

function DesktopPreferenceQuestion({
  saving,
  enabled,
  error,
  choose,
  onBack,
}: {
  saving: boolean;
  enabled: boolean;
  error: string;
  choose(enabled: boolean, advance?: boolean): Promise<void>;
  onBack(): void;
}) {
  const { revealed, typing, done, skip } = useReveal(sequence);
  const question = useRef<HTMLElement>(null);

  useEffect(() => {
    question.current?.focus();
  }, []);

  return (
    <section
      className="ob-step ob-desktop-preference"
      aria-label="Open at login"
      ref={question}
      tabIndex={-1}
      data-analytics-public
      onClick={done ? undefined : skip}
    >
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>
            <p>Enable open at login so I’m ready to help when you sign in to your computer.</p>
            {!enabled && (
              <div className="ob-preference-action">
                <Button disabled={saving} aria-busy={saving} onClick={() => void choose(true)}>
                  {saving ? (
                    <LoaderCircle size={17} className="spin" aria-hidden="true" />
                  ) : (
                    <Power size={17} aria-hidden="true" />
                  )}
                  {saving ? 'Enabling…' : error ? 'Try again' : 'Enable open at login'}
                </Button>
              </div>
            )}
            {error && (
              <p className="ob-preference-error" role="alert">
                {error}
              </p>
            )}
          </Bubble>,
          ...(enabled
            ? [
                <Bubble role="status">
                  Open at login is on. I’ll start when you sign in to your computer.
                </Bubble>,
              ]
            : []),
        ]}
      />
      <Footer
        show={revealed >= sequence.length}
        busy={saving}
        onBack={onBack}
        nextDisabled={!enabled}
        nextLabel="Start chatting"
        onNext={() => void choose(enabled, true)}
      />
    </section>
  );
}
