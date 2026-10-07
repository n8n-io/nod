import { useEffect, useState } from 'react';
import { Check, Globe2, KeyRound, Link2, MonitorSmartphone } from 'lucide-react';
import type { AppSetupStatus, CredentialRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import type { SetupKind } from '../lib/message-links';
import { ServiceLogo } from './service-logo';

const icons = { vault: KeyRound, website: Globe2, app: Link2, browser: MonitorSmartphone };
const vaultLink = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]+)\/?$/;
const appLink = /^\/apps\?connect=([a-f0-9-]{36})$/i;

function useAppLinks(hrefs: string[]) {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [apps, setApps] = useState<Map<string, AppSetupStatus['apps'][number]>>(new Map());
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
            const connectionId = appLink.exec(href)?.[1].toLowerCase();
            const digest = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(connectionId ? `/apps?connect=${connectionId}` : href),
            );
            const hash = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            return { href, hash, connectionId };
          }),
        );
        const result = await api<AppSetupStatus>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({
            hashes: fingerprints.map((link) => link.hash),
            connectionIds: fingerprints.flatMap((link) => link.connectionId ?? []),
          }),
          signal: controller.signal,
          cache: 'no-store',
        });
        setCompleted(
          (current) =>
            new Set([
              ...current,
              ...fingerprints
                .filter((link) => result.completed.includes(link.hash))
                .map((link) => link.href),
            ]),
        );
        setApps(
          new Map(
            fingerprints.flatMap(({ href, hash }) => {
              const app = result.apps.find((item) => item.hash === hash);
              return app ? [[href, app]] : [];
            }),
          ),
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
  return { completed, apps };
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

function SetupAction({
  href,
  setup,
  label,
  app,
}: {
  href: string;
  setup: SetupKind;
  label: string;
  app?: AppSetupStatus['apps'][number];
}) {
  const status = useRequestStatus(href);
  const Icon = icons[setup];
  if (status !== 'pending')
    return (
      <button type="button" data-setup={setup} data-status={status} disabled>
        {status === 'filled' ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Icon size={16} aria-hidden="true" />
        )}
        {label}
      </button>
    );
  if (setup === 'app')
    return (
      <button type="button" data-setup={setup} onClick={() => window.location.assign(href)}>
        {app ? (
          <ServiceLogo slug={app.slug} logoUrl={app.logoUrl} size={18} />
        ) : (
          <Icon size={18} aria-hidden="true" />
        )}
        <span>{label}</span>
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
      <Icon size={16} aria-hidden="true" />
      {label}
    </a>
  );
}

export function SetupActions({
  actions,
}: {
  actions: { href: string; setup: SetupKind; label: string }[];
}) {
  const { completed, apps } = useAppLinks(
    actions.filter((action) => action.setup === 'app').map((action) => action.href),
  );
  const pending = actions.filter((action) => !completed.has(action.href));
  if (!pending.length) return null;
  return (
    <div className="setup-group">
      {pending.map((action) => (
        <SetupAction key={action.href} {...action} app={apps.get(action.href)} />
      ))}
    </div>
  );
}
