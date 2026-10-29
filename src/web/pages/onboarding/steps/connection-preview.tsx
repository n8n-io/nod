import { onboardingEmailProviders } from '../../../../shared/onboarding';
import { ConnectRow } from '../../../components/connect-row';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { Bubble, Messages, useReveal, type RevealStep } from '../motion';

export const connectionSequence: RevealStep[] = [{ typing: 500 }, { wait: 200 }, { wait: 200 }];

export const emailCopy = {
  introduction:
    'I’m here to take things off your plate. Connect your email and I’ll look through your recent messages to suggest a few tasks I can handle for you.',
  action: 'Connect via Composio',
  note: 'Google or Microsoft will ask you to allow Composio, the service Nod uses to connect your apps.',
};

const names = { gmail: 'Gmail', outlook: 'Outlook' };

export function ComposioMark({ src = '/logos/composio.svg' }: { src?: string }) {
  return (
    <span
      className="ob-composio"
      aria-hidden="true"
      style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` }}
    />
  );
}

export function EmailPreview({ logos }: { logos: Record<string, string> }) {
  const { revealed, typing } = useReveal(connectionSequence);
  return (
    <section className="ob-step ob-email" data-analytics-public aria-busy="true">
      <Messages
        revealed={revealed}
        typing={typing}
        items={[<Bubble>{emailCopy.introduction}</Bubble>]}
      />
      <Rise show={revealed >= 2} className="ob-personal-choices">
        <div className="connect-rows">
          {onboardingEmailProviders.map((slug) => (
            <ConnectRow
              key={slug}
              data-provider={slug}
              logo={
                <img className="service-logo" src={logos[slug]} alt="" width={28} height={28} />
              }
              name={names[slug]}
              details={['Getting ready…']}
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled
                  aria-label={`Connect ${names[slug]} via Composio`}
                >
                  <ComposioMark src={logos.composio} />
                  {emailCopy.action}
                </Button>
              }
            />
          ))}
        </div>
        <p className="ob-personal-muted">{emailCopy.note}</p>
      </Rise>
    </section>
  );
}
