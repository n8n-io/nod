import { useState } from 'react';
import { Button } from '../../../components/ui';
import { captureAnalytics } from '../../../lib/analytics';
import type { StepProps } from '..';
import { Bubble, Footer, Messages } from '../motion';

export function Community({ onNext, onBack, onSkip, nextLabel }: StepProps) {
  const [opened, setOpened] = useState(false);
  return (
    <section className="ob-step" data-analytics-public>
      <Messages
        items={[
          <Bubble>Help shape Nod.</Bubble>,
          <Bubble>
            Share what works, ask questions, or tell us what's missing in the n8n Labs community.
          </Bubble>,
        ]}
      />
      <div className="ob-choices">
        <Button variant="outline" asChild>
          <a
            href="https://community.n8n.io/c/n8n-labs/48"
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              setOpened(true);
              captureAnalytics('nod_community_opened', { destination: 'forum' });
            }}
          >
            Join the discussion
          </a>
        </Button>
        <Button
          onClick={() => {
            if (!opened) onSkip?.();
            onNext();
          }}
        >
          {nextLabel ?? 'Continue'}
        </Button>
      </div>
      <Footer onBack={onBack} />
    </section>
  );
}
