import { useEffect, useState } from 'react';
import type { VaultActivity } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { VaultActivityPages } from './vault-activity';
import { Notice } from './ui';

export function VaultSiteAccess({ origin }: { origin: string }) {
  const [activity, setActivity] = useState<VaultActivity | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setActivity(null);
    setError('');
    void api<VaultActivity>(`/api/vault/activity?origin=${encodeURIComponent(origin)}`, {
      signal: controller.signal,
    })
      .then((history) => {
        if (!controller.signal.aborted) setActivity(history);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [origin]);

  return (
    <>
      {error && <Notice>{error}</Notice>}
      <section className="vault-site-activity" aria-label="Activity">
        {!activity ? null : activity.entries.length ? (
          <div className="statement">
            <VaultActivityPages activity={activity} origin={origin} />
          </div>
        ) : (
          <p className="statement-empty">Nod hasn’t used this yet.</p>
        )}
      </section>
    </>
  );
}
