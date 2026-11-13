import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ApprovalState, MessageApproval } from '../../shared/contracts';
import { errorMessage } from '../lib/api';
import { ChoiceBadge, ChoiceCopy } from './answer-choices';
import { AlertCircle, ArrowDown, Check, LoaderCircle, X } from './icons';
import { ServiceLogo } from './service-logo';
import { Button } from './ui';

export function ActionCard({
  label,
  title,
  logo,
  settled = false,
  footer,
  children,
}: {
  label: string;
  title?: ReactNode;
  logo?: ReactNode;
  settled?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`action-card${settled ? ' action-card-settled' : ''}`}
      aria-label={label}
      data-analytics-private
    >
      {title && (
        <>
          <header className="action-card-header">
            {logo}
            <h3 className="action-card-title">{title}</h3>
          </header>
          <div className="action-card-divider" aria-hidden="true" />
        </>
      )}
      <div className="action-card-body">{children}</div>
      {footer}
    </section>
  );
}

export function ApprovalFields({
  fields,
  body,
  bodyCut = false,
}: {
  fields: Array<{ label: string; value: string }>;
  body?: string;
  bodyCut?: boolean;
}) {
  return (
    <>
      <dl className="action-card-fields">
        {fields.map((field) => (
          <Fragment key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </Fragment>
        ))}
      </dl>
      {body && <div className="action-card-content">{body}</div>}
      {bodyCut && (
        <p className="action-card-cut">Only the start is shown. The rest is included too.</p>
      )}
    </>
  );
}

type Answer = (approved: boolean, label: string) => Promise<boolean | 'unavailable'>;

function useApproval(approval: MessageApproval, disabled: boolean, onAnswer?: Answer) {
  const [answered, setAnswered] = useState<ApprovalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (approval.state === 'pending') return;
    setAnswered(null);
    setError('');
  }, [approval.state]);
  async function answer(approved: boolean, label: string) {
    if (!onAnswer || busy || disabled) return;
    setBusy(true);
    setError('');
    const focused = document.activeElement;
    const message = focused?.closest<HTMLElement>('[data-message-id]');
    try {
      const sent = await onAnswer(approved, label);
      if (
        sent === true &&
        message?.isConnected &&
        (document.activeElement === focused ||
          (document.activeElement === document.body && !focused?.isConnected))
      )
        message.focus({ preventScroll: true });
      if (!mounted.current) return;
      if (sent === 'unavailable') setError('This can no longer be answered here.');
      else if (sent) setAnswered(approved ? 'working' : 'declined');
      else setError('Your answer could not be sent. Try again.');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return {
    state: approval.state === 'pending' && answered ? answered : approval.state,
    locked: busy || disabled || !onAnswer,
    error,
    answer,
  };
}

function ApprovalStatus({ state, sends = false }: { state: ApprovalState; sends?: boolean }) {
  return (
    <span className="action-card-status" data-state={state} role="status">
      {state === 'working' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {state === 'done' && <Check size={16} aria-hidden="true" />}
      {state === 'declined' && <X size={16} aria-hidden="true" />}
      {state === 'working'
        ? sends
          ? 'Sending…'
          : 'Working…'
        : state === 'done'
          ? sends
            ? 'Sent'
            : 'Done'
          : state === 'declined'
            ? 'Cancelled'
            : 'Expired'}
    </span>
  );
}

function UncertainNote({ app }: { app: string }) {
  return (
    <div className="action-card-note" role="status">
      <p className="action-card-note-title">
        <AlertCircle size={16} aria-hidden="true" />
        May have run
      </p>
      <p>
        {app || 'The app'} didn’t confirm it, and Nod won’t retry it. Check {app || 'the app'}{' '}
        before trying again.
      </p>
    </div>
  );
}

interface ApprovalProps {
  approval: MessageApproval;
  disabled?: boolean;
  onAnswer?: Answer;
  children: ReactNode;
}

function declineLabel(title: string) {
  return /^cancel\b/i.test(title) ? 'No' : 'Cancel';
}

export function ApprovalChoiceCard({
  approval,
  disabled = false,
  onAnswer,
  children,
}: ApprovalProps) {
  const id = useId();
  const { state, locked, error, answer } = useApproval(approval, disabled, onAnswer);
  const rows = [approval.title, declineLabel(approval.title)];
  const chosen = state === 'declined' ? 1 : 0;
  return (
    <section
      className={`action-card choice-card${state === 'pending' ? '' : ' action-card-settled'}`}
      aria-labelledby={`${id}-question`}
      data-analytics-private
    >
      <div className="choice-card-heading">
        <div id={`${id}-question`} className="choice-card-title">
          {children}
        </div>
      </div>
      {state === 'pending' ? (
        <div className="choice-card-list" role="group" aria-labelledby={`${id}-question`}>
          {rows.map((label, index) => (
            <button
              key={label}
              type="button"
              className="choice-card-row"
              aria-disabled={locked}
              onClick={() => void answer(index === 0, label)}
            >
              <ChoiceBadge index={index} />
              <ChoiceCopy label={label} />
            </button>
          ))}
        </div>
      ) : (
        <div className="choice-card-list" role="group" aria-label="Your answer">
          <div className="choice-card-row choice-card-chosen">
            {state !== 'expired' && <ChoiceBadge index={chosen} on />}
            <ChoiceCopy label={state === 'expired' ? 'Expired' : rows[chosen]!} />
            {(state === 'working' || state === 'done') && <ApprovalStatus state={state} />}
          </div>
        </div>
      )}
      {state === 'uncertain' && <UncertainNote app={approval.app} />}
      {error && (
        <div className="choice-card-footer">
          <p className="choice-card-error" role="alert">
            {error}
          </p>
        </div>
      )}
    </section>
  );
}

export function ApprovalCard({ approval, disabled = false, onAnswer, children }: ApprovalProps) {
  const { state, locked, error, answer } = useApproval(approval, disabled, onAnswer);
  const verb = approval.title.split(' ')[0] || 'Approve';
  const refusal = declineLabel(approval.title);
  return (
    <ActionCard
      label={approval.app ? `${approval.app}: ${approval.title}` : approval.title}
      title={approval.title}
      logo={approval.slug ? <ServiceLogo slug={approval.slug} size={20} /> : undefined}
      settled={state !== 'pending'}
      footer={
        state === 'pending' ? (
          <div className="action-card-actions">
            {error && (
              <p className="action-card-error" role="alert">
                {error}
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              aria-disabled={locked}
              onClick={() => void answer(false, refusal)}
            >
              {refusal}
            </Button>
            <Button
              type="button"
              variant={/^(delete|remove|trash)\b/i.test(verb) ? 'destructive' : 'default'}
              aria-disabled={locked}
              onClick={() => void answer(true, verb)}
            >
              {verb}
            </Button>
          </div>
        ) : state === 'uncertain' ? (
          <UncertainNote app={approval.app} />
        ) : (
          <div className="action-card-footer">
            <ApprovalStatus state={state} sends={verb === 'Send'} />
          </div>
        )
      }
    >
      {children}
    </ActionCard>
  );
}

export function CodeRequestCard({ kind }: { kind: 'otp' | 'payment' }) {
  const otp = kind === 'otp';
  return (
    <ActionCard
      label={otp ? 'Waiting for a verification code' : 'Waiting for a security code'}
      title={otp ? 'Verification code' : 'Card security code'}
    >
      <div className="code-card-slots" aria-hidden="true">
        {Array.from({ length: otp ? 6 : 3 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <p className="code-card-hint">
        <ArrowDown size={16} aria-hidden="true" />
        {otp
          ? 'Send the code by itself in the message box. Nod enters it privately and hides it in this chat.'
          : 'Send the 3- or 4-digit code from your card by itself in the message box.'}
      </p>
    </ActionCard>
  );
}
