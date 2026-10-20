import { useEffect, useRef, type ReactNode } from 'react';
import { OttoGlyph } from './motion';

export function SetupProgress({
  title,
  description,
  error,
  progress,
  children,
}: {
  title: string;
  description?: string;
  error?: string;
  progress?: number;
  children?: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const percent =
    !error && typeof progress === 'number' && Number.isFinite(progress)
      ? Math.round(Math.max(0, Math.min(1, progress)) * 100)
      : undefined;

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <main className="setup-progress" ref={panel} tabIndex={-1} aria-label={title}>
      <div className="setup-progress-content">
        <OttoGlyph
          key={error ? 'error' : 'loading'}
          size={80}
          mode={error ? 'still' : 'thinking'}
        />
        <div
          className="setup-progress-message"
          data-analytics-private
          role={error ? 'alert' : 'status'}
        >
          <h1>{title}</h1>
          {description && <p>{description}</p>}
          {error && <p data-analytics-private>{error}</p>}
        </div>
        {percent !== undefined && (
          <div className="setup-progress-download">
            <progress aria-label="Download progress" max={100} value={percent} />
            <span aria-hidden="true">{percent}%</span>
          </div>
        )}
        {children && <div className="setup-progress-actions">{children}</div>}
      </div>
    </main>
  );
}
