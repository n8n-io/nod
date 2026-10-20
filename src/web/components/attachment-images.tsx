import { Play } from 'lucide-react';
import type { Artifact } from '../../shared/contracts';
import { ownedArtifactUrl } from '../lib/attachment-url';
import { attachmentKind, previewableImage, vectorImage } from '../lib/attachment-kind';
import { FileGlyph } from './attachment-glyph';
import { useArtifactDrawer } from './artifact-context';
export { ownedArtifactUrl } from '../lib/attachment-url';

export interface ImagePreview {
  id: string;
  url: string;
  name: string;
  size: number;
  mimeType?: string;
  downloadUrl?: string;
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

export function artifactPreview(artifact: Artifact): ImagePreview | null {
  if (!attachmentKind(artifact.mimeType, artifact.name) || !ownedArtifactUrl(artifact.url))
    return null;
  return { ...artifact, downloadUrl: artifact.url };
}

export function artifactImage(artifact: Artifact): ImagePreview | null {
  if (!previewableImage(artifact.mimeType, artifact.name) || !ownedArtifactUrl(artifact.url))
    return null;
  return { ...artifact, downloadUrl: artifact.url };
}

export function AttachmentThumbnail({ image }: { image: ImagePreview }) {
  const kind = attachmentKind(image.mimeType ?? 'image/png', image.name);
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
        <video
          src={image.url}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          aria-hidden="true"
        />
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

export function ImageGallery({ images }: { images: ImagePreview[] }) {
  images = images.filter(
    (image) =>
      ownedArtifactUrl(image.url) && attachmentKind(image.mimeType ?? 'image/png', image.name),
  );
  const drawer = useArtifactDrawer();
  const visible = images.slice(0, 4);
  const onlyImages = images.every((image) =>
    previewableImage(image.mimeType ?? 'image/png', image.name),
  );
  const itemLabel = onlyImages ? 'image' : 'attachment';
  return (
    <div
      className={`attachment-image-gallery${images.length === 1 ? ' is-single' : ''}${images.length >= 3 ? ' is-grid' : ''}`}
      aria-label={`${images.length} ${itemLabel}${images.length === 1 ? '' : 's'}`}
    >
      {visible.map((image, index) => (
        <button
          type="button"
          className={`attachment-image-tile is-${attachmentKind(image.mimeType ?? 'image/png', image.name)}${drawer.selectedId === image.id ? ' is-selected' : ''}`}
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
      ))}
    </div>
  );
}
