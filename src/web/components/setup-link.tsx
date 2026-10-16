import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, Globe2, KeyRound, Link2, MonitorSmartphone } from 'lucide-react';
import type { AppSetupStatus, CredentialRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import type { SetupKind } from '../lib/message-links';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
import { AppConnectionDialog, type AppSignIn } from './app-connection-dialog';
import { ServiceLogo } from './service-logo';
import { Notice } from './ui';

const icons = { vault: KeyRound, website: Globe2, app: Link2, browser: MonitorSmartphone };
const vaultLink = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]+)\/?$/;
const appLink = /^\/apps\?connect=([a-f0-9-]{36})$/i;

async function readAppLinks(links: string[], signal: AbortSignal, pairingUrl?: string) {
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
      ...(pairingUrl ? { pairingUrl } : {}),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    cache: 'no-store',
  });
  signal.throwIfAborted();
  return {
    completed: fingerprints
      .filter((link) => result.completed.includes(link.hash))
      .map((link) => link.href),
    apps: new Map(
      fingerprints.flatMap(({ href, hash }) => {
        const app = result.apps.find((item) => item.hash === hash);
        return app ? [[href, app] as const] : [];
      }),
    ),
  };
}

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
        const result = await readAppLinks(links, controller.signal);
        setCompleted((current) => new Set([...current, ...result.completed]));
        setApps(result.apps);
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
  const complete = useCallback((href: string) => {
    setCompleted((current) => new Set([...current, href]));
  }, []);
  return { completed, apps, complete };
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
  onConnect,
}: {
  href: string;
  setup: SetupKind;
  label: string;
  app?: AppSetupStatus['apps'][number];
  onConnect(href: string, trigger: HTMLButtonElement): void;
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
      <button
        type="button"
        data-setup={setup}
        onClick={(event) => onConnect(href, event.currentTarget)}
      >
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
      rel={
        setup === 'vault' && (vaultLink.test(href) || href.startsWith('/payments/'))
          ? 'opener'
          : 'noopener noreferrer'
      }
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
  const { completed, apps, complete } = useAppLinks(
    actions.filter((action) => action.setup === 'app').map((action) => action.href),
  );
  const [signIn, setSignIn] = useState<AppSignIn>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [accessRenewed, setAccessRenewed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const opened = useRef(new Set<string>());
  const trigger = useRef<HTMLButtonElement | null>(null);
  const key = JSON.stringify(actions.map((action) => action.href));
  function close() {
    request.current?.abort();
    request.current = null;
    window.clearTimeout(timer.current);
    setSignIn(undefined);
    setOpening(false);
    setError('');
  }
  useEffect(() => {
    close();
    setAccessRenewed(false);
    return () => {
      request.current?.abort();
      window.clearTimeout(timer.current);
    };
  }, [key]);
  useEffect(() => {
    if (signIn?.url && completed.has(signIn.url)) close();
  }, [completed, signIn?.url]);
  async function connect(href: string) {
    if (appLink.test(href)) {
      window.location.assign(href);
      return;
    }
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    const external = desktopLinksAvailable();
    const popup =
      external || opened.current.has(href)
        ? null
        : window.open('', '_blank', 'popup,width=520,height=720');
    let handedOff = false;
    controller.signal.addEventListener(
      'abort',
      () => {
        if (!handedOff) popup?.close();
      },
      { once: true },
    );
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = 'Connect to Otto';
        popup.document.body.textContent = 'Preparing secure sign-in…';
      }
    } catch {}
    const previous = apps.get(href);
    setSignIn({
      service: previous?.slug ?? '',
      name: previous?.name ?? 'app',
      logoUrl: previous?.logoUrl,
      opened: opened.current.has(href),
    });
    setOpening(true);
    setError('');
    setAccessRenewed(false);
    const deadline = Date.now() + 10 * 60_000;
    const fail = (message: string) => {
      if (!current()) return;
      controller.abort();
      request.current = null;
      window.clearTimeout(timer.current);
      setOpening(false);
      setError(message);
    };
    const check = async () => {
      if (!current()) return;
      try {
        const result = await readAppLinks([href], controller.signal, href);
        if (!current()) return;
        if (result.completed.includes(href)) {
          complete(href);
          close();
          return;
        }
        const app = result.apps.get(href);
        if (!app) {
          fail('This sign-in link is no longer available. Ask Otto to connect again.');
          return;
        }
        setSignIn((value) =>
          current() && value?.url === href && !value.signInRequired && app.signInRequired === true
            ? { ...value, signInRequired: true }
            : value,
        );
        if (app.pairingConfirmed === true) {
          setSignIn((value) =>
            current() && value?.url === href && !value.pairingConfirmed
              ? { ...value, pairingConfirmed: true }
              : value,
          );
        }
      } catch {
        if (!current()) return;
      }
      if (Date.now() >= deadline) {
        fail('The sign-in link expired. Ask Otto to connect again.');
        return;
      }
      timer.current = window.setTimeout(() => void check(), 5000);
    };
    try {
      const result = await readAppLinks([href], controller.signal, href);
      if (!current()) return;
      if (result.completed.includes(href)) {
        popup?.close();
        complete(href);
        close();
        return;
      }
      const app = result.apps.get(href);
      if (!app) throw new Error('The sign-in link is unavailable.');
      const pairingConfirmed = app.pairingConfirmed === true;
      if (pairingConfirmed) {
        popup?.close();
        opened.current.add(href);
      }
      const pending = {
        service: app.slug,
        name: app.name,
        logoUrl: app.logoUrl,
        url: href,
        opened: opened.current.has(href),
        reopened: opened.current.has(href),
        pairingConfirmed,
        signInRequired: app.signInRequired === true,
      };
      flushSync(() => setSignIn(pending));
      timer.current = window.setTimeout(() => void check(), 5000);
      if (pending.signInRequired) popup?.close();
      else if (!pending.opened) {
        if (external) {
          await openConnection(href);
          opened.current.add(href);
        } else if (popup && !popup.closed) {
          popup.location.href = href;
          handedOff = true;
          opened.current.add(href);
        }
      }
      if (!current()) return;
      setSignIn((value) =>
        current() && value?.url === href ? { ...value, opened: opened.current.has(href) } : value,
      );
      setOpening(false);
    } catch {
      popup?.close();
      if (!current()) return;
      fail('This sign-in link could not be opened. Ask Otto to connect again.');
    }
  }
  const pending = actions.filter((action) => !completed.has(action.href));
  if (!pending.length && !signIn && !accessRenewed) return null;
  return (
    <>
      {accessRenewed && (
        <Notice kind="success">
          Browser sign-in renewed. <a href="/apps">Open Apps</a> to connect the app again.
        </Notice>
      )}
      {pending.length > 0 && (
        <div className="setup-group">
          {pending.map((action) => (
            <SetupAction
              key={action.href}
              {...action}
              app={apps.get(action.href)}
              onConnect={(href, button) => {
                trigger.current = button;
                void connect(href);
              }}
            />
          ))}
        </div>
      )}
      <AppConnectionDialog
        signIn={signIn}
        opening={opening}
        error={error}
        onClose={close}
        onAccessRenewed={() => {
          close();
          setAccessRenewed(true);
        }}
        onOpened={() => {
          if (!signIn?.url) return;
          opened.current.add(signIn.url);
          setSignIn((value) => (value === signIn ? { ...value, opened: true } : value));
        }}
        onCloseAutoFocus={(event) => {
          if (!trigger.current?.isConnected) return;
          event.preventDefault();
          trigger.current.focus();
        }}
      />
    </>
  );
}
