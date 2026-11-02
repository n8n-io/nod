import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
} from '../../../components/icons';
import type { ModelConnection, ModelProvider, ModelsResponse } from '../../../../shared/models';
import { modelKeyError } from '../../../../shared/model-keys';
import {
  modelProviderInfo,
  modelProviderNames,
  modelProviders,
  modelSource,
} from '../../../../shared/models';
import { Button, Input, Notice, SearchField } from '../../../components/ui';
import {
  CloudKeyFields,
  ModelKeyHelp,
  ModelPicker,
  ModelProviderLogo,
} from '../../../components/models';
import {
  keyConnection,
  keySettingsReady,
  localServerAddress,
  modelReady,
  modelSelection,
  noKeySettings,
  recommendedModel,
  useModelSignIn,
  useModels,
  type KeySettings,
} from '../../../hooks/use-models';
import { ApiError, api, errorMessage } from '../../../lib/api';
import { pageDataCache } from '../../../lib/page-data-cache';
import type { StepProps } from '..';
import { Rise } from '../../../components/motion';
import { Bubble, Footer, Messages, useReveal, type RevealStep } from '../motion';

const sequence: RevealStep[] = [{ typing: 450 }, { wait: 200 }, { wait: 300 }];

type SignInProvider = 'openai' | 'openrouter';

const providers = modelProviders.map((provider) => ({
  provider,
  name: provider === 'compatible' ? 'Your own server' : modelProviderNames[provider],
  common: modelProviderInfo[provider].common,
}));

const common = providers.filter((item) => item.common);

const hints: Partial<Record<ModelProvider, string>> = {
  openai: 'Sign in with your ChatGPT Plus or Pro plan, no extra cost',
};

const placeholders: Partial<Record<ModelProvider, string>> = {
  openai: 'sk-…',
  anthropic: 'sk-ant-…',
  openrouter: 'sk-or-…',
};

const depth = { list: 0, setup: 1, done: 2 } as const;

type View = keyof typeof depth;

function signsIn(provider: ModelProvider): provider is SignInProvider {
  return provider === 'openai' || provider === 'openrouter';
}

function ownerChooses(source: ModelConnection) {
  return ['amazon-bedrock', 'compatible'].includes(source.provider) && source.models.length > 1;
}

function recommended(source: ModelConnection) {
  return ownerChooses(source) ? undefined : recommendedModel(source);
}

function useConnect() {
  const models = useModels();
  const [fresh, setFresh] = useState<string>();
  const [another, setAnother] = useState(false);
  const flow = useModelSignIn(models, (provider) => {
    const latest = pageDataCache
      .getSnapshot<ModelsResponse>('/api/models')
      .data?.connections.filter((item) => item.provider === provider)
      .at(-1);
    setAnother(false);
    setFresh(latest?.id);
  });
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState('');
  const submitting = useRef(false);
  const data = models.data;
  const connections = data?.connections ?? [];
  const selected = connections.find((item) => item.id === data?.selection?.connectionId);
  const usable = connections.filter((item) => item.status !== 'reconnect');
  const shown = another
    ? undefined
    : (usable.find((item) => item.id === fresh) ??
      usable.find((item) => item.id === selected?.id) ??
      usable[0]);
  const ready = modelReady(data) && selected?.id === shown?.id;
  const recommendation = shown?.status === 'connected' ? recommended(shown) : undefined;
  const signingIn = !!flow.signIn || flow.pending;

  useEffect(() => {
    if (!shown || !recommendation || ready || models.busy || models.error || signingIn || checking)
      return;
    void models.change('/api/models/selection', 'PUT', modelSelection(shown, recommendation.id));
  }, [shown, recommendation, ready, models.busy, models.error, signingIn, checking]);

  function clearError() {
    setKeyError('');
    models.setError('');
  }

  async function save(provider: ModelProvider, key: string, settings = noKeySettings, url = '') {
    if (submitting.current) return false;
    const value = key.trim();
    const endpoint = provider === 'compatible';
    if (endpoint && !url.trim()) return (setKeyError('Enter the server address first.'), false);
    if (!keySettingsReady(provider, settings))
      return (setKeyError('Fill in every field first.'), false);
    if (!endpoint && !value) return (setKeyError('Paste your API key first.'), false);
    const formatError = modelKeyError(provider, value);
    if (formatError) return (setKeyError(formatError), false);
    clearError();
    submitting.current = true;
    setChecking(true);
    try {
      const result = await api<ModelsResponse>(
        endpoint ? '/api/models/endpoints' : '/api/models/keys',
        {
          method: 'POST',
          body: JSON.stringify(
            endpoint ? { url: url.trim(), key: value } : keyConnection(provider, value, settings),
          ),
        },
      );
      models.update(() => result);
      models.setWorkspaces([]);
      setAnother(false);
      setFresh(result.connections.at(-1)?.id);
      return true;
    } catch (cause) {
      setKeyError(
        cause instanceof ApiError
          ? errorMessage(cause)
          : 'The connection couldn’t be completed. Try again.',
      );
      if (cause instanceof ApiError && cause.workspaces) models.setWorkspaces(cause.workspaces);
      return false;
    } finally {
      submitting.current = false;
      setChecking(false);
    }
  }

  function signIn(provider: SignInProvider) {
    setKeyError('');
    void flow.connect(provider);
  }

  return {
    models,
    flow,
    data,
    shown,
    ready,
    recommendation,
    signingIn,
    locked: models.busy || checking || flow.pending,
    checking,
    keyError,
    expired: connections.find((item) => item.status === 'reconnect'),
    clearError,
    save,
    signIn,
    addAnother: () => {
      models.setError('');
      setAnother(true);
    },
    existing: (provider: ModelProvider) => usable.find((item) => item.provider === provider),
    open: (id: string) => {
      models.setError('');
      setAnother(false);
      setFresh(id);
    },
    keepCurrent: another && usable.length > 0 ? () => setAnother(false) : undefined,
  };
}

type Connect = ReturnType<typeof useConnect>;

function Logo({ provider, size = 20 }: { provider: ModelProvider; size?: number }) {
  return <ModelProviderLogo provider={provider} size={size} />;
}

function Problem({ children }: { children?: string }) {
  return children ? (
    <p className="ob-brain-error" role="alert" data-analytics-private>
      {children}
    </p>
  ) : null;
}

function Spinner() {
  return (
    <span className="ob-brain-icon">
      <LoaderCircle size={18} className="spin" aria-hidden="true" />
    </span>
  );
}

function ConnectButton({
  checking,
  saved = false,
  disabled = false,
}: {
  checking: boolean;
  saved?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button type="submit" variant="outline" disabled={checking || disabled}>
      {checking && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {checking ? (saved ? 'Saving' : 'Checking') : saved ? 'Save key' : 'Connect'}
    </Button>
  );
}

function Waiting({ c }: { c: Connect }) {
  const [callback, setCallback] = useState('');
  return (
    <div className="ob-brain-status">
      <Spinner />
      <p className="ob-brain-wait">Finish signing in, then come back here.</p>
      <Button
        variant="ghost"
        size="sm"
        disabled={c.locked}
        onClick={() => void c.flow.cancel().then((done) => done && setCallback(''))}
      >
        Cancel
      </Button>
      {c.flow.signIn && (
        <details className="ob-brain-fallback">
          <summary>Sign-in page didn’t open?</summary>
          <p>
            <button type="button" className="ob-link" onClick={c.flow.reopen}>
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
              void c.flow.complete(url);
            }}
          >
            <Input
              type="url"
              required
              autoComplete="off"
              placeholder="Paste the address here"
              aria-label="Sign-in address"
              value={callback}
              disabled={c.locked}
              data-analytics-private
              onChange={(event) => setCallback(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={c.locked}>
              Finish
            </Button>
          </form>
        </details>
      )}
      <Problem>{c.models.error}</Problem>
    </div>
  );
}

function KeyForm({
  c,
  provider,
  autoFocus,
}: {
  c: Connect;
  provider: ModelProvider;
  autoFocus?: boolean;
}) {
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [settings, setSettings] = useState<KeySettings>(noKeySettings);
  const { setWorkspaces } = c.models;
  useEffect(() => {
    setKey('');
    setKeyTouched(false);
    setSettings(noKeySettings);
    setWorkspaces([]);
  }, [provider, setWorkspaces]);
  const id = `ob-brain-key-${provider}`;
  const formatError = key ? modelKeyError(provider, key) : undefined;
  const error = c.keyError || (keyTouched ? formatError : undefined);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await c.save(provider, key, settings)) {
      setKey('');
      setSettings(noKeySettings);
    }
  }
  return (
    <form className="ob-brain-form" onSubmit={(event) => void submit(event)} noValidate>
      <CloudKeyFields
        provider={provider}
        value={settings}
        workspaces={c.models.workspaces}
        showWorkspace={Boolean(c.keyError && !formatError)}
        onChange={(next) => {
          setSettings(next);
          c.clearError();
        }}
        disabled={c.checking}
      />
      <label className="ob-brain-label" htmlFor={id}>
        API key
      </label>
      <div className="ob-brain-row">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32000}
          placeholder={placeholders[provider]}
          autoFocus={
            autoFocus &&
            !['amazon-bedrock', 'azure', 'cloudflare-workers-ai', 'cloudflare-ai-gateway'].includes(
              provider,
            )
          }
          value={key}
          disabled={c.checking}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          data-analytics-private
          onBlur={() => setKeyTouched(true)}
          onPaste={() => setKeyTouched(true)}
          onChange={(event) => {
            setKey(event.target.value);
            setSettings((current) => ({ ...current, workspaceId: '' }));
            setWorkspaces([]);
            c.clearError();
          }}
        />
        <ConnectButton
          checking={c.checking}
          saved={modelProviderInfo[provider].catalog === 'bundled'}
          disabled={
            !!formatError || (c.models.workspaces.length > 0 && !settings.workspaceId.trim())
          }
        />
      </div>
      {error && (
        <div id={`${id}-error`}>
          <Problem>{error}</Problem>
        </div>
      )}
      <ModelKeyHelp provider={provider} className="ob-brain-note" />
    </form>
  );
}

function ServerForm({ c }: { c: Connect }) {
  const [url, setUrl] = useState(localServerAddress);
  const [key, setKey] = useState('');
  return (
    <form
      className="ob-brain-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void c.save('compatible', key, noKeySettings, url).then((saved) => saved && setKey(''));
      }}
    >
      <label className="ob-brain-label" htmlFor="ob-brain-url">
        Server address
      </label>
      <Input
        id="ob-brain-url"
        type="url"
        autoComplete="off"
        spellCheck={false}
        maxLength={2000}
        placeholder={localServerAddress}
        autoFocus
        value={url}
        disabled={c.checking}
        aria-invalid={!!c.keyError}
        aria-describedby="ob-brain-url-hint"
        data-analytics-private
        onChange={(event) => {
          setUrl(event.target.value);
          c.clearError();
        }}
      />
      <p className="ob-brain-note ob-brain-server-hint" id="ob-brain-url-hint">
        Ollama, LM Studio, vLLM or any OpenAI-compatible server.
      </p>
      <label className="ob-brain-label" htmlFor="ob-brain-server-key">
        API key <span className="ob-brain-optional">optional</span>
      </label>
      <div className="ob-brain-row">
        <Input
          id="ob-brain-server-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={32000}
          value={key}
          disabled={c.checking}
          data-analytics-private
          onChange={(event) => {
            setKey(event.target.value);
            c.clearError();
          }}
        />
        <ConnectButton checking={c.checking} />
      </div>
      <Problem>{c.keyError}</Problem>
      <p className="ob-brain-note">
        This model also decides when I ask before acting. Small models can get that wrong.
      </p>
    </form>
  );
}

function SignInFirst({ c, provider }: { c: Connect; provider: SignInProvider }) {
  const [key, setKey] = useState(false);
  return (
    <div className="ob-brain-signin">
      <div className="ob-brain-oauth">
        <Button disabled={c.locked} autoFocus onClick={() => c.signIn(provider)}>
          <Logo provider={provider} size={18} />
          {provider === 'openai' ? 'Sign in with ChatGPT' : 'Sign in to OpenRouter'}
        </Button>
        <p className="ob-brain-note">
          {provider === 'openai'
            ? 'Uses your ChatGPT Plus or Pro plan.'
            : 'Creates a key for me and uses your OpenRouter credits.'}
        </p>
      </div>
      <Problem>{c.models.error}</Problem>
      {key ? (
        <div className="ob-brain-reveal">
          <KeyForm c={c} provider={provider} autoFocus />
        </div>
      ) : (
        <button
          type="button"
          className="ob-link ob-brain-quiet"
          onClick={() => {
            c.clearError();
            setKey(true);
          }}
        >
          Use an API key instead
        </button>
      )}
    </div>
  );
}

function Setup({ c, provider }: { c: Connect; provider: ModelProvider }) {
  if (c.signingIn) return <Waiting c={c} />;
  if (provider === 'compatible') return <ServerForm c={c} />;
  if (signsIn(provider)) return <SignInFirst c={c} provider={provider} />;
  return <KeyForm c={c} provider={provider} autoFocus />;
}

function Connected({ c, onReconnect }: { c: Connect; onReconnect: () => void }) {
  const source = c.shown!;
  const saved = modelProviderInfo[source.provider]?.catalog === 'bundled';
  const choosing =
    source.status === 'connected' &&
    !c.ready &&
    (ownerChooses(source) || (!c.recommendation && source.models.length > 0));
  const missing = source.status === 'connected' && !c.ready && !c.recommendation && !choosing;
  return (
    <div className="ob-brain-connected">
      <div className="ob-brain-status">
        <span className="ob-brain-icon ob-brain-done" aria-hidden="true">
          <Check size={18} strokeWidth={2.5} />
        </span>
        <div className="ob-brain-status-text">
          <p className="ob-brain-title">
            {saved ? 'Key saved for ' : 'Connected to '}
            <span data-analytics-private>
              {source.provider === 'compatible' ? source.label : modelSource(source)}
            </span>
          </p>
          <p className="ob-brain-note">
            {source.status === 'loading'
              ? 'Load the models for this account to continue.'
              : choosing
                ? 'Choose the model I should use.'
                : missing
                  ? 'No supported models are available for this account.'
                  : saved
                    ? 'Access checked on first use. You can change the model any time.'
                    : 'I’ll use this model for every reply. You can change it any time.'}
          </p>
        </div>
      </div>
      {source.status === 'connected' && (c.ready || choosing) && (
        <div className="ob-brain-model" data-analytics-private>
          <span className="ob-brain-model-label">{choosing ? 'Model' : 'Using'}</span>
          <ModelPicker manageConnections={false} surface="onboarding" />
        </div>
      )}
      {(source.status === 'loading' || missing || c.models.error) && (
        <Button
          variant="outline"
          disabled={c.models.busy}
          onClick={() =>
            void c.models.change(`/api/models/connections/${source.id}/refresh`, 'POST')
          }
        >
          {c.models.busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          Load models
        </Button>
      )}
      {(source.status === 'loading' || missing) && (
        <Button variant="ghost" disabled={c.locked} onClick={onReconnect}>
          {source.provider === 'compatible'
            ? 'Change server'
            : source.method === 'api_key'
              ? 'Use another API key'
              : 'Use another account'}
        </Button>
      )}
      <Problem>{c.models.error}</Problem>
      <button type="button" className="ob-link ob-brain-another" onClick={c.addAnother}>
        Use a different provider
      </button>
    </div>
  );
}

function Card({
  page,
  direction,
  children,
}: {
  page: string;
  direction: 'forward' | 'back';
  children: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = inner.current!;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    setHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="ob-brain-card" style={height ? { height } : undefined}>
      <div ref={inner}>
        <div key={page} className="ob-brain-page" data-direction={direction}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Brain({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing, done, skip } = useReveal(sequence, { enabled: arrived === 'forward' });
  const c = useConnect();
  const [picked, setPicked] = useState<ModelProvider>();
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [restore, setRestore] = useState<ModelProvider>();
  const rows = useRef(new Map<ModelProvider, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);
  const entry = providers.find((item) => item.provider === picked);
  const view: View = c.shown ? 'done' : entry ? 'setup' : 'list';
  const page = view === 'setup' ? `setup:${entry!.provider}` : view;
  const [motion, setMotion] = useState({ page, view, direction: 'forward' as 'forward' | 'back' });
  if (motion.page !== page) {
    setMotion({
      page,
      view,
      direction: depth[view] >= depth[motion.view] ? 'forward' : 'back',
    });
    if (view === 'done' && picked) setPicked(undefined);
  }

  useEffect(() => {
    if (expanded) searchInput.current?.focus();
  }, [expanded]);

  useEffect(() => {
    if (view !== 'list' || !restore) return;
    rows.current.get(restore)?.focus();
    setRestore(undefined);
  }, [view, restore]);

  async function back() {
    c.clearError();
    if (c.flow.signIn && !(await c.flow.cancel())) return;
    setRestore(picked);
    setPicked(undefined);
  }

  const keepCurrent = view === 'list' ? c.keepCurrent : undefined;
  const visible = (expanded ? providers : common).filter((item) =>
    `${item.name} ${item.provider === 'compatible' ? 'Ollama LM Studio vLLM local server' : item.provider}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const list = (
    <>
      {expanded && (
        <SearchField
          inputRef={searchInput}
          placeholder="Search providers"
          aria-label="Search providers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
        />
      )}
      <ul className="ob-brain-providers" aria-label="AI providers">
        {visible.map((item) => {
          const existing = c.existing(item.provider);
          return (
            <li key={item.provider}>
              <button
                ref={(node) => {
                  if (node) rows.current.set(item.provider, node);
                  else rows.current.delete(item.provider);
                }}
                type="button"
                className="ob-brain-provider"
                disabled={c.locked}
                onClick={() => {
                  c.clearError();
                  if (existing) c.open(existing.id);
                  else setPicked(item.provider);
                }}
              >
                <Logo provider={item.provider} />
                <span className="ob-brain-provider-name">
                  {item.name}
                  {!existing && hints[item.provider] && (
                    <span className="ob-brain-provider-hint">{hints[item.provider]}</span>
                  )}
                </span>
                {existing && (
                  <span
                    className="ob-brain-check"
                    role="img"
                    aria-label={
                      modelProviderInfo[item.provider].catalog === 'bundled'
                        ? 'Key saved'
                        : 'Connected'
                    }
                  >
                    <Check size={12} aria-hidden="true" />
                  </span>
                )}
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </li>
          );
        })}
        {!visible.length && <li className="ob-brain-empty">No providers match this search.</li>}
        {!expanded && (
          <li>
            <button
              type="button"
              className="ob-brain-provider ob-brain-more"
              disabled={c.locked}
              onClick={() => setExpanded(true)}
            >
              <span className="ob-brain-lead" aria-hidden="true">
                <ChevronDown size={12} />
              </span>
              <span className="ob-brain-provider-name">More providers</span>
              <span className="ob-brain-more-logos" aria-hidden="true">
                <Logo provider="deepseek" size={16} />
                <Logo provider="mistral" size={16} />
                <Logo provider="groq" size={16} />
                <Logo provider="huggingface" size={16} />
                <Logo provider="cloudflare-workers-ai" size={16} />
                <Logo provider="qwen-token-plan" size={16} />
                <Logo provider="xai" size={16} />
                <Logo provider="kimi-coding" size={16} />
              </span>
            </button>
          </li>
        )}
      </ul>
    </>
  );

  return (
    <section className="ob-step ob-brain" onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        className="ob-brain-messages"
        items={[
          <Bubble>
            I work with most AI providers. Which one do you want me to use? You can change it later.
          </Bubble>,
        ]}
      />
      <Rise show={revealed >= 2} className="ob-brain-content">
        {!c.data && c.models.error ? (
          <Notice>
            <span data-analytics-private>{c.models.error}</span>{' '}
            <Button
              variant="ghost"
              size="sm"
              disabled={c.models.refreshing}
              onClick={() => {
                c.models.setError('');
                void c.models.refresh();
              }}
            >
              {c.models.refreshing ? 'Trying again…' : 'Try again'}
            </Button>
          </Notice>
        ) : !c.data ? (
          <div className="ob-brain-status">
            <Spinner />
            <p className="ob-brain-wait">Loading…</p>
          </div>
        ) : (
          <>
            {c.expired && (
              <p className="ob-brain-expired">
                Your {modelSource(c.expired)} connection for{' '}
                <span data-analytics-private>{c.expired.label}</span> needs attention.{' '}
                {c.expired.method === 'api_key'
                  ? 'Add the connection again to keep using it.'
                  : 'Sign in again to keep using it.'}
              </p>
            )}
            {view === 'list' && expanded ? (
              <div className="ob-brain-catalog">{list}</div>
            ) : (
              <Card page={page} direction={motion.direction}>
                {view === 'done' ? (
                  <Connected
                    c={c}
                    onReconnect={() => {
                      setPicked(c.shown!.provider);
                      c.addAnother();
                    }}
                  />
                ) : view === 'setup' ? (
                  <>
                    <header className="ob-brain-header">
                      <button
                        type="button"
                        className="ob-brain-back"
                        aria-label="All providers"
                        disabled={c.locked}
                        onClick={back}
                      >
                        <ChevronLeft size={16} aria-hidden="true" />
                      </button>
                      <h3>
                        <Logo provider={entry!.provider} />
                        {entry!.name}
                      </h3>
                    </header>
                    <div className="ob-brain-body">
                      <Setup c={c} provider={entry!.provider} />
                    </div>
                  </>
                ) : (
                  list
                )}
              </Card>
            )}
          </>
        )}
      </Rise>
      <Footer
        show={revealed >= 3}
        onBack={view === 'setup' ? back : (keepCurrent ?? onBack)}
        backLabel={keepCurrent ? 'Keep current' : 'Back'}
        busy={c.locked}
        onNext={onNext}
        nextDisabled={!c.ready || c.models.busy || c.checking || c.signingIn}
      />
    </section>
  );
}
