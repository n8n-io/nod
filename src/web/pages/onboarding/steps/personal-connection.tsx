import { useEffect, useRef, useState } from 'react';
import type { Configuration, Connection } from '../../../../shared/contracts';
import {
  onboardingCalendarProviders,
  onboardingEmailProviders,
  reconnectable,
} from '../../../../shared/onboarding';
import { ConnectRow, SignInActions, signInIssue } from '../../../components/connect-row';
import { ServiceLogo } from '../../../components/service-logo';
import { AppAccountManager } from '../../../components/app-account-manager';
import { Rise } from '../../../components/motion';
import { Button } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { useAppSignIn } from '../../../hooks/use-app-sign-in';
import { api, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { connectionGroups, connectionIssue, removeConnection } from '../../../lib/secondary-pages';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal } from '../motion';
import { ComposioMark, connectionSequence } from './connection-preview';

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

export function PersonalConnection({
  kind,
  providerSlugs,
  introduction,
  action,
  note,
  arrived,
  quiet,
  onNext,
  onBack,
  onSkip,
}: StepProps & {
  kind: 'email' | 'calendar';
  providerSlugs: readonly PersonalProvider[];
  introduction: string | ((accounts: Connection[]) => string);
  action: string;
  note: string;
}) {
  const { revealed, typing, done, skip } = useReveal(connectionSequence, {
    enabled: arrived === 'forward' && !quiet,
  });
  const configuration = usePageData<Configuration>('/api/configuration');
  const apps = usePageData<Connection[]>('/api/apps');
  const refreshApps = apps.refresh;
  const [reloading, setReloading] = useState(false);
  const [recovering, setRecovering] = useState<string>();
  const [manageService, setManageService] = useState<PersonalProvider>();
  const signIn = useAppSignIn({
    entry: 'onboarding',
    name: (service) => providerNames[service as PersonalProvider] ?? service,
    onSettled: () => void refreshApps(),
  });
  const { pending, error, setError, completed, setCompleted, attempt, cancel } = signIn;
  const provider = signIn.service as PersonalProvider | undefined;
  const request = useRef<AbortController | null>(null);
  const manageTrigger = useRef<HTMLButtonElement | null>(null);
  const manageCard = useRef<HTMLElement | null>(null);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);

  const providers = providerSlugs.map((slug) => {
    const accounts = apps.data?.filter((connection) => connection.slug === slug) ?? [];
    const service = accounts.find((connection) => connection.status !== 'not_configured');
    return {
      slug,
      service,
      account: accounts.find(ownedAccount),
      reconnect: accounts.find(reconnectable),
      disconnections: accounts.filter((connection) => connection.disconnectPending),
    };
  });
  const connected = providers.some((entry) => entry.account);
  const managed = connectionGroups(apps.data ?? []).find((group) => group.key === manageService);
  const loading = (!configuration.data && !configuration.error) || (!apps.data && !apps.error);
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
  const ready = Boolean(completed && canConnect(completed.service as PersonalProvider));

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

  function connect(
    slug: PersonalProvider,
    target?: Pick<PersonalTarget, 'connectionId' | 'managed'>,
  ) {
    if (request.current || !canConnect(slug)) return;
    void signIn.connect({
      service: slug,
      ...(target ?? {
        connectionId: providers.find((entry) => entry.slug === slug)?.reconnect?.connectionId,
      }),
    });
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
      analyticsForCurrentSession()('ui_error', { area: 'onboarding', action: 'disconnect' });
      throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current) setRecovering(undefined);
    }
  }

  async function retryDisconnection(connection: Connection) {
    signIn.setService(providerSlugs.find((slug) => slug === connection.slug));
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

  async function reload() {
    setReloading(true);
    await Promise.all([configuration.refresh(), refreshApps()]);
    if (active.current) setReloading(false);
  }

  return (
    <section className={`ob-step ob-${kind}`} onClick={done ? undefined : skip}>
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
        <div className="connect-rows">
          {providers.map(({ slug, service, account, reconnect, disconnections }) => {
            const name =
              kind === 'calendar' && slug === 'outlook' ? 'Outlook Calendar' : providerNames[slug];
            return (
              <ConnectRow
                key={slug}
                data-provider={slug}
                data-connected={Boolean(account)}
                logo={<ServiceLogo slug={slug} logoUrl={service?.logoUrl} size={28} />}
                name={name}
                details={[
                  (account ?? reconnect)?.accountEmail && (
                    <span data-analytics-private>{(account ?? reconnect)?.accountEmail}</span>
                  ),
                  !account && reconnect && connectionIssue(reconnect),
                  !loading && !service && !unavailable && 'Unavailable right now',
                ].filter(Boolean)}
                error={provider === slug ? signInIssue(signIn) || error : ''}
                actions={
                  pending && provider === slug ? (
                    <SignInActions
                      signIn={signIn}
                      onRestart={() => connect(slug, attempt.current)}
                    />
                  ) : account ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ob-personal-manage"
                      aria-label={`Manage ${name} accounts`}
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
                      aria-label={`${reconnect ? 'Reconnect' : 'Connect'} ${name}${reconnect ? '' : ' via Composio'}`}
                      disabled={!canConnect(slug) || Boolean(pending)}
                      onClick={() => connect(slug)}
                    >
                      {error && provider === slug ? (
                        'Try again'
                      ) : reconnect ? (
                        'Reconnect'
                      ) : (
                        <>
                          <ComposioMark />
                          {action}
                        </>
                      )}
                    </Button>
                  )
                }
              >
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
              </ConnectRow>
            );
          })}
        </div>
        {!connected && <p className="ob-personal-muted">{note}</p>}
        {unavailable && (
          <div className="ob-personal-retry">
            <p className="ob-personal-muted">{unavailable}</p>
            <Button variant="ghost" size="sm" disabled={reloading} onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        )}
        {error && !provider && (
          <p role="alert" className="connect-row-error" data-analytics-private>
            {error}
          </p>
        )}
      </Rise>
      <Footer
        show={revealed >= 3}
        onBack={onBack}
        onNext={onNext}
        skipLabel={`Continue without ${kind}`}
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
            connect(slug, {
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
