import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  UserRound,
  X,
} from 'lucide-react';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../shared/models';
import { modelProviderNames, modelSource } from '../../shared/models';
import { agentModels } from '../../shared/model-defaults';
import { BrandMark } from './brand';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
  SearchField,
} from './ui';

function useModels() {
  const page = usePageData<ModelsResponse>('/api/models');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(path: string, method: string, body?: unknown) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<ModelsResponse>(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      page.update(() => result);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { ...page, busy, error: error || page.error, setError, change };
}

function ModelConnectionAvatar({ connection }: { connection: ModelConnection }) {
  const initials =
    connection.method !== 'api_key' && connection.label.includes('@')
      ? connection.label
          .split('@')[0]
          .split(/[.\s_-]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => Array.from(part)[0])
          .join('')
          .toLocaleUpperCase()
      : '';
  return (
    <span className={`model-connection-avatar${initials ? '' : ' neutral'}`} aria-hidden="true">
      {initials ||
        (connection.method === 'api_key' ? <KeyRound size={18} /> : <UserRound size={19} />)}
      <span className="model-connection-provider">
        <span className={`model-provider-logo ${connection.provider}`} />
      </span>
    </span>
  );
}

export function ModelSettings({
  onDirtyChange,
  onboarding = false,
}: {
  onDirtyChange?(dirty: boolean): void;
  onboarding?: boolean;
} = {}) {
  const models = useModels();
  const [keyProvider, setKeyProvider] = useState<ModelProvider | null>(null);
  const [key, setKey] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signIn, setSignIn] = useState<{ url: string; attempt: string } | null>(null);
  const activeAttempt = useRef<string | null>(null);
  const mounted = useRef(true);
  const [callback, setCallback] = useState('');
  const dirty = models.busy || signingIn || !!signIn || Boolean(key.trim());
  const available = models.data?.connections.filter(
    (connection) => connection.status === 'connected' && connection.models.length > 0,
  ).length;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeAttempt.current)
        void api(`/api/models/oauth/${activeAttempt.current}`, { method: 'DELETE' }).catch(
          () => {},
        );
    };
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!signIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + 600000;
    async function check() {
      try {
        const result = await api<{ status: 'waiting' | 'connected' | 'failed'; error?: string }>(
          `/api/models/oauth/status/${signIn!.attempt}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.status === 'connected') {
          await models.refresh();
          if (!controller.signal.aborted) {
            models.setError(result.error ?? '');
            activeAttempt.current = null;
            setSignIn(null);
          }
          return;
        }
        if (result.status === 'failed') {
          models.setError(result.error ?? 'Sign-in failed. Start a new connection.');
          activeAttempt.current = null;
          setSignIn(null);
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        models.setError(errorMessage(cause));
      }
      if (Date.now() >= expires) {
        models.setError('Sign-in expired. Start a new connection.');
        void api(`/api/models/oauth/${signIn!.attempt}`, { method: 'DELETE' }).catch(() => {});
        activeAttempt.current = null;
        setSignIn(null);
      } else timer = setTimeout(() => void check(), 2000);
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [signIn, models.refresh]);
  async function cancelSignIn() {
    if (!signIn) return;
    setSigningIn(true);
    try {
      await api(`/api/models/oauth/${signIn.attempt}`, { method: 'DELETE' });
      activeAttempt.current = null;
      if (mounted.current) {
        setSignIn(null);
        setCallback('');
      }
    } catch (cause) {
      if (mounted.current) models.setError(errorMessage(cause));
    } finally {
      if (mounted.current) setSigningIn(false);
    }
  }
  async function connect(provider: 'openai' | 'openrouter', connectionId?: string) {
    if (signingIn || signIn) return;
    const desktop = desktopLinksAvailable();
    const popup = desktop ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setSigningIn(true);
    models.setError('');
    try {
      const response = await post<{ url: string; attempt: string }>('/api/models/oauth', {
        provider,
        connectionId,
      });
      activeAttempt.current = response.attempt;
      if (!mounted.current) {
        await api(`/api/models/oauth/${response.attempt}`, { method: 'DELETE' });
        activeAttempt.current = null;
        popup?.close();
        return;
      }
      const url = connectionUrl(response.url, window.location.origin);
      setSignIn({ url, attempt: response.attempt });
      if (desktop) await openConnection(url);
      else if (popup) popup.location.replace(url);
    } catch (cause) {
      popup?.close();
      if (activeAttempt.current) {
        await api(`/api/models/oauth/${activeAttempt.current}`, { method: 'DELETE' }).catch(
          () => {},
        );
        activeAttempt.current = null;
      }
      if (mounted.current) {
        setSignIn(null);
        models.setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current) setSigningIn(false);
    }
  }
  if (!models.data) return models.loading ? <Loading /> : <Notice>{models.error}</Notice>;
  const data = models.data;
  const busy = models.busy || signingIn || !!signIn;
  return (
    <div className="model-settings" data-desktop-settings-pending={dirty || undefined}>
      <p className="model-intro" data-analytics-public>
        Connect as many services as you want. All their models appear in one list.
      </p>
      {!onboarding && !!available && (
        <div className="model-current">
          <span>Your model</span>
          <ModelPicker manageConnections={false} />
        </div>
      )}
      <div className="model-services">
        {(['openai', 'anthropic', 'openrouter'] as ModelProvider[]).map((provider) => (
          <section
            className="model-service"
            key={provider}
            aria-label={modelProviderNames[provider]}
          >
            <div className="model-service-heading" data-analytics-public>
              <div className="model-service-identity">
                <span className={`model-provider-logo ${provider}`} aria-hidden="true" />
                <div>
                  <h4>{modelProviderNames[provider]}</h4>
                  <p>
                    {provider === 'openai'
                      ? data.subscriptionAvailable
                        ? 'API key or ChatGPT plan'
                        : 'API key'
                      : provider === 'anthropic'
                        ? 'API key for Claude models'
                        : 'Many models with one connection'}
                  </p>
                </div>
              </div>
              <div className="model-service-actions">
                {(provider === 'openrouter' ||
                  (provider === 'openai' && data.subscriptionAvailable)) && (
                  <Button
                    type="button"
                    className="model-connect-button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void connect(provider as 'openai' | 'openrouter')}
                  >
                    <span className={`model-provider-logo ${provider}`} aria-hidden="true" />
                    {provider === 'openai' ? 'Connect ChatGPT' : 'Connect account'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setKey('');
                    setKeyProvider(keyProvider === provider ? null : provider);
                  }}
                >
                  <KeyRound size={14} />
                  Add API key
                </Button>
              </div>
            </div>
            {keyProvider === provider && (
              <form
                className="model-key-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = key;
                  setKey('');
                  void models
                    .change('/api/models/keys', 'POST', { provider, key: value })
                    .then((saved) => {
                      if (saved) setKeyProvider(null);
                    });
                }}
              >
                <Field
                  label={`${modelProviderNames[provider]} API key`}
                  hint="Your saved key stays private."
                >
                  <Input
                    type="password"
                    value={key}
                    required
                    minLength={8}
                    maxLength={32000}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    disabled={busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                <div>
                  <Button type="submit" size="sm" disabled={busy || !key.trim()}>
                    {busy ? 'Connecting…' : 'Save connection'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setKey('');
                      setKeyProvider(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {data.connections
              .filter((connection) => connection.provider === provider)
              .map((connection) => (
                <div className="model-connection" key={connection.id}>
                  <div className="model-connection-label">
                    <ModelConnectionAvatar connection={connection} />
                    <div className="model-connection-identity">
                      <strong>{connection.label}</strong>
                      <span className={`model-connection-meta ${connection.status}`}>
                        {connection.status === 'reconnect'
                          ? 'Reconnect to continue'
                          : connection.status === 'loading'
                            ? 'Connected · Load models to continue'
                            : `${modelSource(connection)} · ${connection.models.length} models`}
                        {connection.managed && ' · Server settings'}
                      </span>
                    </div>
                  </div>
                  <div className="model-connection-controls">
                    {data.selection?.connectionId === connection.id && (
                      <span className="model-connection-selected">
                        <Check size={12} aria-hidden="true" />
                        Selected
                      </span>
                    )}
                    <div className="model-service-actions">
                      {connection.method !== 'api_key' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void connect(provider as 'openai' | 'openrouter', connection.id)
                          }
                        >
                          Reconnect
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size={connection.status === 'loading' ? 'sm' : 'icon'}
                        aria-label={`Refresh ${connection.label} models`}
                        disabled={busy}
                        onClick={() =>
                          void models.change(
                            `/api/models/connections/${connection.id}/refresh`,
                            'POST',
                          )
                        }
                      >
                        <RefreshCw size={15} />
                        {connection.status === 'loading' && 'Load models'}
                      </Button>
                      {!connection.managed && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${connection.label}`}
                          disabled={busy}
                          onClick={() =>
                            void models.change(`/api/models/connections/${connection.id}`, 'DELETE')
                          }
                        >
                          <X size={15} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </section>
        ))}
        {onboarding && !!available && (
          <section className="model-service model-choice" aria-label="Choose your model">
            <div className="model-service-heading">
              <div>
                <h4>Choose your model</h4>
                <p>All models from your connected services</p>
              </div>
              <div className="model-service-actions">
                <ModelPicker manageConnections={false} />
              </div>
            </div>
          </section>
        )}
      </div>
      {signIn && (
        <div className="model-sign-in">
          <p>
            Complete sign-in in the browser, then return to Otto. If the browser ends on a page that
            does not load, copy its full address and paste it below.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (desktopLinksAvailable())
                void openConnection(signIn.url).catch((cause) =>
                  models.setError(errorMessage(cause)),
                );
              else window.open(signIn.url, '_blank', 'noopener,noreferrer');
            }}
          >
            Open sign-in <ExternalLink size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={signingIn}
            onClick={() => void cancelSignIn()}
          >
            Cancel sign-in
          </Button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const url = callback;
              setCallback('');
              void models.change('/api/models/oauth/complete', 'POST', { url }).then((saved) => {
                if (saved) {
                  activeAttempt.current = null;
                  setSignIn(null);
                }
              });
            }}
          >
            <Field label="Callback URL">
              <Input
                value={callback}
                autoComplete="off"
                disabled={models.busy}
                onChange={(event) => setCallback(event.target.value)}
                required
                type="url"
              />
            </Field>
            <Button type="submit" size="sm" disabled={models.busy}>
              Complete sign-in
            </Button>
          </form>
        </div>
      )}
      {models.error && <Notice>{models.error}</Notice>}
      {!onboarding && (
        <details className="model-details">
          <summary>Connection details</summary>
          <p className="model-footnote">
            Claude plans do not support this connection. Use an Anthropic API key or OpenRouter.{' '}
            <a
              href="https://code.claude.com/docs/en/legal-and-compliance"
              target="_blank"
              rel="noreferrer"
            >
              Provider conditions
            </a>
          </p>
          {!data.subscriptionAvailable && (
            <p className="model-footnote">ChatGPT plan sign-in is available in local Otto.</p>
          )}
          <p className="model-footnote">Voice needs an OpenAI API key in server settings.</p>
        </details>
      )}
    </div>
  );
}

export function ModelPicker({
  setup = false,
  manageConnections = true,
}: {
  setup?: boolean;
  manageConnections?: boolean;
}) {
  const models = useModels();
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [search, setSearch] = useState('');
  const selected = models.data?.selection;
  const connection = models.data?.connections.find((item) => item.id === selected?.connectionId);
  const model = connection?.models.find((item) => item.id === selected?.modelId);
  const canChoose = models.data?.connections.some(
    (source) => source.status === 'connected' && source.models.length > 0,
  );
  const choices = (models.data?.connections ?? [])
    .filter((source) => source.status === 'connected')
    .flatMap((source) =>
      source.models.map((item) => ({
        source,
        item,
        recommended:
          item.id === agentModels[source.provider] || item.id === 'anthropic/claude-opus-5.5',
      })),
    )
    .filter(({ source, item }) =>
      `${item.name} ${item.id} ${source.label} ${modelSource(source)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.recommended) - Number(a.recommended) ||
        a.item.name.localeCompare(b.item.name) ||
        modelSource(a.source).localeCompare(modelSource(b.source)),
    );
  async function choose(source: ModelConnection, id: string) {
    const efforts = source.models.find((item) => item.id === id)?.efforts ?? [];
    const effort = efforts.includes('high') ? 'high' : efforts[0];
    if (
      await models.change('/api/models/selection', 'PUT', {
        connectionId: source.id,
        modelId: id,
        effort,
      })
    )
      setOpen(false);
  }
  return (
    <div className={`model-picker${setup ? ' model-picker-setup' : ''}`}>
      <Button
        type="button"
        variant={setup ? 'default' : 'ghost'}
        size={setup ? 'default' : 'sm'}
        className="model-picker-trigger"
        onClick={() => {
          setSearch('');
          canChoose ? setOpen(true) : setManage(true);
        }}
        aria-label={setup && !canChoose ? 'Connect a model' : 'Choose model'}
        disabled={models.loading}
      >
        {model && !setup ? (
          <>
            <span className="model-picker-name">{model.name}</span>
            <ChevronDown size={13} />
          </>
        ) : (
          <>
            <Plus size={14} />
            {canChoose ? 'Choose a model' : 'Connect a model'}
          </>
        )}
      </Button>
      {model && !setup && (
        <span
          className={`model-picker-source ${connection?.status === 'reconnect' ? 'model-needs-reconnect' : ''}`}
        >
          {connection?.status === 'reconnect' ? 'Reconnect in Models' : modelSource(connection!)}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="model-picker-dialog" aria-describedby="model-picker-description">
          <DialogTitle>Choose model</DialogTitle>
          <p id="model-picker-description" className="model-intro">
            All models from your connected services. Your choice applies to the next turn.
          </p>
          <SearchField
            placeholder="Search models or services"
            aria-label="Search models"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
          />
          <div className="model-options">
            {choices.map(({ source, item, recommended }) => {
              const active = selected?.connectionId === source.id && selected.modelId === item.id;
              return (
                <button
                  type="button"
                  key={`${source.id}:${item.id}`}
                  className="model-option"
                  aria-pressed={active}
                  disabled={models.busy}
                  onClick={() => void choose(source, item.id)}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {modelSource(source)}
                      {source.label !== modelSource(source) ? ` · ${source.label}` : ''}
                      {' · '}
                      {Math.round(item.contextWindow / 1000)}k context
                      {item.images ? ' · Images' : ''}
                    </small>
                  </span>
                  {active ? <Check size={16} /> : recommended && <small>Recommended</small>}
                </button>
              );
            })}
            {!choices.length && (
              <p className="model-empty">No available models match this search.</p>
            )}
          </div>
          {models.error && <Notice>{models.error}</Notice>}
          {manageConnections && (
            <Button
              type="button"
              variant="ghost"
              className="model-manage"
              onClick={() => {
                setOpen(false);
                setManage(true);
              }}
            >
              <SlidersHorizontal size={15} />
              Manage connections
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={manage} onOpenChange={setManage}>
        <DialogContent className="model-settings-dialog" aria-describedby={undefined}>
          <DialogTitle>Models</DialogTitle>
          <ModelSettings />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ModelSetup() {
  const { data } = useModels();
  const available = data?.connections.some(
    (connection) => connection.status === 'connected' && connection.models.length > 0,
  );
  return (
    <div className="welcome model-setup">
      <BrandMark />
      <h2>{available ? 'Choose your model' : 'Connect your model'}</h2>
      <p>{available ? 'All your models, in one place.' : 'Use your ChatGPT plan or an API key.'}</p>
      <ModelPicker setup />
    </div>
  );
}
