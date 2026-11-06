import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AppSetupStatus } from '../../shared/contracts';
import { api, ApiError, errorMessage } from '../lib/api';
import { analyticsForCurrentSession, appConnectionAnalytics } from '../lib/analytics';
import { cancelSetup, connectionUrl, setupLinkHash } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';

const outcomes = ['connected', 'continued', 'cancelled', 'failed', 'expired'];

type SignInTarget = { service: string; connectionId?: string; managed?: boolean };

function outcomeMessage(name: string, result?: string) {
  if (result === 'cancelled') return 'Sign-in cancelled. You can try again.';
  if (result === 'expired')
    return 'This sign-in link is no longer active. Try again with a new window.';
  if (result === 'failed') return `${name} didn’t connect. Try again with a new sign-in window.`;
  return '';
}

export function useAppSignIn({
  entry,
  name,
  onSettled,
  onSetup,
}: {
  entry: 'onboarding' | 'chat';
  name(service: string): string;
  onSettled(): void;
  onSetup?(url: string): void;
}) {
  const [service, setService] = useState<string>();
  const [pending, setPending] = useState<'opening' | 'waiting'>();
  const [pairingConfirmed, setPairingConfirmed] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string>();
  const [signInOpened, setSignInOpened] = useState(false);
  const [stale, setStale] = useState(false);
  const [pollFailing, setPollFailing] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<SignInTarget>();
  const request = useRef<AbortController | null>(null);
  const signInWindow = useRef<Window | null>(null);
  const attempt = useRef<(SignInTarget & { id: string; url: string; report(): void }) | undefined>(
    undefined,
  );
  const active = useRef(false);
  const latest = useRef({ name, onSettled, onSetup });
  latest.current = { name, onSettled, onSetup };

  function clearAttempt() {
    signInWindow.current?.close();
    signInWindow.current = null;
    setCompleted(undefined);
    attempt.current = undefined;
    setSignInUrl(undefined);
    setSignInOpened(false);
    setStale(false);
    setPollFailing(false);
  }

  useEffect(() => {
    active.current = true;
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nod.apps');
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{ connection?: string; service?: string; attempt?: string } | null>,
      ) => {
        const { connection, service: value, attempt: id } = event.data ?? {};
        if (
          !attempt.current ||
          value !== attempt.current.service ||
          !id ||
          attempt.current.id !== id ||
          !outcomes.includes(connection ?? '')
        )
          return;
        const selected = attempt.current;
        if (connection === 'connected') {
          void (async () => {
            try {
              const hash = await setupLinkHash(selected.url);
              const result = await api<AppSetupStatus>('/api/apps/setup-status', {
                method: 'POST',
                body: JSON.stringify({ hashes: [hash], pairingUrl: selected.url }),
                signal: AbortSignal.timeout(10_000),
                cache: 'no-store',
              });
              if (result.completed.includes(hash)) selected.report();
            } catch {}
          })();
        }
        clearAttempt();
        const success = connection === 'connected' || connection === 'continued';
        setCompleted(success ? selected : undefined);
        setError(outcomeMessage(latest.current.name(selected.service), connection));
        setPending((current) => (current === 'waiting' ? undefined : current));
        latest.current.onSettled();
      };
    return () => {
      active.current = false;
      channel?.close();
      request.current?.abort();
      signInWindow.current?.close();
      attempt.current = undefined;
    };
  }, []);

  useEffect(() => {
    const currentAttempt = attempt.current;
    if (!signInUrl || !currentAttempt) return;
    const controller = new AbortController();
    let checking: Promise<boolean> | undefined;
    let poll: number | undefined;
    let grace: number | undefined;
    let failures = 0;
    let confirmed = false;
    const current = () => !controller.signal.aborted && attempt.current === currentAttempt;
    const settle = (result: 'connected' | 'failed' | 'expired') => {
      if (!current()) return;
      controller.abort();
      window.clearTimeout(poll);
      window.clearTimeout(grace);
      clearAttempt();
      if (result === 'connected') currentAttempt.report();
      setCompleted(result === 'connected' ? currentAttempt : undefined);
      setPending(undefined);
      setError(outcomeMessage(latest.current.name(currentAttempt.service), result));
      latest.current.onSettled();
    };
    const read = async () => {
      try {
        const hash = await setupLinkHash(signInUrl);
        const result = await api<AppSetupStatus>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({ hashes: [hash], pairingUrl: signInUrl }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          cache: 'no-store',
        });
        if (!current()) return false;
        failures = 0;
        setPollFailing(false);
        if (result.completed.includes(hash)) {
          settle('connected');
          return true;
        }
        const app = result.apps.find((app) => app.hash === hash);
        if (!app || app.available === false) {
          settle('expired');
          return true;
        }
        if (app.pairingConfirmed === true && !confirmed) {
          confirmed = true;
          setPairingConfirmed(true);
        }
      } catch {
        if (current() && ++failures >= 3) setPollFailing(true);
      }
      return false;
    };
    const check = () => {
      if (!current()) return Promise.resolve(false);
      checking ??= read().finally(() => {
        checking = undefined;
      });
      return checking;
    };
    const schedule = () => {
      poll = window.setTimeout(() => {
        void check().finally(() => {
          if (current()) schedule();
        });
      }, 5000);
    };
    const returned = () => {
      if (document.visibilityState !== 'visible') return;
      void check();
      window.clearTimeout(grace);
      grace = window.setTimeout(() => {
        if (current()) setStale(true);
      }, 4000);
    };
    if (document.visibilityState === 'visible') void check();
    schedule();
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    const timer = window.setTimeout(() => {
      void check().then((settled) => {
        if (!settled) settle('expired');
      });
    }, 10 * 60_000);
    return () => {
      controller.abort();
      window.clearTimeout(poll);
      window.clearTimeout(grace);
      window.clearTimeout(timer);
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, [signInUrl]);

  async function connect(target: SignInTarget) {
    if (request.current) return;
    const { service: slug, connectionId } = target;
    const capture = analyticsForCurrentSession();
    const completion = appConnectionAnalytics(entry);
    capture('app_connect_clicked', { entry, result: 'opened' });
    const previous = attempt.current;
    const restarting =
      previous?.service === slug && previous.connectionId === connectionId ? previous : undefined;
    if (!restarting) clearAttempt();
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open(
          `/connection-loading.html?service=${encodeURIComponent(slug)}`,
          restarting ? '_blank' : `nod-connect-${slug}`,
          'popup,width=520,height=720',
        );
    try {
      if (popup) popup.opener = null;
    } catch {}
    const controller = new AbortController();
    request.current = controller;
    controller.signal.addEventListener('abort', () => popup?.close(), { once: true });
    if (!restarting) signInWindow.current = popup;
    setService(slug);
    setPending('opening');
    setPairingConfirmed(false);
    setError('');
    let next: 'waiting' | undefined;
    let ownedAttempt = restarting;
    try {
      if (previous && !restarting)
        await api('/api/apps/setup-cancel', {
          method: 'POST',
          body: JSON.stringify({ hash: await setupLinkHash(previous.url) }),
          signal: controller.signal,
        });
      const response = await api<{ url: string; attempt?: string }>(
        `/api/apps/${encodeURIComponent(slug)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify({
            returnTo: external ? 'desktop' : 'window',
            connectionId,
            restartAttempt: restarting?.id,
          }),
        },
      );
      if (controller.signal.aborted) {
        cancelSetup(connectionUrl(response.url, window.location.origin));
        throw new DOMException('Cancelled.', 'AbortError');
      }
      const url = connectionUrl(response.url, window.location.origin);
      clearAttempt();
      signInWindow.current = popup;
      const setup = new URL(url);
      if (
        latest.current.onSetup &&
        setup.origin === window.location.origin &&
        setup.pathname === '/apps' &&
        setup.searchParams.has('connect')
      ) {
        popup?.close();
        completion.transfer(setup.searchParams.get('connect')!);
        latest.current.onSetup(`${setup.pathname}${setup.search}`);
        return;
      }
      if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
        throw new Error(outcomeMessage(latest.current.name(slug), 'failed'));
      attempt.current = {
        ...target,
        id: response.attempt,
        url,
        report: completion.complete,
      };
      ownedAttempt = attempt.current;
      flushSync(() => {
        setSignInUrl(url);
      });
      next = 'waiting';
      if (external) await openConnection(url);
      else if (popup && !popup.closed) popup.location.href = url;
      if (!controller.signal.aborted && attempt.current?.id === response.attempt)
        setSignInOpened(external || Boolean(popup && !popup.closed));
    } catch (cause) {
      popup?.close();
      if (
        controller.signal.aborted ||
        request.current !== controller ||
        (ownedAttempt && attempt.current !== ownedAttempt)
      )
        return;
      if (
        restarting &&
        attempt.current === restarting &&
        cause instanceof ApiError &&
        cause.status === 409
      )
        next = 'waiting';
      else clearAttempt();
      setError(errorMessage(cause));
      capture('ui_error', { area: entry, action: 'connect' });
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setPending(attempt.current ? next : undefined);
      }
    }
  }

  function cancel() {
    if (signInUrl) cancelSetup(signInUrl);
    request.current?.abort();
    request.current = null;
    clearAttempt();
    setPending(undefined);
  }

  function openSignIn() {
    if (!signInUrl || !service) return;
    const popup = window.open(signInUrl, `nod-connect-${service}`, 'popup,width=520,height=720');
    if (popup) popup.opener = null;
    signInWindow.current = popup;
    setSignInOpened(Boolean(popup && !popup.closed));
  }

  return {
    service,
    setService,
    pending,
    pairingConfirmed,
    signInUrl,
    signInOpened,
    setSignInOpened,
    stale,
    pollFailing,
    error,
    setError,
    completed,
    setCompleted,
    attempt,
    connect,
    cancel,
    openSignIn,
  };
}
