import { useEffect, useId, useRef, useState } from 'react';
import {
  choiceAnswerText,
  type AnswerChoices as AnswerChoicesValue,
  type QuestionAnswer,
} from '../../shared/answer-choices';
import { errorMessage } from '../lib/api';
import { analyticsForCurrentSession, observeAnalyticsView } from '../lib/analytics';
import { Check, PenLine } from './icons';
import { Button } from './ui';

export interface AnswerChoicesProps {
  choices: AnswerChoicesValue;
  question: { id: string; text: string };
  disabled?: boolean;
  onAnswer(text: string, answer: QuestionAnswer): Promise<boolean | 'unavailable'>;
  onWriteAnswer(text: string): void;
}

export function AnswerChoices({
  choices,
  question,
  disabled = false,
  onAnswer,
  onWriteAnswer,
}: AnswerChoicesProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const unavailable = useRef(disabled);
  unavailable.current = disabled;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy;
  const selectedOptions = choices.options.filter((option) => selected.includes(option.id));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (submitted || !root.current) return;
    return observeAnalyticsView(root.current, question.id, 'answer_choices_viewed', {
      multiple: choices.multiple,
      option_count: choices.options.length,
    });
  }, [choices.multiple, choices.options.length, question.id, submitted]);

  async function answer(value: string, selection: QuestionAnswer) {
    if (!mounted.current || unavailable.current || pending.current || !value.trim()) return;
    const capture = analyticsForCurrentSession();
    const properties =
      'choiceIds' in selection
        ? {
            multiple: choices.multiple,
            option_count: choices.options.length,
            selected_count: selection.choiceIds.length,
          }
        : undefined;
    pending.current = true;
    setBusy(true);
    setError('');
    const focused = document.activeElement;
    const message = root.current?.closest<HTMLElement>('[data-message-id]');
    try {
      const outcome = await onAnswer(value.trim(), selection);
      if (outcome === true && properties) capture('answer_choices_selected', properties);
      if (outcome === true || outcome === 'unavailable') {
        if (
          message?.isConnected &&
          (root.current?.contains(document.activeElement) ||
            (document.activeElement === document.body && focused && !focused.isConnected))
        )
          message.focus({ preventScroll: true });
        if (mounted.current) setSubmitted(true);
        return;
      }
      if (mounted.current) setError('Your answer could not be sent. Try again.');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
    pending.current = false;
    if (mounted.current) setBusy(false);
  }

  if (submitted || !choices.options.length) return null;

  return (
    <div
      ref={root}
      className="answer-choices"
      data-analytics-private
      data-question-id={question.id}
      role="group"
      aria-labelledby={`${id}-question`}
      aria-describedby={choices.multiple ? `${id}-instructions` : undefined}
      aria-busy={busy}
    >
      <span id={`${id}-question`} className="sr-only">
        Answer: {question.text}
      </span>
      {choices.multiple && (
        <span id={`${id}-instructions`} className="sr-only">
          Choose one or more answers, then send. Use Add your own to edit your selections and add
          options in the message composer.
        </span>
      )}
      <div className="answer-choices-options">
        {choices.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            className={`answer-choice${option.description ? ' has-description' : ''}`}
            aria-pressed={choices.multiple ? selected.includes(option.id) : undefined}
            aria-disabled={locked}
            onClick={() => {
              if (unavailable.current || pending.current) return;
              setError('');
              if (choices.multiple)
                setSelected((current) =>
                  current.includes(option.id)
                    ? current.filter((value) => value !== option.id)
                    : [...current, option.id],
                );
              else void answer(choiceAnswerText([option]), { choiceIds: [option.id] });
            }}
          >
            {choices.multiple && (
              <span className="answer-choice-check" aria-hidden="true">
                {selected.includes(option.id) && <Check size={12} />}
              </span>
            )}
            <span className="answer-choice-copy">
              <span className="answer-choice-label">{option.label}</span>
              {option.description && (
                <span className="answer-choice-description">{option.description}</span>
              )}
            </span>
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          className="answer-choices-write"
          aria-disabled={locked}
          onClick={() => {
            if (unavailable.current || pending.current) return;
            setError('');
            onWriteAnswer(choiceAnswerText(selectedOptions));
          }}
        >
          <PenLine size={14} aria-hidden="true" />
          {choices.multiple ? 'Add your own' : 'Write an answer'}
        </Button>
      </div>
      {choices.multiple && (
        <div className="answer-choices-actions">
          <Button
            type="button"
            size="sm"
            className="answer-choices-send"
            aria-disabled={locked || !selectedOptions.length}
            onClick={() => {
              if (!selectedOptions.length) return;
              void answer(choiceAnswerText(selectedOptions), {
                choiceIds: selectedOptions.map((option) => option.id),
              });
            }}
          >
            Send
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="answer-choices-secondary"
            aria-disabled={locked || !selected.length}
            onClick={() => {
              if (unavailable.current || pending.current) return;
              setSelected([]);
              setError('');
            }}
          >
            Clear
          </Button>
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="answer-choices-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
