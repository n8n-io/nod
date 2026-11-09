import { PageTitle } from '../components/page-title';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertCircle, ListFilter, MessageCircle, Plus, Users, X } from '../components/icons';
import type { AppSetupStatus, Configuration, Connection } from '../../shared/contracts';
import { SetupNotice } from '../components/setup-notice';
import { ServiceLogo } from '../components/service-logo';
import { AppConnectionDialog, type AppSignIn } from '../components/app-connection-dialog';
import { AppDiscoveryDialog } from '../components/app-discovery-dialog';
import { ManualMcpDialog } from '../components/manual-mcp-dialog';
import { IntegrationCard } from '../components/integration-card';
import { SearchPicker } from '../components/search-picker';
import { Tabs } from '../components/tabs';
import { Tooltip } from '../components/tooltip';
import { AppAccountManager } from '../components/app-account-manager';
import { api, ApiError, errorMessage } from '../lib/api';
import { connectionUrl, setupLinkHash } from '../lib/connection-url';
import { searchApps } from '../lib/app-search';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
import {
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
} from '../lib/secondary-pages';
import { usePageData } from '../hooks/use-page-data';
import {
  analyticsForCurrentSession,
  appConnectionAnalytics,
  captureAnalytics,
} from '../lib/analytics';
import { Button, Loading, Notice, SearchField } from '../components/ui';

function accountLabel(account: Connection) {
  const identity = connectionIdentity(account);
  return account.slug === 'notion' && identity.secondary
    ? `${identity.primary} · ${identity.secondary}`
    : (identity.secondary ?? identity.primary);
}

function categoryKey(value: string) {
  const key = value.trim().toLocaleLowerCase();
  if (key === 'calendar' || key === 'scheduling & booking') return 'calendar & scheduling';
  if (key === 'commerce' || key === 'e-commerce' || key === 'ecommerce') return 'commerce';
  return key;
}

function categoryLabel(value: string) {
  const label = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (label === 'model context protocol') return 'MCP servers';
  return `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)}`.replace(
    /\b(ai|api|crm|erp|hr|it|llm|mcp|pdf|seo|sms|sql|ui|url|ux)\b/gi,
    (word) => word.toUpperCase(),
  );
}

function hasCurrentAccount(group: { accounts: Connection[] }) {
  return group.accounts.some((account) => account.slug !== 'notion_mcp');
}

export function Apps({
  configuration,
  onAsk,
}: {
  configuration?: Configuration;
  onAsk(text: string): void;
}) {
  const {
    data: connections,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<Connection[]>('/api/apps');
  const {
    data: catalog,
    error: catalogError,
    status: catalogStatus,
    loading: catalogLoading,
    refreshing: catalogRefreshing,
    refresh: refreshCatalog,
  } = usePageData<Connection[]>('/api/apps/catalog');
  const tabsId = useId();
  const [view, setView] = useState<'all' | 'connected'>('all');
  const seen = useRef(false);
  useEffect(() => {
    if (seen.current) return;
    seen.current = true;
    captureAnalytics('tab_viewed', { page: 'apps', tab: view });
  }, []);
  const selectView = (next: typeof view) => {
    if (next !== view) captureAnalytics('tab_viewed', { page: 'apps', tab: next });
    setView(next);
  };
  useEffect(() => {
    if (loadError || (catalogError && catalogStatus !== 403))
      captureAnalytics('ui_error', { area: 'apps', action: 'load' });
  }, [loadError, catalogError, catalogStatus]);
  const [query, setQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(24);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState('');
  const [signIn, setSignIn] = useState<
    AppSignIn & {
      attempt?: string;
      error?: string;
      connection: Connection;
      entry: 'apps' | 'manage';
      addAccount: boolean;
      report(): void;
    }
  >();
  const [manualMcp, setManualMcp] = useState(false);
  const manualMcpTrigger = useRef<HTMLButtonElement>(null);
  const manualMcpOrigin = useRef<HTMLButtonElement | null>(null);
  const manualMcpAnalytics = useRef<ReturnType<typeof appConnectionAnalytics> | null>(null);
  function openManualMcp(trigger: HTMLButtonElement) {
    captureAnalytics('app_connect_clicked', { entry: 'apps', result: 'opened' });
    manualMcpAnalytics.current = appConnectionAnalytics('apps');
    manualMcpOrigin.current = trigger;
    setManualMcp(true);
  }
  const [manageService, setManageService] = useState<string | null>(null);
  const [pointerRestoredService, setPointerRestoredService] = useState<string | null>(null);
  const [discoveryId, setDiscoveryId] = useState(() =>
    new URLSearchParams(window.location.search).get('connect'),
  );
  useEffect(() => {
    const sync = () => setDiscoveryId(new URLSearchParams(window.location.search).get('connect'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const page = useRef<HTMLDivElement>(null);
  const catalogEnd = useRef<HTMLDivElement>(null);
  const appSearch = useRef<HTMLInputElement>(null);
  const manageTitle = useRef<HTMLHeadingElement>(null);
  const manageKeyboard = useRef(false);
  const dialogService = useRef('');
  const actionRequest = useRef<AbortController | null>(null);
  const locked = Boolean(busy);
  const groups = connectionGroups(connections ?? [], catalog ?? []).map((group) => ({
    ...group,
    name: group.service.name,
    slug: group.service.slug,
    description: group.service.description ?? '',
    category: (group.service.categories ?? []).join(' '),
  }));
  const managed = groups.find((group) => group.key === manageService);
  const categories = [
    ...new Set(groups.flatMap(({ service }) => (service.categories ?? []).map(categoryKey))),
  ].sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right)));
  const search = query.trim().toLocaleLowerCase();
  const filtered = searchApps(groups, query).filter(
    (group) =>
      !selectedCategories.length ||
      group.service.categories?.some((category) =>
        selectedCategories.includes(categoryKey(category)),
      ),
  );
  const connected = filtered.filter(hasCurrentAccount);
  const available = filtered.filter((group) => !hasCurrentAccount(group));
  const connectedCount = groups.filter(hasCurrentAccount).length;
  const hasFilters = Boolean(search || selectedCategories.length);
  const empty =
    view === 'connected' ? !connected.length : !filtered.length && !catalogLoading && !catalogError;
  function toggleCategory(category: string) {
    setSelectedCategories((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
    setVisibleCount(24);
  }
  function clearCategories() {
    setSelectedCategories([]);
    setVisibleCount(24);
  }
  function closeSignIn() {
    actionRequest.current?.abort();
    actionRequest.current = null;
    setBusy('');
    if (signIn?.outcome === 'connected') setAnnouncement(`${signIn.name} connected.`);
    setSignIn(undefined);
  }
  useEffect(() => {
    const target = catalogEnd.current;
    if (view !== 'all' || !target || visibleCount >= available.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleCount(available.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setVisibleCount((count) => Math.min(count + 24, available.length));
      },
      { rootMargin: '200px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [available.length, visibleCount, query, selectedCategories, view, connections]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('connection');
    if (!outcome) return;
    if (outcome !== 'connected' && outcome !== 'continued')
      setError(
        outcome === 'cancelled'
          ? 'Connection cancelled. Try again.'
          : 'The app could not connect. Try again.',
      );
    url.searchParams.delete('connection');
    url.searchParams.delete('service');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => () => actionRequest.current?.abort(), []);
  useEffect(() => {
    if (!signIn?.url || signIn.outcome) return;
    const url = signIn.url;
    const controller = new AbortController();
    let checking: Promise<boolean> | undefined;
    let poll: number | undefined;
    let pairingConfirmed = signIn.pairingConfirmed === true;
    const settle = (outcome: NonNullable<AppSignIn['outcome']>) => {
      if (controller.signal.aborted) return;
      controller.abort();
      if (outcome === 'connected') signIn.report();
      actionRequest.current?.abort();
      actionRequest.current = null;
      setBusy('');
      setSignIn((current) =>
        current?.url === url &&
        current.service === signIn.service &&
        current.attempt === signIn.attempt
          ? { ...current, outcome }
          : current,
      );
      void refresh();
    };
    const read = async () => {
      try {
        const hash = await setupLinkHash(url);
        const result = await api<AppSetupStatus>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({ hashes: [hash], pairingUrl: url }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          cache: 'no-store',
        });
        if (controller.signal.aborted) return false;
        if (!result.completed.includes(hash)) {
          const app = result.apps.find((app) => app.hash === hash);
          if (app && app.available !== false) {
            if (app.pairingConfirmed === true && !pairingConfirmed) {
              pairingConfirmed = true;
              setSignIn((current) =>
                !controller.signal.aborted &&
                current?.url === url &&
                current.service === signIn.service &&
                current.attempt === signIn.attempt
                  ? { ...current, pairingConfirmed: true }
                  : current,
              );
            }
            return false;
          }
          settle('unavailable');
          return true;
        }
        settle('connected');
        return true;
      } catch {
        return false;
      }
    };
    const check = () => {
      if (controller.signal.aborted) return Promise.resolve(false);
      checking ??= read().finally(() => {
        checking = undefined;
      });
      return checking;
    };
    const schedule = () => {
      poll = window.setTimeout(() => {
        void check().finally(() => {
          if (!controller.signal.aborted) schedule();
        });
      }, 5000);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    visible();
    schedule();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    const timeout = window.setTimeout(() => {
      void check().then((completed) => {
        if (completed || controller.signal.aborted) return;
        settle('unavailable');
      });
    }, 10 * 60_000);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nod.apps');
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{ service?: string; attempt?: string; connection?: string } | null>,
      ) => {
        if (
          controller.signal.aborted ||
          !signIn.attempt ||
          event.data?.attempt !== signIn.attempt ||
          event.data.service !== signIn.service ||
          !['connected', 'cancelled', 'failed', 'expired'].includes(event.data.connection ?? '')
        )
          return;
        if (event.data.connection === 'connected') {
          void check();
          return;
        }
        settle(
          event.data.connection === 'cancelled'
            ? 'cancelled'
            : event.data.connection === 'expired'
              ? 'unavailable'
              : 'failed',
        );
      };
    return () => {
      controller.abort();
      window.clearTimeout(poll);
      window.clearTimeout(timeout);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      channel?.close();
    };
  }, [signIn?.url, signIn?.service, signIn?.attempt, signIn?.outcome, refresh]);
  async function connect(
    connection: Connection,
    entry: 'apps' | 'manage',
    addAccount = false,
    restarting?: typeof signIn,
  ) {
    if (actionRequest.current || locked) return;
    const capture = analyticsForCurrentSession();
    const completion = appConnectionAnalytics(entry);
    capture('app_connect_clicked', { entry, result: 'opened' });
    const request = new AbortController();
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open('', 'nod-connect-app', 'popup,width=520,height=720');
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = 'Connect to Nod';
        popup.document.body.textContent = 'Preparing secure sign-in…';
      }
    } catch {}
    request.signal.addEventListener('abort', () => popup?.close(), { once: true });
    actionRequest.current = request;
    dialogService.current = connection.slug.replace(/_mcp$/, '');
    setBusy(
      !addAccount && connection.connectionId
        ? `reconnect:${connection.connectionId}`
        : `connect:${connection.slug}`,
    );
    setError('');
    setAnnouncement('');
    const context = {
      service: connection.slug,
      name: connection.name,
      logoUrl: connection.logoUrl,
      broker: !connection.direct && !connection.accessPaths?.length,
      accountLabel: !addAccount && connection.connectionId ? accountLabel(connection) : undefined,
      connection,
      entry,
      addAccount,
      opened: false,
      report: completion.complete,
    };
    setSignIn(context);
    try {
      const result = await api<{ url: string; attempt?: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify({
            returnTo: external ? 'desktop' : 'window',
            ...(restarting?.attempt ? { restartAttempt: restarting.attempt } : {}),
            ...(addAccount && connection.accessPaths?.length ? { newAccount: true } : {}),
            ...(!addAccount || connection.accessPaths?.length
              ? { connectionId: connection.connectionId }
              : {}),
          }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      const url = connectionUrl(result.url, window.location.origin);
      const proposal = new URL(url);
      if (
        proposal.origin === window.location.origin &&
        proposal.pathname === '/apps' &&
        proposal.searchParams.has('connect')
      ) {
        if (
          proposal.hash ||
          proposal.searchParams.size !== 1 ||
          !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
            proposal.searchParams.get('connect')!,
          )
        )
          throw new Error('The app sign-in could not be opened. Try again.');
        popup?.close();
        completion.transfer(proposal.searchParams.get('connect')!);
        window.history.pushState(null, '', `${proposal.pathname}${proposal.search}`);
        setDiscoveryId(proposal.searchParams.get('connect'));
        setManageService(null);
        setSignIn(undefined);
        setBusy('');
        return;
      }
      if (result.attempt !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result.attempt))
        throw new Error('The app sign-in could not be opened. Try again.');
      const pending = { ...context, url, attempt: result.attempt };
      flushSync(() => setSignIn(pending));
      let opened = false;
      if (external) {
        await openConnection(url);
        opened = true;
      } else if (popup && !popup.closed) {
        popup.location.href = url;
        opened = true;
      }
      if (request.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      setSignIn((current) =>
        !request.signal.aborted &&
        current?.url === pending.url &&
        current.attempt === pending.attempt
          ? { ...current, opened }
          : current,
      );
      setBusy('');
    } catch (cause) {
      popup?.close();
      if (request.signal.aborted || actionRequest.current !== request) return;
      setSignIn(
        restarting && cause instanceof ApiError && cause.status === 409
          ? restarting
          : { ...context, outcome: 'failed', error: errorMessage(cause) },
      );
      capture('ui_error', { area: 'apps', action: 'connect' });
      setBusy('');
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
    }
  }
  async function disconnect(connection: Connection) {
    if (!connection.connectionId || actionRequest.current || busy) return;
    const capture = analyticsForCurrentSession();
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(`disconnect:${connection.connectionId}`);
    try {
      await api(
        `/api/apps/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(connection.connectionId)}/disconnect`,
        {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
        },
      );
      if (request.signal.aborted) return;
      update((current) =>
        current ? removeConnection(current, connection.connectionId!) : current,
      );
      if (managed?.accounts.length === 1) setManageService(null);
      void refresh();
    } catch (cause) {
      if (request.signal.aborted) return;
      capture('ui_error', { area: 'apps', action: 'disconnect' });
      void refresh();
      throw cause;
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
      if (!request.signal.aborted) setBusy('');
    }
  }
  function restoreAppFocus() {
    const button = Array.from(
      page.current?.querySelectorAll<HTMLButtonElement>(
        '[data-manage-service],[data-connect-service]',
      ) ?? [],
    ).find(
      (candidate) =>
        candidate.dataset.manageService === dialogService.current ||
        candidate.dataset.connectService === dialogService.current,
    );
    setPointerRestoredService(
      !manageKeyboard.current && button?.dataset.manageService ? dialogService.current : null,
    );
    button?.focus({ preventScroll: true });
  }

  function cards(items: typeof groups, catalogCards = false) {
    return (
      <div className={catalogCards ? 'app-grid app-catalog-grid' : 'app-grid'}>
        {items.map(({ key, service, accounts }) => {
          const addAccount =
            accounts.find(
              (account) => account.slug === service.slug && account.status !== 'not_configured',
            ) ??
            (service.direct ? service : undefined) ??
            accounts.find((account) => account.status !== 'not_configured') ??
            service;
          const usableNotion =
            service.slug === 'notion' &&
            accounts.some((account) => account.slug === 'notion' && !connectionIssue(account));
          const issue = accounts.some(
            (account) =>
              !(usableNotion && account.slug === 'notion_mcp') && connectionIssue(account),
          );
          const connectLabel =
            service.slug === 'notion' && !usableNotion
              ? `Connect ${service.name}`
              : `Connect another ${service.name} account`;
          return (
            <IntegrationCard
              key={key}
              id={`app-${key}`}
              className="app-card"
              name={service.name}
              logo={<ServiceLogo {...service} />}
              description={service.description}
              badge={
                service.status === 'not_configured' && (
                  <Tooltip content="Sign-in unavailable">
                    <span className="app-card-attention">
                      <AlertCircle size={14} aria-label="Sign-in unavailable" />
                    </span>
                  </Tooltip>
                )
              }
              actions={
                accounts.length ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="app-manage"
                      data-manage-service={key}
                      data-pointer-restored={pointerRestoredService === key || undefined}
                      aria-label={`Manage ${service.name} accounts (${accounts.length})${issue ? ', sign-in required' : ''}`}
                      title={`${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}${issue ? ' · Sign-in required' : ''} · Manage accounts`}
                      onKeyDown={() => setPointerRestoredService(null)}
                      onBlur={() => setPointerRestoredService(null)}
                      onClick={(event) => {
                        dialogService.current = key;
                        manageKeyboard.current = event.detail === 0;
                        setPointerRestoredService(null);
                        setError('');
                        setManageService(key);
                      }}
                    >
                      <Users size={16} aria-hidden="true" />
                      <span className="app-account-count" aria-hidden="true">
                        {accounts.length > 99 ? '99+' : accounts.length}
                      </span>
                      {issue && <span className="app-account-attention" aria-hidden="true" />}
                    </Button>
                    {!addAccount.browserUrl && !addAccount.savedLogin && (
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={connectLabel}
                        title={connectLabel}
                        disabled={locked || addAccount.status === 'not_configured'}
                        onClick={() => void connect(addAccount, 'apps', true)}
                      >
                        <Plus size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="app-connect"
                    data-connect-service={key}
                    aria-label={`Connect ${service.name}`}
                    aria-busy={busy === `connect:${service.slug}`}
                    disabled={service.status === 'not_configured' || locked}
                    onClick={() => void connect(service, 'apps')}
                  >
                    {busy === `connect:${service.slug}` ? 'Opening…' : 'Connect'}
                  </Button>
                )
              }
            />
          );
        })}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page apps-page" ref={page}>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <header className="page-heading secondary-heading">
        <PageTitle path="/apps" />
        <Button
          ref={manualMcpTrigger}
          variant="outline"
          size="sm"
          onClick={(event) => openManualMcp(event.currentTarget)}
        >
          <Plus size={16} aria-hidden="true" />
          Connect MCP
        </Button>
      </header>
      {configuration && <SetupNotice configuration={configuration} />}
      {error && <Notice onDismiss={() => setError('')}>{error}</Notice>}
      {loadError && (
        <Notice>
          {loadError}{' '}
          {!connections && (
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
              Retry
            </Button>
          )}
        </Notice>
      )}
      {!connections ? (
        loading ? (
          <Loading label="Checking apps…" />
        ) : null
      ) : (
        <>
          <Tabs
            id={tabsId}
            panelId={`${tabsId}-panel`}
            className="apps-views"
            label="App views"
            value={view}
            items={[
              { value: 'all', label: 'All', count: groups.length },
              { value: 'connected', label: 'Connected', count: connectedCount },
            ]}
            onValueChange={(value) => {
              selectView(value);
              setVisibleCount(24);
            }}
          />
          <div className="app-catalog-search">
            <SearchField
              inputRef={appSearch}
              type="search"
              aria-label="Search apps"
              placeholder="Search apps"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(24);
              }}
              onClear={() => {
                setQuery('');
                setVisibleCount(24);
              }}
            />
            <SearchPicker
              multiple
              triggerLabel="Categories"
              icon={<ListFilter size={16} aria-hidden="true" />}
              className="app-category-trigger"
              value={selectedCategories}
              options={categories.map((value) => ({ value, label: categoryLabel(value) }))}
              labels={{
                choose: 'Filter by categories',
                search: 'Search categories',
                placeholder: 'Search categories',
                clear: 'Clear category search',
                list: 'App categories',
                empty: 'No matching categories.',
              }}
              onChange={(values) => {
                setSelectedCategories(values);
                setVisibleCount(24);
              }}
            />
          </div>
          {selectedCategories.length > 0 && (
            <div className="app-category-filters" aria-label="Selected categories">
              {selectedCategories.map((name) => (
                <Button
                  key={name}
                  variant="secondary"
                  size="sm"
                  className="app-category-chip"
                  aria-label={`Remove ${categoryLabel(name)} filter`}
                  onClick={() => toggleCategory(name)}
                >
                  <span>{categoryLabel(name)}</span>
                  <X size={14} aria-hidden="true" />
                </Button>
              ))}
              <Button variant="ghost" size="sm" onClick={clearCategories}>
                Clear all
              </Button>
            </div>
          )}
          <div
            className="apps-results"
            role="tabpanel"
            id={`${tabsId}-panel`}
            aria-labelledby={`${tabsId}-${view}`}
            tabIndex={0}
          >
            {view === 'all' && catalogError && (
              <Notice>
                More apps could not be loaded. {catalogError}{' '}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={catalogLoading || catalogRefreshing}
                  onClick={() => void refreshCatalog()}
                >
                  Retry
                </Button>
              </Notice>
            )}
            {connected.length > 0 && (
              <section className="apps-group" aria-label="Connected apps">
                {view === 'all' && <h2 id="apps-connected">Connected</h2>}
                {cards(connected)}
              </section>
            )}
            {view === 'all' && available.length > 0 && (
              <section className="apps-group" aria-labelledby="apps-available">
                <h2 id="apps-available">More</h2>
                {cards(available.slice(0, visibleCount), true)}
                {available.length > visibleCount && (
                  <div className="app-catalog-end" ref={catalogEnd} aria-hidden="true" />
                )}
              </section>
            )}
            {view === 'all' && catalogLoading && !available.length && (
              <Loading label="Loading more apps…" />
            )}
            {empty && (
              <div className="apps-empty">
                <h2>
                  {hasFilters
                    ? view === 'connected'
                      ? 'No connected apps found'
                      : 'No apps found'
                    : view === 'connected'
                      ? 'No connected apps yet'
                      : 'No apps available'}
                </h2>
                <p>
                  {hasFilters
                    ? 'Try a different search or clear your filters.'
                    : view === 'connected'
                      ? 'Connect your first app to use it with Nod.'
                      : 'Reload the catalog to check for available apps.'}
                </p>
                <Button
                  variant="outline"
                  disabled={view === 'all' && !hasFilters && catalogRefreshing}
                  onClick={() => {
                    if (hasFilters) {
                      setQuery('');
                      clearCategories();
                      appSearch.current?.focus();
                    } else if (view === 'connected') {
                      setView('all');
                      setVisibleCount(24);
                      document.getElementById(`${tabsId}-all`)?.focus();
                    } else {
                      void refreshCatalog();
                      appSearch.current?.focus();
                    }
                  }}
                >
                  {hasFilters
                    ? selectedCategories.length
                      ? 'Clear filters'
                      : 'Clear search'
                    : view === 'connected'
                      ? 'Browse apps'
                      : catalogRefreshing
                        ? 'Reloading…'
                        : 'Reload apps'}
                </Button>
              </div>
            )}
            {view === 'all' && !catalogLoading && !catalogError && (
              <IntegrationCard
                id="app-connection-help"
                className="app-connection-help"
                name="Connect another tool"
                logo={<MessageCircle aria-hidden="true" />}
                description="Tell Nod what you use and get help setting it up."
                actions={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onAsk(
                        query.trim()
                          ? `Help me connect ${query.trim()}. Guide me through setting it up.`
                          : 'Help me connect a tool. Ask me which tool I want to connect, then guide me through setting it up.',
                      )
                    }
                  >
                    Ask Nod
                  </Button>
                }
              />
            )}
          </div>
        </>
      )}
      <AppConnectionDialog
        signIn={signIn}
        opening={Boolean(busy)}
        error={signIn?.error}
        onClose={closeSignIn}
        onRetry={() => {
          if (!signIn) return;
          const { connection, entry, addAccount } = signIn;
          closeSignIn();
          void connect(connection, entry, addAccount, signIn.outcome ? undefined : signIn);
        }}
        onOpened={() =>
          setSignIn((current) =>
            current && current === signIn ? { ...current, opened: true } : current,
          )
        }
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!managed?.accounts.length) restoreAppFocus();
        }}
      />
      <AppAccountManager
        group={managed}
        suspended={Boolean(signIn) || Boolean(discoveryId)}
        busy={locked}
        titleRef={manageTitle}
        onDismissError={() => setError('')}
        onClose={() => setManageService(null)}
        onConnect={(account, addAccount) => void connect(account, 'manage', addAccount)}
        onDisconnect={disconnect}
        onRestoreFocus={restoreAppFocus}
        onKeyboard={() => {
          manageKeyboard.current = true;
        }}
      />
      {manualMcp && (
        <ManualMcpDialog
          onClose={() => {
            manualMcpAnalytics.current = null;
            setManualMcp(false);
          }}
          onCreated={(id) => {
            manualMcpAnalytics.current?.transfer(id);
            manualMcpAnalytics.current = null;
            window.history.pushState(null, '', `/apps?connect=${id}`);
            dialogService.current = '';
            setDiscoveryId(id);
            setManualMcp(false);
          }}
          returnFocus={() => manualMcpOrigin.current ?? manualMcpTrigger.current}
        />
      )}
      {discoveryId && (
        <AppDiscoveryDialog
          key={discoveryId}
          id={discoveryId}
          returnFocus={() =>
            Array.from(
              page.current?.querySelectorAll<HTMLButtonElement>(
                '[data-manage-service],[data-connect-service]',
              ) ?? [],
            ).find(
              (button) =>
                button.dataset.manageService === dialogService.current ||
                button.dataset.connectService === dialogService.current,
            ) ??
            manualMcpOrigin.current ??
            manualMcpTrigger.current
          }
          onClose={() => {
            window.history.replaceState(null, '', '/apps');
            setDiscoveryId(null);
            void refresh();
          }}
          onConnected={(name) => {
            window.history.replaceState(null, '', '/apps');
            setDiscoveryId(null);
            setAnnouncement(`${name} connected.`);
            void refresh();
            void refreshCatalog();
          }}
        />
      )}
    </div>
  );
}
