import { PageTitle } from '../components/page-title';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  Plus,
  X,
} from 'lucide-react';
import type { Configuration, Connection } from '../../shared/contracts';
import { SetupNotice } from '../components/setup-notice';
import { ServiceLogo } from '../components/service-logo';
import { api, ApiError, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
import {
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
} from '../lib/secondary-pages';
import { usePageData } from '../hooks/use-page-data';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
  SearchField,
} from '../components/ui';

type Discovery = {
  name: string;
  oauthStatus?: 'pending' | 'connected' | 'cancelled' | 'failed' | null;
  authorizationUrl?: string;
  callbackUrl?: string;
  setupUrl?: string;
  setupText?: string;
  paths: Array<{
    kind: string;
    endpoint?: string;
    command?: string;
    auth: string;
    envName?: string;
    source?: { npm?: string; pypi?: string; url?: string; sha256?: string };
    testPath?: string;
    scope?: string;
    clientIdRequired?: boolean;
  }>;
};

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

function readCheckUrl(path: { endpoint: string; testPath?: string }) {
  if (!path.testPath) return null;
  try {
    return new URL(
      path.testPath.replace(/^\/+/, ''),
      path.endpoint.endsWith('/') ? path.endpoint : `${path.endpoint}/`,
    ).href;
  } catch {
    return null;
  }
}

function AppDescription({ name, description }: { name: string; description?: string }) {
  const descriptionId = useId();
  const text = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => {
      const next = element.scrollHeight > element.clientHeight + 1;
      setTruncated(next);
      if (!next) {
        pinned.current = false;
        setOpen(false);
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [description, truncated]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function preview() {
    clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function closePreview() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (
        !pinned.current &&
        document.activeElement !== trigger.current &&
        !content.current?.contains(document.activeElement)
      ) {
        setOpen(false);
      }
    }, 160);
  }

  const summary = (
    <span ref={text} className="app-description-text">
      {description}
    </span>
  );
  if (!truncated) return <p className="app-card-description">{summary}</p>;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        pinned.current = false;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        ref={trigger}
        className="app-card-description app-description-trigger"
        aria-label={`Read full description of ${name}`}
        aria-describedby={open ? descriptionId : undefined}
        onPointerEnter={(event) => event.pointerType === 'mouse' && preview()}
        onPointerLeave={closePreview}
        onFocus={preview}
        onBlur={closePreview}
        onKeyDown={(event) => {
          const panel = content.current;
          if (!panel || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) return;
          event.preventDefault();
          const distance = event.key.startsWith('Page') ? panel.clientHeight : 40;
          panel.scrollTop += event.key.endsWith('Up') ? -distance : distance;
        }}
        onClick={(event) => {
          event.preventDefault();
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        {summary}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="menu app-description-popover"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={`${name} description`}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => {
            if (content.current?.contains(document.activeElement)) trigger.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            trigger.current?.focus();
            pinned.current = false;
            setOpen(false);
          }}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={closePreview}
          onBlur={closePreview}
        >
          <strong>{name}</strong>
          <p id={descriptionId}>{description}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function ConnectedAccount({
  account,
  busy,
  reconnecting = false,
  onDisconnect,
  onReconnect,
}: {
  account: Connection;
  busy: boolean;
  reconnecting?: boolean;
  onDisconnect(trigger: HTMLButtonElement): void;
  onReconnect?(): void;
}) {
  const issue = connectionIssue(account);
  const label = accountLabel(account);
  const identity = connectionIdentity(account);
  return (
    <div className="compact-account">
      <div className="compact-account-details">
        <span className="compact-account-name">{identity.primary}</span>
        {identity.secondary && <span className="compact-account-email">{identity.secondary}</span>}
        <p className="app-status" data-status={issue ? 'attention' : 'connected'}>
          {issue ? (
            <AlertCircle size={16} aria-hidden="true" />
          ) : (
            <Check size={16} aria-hidden="true" />
          )}
          {issue ?? 'Connected'}
        </p>
      </div>
      <div className="app-account-actions">
        {((account.canReconnect &&
          (account.status === 'disconnected' || account.reconnectRequired)) ||
          account.browserState === 'needs_sign_in' ||
          account.browserState === 'pending') &&
          onReconnect && (
            <Button
              size="sm"
              aria-label={
                account.browserState === 'pending'
                  ? `Continue signing in to ${account.name} as ${label}`
                  : `Reconnect ${label} to ${account.name}`
              }
              aria-busy={reconnecting}
              disabled={busy}
              onClick={onReconnect}
            >
              {reconnecting && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              {reconnecting
                ? 'Opening…'
                : account.browserState === 'pending'
                  ? 'Continue sign-in'
                  : 'Reconnect'}
            </Button>
          )}
        <Button
          variant="ghost"
          size="sm"
          className="account-disconnect"
          data-disconnect-account={account.connectionId}
          aria-label={`Disconnect ${label} from ${account.name}`}
          disabled={busy}
          onClick={(event) => onDisconnect(event.currentTarget)}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
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
    loading: catalogLoading,
    refreshing: catalogRefreshing,
    refresh: refreshCatalog,
  } = usePageData<Connection[]>('/api/apps/catalog');
  const tabsId = useId();
  const [view, setView] = useState<'all' | 'connected'>('all');
  const [query, setQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(24);
  const [error, setError] = useState('');
  const [connectErrorService, setConnectErrorService] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [manageService, setManageService] = useState<string | null>(null);
  const [pointerRestoredService, setPointerRestoredService] = useState<string | null>(null);
  const [disconnectAccount, setDisconnectAccount] = useState<Connection | null>(null);
  const [disconnectError, setDisconnectError] = useState('');
  const [websiteOpen, setWebsiteOpen] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [websiteLabel, setWebsiteLabel] = useState('');
  const [websiteConnectionId, setWebsiteConnectionId] = useState<string>();
  const [websiteError, setWebsiteError] = useState('');
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const discoveryId = new URLSearchParams(window.location.search).get('connect');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryLoadError, setDiscoveryLoadError] = useState('');
  const [savingDiscovery, setSavingDiscovery] = useState(false);
  const [discoverySignIn, setDiscoverySignIn] = useState<{ id: string; url: string } | null>(null);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const catalogEnd = useRef<HTMLDivElement>(null);
  const appSearch = useRef<HTMLInputElement>(null);
  const categorySearch = useRef<HTMLInputElement>(null);
  const manageTitle = useRef<HTMLHeadingElement>(null);
  const manageKeyboard = useRef(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogService = useRef('');
  const discoveryTitle = useRef<HTMLHeadingElement>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const discoveryRequest = useRef<AbortController | null>(null);
  const groups = connectionGroups(connections ?? [], catalog ?? []);
  const managed = groups.find((group) => group.key === manageService);
  const manageError = managed?.key === connectErrorService ? error : '';
  const addAccountConnection =
    managed?.accounts.find(
      (account) => account.slug === managed.service.slug && account.status !== 'not_configured',
    ) ??
    managed?.accounts.find((account) => account.status !== 'not_configured') ??
    managed?.service;
  const categories = [
    ...new Set(groups.flatMap(({ service }) => (service.categories ?? []).map(categoryKey))),
  ].sort((left, right) => categoryLabel(left).localeCompare(categoryLabel(right)));
  const categoryMatches = categories.filter((name) =>
    categoryLabel(name).toLocaleLowerCase().includes(categoryQuery.trim().toLocaleLowerCase()),
  );
  const search = query.trim().toLocaleLowerCase();
  const filtered = groups.filter(
    (group) =>
      (!selectedCategories.length ||
        group.service.categories?.some((category) =>
          selectedCategories.includes(categoryKey(category)),
        )) &&
      (!search ||
        `${group.service.name} ${group.service.slug} ${group.service.description ?? ''}`
          .toLocaleLowerCase()
          .includes(search)),
  );
  const connected = filtered.filter((group) => group.accounts.length);
  const available = filtered.filter((group) => !group.accounts.length);
  const connectedCount = groups.filter((group) => group.accounts.length).length;
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
    if (!discoveryId) return;
    let timer: number | undefined;
    let checks = 0;
    async function check() {
      window.clearTimeout(timer);
      discoveryRequest.current?.abort();
      if (actionRequest.current) return;
      const request = new AbortController();
      discoveryRequest.current = request;
      try {
        const value = await api<Discovery>(
          `/api/apps/discovery/${encodeURIComponent(discoveryId!)}`,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        setDiscovery(value);
        setDiscoveryLoadError('');
        if (value.oauthStatus === 'connected') {
          const url = new URL(window.location.href);
          if (url.searchParams.get('connect') !== discoveryId) return;
          url.searchParams.delete('connect');
          window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
          setDiscovery(null);
          setDiscoverySignIn(null);
          void refresh();
          return;
        }
        setDiscoverySignIn(
          value.authorizationUrl
            ? {
                id: discoveryId!,
                url: connectionUrl(value.authorizationUrl, window.location.origin),
              }
            : null,
        );
        if (value.oauthStatus === 'cancelled' || value.oauthStatus === 'failed')
          setDiscoveryError(
            value.oauthStatus === 'cancelled'
              ? 'Connection cancelled. Try again.'
              : 'The app could not connect. Try again.',
          );
        if (value.oauthStatus === 'pending' && checks++ < 12)
          timer = window.setTimeout(() => void check(), 5000);
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setDiscovery(null);
          setDiscoverySignIn(null);
        }
        setDiscoveryLoadError(errorMessage(cause));
      }
    }
    function focus() {
      checks = 0;
      void check();
    }
    focus();
    window.addEventListener('focus', focus);
    return () => {
      window.clearTimeout(timer);
      discoveryRequest.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, [discoveryId, discoveryVersion, refresh]);
  async function saveDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!discoveryId || savingDiscovery) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setSavingDiscovery(true);
    setDiscoveryError('');
    try {
      await api(`/api/apps/discovery/${encodeURIComponent(discoveryId)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          accountName: values.get('accountName'),
          token: values.get('token'),
        }),
      });
      form.reset();
      window.location.assign('/');
    } catch (cause) {
      const token = form.elements.namedItem('token');
      if (token instanceof HTMLInputElement) token.value = '';
      setDiscoveryError(errorMessage(cause));
      setSavingDiscovery(false);
    }
  }
  async function authorizeDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!discoveryId || savingDiscovery || actionRequest.current) return;
    const clientId =
      event.currentTarget.querySelector<HTMLInputElement>('[name="clientId"]')?.value;
    const request = new AbortController();
    actionRequest.current = request;
    discoveryRequest.current?.abort();
    setSavingDiscovery(true);
    setDiscoveryError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/discovery/${encodeURIComponent(discoveryId)}/authorize`,
        {
          method: 'POST',
          body: JSON.stringify({ ...(clientId ? { clientId } : {}) }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      const url = connectionUrl(result.url, window.location.origin);
      setDiscoverySignIn({ id: discoveryId, url });
      await openConnection(url);
    } catch (cause) {
      if (request.signal.aborted) return;
      setDiscoveryError(errorMessage(cause));
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
      if (!request.signal.aborted) {
        setSavingDiscovery(false);
        setDiscoveryVersion((value) => value + 1);
      }
    }
  }
  async function connect(connection: Connection, addAccount = false) {
    if (actionRequest.current || busy) return;
    if (connection.accessPaths?.some((path) => path.kind === 'browser')) {
      if (connection.browserState) {
        setWebsiteUrl(
          connection.browserUrl ??
            connection.accessPaths.find((path) => path.kind === 'browser')?.endpoint ??
            '',
        );
        setWebsiteLabel('');
        setWebsiteConnectionId(addAccount ? undefined : connection.connectionId);
        setWebsiteError('');
        setManageService(null);
        setWebsiteOpen(true);
        return;
      }
      window.location.assign('/vault');
      return;
    }
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(
      !addAccount && connection.connectionId
        ? `reconnect:${connection.connectionId}`
        : `connect:${connection.slug}`,
    );
    setError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify({
            returnTo: desktopLinksAvailable() ? 'window' : 'apps',
            ...(!addAccount || connection.accessPaths?.some((path) => path.kind !== 'browser')
              ? { connectionId: connection.connectionId }
              : {}),
          }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      await openConnection(connectionUrl(result.url, window.location.origin));
      if (desktopLinksAvailable()) setBusy('');
    } catch (cause) {
      if (request.signal.aborted) return;
      setConnectErrorService(connection.slug.replace(/_mcp$/, ''));
      setError(errorMessage(cause));
      setBusy('');
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
    }
  }
  async function disconnect() {
    const connection = disconnectAccount;
    if (!connection?.connectionId || actionRequest.current || busy) return;
    const request = new AbortController();
    actionRequest.current = request;
    setBusy(`disconnect:${connection.connectionId}`);
    setDisconnectError('');
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
      setManageService(null);
      setDisconnectAccount(null);
      void refresh();
    } catch (cause) {
      if (request.signal.aborted) return;
      setDisconnectError(errorMessage(cause));
      void refresh();
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
    button?.focus();
  }

  function cards(items: typeof groups, catalogCards = false) {
    return (
      <div className={catalogCards ? 'app-grid app-catalog-grid' : 'app-grid'}>
        {items.map(({ key, service, accounts }) => (
          <article key={key} className="app-card" aria-labelledby={`app-${key}`}>
            <ServiceLogo {...service} />
            <div className="app-card-copy">
              <h3 id={`app-${key}`} title={service.name}>
                {service.name}
              </h3>
              <AppDescription name={service.name} description={service.description} />
              {service.status === 'not_configured' && (
                <p className="app-status">Sign-in unavailable</p>
              )}
              {accounts.some((account) => connectionIssue(account)) && (
                <p className="app-status" data-status="attention">
                  <AlertCircle size={16} aria-hidden="true" />
                  Sign-in required
                </p>
              )}
            </div>
            {accounts.length ? (
              <Button
                variant="ghost"
                size="sm"
                className="app-manage"
                data-manage-service={key}
                data-pointer-restored={pointerRestoredService === key || undefined}
                aria-label={`Manage ${service.name} accounts`}
                onKeyDown={() => setPointerRestoredService(null)}
                onBlur={() => setPointerRestoredService(null)}
                onClick={(event) => {
                  dialogService.current = key;
                  dialogTrigger.current = null;
                  manageKeyboard.current = event.detail === 0;
                  setPointerRestoredService(null);
                  setError('');
                  setManageService(key);
                }}
              >
                Manage
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="app-connect"
                data-connect-service={key}
                aria-label={`Connect ${service.name}`}
                aria-busy={busy === `connect:${service.slug}`}
                disabled={service.status === 'not_configured' || Boolean(busy)}
                onClick={() => void connect(service)}
              >
                {busy === `connect:${service.slug}` ? 'Opening…' : 'Connect'}
              </Button>
            )}
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page apps-page" ref={page}>
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/apps" />
          <p>Your tools, connected to Otto.</p>
        </div>
        <div className="secondary-heading-actions">
          <Button
            onClick={() => {
              setWebsiteUrl('');
              setWebsiteLabel('');
              setWebsiteConnectionId(undefined);
              setWebsiteError('');
              setWebsiteOpen(true);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Connect website
          </Button>
        </div>
      </header>
      {configuration && <SetupNotice configuration={configuration} />}
      {error && !manageError && <Notice onDismiss={() => setError('')}>{error}</Notice>}
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
          <div
            className="apps-views"
            role="tablist"
            aria-label="App views"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 'all'
                  : event.key === 'End'
                    ? 'connected'
                    : view === 'all'
                      ? 'connected'
                      : 'all';
              setView(next);
              setVisibleCount(24);
              event.currentTarget
                .querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
                ?.focus();
            }}
          >
            {(['all', 'connected'] as const).map((value) => (
              <button
                key={value}
                type="button"
                id={`${tabsId}-${value}`}
                data-view={value}
                role="tab"
                tabIndex={view === value ? 0 : -1}
                aria-selected={view === value}
                aria-controls={`${tabsId}-panel`}
                onClick={() => {
                  setView(value);
                  setVisibleCount(24);
                }}
              >
                {value === 'all' ? 'All apps' : 'Connected'}
                <span>{value === 'all' ? groups.length : connectedCount}</span>
              </button>
            ))}
          </div>
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
            <Popover.Root
              open={categoriesOpen}
              onOpenChange={(open) => {
                setCategoriesOpen(open);
                setCategoryQuery('');
              }}
              modal
            >
              <Popover.Trigger
                type="button"
                className="button button-outline app-category-trigger"
                data-filtered={selectedCategories.length > 0 || undefined}
              >
                <ListFilter size={16} aria-hidden="true" />
                Categories
                {selectedCategories.length > 0 && (
                  <span className="app-category-count">{selectedCategories.length}</span>
                )}
                <ChevronDown size={16} aria-hidden="true" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="menu app-category-panel"
                  aria-label="Filter by categories"
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    categorySearch.current?.focus({ preventScroll: true });
                  }}
                >
                  <SearchField
                    inputRef={categorySearch}
                    type="search"
                    aria-label="Search categories"
                    placeholder="Search categories"
                    value={categoryQuery}
                    onChange={(event) => setCategoryQuery(event.target.value)}
                    onClear={() => setCategoryQuery('')}
                  />
                  <div className="app-category-options" role="group" aria-label="App categories">
                    {categoryMatches.map((name) => (
                      <label
                        key={name}
                        className="app-category-option"
                        data-selected={selectedCategories.includes(name) || undefined}
                      >
                        <Checkbox
                          checked={selectedCategories.includes(name)}
                          onChange={() => toggleCategory(name)}
                        />
                        <span>{categoryLabel(name)}</span>
                      </label>
                    ))}
                    {!categoryMatches.length && (
                      <p className="app-category-empty">No matching categories.</p>
                    )}
                  </div>
                  <div className="app-category-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!selectedCategories.length}
                      onClick={clearCategories}
                    >
                      Clear all
                    </Button>
                    <Popover.Close asChild>
                      <Button variant="outline" size="sm">
                        Done
                      </Button>
                    </Popover.Close>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
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
                {view === 'all' && <h2 id="apps-connected">Connected apps</h2>}
                {cards(connected)}
              </section>
            )}
            {view === 'all' && available.length > 0 && (
              <section className="apps-group" aria-labelledby="apps-available">
                <h2 id="apps-available">{connected.length ? 'More apps' : 'Available apps'}</h2>
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
                      ? 'Connect your first app to use it with Otto.'
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
                      page.current?.querySelector<HTMLButtonElement>('[data-view="all"]')?.focus();
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
              <div className="app-catalog-footer">
                <p>
                  {query.trim()
                    ? `Explore other ways to connect “${query.trim()}”.`
                    : 'Explore other ways to connect your tools.'}
                </p>
                <Button
                  variant="ghost"
                  onClick={() =>
                    onAsk(
                      query.trim()
                        ? `Help me connect ${query.trim()}. Check available integrations, or help me set up a custom connection.`
                        : 'Help me connect another app. Find a way to connect based on what I need.',
                    )
                  }
                >
                  Ask Otto in chat
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      <Dialog
        open={Boolean(managed?.accounts.length) && !disconnectAccount}
        onOpenChange={(open) => {
          if (!open && !disconnectAccount) setManageService(null);
        }}
      >
        <DialogContent
          className="app-manage-dialog"
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') manageKeyboard.current = true;
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const id = dialogTrigger.current?.dataset.disconnectAccount;
            const trigger = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-disconnect-account]'),
            ).find((button) => button.dataset.disconnectAccount === id);
            if (trigger) trigger.focus();
            else manageTitle.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreAppFocus();
          }}
        >
          <div className="dialog-heading app-manage-heading">
            {managed && <ServiceLogo {...managed.service} />}
            <div>
              <DialogTitle ref={manageTitle} tabIndex={-1}>
                {managed?.service.name} accounts
              </DialogTitle>
              <DialogDescription>Choose which accounts Otto can use.</DialogDescription>
            </div>
          </div>
          {manageError && <Notice onDismiss={() => setError('')}>{manageError}</Notice>}
          <div className="app-manage-accounts">
            {managed?.accounts.map((account) => (
              <ConnectedAccount
                key={account.connectionId}
                account={account}
                busy={Boolean(busy)}
                reconnecting={busy === `reconnect:${account.connectionId}`}
                onDisconnect={(trigger) => {
                  dialogTrigger.current = trigger;
                  dialogService.current = managed.key;
                  setDisconnectError('');
                  setDisconnectAccount(account);
                }}
                onReconnect={() => void connect(account)}
              />
            ))}
          </div>
          <div className="dialog-actions app-manage-actions">
            <Button
              size="sm"
              data-add-account
              disabled={Boolean(busy) || addAccountConnection?.status === 'not_configured'}
              onClick={() => addAccountConnection && void connect(addAccountConnection, true)}
            >
              {busy === `connect:${addAccountConnection?.slug}` ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : (
                <Plus size={16} aria-hidden="true" />
              )}
              Add account
            </Button>
            <Button variant="outline" size="sm" onClick={() => setManageService(null)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={websiteOpen} onOpenChange={(open) => !websiteBusy && setWebsiteOpen(open)}>
        <DialogContent className="app-website-dialog">
          <DialogTitle>Connect a website</DialogTitle>
          <DialogDescription>
            Otto will open the site in a private browser. Sign in once, then use the saved session
            in later tasks.
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (websiteBusy) return;
              setWebsiteBusy(true);
              setWebsiteError('');
              const text = websiteConnectionId
                ? `Use browser connection ${websiteConnectionId} to open ${websiteUrl}. Check whether it works. If the session expired, help me sign in through the secure form and save the session.`
                : `Connect to ${websiteUrl} in your private browser${websiteLabel.trim() ? ` as ${websiteLabel.trim()}` : ''}. Help me sign in through the secure form if needed, then save the browser session.`;
              void api('/api/messages', {
                method: 'POST',
                body: JSON.stringify({ text }),
              })
                .then(() => window.location.assign('/'))
                .catch((cause) => {
                  setWebsiteError(errorMessage(cause));
                  setWebsiteBusy(false);
                });
            }}
          >
            <Field label="Website address">
              <Input
                type="url"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder="https://example.com/account"
                autoFocus
                required
                disabled={websiteBusy}
              />
            </Field>
            <Field label="Account name">
              <Input
                value={websiteLabel}
                onChange={(event) => setWebsiteLabel(event.target.value)}
                placeholder="Optional"
                maxLength={100}
                disabled={websiteBusy}
              />
            </Field>
            {websiteError && <Notice>{websiteError}</Notice>}
            <Button type="submit" disabled={websiteBusy}>
              {websiteBusy ? 'Opening…' : 'Continue in chat'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(discoveryId)}
        onOpenChange={(open) => {
          if (!open && !savingDiscovery) window.location.assign('/apps');
        }}
      >
        <DialogContent
          className="app-discovery-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            discoveryTitle.current?.focus();
          }}
        >
          <DialogTitle ref={discoveryTitle} tabIndex={-1}>
            Connect {discovery?.name ?? 'app'}
          </DialogTitle>
          <DialogDescription>
            {discovery?.paths.some((path) => path.kind === 'cli')
              ? 'Add your account securely. CLI tokens are saved without a setup check.'
              : 'Add your account securely. Otto will check access before it saves the connection.'}
          </DialogDescription>
          {discovery?.setupText && <p>{discovery.setupText}</p>}
          {discovery?.setupUrl && (
            <Button asChild variant="outline" size="sm" className="app-discovery-setup">
              <a href={discovery.setupUrl} target="_blank" rel="noopener noreferrer">
                Open setup page
                <ExternalLink size={16} aria-hidden="true" />
              </a>
            </Button>
          )}
          {discovery?.paths.map((path) => (
            <div
              className="app-discovery-path"
              key={`${path.kind}:${path.endpoint ?? path.command}`}
            >
              <strong>{path.kind.toUpperCase()}</strong>
              <span>
                {path.source?.npm
                  ? `npm ${path.source.npm}`
                  : path.source?.pypi
                    ? `PyPI ${path.source.pypi}`
                    : (path.source?.url ?? path.endpoint ?? path.command)}
              </span>
            </div>
          ))}
          {discovery?.paths.some((path) => path.testPath || path.kind === 'cli' || path.scope) && (
            <details className="app-discovery-methods">
              <summary>Connection details</summary>
              {discovery.paths.map((path) => (
                <div
                  className="app-discovery-path"
                  key={`${path.kind}:${path.endpoint ?? path.command}`}
                >
                  {path.kind === 'http' && path.testPath && (
                    <span>
                      Read check: GET{' '}
                      {readCheckUrl({ endpoint: path.endpoint ?? '', testPath: path.testPath }) ??
                        'unavailable'}
                    </span>
                  )}
                  {path.kind === 'cli' && (
                    <span>CLI: {path.command} (not checked during setup)</span>
                  )}
                  {path.source?.sha256 && <span>SHA-256: {path.source.sha256}</span>}
                  {path.scope && <span>Requested access: {path.scope}</span>}
                </div>
              ))}
            </details>
          )}
          {(discoveryError || discoveryLoadError) && (
            <Notice>{discoveryError || discoveryLoadError}</Notice>
          )}
          {discovery?.paths[0]?.auth === 'oauth' ? (
            <form onSubmit={(event) => void authorizeDiscovery(event)} autoComplete="off">
              {discovery.paths[0]?.clientIdRequired && (
                <Field label="Client ID">
                  <Input
                    name="clientId"
                    required
                    maxLength={500}
                    autoComplete="off"
                    disabled={savingDiscovery || discoverySignIn?.id === discoveryId}
                  />
                </Field>
              )}
              {discovery.callbackUrl && <p>Set the app callback URL to {discovery.callbackUrl}.</p>}
              <Button type="submit" disabled={savingDiscovery}>
                {savingDiscovery
                  ? 'Opening sign-in…'
                  : discoverySignIn?.id === discoveryId
                    ? 'Continue sign-in'
                    : `Continue to ${discovery.name}`}
              </Button>
            </form>
          ) : discovery ? (
            <form onSubmit={(event) => void saveDiscovery(event)} autoComplete="off">
              <Field label="Account name">
                <Input name="accountName" required maxLength={200} autoComplete="off" />
              </Field>
              <Field label="Access token">
                <Input
                  name="token"
                  type="password"
                  required
                  minLength={8}
                  maxLength={8192}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Button
                type="submit"
                disabled={
                  savingDiscovery ||
                  discovery.paths.some(
                    (path) =>
                      path.kind === 'http' &&
                      !readCheckUrl({ endpoint: path.endpoint ?? '', testPath: path.testPath }),
                  )
                }
              >
                {savingDiscovery
                  ? discovery.paths.some((path) => path.kind === 'cli')
                    ? 'Saving…'
                    : 'Checking…'
                  : 'Connect account'}
              </Button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(disconnectAccount)}
        onOpenChange={(open) => {
          if (!open && !busy) setDisconnectAccount(null);
        }}
      >
        <DialogContent
          className="app-disconnect-dialog"
          aria-busy={Boolean(busy)}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') manageKeyboard.current = true;
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-keep-account]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = dialogTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else restoreAppFocus();
          }}
        >
          <DialogTitle>
            Disconnect from {disconnectAccount?.name.replace(/\s+MCP$/i, '')}?
          </DialogTitle>
          <DialogDescription>
            {disconnectAccount && accountLabel(disconnectAccount)}
            <span>Otto will lose access to this account. You can connect it again later.</span>
          </DialogDescription>
          {disconnectError && <Notice>{disconnectError}</Notice>}
          <div className="app-disconnect-actions">
            <Button
              data-keep-account
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => setDisconnectAccount(null)}
            >
              Keep account
            </Button>
            <Button
              variant="destructive"
              disabled={Boolean(busy)}
              onClick={() => void disconnect()}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
