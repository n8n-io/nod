import { Tooltip } from './tooltip';
import { useEffect, useId, useRef, useState } from 'react';
import { Download, LoaderCircle, Pause, Play, RotateCcw } from './icons';
import { loadAudioWaveform } from '../lib/audio-waveform';
import { localPreviewUrl, ownedArtifactUrl } from '../lib/attachment-url';
import type { ImagePreview } from './attachment-images';
import { Button } from './ui';

function audioTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

type AudioPlayerProps = {
  item: ImagePreview;
  selected?: boolean;
  onDuration?(duration: number): void;
};

export function AudioPlayer(props: AudioPlayerProps) {
  if (!ownedArtifactUrl(props.item.url) && !localPreviewUrl(props.item.url)) return null;
  return <Player key={props.item.url} {...props} />;
}

function Player({ item, selected = false, onDuration }: AudioPlayerProps) {
  const container = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const frame = useRef(0);
  const clip = useId();
  const [visible, setVisible] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState(1);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '100px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || failed) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void loadAudioWaveform(item.url, item.size, 0, signal)
      .then((value) => {
        if (signal.aborted) return;
        setPeaks(value.peaks);
        setDuration(value.duration);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [visible, item.url, item.size, failed]);
  useEffect(() => {
    if (duration > 0) onDuration?.(duration);
  }, [duration, onDuration]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      cancelAnimationFrame(frame.current);
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, []);
  const follow = () => {
    const element = audio.current;
    if (!element) return;
    setCurrent(element.currentTime);
    if (!element.paused) frame.current = requestAnimationFrame(follow);
  };
  const stopFollowing = () => {
    cancelAnimationFrame(frame.current);
    setPlaying(false);
    setWaiting(false);
  };
  const seek = (value: number) => {
    const element = audio.current;
    if (!element || !duration) return;
    element.currentTime = Math.max(0, Math.min(duration, value));
    setCurrent(element.currentTime);
  };
  const progress = duration ? Math.min(1, current / duration) : 0;
  const bars = peaks ? (
    peaks.map((peak, index) => (
      <rect key={index} x={index * 5} y={24 - peak * 16} width="3" height={peak * 32} rx="1.5" />
    ))
  ) : (
    <rect y="22.5" width="320" height="3" rx="1.5" />
  );
  return (
    <div
      className="audio-player"
      ref={container}
      role="group"
      aria-label={item.name}
      aria-current={selected || undefined}
    >
      <audio
        ref={audio}
        src={visible ? item.url : undefined}
        preload="metadata"
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          const seconds = Number.isFinite(value) && value > 0 ? value : 0;
          if (seconds > 0) {
            setDuration(seconds);
          }
        }}
        onPlay={(event) => {
          document.querySelectorAll('audio').forEach((other) => {
            if (other !== event.currentTarget) other.pause();
          });
          cancelAnimationFrame(frame.current);
          setPlaying(true);
          follow();
        }}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onPause={stopFollowing}
        onEnded={stopFollowing}
        onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onError={() => {
          stopFollowing();
          setFailed(true);
        }}
      />
      <button
        type="button"
        className="audio-player-play"
        disabled={!visible}
        aria-label={failed ? 'Retry audio' : playing ? 'Pause audio' : 'Play audio'}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (failed) {
            setFailed(false);
            setCurrent(0);
            setDuration(0);
            setPeaks(null);
            element.load();
            element.playbackRate = rate;
          }
          if (element.paused)
            void element.play().catch(() => {
              if (element.error) setFailed(true);
            });
          else element.pause();
        }}
      >
        {failed ? (
          <RotateCcw size={20} aria-hidden="true" />
        ) : waiting && playing ? (
          <LoaderCircle size={20} className="audio-player-loading" aria-hidden="true" />
        ) : playing ? (
          <Pause size={20} fill="currentColor" aria-hidden="true" />
        ) : (
          <Play size={20} solid aria-hidden="true" />
        )}
      </button>
      <div className="audio-player-track" data-waveform-ready={Boolean(peaks)}>
        <svg viewBox="0 0 320 48" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect width={320 * progress} height="48" />
            </clipPath>
          </defs>
          <g className="audio-player-bars">{bars}</g>
          <g className="audio-player-progress" clipPath={`url(#${clip})`}>
            {bars}
          </g>
        </svg>
        <span className="audio-player-position" style={{ left: `${progress * 100}%` }} />
        <input
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={Math.min(current, duration)}
          disabled={!duration || failed}
          aria-label="Seek audio"
          aria-valuetext={`${audioTime(current)} of ${audioTime(duration)}`}
          onChange={(event) => seek(Number(event.target.value))}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            seek(current + (event.key === 'ArrowLeft' ? -5 : 5));
          }}
        />
      </div>
      <div className="audio-player-info">
        <span
          className="audio-player-time"
          aria-label={`${audioTime(current)} of ${audioTime(duration)}`}
        >
          <span className="audio-player-current">{audioTime(current)}</span>
          <span className="audio-player-separator"> / </span>
          <span className="audio-player-total">{duration ? audioTime(duration) : '–:––'}</span>
        </span>
        <Tooltip content="Change playback speed">
          <button
            type="button"
            className="audio-player-rate"
            disabled={failed}
            aria-label={`Playback speed ${rate}×. Change speed`}
            onClick={() => {
              const speeds = [1, 1.25, 1.5, 2, 0.75];
              if (audio.current)
                audio.current.playbackRate = speeds[(speeds.indexOf(rate) + 1) % speeds.length];
            }}
          >
            {rate}×
          </button>
        </Tooltip>
        <Button variant="ghost" size="icon" className="audio-player-download" asChild>
          <a href={item.url} download={item.name} aria-label={`Download ${item.name}`}>
            <Download size={16} aria-hidden="true" />
          </a>
        </Button>
      </div>
      {failed && (
        <p className="audio-player-error" role="status">
          Audio unavailable. Retry or download the file.
        </p>
      )}
    </div>
  );
}
