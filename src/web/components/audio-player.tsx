import { useEffect, useId, useRef, useState } from 'react';
import { Download, LoaderCircle, Pause, Play } from './icons';
import { loadAudioWaveform } from '../lib/audio-waveform';
import { ownedArtifactUrl } from '../lib/attachment-url';
import type { ImagePreview } from './attachment-images';
import { Button } from './ui';

function audioTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function AudioPlayer({
  item,
  selected = false,
}: {
  item: ImagePreview;
  selected?: boolean;
}) {
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
    if (!visible || !duration) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void loadAudioWaveform(item.url, item.size, duration, signal)
      .then((values) => {
        if (!signal.aborted) setPeaks(values);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [visible, duration, item.url, item.size]);
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
  if (!ownedArtifactUrl(item.url)) return null;
  const progress = duration ? Math.min(1, current / duration) : 0;
  const bars = (peaks ?? Array<number>(64).fill(0.08)).map((peak, index) => (
    <rect key={index} x={index * 4} y={20 - peak * 18} width="2.5" height={peak * 36} rx="1.25" />
  ));
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
          setDuration(Number.isFinite(value) && value > 0 ? value : 0);
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
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onError={() => {
          stopFollowing();
          setFailed(true);
        }}
      />
      <button
        type="button"
        className="audio-player-play"
        disabled={!visible || failed}
        aria-label={playing ? 'Pause audio' : 'Play audio'}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused)
            void element.play().catch(() => {
              if (element.error) setFailed(true);
            });
          else element.pause();
        }}
      >
        {waiting ? (
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
        <input
          type="range"
          min="0"
          max={duration || 1}
          step="0.05"
          value={Math.min(current, duration)}
          disabled={!duration || failed}
          aria-label="Seek audio"
          aria-valuetext={`${audioTime(current)} of ${audioTime(duration)}`}
          onChange={(event) => {
            if (!audio.current) return;
            audio.current.currentTime = Number(event.target.value);
            setCurrent(audio.current.currentTime);
          }}
        />
      </div>
      <div className="audio-player-info">
        <span className="audio-player-time">
          {failed
            ? 'Audio unavailable'
            : `${audioTime(current)} / ${duration ? audioTime(duration) : '–:––'}`}
        </span>
        <button
          type="button"
          className="audio-player-rate"
          disabled={failed}
          aria-label={`Playback speed ${rate}. Change speed`}
          onClick={() => {
            const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
            if (audio.current) audio.current.playbackRate = next;
            setRate(next);
          }}
        >
          {rate}×
        </button>
        <Button variant="ghost" size="icon" asChild>
          <a href={item.url} download={item.name} aria-label={`Download ${item.name}`}>
            <Download size={15} aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
  );
}
