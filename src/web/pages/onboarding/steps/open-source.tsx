import { useEffect, useId, useRef, useState } from 'react';
import type { StepProps } from '..';
import { OttoGlyph, type GlyphReaction } from '../../../components/motion';
import { Switch } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { Bubble, Footer, Messages, useReveal } from '../motion';
import { prepareSuggestions } from '../storage';
import { posthogConfig } from '../../../../shared/analytics';

const sequence = [
  { typing: 450 },
  { wait: 300, typing: 550 },
  { wait: 300, typing: 600 },
  { wait: 300 },
];

export function OpenSource({ arrived, onNext, onBack, busy, notice, usage }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [reaction, setReaction] = useState<GlyphReaction | null>(null);
  const id = useId();
  const noticeBox = useRef<HTMLDivElement>(null);
  const enabled = saving ?? usage?.enabled ?? false;
  const noticed = !!notice;
  useEffect(() => void prepareSuggestions(true), []);
  useEffect(() => {
    if (noticed) noticeBox.current?.scrollIntoView({ block: 'nearest' });
  }, [noticed]);

  async function change(value: boolean) {
    if (!usage || saving !== null) return;
    setSaving(value);
    setError('');
    setReaction((current) => ({ kind: value ? 'on' : 'off', count: (current?.count ?? 0) + 1 }));
    try {
      await usage.onChange(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="ob-step ob-open" data-analytics-public>
      <Messages
        revealed={revealed}
        typing={typing}
        avatar={
          <span className="ob-avatar">
            <OttoGlyph mode={typing ? 'thinking' : 'idle'} reaction={reaction} />
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
          <Bubble className="ob-open-usage">
            <p id={`${id}-usage-data`}>
              Sends the Otto team at n8n how you use Otto, the websites it visits, purchase amounts
              and task labels your model writes from your chats, never message content.{' '}
              <a href={posthogConfig.docsUrl} target="_blank" rel="noreferrer">
                What’s shared
              </a>
            </p>
            <div className="ob-open-toggle">
              <Switch
                id={id}
                checked={enabled}
                disabled={!usage || busy}
                aria-busy={saving !== null}
                aria-describedby={`${id}-usage-data`}
                onCheckedChange={(value) => void change(value)}
              />
              <label htmlFor={id}>Share usage data · you can change this in Settings</label>
            </div>
            {error && (
              <p className="ob-open-error" role="alert">
                {error}
              </p>
            )}
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
        nextDisabled={saving !== null}
        busy={busy}
      />
    </section>
  );
}
