import { useEffect, useState } from 'react';
import { Check, CircleX, CreditCard, LockKeyhole } from 'lucide-react';
import type { VaultPaymentRequest } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { originLabel } from '../lib/vault-name';
import { returnToChat } from '../lib/navigation';
import { formatMoney } from './vault-activity';
import { Button, Field, Input, Loading, Notice, Switch } from './ui';

export function PaymentForm({ token, inline = false }: { token: string; inline?: boolean }) {
  const [request, setRequest] = useState<VaultPaymentRequest | null>(null);
  const [cardId, setCardId] = useState<string>();
  const [doItForMe, setDoItForMe] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const settled = Boolean(request) && request?.status !== 'pending';
  const Heading = inline ? 'h2' : 'h1';
  useEffect(() => {
    if (settled) return;
    const controller = new AbortController();
    const load = () =>
      api<VaultPaymentRequest>(`/api/payments/${encodeURIComponent(token)}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((value) => {
          setRequest(value);
          setCardId(
            (current) =>
              current ??
              value.cardId ??
              (value.cards.length === 1 ? value.cards[0]!.id : undefined),
          );
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError('This payment request is unavailable. Ask Otto again.');
        });
    void load();
    const timer = inline ? window.setInterval(() => void load(), 5000) : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [token, inline, settled]);

  const card = request?.cards.find((item) => item.id === cardId);
  const amount = request ? formatMoney(request.amount) : '';
  const needsCode = !card?.doItForMe;
  const site = request ? originLabel(request.origin) : '';

  async function act(path: string, body?: object) {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ status: VaultPaymentRequest['status'] }>(path, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      });
      setRequest((current) => current && { ...current, status: result.status });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function pay(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!card) return;
    const code = String(new FormData(event.currentTarget).get('securityCode') ?? '');
    void act(`/api/payments/${encodeURIComponent(token)}`, {
      cardId: card.id,
      ...(needsCode ? { securityCode: code, doItForMe } : {}),
    });
  }

  const back = !inline && (
    <Button asChild>
      <a href="/" onClick={returnToChat}>
        Back to chat
      </a>
    </Button>
  );

  return (
    <div
      className={inline ? 'payment-inline' : undefined}
      aria-busy={busy || (!request && !error)}
      data-analytics-private
    >
      {!request && !error ? (
        <div className="credential-complete" role="status">
          <Loading label="Opening the payment…" />
        </div>
      ) : request?.status === 'entered' ? (
        <div className="credential-complete" role="status">
          <div className="success-mark">
            <Check size={inline ? 18 : 24} />
          </div>
          <Heading>{amount} approved</Heading>
          <p>Otto entered your card at {site} and will place the order.</p>
          {back}
        </div>
      ) : request?.status === 'declined' ? (
        <div className="credential-complete" role="status">
          <CircleX size={inline ? 22 : 32} />
          <Heading>Not paid</Heading>
          <p>Otto won’t pay {site}.</p>
          {back}
        </div>
      ) : request && settled ? (
        <div className="credential-complete">
          <LockKeyhole size={inline ? 22 : 32} />
          <Heading>
            {request.status === 'expired' ? 'This payment expired' : 'This payment stopped'}
          </Heading>
          <p>Ask Otto again if you still want to buy it.</p>
          {back}
        </div>
      ) : request ? (
        <>
          {inline ? (
            <p className="credential-intro">{request.description}</p>
          ) : (
            <header className="credential-heading">
              <div className="credential-symbol">
                <CreditCard size={inline ? 20 : 24} />
              </div>
              <div>
                <Heading>Pay {amount}</Heading>
                <p className="credential-intro">
                  {site} · {request.description}
                </p>
              </div>
            </header>
          )}
          {request.flagged && (
            <Notice>
              A page in this task had instructions for AI assistants. Check the shop and the amount.
            </Notice>
          )}
          <form className="form-stack payment-form" autoComplete="off" onSubmit={pay}>
            {(!inline || request.cards.length > 1) && (
              <div className="payment-cards" role="radiogroup" aria-label="Card">
                {request.cards.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={item.id === cardId}
                    className="button button-outline payment-card"
                    disabled={busy}
                    onClick={() => setCardId(item.id)}
                  >
                    <CreditCard size={16} aria-hidden="true" />
                    <span>
                      <strong>
                        {item.brand} •••• {item.last4}
                      </strong>
                      <small>{item.label}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {card && needsCode && (
              <>
                <Field label="Security code">
                  <Input
                    name="securityCode"
                    inputMode="numeric"
                    autoComplete="cc-csc"
                    pattern="[0-9]{3,4}"
                    maxLength={4}
                    autoFocus={!inline}
                    required
                  />
                </Field>
                {request.local && (
                  <div className="field vault-switch-row">
                    <span>
                      <span className="field-label">Do it for me</span>
                      <small className="payment-hint">Next time, your yes is enough.</small>
                    </span>
                    <Switch
                      checked={doItForMe}
                      aria-label="Do it for me"
                      disabled={busy}
                      onCheckedChange={setDoItForMe}
                    />
                  </div>
                )}
              </>
            )}
            <div className="payment-actions">
              <Button type="submit" disabled={busy || !card}>
                {busy ? 'Paying…' : `Pay ${amount}`}
              </Button>
              <Button
                variant="ghost"
                type="button"
                disabled={busy}
                onClick={() => void act(`/api/payments/${encodeURIComponent(token)}/decline`)}
              >
                Don’t pay
              </Button>
            </div>
          </form>
        </>
      ) : null}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
