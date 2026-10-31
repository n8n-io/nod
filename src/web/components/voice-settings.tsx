import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { SpeechVoice } from '../../shared/speech';
import { useModels } from '../hooks/use-models';
import { usePageData } from '../hooks/use-page-data';
import { useVoiceRecorder } from '../hooks/use-voice-recorder';
import { api, apiResponse, errorMessage } from '../lib/api';
import { desktopSettingsAvailable } from '../lib/desktop';
import { savePreferences } from '../lib/preferences';
import { SearchPicker } from './search-picker';
import { useSettingsDraft } from './settings-drafts';
import { VoiceConnections } from './voice-connections';
import {
  VoicePicker,
  VoiceSample,
  voiceProvider,
  voiceProviderNames,
  type ConnectedVoiceProvider,
  type LocalVoiceStatus,
} from './voice-picker';
import { Button, Dialog, DialogContent, DialogTitle, Notice } from './ui';

interface SpeechSettings {
  transcription: boolean;
  synthesis: boolean;
  voicesError?: string;
  voices: readonly SpeechVoice[];
  speechVoice: string | null;
  defaultVoice?: string;
  speechReply: 'auto' | 'voice' | 'always' | 'never';
  local?: LocalVoiceStatus;
  localInput?: LocalVoiceStatus;
}

export function VoiceSettings({ onBusyChange }: { onBusyChange(busy: boolean): void }) {
  const {
    data,
    error: loadError,
    update,
    refresh,
    refreshing,
  } = usePageData<SpeechSettings>('/api/speech');
  const models = useModels();
  const recorder = useVoiceRecorder('settings-microphone');
  const id = useId();
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');
  const [permissionHelp, setPermissionHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingReply, setPendingReply] = useState<SpeechSettings['speechReply'] | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectedVoiceProvider | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [discardConnection, setDiscardConnection] = useState(false);
  const [error, setError] = useState('');
  const [preparationError, setPreparationError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const catalogRequest = useRef<AbortController | null>(null);
  const catalogResult = useRef<Promise<SpeechSettings | undefined> | null>(null);
  const prepareRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);
  const voiceRow = useRef<HTMLDivElement>(null);
  const returnToChooser = useRef(false);
  const mounted = useRef(true);
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
  const busy = saving || preparing || connectionBusy || catalogRefreshing || recorder.discovering;
  useLayoutEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useSettingsDraft('voice', { changes: [], busy, save: async () => !busy, discard: () => {} });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveRequest.current?.abort();
      prepareRequest.current?.abort();
      catalogRequest.current?.abort();
      stop();
    };
  }, []);
  useEffect(() => {
    void recorder.refreshMicrophones();
    let current = true;
    let status: PermissionStatus | undefined;
    const changed = () => {
      if (current && status) {
        setPermission(status.state);
        void recorder.refreshMicrophones();
      }
    };
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (!current) return;
        status = result;
        changed();
        status.addEventListener('change', changed);
      })
      .catch(() => {});
    const focus = () => void recorder.refreshMicrophones();
    window.addEventListener('focus', focus);
    return () => {
      current = false;
      status?.removeEventListener('change', changed);
      window.removeEventListener('focus', focus);
    };
  }, []);
  useEffect(() => {
    if (
      refreshing ||
      (!preparing &&
        data?.local?.state !== 'downloading' &&
        data?.localInput?.state !== 'downloading')
    )
      return;
    const timer = window.setTimeout(() => void refresh(), 1000);
    return () => window.clearTimeout(timer);
  }, [preparing, data?.local?.state, data?.localInput?.state, refresh, refreshing]);
  async function prepare() {
    if (prepareRequest.current) return;
    const controller = new AbortController();
    prepareRequest.current = controller;
    setPreparing(true);
    setPreparationError('');
    try {
      await api('/api/speech/prepare', {
        method: 'POST',
        body: JSON.stringify({ locale: navigator.language }),
        signal: controller.signal,
      });
      const next = await api<SpeechSettings>('/api/speech', { signal: controller.signal });
      controller.signal.throwIfAborted();
      update(() => next);
    } catch (cause) {
      if (!controller.signal.aborted) setPreparationError(errorMessage(cause));
    } finally {
      if (prepareRequest.current === controller) {
        prepareRequest.current = null;
        if (mounted.current) {
          setPreparing(false);
          void refresh();
        }
      }
    }
  }
  function refreshVoices(fresh = false): Promise<SpeechSettings | undefined> {
    if (catalogResult.current)
      return fresh
        ? catalogResult.current.then(() => (mounted.current ? refreshVoices() : undefined))
        : catalogResult.current;
    if (!mounted.current) return Promise.resolve(undefined);
    const controller = new AbortController();
    catalogRequest.current = controller;
    setCatalogRefreshing(true);
    setCatalogError('');
    const pending = (async () => {
      try {
        const result = await api<SpeechSettings>('/api/speech/voices/refresh', {
          method: 'POST',
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        update((current) =>
          current
            ? { ...result, speechVoice: current.speechVoice, speechReply: current.speechReply }
            : result,
        );
        return result;
      } catch (cause) {
        if (!controller.signal.aborted) setCatalogError(errorMessage(cause));
      } finally {
        if (catalogRequest.current === controller) {
          catalogRequest.current = null;
          catalogResult.current = null;
          if (mounted.current) setCatalogRefreshing(false);
        }
      }
    })();
    catalogResult.current = pending;
    return pending;
  }
  async function save(change: Partial<AccountPreferences>) {
    if (saveRequest.current) return false;
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    setError('');
    if (change.speechReply) setPendingReply(change.speechReply);
    stop();
    try {
      const saved = await savePreferences(change, controller.signal);
      controller.signal.throwIfAborted();
      update(
        (current) =>
          current && {
            ...current,
            speechVoice: saved.speechVoice ?? null,
            speechReply: saved.speechReply ?? 'auto',
          },
      );
      void refresh();
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      return false;
    } finally {
      if (saveRequest.current === controller) {
        saveRequest.current = null;
        if (mounted.current) {
          setSaving(false);
          setPendingReply(null);
        }
      }
    }
  }
  const voices =
    data?.voices.filter(
      (voice) => voiceProvider(voice) !== 'local' || data.local?.state === 'ready',
    ) ?? [];
  const selected = data?.speechVoice ?? data?.defaultVoice;
  const selectedVoice = voices.find((voice) => voice.id === selected);
  useEffect(() => {
    stop();
  }, [selected, data?.speechVoice, Boolean(selectedVoice)]);
  async function preview(voiceId: string) {
    if (!data?.synthesis || !voices.some((voice) => voice.id === voiceId)) return;
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
        body: JSON.stringify({ voice: voiceId, locale: navigator.language }),
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
  const providerOptions = (['elevenlabs', 'openrouter', 'openai'] as const).map((provider) => {
    const connections =
      models.data?.connections.filter(
        (item) => item.provider === provider && item.method !== 'subscription',
      ) ?? [];
    return {
      id: provider,
      action: voices.some((voice) => voiceProvider(voice) === provider)
        ? 'Manage'
        : connections.some((item) => item.status === 'reconnect')
          ? 'Reconnect'
          : connections.length
            ? 'Review'
            : 'Connect',
    };
  });
  const access = recorder.microphoneAccess && permission !== 'denied';
  const microphoneHelp = !recorder.supported
    ? 'Microphone recording is unavailable in this browser.'
    : permission === 'denied'
      ? 'Allow access in your browser or device settings.'
      : recorder.microphoneFailure;
  return (
    <section className="account-region voice-settings">
      <div className="account-preference-row">
        <span id={`${id}-microphone`}>Microphone</span>
        <div className="voice-microphone-control">
          {access ? (
            <SearchPicker
              className="voice-microphone-picker"
              labelledBy={`${id}-microphone`}
              value={recorder.microphoneId}
              onChange={recorder.selectMicrophone}
              options={[
                { value: '', label: 'System default' },
                ...recorder.microphones.map((device, index) => ({
                  value: device.deviceId,
                  label: device.label || `Microphone ${index + 1}`,
                })),
              ]}
              labels={{
                choose: 'Choose microphone',
                search: 'Search microphones',
                placeholder: 'Search microphones',
                clear: 'Clear microphone search',
                list: 'Microphones',
                empty: 'No microphones found.',
              }}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="voice-access-button"
              aria-label="Allow microphone access"
              disabled={!recorder.supported || recorder.discovering}
              onClick={() =>
                permission === 'denied'
                  ? setPermissionHelp(true)
                  : void recorder.discoverMicrophones()
              }
            >
              {recorder.discovering ? 'Waiting for permission…' : 'Allow access'}
            </Button>
          )}
        </div>
      </div>
      {microphoneHelp && (
        <p className="field-hint" role={recorder.microphoneFailure ? 'alert' : undefined}>
          {microphoneHelp}
        </p>
      )}
      {data ? (
        <>
          <div ref={voiceRow} className="account-preference-row">
            <span id={`${id}-voice`}>Voice</span>
            <div className="voice-settings-choice">
              <VoicePicker
                voices={voices}
                value={data.speechVoice}
                defaultVoice={data.defaultVoice}
                open={pickerOpen}
                disabled={saving || connectionBusy}
                labelledBy={`${id}-voice`}
                loading={previewing}
                playing={playing}
                error={error || catalogError || data.voicesError || ''}
                local={data.local}
                preparing={preparing}
                preparationError={preparationError}
                refreshing={catalogRefreshing}
                providers={providerOptions}
                onOpenChange={(open) => {
                  stop();
                  setPickerOpen(open);
                }}
                onChange={(speechVoice) => {
                  if (speechVoice && !voices.some((voice) => voice.id === speechVoice)) return;
                  void save({ speechVoice }).then((saved) => {
                    if (saved && mounted.current) setPickerOpen(false);
                  });
                }}
                onPreview={(voice) => void preview(voice)}
                onStop={stop}
                onPrepare={() => void prepare()}
                onCancelPreparation={() => prepareRequest.current?.abort()}
                onConnect={(provider) => {
                  stop();
                  setConnection(provider);
                }}
                onRefresh={() => void refreshVoices()}
              />
              <VoiceSample
                voice={selectedVoice}
                loading={Boolean(selectedVoice && previewing === selectedVoice.id)}
                playing={Boolean(selectedVoice && playing === selectedVoice.id)}
                disabled={saving || !selectedVoice || !data.synthesis}
                onPlay={() => {
                  if (selectedVoice) void preview(selectedVoice.id);
                }}
              />
            </div>
          </div>
          {data.speechVoice && !selectedVoice && (
            <p className="field-hint" role="status">
              Your saved voice is unavailable. Check its connection or choose another voice.
            </p>
          )}
          {!pickerOpen && (preparing || data.local?.state === 'downloading') && (
            <p className="field-hint" role="status">
              {(data.local?.progress ?? 0) >= 100
                ? 'Preparing free voices…'
                : `Downloading free voices · ${Math.round(data.local?.progress ?? 0)}%`}
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
            </p>
          )}
          <div className="account-preference-row voice-spoken-row">
            <span id={`${id}-replies`}>Spoken replies</span>
            <div className="voice-reply-options" role="group" aria-labelledby={`${id}-replies`}>
              {(
                [
                  ['auto', 'Auto'],
                  ['voice', 'After audio'],
                  ['always', 'Always'],
                  ['never', 'Off'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={(pendingReply ?? data.speechReply) === value}
                  disabled={saving}
                  onClick={() => {
                    if (value !== data.speechReply) void save({ speechReply: value });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        !loadError && <p className="field-hint">Loading voices…</p>
      )}
      {!pickerOpen &&
        (loadError || error || catalogError || data?.voicesError || preparationError) && (
          <Notice>
            {loadError || error || catalogError || data?.voicesError || preparationError}
            {(loadError || catalogError || data?.voicesError) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={refreshing || catalogRefreshing}
                onClick={() => void (loadError ? refresh() : refreshVoices())}
              >
                Try again
              </Button>
            )}
          </Notice>
        )}
      <Dialog
        open={connection !== null}
        onOpenChange={(open) => {
          if (open || connectionBusy) return;
          if (connectionDirty) setDiscardConnection(true);
          else setConnection(null);
        }}
      >
        <DialogContent
          className="voice-connection-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnToChooser.current) {
              returnToChooser.current = false;
              setPickerOpen(true);
            } else
              voiceRow.current
                ?.querySelector<HTMLButtonElement>('.voice-picker-trigger')
                ?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>
            {connection ? voiceProviderNames[connection] : 'Voice connection'}
          </DialogTitle>
          {connection && (
            <VoiceConnections
              key={connection}
              provider={connection}
              voices={voices}
              disabled={saving}
              onBusyChange={setConnectionBusy}
              onDirtyChange={setConnectionDirty}
              onRefresh={async () => {
                await refreshVoices();
              }}
              onConnected={() => {
                void refreshVoices(true).then(() => {
                  if (!mounted.current) return;
                  returnToChooser.current = true;
                  setConnectionBusy(false);
                  setConnection(null);
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={discardConnection} onOpenChange={setDiscardConnection}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Discard connection details?</DialogTitle>
          <p className="field-hint">These details haven’t been saved.</p>
          <div className="dialog-actions">
            <Button type="button" variant="secondary" onClick={() => setDiscardConnection(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDiscardConnection(false);
                setConnection(null);
              }}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={permissionHelp} onOpenChange={setPermissionHelp}>
        <DialogContent aria-describedby={`${id}-permission-help`}>
          <DialogTitle>Microphone access</DialogTitle>
          <p id={`${id}-permission-help`} className="field-hint">
            {desktopSettingsAvailable()
              ? /Mac/.test(navigator.platform)
                ? 'Allow Nod in System Settings → Privacy & Security → Microphone.'
                : 'Allow microphone access for Nod in your device’s privacy settings.'
              : 'Allow Microphone in this site’s browser permissions, then return here.'}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setPermissionHelp(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
