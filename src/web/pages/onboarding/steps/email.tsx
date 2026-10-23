import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, LoaderCircle } from '../../../components/icons';
import type { AppSetupStatus, Configuration, Connection } from '../../../../shared/contracts';
import { connectedGmail } from '../../../../shared/onboarding';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { connectionUrl } from '../../../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../../../lib/desktop';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [
  { typing: 450 },
  { wait: 300, typing: 550 },
  { wait: 200 },
  { wait: 200 },
];

const outcomes = ['connected', 'cancelled', 'failed', 'expired'];

const unavailableReasons = {
  load: 'Couldn’t check your app connections.',
  ready: 'App connections aren’t available right now.',
  gmail: 'Gmail isn’t available with this connection.',
};

function connectionMessage(result?: string) {
  if (result === 'cancelled') return 'Sign-in cancelled. You can try again.';
  if (result === 'expired')
    return 'This sign-in link is no longer active. Try again with a new window.';
  if (result === 'failed') return 'Gmail didn’t connect. Try again with a new sign-in window.';
  return '';
}

export function Email({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing, done, skip } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  const configuration = usePageData<Configuration>('/api/configuration');
  const apps = usePageData<Connection[]>('/api/apps');
  const refreshApps = apps.refresh;
  const [reloading, setReloading] = useState(false);
  const [recovering, setRecovering] = useState<string>();
  const [pending, setPending] = useState<'opening' | 'waiting'>();
  const [pairingConfirmed, setPairingConfirmed] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string>();
  const [signInOpened, setSignInOpened] = useState(false);
  const [stale, setStale] = useState(false);
  const [pollFailing, setPollFailing] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<string | undefined>(undefined);
  const active = useRef(false);

  function clearAttempt() {
    setCompleted(false);
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
        const { connection, service, attempt: value } = event.data ?? {};
        if (
          service !== 'gmail' ||
          !value ||
          attempt.current !== value ||
          !outcomes.includes(connection ?? '')
        )
          return;
        clearAttempt();
        setCompleted(connection === 'connected');
        setError(connectionMessage(connection));
        setPending((current) => (current === 'waiting' ? undefined : current));
        void refreshApps();
      };
    return () => {
      active.current = false;
      channel?.close();
      request.current?.abort();
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
      setCompleted(result === 'connected');
      setPending(undefined);
      setError(connectionMessage(result));
      void refreshApps();
    };
    const read = async () => {
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signInUrl));
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
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
  }, [signInUrl, refreshApps]);

  const gmail = apps.data?.filter((connection) => connection.slug === 'gmail') ?? [];
  const disconnections = gmail.filter((connection) => connection.disconnectPending);
  const account = gmail.find(connectedGmail);
  const connected = !!account;
  const loading = (!configuration.data && !configuration.error) || (!apps.data && !apps.error);
  const unavailable: keyof typeof unavailableReasons | undefined = loading
    ? undefined
    : !configuration.data || !apps.data
      ? 'load'
      : !configuration.data.integrationsReady
        ? 'ready'
        : gmail.some((connection) => connection.status !== 'not_configured')
          ? undefined
          : 'gmail';
  const canConnect = !disconnections.length && !recovering && !loading && !unavailable;

  useEffect(() => {
    if (
      arrived !== 'forward' ||
      !completed ||
      !connected ||
      !canConnect ||
      pending ||
      apps.refreshing ||
      apps.error
    )
      return;
    setCompleted(false);
    onNext();
  }, [arrived, completed, connected, canConnect, pending, apps.refreshing, apps.error, onNext]);

  async function connect() {
    if (request.current || !canConnect) return;
    const capture = analyticsForCurrentSession();
    capture('nod_app_connect_clicked', { entry: 'onboarding', result: 'opened' });
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open(
          '/connection-loading.html?service=gmail',
          'nod-connect-gmail',
          'popup,width=520,height=720',
        );
    try {
      if (popup) popup.opener = null;
    } catch {}
    const controller = new AbortController();
    request.current = controller;
    clearAttempt();
    setPending('opening');
    setPairingConfirmed(false);
    setError('');
    let next: 'waiting' | undefined;
    try {
      const response = await api<{ url: string; attempt?: string }>('/api/apps/gmail/connect', {
        method: 'POST',
        body: JSON.stringify({ returnTo: 'window' }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      const url = connectionUrl(response.url, window.location.origin);
      if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
        throw new Error('Gmail didn’t connect. Try again?');
      attempt.current = response.attempt;
      flushSync(() => {
        setSignInUrl(url);
      });
      next = 'waiting';
      if (external) {
        await openConnection(url);
        if (!controller.signal.aborted && attempt.current === response.attempt)
          setSignInOpened(true);
      } else if (popup && !popup.closed) {
        popup.location.href = url;
        setSignInOpened(true);
      }
    } catch (cause) {
      popup?.close();
      clearAttempt();
      if (!controller.signal.aborted) {
        setError(errorMessage(cause));
        capture('nod_ui_error', { area: 'onboarding', action: 'connect' });
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setPending(attempt.current ? next : undefined);
      }
    }
  }

  async function retryDisconnection(id: string) {
    if (request.current || recovering) return;
    const controller = new AbortController();
    request.current = controller;
    setRecovering(id);
    setError('');
    try {
      await api(`/api/apps/gmail/accounts/${encodeURIComponent(id)}/disconnect`, {
        method: 'POST',
        signal: controller.signal,
      });
      await refreshApps();
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current) setRecovering(undefined);
    }
  }

  function cancel() {
    request.current?.abort();
    request.current = null;
    clearAttempt();
    setPending(undefined);
  }

  async function reload() {
    setReloading(true);
    await Promise.all([configuration.refresh(), refreshApps()]);
    if (active.current) setReloading(false);
  }

  const gmailState = connected ? 'connected' : (pending ?? 'idle');
  let status;
  if (disconnections.length)
    status = (
      <div className="ob-email-notes">
        <p>Disconnection wasn’t confirmed. Retry to check its status and finish disconnecting.</p>
        {disconnections.map((connection) => (
          <div className="ob-email-retry" key={connection.connectionId ?? connection.accountId}>
            {connection.accountEmail && (
              <p className="ob-email-muted" data-analytics-private>
                {connection.accountEmail}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!!recovering || !!pending || !connection.connectionId}
              onClick={() => void retryDisconnection(connection.connectionId!)}
            >
              {recovering === connection.connectionId ? 'Checking…' : 'Retry disconnection'}
            </Button>
          </div>
        ))}
      </div>
    );
  else if (account) status = null;
  else if (gmailState === 'waiting')
    status = (
      <div className="ob-email-waiting">
        <div className="ob-email-waiting-status" role="status">
          <LoaderCircle size={18} className="spin" aria-hidden="true" />
          <p>
            {stale ? 'Still waiting for sign-in.' : 'Finish signing in in your browser.'}{' '}
            {signInUrl && !signInOpened && !pairingConfirmed && (
              <a
                href={signInUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setSignInOpened(true)}
              >
                Open sign-in
              </a>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void connect()}>
          Start again
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  else if (loading) status = <p className="ob-email-muted">Checking app connections…</p>;
  else if (unavailable)
    status = (
      <div className="ob-email-retry">
        <p className="ob-email-muted">{unavailableReasons[unavailable]}</p>
        <Button variant="ghost" size="sm" disabled={reloading} onClick={() => void reload()}>
          {reloading && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          Try again
        </Button>
      </div>
    );
  else
    status = error ? null : (
      <p className="ob-email-muted">Sign in to Gmail and review what nod can access.</p>
    );

  return (
    <section className="ob-step ob-email" data-analytics-public onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>Let’s connect your email.</Bubble>,
          <Bubble>
            I can help you read, sort and draft.
            <br />
            I’ll only send when you ask.
          </Bubble>,
        ]}
      />
      <Rise show={revealed >= 3} className="ob-email-card">
        <div className="ob-email-gmail" data-gmail={gmailState}>
          <div className="ob-email-head">
            <span className="ob-email-tile">
              <img src="/logos/gmail.svg" alt="" width={24} height={24} />
            </span>
            <div className="ob-email-title">
              <p className="ob-email-name">Gmail</p>
              {account ? (
                <p className="ob-email-muted" data-analytics-private>
                  {account.accountEmail ?? 'Signed in.'}
                </p>
              ) : (
                <p className="ob-email-muted">Choose the inbox you want to connect.</p>
              )}
            </div>
            {connected ? (
              <span className="ob-email-chip">
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                Connected
              </span>
            ) : (
              gmailState !== 'waiting' && (
                <Button
                  className="ob-gmail-connect"
                  disabled={!canConnect || gmailState === 'opening'}
                  onClick={() => void connect()}
                >
                  {gmailState === 'opening' && (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  )}
                  {error ? 'Try again' : 'Connect Gmail'}
                </Button>
              )
            )}
          </div>
          {status}
          {pollFailing && (
            <p role="alert" className="ob-email-error">
              Can’t check on the sign-in right now. Still trying.
            </p>
          )}
          {error && (
            <p role="alert" className="ob-email-error" data-analytics-private>
              {error}
            </p>
          )}
        </div>
      </Rise>
      <Footer
        show={revealed >= 4}
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!connected || !!disconnections.length || !!recovering}
      />
    </section>
  );
}
