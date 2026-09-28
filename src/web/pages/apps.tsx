import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, Link2, LoaderCircle, X } from 'lucide-react';
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
  Loading,
  Notice,
} from '../components/ui';

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

function ServiceLogo({ slug }: { slug: string }) {
  return logos.has(slug) ? (
    <img src={`/logos/${slug}.svg`} alt="" width={24} height={24} />
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
}: {
  account: Connection;
  busy: boolean;
  onDisconnect(trigger: HTMLButtonElement): void;
}) {
  const issue = connectionIssue(account);
  const label = accountLabel(account);
  return (
    <div className="compact-account">
      <div className="compact-account-details">
        <span className="compact-account-name">{label}</span>
        {account.accessPaths && (
          <span className="compact-account-paths">
            {account.accessPaths.map((path) => path.kind.toUpperCase()).join(' · ')}
          </span>
        )}
        {issue && (
          <p className="compact-account-issue">
            <AlertCircle size={12} aria-hidden="true" />
            {issue}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="account-disconnect"
        data-disconnect-account={account.connectionId}
        aria-label={`Disconnect ${label} from ${account.name}`}
        title="Disconnect account"
        disabled={busy}
        onClick={(event) => onDisconnect(event.currentTarget)}
      >
        <X size={15} aria-hidden="true" />
      </Button>
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
  const discoveryId = new URLSearchParams(window.location.search).get('connect');
  const [discovery, setDiscovery] = useState<{
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
      testArgs?: string[];
      testPath?: string;
      scope?: string;
      clientIdRequired?: boolean;
    }>;
  } | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [savingDiscovery, setSavingDiscovery] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const dialogService = useRef('');
  const actionRequest = useRef<AbortController | null>(null);
  const groups = connectionGroups(connections ?? []);
  const managed = groups.find((group) => group.service.slug === manageService);
  const connected = groups.filter((group) => group.accounts.length);
  const available = groups.filter((group) => !group.accounts.length);
  useEffect(() => () => actionRequest.current?.abort(), []);
  useEffect(() => {
    if (!discoveryId) return;
    const request = new AbortController();
    void api<{
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
        testArgs?: string[];
        testPath?: string;
        scope?: string;
        clientIdRequired?: boolean;
      }>;
    }>(`/api/apps/discovery/${encodeURIComponent(discoveryId)}`, { signal: request.signal })
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
  async function connect(connection: Connection) {
    if (actionRequest.current || busy) return;
    if (connection.accessPaths?.some((path) => path.kind === 'browser')) {
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
              <ServiceLogo slug={service.slug} />
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
      </header>
      {(error || loadError) && <Notice>{error || loadError}</Notice>}
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
          <DialogTitle>{managed?.service.name} accounts</DialogTitle>
          <DialogDescription>Manage the accounts Otto can use for this app.</DialogDescription>
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
              />
            ))}
          </div>
          <Button
            data-add-account
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => managed && void connect(managed.accounts[0])}
          >
            {busy === `connect:${manageService}` ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : null}
            Add account
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(discoveryId)}
        onOpenChange={(open) => {
          if (!open && !savingDiscovery) window.location.assign('/apps');
        }}
      >
        <DialogContent className="app-discovery-dialog">
          <DialogTitle>Connect {discovery?.name ?? 'app'}</DialogTitle>
          <DialogDescription>
            Add your account securely. Otto will check access before it saves the connection.
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
                    <span>
                      Read check: {path.command}{' '}
                      {path.testArgs?.map((arg) => JSON.stringify(arg)).join(' ')}
                    </span>
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
                <label>
                  Client ID
                  <input name="clientId" required maxLength={500} autoComplete="off" />
                </label>
              )}
              {discovery.callbackUrl && <p>Set the app callback URL to {discovery.callbackUrl}.</p>}
              <Button type="submit" disabled={savingDiscovery}>
                {savingDiscovery ? 'Opening sign-in…' : `Continue to ${discovery.name}`}
              </Button>
            </form>
          ) : discovery ? (
            <form onSubmit={(event) => void saveDiscovery(event)} autoComplete="off">
              <label>
                Account name
                <input name="accountName" required maxLength={200} autoComplete="off" />
              </label>
              <label>
                Access token
                <input
                  name="token"
                  type="password"
                  required
                  minLength={8}
                  maxLength={8192}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
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
                {savingDiscovery ? 'Checking…' : 'Connect account'}
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
