import { useEffect, useRef, useState } from 'react';
import type { useVoiceRecorder } from '../hooks/use-voice-recorder';
import { LoaderCircle, Mic, Pause, Play, RotateCcw, Square, Trash2, X } from './icons';
import { Button } from './ui';

function recordingTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingPreview({
  recording,
  sending,
}: {
  recording: NonNullable<ReturnType<typeof useVoiceRecorder>['recording']>;
  sending: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(recording.duration / 1000);
  const progress = duration ? Math.min(100, (current / duration) * 100) : 0;
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
      <div className="recording-preview-position">
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.05}
          value={Math.min(current, duration)}
          disabled={sending || !duration || failed}
          aria-label="Seek recording"
          aria-valuetext={`${recordingTime(current * 1000)} of ${recordingTime(Math.ceil(duration) * 1000)}`}
          style={{
            backgroundImage: `linear-gradient(to right, var(--accent) ${progress}%, var(--border) ${progress}%)`,
          }}
          onChange={(event) => {
            if (!audio.current) return;
            audio.current.currentTime = Number(event.target.value);
            setCurrent(audio.current.currentTime);
          }}
        />
        <span className="recording-preview-time">
          {recordingTime(current * 1000)} / {recordingTime(Math.ceil(duration) * 1000)}
        </span>
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
  const stopButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const { phase, recording, elapsed, level } = recorder;
  const preview = phase === 'preview' && recording;
  useEffect(() => {
    if (phase === 'requesting') discardButton.current?.focus();
    else if (phase === 'recording') stopButton.current?.focus();
  }, [phase]);
  if (phase === 'idle') return null;
  return (
    <section
      className="voice-recorder"
      aria-label="Audio message"
      data-analytics-private
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !sending) {
          event.preventDefault();
          onDiscard();
        }
      }}
    >
      <div className="voice-recorder-header">
        <div className="voice-recorder-status" role="status">
          {phase === 'requesting' || phase === 'finishing' || sending ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Mic size={16} />
          )}
          <span>
            {phase === 'requesting'
              ? 'Waiting for your microphone…'
              : phase === 'finishing'
                ? 'Preparing audio…'
                : sending
                  ? 'Sending audio…'
                  : preview
                    ? 'Ready to send'
                    : 'Recording'}
          </span>
        </div>
        <div className="voice-recorder-actions">
          {preview ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void recorder.start()}
              disabled={sending}
            >
              <RotateCcw size={14} />
              Record again
            </Button>
          ) : phase === 'recording' ? (
            <Button
              ref={stopButton}
              type="button"
              variant="outline"
              size="sm"
              onClick={recorder.stop}
            >
              <Square size={12} solid />
              Stop recording
            </Button>
          ) : null}
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
        </div>
      </div>
      {preview ? (
        <RecordingPreview key={recording.url} recording={recording} sending={sending} />
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
            {Array.from({ length: 16 }, (_, index) => (
              <span key={index} data-active={level > index / 16 || undefined} />
            ))}
          </div>
          <span className="voice-recorder-limit">5 min max</span>
        </div>
      ) : null}
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
          <span>{ready ? 'Audio is ready' : preparing ? 'Preparing audio…' : 'Local audio'}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel audio setup"
          onClick={onCancel}
        >
          <X size={16} />
        </Button>
      </div>
      {preparing && !ready ? (
        <>
          <div className="voice-setup-progress">
            <progress aria-label="Downloading speech models" max={100} value={percent} />
            {percent !== undefined && <span>{percent}%</span>}
          </div>
          <p>You can keep typing while this downloads.</p>
        </>
      ) : (
        <>
          <p>
            {ready
              ? 'Your microphone will only turn on when you start recording.'
              : failed
                ? 'Audio setup did not finish. Try again when you are connected.'
                : 'Downloads speech models once to the computer running nod.'}
          </p>
          <Button type="button" size="sm" onClick={ready ? onRecord : onPrepare}>
            {ready ? 'Record audio' : failed ? 'Try again' : 'Enable local audio'}
          </Button>
        </>
      )}
    </section>
  );
}
