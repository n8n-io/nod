import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ExternalLink,
  FileAudio,
  FileImage,
  KeyRound,
  Plus,
  Server,
  SlidersHorizontal,
  UserRound,
  Trash2,
} from './icons';
import type { ModelConnection, ModelProvider, ModelWorkspace } from '../../shared/models';
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
import { SearchPicker } from './search-picker';
import { Tooltip } from './tooltip';
import { useSettingsDraft } from './settings-drafts';
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

const modelPrice = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumSignificantDigits: 4,
});

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
  return (
    <span className="model-connection-avatar" aria-hidden="true">
      {connection.provider === 'compatible' ? (
        <Server size={18} />
      ) : connection.method === 'api_key' ? (
        <KeyRound size={18} />
      ) : (
        <UserRound size={18} />
      )}
    </span>
  );
}

export function CloudKeyFields({
  provider,
  value,
  onChange,
  disabled,
  workspaces = [],
  showWorkspace = false,
}: {
  provider: ModelProvider;
  value: KeySettings;
  onChange(value: KeySettings): void;
  disabled?: boolean;
  workspaces?: ModelWorkspace[];
  showWorkspace?: boolean;
}) {
  const [workspaceFallback, setWorkspaceFallback] = useState(false);
  useEffect(() => setWorkspaceFallback(false), [provider]);
  useEffect(() => {
    if (showWorkspace) setWorkspaceFallback(true);
  }, [showWorkspace, provider]);
  if (provider === 'anthropic')
    return showWorkspace || workspaceFallback || workspaces.length > 0 ? (
      <>
        {workspaces.length > 0 && (
          <Field label="Workspace" hint="Choose the workspace Nod should use.">
            <select
              className="input"
              value={
                workspaces.some((item) => item.id === value.workspaceId) ? value.workspaceId : ''
              }
              disabled={disabled}
              onChange={(event) => onChange({ ...value, workspaceId: event.target.value })}
            >
              <option value="" disabled>
                Choose a workspace
              </option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <details className="model-details">
          <summary>Enter workspace ID manually</summary>
          <Field
            label="Workspace ID (optional)"
            hint="Leave empty to find the workspace automatically."
          >
            <Input
              value={value.workspaceId}
              maxLength={100}
              placeholder="wrkspc_…"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, workspaceId: event.target.value })}
            />
          </Field>
        </details>
      </>
    ) : null;
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

type ModelPanel =
  | { type: 'providers' }
  | { type: 'manage'; provider: ModelProvider }
  | { type: 'connect'; provider: ModelProvider; connectionId?: string };

export function ModelSettings({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void } = {}) {
  const models = useModels();
  const keyErrorId = useId();
  const [panel, setPanel] = useState<ModelPanel | null>(null);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const [providerSearch, setProviderSearch] = useState('');
  const [keyForm, setKeyForm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [callback, setCallback] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const manageAdd = useRef<HTMLButtonElement>(null);
  const flow = useModelSignIn(models, () => {
    resetForm(false);
    setPanel(null);
  });
  const keyProvider = panel?.type === 'connect' ? panel.provider : null;
  const busy = models.busy || flow.pending || !!flow.signIn;
  const formDirty = Boolean(
    key.trim() ||
    (url.trim() && url.trim() !== localServerAddress) ||
    Object.values(settings).some((value) => value.trim()),
  );
  const dirty = busy || formDirty;
  const keyFormatError = keyProvider && key ? modelKeyError(keyProvider, key) : undefined;
  const keySubmissionError = ['/api/models/keys', '/api/models/endpoints'].includes(
    models.errorPath ?? '',
  )
    ? models.error
    : '';
  const keyError = keySubmissionError || keyFormatError;
  const canSaveKey = Boolean(
    keyProvider &&
    !keyFormatError &&
    (!models.workspaces.length || settings.workspaceId.trim()) &&
    (keyProvider === 'compatible'
      ? url.trim()
      : key.trim() && keySettingsReady(keyProvider, settings)),
  );
  function resetForm(clearError = true) {
    setKey('');
    setUrl('');
    setSettings(noKeySettings);
    setCallback('');
    models.setWorkspaces([]);
    if (clearError) models.setError('');
  }
  function closePanel() {
    if (busy) return;
    resetForm();
    setPanel(null);
    setDiscard(false);
  }
  async function saveKey() {
    if (!keyProvider || busy) return false;
    if (!canSaveKey) {
      models.setError(keyFormatError || 'Complete the connection details before saving.');
      return false;
    }
    const saved = await models.change(
      keyProvider === 'compatible' ? '/api/models/endpoints' : '/api/models/keys',
      'POST',
      keyProvider === 'compatible'
        ? { url: url.trim(), key }
        : keyConnection(keyProvider, key, settings),
    );
    if (saved) {
      resetForm();
      setPanel(null);
    }
    return saved;
  }
  useSettingsDraft('models-connection', {
    changes:
      formDirty && keyProvider
        ? [
            {
              label: `${modelProviderNames[keyProvider]} connection`,
              before: 'Not saved',
              after: 'Connection details entered',
            },
          ]
        : [],
    busy,
    save: saveKey,
    discard: closePanel,
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      const dialog = document.getElementById(`${keyErrorId}-dialog`);
      const target =
        dialog?.querySelector<HTMLElement>('input:not([disabled])') ??
        dialog?.querySelector<HTMLElement>('h2');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [panel?.type, panel && 'provider' in panel ? panel.provider : null, keyForm, !!flow.signIn]);
  if (!models.data) return models.loading ? <Loading /> : <Notice>{models.error}</Notice>;
  const data = models.data;
  const connections = data.connections.filter(
    (connection) => !modelProviderInfo[connection.provider].speechOnly,
  );
  const providers = modelProviders.filter((provider) =>
    connections.some((connection) => connection.provider === provider),
  );
  const selectedConnection = connections.find(
    (connection) => connection.id === data.selection?.connectionId,
  );
  const selectedModel = selectedConnection?.models.find(
    (model) => model.id === data.selection?.modelId,
  );
  const available = connections.some(
    (connection) => connection.status === 'connected' && connection.models.length > 0,
  );
  const listedProviders = modelProviders.filter((provider) =>
    `${modelProviderNames[provider]} ${providerDescription(provider)} ${provider}`
      .toLowerCase()
      .includes(providerSearch.trim().toLowerCase()),
  );
  function startConnection(provider: ModelProvider, connectionId?: string) {
    resetForm();
    setUrl(provider === 'compatible' ? localServerAddress : '');
    setKeyForm(provider !== 'openai' && provider !== 'openrouter');
    setPanel({ type: 'connect', provider, connectionId });
  }
  const panelProvider = panel && 'provider' in panel ? panel.provider : null;
  return (
    <div className="model-settings">
      {available && (
        <section className="model-current-section" aria-label="Your model">
          <h3>Your model</h3>
          <div className="model-current">
            {selectedConnection && (
              <ModelProviderLogo provider={selectedConnection.provider} size={24} />
            )}
            <div className="model-current-label">
              <strong>{selectedModel?.name ?? 'Choose a model'}</strong>
              <span>
                {selectedConnection
                  ? `${modelProviderNames[selectedConnection.provider]} · ${connectionName(selectedConnection, true)}`
                  : 'Choose from your connections'}
              </span>
              {selectedModel?.audio && (
                <span>
                  {selectedModel.textModelName
                    ? `Text support: ${selectedModel.textModelName}`
                    : 'Text model unavailable'}
                </span>
              )}
            </div>
            <ModelPicker manageConnections={false} surface="settings" label="Change" />
          </div>
        </section>
      )}
      <div className="model-section-heading">
        <h3>{connections.length ? 'Connections' : 'Connect a model'}</h3>
        {!!connections.length && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setProviderSearch('');
              setPanel({ type: 'providers' });
              models.setError('');
            }}
          >
            <Plus size={16} />
            Add
          </Button>
        )}
      </div>
      <div className="model-services">
        {providers.map((provider) => {
          const accounts = connections.filter((connection) => connection.provider === provider);
          const attention = accounts.some((connection) => connection.status !== 'connected');
          return (
            <div className="model-service" key={provider}>
              <ModelProviderLogo provider={provider} size={24} />
              <div className="model-service-identity">
                <strong>{modelProviderNames[provider]}</strong>
                <span>
                  {accounts.length === 1
                    ? connectionName(accounts[0]!, true)
                    : `${accounts.length} connections`}
                  {attention ? ' · Needs attention' : ''}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Manage ${modelProviderNames[provider]}`}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  models.setError('');
                  setPanel({ type: 'manage', provider });
                }}
              >
                Manage
              </Button>
            </div>
          );
        })}
      </div>
      {!connections.length && (
        <div className="model-empty-state">
          <p>Use your plan, an API key or your own model server.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setProviderSearch('');
              setPanel({ type: 'providers' });
            }}
          >
            <Plus size={16} />
            Add connection
          </Button>
        </div>
      )}
      {!panel && models.error && <Notice>{models.error}</Notice>}
      <Dialog
        open={!!panel}
        onOpenChange={(open) => {
          if (open || busy) return;
          if (formDirty) setDiscard(true);
          else closePanel();
        }}
      >
        <DialogContent
          id={`${keyErrorId}-dialog`}
          className={`model-connection-dialog${panel?.type === 'providers' ? ' model-provider-dialog' : ''}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
          }}
        >
          <DialogTitle tabIndex={-1} className="model-dialog-title">
            {panelProvider && <ModelProviderLogo provider={panelProvider} size={24} />}
            {panel?.type === 'providers'
              ? 'Add connection'
              : panel?.type === 'connect'
                ? `Connect ${modelProviderNames[panel.provider]}`
                : panelProvider
                  ? modelProviderNames[panelProvider]
                  : 'Connections'}
          </DialogTitle>
          {panel?.type === 'providers' && (
            <>
              <SearchField
                placeholder="Search providers"
                aria-label="Search providers"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                onClear={() => setProviderSearch('')}
              />
              <div className="model-provider-options" aria-label="Model providers">
                {listedProviders.map((provider) => (
                  <button
                    type="button"
                    className="model-provider-option"
                    key={provider}
                    onClick={() => startConnection(provider)}
                  >
                    <ModelProviderLogo provider={provider} size={22} />
                    <span>
                      <strong>{modelProviderNames[provider]}</strong>
                      <span>{providerDescription(provider)}</span>
                    </span>
                    <Plus size={16} />
                  </button>
                ))}
                {!listedProviders.length && (
                  <p className="model-empty" role="status">
                    No matching providers.
                  </p>
                )}
              </div>
            </>
          )}
          {panel?.type === 'manage' && (
            <>
              <div className="model-accounts">
                {connections
                  .filter((connection) => connection.provider === panel.provider)
                  .map((connection) => (
                    <div className="model-connection" key={connection.id}>
                      <div className="model-connection-label">
                        <ModelConnectionAvatar connection={connection} />
                        <div className="model-connection-identity">
                          <strong>{connectionName(connection, true)}</strong>
                          <span className={`model-connection-meta ${connection.status}`}>
                            {connection.managed
                              ? 'Server settings'
                              : connection.method === 'subscription'
                                ? 'ChatGPT plan'
                                : connection.method === 'oauth'
                                  ? 'Connected with sign-in'
                                  : connection.provider === 'compatible'
                                    ? 'Model server'
                                    : 'API key'}
                            {connection.status === 'reconnect'
                              ? ' · Needs attention'
                              : connection.status === 'loading'
                                ? ' · Models not loaded'
                                : ''}
                          </span>
                          {data.selection?.connectionId === connection.id && (
                            <span className="model-connection-selected">Current model</span>
                          )}
                        </div>
                      </div>
                      <div className="model-service-actions">
                        {connection.status === 'reconnect' && !connection.managed && (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              startConnection(
                                connection.provider,
                                connection.method !== 'api_key' ? connection.id : undefined,
                              )
                            }
                          >
                            {connection.method !== 'api_key'
                              ? 'Reconnect'
                              : connection.provider === 'compatible'
                                ? 'Add server'
                                : 'Add key'}
                          </Button>
                        )}
                        {(connection.status === 'loading' ||
                          (connection.managed && connection.status === 'reconnect')) && (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void models.change(
                                `/api/models/connections/${connection.id}/refresh`,
                                'POST',
                              )
                            }
                          >
                            {connection.status === 'loading' ? 'Load models' : 'Try again'}
                          </Button>
                        )}
                        {!connection.managed && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title="Remove connection"
                            aria-label={`Remove ${connectionName(connection)}`}
                            disabled={busy}
                            onClick={() =>
                              void models
                                .change(`/api/models/connections/${connection.id}`, 'DELETE')
                                .then((saved) => {
                                  if (saved) manageAdd.current?.focus();
                                })
                            }
                          >
                            <Trash2 size={16} />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
              <div className="model-dialog-actions">
                <Button
                  ref={manageAdd}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => startConnection(panel.provider)}
                >
                  <Plus size={16} />
                  Add connection
                </Button>
              </div>
            </>
          )}
          {panel?.type === 'connect' && !flow.signIn && (
            <>
              {!keyForm && (panel.provider === 'openai' || panel.provider === 'openrouter') ? (
                <div className="model-connect-methods">
                  <p>{providerDescription(panel.provider)}</p>
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void flow.connect(
                        panel.provider as 'openai' | 'openrouter',
                        panel.connectionId,
                      )
                    }
                  >
                    {panel.connectionId
                      ? 'Reconnect'
                      : panel.provider === 'openai'
                        ? 'Sign in with ChatGPT'
                        : 'Sign in with OpenRouter'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setKeyForm(true)}
                  >
                    <KeyRound size={16} />
                    Use an API key
                  </Button>
                </div>
              ) : (
                <form
                  className="model-key-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveKey();
                  }}
                >
                  {panel.provider === 'compatible' && (
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
                    provider={panel.provider}
                    value={settings}
                    workspaces={models.workspaces}
                    showWorkspace={Boolean(keySubmissionError)}
                    onChange={(next) => {
                      setSettings(next);
                      models.setError('');
                    }}
                    disabled={busy}
                  />
                  <Field label={panel.provider === 'compatible' ? 'API key (optional)' : 'API key'}>
                    <Input
                      type="password"
                      value={key}
                      required={panel.provider !== 'compatible'}
                      minLength={panel.provider === 'compatible' ? undefined : 8}
                      maxLength={32000}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      aria-invalid={!!keyError}
                      aria-describedby={keyError ? keyErrorId : undefined}
                      onChange={(event) => {
                        setKey(event.target.value);
                        setSettings((current) => ({ ...current, workspaceId: '' }));
                        models.setWorkspaces([]);
                        models.setError('');
                      }}
                    />
                  </Field>
                  {keyError && (
                    <div id={keyErrorId}>
                      <Notice>{keyError}</Notice>
                    </div>
                  )}
                  {panel.provider !== 'compatible' && <ModelKeyHelp provider={panel.provider} />}
                  {panel.provider === 'compatible' && (
                    <p className="model-key-note">
                      Nod also uses this model to check actions. Smaller models decide less
                      reliably.
                    </p>
                  )}
                  <div className="model-dialog-actions">
                    <Button type="button" variant="ghost" disabled={busy} onClick={closePanel}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={busy || !canSaveKey}>
                      {models.busy
                        ? 'Saving…'
                        : modelProviderInfo[panel.provider].catalog === 'bundled'
                          ? 'Save key'
                          : 'Connect'}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
          {flow.signIn && (
            <div className="model-sign-in">
              <p>Finish sign-in in your browser.</p>
              <div className="model-service-actions">
                <Button type="button" variant="secondary" size="sm" onClick={flow.reopen}>
                  Open sign-in
                  <ExternalLink size={16} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={flow.pending || models.busy}
                  onClick={() =>
                    void flow.cancel().then((done) => {
                      if (done) setCallback('');
                    })
                  }
                >
                  Cancel sign-in
                </Button>
              </div>
              <details className="model-details">
                <summary>Browser didn’t return to Nod?</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void flow.complete(callback);
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
                  <Button type="submit" size="sm" disabled={models.busy || !callback.trim()}>
                    Complete sign-in
                  </Button>
                </form>
              </details>
            </div>
          )}
          {models.error && !(panel?.type === 'connect' && keyForm && !flow.signIn && keyError) && (
            <Notice>{models.error}</Notice>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent aria-describedby={`${keyErrorId}-discard`} className="model-discard-dialog">
          <DialogTitle>Discard connection details?</DialogTitle>
          <p id={`${keyErrorId}-discard`} className="model-intro">
            These details haven’t been saved.
          </p>
          <div className="model-dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button type="button" onClick={closePanel}>
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ModelPicker({
  manageConnections = true,
  surface = 'settings',
  label,
}: {
  manageConnections?: boolean;
  surface?: 'settings' | 'onboarding';
  label?: string;
}) {
  const models = useModels();
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [search, setSearch] = useState('');
  const [provider, setProvider] = useState('all');
  const [active, setActive] = useState('');
  const [height, setHeight] = useState(300);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const optionNodes = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  const selected = models.data?.selection;
  const connection = models.data?.connections.find((item) => item.id === selected?.connectionId);
  const model = connection?.models.find((item) => item.id === selected?.modelId);
  const sourceDescription = connection
    ? [...new Set([modelProviderNames[connection.provider], connectionName(connection)])].join(
        ' · ',
      )
    : '';
  const connections = (models.data?.connections ?? []).filter(
    (source) => source.status === 'connected',
  );
  const available = connections.flatMap((source) =>
    source.models.map((item) => ({
      source,
      item,
      recommended: item.id === recommendedModel(source)?.id,
      key: `${source.id}:${item.id}`,
    })),
  );
  const current = useRef(available);
  current.current = available;
  const canChoose = available.length > 0;
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const choices = available
    .filter(
      ({ source, item }) =>
        (provider === 'all' || source.provider === provider) &&
        words.every((word) =>
          `${item.name} ${item.id} ${source.label} ${source.keyEnding ?? ''} ${modelProviderNames[source.provider]} ${modelSource(source)}`
            .toLowerCase()
            .includes(word),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.recommended) - Number(a.recommended) || a.item.name.localeCompare(b.item.name),
    );
  const groups = connections
    .map((source) => ({
      source,
      choices: choices.filter((choice) => choice.source.id === source.id),
    }))
    .filter((group) => group.choices.length);
  const enabled = groups
    .flatMap((group) => group.choices)
    .filter(({ item }) => !item.audio || item.textModelName);
  const enabledKeys = enabled.map(({ key }) => key);
  const filterKey = enabledKeys.join('|');
  const selectedKey = selected ? `${selected.connectionId}:${selected.modelId}` : '';
  useEffect(() => {
    if (!open) return;
    setActive((value) =>
      enabledKeys.includes(value)
        ? value
        : enabledKeys.includes(selectedKey)
          ? selectedKey
          : (enabledKeys[0] ?? ''),
    );
  }, [filterKey, selectedKey, open]);
  useEffect(() => {
    if (results.current) results.current.scrollTop = 0;
  }, [search, provider, open]);
  function focusOption(key: string) {
    const node = optionNodes.current.get(key);
    if (!node || node.disabled) return;
    setActive(key);
    node.focus({ preventScroll: true });
    const viewport = results.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const item = node.getBoundingClientRect();
    if (item.top < bounds.top) viewport.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) viewport.scrollTop += item.bottom - bounds.bottom;
  }
  async function choose(key: string) {
    if (models.busy) return;
    const choice = current.current.find((value) => value.key === key);
    if (!choice || (choice.item.audio && !choice.item.textModelName)) return;
    const capture = analyticsForCurrentSession();
    if (
      await models.change(
        '/api/models/selection',
        'PUT',
        modelSelection(choice.source, choice.item.id),
      )
    ) {
      capture('model_selected', {
        provider: choice.source.provider in modelProviderNames ? choice.source.provider : 'other',
        entry: surface,
        recommended: choice.recommended,
      });
      setOpen(false);
    } else {
      capture('ui_error', { area: 'models', action: 'save' });
      requestAnimationFrame(() => focusOption(key));
    }
  }
  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      models.busy ||
      !enabledKeys.length
    )
      return;
    const input = event.target === searchInput.current;
    if (!input && !(event.target as HTMLElement).closest('.model-option')) return;
    if (input && ['Home', 'End'].includes(event.key)) return;
    if (event.key === 'Enter' && input) {
      event.preventDefault();
      void choose(enabledKeys.includes(active) ? active : enabledKeys[0]!);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const index = enabledKeys.indexOf(active);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabledKeys.length - 1
          : input
            ? event.key === 'ArrowUp'
              ? enabledKeys.length - 1
              : Math.max(0, index)
            : Math.min(
                enabledKeys.length - 1,
                Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
              );
    focusOption(enabledKeys[next]!);
  }
  return (
    <div className="model-picker">
      <Button
        ref={trigger}
        type="button"
        variant={label ? 'secondary' : 'ghost'}
        size="sm"
        className="model-picker-trigger"
        disabled={models.loading}
        onClick={() => {
          setSearch('');
          setProvider('all');
          models.setError('');
          setHeight(
            Math.min(420, Math.max(156, available.length * 38 + connections.length * 38 + 12)),
          );
          setActive(selectedKey);
          canChoose ? setOpen(true) : setManage(true);
        }}
        aria-label={
          model
            ? `Choose model: ${model.name}, ${sourceDescription}`
            : canChoose
              ? 'Choose a model'
              : 'Connect a model'
        }
        title={
          model
            ? `${model.name} · ${sourceDescription}${model.audio ? ` · ${model.textModelName ? `Text support: ${model.textModelName}` : 'Text model unavailable'}` : ''}`
            : undefined
        }
      >
        {label ?? (
          <>
            <span className="model-picker-name">
              {model?.name ?? (canChoose ? 'Choose a model' : 'Connect a model')}
            </span>
            {model ? <ChevronDown size={12} /> : <Plus size={16} />}
          </>
        )}
      </Button>
      {surface === 'settings' && model && connection?.status === 'reconnect' && (
        <a className="model-needs-reconnect" href="/settings/models">
          Reconnect in Settings &gt; Models
        </a>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!models.busy) setOpen(value);
        }}
      >
        <DialogContent
          className="model-picker-dialog"
          aria-describedby={undefined}
          onKeyDown={navigate}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInput.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!manage) trigger.current?.focus();
          }}
        >
          <DialogTitle>Choose a model</DialogTitle>
          <p className="field-hint">Applies to your next message.</p>
          <div className="model-picker-toolbar">
            <SearchField
              inputRef={searchInput}
              placeholder="Search models or accounts"
              aria-label="Search models or accounts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClear={() => {
                setSearch('');
                searchInput.current?.focus();
              }}
            />
            <SearchPicker
              className="model-provider-filter"
              value={provider}
              onChange={setProvider}
              disabled={models.busy}
              options={[
                { value: 'all', label: 'All providers' },
                ...Array.from(new Set(connections.map((source) => source.provider))).map(
                  (value) => ({ value, label: modelProviderNames[value] }),
                ),
              ]}
              labels={{
                choose: 'Filter model providers',
                search: 'Search model providers',
                placeholder: 'Search providers',
                clear: 'Clear provider search',
                list: 'Model providers',
                empty: 'No matching providers',
              }}
            />
          </div>
          <div
            ref={results}
            className="model-options"
            role={choices.length ? 'listbox' : 'region'}
            aria-label="Available models"
            aria-busy={models.busy}
            style={{ '--model-results-height': `${height}px` } as CSSProperties}
          >
            {groups.map(({ source, choices: group }) => (
              <div
                key={source.id}
                className="model-option-group"
                role="group"
                aria-labelledby={`${id}-${source.id}`}
              >
                <div id={`${id}-${source.id}`} className="model-option-group-heading">
                  <ModelProviderLogo provider={source.provider} />
                  <strong>{modelProviderNames[source.provider]}</strong>
                  <span>{connectionName(source, true)}</span>
                </div>
                {group.map(({ item, key, recommended }) => {
                  const price =
                    source.provider === 'openrouter'
                      ? item.pricing === 'variable'
                        ? 'Price varies'
                        : !item.pricing
                          ? 'Price unavailable'
                          : item.pricing.input === 0 && item.pricing.output === 0
                            ? 'Free tokens'
                            : `${modelPrice.format(item.pricing.input)} in · ${modelPrice.format(item.pricing.output)} out / 1M`
                      : null;
                  return (
                    <button
                      ref={(node) => {
                        if (node) optionNodes.current.set(key, node);
                        else optionNodes.current.delete(key);
                      }}
                      key={key}
                      type="button"
                      role="option"
                      aria-selected={selectedKey === key}
                      className="model-option"
                      tabIndex={active === key ? 0 : -1}
                      disabled={models.busy || (item.audio && !item.textModelName)}
                      onFocus={() => focusOption(key)}
                      onClick={() => void choose(key)}
                    >
                      <span className="model-option-copy">
                        <span className="model-option-heading">
                          <strong>{item.name}</strong>
                          {recommended && (
                            <span className="model-option-recommended">Recommended</span>
                          )}
                        </span>
                        {item.audio && (
                          <span className="model-option-detail">
                            {item.textModelName
                              ? `Text support: ${item.textModelName}`
                              : 'Text model unavailable'}
                          </span>
                        )}
                      </span>
                      <span className="model-option-capabilities">
                        {item.images && (
                          <Tooltip content="Reads images">
                            <span role="img" aria-label="Reads images">
                              <FileImage size={14} />
                            </span>
                          </Tooltip>
                        )}
                        {item.audio && (
                          <Tooltip content="Audio input">
                            <span role="img" aria-label="Audio input">
                              <FileAudio size={14} />
                            </span>
                          </Tooltip>
                        )}
                        {item.efforts.some((effort) => effort !== 'off') && (
                          <Tooltip content="Extra thinking">
                            <span role="img" aria-label="Extra thinking">
                              <Brain size={14} />
                            </span>
                          </Tooltip>
                        )}
                      </span>
                      {price && (
                        <span
                          className="model-option-price"
                          aria-label={`${price} tokens in US dollars`}
                        >
                          {price}
                        </span>
                      )}
                      <span className="model-option-status" aria-hidden="true">
                        {selectedKey === key && <Check size={15} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!choices.length && (
              <div className="model-picker-empty" role="status">
                <span>No matching models.</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setProvider('all');
                    searchInput.current?.focus();
                  }}
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>
          <div className="model-picker-footer">
            <span role="status">
              {choices.length} {choices.length === 1 ? 'model' : 'models'}
              {connections.some((source) => source.provider === 'openrouter')
                ? ' · OpenRouter prices in USD; rates can vary.'
                : ''}
            </span>
            {manageConnections && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setManage(true);
                }}
              >
                <SlidersHorizontal size={15} />
                Manage connections
              </Button>
            )}
          </div>
          {models.error && <Notice>{models.error}</Notice>}
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
