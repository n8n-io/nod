import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AppSetupStatus, Configuration, Connection } from '../../../../shared/contracts';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { connectionUrl } from '../../../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../../../lib/desktop';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, Rise, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [
  { typing: 450 },
  { wait: 300, typing: 550 },
  { wait: 200 },
  { wait: 200 },
];

const outcomes = ['connected', 'cancelled', 'failed', 'expired'];

function connectionMessage(result: string | null) {
  if (result === 'cancelled') return 'Sign-in cancelled. You can try again.';
  if (result === 'failed' || result === 'expired') return 'Gmail didn’t connect. Try again?';
  return '';
}

export function Email({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const { data: configuration } = usePageData<Configuration>('/api/configuration');
  const { data: apps, refresh: refreshApps } = usePageData<Connection[]>('/api/apps');
  const [pending, setPending] = useState<'opening' | 'waiting'>();
  const [pairingCode, setPairingCode] = useState<string>();
  const [signInUrl, setSignInUrl] = useState<string>();
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<string | undefined>(undefined);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const result = new URLSearchParams(window.location.search).get('connection');
    setError(connectionMessage(result));
    if (result) window.history.replaceState(null, '', window.location.pathname);
    const settle = () => setPending((current) => (current === 'waiting' ? undefined : current));
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
        attempt.current = undefined;
        setPairingCode(undefined);
        setSignInUrl(undefined);
        setError(connectionMessage(connection ?? null));
        settle();
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
    const current = () => !controller.signal.aborted && attempt.current === currentAttempt;
    const settle = (result: 'connected' | 'failed' | 'expired') => {
      if (!current()) return;
      controller.abort();
      attempt.current = undefined;
      setPairingCode(undefined);
      setSignInUrl(undefined);
      setPending(undefined);
      setError(connectionMessage(result));
      void refreshApps();
    };
    const check = async () => {
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signInUrl));
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        const result = await api<AppSetupStatus>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({ hashes: [hash] }),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!current()) return false;
        if (result.completed.includes(hash)) {
          settle('connected');
          return true;
        }
        if (!result.apps.some((app) => app.hash === hash)) {
          settle('failed');
          return true;
        }
      } catch {}
      return false;
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    visible();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setTimeout(() => {
      void check().then((settled) => {
        if (!settled) settle('expired');
      });
    }, 10 * 60_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [signInUrl, refreshApps]);

  const gmail = apps?.filter((connection) => connection.slug === 'gmail') ?? [];
  const account = gmail.find((connection) => connection.status === 'connected');
  const connected = !!account;
  const canConnect =
    !!configuration?.integrationsReady &&
    gmail.some((connection) => connection.status !== 'not_configured');

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
    attempt.current = undefined;
    setPending('opening');
    setPairingCode(undefined);
    setSignInUrl(undefined);
    setError('');
    let next: 'opening' | 'waiting' | undefined;
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
      setPairingCode(response.pairingCode);
      setSignInUrl(url);
      if (external) {
        await openConnection(url);
        next = 'waiting';
      } else {
        next = 'waiting';
        if (popup && !popup.closed) popup.location.href = url;
      }
    } catch (cause) {
      popup?.close();
      attempt.current = undefined;
      setPairingCode(undefined);
      setSignInUrl(undefined);
      if (!controller.signal.aborted) {
        setError(errorMessage(cause));
        capture('otto_ui_error', { area: 'onboarding', action: 'connect' });
      }
    } finally {
      if (next !== 'opening' && request.current === controller) {
        request.current = null;
        if (active.current) setPending(attempt.current ? next : undefined);
      }
    }
  }

  function cancel() {
    request.current?.abort();
    request.current = null;
    attempt.current = undefined;
    setPending(undefined);
    setPairingCode(undefined);
    setSignInUrl(undefined);
  }

  const gmailState = connected ? 'connected' : (pending ?? 'idle');
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
        <div className="ob-email-head">
          <span className="ob-email-tile">
            <img src="/logos/gmail.svg" alt="" width={24} height={24} />
          </span>
          <div className="ob-email-title">
            <p className="ob-email-name">Gmail</p>
            <p className="ob-email-muted">Start with one inbox. You can add more apps later.</p>
          </div>
          {connected && (
            <span className="ob-email-chip">
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
              Connected
            </span>
          )}
        </div>
        <div className="ob-email-step">
          <div className="ob-email-body" data-gmail={gmailState}>
            <div className="ob-email-label">
              <p>Sign in to Gmail</p>
            </div>
            {pairingCode && !connected && (
              <p className="ob-email-muted">
                Confirm the same code in your browser:{' '}
                <strong data-analytics-private>{pairingCode}</strong>.{' '}
              </p>
            )}
            {gmailState === 'idle' || gmailState === 'opening' ? (
              <div className="ob-email-connect">
                <Button
                  variant="outline"
                  className="ob-gmail-connect"
                  disabled={!canConnect || gmailState === 'opening'}
                  onClick={() => void connect()}
                >
                  {gmailState === 'opening' ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <img src="/logos/gmail.svg" alt="" width={16} height={16} />
                  )}
                  Connect Gmail
                </Button>
                <p className="ob-email-muted">
                  {configuration && !configuration.integrationsReady
                    ? 'App connections are unavailable. Try again later or skip this step.'
                    : 'Opens Google in your browser.'}
                </p>
              </div>
            ) : gmailState === 'waiting' ? (
              <div className="ob-email-waiting">
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
                <p>
                  Finish signing in to Google in your browser.{' '}
                  {signInUrl && (
                    <a href={signInUrl} target="_blank" rel="noreferrer">
                      Open sign-in
                    </a>
                  )}
                </p>
                <Button variant="ghost" size="sm" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            ) : (
              <p className="ob-email-done">
                {account?.accountEmail ? (
                  <>
                    Signed in as <strong data-analytics-private>{account.accountEmail}</strong>
                  </>
                ) : (
                  'Signed in.'
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="ob-email-error">
                {error}
              </p>
            )}
          </div>
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
