import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, Music2, Play } from 'lucide-react';
import type { Artifact } from '../../shared/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui';
import { ownedArtifactUrl } from '../lib/attachment-url';
import PdfPreview from './attachment-pdf';
import AttachmentData from './attachment-data';
export { ownedArtifactUrl } from '../lib/attachment-url';

export interface ImagePreview {
  id: string;
  url: string;
  name: string;
  size: number;
  mimeType?: string;
  downloadUrl?: string;
}

export type AttachmentKind =
  'image' | 'audio' | 'video' | 'pdf' | 'markdown' | 'csv' | 'spreadsheet';

export function attachmentKind(mimeType: string): AttachmentKind | null {
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  if (/^image\/(?:png|jpeg|webp|gif|avif|bmp|svg\+xml)$/.test(type)) return 'image';
  if (/^audio\/(?:mpeg|wav|x-wav|webm|ogg|mp4|aac|flac)$/.test(type)) return 'audio';
  if (/^video\/(?:mp4|webm|ogg)$/.test(type)) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (type === 'text/csv' || type === 'application/csv') return 'csv';
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    return 'spreadsheet';
  return null;
}

function vectorImage(mimeType: string) {
  return mimeType.split(';', 1)[0].trim().toLowerCase() === 'image/svg+xml';
}

export function localPreviewable(mimeType: string) {
  return Boolean(attachmentKind(mimeType)) && !vectorImage(mimeType);
}

export function previewableImage(mimeType: string) {
  return attachmentKind(mimeType) === 'image';
}

export function artifactPreview(artifact: Artifact): ImagePreview | null {
  if (!attachmentKind(artifact.mimeType) || !ownedArtifactUrl(artifact.url)) return null;
  return { ...artifact, downloadUrl: artifact.url };
}

export function artifactImage(artifact: Artifact): ImagePreview | null {
  if (!previewableImage(artifact.mimeType) || !ownedArtifactUrl(artifact.url)) return null;
  return { ...artifact, downloadUrl: artifact.url };
}

export function AttachmentThumbnail({ image }: { image: ImagePreview }) {
  const kind = attachmentKind(image.mimeType ?? 'image/png');
  if (kind === 'image')
    return (
      <img
        src={image.url}
        alt=""
        loading="lazy"
        className={vectorImage(image.mimeType ?? '') ? 'is-vector' : undefined}
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
          <Play size={20} />
          Video
        </span>
      </>
    );
  const label =
    kind === 'audio'
      ? 'Audio'
      : kind === 'pdf'
        ? 'PDF'
        : kind === 'markdown'
          ? 'Markdown'
          : kind === 'csv'
            ? 'CSV'
            : 'Spreadsheet';
  return (
    <span className="attachment-media-thumbnail" aria-hidden="true">
      {kind === 'audio' ? <Music2 size={28} /> : <FileText size={28} />}
      <span>{label}</span>
      {kind !== 'audio' && kind !== 'pdf' && (
        <span className="attachment-document-name">{image.name}</span>
      )}
    </span>
  );
}

function PreviewContent({ image }: { image: ImagePreview }) {
  const [failed, setFailed] = useState(false);
  const kind = attachmentKind(image.mimeType ?? 'image/png');
  if (failed)
    return (
      <div className="attachment-preview-unavailable" role="status">
        <FileText size={32} aria-hidden="true" />
        <span>Preview unavailable</span>
        <a href={image.url} download={image.name}>
          Download
        </a>
      </div>
    );
  if (kind === 'image')
    return (
      <img
        src={image.url}
        alt={image.name}
        className={vectorImage(image.mimeType ?? '') ? 'is-vector' : undefined}
        onError={() => setFailed(true)}
      />
    );
  if (kind === 'audio')
    return (
      <audio
        controls
        preload="metadata"
        src={image.url}
        aria-label={image.name}
        onError={() => setFailed(true)}
      />
    );
  if (kind === 'video')
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={image.url}
        aria-label={image.name}
        onError={() => setFailed(true)}
      />
    );
  if (kind === 'pdf') return <PdfPreview url={image.url} name={image.name} />;
  if (!kind) return null;
  return <AttachmentData url={image.url} name={image.name} kind={kind} size={image.size} />;
}

export function ImageViewer({
  images,
  selectedId,
  onSelect,
  onClose,
  restoreFocus,
  allowLocalPreviews = false,
}: {
  images: ImagePreview[];
  selectedId: string | null;
  onSelect(id: string): void;
  onClose(): void;
  restoreFocus(): void;
  allowLocalPreviews?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const safeImages = images.filter(
    (image) =>
      attachmentKind(image.mimeType ?? 'image/png') &&
      (ownedArtifactUrl(image.url) ||
        (allowLocalPreviews &&
          image.url.startsWith('blob:') &&
          localPreviewable(image.mimeType ?? 'image/png'))),
  );
  const index = safeImages.findIndex((image) => image.id === selectedId);
  const current = safeImages[index];
  if (!current) return null;
  const onlyImages = safeImages.every((image) => previewableImage(image.mimeType ?? 'image/png'));
  const itemLabel = onlyImages ? 'image' : 'attachment';
  const move = (next: number) =>
    onSelect(safeImages[Math.max(0, Math.min(next, safeImages.length - 1))].id);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="attachment-image-viewer"
        onPointerUp={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          surface.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        onKeyDown={(event) => {
          if (
            (event.target as HTMLElement).closest(
              'audio,video,object,input,textarea,select,.attachment-data-preview,[contenteditable="true"]',
            )
          )
            return;
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          move(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? safeImages.length - 1
                : index + (event.key === 'ArrowLeft' ? -1 : 1),
          );
        }}
      >
        <DialogTitle className="sr-only">{current.name}</DialogTitle>
        <DialogDescription className="sr-only">
          Use the left and right arrow keys to browse attachments. Press Escape to close.
        </DialogDescription>
        <div
          className={`attachment-viewer-surface is-${attachmentKind(current.mimeType ?? 'image/png')}`}
          ref={surface}
          tabIndex={-1}
          role="group"
          aria-label="Attachment preview"
        >
          <PreviewContent key={`${current.id}:${current.url}`} image={current} />
        </div>
        <div className="attachment-viewer-footer">
          <span
            className="attachment-viewer-counter"
            role="status"
            aria-live="polite"
            aria-label={`${itemLabel} ${index + 1} of ${safeImages.length}`}
          >
            {index + 1} / {safeImages.length}
          </span>
          <div className="attachment-viewer-actions">
            {safeImages.length > 1 && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Previous ${itemLabel}`}
                  aria-disabled={index === 0}
                  onClick={() => move(index - 1)}
                >
                  <ChevronLeft size={20} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Next ${itemLabel}`}
                  aria-disabled={index === safeImages.length - 1}
                  onClick={() => move(index + 1)}
                >
                  <ChevronRight size={20} />
                </Button>
              </>
            )}
            {current.downloadUrl && ownedArtifactUrl(current.downloadUrl) && (
              <Button variant="ghost" size="icon" asChild>
                <a
                  href={current.downloadUrl}
                  download={current.name}
                  aria-label={`Download ${current.name}`}
                >
                  <Download size={18} />
                </a>
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ImageGallery({ images }: { images: ImagePreview[] }) {
  images = images.filter(
    (image) => ownedArtifactUrl(image.url) && attachmentKind(image.mimeType ?? 'image/png'),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const visible = images.slice(0, 4);
  const onlyImages = images.every((image) => previewableImage(image.mimeType ?? 'image/png'));
  const itemLabel = onlyImages ? 'image' : 'attachment';
  return (
    <>
      <div
        className={`attachment-image-gallery${images.length === 1 ? ' is-single' : ''}${images.length >= 3 ? ' is-grid' : ''}`}
        aria-label={`${images.length} ${itemLabel}${images.length === 1 ? '' : 's'}`}
      >
        {visible.map((image, index) => (
          <button
            type="button"
            className={`attachment-image-tile is-${attachmentKind(image.mimeType ?? 'image/png')}`}
            key={image.id}
            aria-label={`View ${itemLabel} ${index + 1} of ${images.length}`}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              setSelectedId(image.id);
            }}
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
      <ImageViewer
        images={images}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setSelectedId(null)}
        restoreFocus={() => trigger.current?.focus()}
      />
    </>
  );
}
