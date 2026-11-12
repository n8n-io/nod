import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  choiceAnswerText,
  type AnswerChoices as AnswerChoicesValue,
  type QuestionAnswer,
} from '../../shared/answer-choices';
import type { Message } from '../../shared/contracts';
import { errorMessage } from '../lib/api';
import { analyticsForCurrentSession, observeAnalyticsView } from '../lib/analytics';
import { ArrowUp, Check, PenLine } from './icons';

export interface AnswerChoicesProps {
  choices: AnswerChoicesValue;
  question: { id: string; text: string };
  title: ReactNode;
  disabled?: boolean;
  onAnswer(text: string, answer: QuestionAnswer): Promise<boolean | 'unavailable'>;
}

type GivenAnswer = NonNullable<Message['choiceAnswer']>;

export function ChoiceBadge({
  index,
  on = false,
  children,
}: {
  index?: number;
  on?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className="choice-card-badge" data-on={on || undefined} aria-hidden="true">
      {children ?? (index === undefined ? null : String.fromCharCode(65 + index))}
    </span>
  );
}

export function ChoiceCopy({ label }: { label: string }) {
  return (
    <span className="choice-card-copy" title={label}>
      {label}
    </span>
  );
}

export function AnswerChoices({
  choices,
  question,
  title,
  disabled = false,
  onAnswer,
}: AnswerChoicesProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const unavailable = useRef(disabled);
  unavailable.current = disabled;
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<GivenAnswer | 'unavailable' | null>(null);
  const [error, setError] = useState('');
  const { multiple, options } = choices;
  const locked = disabled || busy;
  const typed = text.trim();
  const picked = options.filter((option) => selected.includes(option.id));
  const count = picked.length + (typed ? 1 : 0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (submitted || !root.current) return;
    return observeAnalyticsView(root.current, question.id, 'answer_choices_viewed', {
      multiple,
      option_count: options.length,
    });
  }, [multiple, options.length, question.id, submitted]);

  async function answer(chosen: typeof options, written: string) {
    if (!mounted.current || unavailable.current || pending.current) return;
    if (!chosen.length && !written) return;
    const choiceIds = chosen.map((option) => option.id);
    const selection: QuestionAnswer = !chosen.length
      ? { custom: true }
      : written
        ? { choiceIds, custom: true }
        : { choiceIds };
    const value = [...(chosen.length ? [choiceAnswerText(chosen)] : []), written]
      .filter(Boolean)
      .join('\n');
    const capture = analyticsForCurrentSession();
    pending.current = true;
    setBusy(true);
    setError('');
    const focused = document.activeElement;
    const message = root.current?.closest<HTMLElement>('[data-message-id]');
    try {
      const outcome = await onAnswer(value, selection);
      if (outcome === true && chosen.length)
        capture('answer_choices_selected', {
          multiple,
          option_count: options.length,
          selected_count: chosen.length,
        });
      if (outcome === true || outcome === 'unavailable') {
        if (
          message?.isConnected &&
          (root.current?.contains(document.activeElement) ||
            (document.activeElement === document.body && focused && !focused.isConnected))
        )
          message.focus({ preventScroll: true });
        if (mounted.current)
          setSubmitted(
            outcome === 'unavailable'
              ? 'unavailable'
              : { choiceIds, ...(written ? { text: written } : {}) },
          );
        return;
      }
      if (mounted.current) setError('Your answer could not be sent. Try again.');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
    pending.current = false;
    if (mounted.current) setBusy(false);
  }

  function finish() {
    void answer(multiple ? picked : [], typed);
  }

  if (submitted === 'unavailable' || !options.length) return <>{title}</>;
  if (submitted) return <ChoiceAnswer choices={choices} answer={submitted} title={title} />;

  return (
    <section
      ref={root}
      className="action-card answer-choices choice-card"
      data-analytics-private
      data-question-id={question.id}
      aria-labelledby={`${id}-question`}
      aria-busy={busy}
    >
      <div className="choice-card-heading">
        <div id={`${id}-question`} className="choice-card-title">
          {title}
        </div>
        {multiple && (
          <p className="choice-card-count" aria-live="polite">
            {count ? `${count} selected` : 'Pick one or more'}
          </p>
        )}
      </div>
      <div className="choice-card-list" role="group" aria-labelledby={`${id}-question`}>
        {options.map((option, index) => {
          const on = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className="answer-choice choice-card-row"
              aria-pressed={multiple ? on : undefined}
              aria-disabled={locked}
              onClick={() => {
                if (unavailable.current || pending.current) return;
                setError('');
                if (!multiple) return void answer([option], '');
                setSelected((current) =>
                  on ? current.filter((value) => value !== option.id) : [...current, option.id],
                );
              }}
            >
              <ChoiceBadge index={index} on={on}>
                {on ? <Check size={14} /> : undefined}
              </ChoiceBadge>
              <ChoiceCopy label={choiceAnswerText([option])} />
            </button>
          );
        })}
        <div className="choice-card-row choice-card-input">
          <ChoiceBadge on={multiple && Boolean(typed)}>
            <PenLine size={14} />
          </ChoiceBadge>
          <input
            className="answer-choices-write"
            value={text}
            maxLength={4000}
            placeholder="Type your own answer"
            aria-label="Type your own answer"
            readOnly={locked}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              finish();
            }}
          />
          {!multiple && (
            <button
              type="button"
              className="answer-choices-send choice-card-send"
              aria-label="Send answer"
              aria-hidden={!typed || undefined}
              tabIndex={typed ? undefined : -1}
              data-idle={!typed || undefined}
              aria-disabled={locked}
              onClick={finish}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {(multiple || error) && (
        <div className="choice-card-footer">
          {error && (
            <p className="choice-card-error" role="alert">
              {error}
            </p>
          )}
          {multiple && (
            <button
              type="button"
              className="answer-choices-done choice-card-done"
              aria-disabled={locked || !count}
              onClick={finish}
            >
              Done
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ChoiceAnswer({
  choices,
  answer,
  title,
}: {
  choices: AnswerChoicesValue;
  answer: GivenAnswer;
  title: ReactNode;
}) {
  return (
    <section className="action-card action-card-settled choice-card" data-analytics-private>
      <div className="choice-card-heading">
        <div className="choice-card-title">{title}</div>
      </div>
      <div className="choice-card-list" role="group" aria-label="Your answer">
        {choices.options.map(
          (option, index) =>
            answer.choiceIds.includes(option.id) && (
              <div key={option.id} className="choice-card-row choice-card-chosen">
                <ChoiceBadge index={index} on />
                <ChoiceCopy label={choiceAnswerText([option])} />
              </div>
            ),
        )}
        {answer.text && (
          <div className="choice-card-row choice-card-chosen">
            <ChoiceBadge on>
              <PenLine size={14} />
            </ChoiceBadge>
            <span className="choice-card-written">{answer.text}</span>
          </div>
        )}
      </div>
    </section>
  );
}
