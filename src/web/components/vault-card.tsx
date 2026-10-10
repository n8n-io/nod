import { useEffect, useState } from 'react';
import type { VaultActivity, VaultEntryDetails } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { VaultActivityPages } from './vault-activity';
import { Button, Field, Input, Notice, Switch } from './ui';

export function VaultCardPayments({
  cardId,
  hosted,
  onChanged,
}: {
  cardId: string;
  hosted: boolean;
  onChanged(): void;
}) {
  const [doItForMe, setDoItForMe] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [activity, setActivity] = useState<VaultActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      hosted
        ? Promise.resolve(null)
        : api<VaultEntryDetails>(`/api/vault/${encodeURIComponent(cardId)}/details`, {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
          }),
      api<VaultActivity>(`/api/vault/activity?item=${encodeURIComponent(cardId)}`, {
        signal: controller.signal,
      }),
    ])
      .then(([details, history]) => {
        setDoItForMe(details?.kind === 'card' ? details.hasSecurityCode : false);
        setActivity(history);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [cardId, hosted]);

  async function save(securityCode: string | null) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/vault/${encodeURIComponent(cardId)}/security-code`, {
        method: 'PUT',
        body: JSON.stringify({ securityCode }),
      });
      setDoItForMe(Boolean(securityCode));
      setAdding(false);
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!hosted && (
        <div className="vault-inset">
          <div className="vault-inset-row vault-switch-row">
            <span>
              <span className="vault-detail-value">Do it for me</span>
              <small className="payment-hint">
                Otto keeps the security code, so your yes is enough to pay.
              </small>
            </span>
            <Switch
              checked={Boolean(doItForMe) || adding}
              aria-label="Do it for me"
              disabled={doItForMe === null || busy}
              onCheckedChange={(next) =>
                next ? setAdding(true) : adding ? setAdding(false) : void save(null)
              }
            />
          </div>
          {adding && (
            <form
              className="vault-inset-row vault-card-code"
              onSubmit={(event) => {
                event.preventDefault();
                void save(String(new FormData(event.currentTarget).get('securityCode') ?? ''));
              }}
            >
              <Field label="Security code">
                <Input
                  name="securityCode"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  pattern="[0-9]{3,4}"
                  maxLength={4}
                  autoFocus
                  required
                />
              </Field>
              <Button type="submit" size="sm" disabled={busy}>
                Save
              </Button>
            </form>
          )}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      <section className="vault-site-activity" aria-label="Payments">
        <h3>Payments</h3>
        {!activity ? null : activity.entries.length ? (
          <div className="statement">
            <VaultActivityPages activity={activity} item={cardId} />
          </div>
        ) : (
          <p className="statement-empty">Otto hasn’t used this card yet.</p>
        )}
      </section>
    </>
  );
}
