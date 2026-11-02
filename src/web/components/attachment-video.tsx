import { useEffect, useRef } from 'react';
import type { ImagePreview } from './attachment-images';

export function AttachmentVideo({
  item,
  preview = false,
  onMetadata,
  onError,
}: {
  item: ImagePreview;
  preview?: boolean;
  onMetadata?(video: HTMLVideoElement): void;
  onError?(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const started = useRef(false);
  const previewTime = useRef<number | null>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    started.current = false;
    previewTime.current = null;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) element.pause();
    });
    observer.observe(element);
    const pause = () => {
      if (document.hidden) element.pause();
    };
    document.addEventListener('visibilitychange', pause);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', pause);
      element.pause();
    };
  }, [item.url]);
  return (
    <video
      ref={video}
      controls={!preview}
      playsInline
      preload="metadata"
      muted={preview}
      src={item.url}
      aria-label={preview ? undefined : item.name}
      aria-hidden={preview || undefined}
      tabIndex={preview ? -1 : 0}
      onLoadedMetadata={(event) => {
        const element = event.currentTarget;
        if (!started.current && Number.isFinite(element.duration) && element.duration > 0) {
          previewTime.current = Math.min(0.1, element.duration / 2);
          element.currentTime = previewTime.current;
        }
        onMetadata?.(element);
      }}
      onSeeking={(event) => {
        if (event.currentTarget.currentTime !== previewTime.current) previewTime.current = null;
      }}
      onPlay={(event) => {
        if (started.current) return;
        started.current = true;
        if (previewTime.current !== null) event.currentTarget.currentTime = 0;
      }}
      onError={onError}
    />
  );
}
