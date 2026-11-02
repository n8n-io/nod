import { Maximize2, Play } from './icons';
import { useEffect, useRef } from 'react';
import { FileActions, fileDrag, prepareFile } from './file-actions';
import type { Artifact } from '../../shared/contracts';
import type { Presentation } from '../../shared/presentation';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { attachmentKind, previewableImage, vectorImage } from '../lib/attachment-kind';
import { FileGlyph } from './attachment-glyph';
import { useArtifactDrawer } from './artifact-context';
import { StickerPlayer } from './sticker-player';
import { AttachmentVideo } from './attachment-video';
import { Button } from './ui';
export { ownedArtifactUrl } from '../lib/attachment-url';

export interface ImagePreview {
  id: string;
  url: string;
  name: string;
  size: number;
  mimeType?: string;
  downloadUrl?: string;
  source?: Artifact['source'];
  presentation?: Presentation;
}

export interface AttachmentTrigger {
  element: HTMLElement;
  keyboard: boolean;
}

export function restoreAttachmentFocus(trigger: AttachmentTrigger | null) {
  if (!trigger?.element.isConnected) return false;
  const { element, keyboard } = trigger;
  const options = { preventScroll: true, focusVisible: keyboard };
  element.focus(options);
  if (!keyboard) {
    element.dataset.attachmentPointerFocus = '';
    const controller = new AbortController();
    const reset = () => {
      delete element.dataset.attachmentPointerFocus;
      controller.abort();
    };
    for (const event of ['blur', 'keydown', 'pointerdown'])
      element.addEventListener(event, reset, { once: true, signal: controller.signal });
  }
  return true;
}

function AttachmentThumbnail({ image }: { image: ImagePreview }) {
  const kind = attachmentKind(image.mimeType ?? 'image/png', image.name);
  if (kind === 'sticker') return <StickerPlayer item={image} />;
  if (kind === 'video' && image.source === 'sticker') return <StickerVideo item={image} />;
  if (kind === 'image')
    return (
      <img
        src={image.url}
        alt=""
        loading="lazy"
        className={vectorImage(image.mimeType ?? '', image.name) ? 'is-vector' : undefined}
      />
    );
  if (kind === 'video')
    return (
      <>
        <AttachmentVideo item={image} preview />
        <span className="attachment-media-label" aria-hidden="true">
          <Play size={24} />
          Video
        </span>
      </>
    );
  return (
    <span className="attachment-media-thumbnail" aria-hidden="true">
      <FileGlyph name={image.name} mimeType={image.mimeType ?? ''} size={24} />
      <span className="attachment-document-name">{image.name}</span>
    </span>
  );
}

function StickerVideo({ item }: { item: ImagePreview }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.src = item.url;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => {
      if (visible && !motion.matches && !document.hidden) void element.play().catch(() => {});
      else element.pause();
    };
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(element);
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [item.url]);
  return (
    <video ref={video} preload="metadata" muted loop playsInline tabIndex={-1} aria-hidden="true" />
  );
}

export function ImageGallery({ images }: { images: ImagePreview[] }) {
  images = images.filter(
    (image) =>
      ownedArtifactUrl(image.url) && attachmentKind(image.mimeType ?? 'image/png', image.name),
  );
  const drawer = useArtifactDrawer();
  const gallery = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (drawer.selectedId)
      gallery.current?.querySelectorAll('video').forEach((video) => video.pause());
  }, [drawer.selectedId]);
  const visible = images.slice(0, 4);
  const onlyImages = images.every((image) =>
    previewableImage(image.mimeType ?? 'image/png', image.name),
  );
  const itemLabel = onlyImages ? 'image' : 'attachment';
  return (
    <div
      ref={gallery}
      className={`attachment-image-gallery${images.length === 1 ? ' is-single' : ''}${images.length >= 3 ? ' is-grid' : ''}`}
      aria-label={`${images.length} ${itemLabel}${images.length === 1 ? '' : 's'}`}
    >
      {visible.map((image, index) => (
        <div key={image.id} className="attachment-image-item">
          {attachmentKind(image.mimeType ?? '', image.name) === 'video' &&
          image.source !== 'sticker' ? (
            <div
              className={`attachment-inline-video${drawer.selectedId === image.id ? ' is-selected' : ''}`}
              aria-current={drawer.selectedId === image.id || undefined}
            >
              <AttachmentVideo item={image} />
              <div className="attachment-video-toolbar">
                <FileActions item={image} />
                <Button
                  draggable
                  onDragStart={(event) => fileDrag(event, image)}
                  onPointerEnter={() => prepareFile(image)}
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Open ${image.name} in gallery`}
                  title="Open in gallery"
                  onClick={(event) =>
                    drawer.open(image.id, {
                      element: event.currentTarget,
                      keyboard: event.detail === 0,
                    })
                  }
                >
                  <Maximize2 size={16} />
                </Button>
              </div>
              {index === 3 && images.length > visible.length && (
                <button
                  type="button"
                  className="attachment-video-more"
                  onClick={(event) =>
                    drawer.open(images[visible.length].id, {
                      element: event.currentTarget,
                      keyboard: event.detail === 0,
                    })
                  }
                >
                  +{images.length - visible.length} more
                </button>
              )}
            </div>
          ) : (
            <>
              <button
                draggable
                onDragStart={(event) => fileDrag(event, image)}
                onPointerEnter={() => prepareFile(image)}
                type="button"
                className={`attachment-image-tile is-${attachmentKind(image.mimeType ?? 'image/png', image.name)}${image.source === 'sticker' ? ' is-sticker' : ''}${drawer.selectedId === image.id ? ' is-selected' : ''}`}
                key={image.id}
                aria-label={`View ${itemLabel} ${index + 1} of ${images.length}`}
                aria-current={drawer.selectedId === image.id || undefined}
                onClick={(event) =>
                  drawer.open(image.id, {
                    element: event.currentTarget,
                    keyboard: event.detail === 0,
                  })
                }
              >
                <AttachmentThumbnail image={image} />
                {index === 3 && images.length > visible.length && (
                  <span className="attachment-image-more" aria-hidden="true">
                    +{images.length - visible.length}
                  </span>
                )}
              </button>
              <FileActions item={image} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
