import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ExternalLink, LoaderCircle } from 'lucide-react';
import type { Configuration, Connection } from '../../../../shared/contracts';
import type { IntegrationKeyStatus } from '../../../../shared/integrations';
import { Button, Input } from '../../../components/ui';
import { useDesktopSettings } from '../../../components/desktop-settings';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage, post } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { connectionUrl } from '../../../lib/connection-url';
import {
  applyDesktopSettings,
  desktopLinksAvailable,
  desktopSettingsAvailable,
  openConnection,
} from '../../../lib/desktop';
import { pageDataCache } from '../../../lib/page-data-cache';
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

function Badge({ state, children }: { state: 'idle' | 'active' | 'done'; children: string }) {
  return (
    <span className="ob-email-badge" data-state={state} aria-hidden="true">
      {state === 'done' ? <Check size={14} strokeWidth={3} /> : children}
    </span>
  );
}

export function Email({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const desktop = desktopSettingsAvailable();
  const native = useDesktopSettings(desktop);
  const { data: configuration } = usePageData<Configuration>('/api/configuration');
  const { data: apps, refresh: refreshApps } = usePageData<Connection[]>('/api/apps');
  const [local, setLocal] = useState<IntegrationKeyStatus | null>(null);
  const [explain, setExplain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [pending, setPending] = useState<'opening' | 'waiting'>();
  const [error, setError] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const attempt = useRef<string | undefined>(undefined);
  const active = useRef(false);
  const mode = desktop
    ? 'desktop'
    : configuration && (configuration.localOnly ? 'local' : 'hosted');

  useEffect(() => {
    if (mode !== 'local') return;
    let current = true;
    api<IntegrationKeyStatus>('/api/integrations/key')
      .then((value) => current && setLocal(value))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [mode]);

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
        setError(connectionMessage(connection ?? null));
        settle();
        void refreshApps();
      };
    window.addEventListener('focus', settle);
    return () => {
      active.current = false;
      channel?.close();
      window.removeEventListener('focus', settle);
      request.current?.abort();
      attempt.current = undefined;
    };
  }, []);

  const status =
    mode === 'desktop'
      ? native.settings && {
          saved: native.settings.hasComposioKey,
          suffix: native.settings.keys.composioApiKey.suffix,
          editable: true,
        }
      : mode === 'hosted'
        ? { saved: !!configuration?.integrationsReady, suffix: null, editable: false }
        : mode === 'local' && local
          ? { saved: local.managed || local.saved, suffix: local.suffix, editable: !local.managed }
          : null;
  const keyDone = !!status?.saved && !editing;
  const restartRequired = mode === 'desktop' && !!native.settings?.restartRequired;
  const gmail = apps?.filter((connection) => connection.slug === 'gmail') ?? [];
  const account = gmail.find((connection) => connection.status === 'connected');
  const connected = !!account;
  const canConnect =
    keyDone &&
    !restartRequired &&
    !!configuration?.integrationsReady &&
    gmail.some((connection) => connection.status !== 'not_configured');

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    const value = key.trim();
    if (!value) {
      setKeyError('Paste your Composio key first.');
      return;
    }
    const capture = analyticsForCurrentSession();
    setChecking(true);
    setKeyError('');
    try {
      if (mode === 'desktop') {
        await post('/api/integrations/key/check', { key: value });
        const saved = await native.save({ composioApiKey: value });
        if (saved.restartRequired) await applyDesktopSettings().catch(() => {});
      } else {
        await api('/api/integrations/key', { method: 'PUT', body: JSON.stringify({ key: value }) });
        const next = await api<IntegrationKeyStatus>('/api/integrations/key');
        if (active.current) setLocal(next);
        await Promise.all([
          pageDataCache.refresh('/api/configuration', true),
          pageDataCache.refresh('/api/apps', true),
        ]);
      }
      if (!active.current) return;
      setKey('');
      setEditing(false);
      setExplain(false);
    } catch (cause) {
      if (!active.current) return;
      setKeyError(errorMessage(cause));
      capture('otto_ui_error', { area: 'onboarding', action: 'save' });
    } finally {
      if (active.current) setChecking(false);
    }
  }

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
    setError('');
    let next: 'opening' | 'waiting' | undefined;
    try {
      const response = await api<{ url: string; attempt?: string }>('/api/apps/gmail/connect', {
        method: 'POST',
        body: JSON.stringify({ returnTo: popup || external ? 'window' : 'onboarding' }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      const url = connectionUrl(response.url, window.location.origin);
      if (external || popup) {
        if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
          throw new Error('Gmail didn’t connect. Try again?');
        attempt.current = response.attempt;
      }
      if (external) {
        await openConnection(url);
        next = 'waiting';
      } else if (!popup) {
        next = 'opening';
        window.location.assign(url);
      } else if (!popup.closed) {
        next = 'waiting';
        popup.location.href = url;
      }
    } catch (cause) {
      popup?.close();
      if (!controller.signal.aborted) {
        setError(errorMessage(cause));
        capture('otto_ui_error', { area: 'onboarding', action: 'connect' });
      }
    } finally {
      if (next !== 'opening' && request.current === controller) {
        request.current = null;
        if (active.current) setPending(next);
      }
    }
  }

  function cancel() {
    request.current?.abort();
    request.current = null;
    attempt.current = undefined;
    setPending(undefined);
  }

  function change() {
    setEditing(true);
    setKeyError('');
    requestAnimationFrame(() => keyInput.current?.focus());
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
          <Badge state={keyDone ? 'done' : 'active'}>1</Badge>
          <div className="ob-email-body">
            <div className="ob-email-label">
              <p>Paste your Composio key</p>
              {status?.editable !== false && (
                <button
                  type="button"
                  className="ob-email-link"
                  aria-expanded={explain}
                  onClick={() => setExplain((value) => !value)}
                >
                  What’s this?
                </button>
              )}
            </div>
            {explain && (
              <div className="ob-email-explain">
                <p>
                  Composio is how I sign in to apps like Gmail, Calendar and Slack for you. I never
                  see your passwords, and you can take away access anytime.
                </p>
                <p>
                  Make a free account, copy your API key from its Settings and paste it here. It
                  takes about a minute.
                </p>
                <a href="https://app.composio.dev" target="_blank" rel="noreferrer">
                  Open Composio
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </div>
            )}
            {status?.editable && !keyDone && (
              <>
                <form className="ob-email-form" onSubmit={(event) => void saveKey(event)}>
                  <Input
                    ref={keyInput}
                    type="password"
                    value={key}
                    placeholder="ak_…"
                    aria-label="Composio API key"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={16384}
                    disabled={checking}
                    data-analytics-private
                    onChange={(event) => {
                      setKey(event.target.value);
                      setKeyError('');
                    }}
                  />
                  <Button type="submit" variant="outline" disabled={checking}>
                    {checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
                    {checking ? 'Checking' : 'Save'}
                  </Button>
                </form>
                {keyError && (
                  <p role="alert" className="ob-email-error" data-analytics-private>
                    {keyError}
                  </p>
                )}
                <p className="ob-email-muted">
                  It’s encrypted, stays on this computer and never goes to AI providers.
                </p>
              </>
            )}
            {keyDone && (
              <div className="ob-email-saved">
                {status?.editable ? (
                  <>
                    <span className="ob-mono" data-analytics-private>
                      Key saved{status.suffix ? ` · ••••${status.suffix}` : ''}
                    </span>
                    <button type="button" className="ob-email-change" onClick={change}>
                      Change
                    </button>
                  </>
                ) : (
                  <span>Already set up for you.</span>
                )}
              </div>
            )}
            {status && !status.saved && !status.editable && (
              <p className="ob-email-muted">
                Apps aren’t set up here yet. Ask your Otto admin, or skip this for now.
              </p>
            )}
          </div>
        </div>
        <div className="ob-email-step">
          <Badge state={connected ? 'done' : keyDone ? 'active' : 'idle'}>2</Badge>
          <div className="ob-email-body" data-gmail={gmailState}>
            <div className="ob-email-label">
              <p>Sign in to Gmail</p>
            </div>
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
                  {!keyDone
                    ? 'Save your Composio key first.'
                    : restartRequired
                      ? 'Restart Otto to start using your key.'
                      : 'Opens Google in your browser.'}
                </p>
                {restartRequired && keyDone && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void applyDesktopSettings().catch(() => {})}
                  >
                    Restart now
                  </Button>
                )}
              </div>
            ) : gmailState === 'waiting' ? (
              <div className="ob-email-waiting">
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
                <p>Finish signing in to Google in your browser.</p>
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
              <p role="alert" className="ob-email-error" data-analytics-private>
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
