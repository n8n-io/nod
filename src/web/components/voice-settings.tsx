import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { SpeechVoice } from '../../shared/speech';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, errorMessage } from '../lib/api';
import { savePreferences } from '../lib/preferences';
import { Check, ChevronDown, Download, LoaderCircle, Mic, Sparkles } from './icons';
import { ConnectionMenu } from './connection-menu';
import { ModelProviderLogo } from './models';
import { VoiceConnections } from './voice-connections';
import { VoicePicker, VoiceSample, voiceProvider } from './voice-picker';
import { Button, Notice } from './ui';

const providerNames = {
  auto: 'Automatic',
  local: 'Free voices',
  elevenlabs: 'ElevenLabs',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
} as const;
type VoiceProvider = keyof typeof providerNames;

function VoiceProviderIcon({ provider }: { provider: VoiceProvider }) {
  return provider === 'auto' ? (
    <Sparkles size={18} aria-hidden="true" />
  ) : provider === 'local' ? (
    <Download size={18} aria-hidden="true" />
  ) : provider === 'elevenlabs' ? (
    <Mic size={18} aria-hidden="true" />
  ) : (
    <ModelProviderLogo provider={provider} size={18} />
  );
}

interface SpeechSettings {
  transcription: boolean;
  synthesis: boolean;
  voicesError?: string;
  voices: readonly SpeechVoice[];
  speechVoice: string | null;
  defaultVoice?: string;
  speechReply: 'auto' | 'voice' | 'always' | 'never';
  local?: { state: 'not_downloaded' | 'downloading' | 'ready' | 'failed'; progress?: number };
}

export function VoiceSettings({ onBusyChange }: { onBusyChange(busy: boolean): void }) {
  const {
    data,
    error: loadError,
    update,
    refresh,
    refreshing,
  } = usePageData<SpeechSettings>('/api/speech');
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [providerChoice, setProviderChoice] = useState<VoiceProvider | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const catalogRequest = useRef<AbortController | null>(null);
  const prepareRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);
  function stop() {
    previewRequest.current?.abort();
    previewRequest.current = null;
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
      audio.current.removeAttribute('src');
      audio.current.load();
    }
    audio.current = null;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPlaying(null);
    setPreviewing(null);
  }
  useLayoutEffect(() => {
    onBusyChange(saving || preparing || connectionBusy || catalogRefreshing);
    return () => onBusyChange(false);
  }, [saving, preparing, connectionBusy, catalogRefreshing, onBusyChange]);
  useEffect(
    () => () => {
      saveRequest.current?.abort();
      prepareRequest.current?.abort();
      catalogRequest.current?.abort();
      stop();
    },
    [],
  );
  useEffect(() => {
    if (refreshing || (!preparing && data?.local?.state !== 'downloading')) return;
    const timer = window.setTimeout(() => void refresh(), 1000);
    return () => window.clearTimeout(timer);
  }, [preparing, data?.local?.state, refresh, refreshing]);
  async function prepare() {
    if (prepareRequest.current) return;
    const controller = new AbortController();
    prepareRequest.current = controller;
    setPreparing(true);
    setError('');
    try {
      await api('/api/speech/prepare', {
        method: 'POST',
        body: JSON.stringify({ locale: navigator.language }),
        signal: controller.signal,
      });
      const next = await api<SpeechSettings>('/api/speech', { signal: controller.signal });
      controller.signal.throwIfAborted();
      update(() => next);
      await chooseProvider('local', next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (prepareRequest.current === controller) {
        prepareRequest.current = null;
        setPreparing(false);
        void refresh();
      }
    }
  }
  async function refreshVoices() {
    if (catalogRequest.current) return;
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogRefreshing(true);
    setCatalogError(false);
    setError('');
    try {
      const result = await api<SpeechSettings>('/api/speech/voices/refresh', {
        method: 'POST',
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      update((current) =>
        current
          ? {
              ...result,
              speechVoice: current.speechVoice,
              speechReply: current.speechReply,
            }
          : result,
      );
      return result;
    } catch (cause) {
      if (!controller.signal.aborted) {
        setCatalogError(true);
        setError(errorMessage(cause));
      }
    } finally {
      if (catalogRequest.current === controller) {
        catalogRequest.current = null;
        setCatalogRefreshing(false);
      }
    }
  }
  async function save(change: Partial<AccountPreferences>) {
    if (saveRequest.current) return false;
    catalogRequest.current?.abort();
    catalogRequest.current = null;
    setCatalogRefreshing(false);
    stop();
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError('');
    try {
      const saved = await savePreferences(change, controller.signal);
      update(
        (current) =>
          current && {
            ...current,
            speechVoice: saved.speechVoice ?? null,
            speechReply: saved.speechReply ?? 'auto',
          },
      );
      await refresh();
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      return false;
    } finally {
      if (saveRequest.current === controller) saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  const selected = data?.speechVoice ?? data?.defaultVoice;
  useEffect(() => {
    stop();
    setProviderChoice(null);
  }, [selected, data?.speechVoice]);
  async function preview(voiceId: string) {
    if (!data?.synthesis) return;
    if (previewing === voiceId || playing === voiceId) {
      stop();
      return;
    }
    stop();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewing(voiceId);
    setError('');
    try {
      const response = await apiResponse('/api/speech/preview', {
        method: 'POST',
        body: JSON.stringify({
          voice: voiceId,
          locale: navigator.language,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || 'The voice preview could not play. Try again.');
      }
      const blob = await response.blob();
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      previewUrl.current = url;
      const player = new Audio(url);
      audio.current = player;
      player.onended = stop;
      player.onerror = () => {
        stop();
        setError('The voice preview could not play. Try again.');
      };
      document.querySelectorAll('audio').forEach((element) => element.pause());
      await player.play();
      controller.signal.throwIfAborted();
      setPreviewing(null);
      setPlaying(voiceId);
    } catch (cause) {
      if (!controller.signal.aborted) {
        stop();
        setError(errorMessage(cause));
      }
    }
  }
  const providerSelection =
    providerChoice ?? (data?.speechVoice ? voiceProvider(data.speechVoice) : 'auto');
  useEffect(() => {
    if (providerSelection === 'auto') setPickerOpen(false);
  }, [providerSelection]);
  const automaticVoice = data?.voices.find((item) => item.id === data.defaultVoice);
  const provider =
    providerSelection === 'auto'
      ? automaticVoice
        ? voiceProvider(automaticVoice)
        : data?.defaultVoice
          ? voiceProvider(data.defaultVoice)
          : 'local'
      : providerSelection;
  const providerVoices = data?.voices.filter((item) => voiceProvider(item) === provider) ?? [];
  const providerVoiceId =
    providerSelection === 'auto'
      ? (data?.defaultVoice ?? null)
      : selected && voiceProvider(selected) === provider
        ? selected
        : null;
  const selectedVoice = providerVoices.find((item) => item.id === providerVoiceId);
  const setupBusy = preparing || connectionBusy;
  async function chooseProvider(next: VoiceProvider, settings = data) {
    if (!settings || saveRequest.current) return;
    stop();
    setError('');
    setCatalogError(false);
    setProviderChoice(next);
    if (next === 'auto') {
      if (!(await save({ speechVoice: null }))) setProviderChoice(null);
      return;
    }
    const available = settings.voices.filter((item) => voiceProvider(item) === next);
    const preferred =
      available.find((item) => item.id === (settings.speechVoice ?? settings.defaultVoice)) ??
      available[0];
    if (preferred && preferred.id !== settings.speechVoice) {
      if (!(await save({ speechVoice: preferred.id }))) setProviderChoice(null);
    }
  }
  return (
    <section className="account-region voice-settings" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Voice</h2>
      {data ? (
        <>
          <div className="account-preference-row account-picker-row">
            <span>Voice provider</span>
            <div className="voice-settings-choice">
              <ConnectionMenu
                label={`Voice provider, ${providerNames[providerSelection]}`}
                triggerClassName="input select-trigger voice-provider-trigger"
                disabled={saving || setupBusy || catalogRefreshing}
                trigger={
                  <>
                    <VoiceProviderIcon provider={providerSelection} />
                    <span className="voice-provider-name">{providerNames[providerSelection]}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </>
                }
              >
                {(close) =>
                  Object.entries(providerNames).map(([value, name]) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-label={name}
                      aria-checked={value === providerSelection}
                      onClick={() => {
                        close();
                        void chooseProvider(value as VoiceProvider);
                      }}
                    >
                      <VoiceProviderIcon provider={value as VoiceProvider} />
                      <span className="voice-provider-name voice-picker-label">
                        <span>{name}</span>
                        {value === 'auto' && automaticVoice && (
                          <small>
                            {providerNames[voiceProvider(automaticVoice)]} · {automaticVoice.name}
                          </small>
                        )}
                      </span>
                      {value === providerSelection && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))
                }
              </ConnectionMenu>
            </div>
          </div>
          <div className="voice-provider-connection">
            {provider === 'local' ? (
              <div className="voice-connect-option">
                {data.local?.state !== 'ready' && (
                  <p className="field-hint">No account needed. Download once, about 180 MB.</p>
                )}
                <div className="voice-connect-actions">
                  {data.local?.state === 'ready' ? (
                    <span className="voice-connect-ready">
                      <Check size={14} /> Downloaded
                    </span>
                  ) : data.local ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={preparing || data.local.state === 'downloading'}
                        onClick={() => void prepare()}
                      >
                        {preparing || data.local.state === 'downloading' ? (
                          <>
                            <LoaderCircle size={14} className="voice-preview-loading" />
                            Downloading…
                            {data.local.progress !== undefined &&
                              ` ${Math.round(data.local.progress)}%`}
                          </>
                        ) : (
                          'Download voices'
                        )}
                      </Button>
                      {preparing && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => prepareRequest.current?.abort()}
                        >
                          Cancel download
                        </Button>
                      )}
                    </>
                  ) : (
                    <p className="field-hint">Free voices are unavailable on this server.</p>
                  )}
                </div>
              </div>
            ) : (
              <VoiceConnections
                key={provider}
                provider={provider}
                voices={data.voices}
                disabled={preparing || saving}
                onRefresh={async () => {
                  await refreshVoices();
                }}
                onBusyChange={setConnectionBusy}
                onConnected={() => {
                  setError('');
                  void refreshVoices().then((next) => {
                    if (next) void chooseProvider(provider, next);
                  });
                }}
              />
            )}
          </div>
          <div className="account-preference-row account-picker-row">
            <span id={`${id}-voice`}>Assistant voice</span>
            <div className="voice-settings-choice">
              {providerSelection === 'auto' ? (
                <div className="voice-automatic-choice" aria-labelledby={`${id}-voice`}>
                  <span className="voice-picker-label">
                    <span>{selectedVoice ? selectedVoice.name : 'No voice available'}</span>
                    <small>
                      {selectedVoice
                        ? `${providerNames[provider]} default`
                        : 'Choose a provider to get started'}
                    </small>
                  </span>
                </div>
              ) : (
                <VoicePicker
                  providerName={providerNames[provider]}
                  voices={providerVoices}
                  value={providerVoiceId}
                  defaultVoice={selectedVoice?.id}
                  open={pickerOpen}
                  disabled={saving || setupBusy || providerVoices.length === 0}
                  labelledBy={`${id}-voice`}
                  loading={previewing}
                  playing={playing}
                  error={error || loadError || data.voicesError || ''}
                  onOpenChange={(open) => {
                    if (saveRequest.current) return;
                    stop();
                    setError('');
                    setPickerOpen(open);
                  }}
                  onChange={(speechVoice) => {
                    void save({ speechVoice }).then((saved) => {
                      if (saved) setPickerOpen(false);
                    });
                  }}
                  onPreview={(voiceId) => void preview(voiceId)}
                  onStop={stop}
                />
              )}
              {selectedVoice && (
                <VoiceSample
                  voice={selectedVoice}
                  loading={previewing === selectedVoice.id}
                  playing={playing === selectedVoice.id}
                  disabled={saving || setupBusy}
                  onPlay={() => void preview(selectedVoice.id)}
                />
              )}
            </div>
          </div>
          {data.speechVoice && providerVoiceId && !selectedVoice && (
            <p className="field-hint" role="status">
              Your saved voice is unavailable. Check the connection or choose another voice.
            </p>
          )}
          <div className="account-preference-row account-picker-row">
            <span id={`${id}-replies`}>Spoken replies</span>
            <div className="voice-reply-options" role="group" aria-labelledby={`${id}-replies`}>
              {(
                [
                  ['auto', 'Auto'],
                  ['voice', 'When I send audio'],
                  ['always', 'Always'],
                  ['never', 'Off'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={data.speechReply === value}
                  disabled={saving || setupBusy}
                  onClick={() => void save({ speechReply: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : !loadError ? (
        <p className="field-hint">Loading voices…</p>
      ) : null}
      {!pickerOpen && (loadError || error || data?.voicesError) && (
        <Notice>
          {loadError || error || data?.voicesError}
          {(loadError || data?.voicesError || catalogError) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing || catalogRefreshing}
              onClick={() => void (data?.voicesError || catalogError ? refreshVoices() : refresh())}
            >
              Try again
            </Button>
          )}
        </Notice>
      )}
    </section>
  );
}
