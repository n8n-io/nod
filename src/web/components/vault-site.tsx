import { useEffect, useState } from 'react';
import { Globe } from './icons';
import type { VaultActivity, VaultSession } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { originLabel } from '../lib/vault-name';
import { VaultActivityPages } from './vault-activity';
import { VaultBackButton, VaultSurface, VaultTitle } from './vault-surface';
import { Button, Notice } from './ui';

const sessionStates: Record<VaultSession['state'], string> = {
  saved: 'Signed in',
  needs_sign_in: 'Sign-in needed',
  pending: 'Sign-in not finished',
  disconnecting: 'Signing out…',
};

export function VaultSiteAccess({
  origin,
  sessions,
  onSessionRemoved,
  onAsk,
}: {
  origin: string;
  sessions: VaultSession[];
  onSessionRemoved(id: string): void;
  onAsk?(text: string): void;
}) {
  const [activity, setActivity] = useState<VaultActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setActivity(null);
    setError('');
    const failed = (cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    };
    void api<VaultActivity>(`/api/vault/activity?origin=${encodeURIComponent(origin)}`, {
      signal: controller.signal,
    })
      .then((history) => {
        if (!controller.signal.aborted) setActivity(history);
      })
      .catch(failed);
    return () => controller.abort();
  }, [origin]);

  async function signOut(session: VaultSession) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/vault/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      onSessionRemoved(session.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {sessions.length > 0 && (
        <div className="vault-inset">
          {sessions.map((session) => (
            <div key={session.id} className="vault-inset-row">
              <span className="vault-inset-label">
                {sessions.length > 1 ? session.label : 'Saved session'}
              </span>
              <div className="vault-inset-value">
                <span className="vault-detail-value">{sessionStates[session.state]}</span>
                <div className="vault-detail-actions">
                  {onAsk && ['needs_sign_in', 'pending'].includes(session.state) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        onAsk(
                          `Use browser connection ${session.id} to open ${session.url}. Check whether it works. If the session expired, help me sign in through the secure form and save the session.`,
                        )
                      }
                    >
                      Sign in again
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void signOut(session)}
                  >
                    Sign out
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      <section className="vault-site-activity" aria-label="Activity">
        {!activity ? null : activity.entries.length ? (
          <div className="statement">
            <VaultActivityPages activity={activity} origin={origin} />
          </div>
        ) : (
          <p className="statement-empty">nod hasn’t used this yet.</p>
        )}
      </section>
    </>
  );
}

export function VaultSessionDetails({
  session,
  autoFocus,
  backLabel,
  onClose,
  onRemoved,
  onAsk,
}: {
  session: VaultSession;
  autoFocus?: boolean;
  backLabel: string;
  onClose(): void;
  onRemoved(id: string): void;
  onAsk?(text: string): void;
}) {
  const host = originLabel(session.origin);
  return (
    <VaultSurface label={session.label} autoFocus={autoFocus} onClose={onClose}>
      <div className="vault-bar">
        <VaultBackButton label={backLabel} onClick={onClose} />
      </div>
      <div className="vault-hero">
        <span className="vault-hero-icon" aria-hidden="true">
          <Globe size={56} />
        </span>
        <VaultTitle>{session.label}</VaultTitle>
        <p>{host}</p>
      </div>
      <VaultSiteAccess
        origin={session.origin}
        sessions={[session]}
        onSessionRemoved={onRemoved}
        onAsk={onAsk}
      />
    </VaultSurface>
  );
}
