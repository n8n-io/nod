import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { captureSurvey, watchAnalyticsSurvey, type AnalyticsSurvey } from '../lib/analytics';
import { BrandMark } from './brand';
import { X } from './icons';
import { Button } from './ui';

function withBrand(text: string) {
  return text.split(/\b(Nod)\b/).map((part, index) =>
    index % 2 ? (
      <span key={index} className="survey-brand">
        <BrandMark />
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function SurveyCard() {
  const [survey, setSurvey] = useState<AnalyticsSurvey>();
  const closed = useRef(new Set<string>());
  useEffect(
    () =>
      watchAnalyticsSurvey((next) =>
        setSurvey((current) =>
          !next ? undefined : (current ?? (closed.current.has(next.id) ? undefined : next)),
        ),
      ),
    [],
  );
  if (!survey) return null;
  return (
    <SurveyForm
      key={survey.id}
      survey={survey}
      onClose={() => {
        closed.current.add(survey.id);
        setSurvey(undefined);
      }}
    />
  );
}

function SurveyForm({ survey, onClose }: { survey: AnalyticsSurvey; onClose(): void }) {
  const card = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const shown = useRef(false);
  const partial = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  const title = useId();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [text, setText] = useState('');
  const [submission] = useState(() => crypto.randomUUID());
  const [sent, setSent] = useState(false);
  const question = survey.questions[step];
  const last = step === survey.questions.length - 1;

  useEffect(() => {
    const show = () => {
      if (shown.current || document.visibilityState !== 'visible' || !card.current?.isConnected)
        return;
      shown.current = true;
      captureSurvey('shown', survey);
    };
    show();
    document.addEventListener('visibilitychange', show);
    return () => document.removeEventListener('visibilitychange', show);
  }, [survey]);

  useEffect(() => {
    if (step > 0) input.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => close.current(), 2500);
    return () => window.clearTimeout(timer);
  }, [sent]);

  function answer(value: number | string) {
    const next = value === '' ? answers : { ...answers, [question.id]: value };
    captureSurvey('sent', survey, { submission, answers: next, completed: last });
    partial.current = !last;
    setAnswers(next);
    setText('');
    if (last) setSent(true);
    else setStep(step + 1);
  }

  function dismiss() {
    if (!sent) captureSurvey('dismissed', survey, partial.current ? { submission } : undefined);
    onClose();
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (!card.current?.contains(document.activeElement)) return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (sent || (!question.optional && !text.trim())) return;
    answer(text.trim());
  }

  return (
    <aside ref={card} className="survey-card" aria-labelledby={title} data-analytics-private>
      <button type="button" className="survey-card-close" aria-label="Close" onClick={dismiss}>
        <X size={14} aria-hidden="true" />
      </button>
      {sent ? (
        <p id={title} className="survey-card-thanks" role="status">
          Thanks, that helps.
        </p>
      ) : question.kind === 'rating' ? (
        <fieldset key={question.id} className="survey-question">
          <legend id={title}>{withBrand(question.text)}</legend>
          <div
            className="survey-scale"
            style={{
              gridTemplateColumns: `repeat(${question.scale === 10 ? 11 : question.scale}, 1fr)`,
            }}
          >
            {Array.from({ length: question.scale === 10 ? 11 : question.scale }, (_, value) =>
              question.scale === 10 ? value : value + 1,
            ).map((value) => (
              <button
                key={value}
                type="button"
                className="survey-scale-option"
                onClick={() => answer(value)}
              >
                {value}
              </button>
            ))}
          </div>
          {(question.low || question.high) && (
            <div className="survey-scale-labels" aria-hidden="true">
              <span>{question.low}</span>
              <span>{question.high}</span>
            </div>
          )}
        </fieldset>
      ) : (
        <form key={question.id} onSubmit={submit}>
          <label className="survey-question">
            <span id={title}>{withBrand(question.text)}</span>
            <textarea
              ref={input}
              className="input"
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <small className="survey-card-hint">Please do not enter personal data.</small>
          </label>
          <div className="survey-card-footer">
            <span>Your answer goes to the Nod team.</span>
            <Button type="submit" size="sm" disabled={!question.optional && !text.trim()}>
              {last ? 'Send' : 'Next'}
            </Button>
          </div>
        </form>
      )}
    </aside>
  );
}
