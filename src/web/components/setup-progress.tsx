import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NodGlyph } from './motion';
import { desktopRuntimeAvailable } from '../lib/desktop';

function useUnchanged(value: number | undefined, milliseconds: number) {
  const [unchanged, setUnchanged] = useState<number>();
  useEffect(() => {
    setUnchanged(undefined);
    if (value === undefined) return;
    const timer = setTimeout(() => setUnchanged(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);
  return value !== undefined && unchanged === value;
}

function downloadLine(fraction: number, secondsLeft: number | undefined, waiting: boolean) {
  const percent = `${Math.floor(fraction * 100)}%`;
  if (waiting) return `${percent} · Waiting for the network…`;
  if (fraction >= 1 || secondsLeft === undefined || !Number.isFinite(secondsLeft)) return percent;
  if (secondsLeft < 45) return `${percent} · Less than a minute left`;
  const minutes = Math.round(secondsLeft / 60);
  const hours = Math.floor(minutes / 60);
  const left =
    hours > 0 ? `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
  return `${percent} · About ${left} left`;
}

export function SetupProgress({
  title,
  description,
  error,
  details,
  progress,
  secondsLeft,
  children,
  footer,
  local = desktopRuntimeAvailable(),
}: {
  title: string;
  description?: string;
  error?: string;
  details?: string;
  progress?: number;
  secondsLeft?: number;
  children?: ReactNode;
  footer?: ReactNode;
  local?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const fraction =
    typeof progress === 'number' && Number.isFinite(progress) && !error
      ? Math.max(0, Math.min(1, progress))
      : undefined;
  const waiting = useUnchanged(fraction, 5000) && fraction! < 1;
  const line = fraction === undefined ? undefined : downloadLine(fraction, secondsLeft, waiting);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <main className="setup-progress" ref={panel} tabIndex={-1} aria-label={title}>
      <div className="setup-progress-content">
        <NodGlyph
          size={112}
          mode={error ? 'still' : 'bounce'}
          progress={fraction}
          waiting={waiting}
          className="setup-progress-mark"
        />
        <div className="setup-progress-message">
          <div
            className="setup-progress-status"
            data-analytics-private
            role={error ? 'alert' : 'status'}
          >
            <h1>{title}</h1>
            {description && <p>{description}</p>}
            {error && <p data-analytics-private>{error}</p>}
          </div>
          {line && <p className="setup-progress-meta">{line}</p>}
        </div>
        {error && details && (
          <details className="setup-progress-details" open data-analytics-private>
            <summary>Technical details</summary>
            <pre>{details}</pre>
          </details>
        )}
        {fraction !== undefined && (
          <progress
            className="setup-progress-download"
            aria-label="Download progress"
            aria-valuetext={line}
            max={1}
            value={fraction}
          />
        )}
        {children && <div className="setup-progress-actions">{children}</div>}
      </div>
      <footer className="setup-progress-footer">
        <p className="setup-progress-note">
          Your workspace, browser and data stay on {local ? 'this computer' : 'your server'}. Your
          chosen AI providers process requests; browsing and connected apps contact external
          services.
        </p>
        {footer}
      </footer>
    </main>
  );
}
