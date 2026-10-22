import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ComputerPermission } from '../../../../shared/computer';
import { OnboardingFrame, type DisplayStep } from '../frame';
import { Notice } from '../../../components/ui';
import {
  ComputerPermissions,
  computerPermissions,
  useComputer,
} from '../../../components/your-computer';
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
  const { status, error, busy, checking, allow, setEnabled, refresh } = useComputer();
  const [requested, setRequested] = useState<ComputerPermission | null>(null);
  const { revealed, typing } = useReveal(sequence, { enabled: Boolean(status?.available) });
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    if (status && status.available !== true) ready.current();
  }, [status]);

  useEffect(() => {
    if (status?.available)
      captureAnalytics('nod_onboarding_step_viewed', { step: 'computer', direction: 'forward' });
  }, [status?.available]);

  const missing = status?.appControlAvailable
    ? computerPermissions.find(([key]) => !status.permissions[key])?.[0]
    : undefined;

  async function next() {
    if (!status) return refresh();
    if (missing) {
      setRequested(missing);
      return allow(missing);
    }
    if ((await setEnabled(true))?.enabled) onReady();
  }

  return (
    <OnboardingFrame step="computer" steps={steps}>
      <section
        className="ob-step ob-computer"
        aria-label="Let nod help on your Mac"
        data-analytics-public
      >
        {status?.available ? (
          <Messages
            revealed={revealed}
            typing={typing}
            items={[
              <Bubble>
                <p>
                  {status.appControlAvailable
                    ? 'I can work with your files, run commands and use your Mac apps.'
                    : 'I can organize files and run commands on your Mac.'}
                </p>
              </Bubble>,
              <div className="ob-computer-access">
                {status.appControlAvailable ? (
                  <>
                    <ComputerPermissions status={status} busy={busy} />
                    {missing && requested === missing && (
                      <div className="ob-computer-guide" aria-live="polite">
                        {checking ? (
                          <p role="status">Checking permissions…</p>
                        ) : (
                          <p>
                            In System Settings, allow the app shown in the macOS prompt, then return
                            here.
                          </p>
                        )}
                        {missing === 'screen' && (
                          <p className="ob-computer-detail">
                            If macOS asks you to quit, reopen this app. Your progress is saved.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p>Mac app control isn't available here. Continue enables files and commands.</p>
                )}
                <p className="ob-computer-disclosure">
                  What I read or see goes to your selected model.
                </p>
              </div>,
            ]}
          />
        ) : (
          <Messages items={[]} typing={!error} />
        )}
        {error && <Notice>{error}</Notice>}
        <Footer
          show={Boolean(error) || (Boolean(status?.available) && revealed >= sequence.length)}
          busy={busy}
          onSkip={onReady}
          skipLabel="Not now"
          nextLabel={
            !status
              ? 'Try again'
              : missing === 'accessibility'
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
