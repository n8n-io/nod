import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Check, KeyRound, LoaderCircle } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import type { IntegrationKeyStatus } from '../../shared/integrations';
import { usePageData } from '../hooks/use-page-data';
import { analyticsForCurrentSession } from '../lib/analytics';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { startIntegrationAccess, type IntegrationAccessAttempt } from '../lib/integration-access';
import { cn } from '../lib/utils';
import { GoogleMark } from './google-mark';
import { OttoGlyph } from './motion';
import { Button, Input } from './ui';

type Mode = IntegrationKeyStatus['mode'];

const modes: { id: Mode; name: string; sub: string }[] = [
  { id: 'otto', name: 'Easy Connect', sub: 'Continue with Google.' },
  { id: 'own', name: 'My Composio key', sub: 'Use your own project.' },
];

const keyPermissions = [
  ['Connected accounts', 'Read and write'],
  ['Session management', 'Read and write'],
  ['Session tool execution', 'Write only'],
  ['Toolkits', 'Read only'],
  ['Auth configs', 'Read only'],
  ['Proxy execute (Legacy)', 'Write only'],
];

export const connectionRoutes: Record<Mode, string> = {
  otto: 'App requests and results pass through n8n’s hosted connection service and Composio.',
  own: 'App requests and results go through your own Composio project.',
};

function disconnects(names: string[]) {
  const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
  return `Switching disconnects ${list}. You’ll connect ${names.length > 1 ? 'them' : 'it'} again after.`;
}

export function integrationAccessReady(status: IntegrationKeyStatus | null) {
  if (!status) return false;
  return status.mode === 'own'
    ? !!status.suffix || !status.switchable
    : status.managed === null || status.managed.state === 'enabled';
}

export function connectionStatusText(status: IntegrationKeyStatus) {
  if (status.mode === 'own')
    return status.suffix
      ? `Using your Composio key ending in ••${status.suffix}`
      : status.switchable
        ? 'Your saved key needs attention.'
        : 'Using your configured Composio project.';
  if (!status.managed) return 'Your installation manages app connections.';
  if (status.managed.state === 'enabled') return status.managed.email ?? 'Google access enabled';
  if (status.managed.state === 'denied') return 'Easy Connect is not enabled for this email.';
  if (status.managed.state === 'revoked') return 'Access for this Otto installation was removed.';
  if (status.managed.state === 'unavailable') return 'Easy Connect is unavailable right now.';
  return 'Sign in with Google to use Easy Connect.';
}

export function useConnectionChoice(
  area: 'onboarding' | 'apps' | 'settings',
  onChanged?: () => unknown,
) {
  const apps = usePageData<Connection[]>('/api/apps');
  const saved = usePageData<IntegrationKeyStatus>('/api/integrations/key');
  const status = saved.data;
  const [choice, setChoice] = useState<Mode>();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [switching, setSwitching] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [removingAccess, setRemovingAccess] = useState(false);
  const accessAttempt = useRef<IntegrationAccessAttempt | null>(null);
  const accessGeneration = useRef(0);
  const active = useRef(false);
  const keyField = useRef<HTMLInputElement>(null);
  const savedKey = useRef<HTMLParagraphElement>(null);
  const tiles = useRef<Partial<Record<Mode, HTMLElement | null>>>({});
  const mode = choice ?? status?.mode;
  const checking = !apps.data && !apps.error;
  const linked = apps.data && [
    ...new Set(
      apps.data
        .filter(
          (app) =>
            app.connectionId &&
            app.status === 'connected' &&
            !app.direct &&
            !app.accessPaths?.length,
        )
        .map((app) => app.name),
    ),
  ];

  async function reload() {
    await saved.refresh();
  }

  async function refresh() {
    await Promise.all([
      saved.refresh(),
      pageDataCache.refresh('/api/apps', true),
      pageDataCache.refresh('/api/apps/catalog', true),
      pageDataCache.refresh('/api/configuration', true),
      onChanged?.(),
    ]);
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      accessGeneration.current++;
      const attempt = accessAttempt.current;
      accessAttempt.current = null;
      void attempt?.cancel().catch(() => {});
    };
  }, []);

  async function apply(value?: string) {
    if (switching || signingIn || checking) return;
    const capture = analyticsForCurrentSession();
    setSwitching(true);
    setError('');
    setNotice('');
    let next: IntegrationKeyStatus | undefined;
    let failure = '';
    try {
      next = await api<IntegrationKeyStatus>(
        '/api/integrations/key',
        value === undefined
          ? { method: 'DELETE' }
          : { method: 'PUT', body: JSON.stringify({ key: value }) },
      );
    } catch (cause) {
      failure = errorMessage(cause);
      capture('otto_ui_error', { area, action: 'save' });
    }
    if (next) {
      pageDataCache.update('/api/apps', () => null);
      pageDataCache.update('/api/apps/catalog', () => null);
      saved.update(() => next!);
    }
    await refresh();
    if (!active.current) return;
    flushSync(() => {
      setSwitching(false);
      if (next) {
        setChoice(undefined);
        setEditing(false);
        setKey('');
        setNotice(next.warning ?? '');
      } else {
        setError(failure);
        if (value === undefined) setChoice(undefined);
      }
    });
    if (next?.mode === 'own') savedKey.current?.focus();
    else if (next) tiles.current.otto?.focus();
    else (keyField.current ?? tiles.current[value === undefined ? 'own' : 'otto'])?.focus();
  }

  function pick(next: Mode) {
    if (!status || next === mode || switching || signingIn) return;
    flushSync(() => {
      setError('');
      setNotice('');
      setEditing(false);
      setKey('');
      setRemovingAccess(false);
      setChoice(next === status.mode ? undefined : next);
    });
    if (area === 'onboarding')
      (next === 'own' ? (keyField.current ?? savedKey.current) : tiles.current.otto)?.focus();
    else keyField.current?.focus();
  }

  function edit(value: boolean) {
    flushSync(() => {
      setEditing(value);
      setKey('');
      setError('');
      setNotice('');
    });
    (value ? keyField : savedKey).current?.focus();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const value = key.trim();
    if (!value) return setError('Paste your Composio key first.');
    void apply(value);
  }

  function signIn() {
    if (switching || accessAttempt.current || !status?.managed) return;
    accessGeneration.current++;
    const attempt = startIntegrationAccess();
    accessAttempt.current = attempt;
    setSigningIn(true);
    setError('');
    setNotice('');
    void attempt.done
      .catch((cause) => {
        if (
          active.current &&
          accessAttempt.current === attempt &&
          !(cause instanceof DOMException && cause.name === 'AbortError')
        )
          setError(errorMessage(cause));
      })
      .finally(async () => {
        if (!active.current || accessAttempt.current !== attempt) return;
        accessAttempt.current = null;
        setSigningIn(false);
        await refresh();
      });
  }

  function cancelSignIn() {
    const generation = ++accessGeneration.current;
    const attempt = accessAttempt.current;
    accessAttempt.current = null;
    setSigningIn(false);
    void attempt
      ?.cancel()
      .catch((cause) => {
        if (active.current && accessGeneration.current === generation)
          setError(errorMessage(cause));
      })
      .finally(() => refresh());
  }

  async function removeAccess() {
    if (switching || signingIn) return;
    setSwitching(true);
    setError('');
    setNotice('');
    try {
      await api('/api/integrations/access', { method: 'DELETE' });
      setRemovingAccess(false);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      await refresh();
      if (active.current) setSwitching(false);
    }
  }

  return {
    area,
    status,
    mode,
    switching,
    signingIn,
    ready: integrationAccessReady(status),
    dirty: switching || signingIn || !!key,
    loadError: saved.error,
    reload,
    view: {
      editing,
      key,
      error,
      notice,
      checking,
      linked,
      keyField,
      savedKey,
      tiles,
      apply,
      pick,
      edit,
      save,
      signIn,
      cancelSignIn,
      removingAccess,
      confirmRemoval: (value: boolean) => setRemovingAccess(value),
      removeAccess,
      type: (value: string) => {
        setKey(value);
        setError('');
      },
    },
  };
}

export function ConnectionChoice({
  state: { area, status, mode, switching, signingIn, loadError, reload, view },
  disabled = false,
  className,
}: {
  state: ReturnType<typeof useConnectionChoice>;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  if (!status || !mode)
    return (
      <div className={cn('connection-choice', className)}>
        <p className="connection-muted" role="status">
          {loadError || 'Checking connection setup…'}
        </p>
        {loadError && (
          <Button variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        )}
      </div>
    );
  const locked = disabled || switching || signingIn;
  const confirmLocked = locked || view.checking;
  const changing = mode !== status.mode;
  const unknown = !view.linked && !view.checking;
  const onboarding = area === 'onboarding' && status.switchable;
  const changingSetup =
    changing && (integrationAccessReady(status) || unknown || !!view.linked?.length);
  const detaching =
    changing &&
    status.mode === 'otto' &&
    mode === 'own' &&
    (status.managed?.state === 'revoked' || status.managed?.state === 'sign_in_required') &&
    (unknown || !!view.linked?.length);
  let warning = '';
  if (detaching)
    warning =
      'Switching removes these connections from Otto. Permissions remain with their providers; remove them in provider settings if needed.';
  else if (changing)
    warning = unknown
      ? 'Switching disconnects apps connected the current way.'
      : view.linked?.length
        ? disconnects(view.linked)
        : '';
  else if (!changing && (unknown || view.linked?.length))
    warning = 'If this key is for a different Composio project, you’ll connect your apps again.';
  let panel = null;
  if (mode === 'own' && !changing && !view.editing)
    panel = (
      <div className="connection-saved">
        <p ref={view.savedKey} tabIndex={-1}>
          {status.suffix ? (
            <>
              Using your Composio key ending in{' '}
              <span className="connection-mono" data-analytics-private>
                ••{status.suffix}
              </span>
            </>
          ) : status.switchable ? (
            'Otto can’t read your saved key. Save it again or choose Easy Connect.'
          ) : (
            'Using the Composio key configured for this installation.'
          )}
        </p>
        {status.switchable && (
          <button
            type="button"
            className="connection-link"
            disabled={locked || !status.keyWritable}
            onClick={() => view.edit(true)}
          >
            Change
          </button>
        )}
      </div>
    );
  else if (mode === 'own')
    panel = (
      <form className="connection-key" onSubmit={view.save} noValidate>
        <label className="connection-label" htmlFor={`${id}-key`}>
          Composio API key
        </label>
        <div className="connection-row">
          <Input
            ref={view.keyField}
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={16384}
            placeholder="ak_…"
            value={view.key}
            disabled={locked || !status.keyWritable}
            aria-invalid={!!view.error}
            aria-describedby={view.error ? `${id}-error` : undefined}
            data-analytics-private
            onChange={(event) => view.type(event.target.value)}
          />
          <Button
            type="submit"
            variant={onboarding ? 'default' : 'outline'}
            disabled={confirmLocked || !status.keyWritable}
            aria-describedby={warning ? `${id}-warning` : undefined}
          >
            {switching && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {onboarding
              ? switching
                ? 'Checking your key…'
                : changingSetup
                  ? 'Save and switch'
                  : 'Save key'
              : switching
                ? 'Checking'
                : changing
                  ? 'Save and switch'
                  : 'Save'}
          </Button>
        </div>
        {area !== 'onboarding' && (
          <p className="connection-muted">It’s encrypted and never shown to the AI.</p>
        )}
        <details className="connection-help">
          <summary>How to get a key</summary>
          <ol>
            <li>
              In the{' '}
              <a href="https://dashboard.composio.dev" target="_blank" rel="noreferrer">
                Composio dashboard
              </a>
              , open your project’s <strong>Settings → API Keys</strong> and select{' '}
              <strong>Create API Key</strong>.
            </li>
            <li>
              Give it these permissions. Read-only access isn’t enough.
              <ul>
                {keyPermissions.map(([name, access]) => (
                  <li key={name}>
                    {name}: <strong>{access}</strong>
                  </li>
                ))}
              </ul>
            </li>
            <li>
              If your server sets <code>COMPOSIO_WEBHOOK_SECRET</code>, also give Triggers:{' '}
              <strong>Read and write</strong>. Leave the rest at <strong>No access</strong>, then
              copy the key and paste it here. You can’t change a key’s permissions later.
            </li>
          </ol>
        </details>
        {!status.keyWritable && (
          <p className="connection-error">
            Otto can’t open its secure key store. Your current setup hasn’t changed.
          </p>
        )}
        {warning && (
          <p id={`${id}-warning`} className="connection-warning">
            {warning}
          </p>
        )}
        {!changing && (
          <button
            type="button"
            className="connection-link"
            disabled={switching}
            onClick={() => view.edit(false)}
          >
            Keep current key
          </button>
        )}
      </form>
    );
  else if (status.managed)
    panel = (
      <div
        className="connection-managed"
        tabIndex={onboarding ? -1 : undefined}
        ref={
          onboarding
            ? (node) => {
                view.tiles.current.otto =
                  node?.querySelector<HTMLButtonElement>(
                    'button[data-connection-action]:not(:disabled)',
                  ) ?? node;
              }
            : undefined
        }
      >
        {status.managed.state === 'enabled' && status.managed.email && (
          <p className="connection-identity" data-analytics-private>
            <GoogleMark />
            {status.managed.email}
          </p>
        )}
        {signingIn ? (
          <div className="connection-saved" role="status">
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
            <p>
              {onboarding ? 'Continue in the Google window.' : 'Finish signing in in your browser.'}
            </p>
            <Button variant="ghost" size="sm" onClick={view.cancelSignIn}>
              Cancel
            </Button>
          </div>
        ) : status.managed.state === 'enabled' ? (
          <>
            <p className="connection-enabled">
              <Check size={16} aria-hidden="true" />
              {area === 'onboarding'
                ? 'Easy Connect is ready.'
                : 'Access enabled for this Otto installation.'}
            </p>
            {changing && (
              <div className="connection-switch">
                {warning && (
                  <p id={`${id}-warning`} className="connection-warning">
                    {warning}
                  </p>
                )}
                <Button
                  data-connection-action
                  variant={onboarding ? 'default' : 'outline'}
                  disabled={confirmLocked}
                  aria-describedby={warning ? `${id}-warning` : undefined}
                  onClick={() => void view.apply()}
                >
                  {switching ? 'Switching' : 'Switch to Easy Connect'}
                </Button>
              </div>
            )}
            {view.removingAccess ? (
              <div className="connection-switch">
                <p className="connection-warning">
                  Removing access stops this installation from using Easy Connect. It does not sign
                  you out of Google.
                </p>
                <div className="connection-row">
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => void view.removeAccess()}
                  >
                    Confirm removal
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() => view.confirmRemoval(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="connection-link"
                disabled={locked}
                onClick={() => view.confirmRemoval(true)}
              >
                Remove access
              </button>
            )}
          </>
        ) : (
          <>
            {(area !== 'onboarding' || status.managed.state === 'unavailable') && (
              <p className="connection-muted">
                {status.managed.state === 'denied'
                  ? 'Easy Connect isn’t enabled for this email. You can use your own Composio key.'
                  : status.managed.state === 'revoked' && area !== 'onboarding'
                    ? 'Access for this Otto installation was removed. Sign in again to check your access.'
                    : status.managed.state === 'unavailable'
                      ? 'Easy Connect is unavailable right now. Try again or use your own Composio key.'
                      : 'Sign in with Google to continue.'}
              </p>
            )}
            <Button
              data-connection-action={status.managed.state !== 'unavailable' || undefined}
              variant={onboarding ? 'default' : 'outline'}
              disabled={locked || status.managed.state === 'unavailable'}
              onClick={view.signIn}
            >
              <GoogleMark />
              Continue with Google
            </Button>
            {status.managed.state === 'unavailable' && (
              <Button
                data-connection-action
                variant="ghost"
                disabled={locked}
                onClick={() => void reload()}
              >
                Try again
              </Button>
            )}
          </>
        )}
        {area !== 'onboarding' && (
          <p className="connection-muted">
            Google sign-in enables Easy Connect. Each app asks for its own permissions.
          </p>
        )}
      </div>
    );
  else if (changing)
    panel = (
      <div className="connection-saved">
        {warning && <p id={`${id}-warning`}>{warning}</p>}
        <Button
          variant="outline"
          size="sm"
          disabled={confirmLocked}
          aria-describedby={warning ? `${id}-warning` : undefined}
          onClick={() => void view.apply()}
        >
          {switching && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          {switching ? 'Switching' : 'Switch'}
        </Button>
      </div>
    );

  return (
    <div className={cn('connection-choice', onboarding && 'connection-onboarding', className)}>
      {status.switchable && !onboarding && (
        <div className="connection-modes" role="group" aria-label="How Otto connects your apps">
          {modes.map((item) => (
            <button
              key={item.id}
              ref={(node) => {
                view.tiles.current[item.id] = node;
              }}
              type="button"
              className="connection-mode"
              aria-pressed={item.id === mode}
              disabled={locked}
              onClick={() => view.pick(item.id)}
            >
              {item.id === 'otto' ? (
                <OttoGlyph size={24} mode="still" />
              ) : (
                <KeyRound size={24} aria-hidden="true" />
              )}
              <span className="connection-mode-text">
                <span className="connection-mode-name">{item.name}</span>
                <span className="connection-muted">
                  {item.id === 'otto' && status.managed?.state === 'enabled'
                    ? 'Signed in with Google.'
                    : item.sub}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {(area !== 'onboarding' || !status.switchable) && (
        <p className="connection-muted">{connectionRoutes[mode]}</p>
      )}
      {onboarding ? (
        mode === 'otto' ? (
          <>
            <div className="connection-onboarding-hero">
              <OttoGlyph size={34} mode="still" />
              <div className="connection-onboarding-content">
                <div>
                  <h2>
                    {status.managed?.state === 'denied'
                      ? 'This account can’t use Easy Connect'
                      : status.managed?.state === 'revoked'
                        ? 'Sign in again to use Easy Connect'
                        : status.managed?.state === 'enabled'
                          ? 'Easy Connect'
                          : 'Use Easy Connect'}
                  </h2>
                  {status.managed?.state !== 'enabled' && (
                    <p className="connection-onboarding-reason">
                      {status.managed?.state === 'denied'
                        ? 'Try another Google account or use your own Composio key.'
                        : status.managed?.state === 'revoked'
                          ? 'Continue with your Google account.'
                          : 'Google verifies your account so you can use Otto’s app connections.'}
                    </p>
                  )}
                </div>
                {panel}
              </div>
            </div>
            <div className="connection-onboarding-alternative">
              <button
                ref={(node) => {
                  view.tiles.current.own = node;
                }}
                type="button"
                className="connection-link"
                disabled={locked}
                onClick={() => view.pick('own')}
              >
                <KeyRound size={20} aria-hidden="true" />
                Use my Composio key
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="connection-onboarding-header">
              <h2>My Composio key</h2>
              <button
                ref={(node) => {
                  view.tiles.current.otto = node;
                }}
                type="button"
                className="connection-link"
                disabled={locked}
                onClick={() => view.pick('otto')}
              >
                Use Easy Connect
              </button>
            </div>
            {panel}
          </>
        )
      ) : (
        panel
      )}
      {view.notice && (
        <p role="status" className="connection-warning">
          {view.notice}
        </p>
      )}
      {view.error && (
        <p id={`${id}-error`} role="alert" className="connection-error" data-analytics-private>
          {view.error}
        </p>
      )}
    </div>
  );
}

export function ConnectionSettings({ onDirtyChange }: { onDirtyChange(dirty: boolean): void }) {
  const choice = useConnectionChoice('settings');
  useEffect(() => {
    onDirtyChange(choice.dirty);
    return () => onDirtyChange(false);
  }, [choice.dirty, onDirtyChange]);
  return <ConnectionChoice state={choice} />;
}
