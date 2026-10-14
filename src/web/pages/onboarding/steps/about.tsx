import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Mic } from 'lucide-react';
import { Button } from '../../../components/ui';
import type { StepProps } from '..';
import {
  interviewLabels,
  lastQuestion,
  type InterviewResponse,
  type InterviewSave,
} from '../../../../shared/onboarding';
import { api, errorMessage } from '../../../lib/api';
import {
  Bubble,
  Footer,
  Messages,
  OttoGlyph,
  prefersReducedMotion,
  Rise,
  UserBubble,
  useReveal,
} from '../motion';
import { readStep, readStored, writeStored } from '../storage';

type Turn = { ack: string[]; question: string };
type Talk = { answers: string[]; turns: Turn[] };

const first: Turn = {
  ack: [
    'I’d love to get to know you a little, so I’ve got three quick questions.',
    'I can help you launch a side project, grow your business, or take the busywork off your hands.',
  ],
  question: 'What are you working on these days? What’s your story?',
};
const scripted: Turn[] = [
  first,
  {
    ack: ['Sounds cool!'],
    question: 'What are you aiming for with it? A launch, a milestone, a first group of users?',
  },
  { ack: ['Love it, that’s a good one to chase.'], question: lastQuestion },
];
const still = (
  <span className="ob-avatar">
    <OttoGlyph mode="still" />
  </span>
);
const wrapUp: Turn = { ack: [], question: '' };
const owner = () => readStep<{ owner: string }>()?.owner;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function restore(): Talk {
  const saved = readStored<(Talk & { owner?: string }) | null>('about');
  if (
    !saved ||
    saved.owner !== owner() ||
    !Array.isArray(saved.answers) ||
    !Array.isArray(saved.turns)
  )
    return { answers: [], turns: [first] };
  const answers = saved.answers.slice(0, 3);
  return { answers, turns: [first, ...saved.turns.slice(0, answers.length)] };
}

export function About({ arrived, onNext }: StepProps) {
  const [{ answers, turns }, setTalk] = useState(restore);
  const [draft, setDraft] = useState('');
  const [fresh, setFresh] = useState(arrived === 'forward');
  const [introDone, setIntroDone] = useState(
    () => answers.length > 0 || arrived !== 'forward' || prefersReducedMotion(),
  );
  const [shown, setShown] = useState(false);
  const [waited, setWaited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const index = turns.length - 1;
  const thinking = turns.length === answers.length;
  const wrapped = turns.length === 4;

  useEffect(() => {
    writeStored('about', { owner: owner(), answers, turns: turns.slice(1) });
  }, [answers, turns]);

  useEffect(() => {
    const count = answers.length;
    if (!count || turns.length > count) return;
    const controller = new AbortController();
    const started = Date.now();
    const next: Promise<Turn> =
      count === 3
        ? wait(1000).then(() => wrapUp)
        : api<InterviewResponse>('/api/onboarding/interview', {
            method: 'POST',
            body: JSON.stringify({ answers }),
            signal: controller.signal,
          })
            .then((reply) => ({ ack: reply.ack ? [reply.ack] : [], question: reply.question }))
            .catch(() => scripted[count]);
    void next.then(async (turn) => {
      await wait(Math.max(0, 700 - (Date.now() - started)));
      if (controller.signal.aborted) return;
      setTalk((talk) =>
        talk.answers.length === count
          ? { ...talk, turns: [...talk.turns.slice(0, count), turn] }
          : talk,
      );
    });
    return () => controller.abort();
  }, [answers]);

  useEffect(() => {
    if (introDone && !thinking && !wrapped) input.current?.focus({ preventScroll: true });
  }, [introDone, index]);

  useEffect(() => {
    const box = chat.current;
    if (!box || !log.current) return;
    const follow = () => {
      if (stuck.current) box.scrollTop = box.scrollHeight;
      box.dataset.top = String(box.scrollTop < 1);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(log.current);
    follow();
    return () => observer.disconnect();
  }, []);

  function scrolled() {
    const box = chat.current;
    if (!box) return;
    stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
    box.dataset.top = String(box.scrollTop < 1);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thinking || wrapped) return;
    setDraft('');
    setShown(false);
    setWaited(true);
    stuck.current = true;
    setTalk({ answers: [...answers, text], turns });
  }

  function restart() {
    setError('');
    setShown(false);
    setFresh(true);
    setWaited(false);
    stuck.current = true;
    setTalk({ answers: [], turns: [first] });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body: InterviewSave = { answers: answers as InterviewSave['answers'] };
      await api('/api/onboarding/interview', { method: 'PUT', body: JSON.stringify(body) });
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  const said = (turn: Turn, at: number) => [
    ...turn.ack.map((text) => <Bubble data-analytics-private={at > 0 || undefined}>{text}</Bubble>),
    <Bubble className="ob-about-question" data-analytics-private={at > 0 || undefined}>
      {turn.question}
    </Bubble>,
  ];
  const lines: ReactNode[] = wrapped
    ? [
        <Bubble>It’s great to meet you.</Bubble>,
        <Bubble>
          This is what I’ve learned about you so far:
          <span className="ob-about-summary" data-analytics-private>
            {interviewLabels.map((label, at) => (
              <span key={label}>
                <span>{label}</span>
                <strong>{answers[at]}</strong>
              </span>
            ))}
          </span>
        </Bubble>,
        <Bubble>
          I’ll keep this in mind. Next, let’s connect your <strong>email</strong> so I can start
          helping.
        </Bubble>,
      ]
    : said(turns[index], index);

  return (
    <section className="ob-step ob-about" data-analytics-public>
      <div className="ob-about-chat" ref={chat} onScroll={scrolled}>
        <div className="ob-about-log" ref={log}>
          {answers.map((answer, at) => (
            <Fragment key={at}>
              <Messages items={said(turns[at], at)} avatar={still} />
              <div className="ob-about-sent" data-new={waited && at === answers.length - 1}>
                <div>
                  <UserBubble>{answer}</UserBubble>
                </div>
              </div>
            </Fragment>
          ))}
          {thinking ? (
            <Messages key="thinking" items={[]} typing />
          ) : (
            <Reveal
              key={`turn-${index}`}
              lines={lines}
              animate={fresh || index > 0}
              open={waited}
              onDone={() => {
                setIntroDone(true);
                setShown(true);
              }}
            />
          )}
        </div>
      </div>
      {!wrapped && (
        <Rise show={introDone} className="ob-about-compose">
          <form className="composer ob-composer" onSubmit={submit}>
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoComplete="off"
              maxLength={560}
              data-analytics-private
            />
            <div className="composer-tools">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                title="Voice input is coming soon"
                aria-label="Voice input is coming soon"
              >
                <Mic size={16} aria-hidden="true" />
              </Button>
              <Button
                type="submit"
                size="icon"
                className="send-button"
                aria-label="Send"
                disabled={!draft.trim() || thinking}
              >
                <ArrowUp size={18} aria-hidden="true" />
              </Button>
            </div>
          </form>
          <p className="ob-about-hint">
            Question {Math.min(turns.length, 3)} of 3 · type your answer
          </p>
        </Rise>
      )}
      {wrapped ? (
        <Footer
          show={shown}
          onBack={restart}
          backLabel="Change my answers"
          onNext={() => void save()}
          busy={saving}
        />
      ) : (
        arrived === 'back' && !answers.length && <Footer onNext={onNext} />
      )}
      {error && (
        <p className="ob-about-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Reveal({
  lines,
  animate,
  open,
  onDone,
}: {
  lines: ReactNode[];
  animate: boolean;
  open: boolean;
  onDone(): void;
}) {
  const { revealed, typing, done } = useReveal(
    [...lines.map((_, at) => (at ? { wait: 240, typing: 560 } : { typing: 560 })), { wait: 240 }],
    { enabled: animate, open },
  );
  useEffect(() => {
    if (done) onDone();
  }, [done]);
  return <Messages items={lines} revealed={revealed} typing={typing} />;
}
