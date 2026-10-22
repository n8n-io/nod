import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
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
    env?: string[];
    source?: { npm?: string; pypi?: string; url?: string; sha256?: string };
    testPath?: string;
    scope?: string;
    clientIdRequired?: boolean;
  }>;
};

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
  onConnected(): void;
  returnFocus?(): HTMLElement | null;
}) {
  const [discovery, setDiscovery] = useState<Discovery>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const action = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const complete = useRef(false);
  const paths = discovery?.paths ?? [];
  const oauth = paths[0]?.auth === 'oauth';
  const names = paths.find((path) => path.kind === 'cli')?.env;
  const settings = names && names.length > 1 ? names : undefined;
  const finish = () => {
    if (complete.current) return;
    complete.current = true;
    connected.current();
  };

  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    let timer: number | undefined;
    let checks = 0;
    async function check() {
      window.clearTimeout(timer);
      if (action.current || document.visibilityState !== 'visible') return;
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
        if (value.oauthStatus === 'connected') {
          finish();
          return;
        }
        if (value.oauthStatus === 'cancelled' || value.oauthStatus === 'failed')
          setError(
            value.oauthStatus === 'cancelled'
              ? 'Connection cancelled. Try again.'
              : 'The app could not connect. Try again.',
          );
        if (value.oauthStatus === 'pending' && checks++ < 120)
          timer = window.setTimeout(() => void check(), 5000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (cause instanceof ApiError && [404, 410].includes(cause.status))
            setDiscovery(undefined);
          setLoadError(errorMessage(cause));
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
      for (const input of form.querySelectorAll('input[type="password"]'))
        if (input instanceof HTMLInputElement) input.value = '';
      setError(errorMessage(cause));
    } finally {
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.current || !discovery) return;
    const clientId = new FormData(event.currentTarget).get('clientId');
    const external = desktopLinksAvailable();
    const popup = external ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    if (!external && !popup) {
      setError('Allow pop-ups for nod, then try again.');
      return;
    }
    const controller = new AbortController();
    action.current = controller;
    read.current?.abort();
    setSaving(true);
    setError('');
    try {
      const result =
        discovery.oauthStatus === 'pending' && discovery.authorizationUrl
          ? { url: discovery.authorizationUrl }
          : await api<{ url: string }>(`/api/apps/discovery/${encodeURIComponent(id)}/authorize`, {
              method: 'POST',
              body: JSON.stringify(clientId ? { clientId } : {}),
              signal: controller.signal,
            });
      if (controller.signal.aborted) {
        popup?.close();
        return;
      }
      const url = connectionUrl(result.url, window.location.origin);
      if (external) await openConnection(url);
      else if (popup && !popup.closed) popup.location.href = url;
      else throw new Error('The sign-in window was closed. Try again.');
      setDiscovery((value) =>
        value ? { ...value, oauthStatus: 'pending', authorizationUrl: url } : value,
      );
    } catch (cause) {
      popup?.close();
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        setVersion((value) => value + 1);
      }
    }
  }

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
            target.focus();
          }
        }}
      >
        <DialogTitle ref={title} tabIndex={-1}>
          Connect {discovery?.name ?? 'app'}
        </DialogTitle>
        <DialogDescription>
          {oauth
            ? 'Sign in to allow access to your account.'
            : paths.some((path) => path.kind === 'cli')
              ? 'Add your account securely. CLI tokens are saved without a setup check.'
              : 'nod will check access before saving your connection.'}
        </DialogDescription>
        {discovery?.setupText && <p>{discovery.setupText}</p>}
        {paths.map((path) => (
          <div className="app-discovery-path" key={`${path.kind}:${path.endpoint ?? path.command}`}>
            <span>{path.kind === 'mcp' ? 'MCP server' : path.kind.toUpperCase()}</span>
            <strong>
              {path.source?.npm
                ? `npm ${path.source.npm}`
                : path.source?.pypi
                  ? `PyPI ${path.source.pypi}`
                  : (path.source?.url ?? path.endpoint ?? path.command)}
            </strong>
            {path.scope && <span>Requested access: {path.scope}</span>}
          </div>
        ))}
        {discovery?.setupUrl && (
          <Button asChild variant="outline" size="sm" className="app-discovery-setup">
            <a href={discovery.setupUrl} target="_blank" rel="noopener noreferrer">
              Open setup page
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          </Button>
        )}
        {paths.some((path) => path.testPath || path.kind === 'cli') && (
          <details className="app-discovery-methods">
            <summary>Connection details</summary>
            {paths.map((path) => (
              <div key={`${path.kind}:${path.endpoint ?? path.command}`}>
                {path.kind === 'http' && path.testPath && (
                  <p>Read check: GET {readCheckUrl(path) ?? 'unavailable'}</p>
                )}
                {path.kind === 'cli' && <p>CLI: {path.command} (not checked during setup)</p>}
                {path.source?.sha256 && <p>SHA-256: {path.source.sha256}</p>}
              </div>
            ))}
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
          (oauth ? (
            <form onSubmit={(event) => void authorize(event)} autoComplete="off">
              {paths[0]?.clientIdRequired && (
                <Field label="Client ID">
                  <Input
                    name="clientId"
                    required
                    maxLength={500}
                    autoComplete="off"
                    disabled={saving || discovery.oauthStatus === 'pending'}
                  />
                </Field>
              )}
              {discovery.callbackUrl && <p>Set the app callback URL to {discovery.callbackUrl}.</p>}
              <Button type="submit" disabled={saving}>
                {saving
                  ? 'Opening sign-in…'
                  : discovery.oauthStatus === 'pending'
                    ? 'Continue sign-in'
                    : `Continue to ${discovery.name}`}
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
