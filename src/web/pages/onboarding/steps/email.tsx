import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, LoaderCircle } from 'lucide-react';
import type { AppSetupStatus, Configuration, Connection } from '../../../../shared/contracts';
import {
  ConnectionChoice,
  connectionRoutes,
  useConnectionChoice,
} from '../../../components/connection-choice';
import { Rise } from '../../../components/motion';
import { PairingCode } from '../../../components/pairing-code';
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
  if (result === 'failed' || result === 'expired') return 'Gmail didn’t connect. Try again?';
  return '';
}

export function Email({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const configuration = usePageData<Configuration>('/api/configuration');
  const apps = usePageData<Connection[]>('/api/apps');
  const refreshApps = apps.refresh;
  const [reloading, setReloading] = useState(false);
  const [pending, setPending] = useState<'opening' | 'waiting'>();
  const [pairingCode, setPairingCode] = useState<string>();
  const [pairingConfirmed, setPairingConfirmed] = useState(false);
  const [signInUrl, setSignInUrl] = useState<string>();
  const [stale, setStale] = useState(false);
  const [pollFailing, setPollFailing] = useState(false);
  const [error, setError] = useState('');
  const choice = useConnectionChoice('onboarding', () => setError(''));
  const keyStatus = choice.status;
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<string | undefined>(undefined);
  const active = useRef(false);

  function clearAttempt() {
    attempt.current = undefined;
    setPairingCode(undefined);
    setSignInUrl(undefined);
    setStale(false);
    setPollFailing(false);
  }

  useEffect(() => {
    active.current = true;
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('otto.apps');
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
        if (!app) {
          settle('failed');
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
      poll = window.setTimeout(
        () => {
          void check().finally(() => {
            if (current()) schedule();
          });
        },
        pairingCode && !confirmed ? 1000 : 5000,
      );
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
  const account = gmail.find((connection) => connection.status === 'connected');
  const connected = !!account;
  const keyNeeded = !!keyStatus && choice.mode !== keyStatus.mode;
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
  const canConnect =
    !loading &&
    !unavailable &&
    !keyNeeded &&
    choice.ready &&
    !choice.switching &&
    !choice.signingIn;

  async function connect() {
    if (request.current || !canConnect) return;
    const capture = analyticsForCurrentSession();
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open('', 'otto-connect-gmail', 'popup,width=520,height=720');
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
      const response = await api<{ url: string; attempt?: string; pairingCode?: string }>(
        '/api/apps/gmail/connect',
        {
          method: 'POST',
          body: JSON.stringify({ returnTo: 'window' }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      const url = connectionUrl(response.url, window.location.origin);
      if (response.pairingCode !== undefined && !/^\d{3}-\d{3}$/.test(response.pairingCode))
        throw new Error('Gmail didn’t connect. Try again?');
      if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
        throw new Error('Gmail didn’t connect. Try again?');
      attempt.current = response.attempt;
      flushSync(() => {
        setPairingCode(response.pairingCode);
        setSignInUrl(url);
      });
      next = 'waiting';
      if (external) await openConnection(url);
      else if (popup && !popup.closed) popup.location.href = url;
    } catch (cause) {
      popup?.close();
      clearAttempt();
      if (!controller.signal.aborted) {
        setError(errorMessage(cause));
        capture('otto_ui_error', { area: 'onboarding', action: 'connect' });
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setPending(attempt.current ? next : undefined);
      }
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
    await Promise.all([configuration.refresh(), refreshApps(), choice.reload()]);
    if (active.current) setReloading(false);
  }

  const gmailState = connected ? 'connected' : (pending ?? 'idle');
  let status;
  if (account)
    status = (
      <p className="ob-email-done">
        {account.accountEmail ? (
          <>
            Signed in as <strong data-analytics-private>{account.accountEmail}</strong>
          </>
        ) : (
          'Signed in.'
        )}
      </p>
    );
  else if (gmailState === 'waiting')
    status = (
      <div className="ob-email-waiting">
        <LoaderCircle size={18} className="spin" aria-hidden="true" />
        <p>
          {stale ? 'Didn’t finish signing in?' : 'Finish signing in in your browser.'}{' '}
          {signInUrl && !pairingConfirmed && (
            <a href={signInUrl} target="_blank" rel="noreferrer">
              Open sign-in
            </a>
          )}
        </p>
        {stale && (
          <Button variant="outline" size="sm" onClick={() => void connect()}>
            Start again
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  else if (loading) status = <p className="ob-email-muted">Checking app connections…</p>;
  else if (keyNeeded)
    status = (
      <p className="ob-email-muted">
        {choice.mode === 'own'
          ? 'Save your Composio key first.'
          : 'Enable Easy Connect and confirm the switch first.'}
      </p>
    );
  else if (keyStatus?.mode === 'otto' && !choice.ready)
    status = (
      <p className="ob-email-muted">Enable Easy Connect above, then connect Gmail separately.</p>
    );
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
    status = (
      <div className="ob-email-notes">
        <p>
          {keyStatus?.mode === 'otto'
            ? 'Google will ask you to sign in to Composio, the service Otto uses to connect apps.'
            : 'Google will ask you to sign in and allow access to your inbox.'}
        </p>
        {keyStatus && !keyStatus.switchable && (
          <p className="ob-email-muted">{connectionRoutes[keyStatus.mode]}</p>
        )}
      </div>
    );

  return (
    <section className="ob-step ob-email" data-analytics-public>
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>Let’s connect your email.</Bubble>,
          <Bubble>
            It’s where a lot of your work happens, so it’s the quickest way for me to learn how you
            work. I can read, sort and draft, and I won’t send anything unless you ask.
          </Bubble>,
        ]}
      />
      <Rise show={revealed >= 3} className="ob-email-card">
        <ConnectionChoice state={choice} disabled={!!pending} className="ob-email-choice" />
        <div className="ob-email-gmail" data-gmail={gmailState}>
          <div className="ob-email-head">
            <span className="ob-email-tile">
              <img src="/logos/gmail.svg" alt="" width={24} height={24} />
            </span>
            <div className="ob-email-title">
              <p className="ob-email-name">Gmail</p>
              <p className="ob-email-muted">Start with one inbox. You can add more apps later.</p>
            </div>
            {connected ? (
              <span className="ob-email-chip">
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                Connected
              </span>
            ) : (
              gmailState !== 'waiting' && (
                <Button
                  variant="outline"
                  className="ob-gmail-connect"
                  disabled={!canConnect || gmailState === 'opening'}
                  onClick={() => void connect()}
                >
                  {gmailState === 'opening' && (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  )}
                  Connect
                </Button>
              )
            )}
          </div>
          {!connected && pairingCode && !pairingConfirmed && <PairingCode code={pairingCode} />}
          {status}
          {pollFailing && (
            <p role="alert" className="ob-email-error">
              Can’t check on the sign-in right now. Still trying.
            </p>
          )}
          {error && (
            <p role="alert" className="ob-email-error">
              {error}
            </p>
          )}
        </div>
      </Rise>
      <Footer
        show={revealed >= 4}
        onBack={onBack}
        onSkip={connected ? undefined : onNext}
        onNext={onNext}
        nextDisabled={!connected}
      />
    </section>
  );
}
