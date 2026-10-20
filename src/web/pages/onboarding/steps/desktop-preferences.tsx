import { useEffect, useRef, useState } from 'react';
import { OnboardingFrame } from '..';
import { Splash } from '../../../components/startup';
import { Button, Notice } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import {
  getDesktopSettings,
  saveDesktopSettings,
  type DesktopSettings,
} from '../../../lib/desktop';
import { Bubble, Footer, Messages, useReveal } from '../motion';

type PreferenceStep = Exclude<DesktopSettings['onboardingPreferenceStep'], 'complete'>;

const sequence = [{ typing: 450 }, { wait: 250, typing: 550 }, { wait: 250 }];

export function DesktopPreferencesSetup({ onReady }: { onReady(): void }) {
  const [step, setStep] = useState<PreferenceStep | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const active = useRef(false);
  const writing = useRef(false);
  const ready = useRef(onReady);
  ready.current = onReady;

  function accept(value: DesktopSettings) {
    if (value.onboardingPreferenceStep === 'complete') ready.current();
    else if (
      value.onboardingPreferenceStep === 'notifications' ||
      value.onboardingPreferenceStep === 'launchAtLogin'
    )
      setStep(value.onboardingPreferenceStep);
    else throw new Error('Your desktop preferences could not be loaded. Try again.');
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

  async function choose(enabled: boolean) {
    if (!step || writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = await saveDesktopSettings({
        [step]: enabled,
        onboardingPreferenceStep: step === 'notifications' ? 'launchAtLogin' : 'complete',
      });
      if (active.current) accept(saved);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      writing.current = false;
      if (active.current) setSaving(false);
    }
  }

  if (!step)
    return error ? (
      <main className="initial-loading">
        <Notice>{error}</Notice>
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
          Try again
        </Button>
      </main>
    ) : (
      <Splash />
    );

  return (
    <OnboardingFrame step="open">
      <DesktopPreferenceQuestion
        key={step}
        step={step}
        saving={saving}
        error={error}
        choose={choose}
      />
    </OnboardingFrame>
  );
}

function DesktopPreferenceQuestion({
  step,
  saving,
  error,
  choose,
}: {
  step: PreferenceStep;
  saving: boolean;
  error: string;
  choose(enabled: boolean): Promise<void>;
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
        items={
          notifications
            ? [
                <Bubble>Would you like desktop notifications?</Bubble>,
                <Bubble>
                  I can let you know when a task finishes or needs your attention, even when you’re
                  using another app.
                </Bubble>,
              ]
            : [
                <Bubble>Should I open when you sign in to your computer?</Bubble>,
                <Bubble>I’ll be ready when you need me. You can change this in Settings.</Bubble>,
              ]
        }
      />
      {error && <Notice>{error}</Notice>}
      <Footer
        show={revealed >= sequence.length}
        busy={saving}
        onSkip={() => void choose(false)}
        skipLabel="Not now"
        onNext={() => void choose(true)}
        nextLabel={notifications ? 'Enable notifications' : 'Open at login'}
      />
    </section>
  );
}
