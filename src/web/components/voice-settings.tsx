import { useEffect, useId, useRef, useState } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { SpeechVoice } from '../../shared/speech';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, errorMessage } from '../lib/api';
import { savePreferences } from '../lib/preferences';
import { LoaderCircle } from './icons';
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

export function VoiceSettings({
  onBusyChange,
  onModels,
}: {
  onBusyChange(busy: boolean): void;
  onModels(): void;
}) {
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
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);
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
  return (
    <section className="account-region voice-settings" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Voice</h2>
      {data?.synthesis ? (
        <>
          <div className="account-preference-row account-picker-row">
            <span id={`${id}-replies`}>Spoken replies</span>
            <div className="voice-reply-options" role="group" aria-labelledby={`${id}-replies`}>
              {(
                [
                  ['voice', 'Voice messages'],
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
                error={error}
                onOpenChange={(open) => {
                  stop();
                  setError('');
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
      ) : (
        <p className="field-hint">
          {data
            ? 'Hear nod’s replies aloud. Download voices or connect a voice service.'
            : 'Loading voices…'}
        </p>
      )}
      {data && (
        <div className="voice-settings-providers">
          {data.local && data.local.state !== 'ready' && (
            <div className="voice-settings-setup">
              <div>
                <span>Local voices</span>
                <p className="field-hint">One download, no account. About 180 MB.</p>
              </div>
              <div className="voice-settings-download">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || preparing || data.local.state === 'downloading'}
                  onClick={() => void prepare()}
                >
                  {preparing || data.local.state === 'downloading' ? (
                    <>
                      <LoaderCircle size={14} className="voice-preview-loading" />
                      Downloading…
                      {data.local.progress !== undefined && ` ${Math.round(data.local.progress)}%`}
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
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="voice-settings-services">
            {!data.voices.some((item) => item.engine !== 'Local') && (
              <p className="field-hint">More voices with OpenRouter or OpenAI.</p>
            )}
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onModels}>
              Voice services
            </Button>
          </div>
        </div>
      )}
      {(loadError || (error && !pickerOpen)) && <Notice>{loadError || error}</Notice>}
    </section>
  );
}
