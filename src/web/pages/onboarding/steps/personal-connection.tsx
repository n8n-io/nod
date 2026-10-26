import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { LoaderCircle } from '../../../components/icons';
import type { AppSetupStatus, Configuration, Connection } from '../../../../shared/contracts';
import {
  onboardingCalendarProviders,
  onboardingEmailProviders,
} from '../../../../shared/onboarding';
import { ServiceLogo } from '../../../components/service-logo';
import { AppAccountManager } from '../../../components/app-account-manager';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { cancelSetup, connectionUrl, setupLinkHash } from '../../../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../../../lib/desktop';
import { connectionGroups, connectionIssue, removeConnection } from '../../../lib/secondary-pages';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [{ typing: 450 }, { wait: 200 }, { wait: 200 }];

const outcomes = ['connected', 'cancelled', 'failed', 'expired'];

type PersonalProvider =
  (typeof onboardingEmailProviders)[number] | (typeof onboardingCalendarProviders)[number];
type PersonalTarget = { service: PersonalProvider; connectionId?: string; managed?: boolean };
const providerNames: Record<PersonalProvider, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  googlecalendar: 'Google Calendar',
};

function ownedAccount(connection: Connection) {
  return (
    !connectionIssue(connection) &&
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending
  );
}

function connectionMessage(service: PersonalProvider, result?: string) {
  if (result === 'cancelled') return 'Sign-in cancelled. You can try again.';
  if (result === 'expired')
    return 'This sign-in link is no longer active. Try again with a new window.';
  if (result === 'failed')
    return `${providerNames[service]} didn’t connect. Try again with a new sign-in window.`;
  return '';
}

export function PersonalConnection({
  kind,
  providerSlugs,
  introduction,
  benefit,
  arrived,
  onNext,
  onBack,
  onSkip,
  onReady,
}: StepProps & {
  kind: 'email' | 'calendar';
  providerSlugs: readonly PersonalProvider[];
  introduction: string | ((accounts: Connection[]) => string);
  benefit: string;
}) {
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
  const [completed, setCompleted] = useState<PersonalTarget>();
  const [provider, setProvider] = useState<PersonalProvider>();
  const [manageService, setManageService] = useState<PersonalProvider>();
  const request = useRef<AbortController | null>(null);
  const signInWindow = useRef<Window | null>(null);
  const attempt = useRef<(PersonalTarget & { id: string }) | undefined>(undefined);
  const manageTrigger = useRef<HTMLButtonElement | null>(null);
  const manageCard = useRef<HTMLElement | null>(null);
  const active = useRef(false);
  const readyReported = useRef(false);

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
        const { connection, service, attempt: value } = event.data ?? {};
        if (
          !attempt.current ||
          service !== attempt.current.service ||
          !value ||
          attempt.current.id !== value ||
          !outcomes.includes(connection ?? '')
        )
          return;
        const selected = attempt.current;
        clearAttempt();
        setCompleted(connection === 'connected' ? selected : undefined);
        setError(connectionMessage(selected.service, connection));
        setPending((current) => (current === 'waiting' ? undefined : current));
        void refreshApps();
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
      setCompleted(result === 'connected' ? currentAttempt : undefined);
      setPending(undefined);
      setError(connectionMessage(currentAttempt.service, result));
      void refreshApps();
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
  }, [signInUrl, provider, refreshApps]);

  const providers = providerSlugs.map((slug) => {
    const accounts = apps.data?.filter((connection) => connection.slug === slug) ?? [];
    const service = accounts.find((connection) => connection.status !== 'not_configured');
    return {
      slug,
      service,
      account: accounts.find(ownedAccount),
      reconnect: accounts.find(
        (connection) =>
          connection.connectionId &&
          connection.accountId &&
          !connection.disconnectPending &&
          connection.canReconnect &&
          (connection.status === 'disconnected' || connection.reconnectRequired),
      ),
      disconnections: accounts.filter((connection) => connection.disconnectPending),
    };
  });
  const connected = providers.some((entry) => entry.account);
  const managed = connectionGroups(apps.data ?? []).find((group) => group.key === manageService);
  const loading = (!configuration.data && !configuration.error) || (!apps.data && !apps.error);
  useEffect(() => {
    if (!readyReported.current && !loading && onReady) {
      readyReported.current = true;
      onReady();
    }
  }, [loading, onReady]);
  const unavailable = loading
    ? ''
    : !configuration.data || !apps.data
      ? 'Couldn’t check your app connections.'
      : !configuration.data.integrationsReady
        ? `${kind === 'email' ? 'Email' : 'Calendar'} connections aren’t available right now.`
        : '';
  const canConnect = (slug: PersonalProvider) => {
    const entry = providers.find((item) => item.slug === slug)!;
    return (
      !entry.disconnections.length &&
      !recovering &&
      !loading &&
      !unavailable &&
      Boolean(entry.service && entry.service.status !== 'not_configured')
    );
  };
  const confirmed =
    completed &&
    apps.data?.find(
      (account) =>
        account.slug === completed.service &&
        (!completed.connectionId || account.connectionId === completed.connectionId) &&
        ownedAccount(account),
    );
  const ready = Boolean(completed && canConnect(completed.service));

  useEffect(() => {
    if (
      arrived !== 'forward' ||
      !completed ||
      completed.managed ||
      !confirmed ||
      !ready ||
      pending ||
      apps.refreshing ||
      apps.error
    )
      return;
    setCompleted(undefined);
    onNext();
  }, [arrived, completed, confirmed, ready, pending, apps.refreshing, apps.error, onNext]);

  async function connect(
    slug: PersonalProvider,
    target?: Pick<PersonalTarget, 'connectionId' | 'managed'>,
  ) {
    if (request.current || !canConnect(slug)) return;
    const { connectionId, managed: managing } = target ?? {
      connectionId: providers.find((entry) => entry.slug === slug)?.reconnect?.connectionId,
    };
    const capture = analyticsForCurrentSession();
    capture('nod_app_connect_clicked', { entry: 'onboarding', result: 'opened' });
    clearAttempt();
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open(
          `/connection-loading.html?service=${slug}`,
          `nod-connect-${slug}`,
          'popup,width=520,height=720',
        );
    try {
      if (popup) popup.opener = null;
    } catch {}
    const controller = new AbortController();
    request.current = controller;
    controller.signal.addEventListener('abort', () => popup?.close(), { once: true });
    signInWindow.current = popup;
    setProvider(slug);
    setPending('opening');
    setPairingConfirmed(false);
    setError('');
    let next: 'waiting' | undefined;
    try {
      const response = await api<{ url: string; attempt?: string }>(`/api/apps/${slug}/connect`, {
        method: 'POST',
        body: JSON.stringify({ returnTo: external ? 'desktop' : 'window', connectionId }),
      });
      if (controller.signal.aborted) {
        cancelSetup(connectionUrl(response.url, window.location.origin));
        throw new DOMException('Cancelled.', 'AbortError');
      }
      const url = connectionUrl(response.url, window.location.origin);
      if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
        throw new Error(connectionMessage(slug, 'failed'));
      attempt.current = { id: response.attempt, service: slug, connectionId, managed: managing };
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
      if (controller.signal.aborted || request.current !== controller) return;
      clearAttempt();
      setError(errorMessage(cause));
      capture('nod_ui_error', { area: 'onboarding', action: 'connect' });
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (active.current) setPending(attempt.current ? next : undefined);
      }
    }
  }

  async function disconnect(connection: Connection) {
    const id = connection.connectionId;
    if (!id || request.current || recovering || pending) return;
    const controller = new AbortController();
    request.current = controller;
    setRecovering(id);
    setError('');
    try {
      await api(
        `/api/apps/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(id)}/disconnect`,
        {
          method: 'POST',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (controller.signal.aborted) return;
      apps.update((current) => (current ? removeConnection(current, id) : current));
      if (managed?.accounts.length === 1) setManageService(undefined);
      void refreshApps();
    } catch (cause) {
      if (controller.signal.aborted) return;
      void refreshApps();
      analyticsForCurrentSession()('nod_ui_error', { area: 'onboarding', action: 'disconnect' });
      throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current) setRecovering(undefined);
    }
  }

  async function retryDisconnection(connection: Connection) {
    setProvider(providerSlugs.find((slug) => slug === connection.slug));
    try {
      await disconnect(connection);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    }
  }

  function restoreFocus() {
    const target = manageTrigger.current?.isConnected
      ? manageTrigger.current
      : manageCard.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    target?.focus({ preventScroll: true });
  }

  function cancel() {
    if (signInUrl) cancelSetup(signInUrl);
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

  return (
    <section
      className={`ob-step ob-${kind}`}
      data-analytics-public
      onClick={done ? undefined : skip}
    >
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>
            {typeof introduction === 'function'
              ? introduction(apps.data?.filter(ownedAccount) ?? [])
              : introduction}
          </Bubble>,
        ]}
      />
      <Rise show={revealed >= 2} className="ob-personal-choices">
        <p className="ob-personal-benefits">{benefit}</p>
        <div className="ob-personal-providers">
          {providers.map(({ slug, service, account, reconnect, disconnections }) => (
            <div
              className="ob-personal-provider"
              key={slug}
              data-provider={slug}
              data-connected={Boolean(account)}
            >
              <ServiceLogo slug={slug} logoUrl={service?.logoUrl} size={28} />
              <div className="ob-personal-identity">
                <span className="ob-personal-name">
                  {kind === 'calendar' && slug === 'outlook'
                    ? 'Outlook Calendar'
                    : providerNames[slug]}
                </span>
                {(account ?? reconnect)?.accountEmail && (
                  <span className="ob-personal-muted" data-analytics-private>
                    {(account ?? reconnect)?.accountEmail}
                  </span>
                )}
                {!account && reconnect && (
                  <span className="ob-personal-muted">{connectionIssue(reconnect)}</span>
                )}
                {!loading && !service && !unavailable && (
                  <span className="ob-personal-muted">Unavailable right now</span>
                )}
                {pending && provider === slug && (
                  <div className="ob-personal-waiting" role={pollFailing ? 'alert' : 'status'}>
                    <LoaderCircle size={14} className="spin" aria-hidden="true" />
                    <p>
                      {pending === 'opening'
                        ? 'Opening sign-in…'
                        : pollFailing
                          ? 'Can’t check sign-in right now.'
                          : 'Waiting for sign-in…'}
                    </p>
                  </div>
                )}
                {error && provider === slug && (
                  <p role="alert" className="ob-personal-error" data-analytics-private>
                    {error}
                  </p>
                )}
              </div>
              {pending && provider === slug ? (
                <div
                  className="ob-personal-actions"
                  data-recovery={stale || pollFailing || pending === 'waiting' ? true : undefined}
                >
                  <Button variant="ghost" size="sm" onClick={cancel}>
                    Cancel
                  </Button>
                  {stale || pollFailing || (pending === 'waiting' && signInOpened) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void connect(slug, attempt.current)}
                    >
                      Start again
                    </Button>
                  ) : pending === 'waiting' && signInUrl && !pairingConfirmed && !signInOpened ? (
                    <Button variant="secondary" size="sm" asChild>
                      <a
                        href={signInUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          if (
                            event.defaultPrevented ||
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          if (desktopLinksAvailable()) {
                            setSignInOpened(true);
                            return;
                          }
                          event.preventDefault();
                          const popup = window.open(
                            signInUrl,
                            `nod-connect-${slug}`,
                            'popup,width=520,height=720',
                          );
                          if (popup) popup.opener = null;
                          signInWindow.current = popup;
                          setSignInOpened(Boolean(popup && !popup.closed));
                        }}
                      >
                        Open sign-in
                      </a>
                    </Button>
                  ) : null}
                </div>
              ) : account ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ob-personal-manage"
                  aria-label={`Manage ${kind === 'calendar' && slug === 'outlook' ? 'Outlook Calendar' : providerNames[slug]} accounts`}
                  disabled={Boolean(pending || recovering)}
                  onClick={(event) => {
                    manageTrigger.current = event.currentTarget;
                    manageCard.current = event.currentTarget.closest('[data-provider]');
                    setError('');
                    setManageService(slug);
                  }}
                >
                  Manage
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`${reconnect ? 'Reconnect' : 'Connect'} ${kind === 'calendar' && slug === 'outlook' ? 'Outlook Calendar' : providerNames[slug]}`}
                  disabled={!canConnect(slug) || Boolean(pending)}
                  onClick={() => void connect(slug)}
                >
                  {error && provider === slug ? 'Try again' : reconnect ? 'Reconnect' : 'Connect'}
                </Button>
              )}
              {disconnections.map((connection) => (
                <div
                  className="ob-personal-retry"
                  key={connection.connectionId ?? connection.accountId}
                >
                  <p>Disconnection wasn’t confirmed.</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(recovering || pending || !connection.connectionId)}
                    onClick={() => void retryDisconnection(connection)}
                  >
                    {recovering === connection.connectionId ? 'Checking…' : 'Retry disconnection'}
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
        {unavailable && (
          <div className="ob-personal-retry">
            <p className="ob-personal-muted">{unavailable}</p>
            <Button variant="ghost" size="sm" disabled={reloading} onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}
        {error && !provider && (
          <p role="alert" className="ob-personal-error" data-analytics-private>
            {error}
          </p>
        )}
      </Rise>
      <Footer
        show={revealed >= 3}
        onBack={onBack}
        onNext={onNext}
        onSkip={
          connected
            ? undefined
            : () => {
                cancel();
                onSkip?.();
                onNext();
              }
        }
        nextDisabled={!connected || Boolean(pending || recovering)}
      />
      <AppAccountManager
        group={managed}
        suspended={Boolean(pending)}
        busy={Boolean(pending || recovering)}
        error={error}
        onDismissError={() => setError('')}
        onClose={() => setManageService(undefined)}
        onConnect={(account, addAccount) => {
          const slug = providerSlugs.find((value) => value === account.slug);
          if (slug)
            void connect(slug, {
              connectionId: addAccount ? undefined : account.connectionId,
              managed: true,
            });
        }}
        onDisconnect={disconnect}
        onRestoreFocus={restoreFocus}
      />
    </section>
  );
}
