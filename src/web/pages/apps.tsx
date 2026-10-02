import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Check, Link2, LoaderCircle, Plus } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import {
  connectionGroups,
  connectionIdentity,
  connectionIssue,
  removeConnection,
} from '../lib/secondary-pages';
import { usePageData } from '../hooks/use-page-data';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
} from '../components/ui';

type Discovery = {
  name: string;
  callbackUrl?: string;
  setupUrl?: string;
  setupText?: string;
  paths: Array<{
    kind: string;
    endpoint?: string;
    command?: string;
    auth: string;
    envName?: string;
    testPath?: string;
    scope?: string;
    clientIdRequired?: boolean;
  }>;
};

const logos = new Set([
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'notion',
  'linear',
]);

function ServiceLogo({ connection }: { connection: Connection }) {
  const [failed, setFailed] = useState<string>();
  const source = logos.has(connection.slug)
    ? `/logos/${connection.slug}.svg`
    : connection.connectionId
      ? `/api/apps/${encodeURIComponent(connection.connectionId)}/icon`
      : undefined;
  return source && failed !== source ? (
    <img
      src={source}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(source)}
    />
  ) : (
    <Link2 size={24} aria-hidden="true" />
  );
}

function accountLabel(account: Connection) {
  const identity = connectionIdentity(account);
  return account.slug === 'notion' && identity.secondary
    ? `${identity.primary} · ${identity.secondary}`
    : (identity.secondary ?? identity.primary);
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

export function ConnectedAccount({
  account,
  busy,
  onDisconnect,
  onReconnect,
}: {
  account: Connection;
  busy: boolean;
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
        <p className="app-account-status" data-needs-attention={Boolean(issue) || undefined}>
          {issue ? (
            <AlertCircle size={13} aria-hidden="true" />
          ) : (
            <Check size={13} aria-hidden="true" />
          )}
          {issue ?? 'Connected'}
        </p>
      </div>
      <div className="app-account-actions">
        {(account.browserState === 'needs_sign_in' || account.browserState === 'pending') &&
          onReconnect && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onReconnect}>
              {account.browserState === 'pending' ? 'Continue sign-in' : 'Reconnect'}
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

export function Apps() {
  const {
    data: connections,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<Connection[]>('/api/apps');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [manageService, setManageService] = useState<string | null>(null);
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
  const [savingDiscovery, setSavingDiscovery] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogService = useRef('');
  const discoveryTitle = useRef<HTMLHeadingElement>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const groups = connectionGroups(connections ?? []);
  const managed = groups.find((group) => group.service.slug === manageService);
  const connected = groups.filter((group) => group.accounts.length);
  const available = groups.filter((group) => !group.accounts.length);
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
    const request = new AbortController();
    void api<Discovery>(`/api/apps/discovery/${encodeURIComponent(discoveryId)}`, {
      signal: request.signal,
    })
      .then((value) => {
        if (!request.signal.aborted) setDiscovery(value);
      })
      .catch((cause) => {
        if (!request.signal.aborted) setDiscoveryError(errorMessage(cause));
      });
    return () => request.abort();
  }, [discoveryId]);
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
    if (!discoveryId || savingDiscovery) return;
    const values = new FormData(event.currentTarget);
    setSavingDiscovery(true);
    setDiscoveryError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/discovery/${encodeURIComponent(discoveryId)}/authorize`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(values.get('clientId') ? { clientId: values.get('clientId') } : {}),
          }),
        },
      );
      window.location.assign(connectionUrl(result.url, window.location.origin));
    } catch (cause) {
      setDiscoveryError(errorMessage(cause));
      setSavingDiscovery(false);
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
    setBusy(`connect:${connection.slug}`);
    setError('');
    try {
      const result = await api<{ url: string }>(
        `/api/apps/${encodeURIComponent(connection.slug)}/connect`,
        {
          method: 'POST',
          body: JSON.stringify({
            returnTo: 'apps',
            ...(connection.accessPaths?.some((path) => path.kind !== 'browser')
              ? { connectionId: connection.connectionId }
              : {}),
          }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      window.location.assign(connectionUrl(result.url, window.location.origin));
    } catch (cause) {
      if (request.signal.aborted) return;
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
  function cards(items: typeof groups) {
    return (
      <div className="app-grid">
        {items.map(({ service, accounts }) => (
          <article key={service.slug} className="app-card" aria-labelledby={`app-${service.slug}`}>
            <div className="app-card-summary">
              <ServiceLogo connection={service} />
              <div className="app-card-copy">
                <h3 id={`app-${service.slug}`}>{service.name}</h3>
                {!accounts.length && <p className="app-card-description">{service.description}</p>}
                {service.status === 'not_configured' && (
                  <p className="app-card-unavailable">Sign-in unavailable</p>
                )}
                {accounts.some((account) => connectionIssue(account)) && (
                  <p className="app-card-unavailable">Sign-in required</p>
                )}
              </div>
              {accounts.length ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="app-manage"
                  data-manage-service={service.slug}
                  aria-label={`Manage ${service.name} accounts`}
                  onClick={() => setManageService(service.slug)}
                >
                  Manage
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="app-connect"
                  data-connect-service={service.slug}
                  aria-label={`Connect ${service.name}`}
                  aria-busy={busy === `connect:${service.slug}`}
                  disabled={service.status === 'not_configured' || Boolean(busy)}
                  onClick={() => void connect(service)}
                >
                  {busy === `connect:${service.slug}` ? 'Opening…' : 'Connect'}
                </Button>
              )}
            </div>
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
            <Plus size={14} aria-hidden="true" />
            Connect website
          </Button>
        </div>
      </header>
      {(error || loadError) && (
        <Notice onDismiss={error ? () => setError('') : undefined}>{error || loadError}</Notice>
      )}
      {!connections ? (
        loading ? (
          <Loading label="Checking apps…" />
        ) : null
      ) : (
        <>
          {connected.length > 0 && (
            <section className="apps-group" aria-labelledby="apps-connected">
              <h2 id="apps-connected">Connected apps</h2>
              {cards(connected)}
            </section>
          )}
          {available.length > 0 && (
            <section className="apps-group" aria-labelledby="apps-available">
              <h2 id="apps-available">{connected.length ? 'More apps' : 'Available apps'}</h2>
              {cards(available)}
            </section>
          )}
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
          onOpenAutoFocus={(event) => {
            const id = dialogTrigger.current?.dataset.disconnectAccount;
            const trigger = Array.from(
              document.querySelectorAll<HTMLButtonElement>('[data-disconnect-account]'),
            ).find((button) => button.dataset.disconnectAccount === id);
            if (trigger) {
              event.preventDefault();
              trigger.focus();
            } else {
              event.preventDefault();
              document.querySelector<HTMLButtonElement>('[data-add-account]')?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const button = page.current?.querySelector<HTMLButtonElement>(
              `[data-manage-service="${manageService}"]`,
            );
            button?.focus();
          }}
        >
          <div className="dialog-heading app-manage-heading">
            {managed && <ServiceLogo connection={managed.service} />}
            <div>
              <DialogTitle>{managed?.service.name} accounts</DialogTitle>
              <DialogDescription>Choose which accounts Otto can use.</DialogDescription>
            </div>
          </div>
          <div className="app-manage-accounts">
            {managed?.accounts.map((account) => (
              <ConnectedAccount
                key={account.connectionId}
                account={account}
                busy={Boolean(busy)}
                onDisconnect={(trigger) => {
                  dialogTrigger.current = trigger;
                  dialogService.current = account.slug;
                  setDisconnectError('');
                  setDisconnectAccount(account);
                }}
                onReconnect={() => void connect(account)}
              />
            ))}
          </div>
          <div className="dialog-actions">
            <Button
              data-add-account
              disabled={Boolean(busy)}
              onClick={() => managed && void connect(managed.accounts[0], true)}
            >
              {busy === `connect:${manageService}` ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : (
                <Plus size={15} aria-hidden="true" />
              )}
              Add account
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
            <a href={discovery.setupUrl} target="_blank" rel="noopener noreferrer">
              Open setup page
            </a>
          )}
          {discovery?.paths.map((path) => (
            <div
              className="app-discovery-path"
              key={`${path.kind}:${path.endpoint ?? path.command}`}
            >
              <strong>{path.kind.toUpperCase()}</strong>
              <span>{path.endpoint ?? path.command}</span>
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
                  {path.scope && <span>Requested access: {path.scope}</span>}
                </div>
              ))}
            </details>
          )}
          {discoveryError && <Notice>{discoveryError}</Notice>}
          {discovery?.paths[0]?.auth === 'oauth' ? (
            <form onSubmit={(event) => void authorizeDiscovery(event)} autoComplete="off">
              {discovery.paths[0]?.clientIdRequired && (
                <Field label="Client ID">
                  <Input name="clientId" required maxLength={500} autoComplete="off" />
                </Field>
              )}
              {discovery.callbackUrl && <p>Set the app callback URL to {discovery.callbackUrl}.</p>}
              <Button type="submit" disabled={savingDiscovery}>
                {savingDiscovery ? 'Opening sign-in…' : `Continue to ${discovery.name}`}
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
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-keep-account]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = dialogTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else
              Array.from(
                page.current?.querySelectorAll<HTMLButtonElement>(
                  '[data-manage-service],[data-connect-service]',
                ) ?? [],
              )
                .find(
                  (button) =>
                    button.dataset.manageService === dialogService.current ||
                    button.dataset.connectService === dialogService.current,
                )
                ?.focus();
          }}
        >
          <DialogTitle>Disconnect from {disconnectAccount?.name}?</DialogTitle>
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
