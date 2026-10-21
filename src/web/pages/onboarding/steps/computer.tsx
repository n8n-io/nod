import { useEffect, useRef, useState, type ReactNode } from 'react';
import { OnboardingFrame, type DisplayStep } from '../frame';
import { Notice } from '../../../components/ui';
import {
  ComputerPermissions,
  computerPermissions,
  useComputer,
} from '../../../components/your-computer';
import { api, errorMessage } from '../../../lib/api';
import { captureAnalytics } from '../../../lib/analytics';
import { Bubble, Footer, Messages, useReveal } from '../motion';

const sequence = [{ typing: 550 }, { wait: 250 }];

export function ComputerSetup({
  steps,
  onReady,
  notice,
}: {
  steps: readonly DisplayStep[];
  onReady(): void;
  notice?: ReactNode;
}) {
  const { status, error, busy, allow } = useComputer();
  const { revealed, typing } = useReveal(sequence, { enabled: Boolean(status?.available) });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    if ((status && status.available !== true) || (!status && error)) ready.current();
  }, [status, error]);

  useEffect(() => {
    if (status?.available)
      captureAnalytics('otto_onboarding_step_viewed', { step: 'computer', direction: 'forward' });
  }, [status?.available]);

  const missing = status
    ? computerPermissions.find(([key]) => !status.permissions[key])?.[0]
    : undefined;

  async function next() {
    if (!status) return;
    if (missing) return allow(missing);
    setSaving(true);
    setSaveError('');
    try {
      await api('/api/computer', { method: 'PATCH', body: JSON.stringify({ enabled: true }) });
      onReady();
    } catch (cause) {
      setSaveError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <OnboardingFrame step="computer" steps={steps}>
      <section className="ob-step" aria-label="Let Otto use your computer" data-analytics-public>
        {status?.available ? (
          <Messages
            revealed={revealed}
            typing={typing}
            items={[
              <Bubble>
                <p>Let Otto use your computer.</p>
                <p>
                  I can organize files, run commands and use your Mac apps in the background. I ask
                  you before anything you did not ask for.
                </p>
                <p>
                  macOS needs two permissions for this. Allow each one, then switch Otto on in
                  System Settings when it opens.
                </p>
              </Bubble>,
              <Bubble>
                <ComputerPermissions
                  status={status}
                  busy={busy || saving}
                  onAllow={(key) => void allow(key)}
                />
              </Bubble>,
            ]}
          />
        ) : (
          <Messages items={[]} typing={!error} />
        )}
        {(error || saveError) && <Notice>{error || saveError}</Notice>}
        <Footer
          show={Boolean(status?.available) && revealed >= sequence.length}
          busy={saving || busy}
          onSkip={onReady}
          skipLabel="Not now"
          nextLabel={
            missing === 'accessibility'
              ? 'Allow Accessibility'
              : missing === 'screen'
                ? 'Allow Screen Recording'
                : 'Continue'
          }
          onNext={() => void next()}
        />
      </section>
      {notice}
    </OnboardingFrame>
  );
}
