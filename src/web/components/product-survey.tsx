import { useEffect, useId, useRef, useState } from 'react';
import {
  churnLabels,
  churnReasons,
  productSurveyEventSchema,
  productSurveys,
  type ProductSurveyOffer,
} from '../../shared/product-surveys';
import { api, errorMessage, requestAccountVersion } from '../lib/api';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Notice } from './ui';

export function ProductSurveyPrompt({
  ownerId,
  enabled,
  visible,
}: {
  ownerId: string;
  enabled: boolean;
  visible: boolean;
}) {
  return enabled && visible ? <SurveyPrompt key={ownerId} /> : null;
}

function SurveyPrompt() {
  const id = useId();
  const [offer, setOffer] = useState<ProductSurveyOffer | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [score, setScore] = useState<number>();
  const [reason, setReason] = useState<(typeof churnReasons)[number]>();
  const [error, setError] = useState('');
  const [thanks, setThanks] = useState(false);
  const request = useRef<AbortController | null>(null);
  const account = useRef(requestAccountVersion());
  const active = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = (controller: AbortController) =>
    active.current && !controller.signal.aborted && account.current === requestAccountVersion();

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started || document.visibilityState !== 'visible') return;
      started = true;
      void api<{ offer: ProductSurveyOffer | null }>('/api/product-survey', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
        .then((result) => {
          if (!current(controller) || !result.offer) return;
          const parsed = productSurveyEventSchema.safeParse({ ...result.offer, status: 'shown' });
          if (parsed.success)
            setOffer({ survey: parsed.data.survey, submission_id: parsed.data.submission_id });
        })
        .catch(() => {});
    };
    load();
    document.addEventListener('visibilitychange', load);
    return () => {
      active.current = false;
      controller.abort();
      request.current?.abort();
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  async function show() {
    if (
      !offer ||
      shown ||
      request.current ||
      !active.current ||
      account.current !== requestAccountVersion()
    )
      return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ accepted: boolean }>('/api/product-survey', {
        method: 'POST',
        body: JSON.stringify({ ...offer, status: 'shown' }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!current(controller)) return;
      if (!result.accepted) {
        setOpen(false);
        setOffer(null);
        return;
      }
      setShown(true);
    } catch (cause) {
      if (current(controller)) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (current(controller)) setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const reveal = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', reveal);
      void show();
    };
    document.addEventListener('visibilitychange', reveal);
    reveal();
    return () => document.removeEventListener('visibilitychange', reveal);
  }, [open]);

  function dismiss() {
    setOpen(false);
    setOffer(null);
    request.current?.abort();
    if (!offer || !active.current || account.current !== requestAccountVersion()) return;
    const controller = new AbortController();
    request.current = controller;
    void api('/api/product-survey', {
      method: 'POST',
      body: JSON.stringify({ ...offer, status: 'dismissed' }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .catch(() => {})
      .finally(() => {
        if (request.current === controller) request.current = null;
      });
  }

  async function send() {
    if (
      !offer ||
      !shown ||
      request.current ||
      !active.current ||
      account.current !== requestAccountVersion()
    )
      return;
    const payload = productSurveyEventSchema.safeParse({
      ...offer,
      status: 'sent',
      ...(offer.survey === 'nps' ? { score } : { reason }),
    });
    if (!payload.success) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ accepted: boolean }>('/api/product-survey', {
        method: 'POST',
        body: JSON.stringify(payload.data),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (!current(controller)) return;
      if (!result.accepted) {
        setOpen(false);
        setOffer(null);
        return;
      }
      setThanks(true);
      setOpen(false);
      setOffer(null);
    } catch (cause) {
      if (current(controller)) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (current(controller)) setBusy(false);
    }
  }

  if (thanks)
    return (
      <p className="product-survey-thanks" role="status">
        Thanks for your feedback.
      </p>
    );
  if (!offer) return null;
  return (
    <div className="product-survey" data-analytics-private>
      <Button ref={trigger} variant="ghost" size="sm" onClick={() => setOpen(true)}>
        One question about Nod
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
      >
        <DialogContent
          className="product-survey-dialog"
          data-analytics-private
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>{productSurveys[offer.survey].question}</DialogTitle>
          <DialogDescription>Your answer is optional and helps us improve Nod.</DialogDescription>
          <fieldset
            className="product-survey-answers"
            disabled={!shown || busy}
            aria-describedby={offer.survey === 'nps' ? `${id}-scale` : undefined}
          >
            <legend className="sr-only">Your answer</legend>
            {offer.survey === 'nps' ? (
              <>
                <div className="product-survey-scores">
                  {Array.from({ length: 11 }, (_, value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={id}
                        value={value}
                        checked={score === value}
                        onChange={() => setScore(value)}
                      />
                      <span>{value}</span>
                    </label>
                  ))}
                </div>
                <div id={`${id}-scale`} className="product-survey-scale">
                  <span>0 — Not likely</span>
                  <span>10 — Very likely</span>
                </div>
              </>
            ) : (
              <div className="product-survey-reasons">
                {churnReasons.map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={id}
                      value={value}
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    <span>{churnLabels[value]}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {error && <Notice>{error}</Notice>}
          <div className="product-survey-actions">
            <Button variant="ghost" onClick={dismiss}>
              Not now
            </Button>
            {error && !shown ? (
              <Button disabled={busy} onClick={() => void show()}>
                Try again
              </Button>
            ) : (
              <Button
                disabled={
                  !shown ||
                  busy ||
                  (offer.survey === 'nps' ? score === undefined : reason === undefined)
                }
                onClick={() => void send()}
              >
                {busy && shown ? 'Sending…' : 'Send'}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
