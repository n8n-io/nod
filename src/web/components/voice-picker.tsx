import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SpeechVoice } from '../../shared/speech';
import { ArrowLeft, Check, ChevronDown, LoaderCircle, Play, Plus, Square } from './icons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Notice,
  SearchField,
} from './ui';

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
  const label = `${loading || playing ? 'Stop' : 'Play'} ${voice.name} sample, ${voice.description}, ${sourceLabel(voice)}`;
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
  adding,
  setup,
  setupBusy,
  canAdd,
  onAddingChange,
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
  adding: boolean;
  setup: ReactNode;
  setupBusy: boolean;
  canAdd: boolean;
  onAddingChange(adding: boolean): void;
  onOpenChange(open: boolean): void;
  onChange(value: string | null): void;
  onPreview(voice: string): void;
  onStop(): void;
}) {
  const [query, setQuery] = useState('');
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (adding) setQuery('');
    if (open) (adding ? heading.current : search.current)?.focus();
  }, [adding, open]);
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
      `${voice.name} ${voice.description} ${voice.language ?? 'Multilingual'} ${voice.engine} ${sourceLabel(voice)}`
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .includes(word),
    ),
  );
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
            {selected?.name ?? (value ? 'Choose another voice' : 'Choose a voice')}
          </span>
          {selected && <small id={`${id}-detail`}>{selected.description}</small>}
        </span>
        <ChevronDown size={16} />
      </DialogTrigger>
      <DialogContent
        className="voice-picker-panel"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          if (!adding) {
            event.preventDefault();
            search.current?.focus({ preventScroll: true });
          }
        }}
        onKeyDown={(event) => {
          if (adding) return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing)
            return;
          const target = event.target as HTMLElement;
          const input = target.tagName === 'INPUT';
          if (input && event.key !== 'ArrowDown') return;
          if (!input && !target.closest('.voice-picker-options, .voice-default')) return;
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
          {adding && voices.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back to voices"
              disabled={setupBusy}
              onClick={() => onAddingChange(false)}
            >
              <ArrowLeft size={18} />
            </Button>
          )}
          <DialogTitle ref={heading} tabIndex={-1}>
            {adding ? 'Add voices' : 'Choose a voice'}
          </DialogTitle>
        </div>
        {adding ? (
          <div className="voice-picker-setup">{setup}</div>
        ) : (
          <>
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
              {[...new Set(matches.map(sourceLabel))].map((engine) => (
                <div key={engine} role="group" aria-label={engine}>
                  <p className="voice-picker-group">{engine}</p>
                  {matches
                    .filter((voice) => sourceLabel(voice) === engine)
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
            {canAdd && (
              <div className="voice-picker-footer">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onStop();
                    onAddingChange(true);
                  }}
                >
                  <Plus size={16} /> Add voices
                </Button>
              </div>
            )}
          </>
        )}
        {(playing ?? loading)?.startsWith('openai:') && (
          <p className="voice-picker-disclosure">OpenAI voices are generated by AI.</p>
        )}
        {error && <Notice>{error}</Notice>}
      </DialogContent>
    </Dialog>
  );
}
