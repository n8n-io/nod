import { useEffect, useId, useRef, useState } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { SpeechVoice } from '../../shared/speech';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, errorMessage } from '../lib/api';
import { savePreferences } from '../lib/preferences';
import { Download, LoaderCircle } from './icons';
import { VoiceConnections } from './voice-connections';
import { VoicePicker, VoiceSample } from './voice-picker';
import { Button, Notice } from './ui';

interface SpeechSettings {
  transcription: boolean;
  synthesis: boolean;
  voices: readonly SpeechVoice[];
  speechVoice: string | null;
  defaultVoice?: string;
  speechReply: 'voice' | 'always' | 'never';
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
  const [adding, setAdding] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [setupNotice, setSetupNotice] = useState(false);
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
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
  useEffect(() => {
    onBusyChange(saving || preparing || connectionBusy);
    return () => onBusyChange(false);
  }, [saving, preparing, connectionBusy, onBusyChange]);
  useEffect(
    () => () => {
      saveRequest.current?.abort();
      prepareRequest.current?.abort();
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
      await refresh();
      setAdding(false);
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
  async function save(change: Partial<AccountPreferences>) {
    if (saveRequest.current) return;
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
            speechReply: saved.speechReply ?? 'voice',
          },
      );
      await refresh();
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (saveRequest.current === controller) saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }
  const selected = data?.speechVoice ?? data?.defaultVoice;
  const voice = data?.voices.find((item) => item.id === selected);
  useEffect(() => stop(), [selected]);
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
  const setupBusy = preparing || connectionBusy;
  const canAdd = Boolean(
    data &&
    ((data.local && data.local.state !== 'ready') ||
      !data.voices.some((item) => item.engine === 'ElevenLabs' || item.engine === 'Kokoro') ||
      !data.voices.some((item) => item.engine === 'OpenAI')),
  );
  useEffect(() => {
    if (adding && !setupBusy && !canAdd) setAdding(false);
    if (!setupBusy) setSetupNotice(false);
  }, [adding, setupBusy, canAdd]);
  return (
    <section className="account-region voice-settings" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Voice</h2>
      {data ? (
        <>
          <div className="account-preference-row account-picker-row">
            <span id={`${id}-replies`}>Spoken replies</span>
            <div className="voice-reply-options" role="group" aria-labelledby={`${id}-replies`}>
              {(
                [
                  ['voice', 'When I send audio'],
                  ['always', 'Always'],
                  ['never', 'Off'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={data.speechReply === value}
                  disabled={saving}
                  onClick={() => void save({ speechReply: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="account-preference-row account-picker-row">
            <span id={`${id}-voice`}>Assistant voice</span>
            <div className="voice-settings-choice">
              <VoicePicker
                voices={data.voices}
                value={data.speechVoice}
                defaultVoice={data.defaultVoice}
                open={pickerOpen}
                disabled={saving}
                labelledBy={`${id}-voice`}
                loading={previewing}
                playing={playing}
                error={setupNotice ? 'Finish or cancel setup first.' : error || loadError}
                adding={adding}
                setupBusy={setupBusy}
                canAdd={canAdd}
                onAddingChange={(next) => {
                  setError('');
                  setAdding(next);
                }}
                setup={
                  <>
                    {data.local && data.local.state !== 'ready' && (
                      <div className="voice-connect-option">
                        <div className="voice-connect-heading">
                          <Download size={20} aria-hidden="true" />
                          <div>
                            <h3>Free voices</h3>
                            <p>No account needed. Download once, about 180 MB.</p>
                          </div>
                        </div>
                        <div className="voice-connect-actions">
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              connectionBusy || preparing || data.local.state === 'downloading'
                            }
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
                        </div>
                      </div>
                    )}
                    <VoiceConnections
                      availableEngines={data.voices.map((item) => item.engine)}
                      disabled={preparing}
                      onBusyChange={setConnectionBusy}
                      onConnected={() => {
                        setError('');
                        void refresh().then(() => setAdding(false));
                      }}
                    />
                  </>
                }
                onOpenChange={(open) => {
                  if (!open && setupBusy) {
                    setSetupNotice(true);
                    return;
                  }
                  stop();
                  setError('');
                  if (open) setAdding(data.voices.length === 0);
                  setPickerOpen(open);
                }}
                onChange={(speechVoice) => {
                  setPickerOpen(false);
                  void save({ speechVoice });
                }}
                onPreview={(voiceId) => void preview(voiceId)}
                onStop={stop}
              />
              {voice && (
                <VoiceSample
                  voice={voice}
                  loading={previewing === voice.id}
                  playing={playing === voice.id}
                  disabled={saving}
                  onPlay={() => void preview(voice.id)}
                />
              )}
            </div>
          </div>
          {selected?.startsWith('openai:') && (
            <p className="field-hint voice-settings-disclosure">
              OpenAI voices are generated by AI.
            </p>
          )}
        </>
      ) : !loadError ? (
        <p className="field-hint">Loading voices…</p>
      ) : null}
      {!pickerOpen && (loadError || error) && (
        <Notice>
          {loadError || error}
          {loadError && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              Try again
            </Button>
          )}
        </Notice>
      )}
    </section>
  );
}
