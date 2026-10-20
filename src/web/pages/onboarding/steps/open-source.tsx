import { useEffect, useRef } from 'react';
import type { StepProps } from '..';
import { OttoGlyph } from '../../../components/motion';
import { Bubble, Footer, Messages, useReveal } from '../motion';
import { prepareSuggestions } from '../storage';

const sequence = [{ typing: 450 }, { wait: 300, typing: 550 }, { wait: 300 }];

export function OpenSource({ arrived, onNext, onBack, busy, notice }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const noticeBox = useRef<HTMLDivElement>(null);
  const noticed = !!notice;
  useEffect(() => void prepareSuggestions(true), []);
  useEffect(() => {
    if (noticed) noticeBox.current?.scrollIntoView({ block: 'nearest' });
  }, [noticed]);

  return (
    <section className="ob-step ob-open" data-analytics-public>
      <Messages
        revealed={revealed}
        typing={typing}
        avatar={
          <span className="ob-avatar">
            <OttoGlyph mode={typing ? 'thinking' : 'idle'} />
          </span>
        }
        items={[
          <Bubble>
            One last thing: I’m <strong>open source</strong>. n8n Labs is building me in the open,
            and your feedback shapes what I become.
          </Bubble>,
          <Bubble>
            If something breaks or you have an idea, send us feedback. There’s a button for it in
            the app. A screenshot helps a lot, and we read every message.
          </Bubble>,
        ]}
      />
      {notice && (
        <div className="ob-notice" ref={noticeBox}>
          {notice}
        </div>
      )}
      <Footer
        show={revealed >= sequence.length}
        onBack={onBack}
        onNext={onNext}
        nextLabel={busy ? 'Opening Otto…' : 'Start chatting'}
        busy={busy}
      />
    </section>
  );
}
