import { useEffect, useRef, type ReactNode } from 'react';
import { NodGlyph } from './motion';
import { desktopRuntimeAvailable } from '../lib/desktop';

export function SetupProgress({
  title,
  description,
  error,
  progress,
  children,
  local = desktopRuntimeAvailable(),
}: {
  title: string;
  description?: string;
  error?: string;
  progress?: number;
  children?: ReactNode;
  local?: boolean;
}) {
  const panel = useRef<HTMLElement>(null);
  const fraction =
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.max(0, Math.min(1, progress))
      : undefined;

  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <main className="setup-progress" ref={panel} tabIndex={-1} aria-label={title}>
      <div className="setup-progress-content">
        <NodGlyph size={112} mode={error ? 'still' : 'bounce'} className="setup-progress-mark" />
        <div
          className="setup-progress-message"
          data-analytics-private
          role={error ? 'alert' : 'status'}
        >
          <h1>{title}</h1>
          {description && <p>{description}</p>}
          {error && <p data-analytics-private>{error}</p>}
        </div>
        {fraction !== undefined && !error && (
          <progress
            className="setup-progress-download"
            aria-label="Download progress"
            max={1}
            value={fraction}
          />
        )}
        {children && <div className="setup-progress-actions">{children}</div>}
      </div>
      <p className="setup-progress-note">
        Your workspace, browser and data stay on {local ? 'this computer' : 'your server'}. Your
        chosen AI providers process requests; browsing and connected apps contact external services.
      </p>
    </main>
  );
}
