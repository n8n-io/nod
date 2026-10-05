import { useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  ModelConnection,
  ModelEffort,
  ModelProvider,
  ModelsResponse,
} from '../../shared/models';
import { modelProviderNames, modelSource } from '../../shared/models';
import { agentModels } from '../../shared/model-defaults';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, post } from '../lib/api';
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

const effortNames: Record<ModelEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};
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

export function ModelSettings() {
  const models = useModels();
  const [keyProvider, setKeyProvider] = useState<ModelProvider | null>(null);
  const [key, setKey] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [signInUrl, setSignInUrl] = useState('');
  const [callback, setCallback] = useState('');
  async function connect(provider: 'openai' | 'openrouter', connectionId?: string) {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setSigningIn(true);
    models.setError('');
    try {
      const { url } = await post<{ url: string }>('/api/models/oauth', { provider, connectionId });
      setSignInUrl(url);
      if (popup) popup.location.replace(url);
    } catch (cause) {
      popup?.close();
      models.setError(errorMessage(cause));
    } finally {
      setSigningIn(false);
    }
  }
  if (!models.data) return models.loading ? <Loading /> : <Notice>{models.error}</Notice>;
  const data = models.data;
  const busy = models.busy || signingIn;
  return (
    <div className="model-settings">
      <p className="model-intro">
        Connect a service, then choose a model in chat. Your choice applies to all channels on the
        next turn.
      </p>
      <div className="model-services">
        {(['openai', 'anthropic', 'openrouter'] as ModelProvider[]).map((provider) => (
          <section
            className="model-service"
            key={provider}
            aria-label={modelProviderNames[provider]}
          >
            <div className="model-service-heading">
              <div>
                <h4>{modelProviderNames[provider]}</h4>
                <p>
                  {provider === 'openai'
                    ? 'API key or ChatGPT plan'
                    : provider === 'anthropic'
                      ? 'Claude models with an API key'
                      : 'Many models with one connection'}
                </p>
              </div>
              <div className="model-service-actions">
                {(provider === 'openrouter' ||
                  (provider === 'openai' && data.subscriptionAvailable)) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void connect(provider as 'openai' | 'openrouter')}
                  >
                    <Plus size={14} />
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
                  hint="The server encrypts your key. Otto does not return it to this page."
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
                    <span className={`model-status ${connection.status}`} aria-hidden="true" />
                    <div>
                      <strong>{connection.label}</strong>
                      <span>
                        {connection.status === 'reconnect'
                          ? 'Reconnect to continue'
                          : `${modelSource(connection)} · ${connection.models.length} models`}
                        {data.selection?.connectionId === connection.id && ' · Selected'}
                        {connection.managed && ' · Server settings'}
                      </span>
                    </div>
                  </div>
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
                      size="icon"
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
              ))}
          </section>
        ))}
      </div>
      {signInUrl && (
        <div className="model-sign-in">
          <p>Complete sign-in in the browser, then return to Otto.</p>
          <a href={signInUrl} target="_blank" rel="noreferrer">
            Open sign-in <ExternalLink size={13} />
          </a>
          <details>
            <summary>Callback did not open?</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const url = callback;
                setCallback('');
                void models.change('/api/models/oauth/complete', 'POST', { url }).then((saved) => {
                  if (saved) setSignInUrl('');
                });
              }}
            >
              <Field label="Callback URL">
                <Input
                  value={callback}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => setCallback(event.target.value)}
                  required
                  type="url"
                />
              </Field>
              <Button type="submit" size="sm" disabled={busy}>
                Complete sign-in
              </Button>
            </form>
          </details>
        </div>
      )}
      {models.error && <Notice>{models.error}</Notice>}
      <p className="model-footnote">
        Claude subscriptions cannot supply API tokens to Otto. Use an Anthropic key or OpenRouter.{' '}
        <a
          href="https://code.claude.com/docs/en/legal-and-compliance"
          target="_blank"
          rel="noreferrer"
        >
          Provider conditions
        </a>
      </p>
      {!data.subscriptionAvailable && (
        <p className="model-footnote">
          ChatGPT plan sign-in is available in local Otto. Hosted use needs OpenAI access.
        </p>
      )}
      <p className="model-footnote">
        Voice uses the separate OpenAI API key in server settings. A ChatGPT plan does not enable
        voice.
      </p>
    </div>
  );
}

export function ModelPicker() {
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
  async function choose(source: ModelConnection, id: string, effort: ModelEffort) {
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
    <div className="model-picker">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="model-picker-trigger"
        onClick={() => {
          setSearch('');
          canChoose ? setOpen(true) : setManage(true);
        }}
        aria-label="Choose model"
        disabled={models.loading}
      >
        {model ? (
          <>
            <span className="model-picker-name">{model.name}</span>
            <span className="model-picker-effort">{effortNames[selected!.effort]}</span>
            <ChevronDown size={13} />
          </>
        ) : (
          <>
            <Plus size={14} />
            {canChoose ? 'Choose a model' : 'Connect a model'}
          </>
        )}
      </Button>
      {model && (
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
            The next turn uses this model and connection.
          </p>
          <SearchField
            placeholder="Search models or services"
            aria-label="Search models"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
          />
          <div className="model-options">
            {models.data?.connections
              .filter((source) => source.status === 'connected')
              .map((source) => {
                const choices = source.models
                  .filter((item) =>
                    `${item.name} ${item.id} ${source.label} ${modelSource(source)}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .sort(
                    (a, b) =>
                      Number(
                        b.id === agentModels[source.provider] ||
                          b.id === 'anthropic/claude-opus-5.5',
                      ) -
                        Number(
                          a.id === agentModels[source.provider] ||
                            a.id === 'anthropic/claude-opus-5.5',
                        ) || a.name.localeCompare(b.name),
                  );
                if (!choices.length) return null;
                return (
                  <section key={source.id} aria-label={source.label}>
                    <h4>
                      {modelSource(source)}
                      <span>{source.label !== modelSource(source) ? source.label : ''}</span>
                    </h4>
                    {choices.map((item) => {
                      const active =
                        selected?.connectionId === source.id && selected.modelId === item.id;
                      const effort = active
                        ? selected.effort
                        : item.efforts.includes('high')
                          ? 'high'
                          : item.efforts[0];
                      return (
                        <button
                          type="button"
                          key={item.id}
                          className="model-option"
                          aria-pressed={active}
                          disabled={models.busy}
                          onClick={() => void choose(source, item.id, effort)}
                        >
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {Math.round(item.contextWindow / 1000)}k context
                              {item.images ? ' · Images' : ''}
                            </small>
                          </span>
                          {active ? (
                            <Check size={16} />
                          ) : (
                            (item.id === agentModels[source.provider] ||
                              item.id === 'anthropic/claude-opus-5.5') && <small>Recommended</small>
                          )}
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            {!models.data?.connections.some(
              (source) =>
                source.status === 'connected' &&
                source.models.some((item) =>
                  `${item.name} ${item.id} ${source.label} ${modelSource(source)}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                ),
            ) && <p className="model-empty">No available models match this search.</p>}
          </div>
          {model && model.efforts.length > 1 && (
            <div className="model-efforts">
              <span>Effort</span>
              <div role="group" aria-label="Model effort">
                {model.efforts.map((effort) => (
                  <Button
                    type="button"
                    key={effort}
                    variant={selected!.effort === effort ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={selected!.effort === effort}
                    disabled={models.busy}
                    onClick={() => void choose(connection!, model.id, effort)}
                  >
                    {effortNames[effort]}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {models.error && <Notice>{models.error}</Notice>}
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
