import { useNotificationChoice } from '../../../components/browser-notifications';
import { useDesktopSettings } from '../../../components/desktop-settings';
import { Ellipsis, X } from '../../../components/icons';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { desktopSettingsAvailable } from '../../../lib/desktop';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

type Choice = {
  on: boolean;
  retry?: boolean;
  tab?: boolean;
  busy: boolean;
  error: string;
  enable(): Promise<unknown>;
  dismiss(): void;
};

const sequence: RevealStep[] = [{ typing: 450 }, { wait: 200 }];
const sample = 'Your morning brief is ready: 3 calls today, the first at 9:30 with Maya.';

function SampleBanner() {
  if (/Win/.test(navigator.platform))
    return (
      <div className="ob-notify-banner" data-platform="windows" aria-hidden="true">
        <span className="ob-notify-app">
          <img src="/nod-logo.png" alt="" />
          <span>Nod</span>
          <Ellipsis size={14} />
          <X size={14} />
        </span>
        <span className="ob-notify-content">
          <img src="/nod-logo.png" alt="" />
          <span className="ob-notify-text">
            <strong>Nod</strong>
            <span>{sample}</span>
          </span>
        </span>
      </div>
    );
  return (
    <div className="ob-notify-banner" aria-hidden="true">
      <img src="/nod-logo.png" alt="" />
      <div className="ob-notify-text">
        <span className="ob-notify-head">
          <strong>Nod</strong>
          <span>now</span>
        </span>
        <span>{sample}</span>
      </div>
    </div>
  );
}

export function Notifications(props: StepProps) {
  return desktopSettingsAvailable() ? (
    <DesktopNotifications {...props} />
  ) : (
    <BrowserNotifications {...props} />
  );
}

function DesktopNotifications(props: StepProps) {
  const native = useDesktopSettings();
  return (
    <NotificationsStep
      {...props}
      choice={{
        on: Boolean(native.settings?.notifications),
        retry: !native.settings,
        busy: native.busy || native.loading,
        error: native.error,
        enable: () =>
          native.settings ? native.save({ notifications: true }).catch(() => {}) : native.refresh(),
        dismiss() {},
      }}
    />
  );
}

function BrowserNotifications(props: StepProps) {
  const browser = useNotificationChoice(props.ownerId);
  return (
    <NotificationsStep
      {...props}
      choice={{
        on: browser.enabled,
        tab: true,
        busy: browser.busy,
        error: browser.error,
        enable: () => browser.change(true),
        dismiss: browser.dismiss,
      }}
    />
  );
}

function NotificationsStep({
  arrived,
  onNext,
  onBack,
  onSkip,
  choice,
}: StepProps & { choice: Choice }) {
  const { revealed, typing, done, skip } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  return (
    <section className="ob-step ob-notifications" onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>
            I keep working when you step away, on longer tasks and the jobs you schedule. Can I let
            you know when something’s ready?
          </Bubble>,
        ]}
      />
      <Rise show={done} className="ob-notify">
        <SampleBanner />
      </Rise>
      <Rise show={done} className="ob-choices">
        {choice.on ? (
          <Button autoFocus onClick={onNext}>
            Continue
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={choice.busy}
              onClick={() => {
                choice.dismiss();
                onSkip?.();
                onNext();
              }}
            >
              Not now
            </Button>
            <Button
              disabled={choice.busy}
              aria-busy={choice.busy}
              onClick={() => void choice.enable()}
            >
              {choice.retry ? 'Try again' : 'Turn on notifications'}
            </Button>
          </>
        )}
        {choice.error ? (
          <p className="ob-choices-error" role="alert" data-analytics-private>
            {choice.error}
          </p>
        ) : (
          <p className="ob-notify-note">
            {choice.on ? 'Notifications are on.' : 'No sound.'}
            {choice.tab && ' Keep this tab open.'} Change it anytime in Settings.
          </p>
        )}
      </Rise>
      <Footer onBack={onBack} busy={choice.busy} />
    </section>
  );
}
