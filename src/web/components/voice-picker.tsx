import { useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { SpeechVoice } from '../../shared/speech';
import { Check, ChevronDown, LoaderCircle, Play, Square, X } from './icons';
import { Button, Notice, SearchField } from './ui';

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
  const label = `${loading || playing ? 'Stop' : 'Play'} ${voice.name} sample, ${voice.description}, ${voice.engine}`;
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
  onOpenChange(open: boolean): void;
  onChange(value: string | null): void;
  onPreview(voice: string): void;
  onStop(): void;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const selected = voices.find((voice) => voice.id === (value ?? defaultVoice));
  const fallback = voices.find((voice) => voice.id === defaultVoice);
  const words = query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  const matches = voices.filter((voice) =>
    words.every((word) =>
      `${voice.name} ${voice.description} ${voice.language ?? 'Multilingual'} ${voice.engine}`
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .includes(word),
    ),
  );
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return;
        if (next) setQuery('');
        onOpenChange(next);
      }}
      modal
    >
      <Popover.Trigger
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
            {selected?.name ?? (value ? 'Choose another voice' : 'Choose a voice')}
          </span>
          {selected && (
            <small id={`${id}-detail`}>
              {selected.language ? selected.description : 'Multilingual'} · {selected.engine}
            </small>
          )}
        </span>
        <ChevronDown size={16} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="voice-picker-panel menu"
          aria-label="Choose a voice"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            search.current?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
              return;
            const target = event.target as HTMLElement;
            const input = target.tagName === 'INPUT';
            if (input && event.key !== 'ArrowDown') return;
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
            <span>Choose a voice</span>
            <Popover.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close voice picker">
                <X size={16} />
              </Button>
            </Popover.Close>
          </div>
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
          <div className="voice-picker-options">
            {[...new Set(matches.map((voice) => voice.engine))].map((engine) => (
              <div
                key={engine}
                role="group"
                aria-label={engine === 'Local' ? 'Local voices' : engine}
              >
                <p className="voice-picker-group">{engine === 'Local' ? 'Local voices' : engine}</p>
                {matches
                  .filter((voice) => voice.engine === engine)
                  .map((voice) => (
                    <div
                      className="voice-picker-option"
                      key={voice.id}
                      data-selected={voice.id === (value ?? defaultVoice)}
                    >
                      <button
                        type="button"
                        className="voice-choice"
                        aria-label={`Choose ${voice.name}, ${voice.description}, ${engine}`}
                        aria-pressed={voice.id === (value ?? defaultVoice)}
                        onClick={() => onChange(voice.id)}
                      >
                        <span className="voice-picker-label">
                          <span>{voice.name}</span>
                          <small>{voice.description}</small>
                        </span>
                        {voice.id === (value ?? defaultVoice) && <Check size={16} />}
                      </button>
                      <VoiceSample
                        voice={voice}
                        loading={loading === voice.id}
                        playing={playing === voice.id}
                        onPlay={() => onPreview(voice.id)}
                      />
                    </div>
                  ))}
              </div>
            ))}
            {!matches.length && (
              <p className="voice-picker-empty" role="status">
                No voices found. Try another name or language.
              </p>
            )}
          </div>
          {value !== null && !query.trim() && fallback && (
            <button
              type="button"
              className="voice-choice voice-default"
              aria-label={`Use default voice, ${fallback.name}`}
              onClick={() => onChange(null)}
            >
              <span className="voice-picker-label">
                <span>Use default voice</span>
                <small>{fallback.name}</small>
              </span>
            </button>
          )}
          {(playing ?? loading)?.startsWith('openai:') && (
            <p className="voice-picker-disclosure">OpenAI voices are generated by AI.</p>
          )}
          {error && <Notice>{error}</Notice>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
