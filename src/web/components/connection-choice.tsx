import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { KeyRound, LoaderCircle } from 'lucide-react';
import type { Connection } from '../../shared/contracts';
import type { IntegrationKeyStatus } from '../../shared/integrations';
import { usePageData } from '../hooks/use-page-data';
import { analyticsForCurrentSession } from '../lib/analytics';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { cn } from '../lib/utils';
import { OttoGlyph } from './motion';
import { Button, Input } from './ui';

type Mode = IntegrationKeyStatus['mode'];

const modes: { id: Mode; name: string; sub: string }[] = [
  { id: 'otto', name: 'Otto’s connection', sub: 'Recommended. Nothing to set up.' },
  { id: 'own', name: 'Your own Composio', sub: 'Use your Composio API key.' },
];

export const connectionRoutes: Record<Mode, string> = {
  otto: 'App requests and results pass through n8n’s hosted connection service and Composio.',
  own: 'App requests and results go through your own Composio project.',
};

function disconnects(names: string[]) {
  const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
  return `Switching disconnects ${list}. You’ll connect ${names.length > 1 ? 'them' : 'it'} again after.`;
}

export function useConnectionChoice(area: 'onboarding' | 'apps', onChanged?: () => unknown) {
  const apps = usePageData<Connection[]>('/api/apps');
  const [status, setStatus] = useState<IntegrationKeyStatus | null>(null);
  const [choice, setChoice] = useState<Mode>();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const active = useRef(false);
  const keyField = useRef<HTMLInputElement>(null);
  const savedKey = useRef<HTMLParagraphElement>(null);
  const tiles = useRef<Partial<Record<Mode, HTMLButtonElement | null>>>({});
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
    try {
      const next = await api<IntegrationKeyStatus>('/api/integrations/key');
      if (active.current) setStatus(next);
    } catch {}
  }

  useEffect(() => {
    active.current = true;
    void reload();
    return () => {
      active.current = false;
    };
  }, []);

  async function apply(value?: string) {
    if (switching || checking) return;
    const capture = analyticsForCurrentSession();
    setSwitching(true);
    setError('');
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
    await Promise.all([
      next || reload(),
      pageDataCache.refresh('/api/apps', true),
      pageDataCache.refresh('/api/configuration', true),
      onChanged?.(),
    ]);
    if (!active.current) return;
    flushSync(() => {
      setSwitching(false);
      if (next) {
        setStatus(next);
        setChoice(undefined);
        setEditing(false);
        setKey('');
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
    if (!status || next === mode || switching) return;
    flushSync(() => {
      setError('');
      setEditing(false);
      setKey('');
      setChoice(next === status.mode ? undefined : next);
    });
    keyField.current?.focus();
  }

  function edit(value: boolean) {
    flushSync(() => {
      setEditing(value);
      setKey('');
      setError('');
    });
    (value ? keyField : savedKey).current?.focus();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const value = key.trim();
    if (!value) return setError('Paste your Composio key first.');
    void apply(value);
  }

  return {
    status,
    mode,
    switching,
    reload,
    view: {
      editing,
      key,
      error,
      checking,
      linked,
      keyField,
      savedKey,
      tiles,
      apply,
      pick,
      edit,
      save,
      type: (value: string) => {
        setKey(value);
        setError('');
      },
    },
  };
}

export function ConnectionChoice({
  state: { status, mode, switching, view },
  disabled = false,
  className,
}: {
  state: ReturnType<typeof useConnectionChoice>;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  if (!status?.switchable || !mode) return null;
  const locked = disabled || switching;
  const confirmLocked = locked || view.checking;
  const changing = mode !== status.mode;
  const unreadable = status.mode === 'own' && !status.suffix;
  const unknown = !view.linked && !view.checking;
  let warning = '';
  if (changing && !unreadable)
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
          ) : (
            'Otto can’t read your saved key. Save it again or switch to Otto’s connection.'
          )}
        </p>
        <button
          type="button"
          className="connection-link"
          disabled={locked}
          onClick={() => view.edit(true)}
        >
          Change
        </button>
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
            disabled={locked}
            aria-invalid={!!view.error}
            aria-describedby={view.error ? `${id}-error` : undefined}
            data-analytics-private
            onChange={(event) => view.type(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={confirmLocked}
            aria-describedby={warning ? `${id}-warning` : undefined}
          >
            {switching && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {switching ? 'Checking' : 'Save'}
          </Button>
        </div>
        <p className="connection-muted">
          <a href="https://platform.composio.dev" target="_blank" rel="noreferrer">
            Get a key from Composio
          </a>
          . It’s encrypted and never shown to the AI.
        </p>
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
    <div className={cn('connection-choice', className)}>
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
              <span className="connection-muted">{item.sub}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="connection-muted">{connectionRoutes[mode]}</p>
      {panel}
      {view.error && (
        <p id={`${id}-error`} role="alert" className="connection-error">
          {view.error}
        </p>
      )}
    </div>
  );
}
