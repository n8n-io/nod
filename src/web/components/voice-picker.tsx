import { useId, useRef, useState } from 'react';
import type { SpeechVoice } from '../../shared/speech';
import { Check, ChevronDown, LoaderCircle, Play, Sparkles, Square } from './icons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Notice,
  SearchField,
} from './ui';

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
  if (voice.engine === 'Local') return 'Free voices';
  return voice.source === 'openrouter' || /^(elevenlabs|kokoro):/.test(voice.id)
    ? `${voice.engine} · OpenRouter`
    : voice.engine;
}

export function VoiceSample({
  voice,
  loading,
  playing,
  disabled,
  onPlay,
}: {
  voice: SpeechVoice;
  loading: boolean;
  playing: boolean;
  disabled?: boolean;
  onPlay(): void;
}) {
  const label = `${loading || playing ? 'Stop' : 'Play'} ${voice.name} sample, ${voice.description}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="voice-sample"
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
  providerName,
  onOpenChange,
  onChange,
  onPreview,
  onStop,
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
  providerName: string;
  onOpenChange(open: boolean): void;
  onChange(value: string | null): void;
  onPreview(voice: string): void;
  onStop(): void;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const selected = voices.find((voice) => voice.id === (value ?? defaultVoice));
  const languageNames = new Intl.DisplayNames([navigator.language], { type: 'language' });
  const language = (voice: SpeechVoice) =>
    voice.language
      ? (languageNames.of(voice.language.split('-')[0]) ?? voice.language)
      : 'Multilingual';
  const words = query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  const matches = voices
    .filter((voice) =>
      words.every((word) =>
        `${voice.name} ${voice.description} ${voice.language ?? 'Multilingual'} ${language(voice)} ${voice.engine} ${sourceLabel(voice)}`
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .includes(word),
      ),
    )
    .sort((a, b) => Number(b.id === selected?.id) - Number(a.id === selected?.id));
  const showAutomatic = words.every((word) =>
    'automatic matches the conversation language'.includes(word),
  );
  const groups = [...new Set(matches.map(language))];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return;
        if (next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogTrigger
        type="button"
        className="input select-trigger voice-picker-trigger"
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        aria-labelledby={`${labelledBy} ${id}-value`}
        aria-describedby={selected ? `${id}-detail` : undefined}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setQuery('');
            onOpenChange(true);
          }
        }}
      >
        <span className="voice-picker-label">
          <span id={`${id}-value`}>
            {value === null ? 'Automatic' : selected ? selected.name : 'Choose another voice'}
          </span>
          {selected && <small id={`${id}-detail`}>{selected.description}</small>}
        </span>
        <ChevronDown size={16} />
      </DialogTrigger>
      <DialogContent
        className="voice-picker-panel"
        aria-describedby={undefined}
        aria-busy={disabled}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const current = search.current
            ?.closest('[role="dialog"]')
            ?.querySelector<HTMLButtonElement>('.voice-choice[aria-pressed="true"]');
          (current ?? search.current)?.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
            return;
          const target = event.target as HTMLElement;
          const input = target.tagName === 'INPUT';
          if (input && event.key !== 'ArrowDown') return;
          if (!input && !target.closest('.voice-picker-options')) return;
          const column = target.closest('.voice-sample') ? '.voice-sample' : '.voice-choice';
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(column)];
          const index = buttons.indexOf(target.closest('button')!);
          const next =
            event.key === 'ArrowDown'
              ? (index + 1) % buttons.length
              : event.key === 'ArrowUp'
                ? (index - 1 + buttons.length) % buttons.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : -1;
          if (next >= 0) {
            event.preventDefault();
            buttons[next]?.focus();
          }
        }}
      >
        <div className="voice-picker-heading">
          <DialogTitle>
            {providerName === 'Free voices' ? providerName : `${providerName} voices`}
          </DialogTitle>
        </div>
        <SearchField
          inputRef={search}
          aria-label="Search voices"
          placeholder={
            voices.some((voice) => voice.language) ? 'Search voices or languages' : 'Search voices'
          }
          value={query}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
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
        <div className="voice-picker-options">
          {showAutomatic && (
            <div className="voice-picker-option" data-selected={value === null}>
              <span className="voice-automatic-icon" aria-hidden="true">
                <Sparkles size={18} />
              </span>
              <button
                type="button"
                className="voice-choice"
                aria-pressed={value === null}
                disabled={disabled}
                onClick={() => onChange(null)}
              >
                <span className="voice-picker-label">
                  <span>Automatic</span>
                  <small>Matches the conversation language</small>
                </span>
                {value === null && <Check size={16} aria-hidden="true" />}
              </button>
            </div>
          )}
          {groups.map((group) => (
            <div key={group} role="group" aria-label={group}>
              {groups.length > 1 && <h3 className="voice-picker-group">{group}</h3>}
              {matches
                .filter((voice) => language(voice) === group)
                .map((voice) => (
                  <div
                    className="voice-picker-option"
                    key={voice.id}
                    data-selected={voice.id === value}
                  >
                    <VoiceSample
                      voice={voice}
                      loading={loading === voice.id}
                      playing={playing === voice.id}
                      disabled={disabled}
                      onPlay={() => onPreview(voice.id)}
                    />
                    <button
                      type="button"
                      className="voice-choice"
                      aria-label={`Choose ${voice.name}, ${voice.description}, ${sourceLabel(voice)}`}
                      aria-pressed={voice.id === value}
                      title={`${voice.name}\n${voice.description}`}
                      disabled={disabled}
                      onClick={() => onChange(voice.id)}
                    >
                      <span className="voice-picker-label">
                        <span>{voice.name}</span>
                        {voice.description !== group && <small>{voice.description}</small>}
                      </span>
                      {voice.id === value && <Check size={16} />}
                    </button>
                  </div>
                ))}
            </div>
          ))}
          {!matches.length && !showAutomatic && (
            <p className="voice-picker-empty" role="status">
              No voices found. Try another name or language.
            </p>
          )}
        </div>
        {disabled && (
          <p className="voice-picker-saving" role="status">
            Saving voice…
          </p>
        )}
        {error && <Notice>{error}</Notice>}
      </DialogContent>
    </Dialog>
  );
}
