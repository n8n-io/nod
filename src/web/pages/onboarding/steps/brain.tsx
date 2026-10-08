import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../../../shared/models';
import { modelProviderNames, modelSource } from '../../../../shared/models';
import { agentModels } from '../../../../shared/model-defaults';
import { Button, Input } from '../../../components/ui';
import { modelReady, modelSelection, useModelSignIn, useModels } from '../../../hooks/use-models';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { sessionStore } from '../../../lib/session';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, Rise, Select, useReveal, type RevealStep } from '../motion';

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
};

const order: ModelProvider[] = ['openai', 'anthropic', 'openrouter'];
const invalidKey = 'That key didn’t work. Check it and try again.';

function oauthFor(provider: ModelProvider, data: ModelsResponse | null | undefined) {
  return provider === 'openai' && !data?.subscriptionAvailable
    ? undefined
    : providers[provider].oauth;
}

function recommended(source: ModelConnection) {
  return (
    source.models.find((item) => item.id === agentModels[source.provider]) ?? source.models[0]
  ).id;
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
    <p className="ob-brain-error" role="alert">
      {children}
    </p>
  ) : null;
}

export function Brain({ arrived, onNext, onBack }: StepProps) {
  const hosted = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getSnapshot().session?.auth.mode === 'google',
  );
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const models = useModels();
  const flow = useModelSignIn(models);
  const data = models.data;
  const [choice, setChoice] = useState<ModelProvider | null>(null);
  const [method, setMethod] = useState<'oauth' | 'key' | null>(null);
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState('');
  const [checking, setChecking] = useState(false);
  const [callback, setCallback] = useState('');
  const claimed = useRef<ModelProvider | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const ready = modelReady(data);
  const connections = data?.connections ?? [];
  const selected = connections.find((item) => item.id === data?.selection?.connectionId);
  const usable = (provider: ModelProvider) =>
    connections.filter((item) => item.provider === provider && item.status !== 'reconnect');
  const provider =
    choice ?? selected?.provider ?? order.find((item) => usable(item).length) ?? 'openai';
  const oauth = oauthFor(provider, data);
  const here = usable(provider);
  const shown = selected?.provider === provider ? selected : here[0];
  const options = here.filter((item) => item.status === 'connected' && item.models.length);
  const current = selected?.provider === provider && data?.selection;

  useEffect(() => {
    if (!data || models.busy || flow.signIn) return;
    const want = claimed.current ?? (ready ? null : provider);
    if (!want) return;
    if (ready && selected?.provider === want) {
      claimed.current = null;
      return;
    }
    const source = connections.find(
      (item) => item.provider === want && item.status === 'connected' && item.models.length,
    );
    if (!source) return;
    claimed.current = null;
    void models.change('/api/models/selection', 'PUT', modelSelection(source, recommended(source)));
  }, [data, models.busy, flow.signIn, provider, ready]);

  function pick(next: ModelProvider) {
    if (next === provider) return;
    if (flow.signIn) void flow.cancel();
    claimed.current = null;
    models.setError('');
    setChoice(next);
    setMethod(null);
    setKey('');
    setKeyError('');
    setCallback('');
  }

  function startSignIn() {
    claimed.current = provider;
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
    if (!value) return setKeyError('Paste your API key first.');
    if (value.length < 8) return setKeyError(invalidKey);
    setKeyError('');
    setChecking(true);
    claimed.current = provider;
    try {
      const result = await api<ModelsResponse>('/api/models/keys', {
        method: 'POST',
        body: JSON.stringify({ provider, key: value }),
      });
      models.update(() => result);
      setKey('');
    } catch (cause) {
      claimed.current = null;
      setKeyError(
        cause instanceof ApiError && cause.status === 400 ? invalidKey : errorMessage(cause),
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

  function choose(value: string) {
    const [id, ...rest] = value.split('|');
    const source = options.find((item) => item.id === id);
    if (source)
      void models.change('/api/models/selection', 'PUT', modelSelection(source, rest.join('|')));
  }

  let panel;
  if (!data)
    panel = (
      <div className="ob-brain-status" data-analytics-public>
        <Spinner />
        <p className="ob-brain-wait">{models.error || 'Loading providers…'}</p>
      </div>
    );
  else if (shown)
    panel = (
      <div className="ob-brain-status">
        <span className="ob-brain-icon ob-brain-done" aria-hidden="true">
          <Check size={18} strokeWidth={2.5} />
        </span>
        <div className="ob-brain-status-text" data-analytics-public>
          <p className="ob-brain-title">Connected to {modelSource(shown)}</p>
          <p className="ob-brain-note">You can add more later in Settings.</p>
        </div>
        {options.length ? (
          <label className="ob-brain-model">
            <span data-analytics-public>Model</span>
            <Select
              value={current ? `${current.connectionId}|${current.modelId}` : ''}
              disabled={models.busy}
              onChange={(event) => choose(event.target.value)}
            >
              {!current && (
                <option value="" disabled>
                  Pick a model
                </option>
              )}
              {options.map((source) => {
                const items = source.models.map((model) => (
                  <option key={model.id} value={`${source.id}|${model.id}`}>
                    {model.name}
                  </option>
                ));
                return options.length > 1 ? (
                  <optgroup key={source.id} label={`${modelSource(source)} · ${source.label}`}>
                    {items}
                  </optgroup>
                ) : (
                  items
                );
              })}
            </Select>
          </label>
        ) : (
          <Button
            variant="outline"
            disabled={models.busy}
            onClick={() =>
              void models.change(`/api/models/connections/${shown.id}/refresh`, 'POST')
            }
          >
            {models.busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
            Load models
          </Button>
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
              <button type="button" className="ob-brain-link" onClick={flow.reopen}>
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
        <button type="button" className="ob-brain-link" onClick={() => switchMethod('key')}>
          Use an API key instead
        </button>
      </div>
    );
  else
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
          .{' '}
          {hosted
            ? 'It’s encrypted and never shown to the AI.'
            : 'It’s encrypted, stays on this computer and is never shown to the AI.'}
        </p>
        {oauth && (
          <button
            type="button"
            className="ob-brain-link"
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
          <Bubble data-analytics-public>Let’s pick a model for me.</Bubble>,
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
              onClick={() => pick(item)}
            >
              <Logo provider={item} />
              <span className="ob-brain-card-text">
                <span className="ob-brain-card-name">{modelProviderNames[item]}</span>
                <span className="ob-brain-card-sub">
                  {item === 'openai' && !oauthFor(item, data) ? 'API key' : providers[item].sub}
                </span>
              </span>
              {usable(item).length > 0 && (
                <span className="ob-brain-badge" role="img" aria-label="Connected">
                  <Check size={13} strokeWidth={3} aria-hidden="true" />
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
