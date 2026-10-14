import { useEffect, useId, useState } from 'react';
import type { StepProps } from '..';
import { Switch } from '../../../components/ui';
import { errorMessage, post } from '../../../lib/api';
import { Bubble, Footer, Messages, OttoGlyph, useReveal, type GlyphReaction } from '../motion';

const sequence = [
  { typing: 450 },
  { wait: 300, typing: 550 },
  { wait: 300, typing: 600 },
  { wait: 300 },
];

export function OpenSource({ arrived, onNext, onBack, busy, usage }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [reaction, setReaction] = useState<GlyphReaction | null>(null);
  const id = useId();
  const enabled = saving ?? usage?.enabled ?? false;
  useEffect(() => {
    void post('/api/onboarding/suggestions').catch(() => {});
  }, []);

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
            One last thing: I’m <strong>open source</strong>. A small team builds me in the open,
            and your feedback shapes what I become.
          </Bubble>,
          <Bubble>
            If something breaks or you have an idea, send us feedback. There’s a button for it in
            the app. A screenshot helps a lot, and we read every message.
          </Bubble>,
          <Bubble className="ob-open-usage">
            <p id={`${id}-usage-data`}>
              Share usage insights with the Otto team at n8n. Your model derives them from chats;
              messages, files and keys are not sent to PostHog.
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
