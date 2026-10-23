import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UserRound,
  X,
} from './icons';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../shared/models';
import { modelProviderNames, modelSource } from '../../shared/models';
import { agentModels } from '../../shared/model-defaults';
import { analyticsForCurrentSession } from '../lib/analytics';
import {
  keyConnection,
  keySettingsReady,
  localServerAddress,
  modelProviders,
  modelSelection,
  noKeySettings,
  useModelSignIn,
  useModels,
  type KeySettings,
} from '../hooks/use-models';
import { usePageData } from '../hooks/use-page-data';
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
        (connection.provider === 'compatible' ? (
          <Server size={16} />
        ) : connection.method === 'api_key' ? (
          <KeyRound size={16} />
        ) : (
          <UserRound size={24} />
        ))}
      {connection.provider !== 'compatible' && (
        <span className="model-connection-provider">
          <span className={`model-provider-logo ${connection.provider}`} />
        </span>
      )}
    </span>
  );
}

export function CloudKeyFields({
  provider,
  value,
  onChange,
  disabled,
}: {
  provider: ModelProvider;
  value: KeySettings;
  onChange(value: KeySettings): void;
  disabled?: boolean;
}) {
  if (provider === 'amazon-bedrock')
    return (
      <Field label="Region">
        <Input
          value={value.region}
          required
          maxLength={100}
          placeholder="us-east-1"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={disabled}
          onChange={(event) => onChange({ ...value, region: event.target.value })}
        />
      </Field>
    );
  if (provider === 'azure') return <AzureKeyFields {...{ value, onChange, disabled }} />;
  return null;
}

function AzureKeyFields({
  value,
  onChange,
  disabled,
}: {
  value: KeySettings;
  onChange(value: KeySettings): void;
  disabled?: boolean;
}) {
  const catalog = usePageData<{ models: { id: string; name: string }[] }>('/api/models/azure');
  const models = catalog.data?.models ?? [];
  return (
    <>
      <Field label="Endpoint">
        <Input
          inputMode="url"
          value={value.url}
          required
          maxLength={2000}
          placeholder="https://your-resource.openai.azure.com"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={disabled}
          onChange={(event) => onChange({ ...value, url: event.target.value })}
        />
      </Field>
      <Field label="Deployment name">
        <Input
          value={value.deployment}
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            const deployment = event.target.value;
            const named = models.find((model) => model.id === deployment.trim());
            onChange({ ...value, deployment, model: named?.id ?? value.model });
          }}
        />
      </Field>
      <Field label="Model">
        <select
          className="input"
          value={value.model}
          required
          disabled={disabled || !models.length}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
        >
          <option value="" disabled>
            {catalog.error ? 'Models couldn’t load' : 'Choose the model it runs'}
          </option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

export function ModelSettings({
  onDirtyChange,
}: {
  onDirtyChange?(dirty: boolean): void;
} = {}) {
  const models = useModels();
  const [keyProvider, setKeyProvider] = useState<ModelProvider | null>(null);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const flow = useModelSignIn(models);
  const { signIn, pending: signingIn, connect } = flow;
  const [callback, setCallback] = useState('');
  const dirty =
    models.busy ||
    signingIn ||
    !!signIn ||
    Boolean(
      key.trim() ||
      (url.trim() && url.trim() !== localServerAddress) ||
      Object.values(settings).some((value) => value.trim()),
    );
  const available = models.data?.connections.filter(
    (connection) => connection.status === 'connected' && connection.models.length > 0,
  ).length;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  if (!models.data) return models.loading ? <Loading /> : <Notice>{models.error}</Notice>;
  const data = models.data;
  const busy = models.busy || signingIn || !!signIn;
  return (
    <div className="model-settings">
      {!!available && (
        <div className="model-current">
          <div className="model-current-label" data-analytics-public>
            <strong>Your model</strong>
            <span>nod uses it for every reply</span>
          </div>
          <ModelPicker manageConnections={false} surface="settings" />
        </div>
      )}
      <p className="model-intro" data-analytics-public>
        Connect as many services as you want. All their models appear in one list.
      </p>
      <div className="model-services">
        {modelProviders.map((provider) => (
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
                      ? 'ChatGPT Plus or Pro plan, or an API key'
                      : provider === 'anthropic'
                        ? 'API key only. Claude plans can’t be used here.'
                        : provider === 'openrouter'
                          ? 'Many models with one API key'
                          : provider === 'amazon-bedrock'
                            ? 'Models in your AWS account'
                            : provider === 'google-vertex'
                              ? 'Gemini with a Google Cloud API key'
                              : provider === 'azure'
                                ? 'A deployment in your Azure resource'
                                : 'Ollama, LM Studio, vLLM or any other server'}
                  </p>
                </div>
              </div>
              <div className="model-service-actions">
                {(provider === 'openrouter' || provider === 'openai') && (
                  <Button
                    type="button"
                    className="model-connect-button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void connect(provider as 'openai' | 'openrouter')}
                  >
                    <span className={`model-provider-logo ${provider}`} aria-hidden="true" />
                    {provider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setKey('');
                    setUrl(localServerAddress);
                    setSettings(noKeySettings);
                    setKeyProvider(keyProvider === provider ? null : provider);
                  }}
                >
                  {provider === 'compatible' ? <Plus size={16} /> : <KeyRound size={16} />}
                  {provider === 'compatible' ? 'Add server' : 'Add API key'}
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
                    .change(
                      provider === 'compatible' ? '/api/models/endpoints' : '/api/models/keys',
                      'POST',
                      provider === 'compatible'
                        ? { url: url.trim(), key: value }
                        : keyConnection(provider, value, settings),
                    )
                    .then((saved) => {
                      if (saved) {
                        setUrl('');
                        setSettings(noKeySettings);
                        setKeyProvider(null);
                      }
                    });
                }}
              >
                {provider === 'compatible' && (
                  <Field label="Server address">
                    <Input
                      inputMode="url"
                      value={url}
                      required
                      maxLength={2000}
                      placeholder={localServerAddress}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      disabled={busy}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </Field>
                )}
                <CloudKeyFields
                  provider={provider}
                  value={settings}
                  onChange={setSettings}
                  disabled={busy}
                />
                <Field
                  label={
                    provider === 'compatible'
                      ? 'API key (optional)'
                      : `${modelProviderNames[provider]} API key`
                  }
                  hint={provider === 'compatible' ? undefined : 'Your saved key stays private.'}
                >
                  <Input
                    type="password"
                    value={key}
                    required={provider !== 'compatible'}
                    minLength={provider === 'compatible' ? undefined : 8}
                    maxLength={32000}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={!['compatible', 'amazon-bedrock', 'azure'].includes(provider)}
                    disabled={busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                {provider === 'compatible' && (
                  <p className="model-key-note">
                    nod also uses this model to decide when to ask you before acting. Smaller models
                    decide less reliably.
                  </p>
                )}
                <div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      busy ||
                      !(provider === 'compatible'
                        ? url.trim()
                        : key.trim() && keySettingsReady(provider, settings))
                    }
                  >
                    {busy ? 'Connecting…' : 'Save connection'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setKey('');
                      setUrl('');
                      setSettings(noKeySettings);
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
                          ? connection.provider !== 'compatible'
                            ? 'Reconnect to continue'
                            : connection.managed
                              ? 'Can’t load its models · Refresh to retry'
                              : 'Remove it and add the server again'
                          : connection.status === 'loading'
                            ? 'Connected · Load models to continue'
                            : `${modelSource(connection)} · ${connection.models.length} ${connection.models.length === 1 ? 'model' : 'models'}`}
                        {connection.managed && ' · Server settings'}
                      </span>
                    </div>
                  </div>
                  <div className="model-connection-controls">
                    {data.selection?.connectionId === connection.id && (
                      <span className="model-connection-selected">
                        <Check size={16} aria-hidden="true" />
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
                        <RefreshCw size={16} />
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
                          <X size={16} />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </section>
        ))}
      </div>
      {signIn && (
        <div className="model-sign-in">
          <p>
            Complete sign-in in the browser, then return to nod. If the browser ends on a page that
            does not load, copy its full address and paste it below.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={flow.reopen}>
            Open sign-in <ExternalLink size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={signingIn}
            onClick={() => void flow.cancel().then((done) => done && setCallback(''))}
          >
            Cancel sign-in
          </Button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const url = callback;
              setCallback('');
              void flow.complete(url);
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
        <p className="model-footnote">
          Voice input uses an OpenAI or OpenRouter API key. Voice replies need OpenAI.
        </p>
      </details>
    </div>
  );
}

export function ModelPicker({
  manageConnections = true,
  surface = 'settings',
}: {
  manageConnections?: boolean;
  surface?: 'settings' | 'onboarding';
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
  async function choose(source: ModelConnection, id: string, recommended: boolean) {
    if (models.busy) return;
    const capture = analyticsForCurrentSession();
    if (await models.change('/api/models/selection', 'PUT', modelSelection(source, id))) {
      capture('nod_model_selected', {
        provider: source.provider in modelProviderNames ? source.provider : 'other',
        entry: surface,
        recommended,
      });
      setOpen(false);
    } else capture('nod_ui_error', { area: 'models', action: 'save' });
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
        aria-label={
          model
            ? `${canChoose ? 'Choose model' : 'Manage model connections'}: ${model.name}, ${connection!.label}`
            : canChoose
              ? 'Choose a model'
              : 'Connect a model'
        }
        title={model ? `${model.name} · ${connection!.label}` : undefined}
        disabled={models.loading}
      >
        {model ? (
          <>
            <span className="model-picker-name">{model.name}</span>
            <ChevronDown size={16} />
          </>
        ) : (
          <>
            <Plus size={16} />
            {canChoose ? 'Choose a model' : 'Connect a model'}
          </>
        )}
      </Button>
      {surface === 'settings' && model && connection?.status === 'reconnect' && (
        <a className="model-needs-reconnect" href="/settings/models">
          Reconnect in Settings &gt; Models
        </a>
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
                  onClick={() => void choose(source, item.id, recommended)}
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
              <SlidersHorizontal size={16} />
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
