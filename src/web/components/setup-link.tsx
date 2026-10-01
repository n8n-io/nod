import { useEffect, useState } from 'react';
import { Check, Globe2, KeyRound, Link2, MonitorSmartphone } from 'lucide-react';
import type { CredentialRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import type { SetupKind } from '../lib/message-links';

const icons = { vault: KeyRound, website: Globe2, app: Link2, browser: MonitorSmartphone };
const vaultLink = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]+)\/?$/;

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
  if (!actions.length) return null;
  return (
    <div className="setup-group">
      {actions.map((action) => (
        <SetupAction key={action.href} {...action} />
      ))}
    </div>
  );
}
