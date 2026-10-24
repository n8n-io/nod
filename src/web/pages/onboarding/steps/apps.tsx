import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { LoaderCircle, Search } from '../../../components/icons';
import type { AppSetupStatus, Connection } from '../../../../shared/contracts';
import { onboardingEmailProviders } from '../../../../shared/onboarding';
import { AppConnectionDialog, type AppSignIn } from '../../../components/app-connection-dialog';
import { AppDiscoveryDialog } from '../../../components/app-discovery-dialog';
import { ServiceLogo } from '../../../components/service-logo';
import { Button, Notice, SearchField } from '../../../components/ui';
import { usePageData } from '../../../hooks/use-page-data';
import { api, errorMessage } from '../../../lib/api';
import { searchApps } from '../../../lib/app-search';
import { analyticsForCurrentSession } from '../../../lib/analytics';
import { connectionUrl } from '../../../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../../../lib/desktop';
import { connectionGroups, connectionIssue, removeConnection } from '../../../lib/secondary-pages';
import { AppAccountManager } from '../../../components/app-account-manager';
import type { StepProps } from '..';
import { Footer } from '../motion';

const featuredSlugs = ['googlecalendar', 'googledrive', 'slack', 'notion', 'linear', 'n8n'];
const categories: Record<string, string> = {
  gmail: 'Communication',
  googlecalendar: 'Planning',
  googledrive: 'Files & documents',
  googlesheets: 'Files & documents',
  googledocs: 'Files & documents',
  slack: 'Communication',
  notion: 'Files & documents',
  linear: 'Planning',
  n8n: 'Automation',
};
const categoryRules = [
  ['Communication', /communication|email|messaging|chat|video conferencing/],
  ['Files & documents', /file|document|spreadsheet|storage|knowledge|note/],
  ['Planning', /calendar|scheduling|project management|productivity|task|time tracking/],
  ['Design & development', /design|developer|development|engineering|code|devops|infrastructure/],
  ['Sales & support', /sales|support|crm|customer|ticketing/],
  ['Automation', /automation|workflow|integration/],
  ['Marketing', /marketing|advertising|campaign|social media/],
  ['Finance', /finance|financial|accounting|billing|payment|payroll|banking/],
] as const;
const categoryOrder = categoryRules.map(([name]) => name);

function appCategory(key: string, service: Connection) {
  if (categories[key]) return categories[key];
  for (const category of service.categories ?? []) {
    const match = categoryRules.find(([, pattern]) =>
      pattern.test(category.toLowerCase().replaceAll('_', ' ')),
    );
    if (match) return match[0];
  }
  return 'More apps';
}

export function Apps({ onNext, onBack, nextLabel }: StepProps) {
  const connections = usePageData<Connection[]>('/api/apps');
  const catalog = usePageData<Connection[]>('/api/apps/catalog');
  const refresh = connections.refresh;
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(60);
  const [signIn, setSignIn] = useState<AppSignIn & { attempt?: string }>();
  const [discoveryId, setDiscoveryId] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [openingService, setOpeningService] = useState<string>();
  const [manageService, setManageService] = useState<string>();
  const [disconnecting, setDisconnecting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const [fades, setFades] = useState({ top: false, bottom: false });
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const triggerCard = useRef<HTMLElement | null>(null);
  const manageTitle = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listContent = useRef<HTMLDivElement>(null);
  const listEnd = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () =>
      connectionGroups(connections.data ?? [], catalog.data ?? [])
        .map((group) => ({
          ...group,
          name: group.service.name,
          description: group.service.description ?? '',
          category: appCategory(group.key, group.service),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [connections.data, catalog.data],
  );
  const featured = useMemo(() => {
    const available = groups.filter((group) => group.service.status !== 'not_configured');
    const preferred = featuredSlugs.flatMap((slug) =>
      available.filter((group) => group.key === slug),
    );
    return [...preferred, ...available.filter((group) => !featuredSlugs.includes(group.key))].slice(
      0,
      6,
    );
  }, [groups]);
  const managed = groups.find((group) => group.key === manageService);
  const connectedCount = groups.filter(
    (group) =>
      !onboardingEmailProviders.some((provider) => provider === group.key) &&
      group.accounts.some((account) => !connectionIssue(account) && !account.disconnectPending),
  ).length;
  const locked = opening || disconnecting || Boolean(signIn) || Boolean(discoveryId);
  const pendingName =
    signIn?.name ?? groups.find((group) => group.service.slug === openingService)?.name;
  const results = useMemo(() => searchApps(groups, query), [groups, query]);
  const searching = Boolean(query.trim());
  const ordered = useMemo(
    () =>
      searching
        ? results
        : [...groups].sort((left, right) => {
            const rank = (category: string) => {
              const index = (categoryOrder as readonly string[]).indexOf(category);
              return index < 0 ? categoryOrder.length : index;
            };
            return (
              rank(left.category) - rank(right.category) ||
              left.category.localeCompare(right.category) ||
              left.name.localeCompare(right.name)
            );
          }),
    [groups, results, searching],
  );
  const sections = new Map<string, typeof groups>();
  for (const group of ordered.slice(0, visibleCount)) {
    const heading = searching ? 'Search results' : group.category;
    sections.set(heading, [...(sections.get(heading) ?? []), group]);
  }
  const loading = !connections.data && !catalog.data && (connections.loading || catalog.loading);

  function updateFades() {
    const element = list.current;
    if (!element) return;
    const next = {
      top: element.scrollTop > 1,
      bottom: element.scrollHeight - element.clientHeight - element.scrollTop > 1,
    };
    setFades((current) =>
      current.top === next.top && current.bottom === next.bottom ? current : next,
    );
  }

  useEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFades);
    if (list.current) observer?.observe(list.current);
    if (listContent.current) observer?.observe(listContent.current);
    updateFades();
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setVisibleCount(60);
    updateFades();
  }, [query]);

  useEffect(() => {
    updateFades();
    const target = listEnd.current;
    if (!target || visibleCount >= ordered.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisibleCount(ordered.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setVisibleCount((count) => Math.min(count + 60, ordered.length));
      },
      { root: list.current, rootMargin: '200px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [ordered.length, visibleCount, searching, loading]);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!query) return;
    const clearSearch = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        locked ||
        managed?.accounts.length ||
        document.querySelector(
          '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])',
        )
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target !== search.current &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      event.preventDefault();
      setQuery('');
    };
    window.addEventListener('keydown', clearSearch);
    return () => window.removeEventListener('keydown', clearSearch);
  }, [query, locked, managed?.accounts.length]);

  function closeSignIn() {
    request.current?.abort();
    request.current = null;
    setOpening(false);
    setOpeningService(undefined);
    setSignIn(undefined);
  }

  function fail(service: string, message: string) {
    setErrors((current) => ({ ...current, [service.replace(/_mcp$/, '')]: message }));
    setAnnouncement(message);
  }

  useEffect(() => {
    if (!signIn?.url) return;
    const pending = signIn;
    const url = pending.url!;
    const controller = new AbortController();
    let checking: Promise<boolean> | undefined;
    let poll: number | undefined;
    const settle = (outcome: 'connected' | 'cancelled' | 'failed' | 'expired') => {
      if (controller.signal.aborted) return;
      controller.abort();
      closeSignIn();
      if (outcome === 'connected') setAnnouncement(`${pending.name} connected.`);
      else
        fail(
          pending.service,
          outcome === 'cancelled'
            ? 'Sign-in cancelled. Try again when you’re ready.'
            : outcome === 'expired'
              ? 'The sign-in link expired. Try connecting again.'
              : 'Sign-in wasn’t completed. Try connecting again.',
        );
      void refresh();
    };
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
        if (result.completed.includes(hash)) {
          settle('connected');
          return true;
        }
        const app = result.apps.find((entry) => entry.hash === hash);
        if (!app) {
          settle('failed');
          return true;
        }
        if (app.pairingConfirmed)
          setSignIn((current) =>
            current?.url === url && current.attempt === pending.attempt
              ? { ...current, pairingConfirmed: true }
              : current,
          );
      } catch {}
      return false;
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
        if (!completed) settle('expired');
      });
    }, 10 * 60_000);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nod.apps');
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{ service?: string; attempt?: string; connection?: string } | null>,
      ) => {
        const outcome = event.data?.connection;
        if (
          !pending.attempt ||
          event.data?.attempt !== pending.attempt ||
          event.data?.service !== pending.service
        )
          return;
        if (outcome === 'connected') void check();
        else if (outcome === 'cancelled' || outcome === 'failed' || outcome === 'expired')
          settle(outcome);
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

  async function connect(connection: Connection, source?: HTMLElement, addAccount = false) {
    if (request.current || signIn || discoveryId) return;
    const capture = analyticsForCurrentSession();
    capture('nod_app_connect_clicked', { entry: 'onboarding', result: 'opened' });
    const controller = new AbortController();
    const external = desktopLinksAvailable();
    const internal = Boolean(
      connection.direct ||
      connection.accessPaths?.length ||
      connections.data?.some((entry) => entry.slug === connection.slug && entry.direct),
    );
    const popup =
      external || internal || !connections.data
        ? null
        : window.open('', 'nod-connect-app', 'popup,width=520,height=720');
    try {
      if (popup) {
        popup.opener = null;
        popup.document.title = 'Connect to nod';
        popup.document.body.textContent = 'Preparing secure sign-in…';
      }
    } catch {}
    controller.signal.addEventListener('abort', () => popup?.close(), { once: true });
    request.current = controller;
    if (source && !manageService) {
      trigger.current = source;
      triggerCard.current = source.closest('article');
    }
    setOpening(true);
    setOpeningService(connection.slug);
    setErrors((current) => ({ ...current, [connection.slug.replace(/_mcp$/, '')]: '' }));
    if (!internal)
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
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      const url = connectionUrl(result.url, window.location.origin);
      const proposal = new URL(url);
      if (proposal.origin === window.location.origin && proposal.pathname === '/apps') {
        const id = proposal.searchParams.get('connect');
        if (
          proposal.hash ||
          proposal.searchParams.size !== 1 ||
          !id ||
          !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)
        )
          throw new Error('The app sign-in could not be opened. Try again.');
        popup?.close();
        setSignIn(undefined);
        setDiscoveryId(id);
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
      if (controller.signal.aborted) return;
      setSignIn((current) =>
        current?.url === pending.url && current.attempt === pending.attempt
          ? { ...current, opened }
          : current,
      );
    } catch (cause) {
      popup?.close();
      if (controller.signal.aborted || request.current !== controller) return;
      setSignIn(undefined);
      fail(connection.slug, errorMessage(cause));
      capture('nod_ui_error', { area: 'onboarding', action: 'connect' });
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) {
        setOpening(false);
        setOpeningService(undefined);
      }
    }
  }

  async function disconnect(connection: Connection) {
    if (!connection.connectionId || request.current || locked) return;
    const capture = analyticsForCurrentSession();
    const controller = new AbortController();
    request.current = controller;
    setDisconnecting(true);
    try {
      await api(
        `/api/apps/${encodeURIComponent(connection.slug)}/accounts/${encodeURIComponent(connection.connectionId)}/disconnect`,
        {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        },
      );
      if (controller.signal.aborted) return;
      connections.update((current) =>
        current ? removeConnection(current, connection.connectionId!) : current,
      );
      if (managed?.accounts.length === 1) setManageService(undefined);
      void refresh();
    } catch (cause) {
      if (controller.signal.aborted) return;
      capture('nod_ui_error', { area: 'onboarding', action: 'disconnect' });
      void refresh();
      throw cause;
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setDisconnecting(false);
    }
  }

  function returnFocus() {
    if (manageService && manageTitle.current?.isConnected) return manageTitle.current;
    if (trigger.current?.isConnected) return trigger.current;
    if (triggerCard.current?.isConnected) return triggerCard.current;
    return search.current;
  }

  function cards(items: typeof groups) {
    return (
      <div className="ob-apps-grid">
        {items.map(({ key, service, accounts }) => {
          const connected = accounts.some(
            (account) => !connectionIssue(account) && !account.disconnectPending,
          );
          const pending = openingService === service.slug || signIn?.service === service.slug;
          const unavailable = service.status === 'not_configured';
          const issue = connected ? undefined : errors[key];
          return (
            <article className="ob-apps-card" key={key} tabIndex={-1}>
              <ServiceLogo {...service} size={24} />
              <div className="ob-apps-card-copy">
                <h3 title={service.name}>{service.name}</h3>
                {issue && <p data-analytics-private>{issue}</p>}
              </div>
              {accounts.length ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ob-apps-manage"
                  data-status={connected ? 'connected' : 'attention'}
                  aria-label={`Manage ${service.name} accounts`}
                  aria-busy={pending}
                  disabled={locked}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    triggerCard.current = event.currentTarget.closest('article');
                    setManageService(key);
                  }}
                >
                  {pending ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    'Manage'
                  )}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unavailable || locked}
                  aria-label={`Connect ${service.name}`}
                  aria-busy={pending}
                  onClick={(event) => void connect(service, event.currentTarget)}
                >
                  {pending ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : unavailable ? (
                    'Unavailable'
                  ) : issue ? (
                    'Try again'
                  ) : (
                    'Connect'
                  )}
                </Button>
              )}
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <section className="ob-apps" aria-labelledby="ob-apps-title">
      <header className="ob-apps-heading">
        <h1 id="ob-apps-title">Connect your tools</h1>
        <SearchField
          className="ob-apps-search"
          inputRef={search}
          type="search"
          aria-label="Search apps"
          placeholder="Search apps"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => {
            setQuery('');
            search.current?.focus({ preventScroll: true });
          }}
        />
        {pendingName && (
          <div className="ob-apps-pending">
            <span role="status">Connecting to {pendingName}…</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                closeSignIn();
                window.requestAnimationFrame(() => returnFocus()?.focus({ preventScroll: true }));
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </header>
      <div className="ob-apps-scroll" data-fade-top={fades.top} data-fade-bottom={fades.bottom}>
        <div
          className="ob-apps-list"
          ref={list}
          onScroll={updateFades}
          role="region"
          aria-label="Available apps"
          tabIndex={0}
        >
          <div ref={listContent} className="ob-apps-list-content">
            {(connections.error || catalog.error) && (
              <Notice>
                {groups.length ? 'Some apps couldn’t load.' : 'Apps couldn’t load.'}{' '}
                {connections.error || catalog.error}{' '}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={connections.refreshing || catalog.refreshing}
                  onClick={() => {
                    void connections.refresh();
                    void catalog.refresh();
                  }}
                >
                  Try again
                </Button>
              </Notice>
            )}
            {loading ? (
              <div
                className="ob-apps-grid"
                role="status"
                aria-label="Loading apps"
                aria-busy="true"
              >
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="ob-apps-skeleton" key={index}>
                    <span />
                    <span />
                  </div>
                ))}
              </div>
            ) : !results.length ? (
              <div className="ob-apps-empty" role="status">
                <Search size={25} aria-hidden="true" />
                <h2>{searching ? 'No apps found' : 'No more apps available yet'}</h2>
                <p>
                  {searching
                    ? 'Try another name, or browse all apps.'
                    : 'You can keep going and connect more apps later.'}
                </p>
                {searching && (
                  <Button variant="outline" onClick={() => setQuery('')}>
                    Browse all apps
                  </Button>
                )}
              </div>
            ) : (
              <>
                {!searching && featured.length > 0 && (
                  <section className="ob-apps-category" aria-label="Popular apps">
                    <h2>Popular</h2>
                    {cards(featured)}
                  </section>
                )}
                {[...sections].map(([category, items]) => (
                  <section className="ob-apps-category" aria-label={category} key={category}>
                    <h2>{category}</h2>
                    {cards(items)}
                  </section>
                ))}
                <div ref={listEnd} aria-hidden="true" />
              </>
            )}
          </div>
        </div>
      </div>
      <div className="ob-apps-footer">
        <Footer
          onBack={onBack}
          onNext={onNext}
          nextLabel={nextLabel}
          summary={
            connectedCount > 0 ? (
              <span role="status">
                {connectedCount} {connectedCount === 1 ? 'app' : 'apps'} connected
              </span>
            ) : undefined
          }
        />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <AppConnectionDialog
        fallbackOnly
        signIn={signIn}
        opening={opening}
        onClose={closeSignIn}
        onOpened={() => setSignIn((current) => (current ? { ...current, opened: true } : current))}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!discoveryId) returnFocus()?.focus({ preventScroll: true });
        }}
      />
      <AppAccountManager
        group={managed}
        suspended={Boolean(signIn) || Boolean(discoveryId)}
        busy={locked}
        error={managed && errors[managed.key]}
        titleRef={manageTitle}
        onDismissError={() => {
          if (managed) setErrors((current) => ({ ...current, [managed.key]: '' }));
        }}
        onClose={() => {
          if (opening) closeSignIn();
          setManageService(undefined);
        }}
        onConnect={(account, addAccount) => void connect(account, undefined, addAccount)}
        onDisconnect={disconnect}
        onRestoreFocus={() => returnFocus()?.focus({ preventScroll: true })}
      />
      {discoveryId && (
        <AppDiscoveryDialog
          key={discoveryId}
          id={discoveryId}
          onClose={() => setDiscoveryId(undefined)}
          onConnected={() => {
            setDiscoveryId(undefined);
            void refresh();
          }}
          returnFocus={returnFocus}
        />
      )}
    </section>
  );
}
