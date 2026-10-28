import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { useVoiceRecorder } from '../hooks/use-voice-recorder';
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Square,
  Trash2,
  X,
} from './icons';
import { Button } from './ui';

export function MicrophonePicker({
  recorder,
  disabled,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const selected = recorder.microphones.find((device) => device.deviceId === recorder.microphoneId);
  const choices = [
    { id: '', label: 'System default' },
    ...recorder.microphones.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ];
  function changeOpen(value: boolean) {
    setOpen(value);
    if (value) void recorder.refreshMicrophones();
    else recorder.cancelMicrophoneDiscovery();
  }
  useEffect(() => {
    if (disabled) changeOpen(false);
  }, [disabled]);
  useEffect(() => () => recorder.cancelMicrophoneDiscovery(), []);
  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="microphone-picker-trigger"
          data-analytics-private
          aria-label="Choose microphone"
          title={selected?.label || 'Choose microphone'}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              changeOpen(true);
            }
          }}
        >
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={panel}
          className="microphone-picker menu"
          data-analytics-private
          role="menu"
          aria-label="Microphone"
          align="end"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
          }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <p className="microphone-picker-heading">Microphone</p>
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="menu-item"
              role="menuitemradio"
              aria-label={choice.label}
              aria-checked={choice.id === (selected?.deviceId ?? '')}
              onClick={() => {
                recorder.selectMicrophone(choice.id);
                changeOpen(false);
              }}
            >
              <span>{choice.label}</span>
              {choice.id === (selected?.deviceId ?? '') && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
          {!recorder.microphones.some((device) => device.label) && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              aria-label="Allow microphone access"
              aria-disabled={recorder.discovering}
              onClick={() => void recorder.discoverMicrophones()}
            >
              {recorder.discovering ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Mic size={14} />
              )}
              {recorder.discovering ? 'Waiting for permission…' : 'Allow microphone access'}
            </button>
          )}
          {recorder.microphoneFailure && <p role="alert">{recorder.microphoneFailure}</p>}
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
      <span
        className="recording-preview-time"
        aria-label={`${recordingTime(current * 1000)} of ${recordingTime(Math.ceil(duration) * 1000)}`}
        title={`${recordingTime(current * 1000)} / ${recordingTime(Math.ceil(duration) * 1000)}`}
      >
        {recordingTime((current > 0 || playing ? current : Math.ceil(duration)) * 1000)}
      </span>
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
  onDiscard,
}: {
  recorder: ReturnType<typeof useVoiceRecorder>;
  sending: boolean;
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
            aria-label={phase === 'requesting' ? 'Cancel recording' : 'Discard recording'}
            title={phase === 'requesting' ? 'Cancel recording' : 'Discard recording'}
            onClick={onDiscard}
            disabled={sending}
          >
            <Trash2 size={16} />
          </Button>
          {preview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="voice-recorder-preview"
              aria-label="Record again"
              title="Record again"
              onClick={() => void recorder.start()}
            >
              <RotateCcw size={18} />
            </Button>
          ) : phase === 'recording' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="voice-recorder-preview"
              aria-label="Stop and preview recording"
              title="Stop and preview recording"
              onClick={recorder.stop}
            >
              <Square size={16} />
            </Button>
          ) : null}
        </div>
      </div>
      {preview && recorder.notice && <p>{recorder.notice}</p>}
    </section>
  );
}

export function VoiceSetup({
  ready,
  preparing,
  progress,
  failed,
  onPrepare,
  onCancel,
  onRecord,
}: {
  ready: boolean;
  preparing: boolean;
  progress?: number;
  failed: boolean;
  onPrepare(): void;
  onCancel(): void;
  onRecord(): void;
}) {
  const percent =
    progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <section className="voice-recorder voice-setup" aria-label="Enable audio messages">
      <div className="voice-recorder-header">
        <div className="voice-recorder-status" role="status">
          {preparing && !ready ? <LoaderCircle size={16} className="spin" /> : <Mic size={16} />}
          <span>
            {ready ? 'Audio is ready' : preparing ? 'Preparing audio…' : 'Enable audio messages'}
          </span>
        </div>
        {(!preparing || ready) && (
          <Button type="button" size="sm" onClick={ready ? onRecord : onPrepare}>
            {ready ? 'Record audio' : failed ? 'Try again' : 'Set up audio'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close audio setup"
          onClick={onCancel}
        >
          <X size={16} />
        </Button>
      </div>
      {preparing && !ready ? (
        <div className="voice-setup-progress">
          <progress aria-label="Downloading speech models" max={100} value={percent} />
          {percent !== undefined && <span>{percent}%</span>}
        </div>
      ) : !ready ? (
        <p>
          {failed
            ? 'Audio setup did not finish. Check your connection and try again.'
            : 'Download speech models to enable audio messages.'}
        </p>
      ) : null}
    </section>
  );
}
