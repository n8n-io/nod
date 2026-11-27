import { useEffect, useRef, useState } from 'react';
import type { PaymentRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import { originLabel } from '../lib/vault-name';
import { returnToChat } from '../lib/navigation';
import { subscribeAppEvents } from '../lib/app-events';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { BrandMark } from '../components/brand';

type PrivateFormProps = {
  id: string;
  embedded?: boolean;
  onClose?(): void;
};

function PrivateFormFrame({
  embedded,
  children,
}: {
  embedded?: boolean;
  children: React.ReactNode;
}) {
  const Element = embedded ? 'div' : 'main';
  return (
    <Element className={embedded ? 'credential-embedded' : 'credential-page'}>
      {!embedded && (
        <a href="/" onClick={returnToChat} className="credential-brand" aria-label="Nod home">
          <BrandMark />
          <span>Nod</span>
        </a>
      )}
      {children}
    </Element>
  );
}

function BackToChat({ onClose }: { onClose?(): void }) {
  return (
    <Button variant="outline" asChild>
      <a
        href="/"
        onClick={(event) => {
          if (onClose) {
            event.preventDefault();
            onClose();
          } else returnToChat(event);
        }}
      >
        Back to chat
      </a>
    </Button>
  );
}

export function Payment(props: PrivateFormProps) {
  return <PaymentForm key={props.id} {...props} />;
}

type PaymentStatus = 'pending' | 'entering' | 'submitted' | 'uncertain' | 'expired';

function PaymentForm({ id, embedded, onClose }: PrivateFormProps) {
  const card = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<PaymentRequest>();
  const [status, setStatus] = useState<PaymentStatus>();
  const [notEntered, setNotEntered] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const action = useRef<AbortController | null>(null);
  const updates = useRef(0);
  const path = `/api/payment-requests/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (action.current) return;
      const version = ++updates.current;
      try {
        const result = await api<{ status: PaymentStatus; notEntered?: boolean }>(
          `${path}/status`,
          {
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        if (controller.signal.aborted || version !== updates.current) return;
        setStatus(result.status);
        setNotEntered(result.notEntered === true);
        if (result.status !== 'pending') setError('');
        if (result.status === 'pending') {
          const value = await api<PaymentRequest>(path, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!controller.signal.aborted && version === updates.current) setRequest(value);
        }
      } catch {
        if (!controller.signal.aborted && version === updates.current)
          setError('This payment request is unavailable. Ask Nod to check the checkout.');
      }
    };
    void refresh();
    const unsubscribe = subscribeAppEvents(undefined, {
      open: () => void refresh(),
      error() {},
      message: (event) => {
        if (JSON.parse(event.data).type === 'refresh') void refresh();
      },
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      action.current?.abort();
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [path]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || action.current || status !== 'pending') return;
    updates.current++;
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    form.reset();
    const controller = new AbortController();
    action.current = controller;
    if (embedded && card.current?.contains(document.activeElement)) card.current.focus();
    setSaving(true);
    setError('');
    try {
      const result = await api<{ ok: boolean }>(path, {
        method: 'POST',
        body: JSON.stringify({ code }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (result.ok !== true) throw new Error('Unconfirmed payment submission');
      if (!controller.signal.aborted) setStatus('submitted');
    } catch {
      if (!controller.signal.aborted) {
        setStatus('uncertain');
        setError('The result is not confirmed. Ask Nod to check the order before another attempt.');
        try {
          const result = await api<{ status: PaymentStatus; notEntered?: boolean }>(
            `${path}/status`,
            {
              signal: controller.signal,
              cache: 'no-store',
            },
          );
          if (!controller.signal.aborted) {
            setStatus(result.status);
            setNotEntered(result.notEntered === true);
            if (result.notEntered || result.status === 'submitted' || result.status === 'entering')
              setError('');
          }
        } catch {}
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (action.current === controller) action.current = null;
    }
  }
  return (
    <PrivateFormFrame embedded={embedded}>
      <div
        className="credential-card credential-payment"
        ref={card}
        tabIndex={embedded ? -1 : undefined}
        data-analytics-private
        aria-busy={saving}
      >
        <h1>
          {notEntered
            ? 'Stopped before entry'
            : status === 'submitted'
              ? 'Card submitted'
              : status === 'uncertain'
                ? 'The result is unknown.'
                : status === 'expired'
                  ? 'This payment request has expired.'
                  : 'Approve payment'}
        </h1>
        {saving || status === 'entering' ? (
          <Loading label="Submitting your card…" />
        ) : status === 'submitted' ? (
          <p>Nod will check the result and continue your task in the same conversation.</p>
        ) : notEntered ? (
          <p>
            No values were entered in this step. Return to chat if you want to start a new payment.
          </p>
        ) : status === 'uncertain' ? (
          <p>
            The card may have reached the website. Ask Nod to check the order before another
            attempt.
          </p>
        ) : status === 'expired' ? (
          <p>Return to chat to check the checkout and request a new approval.</p>
        ) : request && status === 'pending' ? (
          <form className="form-stack" autoComplete="off" onSubmit={(event) => void submit(event)}>
            <p>
              {request.amount} at {originLabel(request.origin)} with {request.card}
            </p>
            <p>Card details go to {request.destinations.map(originLabel).join(' and ')}.</p>
            <Field label="Security code">
              <Input
                name="code"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{3,4}"
                minLength={3}
                maxLength={4}
                required
                autoFocus
                disabled={saving}
              />
            </Field>
            <Button type="submit" disabled={saving}>
              Pay {request.amount}
            </Button>
          </form>
        ) : (
          !error && <Loading label="Opening secure payment…" />
        )}
        {error && <Notice>{error}</Notice>}
        <BackToChat onClose={onClose} />
      </div>
    </PrivateFormFrame>
  );
}
