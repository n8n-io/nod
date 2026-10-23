import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../../../shared/models';
import { modelProviderNames, modelSource } from '../../../../shared/models';
import { agentModels } from '../../../../shared/model-defaults';
import { Button, Input } from '../../../components/ui';
import { CloudKeyFields, ModelPicker } from '../../../components/models';
import {
  keyConnection,
  keySettingsReady,
  localServerAddress,
  modelProviders,
  modelReady,
  modelSelection,
  noKeySettings,
  useModelSignIn,
  useModels,
  type KeySettings,
} from '../../../hooks/use-models';
import { api, ApiError, errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Rise } from '../../../components/motion';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [
  { typing: 450 },
  { wait: 300, typing: 550 },
  { wait: 200 },
  { wait: 300 },
];

const providers: Record<
  ModelProvider,
  {
    methods: string[];
    sub?: string;
    oauth?: string;
    note?: string;
    placeholder: string;
    hint: string;
  }
> = {
  openai: {
    methods: ['ChatGPT plan', 'API key'],
    oauth: 'Sign in with ChatGPT',
    note: 'Uses your ChatGPT Plus or Pro plan. No API key needed.',
    placeholder: 'sk-…',
    hint: 'platform.openai.com/api-keys',
  },
  anthropic: {
    methods: ['API key'],
    note: 'Claude Pro and Max plans can’t be used here.',
    placeholder: 'sk-ant-…',
    hint: 'console.anthropic.com/settings/keys',
  },
  openrouter: {
    methods: ['API key'],
    oauth: 'Sign in to OpenRouter',
    note: 'Creates an API key for me. Uses your OpenRouter credits.',
    placeholder: 'sk-or-…',
    hint: 'openrouter.ai/keys',
  },
  compatible: {
    methods: ['Server address'],
    sub: 'Ollama, LM Studio or vLLM',
    placeholder: localServerAddress,
    hint: '',
  },
  'amazon-bedrock': {
    methods: ['API key'],
    placeholder: '',
    hint: 'console.aws.amazon.com/bedrock',
  },
  'google-vertex': {
    methods: ['API key'],
    placeholder: '',
    hint: 'console.cloud.google.com/apis/credentials',
  },
  azure: {
    methods: ['API key'],
    placeholder: '',
    hint: 'ai.azure.com',
  },
};

const invalidKey = 'That key didn’t work. Check it and try again.';

function noDefault(source: ModelConnection) {
  return (
    (source.provider === 'amazon-bedrock' || source.provider === 'google-vertex') &&
    source.models.length > 1
  );
}

function ownerChooses(source: ModelConnection) {
  return noDefault(source) || (source.provider === 'compatible' && source.models.length > 1);
}

function recommended(source: ModelConnection) {
  const subscription = source.method === 'subscription';
  return (
    (subscription && source.models.find((item) => item.id === 'gpt-6-sol')) ||
    source.models.find((item) => item.id === agentModels[source.provider]) ||
    (noDefault(source) ? undefined : source.models[0])
  );
}

function Logo({ provider }: { provider: ModelProvider }) {
  return <span className={`ob-brain-logo ${provider}`} aria-hidden="true" />;
}

function Spinner() {
  return (
    <span className="ob-brain-icon">
      <LoaderCircle size={18} className="spin" aria-hidden="true" />
    </span>
  );
}

function Problem({ children }: { children: string }) {
  return children ? (
    <p className="ob-brain-error" role="alert" data-analytics-private>
      {children}
    </p>
  ) : null;
}

export function Brain({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing, done, skip } = useReveal(sequence, { enabled: arrived === 'forward' });
  const models = useModels();
  const [connected, setConnected] = useState<ModelProvider | null>(null);
  const flow = useModelSignIn(models, setConnected);
  const data = models.data;
  const [choice, setChoice] = useState<ModelProvider>();
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(localServerAddress);
  const [keySettings, setKeySettings] = useState<KeySettings>(noKeySettings);
  const [keyError, setKeyError] = useState('');
  const [checking, setChecking] = useState(false);
  const [callback, setCallback] = useState('');
  const keyField = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const connections = data?.connections ?? [];
  const selected = connections.find((item) => item.id === data?.selection?.connectionId);
  const usable = (provider: ModelProvider) =>
    connections.filter((item) => item.provider === provider && item.status !== 'reconnect');
  const provider =
    choice ?? selected?.provider ?? modelProviders.find((item) => usable(item).length);
  const here = provider ? usable(provider) : [];
  const source = here.find((item) => item.status === 'connected' && recommended(item));
  const selectedReady = modelReady(data);
  const shown =
    here.find(
      (item) =>
        item.id === selected?.id &&
        item.status === 'connected' &&
        (selectedReady || recommended(item)),
    ) ??
    source ??
    here[0];
  const recommendation = shown && recommended(shown);
  const ready = selectedReady && selected?.id === shown?.id;
  const locked = models.busy || checking || flow.pending;

  useEffect(() => {
    if (
      arrived !== 'forward' ||
      !provider ||
      connected !== provider ||
      !ready ||
      models.busy ||
      models.error ||
      checking ||
      flow.signIn ||
      flow.pending ||
      (shown && ownerChooses(shown))
    )
      return;
    setConnected(null);
    onNext();
  }, [
    arrived,
    connected,
    provider,
    ready,
    models.busy,
    models.error,
    checking,
    flow.signIn,
    flow.pending,
    shown,
    onNext,
  ]);

  useEffect(() => {
    if (
      !shown ||
      shown.status !== 'connected' ||
      !recommendation ||
      ready ||
      models.busy ||
      models.error ||
      flow.signIn ||
      flow.pending ||
      checking
    )
      return;
    void models.change('/api/models/selection', 'PUT', modelSelection(shown, recommendation.id));
  }, [
    shown,
    recommendation,
    ready,
    models.busy,
    models.error,
    flow.signIn,
    flow.pending,
    checking,
  ]);

  function pick(next: ModelProvider) {
    models.setError('');
    if (next === provider) return;
    setConnected(null);
    if (flow.signIn) void flow.cancel();
    setChoice(next);
    setKey('');
    setUrl(localServerAddress);
    setKeySettings(noKeySettings);
    setKeyError('');
    setCallback('');
    if (next === 'anthropic' || next === 'google-vertex')
      requestAnimationFrame(() => keyField.current?.focus());
  }

  function startSignIn() {
    if (provider !== 'openai' && provider !== 'openrouter') return;
    setKeyError('');
    const reconnect = connections.find(
      (item) =>
        item.provider === provider && item.status === 'reconnect' && item.method !== 'api_key',
    );
    void flow.connect(provider, reconnect?.id);
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !provider) return;
    const value = key.trim();
    const endpoint = provider === 'compatible';
    const detailed = endpoint || provider === 'amazon-bedrock' || provider === 'azure';
    if (endpoint && !url.trim()) return setKeyError('Enter the server address first.');
    if (!keySettingsReady(provider, keySettings)) return setKeyError('Fill in every field first.');
    if (!endpoint && !value) return setKeyError('Paste your API key first.');
    if (!endpoint && value.length < 8) return setKeyError(invalidKey);
    setKeyError('');
    models.setError('');
    submitting.current = true;
    setChecking(true);
    try {
      const result = await api<ModelsResponse>(
        endpoint ? '/api/models/endpoints' : '/api/models/keys',
        {
          method: 'POST',
          body: JSON.stringify(
            endpoint
              ? { url: url.trim(), key: value }
              : keyConnection(provider, value, keySettings),
          ),
        },
      );
      models.update(() => result);
      setConnected(provider);
      setKey('');
      setUrl(localServerAddress);
      setKeySettings(noKeySettings);
    } catch (cause) {
      setKeyError(
        cause instanceof ApiError && cause.status === 400 && !detailed
          ? invalidKey
          : errorMessage(cause),
      );
    } finally {
      submitting.current = false;
      setChecking(false);
    }
  }

  function options(provider: ModelProvider) {
    const settings = providers[provider];
    if (!data)
      return (
        <div className="ob-brain-status" data-analytics-public>
          <Spinner />
          <p className="ob-brain-wait">
            {models.error ? <span data-analytics-private>{models.error}</span> : 'Loading…'}
          </p>
        </div>
      );
    if (shown)
      return (
        <div className="ob-brain-status">
          <span className="ob-brain-icon ob-brain-done" aria-hidden="true">
            <Check size={18} strokeWidth={2.5} />
          </span>
          <div className="ob-brain-status-text" data-analytics-public>
            <p className="ob-brain-title">
              Connected to{' '}
              <span data-analytics-private>
                {shown.provider === 'compatible' ? shown.label : modelSource(shown)}
              </span>
            </p>
            <p className="ob-brain-note">
              {shown.status === 'loading'
                ? 'Refresh to load the models for this account.'
                : 'You can add more later in Settings.'}
            </p>
          </div>
          {((shown.provider === 'compatible' && ready) || ownerChooses(shown)) && (
            <ModelPicker manageConnections={false} surface="onboarding" />
          )}
          {(shown.status === 'loading' ||
            (!ready && !recommendation && !ownerChooses(shown)) ||
            models.error) && (
            <Button
              variant="outline"
              disabled={models.busy}
              onClick={() => {
                void models.change(`/api/models/connections/${shown.id}/refresh`, 'POST');
              }}
            >
              {models.busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              Refresh models
            </Button>
          )}
          {shown.status === 'connected' && !ready && !recommendation && !ownerChooses(shown) && (
            <Problem>
              The default model isn’t available for this account. Refresh the models or choose
              another provider.
            </Problem>
          )}
          <Problem>{models.error}</Problem>
        </div>
      );
    if (flow.signIn || flow.pending)
      return (
        <div className="ob-brain-status">
          <Spinner />
          <p className="ob-brain-wait" data-analytics-public>
            Finish signing in, then come back here.
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={flow.pending}
            data-analytics-public
            onClick={() => void flow.cancel().then((done) => done && setCallback(''))}
          >
            Cancel
          </Button>
          {flow.signIn && (
            <details className="ob-brain-fallback">
              <summary data-analytics-public>Sign-in page didn’t open?</summary>
              <p data-analytics-public>
                <button type="button" className="ob-link" onClick={flow.reopen}>
                  Open it again
                </button>{' '}
                or paste the address your browser ended up on.
              </p>
              <form
                className="ob-brain-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  const url = callback;
                  setCallback('');
                  void flow.complete(url);
                }}
              >
                <Input
                  type="url"
                  required
                  autoComplete="off"
                  placeholder="Paste the address here"
                  aria-label="Sign-in address"
                  value={callback}
                  disabled={models.busy}
                  data-analytics-private
                  onChange={(event) => setCallback(event.target.value)}
                />
                <Button type="submit" variant="outline" disabled={models.busy}>
                  Finish
                </Button>
              </form>
            </details>
          )}
          <Problem>{models.error}</Problem>
        </div>
      );
    const connect = (
      <Button type="submit" variant="outline" disabled={checking} data-analytics-public>
        {checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
        {checking ? 'Checking' : 'Connect'}
      </Button>
    );
    if (provider === 'compatible')
      return (
        <form className="ob-brain-form" onSubmit={(event) => void saveKey(event)} noValidate>
          <label className="ob-brain-label" htmlFor="ob-brain-url" data-analytics-public>
            Server address
          </label>
          <Input
            id="ob-brain-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            placeholder={settings.placeholder}
            value={url}
            disabled={checking}
            aria-invalid={!!keyError}
            data-analytics-private
            onChange={(event) => {
              setUrl(event.target.value);
              setKeyError('');
            }}
          />
          <label className="ob-brain-label" htmlFor="ob-brain-key-compatible" data-analytics-public>
            API key <span className="ob-brain-optional">optional</span>
          </label>
          <div className="ob-brain-row">
            <Input
              id="ob-brain-key-compatible"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={32000}
              value={key}
              disabled={checking}
              data-analytics-private
              onChange={(event) => {
                setKey(event.target.value);
                setKeyError('');
              }}
            />
            {connect}
          </div>
          <Problem>{keyError}</Problem>
          <p className="ob-brain-note" data-analytics-public>
            I also use this model to decide when to ask you before acting. Smaller models decide
            less reliably.
          </p>
        </form>
      );
    const keyLabel = `${modelProviderNames[provider]} API key`;
    return (
      <div className="ob-brain-form" data-analytics-public>
        {settings.oauth && (
          <>
            <div className="ob-brain-oauth">
              <Button variant="outline" disabled={locked} onClick={startSignIn}>
                <Logo provider={provider} />
                {settings.oauth}
              </Button>
              <p className="ob-brain-note">{settings.note}</p>
            </div>
            <Problem>{models.error}</Problem>
            <p className="ob-brain-or" aria-hidden="true">
              or use an API key
            </p>
          </>
        )}
        <form className="ob-brain-form" onSubmit={(event) => void saveKey(event)} noValidate>
          <CloudKeyFields
            provider={provider}
            value={keySettings}
            onChange={(next) => {
              setKeySettings(next);
              setKeyError('');
            }}
            disabled={checking}
          />
          {!settings.oauth && (
            <label
              className="ob-brain-label"
              htmlFor={`ob-brain-key-${provider}`}
              data-analytics-public
            >
              {keyLabel}
            </label>
          )}
          <div className="ob-brain-row">
            <Input
              ref={keyField}
              id={`ob-brain-key-${provider}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={32000}
              placeholder={settings.placeholder}
              aria-label={settings.oauth ? keyLabel : undefined}
              value={key}
              disabled={checking}
              aria-invalid={!!keyError}
              data-analytics-private
              onChange={(event) => {
                setKey(event.target.value);
                setKeyError('');
              }}
            />
            {connect}
          </div>
          <Problem>{keyError}</Problem>
          <p className="ob-brain-note" data-analytics-public>
            Get one at{' '}
            <a href={`https://${settings.hint}`} target="_blank" rel="noreferrer">
              {settings.hint}
            </a>
            . It’s encrypted, stays on this computer and is never shown to the AI.
          </p>
          {!settings.oauth && settings.note && <p className="ob-brain-note">{settings.note}</p>}
        </form>
      </div>
    );
  }

  return (
    <section className="ob-step ob-brain" onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        className="ob-brain-messages"
        items={[
          <Bubble data-analytics-public>Let’s connect an AI provider.</Bubble>,
          <Bubble data-analytics-public>Sign in with your ChatGPT plan, or use an API key.</Bubble>,
        ]}
      />
      <div className="ob-brain-list" data-analytics-public>
        {modelProviders.map((item, index) => {
          const open = item === provider;
          return (
            <Rise
              key={item}
              show={revealed >= 3}
              index={index}
              className="ob-brain-rise"
              data-open={open}
            >
              <h3 className="ob-brain-heading">
                <button
                  type="button"
                  className="ob-brain-option"
                  id={`ob-brain-option-${item}`}
                  aria-expanded={open}
                  aria-controls={`ob-brain-options-${item}`}
                  disabled={locked}
                  onClick={() => pick(item)}
                >
                  <span className="ob-brain-radio" aria-hidden="true" />
                  <Logo provider={item} />
                  <span className="ob-brain-option-text">
                    <span className="ob-brain-option-name">{modelProviderNames[item]}</span>
                    {providers[item].sub && (
                      <span className="ob-brain-option-sub">{providers[item].sub}</span>
                    )}
                  </span>
                  <span className="ob-brain-methods">
                    {providers[item].methods.map((method) => (
                      <span
                        key={method}
                        className="ob-brain-method"
                        data-plan={method === 'ChatGPT plan'}
                      >
                        {method}
                      </span>
                    ))}
                  </span>
                  {usable(item).length > 0 && (
                    <span className="ob-brain-badge" role="img" aria-label="Connected">
                      <Check size={14} strokeWidth={3} aria-hidden="true" />
                    </span>
                  )}
                </button>
              </h3>
              {open && (
                <div
                  className="ob-brain-options"
                  id={`ob-brain-options-${item}`}
                  role="region"
                  aria-labelledby={`ob-brain-option-${item}`}
                >
                  {options(item)}
                </div>
              )}
            </Rise>
          );
        })}
      </div>
      <Footer
        show={revealed >= 4}
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!selectedReady || models.busy || checking || !!flow.signIn}
      />
    </section>
  );
}
