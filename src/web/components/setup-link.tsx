import { useEffect, useState } from 'react';
import { Check, Globe2, KeyRound, Link2, MonitorSmartphone } from 'lucide-react';
import type { CredentialRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import type { SetupKind } from '../lib/message-links';

const icons = { vault: KeyRound, website: Globe2, app: Link2, browser: MonitorSmartphone };
const vaultLink = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]+)\/?$/;

function useCompletedAppLinks(hrefs: string[]) {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const key = JSON.stringify(hrefs);
  useEffect(() => {
    const links = JSON.parse(key) as string[];
    if (!links.length) return;
    const controller = new AbortController();
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const fingerprints = await Promise.all(
          links.map(async (href) => {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(href));
            const hash = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            return { href, hash };
          }),
        );
        const hashes = await api<string[]>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({ hashes: fingerprints.map((link) => link.hash) }),
          signal: controller.signal,
          cache: 'no-store',
        });
        setCompleted(
          (current) =>
            new Set([
              ...current,
              ...fingerprints.filter((link) => hashes.includes(link.hash)).map((link) => link.href),
            ]),
        );
      } catch {}
    };
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      controller.abort();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key]);
  return completed;
}

function useRequestStatus(href: string) {
  const token = vaultLink.exec(href)?.[1];
  const [status, setStatus] = useState<CredentialRequest['status']>('pending');
  useEffect(() => {
    if (!token || status !== 'pending') return;
    const controller = new AbortController();
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void api<CredentialRequest>(`/api/credential-requests/${encodeURIComponent(token)}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((request) => setStatus(request.status))
        .catch(() => {});
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      controller.abort();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [token, status]);
  return status;
}

function SetupAction({ href, setup, label }: { href: string; setup: SetupKind; label: string }) {
  const status = useRequestStatus(href);
  const Icon = icons[setup];
  if (status !== 'pending')
    return (
      <button type="button" data-setup={setup} data-status={status} disabled>
        {status === 'filled' ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Icon size={14} aria-hidden="true" />
        )}
        {label}
      </button>
    );
  if (setup === 'app')
    return (
      <button type="button" data-setup={setup} onClick={() => window.location.assign(href)}>
        <Icon size={14} aria-hidden="true" />
        {label}
      </button>
    );
  return (
    <a
      data-setup={setup}
      href={href}
      target={href.startsWith('/apps?connect=') ? undefined : '_blank'}
      rel={setup === 'vault' && vaultLink.test(href) ? 'opener' : 'noopener noreferrer'}
      referrerPolicy="no-referrer"
      title={href.startsWith('https://') ? new URL(href).host : undefined}
    >
      <Icon size={14} aria-hidden="true" />
      {label}
    </a>
  );
}

export function SetupActions({
  actions,
}: {
  actions: { href: string; setup: SetupKind; label: string }[];
}) {
  const completed = useCompletedAppLinks(
    actions
      .filter((action) => action.setup === 'app' && action.href.startsWith('https://'))
      .map((action) => action.href),
  );
  const pending = actions.filter((action) => !completed.has(action.href));
  if (!pending.length) return null;
  return (
    <div className="setup-group">
      {pending.map((action) => (
        <SetupAction key={action.href} {...action} />
      ))}
    </div>
  );
}
