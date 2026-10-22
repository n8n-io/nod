import { PageTitle } from '../components/page-title';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
import type { AppSetupStatus, Configuration, Connection } from '../../shared/contracts';
import { SetupNotice } from '../components/setup-notice';
import { ServiceLogo } from '../components/service-logo';
import { AppConnectionDialog, type AppSignIn } from '../components/app-connection-dialog';
import { AppDiscoveryDialog } from '../components/app-discovery-dialog';
import { connectionStatusText, integrationAccessReady } from '../components/connection-choice';
import type { IntegrationKeyStatus } from '../../shared/integrations';
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
import { analyticsForCurrentSession, captureAnalytics } from '../lib/analytics';
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
        {account.canReconnect &&
          (account.status === 'disconnected' || account.reconnectRequired) &&
          onReconnect && (
            <Button
              size="sm"
              aria-label={`Reconnect ${label} to ${account.name}`}
              aria-busy={reconnecting}
              disabled={busy}
              onClick={onReconnect}
            >
              {reconnecting && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              {reconnecting ? 'Opening…' : 'Reconnect'}
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
  onManageConnection,
}: {
  configuration?: Configuration;
  onAsk(text: string): void;
  onManageConnection(trigger?: HTMLElement): void;
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
  const connectionSetup = usePageData<IntegrationKeyStatus>('/api/integrations/key');
  const tabsId = useId();
  const [view, setView] = useState<'all' | 'connected'>('all');
  useEffect(() => captureAnalytics('otto_tab_viewed', { page: 'apps', tab: view }), []);
  const selectView = (next: typeof view) => {
    if (next !== view) captureAnalytics('otto_tab_viewed', { page: 'apps', tab: next });
    setView(next);
  };
  useEffect(() => {
    if (loadError || (catalogError && catalogStatus !== 403))
      captureAnalytics('otto_ui_error', { area: 'apps', action: 'load' });
  }, [loadError, catalogError, catalogStatus]);
  const [query, setQuery] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(24);
  const [error, setError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [connectErrorService, setConnectErrorService] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [signIn, setSignIn] = useState<AppSignIn & { attempt?: string }>();
  const [manageService, setManageService] = useState<string | null>(null);
  const [pointerRestoredService, setPointerRestoredService] = useState<string | null>(null);
  const [disconnectAccount, setDisconnectAccount] = useState<Connection | null>(null);
  const [disconnectError, setDisconnectError] = useState('');
  const discoveryId = new URLSearchParams(window.location.search).get('connect');
  const page = useRef<HTMLDivElement>(null);
  const catalogEnd = useRef<HTMLDivElement>(null);
  const appSearch = useRef<HTMLInputElement>(null);
  const categorySearch = useRef<HTMLInputElement>(null);
  const manageTitle = useRef<HTMLHeadingElement>(null);
  const manageKeyboard = useRef(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogService = useRef('');
  const actionRequest = useRef<AbortController | null>(null);
  const locked = Boolean(busy);
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
  function closeSignIn() {
    actionRequest.current?.abort();
    actionRequest.current = null;
    setBusy('');
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
    if (!signIn?.url) return;
    const url = signIn.url;
    const controller = new AbortController();
    let checking: Promise<boolean> | undefined;
    let poll: number | undefined;
    let pairingConfirmed = signIn.pairingConfirmed === true;
    const read = async () => {
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        const result = await api<AppSetupStatus>('/api/apps/setup-status', {
          method: 'POST',
          body: JSON.stringify({ hashes: [hash], pairingUrl: url }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          cache: 'no-store',
        });
        if (controller.signal.aborted) return false;
        if (!result.completed.includes(hash)) {
          const app = result.apps.find((app) => app.hash === hash);
          if (app) {
            setSignIn((current) =>
              current?.url === url &&
              current.service === signIn.service &&
              current.attempt === signIn.attempt &&
              !current.signInRequired &&
              app.signInRequired === true
                ? { ...current, signInRequired: true }
                : current,
            );
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
          setConnectErrorService(signIn.service.replace(/_mcp$/, ''));
          setError('Sign-in wasn’t completed. Try connecting again.');
        }
        controller.abort();
        closeSignIn();
        void refresh();
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
        controller.abort();
        closeSignIn();
        setConnectErrorService(signIn.service.replace(/_mcp$/, ''));
        setError('The sign-in link expired. Try connecting again.');
      });
    }, 10 * 60_000);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('otto.apps');
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{ service?: string; attempt?: string; connection?: string } | null>,
      ) => {
        if (
          !signIn.attempt ||
          event.data?.attempt !== signIn.attempt ||
          event.data.service !== signIn.service ||
          !['connected', 'cancelled', 'failed', 'expired'].includes(event.data.connection ?? '')
        )
          return;
        controller.abort();
        closeSignIn();
        if (event.data.connection !== 'connected') {
          setConnectErrorService(signIn.service.replace(/_mcp$/, ''));
          setError(
            event.data.connection === 'cancelled'
              ? 'Connection cancelled. Try again.'
              : 'The app could not connect. Try again.',
          );
        }
        void refresh();
      };
    return () => {
      controller.abort();
      window.clearTimeout(poll);
      window.clearTimeout(timeout);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
      channel?.close();
    };
  }, [signIn?.url, signIn?.service, signIn?.attempt, refresh]);
  async function connect(connection: Connection, entry: 'apps' | 'manage', addAccount = false) {
    if (actionRequest.current || locked) return;
    const capture = analyticsForCurrentSession();
    if (
      !connection.direct &&
      !connection.accessPaths?.length &&
      !integrationAccessReady(connectionSetup.data)
    ) {
      capture('otto_app_connect_clicked', { entry, result: 'needs_access_setup' });
      onManageConnection(
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
      );
      return;
    }
    capture('otto_app_connect_clicked', { entry, result: 'opened' });
    const request = new AbortController();
    const external = desktopLinksAvailable();
    const popup = external
      ? null
      : window.open('', 'otto-connect-app', 'popup,width=520,height=720');
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = 'Connect to Otto';
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
    setConnectionNotice('');
    setSignIn({
      service: connection.slug,
      name: connection.name,
      logoUrl: connection.logoUrl,
      opened: false,
    });
    try {
      const result = await api<{ url: string; attempt?: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify({
            returnTo: 'window',
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
        window.history.pushState(null, '', `${proposal.pathname}${proposal.search}`);
        setManageService(null);
        setSignIn(undefined);
        setBusy('');
        return;
      }
      if (result.attempt !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result.attempt))
        throw new Error('The app sign-in could not be opened. Try again.');
      const pending = {
        service: connection.slug,
        name: connection.name,
        logoUrl: connection.logoUrl,
        url,
        attempt: result.attempt,
        opened: false,
      };
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
      setSignIn(undefined);
      setConnectErrorService(connection.slug.replace(/_mcp$/, ''));
      setError(errorMessage(cause));
      capture('otto_ui_error', { area: 'apps', action: 'connect' });
      setBusy('');
    } finally {
      if (actionRequest.current === request) actionRequest.current = null;
    }
  }
  async function disconnect() {
    const connection = disconnectAccount;
    if (!connection?.connectionId || actionRequest.current || busy) return;
    const capture = analyticsForCurrentSession();
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
      capture('otto_ui_error', { area: 'apps', action: 'disconnect' });
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
                disabled={service.status === 'not_configured' || locked}
                onClick={() => void connect(service, 'apps')}
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
      </header>
      {configuration && <SetupNotice configuration={configuration} />}
      {connectionNotice && (
        <Notice kind="success" onDismiss={() => setConnectionNotice('')}>
          {connectionNotice}
        </Notice>
      )}
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
      <section
        className="apps-connection apps-connection-summary"
        aria-labelledby="apps-connection"
      >
        <div>
          <h2 id="apps-connection">
            {connectionSetup.data?.mode === 'own' ? 'Your Composio project' : 'Easy Connect'}
          </h2>
          <p className="connection-muted" data-analytics-private>
            {connectionSetup.data
              ? connectionStatusText(connectionSetup.data)
              : connectionSetup.error || 'Checking connection setup…'}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={Boolean(busy || signIn)}
          onClick={(event) => onManageConnection(event.currentTarget)}
        >
          Manage connection setup
        </Button>
      </section>
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
              selectView(next);
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
                  selectView(value);
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
      <AppConnectionDialog
        signIn={signIn}
        opening={Boolean(busy)}
        onClose={closeSignIn}
        onAccessRenewed={() => {
          closeSignIn();
          setManageService(null);
          setConnectionNotice('Browser sign-in renewed. Connect the app again.');
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
      <Dialog
        open={Boolean(managed?.accounts.length) && !disconnectAccount && !signIn}
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
            if (!signIn) restoreAppFocus();
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
                busy={locked}
                reconnecting={busy === `reconnect:${account.connectionId}`}
                onDisconnect={(trigger) => {
                  dialogTrigger.current = trigger;
                  dialogService.current = managed.key;
                  setDisconnectError('');
                  setDisconnectAccount(account);
                }}
                onReconnect={() => void connect(account, 'manage')}
              />
            ))}
          </div>
          <div className="dialog-actions app-manage-actions">
            {!addAccountConnection?.browserUrl && (
              <Button
                size="sm"
                data-add-account
                disabled={locked || addAccountConnection?.status === 'not_configured'}
                onClick={() =>
                  addAccountConnection && void connect(addAccountConnection, 'manage', true)
                }
              >
                {busy === `connect:${addAccountConnection?.slug}` ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                Add account
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setManageService(null)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {discoveryId && (
        <AppDiscoveryDialog
          key={discoveryId}
          id={discoveryId}
          onClose={() => window.location.assign('/apps')}
          onConnected={() => window.location.assign('/apps')}
        />
      )}
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
