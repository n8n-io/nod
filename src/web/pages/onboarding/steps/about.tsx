import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Mic } from 'lucide-react';
import type { Connection } from '../../../../shared/contracts';
import {
  interviewAnswerChars,
  interviewLabels,
  lastQuestion,
  type InterviewResponse,
  type InterviewSave,
  type OnboardingInterview,
} from '../../../../shared/onboarding';
import { OttoGlyph, prefersReducedMotion, Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, UserBubble, useReveal } from '../motion';
import { prepareSuggestions, readStep, readStored, writeStored } from '../storage';

type Turn = { ack: string[]; question: string };
type Talk = OnboardingInterview;

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

export function About({ arrived, onNext, onBack, interview }: StepProps) {
  const [{ answers, turns }, setTalk] = useState(() =>
    interview ? (interview.state ?? { answers: [], turns: [first] }) : restore(),
  );
  const { data: apps } = usePageData<Connection[]>('/api/apps');
  const gmail = apps?.some((app) => app.slug === 'gmail' && app.status === 'connected');
  const [draft, setDraft] = useState('');
  const [fresh, setFresh] = useState(arrived === 'forward');
  const [introDone, setIntroDone] = useState(
    () => answers.length > 0 || arrived !== 'forward' || prefersReducedMotion(),
  );
  const [shown, setShown] = useState(false);
  const [waited, setWaited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const pendingTurn = useRef<{ count: number; turn: Turn } | null>(null);
  const savingAnswer = useRef(false);
  const index = turns.length - 1;
  const thinking = turns.length === answers.length;
  const wrapped = turns.length === 4;

  useEffect(() => {
    if (!interview) writeStored('about', { owner: owner(), answers, turns: turns.slice(1) });
  }, [answers, turns]);

  useEffect(() => {
    const count = answers.length;
    if (!count || turns.length > count) return;
    const controller = new AbortController();
    const started = Date.now();
    const next: Promise<Turn> =
      pendingTurn.current?.count === count
        ? Promise.resolve(pendingTurn.current.turn)
        : count === 3
          ? wait(1000).then(() => wrapUp)
          : api<InterviewResponse>('/api/onboarding/interview', {
              method: 'POST',
              body: JSON.stringify({ answers }),
              signal: controller.signal,
            })
              .then((reply) => ({ ack: reply.ack ? [reply.ack] : [], question: reply.question }))
              .catch((cause) => {
                if (interview) throw cause;
                return scripted[count];
              });
    void next
      .then(async (turn) => {
        await wait(Math.max(0, 700 - (Date.now() - started)));
        if (controller.signal.aborted) return;
        pendingTurn.current = { count, turn };
        const talk = { answers, turns: [...turns.slice(0, count), turn] };
        await interview?.save(talk);
        if (controller.signal.aborted) return;
        pendingTurn.current = null;
        setTalk((current) => (current.answers.length === count ? talk : current));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [answers, retry]);

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thinking || wrapped || savingAnswer.current) return;
    savingAnswer.current = true;
    setSaving(true);
    setError('');
    const talk = { answers: [...answers, text], turns };
    try {
      await interview?.save(talk);
      setDraft('');
      setShown(false);
      setWaited(true);
      stuck.current = true;
      setTalk(talk);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      savingAnswer.current = false;
      setSaving(false);
    }
  }

  async function restart() {
    if (savingAnswer.current) return;
    savingAnswer.current = true;
    setSaving(true);
    setError('');
    try {
      const talk = { answers: [], turns: [first] };
      await interview?.save(talk);
      setShown(false);
      setFresh(true);
      setWaited(false);
      stuck.current = true;
      pendingTurn.current = null;
      writeStored('suggestions', false);
      setTalk(talk);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      savingAnswer.current = false;
      setSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body: InterviewSave = { answers: answers as InterviewSave['answers'] };
      await api('/api/onboarding/interview', { method: 'PUT', body: JSON.stringify(body) });
      void prepareSuggestions();
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const said = (turn: Turn, at: number) => [
    ...turn.ack.map((text) => (
      <Bubble data-analytics-private={!!interview || at > 0 || undefined}>{text}</Bubble>
    )),
    <Bubble
      className="ob-about-question"
      data-analytics-private={!!interview || at > 0 || undefined}
    >
      {turn.question}
    </Bubble>,
  ];
  const lines: ReactNode[] = wrapped
    ? [
        <Bubble>
          Thanks, that helps. Here’s what I’ve got so far:
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
          {gmail
            ? 'I’ll keep this in mind and look through your inbox for things I can take off your plate.'
            : 'I’ll keep this in mind.'}{' '}
          Next, let’s set up <strong>Telegram</strong> so you can reach me from anywhere.
        </Bubble>,
      ]
    : said(turns[index], index);

  return (
    <section className="ob-step" data-analytics-public>
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
          <form className="composer ob-composer" onSubmit={(event) => void submit(event)}>
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoComplete="off"
              maxLength={interviewAnswerChars}
              disabled={saving}
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
                disabled={!draft.trim() || thinking || saving}
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
          onBack={() => void restart()}
          backLabel="Change my answers"
          onNext={() => void save()}
          busy={saving}
        />
      ) : (
        !interview && arrived === 'back' && !answers.length && <Footer onNext={onNext} />
      )}
      {error && (
        <p className="ob-about-error" role="alert" data-analytics-private>
          {error}
          {thinking && interview && (
            <>
              <Button variant="ghost" disabled={saving} onClick={onBack}>
                Back
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setError('');
                  setRetry((value) => value + 1);
                }}
              >
                Try again
              </Button>
            </>
          )}
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
