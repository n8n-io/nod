import { useEffect, useState } from 'react';
import type { VaultActivity } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { VaultActivityPages } from './vault-activity';
import { Notice } from './ui';

export function VaultCardPayments({ cardId }: { cardId: string }) {
  const [activity, setActivity] = useState<VaultActivity | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<VaultActivity>(`/api/vault/activity?item=${encodeURIComponent(cardId)}`, {
      signal: controller.signal,
    })
      .then(setActivity)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [cardId]);

  return (
    <>
      {error && <Notice>{error}</Notice>}
      <section className="vault-site-activity" aria-label="Payments">
        {!activity ? null : activity.entries.length ? (
          <div className="statement">
            <VaultActivityPages activity={activity} item={cardId} />
          </div>
        ) : (
          <p className="statement-empty">Nod hasn’t used this card yet.</p>
        )}
      </section>
    </>
  );
}
