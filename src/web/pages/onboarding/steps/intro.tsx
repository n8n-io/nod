import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { NodGlyph, Rise, type GlyphReaction } from '../../../components/motion';
import { Button } from '../../../components/ui';
import type { StepProps } from '..';
import { errorMessage } from '../../../lib/api';
import { posthogConfig } from '../../../../shared/analytics';
import { Bubble, Messages, PreferenceBubble, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [
  { wait: 40 },
  { wait: 60 },
  { wait: 600 },
  { wait: 450, typing: 400 },
  { wait: 120, typing: 300 },
  { wait: 120, typing: 250 },
  { wait: 120, typing: 300 },
  { wait: 160 },
];

export function Introduction({
  arrived,
  onNext,
  usage,
  continuing = false,
}: StepProps & { continuing?: boolean }) {
  const [saving, setSaving] = useState<boolean | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const [error, setError] = useState('');
  const [reaction, setReaction] = useState<GlyphReaction | null>(null);
  const enabled = saving ?? usage?.enabled ?? false;
  const section = useRef<HTMLElement>(null);
  const slot = useRef<HTMLSpanElement>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const {
    revealed: stage,
    typing,
    played,
    done,
    replay,
    skip,
  } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const surface =
        event.target === document.body || event.target === document.querySelector('.ob-main');
      if (event.key !== 'Enter' || !surface || event.repeat) return;
      if (done) void next();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [done, onNext, continuing]);
  async function change(value: boolean) {
    if (!usage || saving !== null) return;
    setSaving(value);
    setError('');
    setReaction((current) => ({ kind: value ? 'on' : 'off', count: (current?.count ?? 0) + 1 }));
    const save = usage.onChange(value).then(
      () => true,
      (cause) => {
        setError(errorMessage(cause));
        return false;
      },
    );
    pending.current = save;
    await save;
    pending.current = null;
    setSaving(null);
  }
  async function next() {
    if (continuing) return;
    if (pending.current && !(await pending.current)) return;
    onNext();
  }
  useLayoutEffect(() => {
    if (stage !== 1 || !section.current || !slot.current) return;
    const area = section.current.getBoundingClientRect();
    const target = slot.current.getBoundingClientRect();
    const scale = area.width / (section.current.offsetWidth || area.width) || 1;
    setOffset({
      dx: Math.round((area.left + area.width / 2 - target.left - target.width / 2) / scale),
      dy: Math.round((area.top + area.height / 2 - target.top - target.height / 2) / scale),
    });
  }, [stage]);
  const away = `translate(${offset.dx}px, ${offset.dy}px)`;
  const avatar: CSSProperties =
    stage === 0
      ? { opacity: 0, transition: 'none' }
      : stage === 1
        ? { opacity: 0, transform: `${away} scale(1.8)`, transition: 'none' }
        : stage === 2
          ? {
              transform: `${away} scale(3)`,
              transition: 'transform 640ms var(--ease-pop), opacity 300ms ease-out',
            }
          : {
              transform: 'translate(0, 0) scale(1)',
              transition: 'transform 500ms var(--ease-travel)',
            };
  return (
    <section
      ref={section}
      className={`ob-step ob-introduction${stage === 0 ? ' ob-introduction-reset' : ''}`}
      data-analytics-public
      onClick={done ? undefined : skip}
    >
      <Messages
        revealed={Math.max(0, stage - 3)}
        typing={typing}
        avatar={
          <span ref={slot} className="ob-avatar ob-introduction-slot">
            <button
              type="button"
              className="ob-introduction-avatar"
              style={avatar}
              title="Say hi again"
              aria-label="Say hi again"
              disabled={continuing}
              onClick={(event) => {
                event.stopPropagation();
                replay();
              }}
            >
              <NodGlyph
                mode={continuing ? 'bounce' : typing ? 'thinking' : 'idle'}
                reaction={reaction}
              />
            </button>
          </span>
        }
        items={[
          <Bubble>
            <span className="ob-greeting-title">
              <span
                className={`ob-wave-hand${played && stage >= 4 ? ' waving' : ''}`}
                aria-hidden="true"
              >
                👋
              </span>
              Hey, I’m nod.
            </span>
            <span className="ob-greeting-sub">
              Your personal assistant for <strong>work and life</strong>.
            </span>
          </Bubble>,
          <Bubble>
            I run on <strong>your computer</strong> and work in{' '}
            <strong>the apps you already use</strong>. Let’s get to know each other a bit first, so
            I can really help.
          </Bubble>,
          <Bubble>
            I’m <strong>built to check with you before I send, post or delete</strong> anything you
            didn’t ask for.
          </Bubble>,
          ...(usage
            ? [
                <PreferenceBubble
                  label="Share usage data"
                  link={
                    <a href={posthogConfig.docsUrl} target="_blank" rel="noreferrer">
                      What’s shared
                    </a>
                  }
                  checked={enabled}
                  saving={saving !== null}
                  disabled={continuing}
                  error={error}
                  onChange={(value) => void change(value)}
                >
                  Help us make nod better by sharing how you use it. Never your messages.
                </PreferenceBubble>,
              ]
            : []),
        ]}
      />
      <Rise show={done} className="ob-introduction-cta">
        <Button
          className="ob-next"
          disabled={continuing}
          aria-busy={continuing}
          onClick={() => void next()}
        >
          {continuing ? 'Opening…' : 'Let’s go'}
        </Button>
        <p className="ob-introduction-reassurance">
          You can change your choices later in Settings.
        </p>
      </Rise>
    </section>
  );
}
