import { useLayoutEffect, useState } from 'react';
import type { SpeechVoice } from '../../shared/speech';
import { useModelSignIn, useModels } from '../hooks/use-models';
import { Check, ExternalLink, LoaderCircle, Mic, RefreshCw } from './icons';
import { modelProviderNames } from '../../shared/models';
import { ModelKeyHelp, ModelProviderLogo } from './models';
import { Button, Field, Input, Notice } from './ui';

export function VoiceConnections({
  voices,
  onRefresh,
  onConnected,
  onBusyChange,
  disabled = false,
}: {
  voices: readonly SpeechVoice[];
  onRefresh(): Promise<void>;
  onConnected(): void;
  onBusyChange(busy: boolean): void;
  disabled?: boolean;
}) {
  const models = useModels();
  const [keyProvider, setKeyProvider] = useState<'elevenlabs' | 'openrouter' | 'openai' | null>(
    null,
  );
  const [key, setKey] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [callback, setCallback] = useState('');
  const flow = useModelSignIn(models, () => {
    setKey('');
    setCallback('');
    setKeyProvider(null);
    onConnected();
  });
  const busy = models.busy || flow.pending || !!flow.signIn || refreshing;
  const dirty = busy || Boolean(key.trim() || callback.trim());
  useLayoutEffect(() => {
    onBusyChange(dirty);
    return () => onBusyChange(false);
  }, [dirty, onBusyChange]);
  function addKey(provider: 'elevenlabs' | 'openrouter' | 'openai') {
    setKey('');
    setCallback('');
    models.setError('');
    setKeyProvider(provider);
  }
  const directConnections =
    models.data?.connections.filter((connection) => connection.provider === 'elevenlabs') ?? [];
  const providers = ['elevenlabs', 'openrouter', 'openai'] as const;
  function connected(provider: (typeof providers)[number]) {
    return (
      voices.some(
        (voice) =>
          voice.source === provider ||
          (!voice.source &&
            (provider === 'openrouter'
              ? /^(elevenlabs|kokoro):/.test(voice.id)
              : voice.id.startsWith(provider === 'elevenlabs' ? 'elevenlabs-direct:' : 'openai:'))),
      ) ||
      models.data?.connections.some(
        (connection) =>
          connection.provider === provider &&
          connection.status === 'connected' &&
          connection.method !== 'subscription',
      )
    );
  }
  return (
    <div className="voice-connections">
      {!models.data && models.loading ? (
        <p className="field-hint" role="status">
          Loading voice services…
        </p>
      ) : (
        models.data &&
        providers.map((provider) => (
          <section className="voice-connect-option" key={provider}>
            <div className="voice-connect-heading">
              {provider === 'elevenlabs' ? (
                <Mic size={22} aria-hidden="true" />
              ) : (
                <ModelProviderLogo provider={provider} size={22} />
              )}
              <div>
                <h3>{modelProviderNames[provider]}</h3>
                <p>
                  {connected(provider)
                    ? provider === 'elevenlabs'
                      ? 'Use the voices saved in your ElevenLabs account.'
                      : 'Ready with your saved connection.'
                    : provider === 'elevenlabs'
                      ? 'Use voices from your ElevenLabs account.'
                      : provider === 'openrouter'
                        ? 'ElevenLabs and more, using your OpenRouter credits.'
                        : 'Use an OpenAI API key. Separate from a ChatGPT plan.'}
                </p>
              </div>
            </div>
            {connected(provider) && keyProvider !== provider && (
              <div className="voice-connect-actions">
                <span className="voice-connect-ready">
                  <Check size={14} /> Connected
                </span>
                {provider === 'elevenlabs' && (
                  <>
                    <a
                      className="voice-library-link"
                      href="https://elevenlabs.io/app/voice-library"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Browse voices <ExternalLink size={13} />
                    </a>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled || (busy && !refreshing) || Boolean(key.trim())}
                      aria-disabled={refreshing || undefined}
                      onClick={() => {
                        if (refreshing) return;
                        setRefreshing(true);
                        void onRefresh().finally(() => setRefreshing(false));
                      }}
                    >
                      <RefreshCw
                        size={14}
                        className={refreshing ? 'voice-preview-loading' : undefined}
                      />
                      Refresh voices
                    </Button>
                  </>
                )}
              </div>
            )}
            {!connected(provider) &&
              keyProvider !== provider &&
              flow.signIn?.provider !== provider && (
                <div className="voice-connect-actions">
                  {provider === 'openrouter' && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled || busy || Boolean(key.trim())}
                      onClick={() => {
                        setKey('');
                        setKeyProvider(null);
                        setCallback('');
                        void flow.connect('openrouter');
                      }}
                    >
                      {flow.pending && !flow.signIn ? (
                        <>
                          <LoaderCircle size={14} className="voice-preview-loading" />
                          Opening sign-in…
                        </>
                      ) : (
                        'Sign in with OpenRouter'
                      )}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant={provider === 'openrouter' ? 'ghost' : 'outline'}
                    size="sm"
                    disabled={disabled || busy || Boolean(key.trim())}
                    onClick={() => addKey(provider)}
                  >
                    {provider === 'openrouter' ? 'Use API key' : 'Connect'}
                  </Button>
                </div>
              )}
            {provider === 'elevenlabs' && directConnections.length > 0 && (
              <details className="voice-connect-manage">
                <summary>Manage connection</summary>
                {directConnections.map((connection) => (
                  <div className="voice-connection-entry" key={connection.id}>
                    <span>
                      {connection.managed
                        ? 'Set up on this device'
                        : connection.keyEnding
                          ? `Key …${connection.keyEnding}`
                          : 'Saved key'}
                      {connection.status === 'reconnect' && ' · Reconnect to continue'}
                    </span>
                    {!connection.managed && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={disabled || busy || Boolean(key.trim())}
                        onClick={() => {
                          void models
                            .change(`/api/models/connections/${connection.id}`, 'DELETE')
                            .then((removed) => {
                              if (removed) void onRefresh();
                            });
                        }}
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                ))}
                {directConnections.length > 1 && (
                  <p className="field-hint">Keep one ElevenLabs connection to use its voices.</p>
                )}
              </details>
            )}
            {keyProvider === provider && (
              <form
                className="voice-connect-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (disabled || busy || !key.trim()) return;
                  const value = key.trim();
                  setKey('');
                  void models
                    .change('/api/models/keys', 'POST', { provider, key: value })
                    .then((saved) => {
                      if (saved) {
                        setKeyProvider(null);
                        onConnected();
                      }
                    });
                }}
              >
                <Field label={`${modelProviderNames[provider]} API key`}>
                  <Input
                    type="password"
                    value={key}
                    required
                    minLength={8}
                    maxLength={32000}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    disabled={disabled || busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                <ModelKeyHelp provider={provider} />
                {provider === 'elevenlabs' && (
                  <p className="field-hint">
                    Allow Text to Speech, Speech to Text and Voices read. You can set a credit
                    limit.
                  </p>
                )}
                <div className="voice-connect-actions">
                  <Button type="submit" size="sm" disabled={disabled || busy || !key.trim()}>
                    {models.busy ? 'Connecting…' : 'Connect'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || busy}
                    onClick={() => {
                      setKey('');
                      setKeyProvider(null);
                      models.setError('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {flow.signIn?.provider === provider && (
              <div className="voice-connect-form">
                <p role="status">Finish signing in with OpenRouter, then return here.</p>
                <div className="voice-connect-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || flow.pending || models.busy}
                    onClick={flow.reopen}
                  >
                    Open sign-in <ExternalLink size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || flow.pending || models.busy}
                    onClick={() => {
                      setCallback('');
                      void flow.cancel();
                    }}
                  >
                    Cancel sign-in
                  </Button>
                </div>
                <details>
                  <summary>Having trouble?</summary>
                  <p className="field-hint">
                    If the browser finishes on a page that won’t load, paste its full address.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (disabled || flow.pending || models.busy || !callback.trim()) return;
                      const url = callback.trim();
                      setCallback('');
                      void flow.complete(url);
                    }}
                  >
                    <Field label="Callback URL">
                      <Input
                        type="url"
                        value={callback}
                        required
                        autoComplete="off"
                        spellCheck={false}
                        disabled={disabled || flow.pending || models.busy}
                        onChange={(event) => setCallback(event.target.value)}
                      />
                    </Field>
                    <Button
                      type="submit"
                      size="sm"
                      disabled={disabled || flow.pending || models.busy || !callback.trim()}
                    >
                      {models.busy ? 'Connecting…' : 'Complete sign-in'}
                    </Button>
                  </form>
                </details>
              </div>
            )}
          </section>
        ))
      )}
      {models.error && (
        <Notice>
          {models.error}
          {!models.data && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={models.refreshing}
              onClick={() => {
                models.setError('');
                void models.refresh();
              }}
            >
              Try again
            </Button>
          )}
        </Notice>
      )}
    </div>
  );
}
