import { useState } from 'react';
import { DataSharing } from '../../../components/data-sharing';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

export function Privacy({ arrived, onNext, onBack, nextLabel, traces, usageShared }: StepProps) {
  const items = [
    ...(traces
      ? [
          <Bubble>Will you help the Nod team make me better?</Bubble>,
          <Bubble>
            I can send our conversations, including what I read and do, to the Nod team at n8n so
            they can see where I go wrong. I remove the personal details I can recognize first. Kept
            14 days, never used to train AI.
          </Bubble>,
        ]
      : [<Bubble>Conversation traces aren’t available in this version of Nod.</Bubble>]),
    ...(usageShared
      ? [
          <Bubble>
            {traces ? 'I also share' : 'I share'} basic usage data, including your fixed About you
            choices and the screens you open, but never your messages or screen recordings. You can
            turn it off in Settings.
          </Bubble>,
        ]
      : []),
  ];
  const sequence: RevealStep[] = [
    { typing: 450 },
    ...items.slice(1).map(() => ({ wait: 200 })),
    { wait: 200 },
  ];
  const { revealed, typing, done, skip } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  async function choose(value: boolean) {
    if (!traces || saving !== null) return;
    setSaving(value);
    setError('');
    try {
      await traces.onChange(value);
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(null);
    }
  }
  return (
    <section className="ob-step ob-privacy" onClick={done ? undefined : skip}>
      <Messages revealed={revealed} typing={typing} items={items} />
      <Rise show={done} className="ob-choices">
        <DataSharing
          className="ob-link ob-data-sharing"
          usage={Boolean(usageShared)}
          traces={traces?.enabled}
        />
        {traces ? (
          <>
            <Button
              variant="secondary"
              disabled={saving !== null}
              aria-busy={saving === false}
              onClick={() => void choose(false)}
            >
              Not now
            </Button>
            <Button
              disabled={saving !== null}
              aria-busy={saving === true}
              onClick={() => void choose(true)}
            >
              Share traces
            </Button>
          </>
        ) : (
          <Button onClick={onNext}>{nextLabel ?? 'Continue'}</Button>
        )}
        {error && (
          <p className="ob-choices-error" role="alert" data-analytics-private>
            {error}
          </p>
        )}
      </Rise>
      <Footer onBack={onBack} busy={saving !== null} />
    </section>
  );
}
