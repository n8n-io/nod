import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OnboardingStep } from '../../../../shared/onboarding';
import { OnboardingFrame } from '../frame';
import { Button, Notice } from '../../../components/ui';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { errorMessage } from '../../../lib/api';
import { desktopSetup, completeDesktopPreferences } from '../../../lib/desktop';
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
  const [loginItemNotice, setLoginItemNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let current = true;
    const capture = analyticsForCurrentSession();
    void desktopSetup()
      .then(async (value) => {
        if (value.preferenceStep === 'complete') return value;
        const completed = await completeDesktopPreferences();
        if (completed.preferenceStep === 'complete' && typeof completed.launchAtLogin === 'boolean')
          capture('login_item_observed', {
            login_item: completed.loginItemError
              ? 'failed'
              : completed.launchAtLogin
                ? 'registered'
                : 'not_registered',
          });
        return completed;
      })
      .then((value) => {
        if (!current) return;
        if (value.preferenceStep !== 'complete')
          throw new Error('Nod couldn’t finish setup. Try again.');
        if (value.loginItemError) setLoginItemNotice(value.loginItemError);
        else ready.current();
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
        <Messages items={[]} typing={!error && !loginItemNotice} />
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
        {loginItemNotice && (
          <Notice kind="info" onDismiss={() => ready.current()}>
            {loginItemNotice}{' '}
            <Button variant="ghost" onClick={() => ready.current()}>
              Continue
            </Button>
          </Notice>
        )}
      </section>
      {notice}
    </OnboardingFrame>
  );
}
