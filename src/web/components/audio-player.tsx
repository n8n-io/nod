import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Download, LoaderCircle, Pause, Play, RotateCcw, RotateCw } from './icons';
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
    if (!visible || !duration || failed) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void loadAudioWaveform(item.url, item.size, duration, signal)
      .then((values) => {
        if (!signal.aborted) setPeaks(values);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [visible, duration, item.url, item.size, failed]);
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
      <rect key={index} x={index * 4} y={20 - peak * 18} width="2.5" height={peak * 36} rx="1.25" />
    ))
  ) : (
    <rect y="18.5" width="256" height="3" rx="1.5" />
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
          setDuration(seconds);
          onDuration?.(seconds);
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
      <div className="audio-player-heading">
        <span className="audio-player-name" title={item.name}>
          {item.name}
        </span>
        <Button variant="ghost" size="icon" asChild>
          <a href={item.url} download={item.name} aria-label={`Download ${item.name}`}>
            <Download size={16} aria-hidden="true" />
          </a>
        </Button>
      </div>
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
        <svg viewBox="0 0 256 40" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect width={256 * progress} height="40" />
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
        <span className="audio-player-time">
          {audioTime(current)} / {duration ? audioTime(duration) : '–:––'}
        </span>
        <button
          type="button"
          className="audio-player-skip"
          disabled={!duration || failed}
          aria-label="Back 10 seconds"
          title="Back 10 seconds"
          onClick={() => seek((audio.current?.currentTime ?? current) - 10)}
        >
          <RotateCcw size={16} aria-hidden="true" />
          <span aria-hidden="true">10</span>
        </button>
        <button
          type="button"
          className="audio-player-skip"
          disabled={!duration || failed}
          aria-label="Forward 10 seconds"
          title="Forward 10 seconds"
          onClick={() => seek((audio.current?.currentTime ?? current) + 10)}
        >
          <RotateCw size={16} aria-hidden="true" />
          <span aria-hidden="true">10</span>
        </button>
        <span className="audio-player-rate">
          <select
            aria-label="Playback speed"
            disabled={failed}
            value={rate}
            onChange={(event) => {
              if (audio.current) audio.current.playbackRate = Number(event.target.value);
            }}
          >
            {[0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      </div>
      {failed && (
        <p className="audio-player-error" role="status">
          Audio unavailable. Retry or download the file.
        </p>
      )}
    </div>
  );
}
