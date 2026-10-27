import { useEffect, useId, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ExternalLink,
  FileAudio,
  FileImage,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UserRound,
  X,
} from './icons';
import type { ModelConnection, ModelProvider } from '../../shared/models';
import { modelKeyError } from '../../shared/model-keys';
import {
  modelProviderInfo,
  modelProviderNames,
  modelProviders,
  modelSource,
} from '../../shared/models';
import { analyticsForCurrentSession } from '../lib/analytics';
import {
  keyConnection,
  keySettingsReady,
  localServerAddress,
  modelSelection,
  noKeySettings,
  recommendedModel,
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

const modelProviderLogos: Partial<Record<ModelProvider, string>> = {
  openai: 'models/openai',
  anthropic: 'models/anthropic',
  google: 'models/google',
  openrouter: 'models/openrouter',
  'amazon-bedrock': 'models/amazon-bedrock',
  'google-vertex': 'models/google-vertex',
  azure: 'models/azure',
  'ant-ling': 'models/ant-ling',
  baseten: 'models/baseten',
  cerebras: 'models/cerebras',
  'cloudflare-workers-ai': 'models/cloudflare',
  'cloudflare-ai-gateway': 'models/cloudflare',
  deepseek: 'models/deepseek',
  fireworks: 'models/fireworks',
  groq: 'models/groq',
  huggingface: 'models/huggingface',
  'kimi-coding': 'models/kimi',
  meta: 'models/meta',
  minimax: 'models/minimax',
  'minimax-cn': 'models/minimax',
  mistral: 'models/mistral',
  moonshotai: 'models/moonshot',
  'moonshotai-cn': 'models/moonshot',
  nvidia: 'models/nvidia',
  opencode: 'models/opencode',
  'opencode-go': 'models/opencode-go',
  'qwen-token-plan': 'models/qwen',
  'qwen-token-plan-cn': 'models/qwen',
  'qwen-token-plan-individual': 'models/qwen',
  radius: 'models/radius',
  together: 'models/together',
  'vercel-ai-gateway': 'models/vercel',
  xai: 'models/xai',
  xiaomi: 'models/xiaomi',
  'xiaomi-token-plan-ams': 'models/xiaomi',
  'xiaomi-token-plan-cn': 'models/xiaomi',
  'xiaomi-token-plan-sgp': 'models/xiaomi',
  zai: 'models/zai',
  'zai-coding-cn': 'models/zai',
  compatible: 'server',
};

export function ModelProviderLogo({
  provider,
  size = 16,
}: {
  provider: ModelProvider;
  size?: number;
}) {
  return (
    <span
      className="model-provider-logo"
      style={{
        width: size,
        height: size,
        maskImage: `url('/logos/${modelProviderLogos[provider] ?? 'server'}.svg')`,
      }}
      aria-hidden="true"
    />
  );
}

export function ModelKeyHelp({
  provider,
  className = 'model-key-note',
}: {
  provider: ModelProvider;
  className?: string;
}) {
  const info = modelProviderInfo[provider];
  return (
    <>
      <p className={className}>
        <a href={`https://${info.keyUrl}`} target="_blank" rel="noreferrer">
          Get API key
        </a>
        {' · '}Your saved key stays private.
        {info.catalog === 'bundled' && ' Access checked on first use.'}
      </p>
      {provider === 'google' && (
        <p className={className}>
          <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">
            Free tier available with limits.
          </a>{' '}
          Google sign-in and AI app plans are separate from API access.
        </p>
      )}
      {provider === 'cloudflare-workers-ai' && (
        <p className={className}>
          Use a token with Workers AI Read and Edit permissions.{' '}
          <a
            href="https://developers.cloudflare.com/workers-ai/get-started/rest-api/"
            target="_blank"
            rel="noreferrer"
          >
            Token setup
          </a>
        </p>
      )}
      {provider === 'cloudflare-ai-gateway' && (
        <p className={className}>
          Use a token with AI Gateway Read and Run permissions. Add Read to tokens created from the
          gateway.{' '}
          <a
            href="https://developers.cloudflare.com/ai-gateway/configuration/authentication/"
            target="_blank"
            rel="noreferrer"
          >
            Token setup
          </a>
        </p>
      )}
    </>
  );
}

function providerDescription(provider: ModelProvider) {
  switch (provider) {
    case 'openai':
      return 'ChatGPT Plus or Pro plan, or an API key';
    case 'anthropic':
      return 'API key only. Claude plans can’t be used here.';
    case 'google':
      return 'Gemini with an AI Studio key · Free tier available';
    case 'openrouter':
      return 'Many models with one API key';
    case 'amazon-bedrock':
      return 'Models in your AWS account';
    case 'google-vertex':
      return 'Gemini with a Google Cloud API key';
    case 'azure':
      return 'A deployment in your Azure resource';
    case 'cloudflare-workers-ai':
      return 'Models in your Cloudflare account';
    case 'cloudflare-ai-gateway':
      return 'Models through your Cloudflare gateway';
    case 'compatible':
      return 'Ollama, LM Studio, vLLM or any other server';
    default:
      return `Models with a ${modelProviderNames[provider]} API key`;
  }
}

function connectionName(connection: ModelConnection, short = false) {
  if (!connection.keyEnding) return connection.label;
  const key = `Key …${connection.keyEnding}`;
  return short && connection.label === modelSource(connection)
    ? key
    : `${connection.label} · ${key}`;
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
        (connection.provider === 'compatible' ? (
          <Server size={16} />
        ) : connection.method === 'api_key' ? (
          <KeyRound size={16} />
        ) : (
          <UserRound size={24} />
        ))}
      {connection.provider !== 'compatible' && (
        <span className="model-connection-provider">
          <ModelProviderLogo provider={connection.provider} size={13} />
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
  if (provider === 'cloudflare-workers-ai' || provider === 'cloudflare-ai-gateway')
    return (
      <>
        <Field label="Account ID">
          <Input
            value={value.accountId}
            required
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={disabled}
            onChange={(event) => onChange({ ...value, accountId: event.target.value })}
          />
        </Field>
        {provider === 'cloudflare-ai-gateway' && (
          <Field label="Gateway ID">
            <Input
              value={value.gatewayId}
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, gatewayId: event.target.value })}
            />
          </Field>
        )}
      </>
    );
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
  const keyErrorId = useId();
  const [keyProvider, setKeyProvider] = useState<ModelProvider | null>(null);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const [providerSearch, setProviderSearch] = useState('');
  const [showProviders, setShowProviders] = useState(false);
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
  const selectedModel = data.connections
    .find((connection) => connection.id === data.selection?.connectionId)
    ?.models.find((model) => model.id === data.selection?.modelId);
  const busy = models.busy || signingIn || !!signIn;
  const keyFormatError = keyProvider && key ? modelKeyError(keyProvider, key) : undefined;
  const keySubmissionError = ['/api/models/keys', '/api/models/endpoints'].includes(
    models.errorPath ?? '',
  )
    ? models.error
    : '';
  const keyError = keySubmissionError || keyFormatError;
  const searching = showProviders || !!providerSearch.trim();
  const listedProviders = modelProviders.filter((provider) =>
    `${modelProviderNames[provider]} ${provider === 'compatible' ? 'Ollama LM Studio vLLM local server' : provider}`
      .toLowerCase()
      .includes(providerSearch.trim().toLowerCase()),
  );
  const shownProviders = modelProviders
    .filter(
      (provider) =>
        modelProviderInfo[provider].common ||
        provider === keyProvider ||
        data.connections.some((connection) => connection.provider === provider),
    )
    .toSorted((a, b) => Number(b === keyProvider) - Number(a === keyProvider));
  function addKey(provider: ModelProvider) {
    models.setError('');
    setKey('');
    setUrl(localServerAddress);
    setSettings(noKeySettings);
    setKeyProvider(provider);
    setProviderSearch('');
    setShowProviders(false);
  }
  return (
    <div className="model-settings">
      {!!available && (
        <div className="model-current">
          <div className="model-current-label" data-analytics-public>
            <strong>Your model</strong>
            <span>
              {selectedModel?.audio
                ? selectedModel.textModelName
                  ? `Text support: ${selectedModel.textModelName}`
                  : 'Text model unavailable'
                : 'Nod uses it for every reply'}
            </span>
          </div>
          <ModelPicker manageConnections={false} surface="settings" />
        </div>
      )}
      <p className="model-intro" data-analytics-public>
        Connect as many services as you want. All their models appear in one list.
      </p>
      <div className="model-provider-search">
        <SearchField
          placeholder="Search providers"
          aria-label="Search providers"
          value={providerSearch}
          onChange={(event) => setProviderSearch(event.target.value)}
          onClear={() => setProviderSearch('')}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setShowProviders(!searching);
            setProviderSearch('');
          }}
        >
          {searching ? 'Back to connections' : 'All providers'}
        </Button>
      </div>
      {searching ? (
        <div className="model-provider-options" aria-label="Model providers">
          {listedProviders.map((provider) => (
            <button
              type="button"
              className="model-provider-option"
              key={provider}
              disabled={busy}
              onClick={() => addKey(provider)}
            >
              <ModelProviderLogo provider={provider} size={20} />
              <span>{modelProviderNames[provider]}</span>
              <Plus size={16} />
            </button>
          ))}
          {!listedProviders.length && (
            <p className="model-empty">No providers match this search.</p>
          )}
        </div>
      ) : (
        <div className="model-services">
          {shownProviders.map((provider) => (
            <section
              className="model-service"
              key={provider}
              aria-label={modelProviderNames[provider]}
            >
              <div className="model-service-heading" data-analytics-public>
                <div className="model-service-identity">
                  <ModelProviderLogo provider={provider} size={20} />
                  <div>
                    <h4>{modelProviderNames[provider]}</h4>
                    <p>{providerDescription(provider)}</p>
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
                      <ModelProviderLogo provider={provider} />
                      {provider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in'}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (keyProvider === provider) {
                        models.setError('');
                        setKey('');
                        setUrl('');
                        setSettings(noKeySettings);
                        setKeyProvider(null);
                      } else addKey(provider);
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
                    if (keyFormatError) return;
                    void models
                      .change(
                        provider === 'compatible' ? '/api/models/endpoints' : '/api/models/keys',
                        'POST',
                        provider === 'compatible'
                          ? { url: url.trim(), key }
                          : keyConnection(provider, key, settings),
                      )
                      .then((saved) => {
                        if (saved) {
                          setKey('');
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
                  >
                    <Input
                      type="password"
                      value={key}
                      required={provider !== 'compatible'}
                      minLength={provider === 'compatible' ? undefined : 8}
                      maxLength={32000}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus={
                        ![
                          'compatible',
                          'amazon-bedrock',
                          'azure',
                          'cloudflare-workers-ai',
                          'cloudflare-ai-gateway',
                        ].includes(provider)
                      }
                      disabled={busy}
                      aria-invalid={!!keyError}
                      aria-describedby={keyError ? keyErrorId : undefined}
                      onChange={(event) => {
                        setKey(event.target.value);
                        models.setError('');
                      }}
                    />
                  </Field>
                  {keyError && (
                    <div id={keyErrorId}>
                      <Notice>{keyError}</Notice>
                    </div>
                  )}
                  {provider !== 'compatible' && <ModelKeyHelp provider={provider} />}
                  {provider === 'compatible' && (
                    <p className="model-key-note">
                      Nod also uses this model to decide when to ask you before acting. Smaller
                      models decide less reliably.
                    </p>
                  )}
                  <div>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        busy ||
                        !!keyFormatError ||
                        !(provider === 'compatible'
                          ? url.trim()
                          : key.trim() && keySettingsReady(provider, settings))
                      }
                    >
                      {busy
                        ? 'Saving…'
                        : modelProviderInfo[provider].catalog === 'bundled'
                          ? 'Save key'
                          : 'Save connection'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        models.setError('');
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
                        <strong>{connectionName(connection, true)}</strong>
                        <span className={`model-connection-meta ${connection.status}`}>
                          {connection.status === 'reconnect'
                            ? connection.managed
                              ? 'Can’t load its models · Refresh to retry'
                              : connection.method !== 'api_key'
                                ? 'Reconnect to continue'
                                : connection.provider === 'compatible'
                                  ? 'Remove it and add the server again'
                                  : 'Remove it and add the key again'
                            : connection.status === 'loading'
                              ? 'Load models to continue'
                              : modelProviderInfo[provider].catalog === 'bundled'
                                ? 'Key saved · Access checked on first use'
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
                            variant={connection.status === 'reconnect' ? 'outline' : 'ghost'}
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void connect(provider as 'openai' | 'openrouter', connection.id)
                            }
                          >
                            Reconnect
                          </Button>
                        )}
                        {(connection.managed || connection.status !== 'reconnect') && (
                          <Button
                            type="button"
                            variant="ghost"
                            size={connection.status === 'loading' ? 'sm' : 'icon'}
                            aria-label={`Refresh ${connectionName(connection)} models`}
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
                        )}
                        {!connection.managed && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${connectionName(connection)}`}
                            disabled={busy}
                            onClick={() =>
                              void models.change(
                                `/api/models/connections/${connection.id}`,
                                'DELETE',
                              )
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
      )}
      {signIn && (
        <div className="model-sign-in">
          <p>
            Complete sign-in in the browser, then return to Nod. If the browser ends on a page that
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
      {(!keySubmissionError || !keyProvider || searching) && models.error && (
        <Notice>{models.error}</Notice>
      )}
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
          Voice uses an OpenAI API key, OpenRouter, or free local voices. Set it up in Settings →
          General → Voice.
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
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selected = models.data?.selection;
  const connection = models.data?.connections.find((item) => item.id === selected?.connectionId);
  const model = connection?.models.find((item) => item.id === selected?.modelId);
  const canChoose = models.data?.connections.some(
    (source) => source.status === 'connected' && source.models.length > 0,
  );
  const connections = (models.data?.connections ?? []).filter(
    (source) => source.status === 'connected',
  );
  const available = connections.flatMap((source) => {
    const recommended = recommendedModel(source)?.id;
    return source.models.map((item) => ({
      source,
      item,
      recommended: item.id === recommended,
    }));
  });
  const sharedImages = available.length > 1 && available.every(({ item }) => item.images);
  const sharedThinking =
    available.length > 1 &&
    available.every(({ item }) => item.efforts.some((effort) => effort !== 'off'));
  const sharedCapabilities = [
    sharedImages && 'read images',
    sharedThinking && 'think before replying',
  ].filter(Boolean);
  const choices = available
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
        ref={trigger}
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
            ? `${canChoose ? 'Choose model' : 'Manage model connections'}: ${model.name}, ${connectionName(connection!)}`
            : canChoose
              ? 'Choose a model'
              : 'Connect a model'
        }
        title={
          model
            ? `${model.name} · ${connectionName(connection!)}${model.audio ? ` · ${model.textModelName ? `Text support: ${model.textModelName}` : 'Text model unavailable'}` : ''}`
            : undefined
        }
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
        <DialogContent
          className="model-picker-dialog"
          aria-describedby="model-picker-description"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!manage) trigger.current?.focus();
          }}
        >
          <DialogTitle>Choose a model</DialogTitle>
          <p id="model-picker-description" className="model-intro">
            Your choice applies to your next message.
            {sharedCapabilities.length > 0 &&
              ` All these models can ${sharedCapabilities.join(' and ')}.`}
          </p>
          <SearchField
            inputRef={searchInput}
            placeholder="Search models or providers"
            aria-label="Search models"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => {
              setSearch('');
              searchInput.current?.focus();
            }}
          />
          <div className="model-options">
            {choices.map(({ source, item, recommended }) => {
              const active = selected?.connectionId === source.id && selected.modelId === item.id;
              const sharedLabel = connections.some(
                (other) =>
                  other.id !== source.id &&
                  modelSource(other) === modelSource(source) &&
                  other.label === source.label,
              );
              return (
                <button
                  type="button"
                  key={`${source.id}:${item.id}`}
                  className="model-option"
                  aria-pressed={active}
                  disabled={models.busy || (item.audio && !item.textModelName)}
                  onClick={() => void choose(source, item.id, recommended)}
                >
                  <ModelProviderLogo provider={source.provider} size={24} />
                  <span className="model-option-copy">
                    <span className="model-option-heading">
                      <strong>{item.name}</strong>
                      {recommended && <span className="model-option-recommended">Recommended</span>}
                    </span>
                    <span className="model-option-details">
                      <span>
                        {source.method === 'subscription'
                          ? 'ChatGPT'
                          : modelProviderNames[source.provider]}
                        {source.label !== modelSource(source) ? ` · ${source.label}` : ''}
                        {sharedLabel && source.keyEnding ? ` · Key …${source.keyEnding}` : ''}
                      </span>
                      {item.images && !sharedImages && (
                        <span className="model-option-capability">
                          <FileImage size={14} />
                          Reads images
                        </span>
                      )}
                      {item.audio && (
                        <>
                          <span className="model-option-capability">
                            <FileAudio size={14} />
                            Audio input
                          </span>
                          <span>
                            {item.textModelName
                              ? `Text support: ${item.textModelName}`
                              : 'Text model unavailable'}
                          </span>
                        </>
                      )}
                      {!sharedThinking && item.efforts.some((effort) => effort !== 'off') && (
                        <span className="model-option-capability">
                          <Brain size={14} />
                          Extra thinking
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="model-option-status">
                    {active && <Check size={18} aria-hidden="true" />}
                  </span>
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
        <DialogContent
          className="model-settings-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogTitle>Models</DialogTitle>
          <ModelSettings />
        </DialogContent>
      </Dialog>
    </div>
  );
}
