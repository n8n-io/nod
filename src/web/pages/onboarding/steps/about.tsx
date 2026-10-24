import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowUp } from '../../../components/icons';
import type { Connection } from '../../../../shared/contracts';
import {
  interviewAnswerChars,
  interviewQuestions,
  type InterviewMessage,
  type InterviewResponse,
  type OnboardingInterview,
  type OnboardingInterviewState,
} from '../../../../shared/onboarding';
import { NodGlyph, prefersReducedMotion, Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, ApiError, errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, UserBubble, useReveal } from '../motion';
import { prepareSuggestions, readStep, readStored, removeStored, writeStored } from '../storage';

type Talk = Pick<OnboardingInterview, 'answers' | 'turns' | 'done'>;

const opening = ['I’d love to get to know you a little.', 'What are you working on these days?'];
const handOff = 'What’s one thing you’d love to take off your plate?';
const still = (
  <span className="ob-avatar">
    <NodGlyph mode="still" />
  </span>
);
const scope = () => readStep<{ owner: string; version: number }>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function restoreCompleted(generation: string): Talk | undefined {
  const saved = readStored<
    Talk & { owner?: string; version?: number; generation?: string; completed?: boolean }
  >('about');
  const current = scope();
  if (
    !current?.owner ||
    typeof current.version !== 'number' ||
    !saved ||
    !saved.completed ||
    saved.generation !== generation ||
    saved.owner !== current?.owner ||
    saved.version !== current?.version
  )
    return;
  const answers = Array.isArray(saved.answers) ? saved.answers.slice(0, interviewQuestions) : [];
  const turns = Array.isArray(saved.turns) ? saved.turns.slice(0, answers.length + 1) : [];
  if (
    !saved.done ||
    !answers.length ||
    turns.length <= answers.length ||
    !answers.every((answer) => typeof answer === 'string') ||
    !turns.every((turn) => Array.isArray(turn) && turn.every((text) => typeof text === 'string'))
  )
    return;
  return { answers, turns, done: true };
}

export function About({ arrived, onNext, onBack }: StepProps) {
  const [{ answers, turns, done }, setTalk] = useState<Talk>({
    answers: [],
    turns: [],
    done: false,
  });
  const [receipt, setReceipt] = useState({ generation: '', completed: false });
  const [resetVersion, setResetVersion] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [needsReload, setNeedsReload] = useState(false);
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
  const pendingTurn = useRef<{ count: number; reply: InterviewResponse } | null>(null);
  const savingAnswer = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const index = turns.length - 1;
  const thinking = !loaded || turns.length === answers.length;

  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setResetVersion('');
    void api<OnboardingInterviewState>('/api/onboarding/interview', { signal: controller.signal })
      .then((saved) => {
        if (controller.signal.aborted) return;
        if ('resetVersion' in saved) {
          setResetVersion(saved.resetVersion);
          setError(
            'Your saved interview couldn’t be opened. Try again, or discard these answers and start again.',
          );
          return;
        }
        const talk = saved.completed
          ? (restoreCompleted(saved.generation) ?? { answers: [], turns: [[]], done: true })
          : saved;
        if (!saved.completed) removeStored('about');
        setReceipt({ generation: saved.generation, completed: saved.completed });
        pendingTurn.current = null;
        setTalk(talk);
        if (talk.answers.length) setIntroDone(true);
        setNeedsReload(false);
        setError('');
        setLoaded(true);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    const count = answers.length;
    if (!loaded || turns.length > count) return;
    const controller = new AbortController();
    const started = Date.now();
    const talk: InterviewMessage[] = turns.flatMap((said, at) => [
      ...said.map((text) => ({ from: 'nod' as const, text })),
      { from: 'owner' as const, text: answers[at] },
    ]);
    const next =
      pendingTurn.current?.count === count
        ? Promise.resolve(pendingTurn.current.reply)
        : api<InterviewResponse>('/api/onboarding/interview', {
            method: 'POST',
            body: JSON.stringify({ generation: receipt.generation, talk }),
            signal: controller.signal,
          }).catch((cause): InterviewResponse => {
            if (!(cause instanceof ApiError) || cause.status !== 503) throw cause;
            return !count
              ? { messages: opening, done: false }
              : count < interviewQuestions && !turns.flat().includes(handOff)
                ? { messages: [handOff], done: false }
                : { messages: [], done: true };
          });
    void next
      .then(async (reply) => {
        await wait(Math.max(0, 700 - (Date.now() - started)));
        if (controller.signal.aborted) return;
        pendingTurn.current = { count, reply };
        const value = {
          answers,
          turns: [...turns.slice(0, count), reply.messages],
          done: reply.done,
        };
        if (controller.signal.aborted) return;
        pendingTurn.current = null;
        setTalk((current) => (current.answers.length === count ? value : current));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setNeedsReload(cause instanceof ApiError && cause.status === 409);
          if (cause instanceof ApiError && cause.status === 400 && count) {
            setDraft(answers[count - 1]);
            setTalk({ answers: answers.slice(0, -1), turns, done: false });
          }
          setError(errorMessage(cause));
        }
      });
    return () => controller.abort();
  }, [answers, loaded, retry, receipt.generation]);

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || thinking || done || savingAnswer.current) return;
    savingAnswer.current = true;
    setSaving(true);
    setError('');
    try {
      const talk = { answers: [...answers, text], turns, done };
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
      const talk = await api<OnboardingInterview>('/api/onboarding/interview', {
        method: 'DELETE',
        body: JSON.stringify(resetVersion ? { resetVersion } : { generation: receipt.generation }),
      });
      removeStored('about');
      setResetVersion('');
      setReceipt({ generation: talk.generation, completed: talk.completed });
      setShown(false);
      setFresh(true);
      setWaited(false);
      stuck.current = true;
      pendingTurn.current = null;
      writeStored('suggestions', false);
      setTalk(talk);
      setNeedsReload(false);
      setLoaded(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setResetVersion('');
      setNeedsReload(cause instanceof ApiError && cause.status === 409);
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
      if (receipt.completed) {
        const current = await api<OnboardingInterviewState>('/api/onboarding/interview');
        if (
          'resetVersion' in current ||
          !current.completed ||
          current.generation !== receipt.generation
        )
          throw new ApiError('Your setup answers changed. Reload them before continuing.', 409);
      } else {
        await api('/api/onboarding/interview', {
          method: 'PUT',
          body: JSON.stringify({ generation: receipt.generation, answers }),
        });
        setReceipt({ ...receipt, completed: true });
        writeStored('about', {
          ...scope(),
          generation: receipt.generation,
          answers,
          turns,
          done,
          completed: true,
        });
      }
      void prepareSuggestions();
      onNext();
    } catch (cause) {
      setNeedsReload(cause instanceof ApiError && cause.status === 409);
      setError(errorMessage(cause));
    } finally {
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
              <Messages items={said(turns[at], true)} avatar={still} conversation />
              <div className="ob-about-sent" data-new={waited && at === answers.length - 1}>
                <div>
                  <UserBubble>{answer}</UserBubble>
                </div>
              </div>
            </Fragment>
          ))}
          {thinking ? (
            !error && <Messages key="thinking" items={[]} typing conversation />
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
          <form className="composer ob-composer" onSubmit={(event) => void submit(event)}>
            <input
              ref={input}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type your answer…"
              aria-label="Your answer"
              autoComplete="off"
              maxLength={interviewAnswerChars}
              disabled={saving || !loaded}
              data-analytics-private
            />
            <div className="composer-tools">
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
        </Rise>
      )}
      {done && (
        <Footer
          show={shown}
          onBack={() => void restart()}
          backLabel="Change my answers"
          onNext={() => void save()}
          busy={saving}
        />
      )}
      {error && (
        <p className="ob-about-error" role="alert" data-analytics-private>
          {error}
          {(thinking || needsReload) && (
            <>
              <Button variant="ghost" disabled={saving} onClick={onBack}>
                Back
              </Button>
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setError('');
                  if (!loaded || needsReload) setLoadAttempt((value) => value + 1);
                  else setRetry((value) => value + 1);
                }}
              >
                Try again
              </Button>
              {resetVersion && (
                <Button variant="ghost" disabled={saving} onClick={() => void restart()}>
                  Start interview again
                </Button>
              )}
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
  return <Messages items={lines} revealed={revealed} typing={typing} conversation />;
}
