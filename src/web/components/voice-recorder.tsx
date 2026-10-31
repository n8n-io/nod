import { Tooltip } from './tooltip';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { useVoiceRecorder } from '../hooks/use-voice-recorder';
import { Check, LoaderCircle, Mic, Pause, Play, Trash2, X } from './icons';
import { Button } from './ui';
import {
  ActionMenuItem,
  actionMenuTabTarget,
  focusActionMenuItem,
  useActionMenuNavigation,
  useActionMenuViewport,
} from './action-menu';

export function MicrophonePicker({
  recorder,
  disabled,
  triggerDisabled,
  hint,
  shortcut,
  children,
  setup,
  setupOpen = false,
  onSetupOpenChange,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  disabled: boolean;
  triggerDisabled: boolean;
  hint: string;
  shortcut?: string;
  children: ReactNode;
  setup?: ReactNode;
  setupOpen?: boolean;
  onSetupOpenChange?(open: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const navigateMenu = useActionMenuNavigation(open && !setupOpen);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const observePanel = useActionMenuViewport(panel);
  const restoreAnchorFocus = useRef(true);
  const tabTarget = useRef<HTMLElement | null>(null);
  const awaitSelected = useRef(false);
  const currentlyDisabled = useRef(disabled);
  currentlyDisabled.current = disabled;
  const selected = recorder.microphones.find((device) => device.deviceId === recorder.microphoneId);
  const microphoneAccess = recorder.microphoneAccess;
  const choices = microphoneAccess
    ? [
        { id: '', label: 'System default' },
        ...recorder.microphones.map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Microphone ${index + 1}`,
        })),
      ]
    : [];
  function changeOpen(value: boolean) {
    awaitSelected.current = value;
    if (value) tabTarget.current = null;
    setOpen(value);
    if (value) void recorder.refreshMicrophones();
    else recorder.cancelMicrophoneDiscovery();
  }
  useEffect(() => {
    if (disabled) changeOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (setupOpen) changeOpen(false);
  }, [setupOpen]);
  useEffect(() => {
    if (!triggerDisabled && document.activeElement === anchor.current)
      anchor.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [triggerDisabled]);
  useEffect(() => {
    if (
      !open ||
      setupOpen ||
      !awaitSelected.current ||
      !microphoneAccess ||
      (recorder.microphoneId && !selected)
    )
      return;
    if (
      !panel.current ||
      (!panel.current.contains(document.activeElement) && document.activeElement !== document.body)
    )
      return;
    awaitSelected.current = false;
    focusActionMenuItem(panel.current.querySelector<HTMLElement>('[aria-checked="true"]'));
  }, [open, setupOpen, recorder.microphoneId, selected?.deviceId, microphoneAccess]);
  useEffect(() => () => recorder.cancelMicrophoneDiscovery(), []);
  return (
    <Popover.Root
      open={open || setupOpen}
      onOpenChange={(value) => {
        if (setupOpen) onSetupOpenChange?.(value);
        else changeOpen(value);
      }}
    >
      <Tooltip content={hint} shortcut={shortcut}>
        <Popover.Anchor asChild>
          <span
            ref={anchor}
            className="composer-microphone tooltip-disabled-trigger"
            tabIndex={triggerDisabled ? 0 : undefined}
            aria-label={triggerDisabled ? hint : undefined}
            onContextMenu={(event) => {
              if (disabled) return;
              event.preventDefault();
              onSetupOpenChange?.(false);
              changeOpen(true);
            }}
            onKeyDown={(event) => {
              if (
                !disabled &&
                (event.key === 'ContextMenu' ||
                  (event.shiftKey && event.key === 'F10') ||
                  (event.altKey && event.key === 'ArrowDown'))
              ) {
                event.preventDefault();
                onSetupOpenChange?.(false);
                changeOpen(true);
              }
            }}
          >
            {children}
          </span>
        </Popover.Anchor>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          ref={observePanel}
          className={setupOpen ? 'microphone-setup' : 'microphone-picker menu action-menu-surface'}
          data-analytics-private
          role={setupOpen ? 'dialog' : 'menu'}
          aria-label={setupOpen ? 'Audio messages' : 'Microphone'}
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = tabTarget.current;
            tabTarget.current = null;
            if (!restoreAnchorFocus.current) return;
            if (target?.isConnected) target.focus({ preventScroll: true });
            else if (!currentlyDisabled.current) anchor.current?.querySelector('button')?.focus();
          }}
          onInteractOutside={() => {
            restoreAnchorFocus.current = false;
            tabTarget.current = null;
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            restoreAnchorFocus.current = true;
            tabTarget.current = null;
            focusActionMenuItem(
              panel.current?.querySelector<HTMLButtonElement>(
                setupOpen
                  ? 'button'
                  : '[aria-checked="true"], [aria-label="Allow microphone access"]',
              ),
            );
            if (setupOpen || (microphoneAccess && (!recorder.microphoneId || selected)))
              awaitSelected.current = false;
          }}
          onKeyDownCapture={(event) => {
            if (setupOpen) return;
            awaitSelected.current = false;
            if (
              event.key !== 'Tab' ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.nativeEvent.isComposing
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            tabTarget.current = actionMenuTabTarget(
              anchor.current?.querySelector('button'),
              event.shiftKey,
              panel.current,
            );
            changeOpen(false);
          }}
          onKeyDown={navigateMenu}
          onPointerDownCapture={() => {
            awaitSelected.current = false;
          }}
          onWheelCapture={() => {
            awaitSelected.current = false;
          }}
        >
          {setupOpen ? (
            setup
          ) : (
            <>
              <p className="microphone-picker-heading">Microphone</p>
              {choices.map((choice) => (
                <ActionMenuItem
                  key={choice.id}
                  aria-label={choice.label}
                  checked={choice.id === (selected?.deviceId ?? '')}
                  onClick={() => {
                    recorder.selectMicrophone(choice.id);
                    changeOpen(false);
                  }}
                >
                  <span>{choice.label}</span>
                  {choice.id === (selected?.deviceId ?? '') && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </ActionMenuItem>
              ))}
              {!microphoneAccess && (
                <ActionMenuItem
                  aria-label="Allow microphone access"
                  aria-disabled={recorder.discovering}
                  onClick={() => {
                    awaitSelected.current = true;
                    void recorder.discoverMicrophones();
                  }}
                >
                  {recorder.discovering ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Mic size={14} />
                  )}
                  {recorder.discovering ? 'Waiting for permission…' : 'Allow microphone access'}
                </ActionMenuItem>
              )}
              {recorder.microphoneFailure && <p role="alert">{recorder.microphoneFailure}</p>}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function recordingTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingWaveform({ levels, progress = 1 }: { levels: number[]; progress?: number }) {
  const clip = useId();
  const bars = Array.from({ length: 64 }, (_, index) => {
    const start = Math.floor((index * levels.length) / 64);
    const end = Math.max(start + 1, Math.floor(((index + 1) * levels.length) / 64));
    const peak = Math.max(0.12, Math.sqrt(Math.min(1, Math.max(0, ...levels.slice(start, end)))));
    return (
      <rect key={index} x={index * 5} y={16 - peak * 14} width="3" height={peak * 28} rx="1.5" />
    );
  });
  return (
    <svg viewBox="0 0 320 32" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <rect width={320 * progress} height="32" />
        </clipPath>
      </defs>
      <g className="recording-waveform-base">{bars}</g>
      <g className="recording-waveform-progress" clipPath={`url(#${clip})`}>
        {bars}
      </g>
    </svg>
  );
}

function RecordingPreview({
  recording,
  sending,
  levels,
}: {
  recording: NonNullable<ReturnType<typeof useVoiceRecorder>['recording']>;
  sending: boolean;
  levels: number[];
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(recording.duration / 1000);
  const progress = duration ? Math.min(1, current / duration) : 0;
  useEffect(() => {
    const element = audio.current;
    if (element) element.src = recording.url;
    playButton.current?.focus();
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, []);
  useEffect(() => {
    if (sending) audio.current?.pause();
  }, [sending]);
  function pause() {
    setPlaying(false);
    setWaiting(false);
  }
  return (
    <div className="recording-preview" role="group" aria-label="Preview recording">
      <audio
        ref={audio}
        src={recording.url}
        preload="metadata"
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onPlay={(event) => {
          document.querySelectorAll('audio').forEach((other) => {
            if (other !== event.currentTarget) other.pause();
          });
          setPlaying(true);
        }}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onPause={pause}
        onEnded={() => {
          pause();
          setCurrent(Math.ceil(duration));
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onError={() => {
          pause();
          setFailed(true);
        }}
      />
      <button
        ref={playButton}
        type="button"
        className="audio-player-play"
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        disabled={sending}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (!element.paused) {
            element.pause();
            return;
          }
          setFailed(false);
          setWaiting(true);
          if (element.error) element.load();
          if (element.ended || element.currentTime >= duration) element.currentTime = 0;
          void element.play().catch(() => {
            if (audio.current !== element) return;
            pause();
            setFailed(true);
          });
        }}
      >
        {waiting ? (
          <LoaderCircle size={20} className="spin" />
        ) : playing ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} solid />
        )}
      </button>
      <Tooltip
        content={`${recordingTime(current * 1000)} / ${recordingTime(Math.ceil(duration) * 1000)}`}
      >
        <span
          className="recording-preview-time"
          aria-label={`${recordingTime(current * 1000)} of ${recordingTime(Math.ceil(duration) * 1000)}`}
        >
          {recordingTime((current > 0 || playing ? current : Math.ceil(duration)) * 1000)}
        </span>
      </Tooltip>
      <div className="recording-preview-position">
        <RecordingWaveform levels={levels} progress={progress} />
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.05}
          value={Math.min(current, duration)}
          disabled={sending || !duration || failed}
          aria-label="Seek recording"
          aria-valuetext={`${recordingTime(current * 1000)} of ${recordingTime(Math.ceil(duration) * 1000)}`}
          onChange={(event) => {
            if (!audio.current) return;
            audio.current.currentTime = Number(event.target.value);
            setCurrent(audio.current.currentTime);
          }}
        />
      </div>
      {failed && <p role="alert">Preview unavailable. You can still send this recording.</p>}
    </div>
  );
}

export function VoiceRecorder({
  recorder,
  sending,
  preparing = false,
  progress,
  onCancel,
  onDiscard,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  sending: boolean;
  preparing?: boolean;
  progress?: number;
  onCancel?(): void;
  onDiscard(): void;
}) {
  const discardButton = useRef<HTMLButtonElement>(null);
  const sampledAt = useRef(-1);
  const [levels, setLevels] = useState<number[]>([]);
  const { phase, recording, elapsed, level } = recorder;
  const preview = phase === 'preview' && recording && !sending;
  useEffect(() => {
    if (phase === 'requesting') discardButton.current?.focus();
  }, [phase]);
  useEffect(() => {
    if (phase !== 'recording' || elapsed === sampledAt.current) return;
    const restart = elapsed < sampledAt.current;
    sampledAt.current = elapsed;
    setLevels((current) =>
      elapsed === 0 ? [] : [...(restart ? [] : current), level].slice(-3000),
    );
  }, [phase, elapsed, level]);
  if (phase === 'idle') return null;
  return (
    <section
      className="voice-recorder voice-recorder-inline"
      aria-label="Audio message"
      data-analytics-private
    >
      <div className="voice-recorder-bar">
        {preview ? (
          <RecordingPreview
            key={recording.url}
            recording={recording}
            sending={sending}
            levels={levels}
          />
        ) : phase === 'recording' ? (
          <div className="voice-recorder-input">
            <span className="voice-recorder-dot" aria-hidden="true" />
            <span className="voice-recorder-time" role="timer" aria-label="Recording duration">
              {recordingTime(elapsed)}
            </span>
            <div
              className="voice-recorder-level"
              role="meter"
              aria-label="Microphone input level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(level * 100)}
            >
              <RecordingWaveform levels={[...Array<number>(64).fill(0), ...levels].slice(-64)} />
            </div>
          </div>
        ) : (
          <div className="voice-recorder-status" role="status">
            <LoaderCircle size={16} className="spin" />
            <span>
              {phase === 'requesting'
                ? 'Waiting for microphone…'
                : preparing
                  ? `Preparing audio messages${progress === undefined ? '…' : ` · ${progress}%`}`
                  : sending
                    ? 'Sending…'
                    : 'Preparing audio…'}
            </span>
          </div>
        )}
        <div className="voice-recorder-actions">
          <Button
            ref={discardButton}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={
              preparing
                ? 'Cancel sending'
                : phase === 'requesting'
                  ? 'Cancel recording'
                  : 'Discard recording'
            }
            title={
              preparing
                ? 'Cancel sending'
                : phase === 'requesting'
                  ? 'Cancel recording'
                  : 'Discard recording'
            }
            onClick={preparing ? onCancel : onDiscard}
            disabled={sending && !preparing}
          >
            {preparing ? <X size={16} /> : <Trash2 size={16} />}
          </Button>
        </div>
      </div>
      {preview && recorder.notice && <p>{recorder.notice}</p>}
    </section>
  );
}

export function VoiceSetup({ error, onRetry }: { error: string; onRetry(): void }) {
  return (
    <div className="voice-setup">
      <p role="alert">{error}</p>
      <Button type="button" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
