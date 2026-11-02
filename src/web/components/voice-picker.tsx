import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { SpeechVoice } from '../../shared/speech';
import { Check, ChevronDown, Download, LoaderCircle, Play, RefreshCw, Square } from './icons';
import {
  ActionMenuItem,
  ActionMenuSurface,
  actionMenuTabTarget,
  focusActionMenuItem,
} from './action-menu';
import { ModelProviderLogo } from './models';
import { Button, SearchField } from './ui';

export const voiceProviderNames = {
  local: 'Free voices',
  elevenlabs: 'ElevenLabs',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
} as const;
export type ConnectedVoiceProvider = 'elevenlabs' | 'openrouter' | 'openai';
export interface LocalVoiceStatus {
  state: 'not_downloaded' | 'downloading' | 'ready' | 'failed';
  progress?: number;
}

export function voiceProvider(voice: SpeechVoice | string): NonNullable<SpeechVoice['source']> {
  if (typeof voice !== 'string') return voice.source ?? voiceProvider(voice.id);
  return voice.startsWith('local:')
    ? 'local'
    : voice.startsWith('openai:')
      ? 'openai'
      : voice.startsWith('elevenlabs-direct:')
        ? 'elevenlabs'
        : 'openrouter';
}

function sourceLabel(voice: SpeechVoice) {
  return voiceProvider(voice) === 'openrouter'
    ? `${voice.engine} · OpenRouter`
    : voiceProviderNames[voiceProvider(voice)];
}

export function VoiceSample({
  voice,
  loading,
  playing,
  disabled,
  menu = false,
  onPlay,
}: {
  voice?: SpeechVoice;
  loading: boolean;
  playing: boolean;
  disabled?: boolean;
  menu?: boolean;
  onPlay(): void;
}) {
  const label = voice
    ? `${loading || playing ? 'Stop' : 'Play'} ${voice.name} sample, ${voice.description}`
    : 'Preview voice';
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="voice-sample"
      role={menu ? 'menuitem' : undefined}
      aria-label={label}
      title={label}
      aria-pressed={loading || playing}
      disabled={disabled}
      onClick={onPlay}
    >
      {loading ? (
        <LoaderCircle size={16} className="voice-preview-loading" />
      ) : playing ? (
        <Square size={14} solid />
      ) : (
        <Play size={16} solid />
      )}
    </Button>
  );
}

export function VoicePicker({
  voices,
  value,
  defaultVoice,
  open,
  disabled,
  labelledBy,
  loading,
  playing,
  error,
  local,
  preparing,
  preparationError,
  refreshing,
  providers,
  onOpenChange,
  onChange,
  onPreview,
  onStop,
  onPrepare,
  onCancelPreparation,
  onConnect,
  onRefresh,
}: {
  voices: readonly SpeechVoice[];
  value: string | null;
  defaultVoice?: string;
  open: boolean;
  disabled: boolean;
  labelledBy: string;
  loading: string | null;
  playing: string | null;
  error: string;
  local?: LocalVoiceStatus;
  preparing: boolean;
  preparationError: string;
  refreshing: boolean;
  providers: { id: ConnectedVoiceProvider; action: string }[];
  onOpenChange(open: boolean): void;
  onChange(value: string | null): void;
  onPreview(voice: string): void;
  onStop(): void;
  onPrepare(): void;
  onCancelPreparation(): void;
  onConnect(provider: ConnectedVoiceProvider): void;
  onRefresh(): void;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const tabTarget = useRef<HTMLElement | null>(null);
  const handoff = useRef(false);
  const returnFocus = useRef(true);
  const selected = voices.find((voice) => voice.id === (value ?? defaultVoice));
  const words = query.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim().split(/\s+/);
  const matchesText = (text: string) =>
    words.every((word) =>
      text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().includes(word),
    );
  const matches = voices.filter((voice) =>
    matchesText(
      `${voice.name} ${voice.description} ${voice.language ?? 'Multilingual'} ${voice.engine} ${sourceLabel(voice)}`,
    ),
  );
  const groups = [...new Set(matches.map(voiceProvider))];
  const showAutomatic =
    voices.length > 0 && matchesText('Automatic matches the conversation language');
  const showLocal = local?.state !== 'ready' && matchesText('Free voices on this device local');
  const more = providers.filter((provider) => matchesText(voiceProviderNames[provider.id]));
  const downloading = preparing || local?.state === 'downloading';
  const progress = Math.max(0, Math.min(100, local?.progress ?? 0));
  const initializing = downloading && progress >= 100;
  function changeOpen(next: boolean) {
    if (next && disabled) return;
    if (next) {
      setQuery('');
      handoff.current = false;
      returnFocus.current = true;
      tabTarget.current = null;
    }
    onOpenChange(next);
  }
  useEffect(() => {
    if (!open) return;
    const blur = () => {
      returnFocus.current = false;
      onOpenChange(false);
    };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [open, onOpenChange]);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          className="voice-picker-trigger"
          aria-disabled={disabled}
          aria-haspopup="menu"
          aria-labelledby={`${labelledBy} ${id}-value`}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (disabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
              return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          <span id={`${id}-value`}>
            {value === null
              ? voices.length
                ? 'Automatic'
                : 'Choose voice'
              : (selected?.name ?? 'Unavailable voice')}
          </span>
          <ChevronDown size={12} />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          asChild
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            handoff.current = false;
            returnFocus.current = true;
            tabTarget.current = null;
            setQuery('');
            search.current?.focus({ preventScroll: true });
          }}
          onInteractOutside={() => {
            returnFocus.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!returnFocus.current || handoff.current) return;
            (tabTarget.current ?? trigger.current)?.focus({ preventScroll: true });
          }}
        >
          <ActionMenuSurface
            ref={menu}
            className="voice-choice-menu"
            aria-label="Choose voice"
            onKeyDownCapture={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
                return;
              if (event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
                tabTarget.current = actionMenuTabTarget(
                  trigger.current,
                  event.shiftKey,
                  menu.current,
                );
                changeOpen(false);
              }
              if (event.target === search.current && event.key === 'ArrowDown') {
                event.preventDefault();
                focusActionMenuItem(
                  menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)'),
                );
              }
            }}
          >
            <SearchField
              inputRef={search}
              aria-label="Search voices"
              placeholder="Search voices or languages"
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                onStop();
                setQuery(event.target.value);
              }}
              onClear={() => {
                onStop();
                setQuery('');
                search.current?.focus();
              }}
              clearLabel="Clear voice search"
            />
            {showAutomatic && (
              <ActionMenuItem
                className="voice-choice"
                checked={value === null}
                aria-disabled={disabled || undefined}
                onClick={() => onChange(null)}
              >
                <span className="voice-picker-label">
                  <span>Automatic</span>
                  <small>Matches the conversation language</small>
                </span>
                {value === null && <Check size={16} />}
              </ActionMenuItem>
            )}
            {groups.map((group) => (
              <div
                className="voice-choice-group"
                key={group}
                role="group"
                aria-label={voiceProviderNames[group]}
              >
                <div className="voice-choice-heading">
                  {group !== 'local' && <ModelProviderLogo provider={group} />}
                  <span>{voiceProviderNames[group]}</span>
                </div>
                {matches
                  .filter((voice) => voiceProvider(voice) === group)
                  .map((voice) => (
                    <div
                      className="voice-picker-option"
                      key={voice.id}
                      data-selected={voice.id === value}
                    >
                      <ActionMenuItem
                        className="voice-choice"
                        textValue={voice.name}
                        aria-label={`Choose ${voice.name}, ${voice.description}, ${sourceLabel(voice)}`}
                        checked={voice.id === value}
                        aria-disabled={disabled || undefined}
                        onClick={() => onChange(voice.id)}
                      >
                        <span className="voice-picker-label">
                          <span>{voice.name}</span>
                          <small>{voice.description}</small>
                        </span>
                        {voice.id === value && <Check size={16} />}
                      </ActionMenuItem>
                      <VoiceSample
                        voice={voice}
                        menu
                        loading={loading === voice.id}
                        playing={playing === voice.id}
                        disabled={disabled}
                        onPlay={() => onPreview(voice.id)}
                      />
                    </div>
                  ))}
              </div>
            ))}
            {showLocal && (
              <div
                className="voice-download-panel"
                data-state={initializing ? 'preparing' : local?.state}
              >
                <div className="voice-download-row">
                  <span className="voice-picker-label">
                    <span>Free voices</span>
                    <small>
                      {!local
                        ? 'Unavailable on this server'
                        : initializing
                          ? 'Preparing voices…'
                          : downloading
                            ? `Downloading · ${Math.round(progress)}%`
                            : local.state === 'failed' || preparationError
                              ? 'Download interrupted'
                              : '180 MB download'}
                    </small>
                  </span>
                  {local && (!downloading || preparing) && (
                    <ActionMenuItem
                      className="voice-download-action"
                      disabled={disabled}
                      aria-label={
                        downloading
                          ? 'Cancel voice download'
                          : local.state === 'failed' || preparationError
                            ? 'Retry voice download'
                            : 'Download free voices'
                      }
                      onClick={downloading ? onCancelPreparation : onPrepare}
                    >
                      {!downloading && <Download size={14} />}
                      {downloading
                        ? 'Cancel'
                        : local.state === 'failed' || preparationError
                          ? 'Retry'
                          : 'Download'}
                    </ActionMenuItem>
                  )}
                </div>
                <div
                  className="voice-download-progress"
                  data-active={downloading}
                  role={downloading ? 'progressbar' : undefined}
                  aria-label={downloading ? 'Voice download' : undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={downloading ? progress : undefined}
                  aria-valuetext={initializing ? 'Downloaded. Preparing voices.' : undefined}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                {preparationError && (
                  <p className="voice-picker-error" role="alert">
                    {preparationError}
                  </p>
                )}
              </div>
            )}
            {more.length > 0 && (
              <div className="voice-choice-group" role="group" aria-label="Voice connections">
                <div className="voice-choice-heading">
                  {groups.some((group) => group !== 'local') ? 'Connections' : 'More voices'}
                </div>
                {more.map((provider) => (
                  <ActionMenuItem
                    key={provider.id}
                    className="voice-provider-option"
                    disabled={disabled}
                    onClick={() => {
                      handoff.current = true;
                      changeOpen(false);
                      onConnect(provider.id);
                    }}
                  >
                    <ModelProviderLogo provider={provider.id} />
                    <span>{voiceProviderNames[provider.id]}</span>
                    <small>{provider.action}</small>
                  </ActionMenuItem>
                ))}
              </div>
            )}
            {!matches.length && !showAutomatic && !showLocal && !more.length && (
              <p className="voice-picker-empty" role="status">
                No voices found. Try another name or language.
              </p>
            )}
            <ActionMenuItem
              className="voice-refresh-option"
              disabled={refreshing || disabled}
              onClick={onRefresh}
            >
              <RefreshCw size={14} className={refreshing ? 'voice-preview-loading' : undefined} />
              {refreshing ? 'Refreshing voices…' : 'Refresh voices'}
            </ActionMenuItem>
            {error && (
              <p className="voice-picker-error" role="alert">
                {error}
              </p>
            )}
          </ActionMenuSurface>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
