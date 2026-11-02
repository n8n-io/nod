import { Tooltip } from './tooltip';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from './icons';
import { ServiceLogo } from './service-logo';
import { AppConnectionDialog, type AppSignIn } from './app-connection-dialog';
import { api, ApiError, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { appConnectionAnalytics, takeAppConnectionAnalytics } from '../lib/analytics';
import { desktopLinksAvailable, desktopRuntimeAvailable, openConnection } from '../lib/desktop';
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
} from './ui';

type Discovery = {
  name: string;
  service?: string;
  needsAddress?: boolean;
  localAddress?: string;
  oauthStatus?: 'pending' | 'connected' | 'cancelled' | 'failed' | null;
  authorizationUrl?: string;
  attempt?: string;
  callbackUrl?: string;
  setupUrl?: string;
  setupText?: string;
  paths: Array<{
    kind: string;
    endpoint?: string;
    command?: string;
    auth: string;
    env?: string[];
    source?: { npm?: string; pypi?: string; url?: string; sha256?: string };
    testPath?: string;
    scope?: string;
    clientIdRequired?: boolean;
  }>;
};
type DiscoverySignIn = AppSignIn & { attempt?: string };

function readCheckUrl(path: Discovery['paths'][number]) {
  if (!path.testPath || !path.endpoint) return null;
  try {
    return new URL(
      path.testPath.replace(/^\/+/, ''),
      path.endpoint.endsWith('/') ? path.endpoint : `${path.endpoint}/`,
    ).href;
  } catch {
    return null;
  }
}

export function AppDiscoveryDialog({
  id,
  onClose,
  onConnected,
  returnFocus,
}: {
  id: string;
  onClose(): void;
  onConnected(name: string): void;
  returnFocus?(): HTMLElement | null;
}) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const [clientId, setClientId] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [signIn, setSignIn] = useState<DiscoverySignIn>();
  const [unavailable, setUnavailable] = useState(false);
  const pending = useRef<DiscoverySignIn | undefined>(undefined);
  const loaded = useRef(false);
  const editing = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const action = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const complete = useRef(false);
  const report = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    report.current ??= takeAppConnectionAnalytics(id);
  }, [id]);
  function beginAnalytics() {
    report.current ??= appConnectionAnalytics('apps').complete;
  }
  const paths = discovery?.paths ?? [];
  const oauth = paths[0]?.auth === 'oauth';
  const names = paths.find((path) => path.kind === 'cli')?.env;
  const settings = names && names.length > 1 ? names : undefined;
  const finish = () => {
    if (complete.current) return;
    complete.current = true;
    report.current?.();
    connected.current(discovery?.name ?? pending.current?.name ?? 'App');
  };

  function show(value: DiscoverySignIn | undefined) {
    pending.current = value;
    setSignIn(value);
  }

  function identity(value: Discovery): AppSignIn {
    const endpoint = value.paths[0]?.endpoint;
    return {
      service: value.service ?? 'mcp',
      name: value.name,
      accountLabel: endpoint ? (URL.parse(endpoint)?.host ?? endpoint) : undefined,
      opened: true,
    };
  }

  function close() {
    action.current?.abort();
    read.current?.abort();
    if (pending.current?.outcome === 'connected') finish();
    else onClose();
  }

  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    let timer: number | undefined;
    let checks = 0;
    async function check() {
      window.clearTimeout(timer);
      if (action.current || pending.current?.outcome || document.visibilityState !== 'visible')
        return;
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      try {
        const value = await api<Discovery>(`/api/apps/discovery/${encodeURIComponent(id)}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted) return;
        setDiscovery(value);
        setLoadError('');
        if (!loaded.current) {
          loaded.current = true;
          setInstanceUrl(value.localAddress ?? '');
        }
        if (editing.current) return;
        const current = pending.current;
        if (value.oauthStatus) {
          if (value.oauthStatus === 'connected') report.current?.();
          setError('');
          const replaced =
            current?.url && value.authorizationUrl && current.url !== value.authorizationUrl;
          show({
            ...identity(value),
            ...current,
            url: value.authorizationUrl ?? current?.url,
            attempt: value.attempt,
            outcome: replaced
              ? 'unavailable'
              : value.oauthStatus === 'pending'
                ? undefined
                : value.oauthStatus,
          });
        } else if (current) show({ ...current, outcome: 'unavailable' });
        if (value.oauthStatus === 'pending' && !pending.current?.outcome && checks++ < 120)
          timer = window.setTimeout(() => void check(), 5000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof ApiError && [404, 410].includes(cause.status)) {
            setUnavailable(true);
            if (pending.current) show({ ...pending.current, outcome: 'unavailable' });
            else setDiscovery(undefined);
          }
          setLoadError(errorMessage(cause));
          if (pending.current && !pending.current.outcome && checks++ < 120)
            timer = window.setTimeout(() => void check(), 5000);
        }
      }
    }
    function focus() {
      checks = 0;
      void check();
    }
    void check();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      window.clearTimeout(timer);
      read.current?.abort();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [id, version]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.current || !discovery) return;
    beginAnalytics();
    const form = event.currentTarget;
    const values = new FormData(form);
    const controller = new AbortController();
    action.current = controller;
    read.current?.abort();
    setSaving(true);
    setError('');
    try {
      await api(`/api/apps/discovery/${encodeURIComponent(id)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          accountName: values.get('accountName'),
          token: settings
            ? Object.fromEntries(settings.map((name) => [name, values.get(`setting:${name}`)]))
            : values.get('token'),
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      form.reset();
      finish();
    } catch (cause) {
      if (controller.signal.aborted) return;
      for (const input of form.querySelectorAll('input[type="password"], input[data-secret-input]'))
        if (input instanceof HTMLInputElement) input.value = '';
      setError(errorMessage(cause));
    } finally {
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.current || !discovery) return;
    beginAnalytics();
    const form = event.currentTarget;
    const values = new FormData(form);
    const token = String(values.get('token') ?? '').trim();
    const typed = String(values.get('instanceUrl') ?? '').trim();
    setInstanceUrl(typed);
    const external = desktopLinksAvailable();
    const popup = token || external ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    const controller = new AbortController();
    action.current = controller;
    read.current?.abort();
    setSaving(true);
    setError('');
    try {
      const result = await api<{ url?: string; attempt?: string }>(
        `/api/apps/discovery/${encodeURIComponent(id)}/instance`,
        {
          method: 'POST',
          body: JSON.stringify({
            instanceUrl: typed,
            ...(token ? { token } : {}),
            returnTo: external ? 'desktop' : 'window',
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) {
        popup?.close();
        return;
      }
      if (!result.url) {
        popup?.close();
        form.reset();
        finish();
        return;
      }
      const url = connectionUrl(
        result.url,
        window.location.origin,
        /^https?:\/\//i.test(typed) ? typed : `http://${typed}`,
      );
      const next = {
        ...identity(discovery),
        accountLabel: typed,
        url,
        attempt: result.attempt,
        opened: false,
      };
      show(next);
      let opened = false;
      if (external) {
        await openConnection(url);
        opened = true;
      } else if (popup && !popup.closed) {
        popup.location.href = url;
        opened = true;
      }
      if (controller.signal.aborted) return;
      show({ ...next, opened });
      setDiscovery((value) =>
        value ? { ...value, oauthStatus: 'pending', authorizationUrl: url } : value,
      );
    } catch (cause) {
      popup?.close();
      if (controller.signal.aborted) return;
      for (const input of form.querySelectorAll('input[type="password"], input[data-secret-input]'))
        if (input instanceof HTMLInputElement) input.value = '';
      setError(errorMessage(cause));
      if (pending.current) show({ ...pending.current, outcome: 'failed' });
    } finally {
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        setVersion((value) => value + 1);
      }
    }
  }

  async function authorize(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (action.current || !discovery || unavailable) return;
    beginAnalytics();
    editing.current = false;
    const enteredClientId = event
      ? String(new FormData(event.currentTarget).get('clientId') ?? '').trim()
      : clientId;
    setClientId(enteredClientId);
    const external = desktopLinksAvailable();
    const popup = external ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    const controller = new AbortController();
    action.current = controller;
    read.current?.abort();
    setSaving(true);
    setError('');
    const previous = pending.current;
    const restartAttempt =
      previous?.attempt ?? (discovery.oauthStatus === 'pending' ? discovery.attempt : null) ?? null;
    if (previous) show({ ...previous, url: undefined, outcome: undefined, opened: false });
    try {
      const result = await api<{ url: string; attempt?: string }>(
        `/api/apps/discovery/${encodeURIComponent(id)}/authorize`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(enteredClientId ? { clientId: enteredClientId } : {}),
            returnTo: external ? 'desktop' : 'window',
            restart: true,
            restartAttempt,
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) {
        popup?.close();
        return;
      }
      const url = connectionUrl(
        result.url,
        window.location.origin,
        paths[0]?.endpoint ||
          (instanceUrl
            ? /^https?:\/\//i.test(instanceUrl)
              ? instanceUrl
              : `http://${instanceUrl}`
            : undefined),
      );
      const next = { ...identity(discovery), url, attempt: result.attempt, opened: false };
      show(next);
      let opened = false;
      if (external) {
        await openConnection(url);
        opened = true;
      } else if (popup && !popup.closed) {
        popup.location.href = url;
        opened = true;
      }
      if (controller.signal.aborted) return;
      show({ ...next, opened });
      setDiscovery((value) =>
        value ? { ...value, oauthStatus: 'pending', authorizationUrl: url } : value,
      );
    } catch (cause) {
      popup?.close();
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && [404, 410].includes(cause.status)) {
          setUnavailable(true);
          setError('');
          show({ ...identity(discovery), ...previous, outcome: 'unavailable' });
        } else if (cause instanceof ApiError && cause.status === 409 && previous)
          show({ ...previous, outcome: undefined });
        else {
          setError(errorMessage(cause));
          if (pending.current) show({ ...pending.current, outcome: 'failed' });
        }
      }
    } finally {
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        setVersion((value) => value + 1);
      }
    }
  }

  function retry() {
    if (paths[0]?.clientIdRequired && pending.current?.outcome) {
      editing.current = true;
      show(undefined);
      setError('');
      return;
    }
    void authorize();
  }

  if (signIn)
    return (
      <AppConnectionDialog
        signIn={signIn}
        opening={saving}
        error={error}
        onClose={close}
        onOpened={() => {
          if (pending.current) show({ ...pending.current, opened: true });
        }}
        onRetry={unavailable ? undefined : retry}
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      />
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="app-discovery-dialog"
        aria-busy={saving}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <div className="app-discovery-heading">
          <span className="app-discovery-logo">
            <ServiceLogo slug={discovery?.service ?? 'mcp'} />
          </span>
          <div>
            <DialogTitle ref={title} tabIndex={-1}>
              Connect {discovery?.name ?? 'app'}
            </DialogTitle>
            <DialogDescription>
              {oauth
                ? 'Sign in to connect your account.'
                : paths.some((path) => path.kind === 'cli')
                  ? 'Save credentials. The command is not checked during setup.'
                  : 'Nod will check access before connecting.'}
            </DialogDescription>
          </div>
        </div>
        {paths[0]?.endpoint && (
          <Tooltip content={paths[0].endpoint}>
            <p className="app-discovery-address">{paths[0].endpoint}</p>
          </Tooltip>
        )}
        {discovery && (discovery.setupText || discovery.setupUrl || paths.length > 0) && (
          <details className="app-discovery-methods app-discovery-details">
            <summary>Connection details</summary>
            {discovery.setupText && <p>{discovery.setupText}</p>}
            {paths.map((path) => (
              <div
                className="app-discovery-path"
                key={`${path.kind}:${path.endpoint ?? path.command}`}
              >
                <span>
                  {path.kind === 'mcp'
                    ? 'MCP server'
                    : path.kind === 'http'
                      ? 'HTTP API'
                      : 'Command-line tool'}
                </span>
                <strong>{path.endpoint ?? path.command}</strong>
                {path.source && (
                  <span>
                    {path.source.npm
                      ? `npm ${path.source.npm}`
                      : path.source.pypi
                        ? `PyPI ${path.source.pypi}`
                        : path.source.url}
                  </span>
                )}
                {path.scope && <span>Requested access: {path.scope}</span>}
                {path.kind === 'http' && path.testPath && (
                  <p>Read check: GET {readCheckUrl(path) ?? 'unavailable'}</p>
                )}
                {path.source?.sha256 && <p>SHA-256: {path.source.sha256}</p>}
              </div>
            ))}
            {discovery.setupUrl && (
              <Button asChild variant="ghost" size="sm" className="app-discovery-setup">
                <a href={discovery.setupUrl} target="_blank" rel="noopener noreferrer">
                  Open setup guide <ExternalLink size={16} aria-hidden="true" />
                </a>
              </Button>
            )}
          </details>
        )}
        {(error || loadError) && (
          <Notice>
            {error || loadError}
            {loadError && (
              <Button variant="ghost" onClick={() => setVersion((value) => value + 1)}>
                Try again
              </Button>
            )}
          </Notice>
        )}
        {!discovery && !loadError && <Loading />}
        {discovery &&
          (discovery.needsAddress && discovery.oauthStatus !== 'pending' ? (
            <form onSubmit={(event) => void connect(event)} autoComplete="off">
              <Field
                label={`Your ${discovery.name} address`}
                hint={
                  discovery.localAddress &&
                  (desktopRuntimeAvailable() ? 'Found on this computer.' : 'Found on your server.')
                }
              >
                <Input
                  name="instanceUrl"
                  value={instanceUrl}
                  onChange={(event) => setInstanceUrl(event.target.value)}
                  required
                  maxLength={2048}
                  placeholder="https://you.app.n8n.cloud"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={saving}
                />
              </Field>
              <details className="app-discovery-methods">
                <summary>Use an access token instead</summary>
                <Field label="MCP access token">
                  <Input
                    name="token"
                    type="password"
                    minLength={8}
                    maxLength={8192}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                  />
                </Field>
              </details>
              <Button type="submit" disabled={saving}>
                {saving ? 'Connecting…' : `Connect ${discovery.name}`}
              </Button>
            </form>
          ) : oauth ? (
            <form onSubmit={(event) => void authorize(event)} autoComplete="off">
              {paths[0]?.clientIdRequired && (
                <Field label="Client ID">
                  <Input
                    name="clientId"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    required
                    maxLength={500}
                    autoComplete="off"
                    disabled={saving}
                  />
                </Field>
              )}
              {discovery.callbackUrl && <p>Set the app callback URL to {discovery.callbackUrl}.</p>}
              <Button type="submit" disabled={saving}>
                {saving ? 'Opening sign-in…' : `Continue to ${discovery.name}`}
              </Button>
            </form>
          ) : (
            <form onSubmit={(event) => void save(event)} autoComplete="off">
              <Field label="Account name">
                <Input
                  name="accountName"
                  required
                  maxLength={200}
                  autoComplete="off"
                  placeholder="Work account"
                  disabled={saving}
                />
              </Field>
              {(settings ?? ['token']).map((name) => (
                <Field key={name} label={name === 'token' ? 'API key or access token' : name}>
                  <Input
                    name={name === 'token' ? 'token' : `setting:${name}`}
                    type="password"
                    required
                    minLength={8}
                    maxLength={8192}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                  />
                </Field>
              ))}
              <Button
                type="submit"
                disabled={
                  saving || paths.some((path) => path.kind === 'http' && !readCheckUrl(path))
                }
              >
                {saving
                  ? paths.some((path) => path.kind === 'cli')
                    ? 'Saving…'
                    : 'Checking…'
                  : 'Connect account'}
              </Button>
            </form>
          ))}
      </DialogContent>
    </Dialog>
  );
}
