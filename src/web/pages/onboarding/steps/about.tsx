import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp, Mic } from 'lucide-react';
import type { Connection } from '../../../../shared/contracts';
import {
  interviewAnswerChars,
  interviewQuestions,
  type InterviewMessage,
  type InterviewResponse,
} from '../../../../shared/onboarding';
import { OttoGlyph, prefersReducedMotion, Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, UserBubble, useReveal } from '../motion';
import { prepareSuggestions, readStep, readStored, writeStored } from '../storage';

type Talk = { answers: string[]; turns: string[][]; done: boolean };

const opening = ['I’d love to get to know you a little.', 'What are you working on these days?'];
const handOff = 'What’s one thing you’d love to take off your plate?';
const still = (
  <span className="ob-avatar">
    <OttoGlyph mode="still" />
  </span>
);
const owner = () => readStep<{ owner: string }>()?.owner;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function restore(): Talk {
  const saved = readStored<(Talk & { owner?: string }) | null>('about');
  const answers = Array.isArray(saved?.answers) ? saved.answers.slice(0, interviewQuestions) : [];
  const turns = Array.isArray(saved?.turns) ? saved.turns.slice(0, answers.length + 1) : [];
  if (saved?.owner !== owner() || turns.length < answers.length || !turns.every(Array.isArray))
    return { answers: [], turns: [], done: false };
  return { answers, turns, done: saved?.done === true && turns.length > answers.length };
}

export function About({ arrived, onNext }: StepProps) {
  const [{ answers, turns, done }, setTalk] = useState(restore);
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
  const input = useRef<HTMLInputElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const index = turns.length - 1;
  const thinking = turns.length === answers.length;

  useEffect(() => {
    writeStored('about', { owner: owner(), answers, turns, done });
  }, [answers, turns, done]);

  useEffect(() => {
    const count = answers.length;
    if (turns.length > count) return;
    const controller = new AbortController();
    const started = Date.now();
    const talk: InterviewMessage[] = turns.flatMap((said, at) => [
      ...said.map((text) => ({ from: 'otto' as const, text })),
      { from: 'owner' as const, text: answers[at] },
    ]);
    void api<InterviewResponse>('/api/onboarding/interview', {
      method: 'POST',
      body: JSON.stringify({ talk }),
      signal: controller.signal,
    })
      .catch((): InterviewResponse =>
        !count
          ? { messages: opening, done: false }
          : count < interviewQuestions && !turns.flat().includes(handOff)
            ? { messages: [handOff], done: false }
            : { messages: [], done: true },
      )
      .then(async (reply) => {
        await wait(Math.max(0, 700 - (Date.now() - started)));
        if (controller.signal.aborted) return;
        setTalk((current) =>
          current.answers.length === count
            ? {
                ...current,
                turns: [...current.turns.slice(0, count), reply.messages],
                done: reply.done,
              }
            : current,
        );
      });
    return () => controller.abort();
  }, [answers]);

  useEffect(() => {
    if (introDone && !thinking && !done) input.current?.focus({ preventScroll: true });
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
    if (!text || thinking || done) return;
    setDraft('');
    setShown(false);
    setWaited(true);
    stuck.current = true;
    setTalk({ answers: [...answers, text], turns, done });
  }

  function restart() {
    setError('');
    setShown(false);
    setFresh(true);
    setWaited(false);
    stuck.current = true;
    writeStored('suggestions', false);
    setTalk({ answers: [], turns: [], done: false });
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await api('/api/onboarding/interview', { method: 'PUT', body: JSON.stringify({ answers }) });
      void prepareSuggestions();
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  const said = (messages: string[], asking: boolean) =>
    messages.map((text, at) => (
      <Bubble
        className={asking && at === messages.length - 1 ? 'ob-about-question' : undefined}
        data-analytics-private
      >
        {text}
      </Bubble>
    ));
  const lines: ReactNode[] = thinking
    ? []
    : done
      ? [
          ...said(turns[index], false),
          <Bubble>
            {gmail && 'I’ll look through your inbox for things I can take off your plate. '}
            Next, let’s set up <strong>Telegram</strong> so you can reach me from anywhere.
          </Bubble>,
        ]
      : said(turns[index], true);

  return (
    <section className="ob-step" data-analytics-public>
      <div className="ob-about-chat" ref={chat} onScroll={scrolled}>
        <div className="ob-about-log" ref={log}>
          {answers.map((answer, at) => (
            <Fragment key={at}>
              <Messages items={said(turns[at], true)} avatar={still} />
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
      {!done && (
        <Rise show={introDone} className="ob-about-compose">
          <form className="composer ob-composer" onSubmit={submit}>
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoComplete="off"
              maxLength={interviewAnswerChars}
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
        </Rise>
      )}
      {done ? (
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
