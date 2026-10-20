import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { OttoGlyph, Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import type { StepProps } from '..';
import { Bubble, Messages, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [
  { wait: 40 },
  { wait: 60 },
  { wait: 600 },
  { wait: 450, typing: 400 },
  { wait: 120, typing: 300 },
  { wait: 120, typing: 250 },
  { wait: 160 },
];

export function Welcome({ arrived, onNext, onSkip }: StepProps) {
  const section = useRef<HTMLElement>(null);
  const slot = useRef<HTMLSpanElement>(null);
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const {
    revealed: stage,
    typing,
    played,
    done,
    replay,
    skip: skipReveal,
  } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  const skip = () => {
    onSkip?.();
    skipReveal();
  };
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.target !== document.body || event.repeat) return;
      if (done) onNext();
      else skip();
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [done]);
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
              transition: 'transform 760ms var(--ease-travel)',
            };
  return (
    <section
      ref={section}
      className={`ob-step ob-welcome${stage === 0 ? ' ob-welcome-reset' : ''}`}
      data-analytics-public
      onClick={done ? undefined : skip}
    >
      <Messages
        revealed={Math.max(0, stage - 3)}
        typing={typing}
        avatar={
          <span ref={slot} className="ob-avatar ob-welcome-slot">
            <button
              type="button"
              className="ob-welcome-avatar"
              style={avatar}
              title="Say hi again"
              aria-label="Say hi again"
              onClick={(event) => {
                event.stopPropagation();
                replay();
              }}
            >
              <OttoGlyph mode={typing ? 'thinking' : 'idle'} />
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
              Hey, I’m Otto.
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
            I <strong>check with you before I send, post or delete</strong> anything you didn’t ask
            for.
          </Bubble>,
        ]}
      />
      <Rise show={stage >= 7} className="ob-welcome-cta">
        <Button className="ob-next" onClick={onNext}>
          Let’s go
        </Button>
      </Rise>
    </section>
  );
}
