import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../../../shared/models';
import { modelProviderNames, modelSource } from '../../../../shared/models';
import { agentModels } from '../../../../shared/model-defaults';
import { Button, Input } from '../../../components/ui';
import { ModelPicker } from '../../../components/models';
import {
  localServerAddress,
  modelReady,
  modelSelection,
  useModelSignIn,
  useModels,
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
  { wait: 200 },
];

const providers: Record<
  ModelProvider,
  { sub: string; oauth?: string; note?: string; placeholder: string; hint: string }
> = {
  openai: {
    sub: 'ChatGPT plan or API key',
    oauth: 'Sign in with ChatGPT',
    note: 'Uses your ChatGPT Plus or Pro plan. No API key needed.',
    placeholder: 'sk-…',
    hint: 'platform.openai.com/api-keys',
  },
  anthropic: {
    sub: 'API key',
    placeholder: 'sk-ant-…',
    hint: 'console.anthropic.com/settings/keys',
  },
  openrouter: {
    sub: 'Account or API key',
    oauth: 'Connect OpenRouter',
    note: 'One account gives me models from lots of different labs.',
    placeholder: 'sk-or-…',
    hint: 'openrouter.ai/keys',
  },
  compatible: {
    sub: 'Ollama, LM Studio or vLLM',
    placeholder: localServerAddress,
    hint: '',
  },
};

const invalidKey = 'That key didn’t work. Check it and try again.';

function recommended(source: ModelConnection) {
  const subscription = source.method === 'subscription';
  return (
    (subscription && source.models.find((item) => item.id === 'gpt-6-sol')) ||
    source.models.find((item) => item.id === agentModels[source.provider]) ||
    source.models[0]
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
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const models = useModels();
  const [connected, setConnected] = useState<ModelProvider | null>(null);
  const flow = useModelSignIn(models, setConnected);
  const data = models.data;
  const [choice, setChoice] = useState<ModelProvider | null>(null);
  const [method, setMethod] = useState<'oauth' | 'key' | null>(null);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(localServerAddress);
  const [keyError, setKeyError] = useState('');
  const [checking, setChecking] = useState(false);
  const [callback, setCallback] = useState('');
  const keyField = useRef<HTMLInputElement>(null);
  const connections = data?.connections ?? [];
  const order: ModelProvider[] = ['openai', 'anthropic', 'openrouter', 'compatible'];
  const selected = connections.find((item) => item.id === data?.selection?.connectionId);
  const usable = (provider: ModelProvider) =>
    connections.filter((item) => item.provider === provider && item.status !== 'reconnect');
  const provider =
    choice ?? selected?.provider ?? order.find((item) => usable(item).length) ?? 'openai';
  const oauth = providers[provider].oauth;
  const here = usable(provider);
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

  useEffect(() => {
    if (
      arrived !== 'forward' ||
      connected !== provider ||
      !ready ||
      models.busy ||
      models.error ||
      checking ||
      flow.signIn ||
      flow.pending ||
      (shown?.provider === 'compatible' && shown.models.length > 1)
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
    setMethod(null);
    setKey('');
    setUrl(localServerAddress);
    setKeyError('');
    setCallback('');
  }

  function startSignIn() {
    const reconnect = connections.find(
      (item) =>
        item.provider === provider && item.status === 'reconnect' && item.method !== 'api_key',
    );
    void flow.connect(provider as 'openai' | 'openrouter', reconnect?.id);
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (checking) return;
    const value = key.trim();
    const endpoint = provider === 'compatible';
    if (endpoint && !url.trim()) return setKeyError('Enter the server address first.');
    if (!endpoint && !value) return setKeyError('Paste your API key first.');
    if (!endpoint && value.length < 8) return setKeyError(invalidKey);
    setKeyError('');
    setChecking(true);
    try {
      const result = await api<ModelsResponse>(
        endpoint ? '/api/models/endpoints' : '/api/models/keys',
        {
          method: 'POST',
          body: JSON.stringify(
            endpoint ? { url: url.trim(), key: value } : { provider, key: value },
          ),
        },
      );
      models.update(() => result);
      setConnected(provider);
      setKey('');
      setUrl(localServerAddress);
    } catch (cause) {
      setKeyError(
        cause instanceof ApiError && cause.status === 400 && !endpoint
          ? invalidKey
          : errorMessage(cause),
      );
    } finally {
      setChecking(false);
    }
  }

  function switchMethod(next: 'oauth' | 'key') {
    setMethod(next);
    setKeyError('');
    models.setError('');
    if (next === 'key') requestAnimationFrame(() => keyField.current?.focus());
  }

  let panel;
  if (!data)
    panel = (
      <div className="ob-brain-status" data-analytics-public>
        <Spinner />
        <p className="ob-brain-wait">
          {models.error ? <span data-analytics-private>{models.error}</span> : 'Loading providers…'}
        </p>
      </div>
    );
  else if (shown)
    panel = (
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
        {shown.provider === 'compatible' && ready && (
          <ModelPicker manageConnections={false} surface="onboarding" />
        )}
        {(shown.status === 'loading' || (!ready && !recommendation) || models.error) && (
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
        {shown.status === 'connected' && !ready && !recommendation && (
          <Problem>
            The default model isn’t available for this account. Refresh the models or choose another
            provider.
          </Problem>
        )}
        <Problem>{models.error}</Problem>
      </div>
    );
  else if (flow.signIn || (flow.pending && method !== 'key'))
    panel = (
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
  else if (oauth && method !== 'key')
    panel = (
      <div className="ob-brain-form" data-analytics-public>
        <div className="ob-brain-oauth">
          <Button variant="outline" disabled={flow.pending} onClick={startSignIn}>
            <Logo provider={provider} />
            {oauth}
          </Button>
          <p className="ob-brain-note">{providers[provider].note}</p>
        </div>
        <Problem>{models.error}</Problem>
        <button type="button" className="ob-link" onClick={() => switchMethod('key')}>
          Use an API key instead
        </button>
      </div>
    );
  else if (provider === 'compatible') {
    const connect = (
      <Button type="submit" variant="outline" disabled={checking} data-analytics-public>
        {checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
        {checking ? 'Checking' : 'Connect'}
      </Button>
    );
    panel = (
      <form className="ob-brain-form" onSubmit={(event) => void saveKey(event)} noValidate>
        <label className="ob-brain-title" htmlFor="ob-brain-url" data-analytics-public>
          Server address
        </label>
        <div className="ob-brain-row">
          <Input
            id="ob-brain-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2000}
            placeholder={providers.compatible.placeholder}
            value={url}
            disabled={checking}
            aria-invalid={!!keyError}
            data-analytics-private
            onChange={(event) => {
              setUrl(event.target.value);
              setKeyError('');
            }}
          />
          {method !== 'key' && connect}
        </div>
        {method === 'key' && (
          <div className="ob-brain-row">
            <Input
              ref={keyField}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={32000}
              placeholder="API key"
              aria-label="API key"
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
        )}
        <Problem>{keyError}</Problem>
        <p className="ob-brain-note" data-analytics-public>
          I also use this model to decide when to ask you before acting. Smaller models decide less
          reliably.
        </p>
        {method !== 'key' && (
          <button
            type="button"
            className="ob-link"
            data-analytics-public
            onClick={() => switchMethod('key')}
          >
            Add an API key
          </button>
        )}
      </form>
    );
  } else
    panel = (
      <form className="ob-brain-form" onSubmit={(event) => void saveKey(event)} noValidate>
        <label
          className="ob-brain-title"
          htmlFor={`ob-brain-key-${provider}`}
          data-analytics-public
        >
          {modelProviderNames[provider]} API key
        </label>
        <div className="ob-brain-row">
          <Input
            ref={keyField}
            id={`ob-brain-key-${provider}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={32000}
            placeholder={providers[provider].placeholder}
            value={key}
            disabled={checking}
            aria-invalid={!!keyError}
            data-analytics-private
            onChange={(event) => {
              setKey(event.target.value);
              setKeyError('');
            }}
          />
          <Button type="submit" variant="outline" disabled={checking} data-analytics-public>
            {checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            {checking ? 'Checking' : 'Connect'}
          </Button>
        </div>
        <Problem>{keyError}</Problem>
        <p className="ob-brain-note" data-analytics-public>
          Get one at{' '}
          <a href={`https://${providers[provider].hint}`} target="_blank" rel="noreferrer">
            {providers[provider].hint}
          </a>
          . It’s encrypted, stays on this computer and is never shown to the AI.
        </p>
        {oauth && (
          <button
            type="button"
            className="ob-link"
            data-analytics-public
            onClick={() => switchMethod('oauth')}
          >
            {oauth} instead
          </button>
        )}
      </form>
    );

  return (
    <section className="ob-step ob-brain">
      <Messages
        revealed={revealed}
        typing={typing}
        className="ob-brain-messages"
        items={[
          <Bubble data-analytics-public>Let’s connect an AI provider.</Bubble>,
          <Bubble data-analytics-public>
            Here are the providers I work with. Connect one and we’re off.
          </Bubble>,
        ]}
      />
      <div className="ob-brain-cards" data-analytics-public>
        {order.map((item, index) => (
          <Rise key={item} show={revealed >= 3} index={index} className="ob-brain-rise">
            <button
              type="button"
              className="ob-brain-card"
              aria-pressed={item === provider}
              disabled={models.busy || checking || flow.pending}
              onClick={() => pick(item)}
            >
              <Logo provider={item} />
              <span className="ob-brain-card-text">
                <span className="ob-brain-card-name">{modelProviderNames[item]}</span>
                <span className="ob-brain-card-sub">{providers[item].sub}</span>
              </span>
              {usable(item).length > 0 && (
                <span className="ob-brain-badge" role="img" aria-label="Connected">
                  <Check size={14} strokeWidth={3} aria-hidden="true" />
                </span>
              )}
            </button>
          </Rise>
        ))}
      </div>
      <Rise show={revealed >= 4} className="ob-brain-panel">
        {panel}
      </Rise>
      <Footer
        show={revealed >= 5}
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!ready || models.busy || checking || !!flow.signIn}
      />
    </section>
  );
}
