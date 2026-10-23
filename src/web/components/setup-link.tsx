import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Globe2, KeyRound, Link2 } from './icons';
import type { AppSetupStatus, CredentialRequest } from '../../shared/contracts';
import { api, ApiError } from '../lib/api';
import { captureAnalytics } from '../lib/analytics';
import type { SetupKind } from '../lib/message-links';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
import { AppConnectionDialog, type AppSignIn } from './app-connection-dialog';
import { AppDiscoveryDialog } from './app-discovery-dialog';
import { ServiceLogo } from './service-logo';
import { usePrivateEntry } from './private-entry';

const icons = { vault: KeyRound, website: Globe2, app: Link2 };
const vaultLink = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]+)\/?$/;
const paymentLink = /^\/payments\/([a-f0-9-]{36})\/?$/i;
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

function usePrivateLinks(hrefs: string[]) {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const key = JSON.stringify(hrefs);
  useEffect(() => {
    const links = (JSON.parse(key) as string[]).filter(
      (href) => vaultLink.test(href) || paymentLink.test(href),
    );
    if (!links.length) return;
    const controller = new AbortController();
    const settled = new Set<string>();
    const deadline = Date.now() + 10 * 60_000;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        await Promise.allSettled(
          links
            .filter((href) => !settled.has(href))
            .map(async (href) => {
              try {
                const token = vaultLink.exec(href)?.[1];
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
                const status = token
                  ? (
                      await api<Pick<CredentialRequest, 'status'>>(
                        `/api/credential-requests/${token}/status`,
                        { signal, cache: 'no-store' },
                      )
                    ).status
                  : (
                      await api<{ status: string }>(
                        `/api/payment-requests/${paymentLink.exec(href)![1]}/status`,
                        { signal, cache: 'no-store' },
                      )
                    ).status;
                if (controller.signal.aborted) return;
                if (['filled', 'submitted', 'uncertain', 'expired'].includes(status))
                  settled.add(href);
                if (status === 'filled' || status === 'submitted')
                  setCompleted((current) => new Set([...current, href]));
              } catch (error) {
                if (
                  !controller.signal.aborted &&
                  error instanceof ApiError &&
                  [404, 410].includes(error.status)
                )
                  settled.add(href);
              }
            }),
        );
      } finally {
        checking = false;
        if (settled.size === links.length) window.clearInterval(timer);
      }
    };
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) window.clearInterval(timer);
      else void check();
    }, 5000);
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [key]);
  return completed;
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
  const Icon = icons[setup];
  const entry = usePrivateEntry();
  if (setup === 'app')
    return (
      <button
        type="button"
        data-setup={setup}
        className="setup-app-card"
        onClick={(event) => {
          captureAnalytics('nod_setup_link_clicked', { setup });
          onConnect(href, event.currentTarget);
        }}
      >
        {app ? (
          <ServiceLogo slug={app.slug} logoUrl={app.logoUrl} size={28} />
        ) : (
          <Icon size={28} aria-hidden="true" />
        )}
        <span className="setup-app-name">{app?.name ?? label.replace(/^Connect\s+/i, '')}</span>
        <span className="setup-app-action">Connect</span>
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
      onClick={(event) => {
        captureAnalytics('nod_setup_link_clicked', { setup });
        if (
          setup === 'vault' &&
          !event.button &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          entry?.open(href, event.currentTarget)
        )
          event.preventDefault();
      }}
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
  const privateCompleted = usePrivateLinks(
    actions.filter((action) => action.setup === 'vault').map((action) => action.href),
  );
  const [signIn, setSignIn] = useState<AppSignIn>();
  const [discoveryHref, setDiscoveryHref] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
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
    setDiscoveryHref(null);
    setOpening(false);
    setError('');
  }
  useEffect(() => {
    close();
    return () => {
      request.current?.abort();
      window.clearTimeout(timer.current);
    };
  }, [key]);
  useEffect(() => {
    if (signIn?.url && completed.has(signIn.url)) close();
  }, [completed, signIn?.url]);
  async function connect(href: string) {
    const navigate = appLink.test(href);
    if (!navigate && request.current) return;
    captureAnalytics('nod_app_connect_clicked', { entry: 'chat', result: 'opened' });
    if (navigate) {
      setDiscoveryHref(href);
      return;
    }
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
        popup.document.title = 'Connect to nod';
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
          fail('This sign-in link is no longer available. Ask nod to connect again.');
          return;
        }
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
        fail('The sign-in link expired. Ask nod to connect again.');
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
      };
      flushSync(() => setSignIn(pending));
      timer.current = window.setTimeout(() => void check(), 5000);
      if (!pending.opened) {
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
      fail('This sign-in link could not be opened. Ask nod to connect again.');
    }
  }
  const pending = actions.filter(
    (action) => !completed.has(action.href) && !privateCompleted.has(action.href),
  );
  if (!pending.length && !signIn && !discoveryHref) return null;
  return (
    <>
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
      {discoveryHref && (
        <AppDiscoveryDialog
          key={discoveryHref}
          id={appLink.exec(discoveryHref)![1]}
          onClose={() => setDiscoveryHref(null)}
          onConnected={() => {
            complete(discoveryHref);
            setDiscoveryHref(null);
          }}
          returnFocus={() => trigger.current}
        />
      )}
      <AppConnectionDialog
        signIn={signIn}
        opening={opening}
        error={error}
        onClose={close}
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
