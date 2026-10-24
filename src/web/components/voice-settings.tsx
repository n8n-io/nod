import { useEffect, useId, useRef, useState } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { SpeechVoice } from '../../shared/speech';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, errorMessage } from '../lib/api';
import { savePreferences } from '../lib/preferences';
import { LoaderCircle, Play, Square } from './icons';
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

const languageNames = new Intl.DisplayNames('en', { type: 'language' });

function voiceLanguage(voice: SpeechVoice) {
  return voice.language ? languageNames.of(voice.language) : 'Multilingual';
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
  const [previewing, setPreviewing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [phrase, setPhrase] = useState('');
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
    setPlaying(false);
    setPreviewing(false);
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
  const defaultVoice = data?.voices.find((item) => item.id === data.defaultVoice);
  const voice = data?.voices.find((item) => item.id === selected);
  useEffect(() => stop(), [selected]);
  async function preview() {
    if (!data?.synthesis) return;
    stop();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewing(true);
    setError('');
    try {
      const response = await apiResponse('/api/speech/preview', {
        method: 'POST',
        body: JSON.stringify({
          voice: selected ?? null,
          locale: navigator.language,
          text: phrase.trim() || undefined,
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
      setPreviewing(false);
      setPlaying(true);
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
            <label htmlFor={`${id}-replies`}>Audio replies</label>
            <select
              id={`${id}-replies`}
              className="input"
              value={data.speechReply}
              disabled={saving}
              onChange={(event) =>
                void save({ speechReply: event.target.value as SpeechSettings['speechReply'] })
              }
            >
              <option value="voice">When I send audio</option>
              <option value="always">Every reply</option>
              <option value="never">Off</option>
            </select>
          </div>
          <div className="account-preference-row account-picker-row">
            <label htmlFor={`${id}-voice`}>Assistant voice</label>
            <select
              id={`${id}-voice`}
              className="input"
              value={data.speechVoice ?? ''}
              disabled={saving}
              onChange={(event) => void save({ speechVoice: event.target.value || null })}
            >
              <option value="">Default{defaultVoice ? ` (${defaultVoice.name})` : ''}</option>
              {data.speechVoice && !voice && (
                <option value={data.speechVoice}>Voice unavailable</option>
              )}
              {[...new Set(data.voices.map((item) => item.engine))].map((engine) => (
                <optgroup key={engine} label={engine}>
                  {data.voices
                    .filter((item) => item.engine === engine)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {voiceLanguage(item)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <p id={`${id}-language`} className="field-hint">
            {voice
              ? voice.language
                ? voice.description
                : `${voice.description}. Follows your conversation’s language.`
              : data.speechVoice
                ? 'Choose an available voice to hear a preview.'
                : 'Preview the default voice.'}
          </p>
          <div className="account-preference-row account-picker-row voice-settings-phrase">
            <label htmlFor={`${id}-phrase`}>Try a phrase</label>
            <div className="voice-settings-preview">
              <textarea
                id={`${id}-phrase`}
                className="input"
                dir="auto"
                rows={2}
                maxLength={500}
                value={phrase}
                placeholder="Write something in your language"
                aria-describedby={`${id}-language`}
                onChange={(event) => {
                  stop();
                  setPhrase(event.target.value);
                  setError('');
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving || (!!data.speechVoice && !voice)}
                aria-label={playing || previewing ? 'Stop voice preview' : 'Preview voice'}
                onClick={() => (playing || previewing ? stop() : void preview())}
              >
                {previewing ? (
                  <LoaderCircle size={16} className="voice-preview-loading" />
                ) : playing ? (
                  <Square size={14} fill="currentColor" />
                ) : (
                  <Play size={16} solid />
                )}
                {playing || previewing ? 'Stop preview' : 'Preview voice'}
              </Button>
            </div>
          </div>
          {selected?.startsWith('openai:') && (
            <p className="field-hint">OpenAI voices are generated by AI.</p>
          )}
        </>
      ) : (
        <p className="field-hint">
          {data
            ? 'Enable local audio or connect a voice service to hear nod’s replies.'
            : 'Loading voices…'}
        </p>
      )}
      {data && (
        <div className="voice-settings-providers">
          <div className="account-preference-row account-picker-row">
            <p className="field-hint">
              Use ElevenLabs voices through OpenRouter, or voices from your OpenAI connection.
            </p>
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onModels}>
              Manage connections
            </Button>
          </div>
          {data.local && (
            <div className="account-preference-row account-picker-row">
              <p className="field-hint">
                {data.local.state === 'ready'
                  ? 'Local audio is ready. Choose a local voice to use it.'
                  : 'Download local audio once (about 180 MB) for English, Portuguese, Spanish, French, Hindi, and Italian. No account needed.'}
              </p>
              {data.local.state !== 'ready' && (
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
                        Preparing audio…
                      </>
                    ) : (
                      'Enable local audio'
                    )}
                  </Button>
                  {(preparing || data.local.state === 'downloading') && (
                    <span role="status">
                      {data.local.progress === undefined
                        ? 'Starting download…'
                        : `${Math.round(data.local.progress)}%`}
                    </span>
                  )}
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
              )}
            </div>
          )}
        </div>
      )}
      {(error || loadError) && <Notice>{error || loadError}</Notice>}
    </section>
  );
}
