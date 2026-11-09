import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OnboardingStep } from '../../../../shared/onboarding';
import { OnboardingFrame } from '../frame';
import { Button, Notice } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { getDesktopSettings, saveDesktopSettings } from '../../../lib/desktop';
import { Messages } from '../motion';

export function DesktopPreferencesSetup({
  onReady,
  notice,
  steps,
}: {
  onReady(): void;
  notice?: ReactNode;
  steps: readonly OnboardingStep[];
}) {
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let current = true;
    void getDesktopSettings()
      .then((value) =>
        value.onboardingPreferenceStep === 'complete'
          ? value
          : saveDesktopSettings({
              launchAtLogin: true,
              onboardingPreferenceStep: 'complete',
            }),
      )
      .then((value) => {
        if (!current) return;
        if (value.onboardingPreferenceStep !== 'complete')
          throw new Error('Nod couldn’t finish setup. Try again.');
        ready.current();
      })
      .catch((cause) => {
        if (current) setError(errorMessage(cause));
      });
    return () => {
      current = false;
    };
  }, [retry]);

  return (
    <OnboardingFrame step="join" steps={steps}>
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
      </section>
      {notice}
    </OnboardingFrame>
  );
}
