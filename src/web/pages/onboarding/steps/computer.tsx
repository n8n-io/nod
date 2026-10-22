import { useEffect, useRef, type ReactNode } from 'react';
import { OnboardingFrame, type DisplayStep } from '../frame';
import { Button, Notice } from '../../../components/ui';
import {
  ComputerPermissions,
  computerPermissions,
  useComputer,
} from '../../../components/your-computer';
import { captureAnalytics } from '../../../lib/analytics';
import { Bubble, Footer, Messages, useReveal } from '../motion';

const sequence = [{ typing: 550 }];

export function ComputerSetup({
  steps,
  onReady,
  notice,
}: {
  steps: readonly DisplayStep[];
  onReady(): void;
  notice?: ReactNode;
}) {
  const { status, error, busy, requesting, requested, checking, allow, setEnabled, refresh } =
    useComputer();
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
    if (!status || status.permissionError || missing) return;
    const value = await setEnabled(true);
    if (value?.enabled && !value.permissionError) onReady();
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
                    ? 'I can help with files and Mac apps.'
                    : 'I can help with files and commands.'}
                </p>
                <div className="ob-computer-access">
                  {status.appControlAvailable ? (
                    <ComputerPermissions
                      status={status}
                      busy={busy || checking}
                      requesting={requesting}
                      requested={requested}
                      checking={checking}
                      onAllow={(key) => void allow(key)}
                    />
                  ) : (
                    <p>
                      Continue enables files and commands. Mac app control isn't available here.
                    </p>
                  )}
                  <p className="ob-computer-disclosure">What I read or see goes to your model.</p>
                </div>
              </Bubble>,
            ]}
          />
        ) : (
          <Messages items={[]} typing={!error} />
        )}
        {error && (
          <Notice>
            {error}
            {(!status || status.permissionError) && (
              <Button variant="ghost" disabled={busy || checking} onClick={() => void refresh()}>
                Try again
              </Button>
            )}
          </Notice>
        )}
        <Footer
          show={Boolean(error) || (Boolean(status?.available) && revealed >= sequence.length)}
          busy={busy && !requesting}
          onSkip={onReady}
          skipLabel="Not now"
          nextDisabled={
            !status || Boolean(status.permissionError) || Boolean(missing) || checking || busy
          }
          onNext={() => void next()}
        />
      </section>
      {notice}
    </OnboardingFrame>
  );
}
