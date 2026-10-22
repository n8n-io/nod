import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { Artifact, Message } from '../../shared/contracts';
import { attachmentKind, fileSize, fileType } from '../lib/attachment-kind';
import { Button } from './ui';
import { FileGlyph } from './attachment-glyph';
import { AudioPlayer } from './audio-player';
import { SharedMessageCard } from './shared-message-card';
import { useArtifactDrawer } from './artifact-context';
import {
  ImageGallery,
  ownedArtifactUrl,
  type AttachmentTrigger,
  type ImagePreview,
} from './attachment-images';
import {
  loadPreviewPdf,
  PdfPage,
  type PreviewPdfDocument,
  type PreviewPdfLoading,
} from './attachment-pdf';

type LoadPdf = typeof loadPreviewPdf;

function CardDetails({ name, mimeType, meta }: { name: string; mimeType: string; meta: string }) {
  return (
    <span className="attachment-card-details">
      <FileGlyph name={name} mimeType={mimeType} size={24} className="attachment-card-glyph" />
      <span className="attachment-card-text">
        <span className="attachment-card-name">{name}</span>
        <span className="attachment-card-meta">{meta}</span>
      </span>
    </span>
  );
}

function PdfThumbnail({
  url,
  loadDocument,
  onPages,
  onThumbnail,
}: {
  url: string;
  loadDocument: LoadPdf;
  onPages(count: number): void;
  onThumbnail(available: boolean): void;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const task = useRef<PreviewPdfLoading | undefined>(undefined);
  const [width, setWidth] = useState(0);
  const [document, setDocument] = useState<PreviewPdfDocument | null>(null);
  const hide = useRef(() => onThumbnail(false)).current;
  const release = useRef(() => {
    void task.current?.destroy().catch(() => {});
    task.current = undefined;
  }).current;
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const show = () => setWidth(target.clientWidth > 32 ? target.clientWidth - 32 : 288);
    if (typeof IntersectionObserver === 'undefined') {
      show();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        show();
      },
      { rootMargin: '200px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!width) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const loading = await loadDocument(url, controller.signal);
        if (controller.signal.aborted) {
          void loading.promise.catch(() => {});
          await loading.destroy();
          return;
        }
        task.current = loading;
        const pdf = await loading.promise;
        if (controller.signal.aborted) return;
        onPages(pdf.numPages);
        setDocument(pdf);
      } catch {
        if (!controller.signal.aborted) hide();
      }
    })();
    return () => {
      controller.abort();
      release();
    };
  }, [width, url, loadDocument, onPages, hide, release]);
  return (
    <span className="attachment-card-preview" ref={element} aria-hidden="true">
      {document && (
        <PdfPage
          document={document}
          number={1}
          width={width + 24}
          onError={hide}
          onRendered={release}
        />
      )}
    </span>
  );
}

function DocumentCard({
  item,
  selected,
  onOpen,
  loadDocument,
}: {
  item: ImagePreview;
  selected: boolean;
  onOpen(trigger: AttachmentTrigger): void;
  loadDocument: LoadPdf;
}) {
  const mimeType = item.mimeType ?? '';
  const [pages, setPages] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState(attachmentKind(mimeType, item.name) === 'pdf');
  const meta = [
    fileType(item.name),
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : '',
    fileSize(item.size),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className={`attachment-card is-${attachmentKind(mimeType, item.name) ?? 'file'}${selected ? ' is-selected' : ''}`}
    >
      <button
        type="button"
        className="attachment-card-open"
        aria-current={selected || undefined}
        onClick={(event) => onOpen({ element: event.currentTarget, keyboard: event.detail === 0 })}
      >
        {thumbnail && (
          <PdfThumbnail
            url={item.url}
            loadDocument={loadDocument}
            onPages={setPages}
            onThumbnail={setThumbnail}
          />
        )}
        <CardDetails name={item.name} mimeType={mimeType} meta={meta} />
      </button>
      {item.downloadUrl && ownedArtifactUrl(item.downloadUrl) && (
        <Button variant="ghost" size="icon" className="attachment-card-download" asChild>
          <a href={item.downloadUrl} download={item.name} aria-label={`Download ${item.name}`}>
            <Download size={16} />
          </a>
        </Button>
      )}
    </div>
  );
}

function messageFiles(attachments: Artifact[]) {
  const owned = attachments
    .filter((artifact) => ownedArtifactUrl(artifact.url))
    .map((artifact): ImagePreview => ({ ...artifact, downloadUrl: artifact.url }));
  const animated = owned.some(
    (item) =>
      item.source === 'sticker' &&
      ['sticker', 'video'].includes(attachmentKind(item.mimeType ?? '', item.name) ?? ''),
  );
  const preview = (item: ImagePreview) =>
    animated &&
    (item.source === 'sticker-preview' ||
      (item.source === 'sticker' &&
        item.name === 'sticker-preview.jpg' &&
        item.mimeType === 'image/jpeg'));
  const visual = owned.filter(
    (item) =>
      !preview(item) &&
      ['image', 'video', 'sticker'].includes(attachmentKind(item.mimeType ?? '', item.name) ?? ''),
  );
  return {
    visual,
    rest: owned.filter((item) => !preview(item) && !visual.includes(item)),
  };
}

export function conversationFiles(messages: Pick<Message, 'attachments'>[]) {
  return messages.flatMap((message) => {
    const { visual, rest } = messageFiles(message.attachments);
    return [...visual, ...rest];
  });
}

export function MessageAttachments({
  attachments,
  loadDocument = loadPreviewPdf,
}: {
  attachments: Artifact[];
  loadDocument?: LoadPdf;
}) {
  const drawer = useArtifactDrawer();
  const container = useRef<HTMLDivElement>(null);
  const { visual, rest } = messageFiles(attachments);
  const selected = [...visual, ...rest].some((item) => item.id === drawer.selectedId)
    ? drawer.selectedId
    : null;
  useEffect(() => {
    if (!selected) return;
    container.current?.querySelector('[aria-current="true"]')?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [selected]);
  if (!visual.length && !rest.length) return null;
  return (
    <div className="message-attachments" ref={container}>
      {visual.length > 0 && <ImageGallery images={visual} />}
      {rest.length > 0 && (
        <div className="attachment-cards">
          {rest.map((item) =>
            item.source === 'location' ||
            item.name === 'location.json' ||
            item.source === 'contact' ||
            /\.vcf$/i.test(item.name) ? (
              <SharedMessageCard
                key={item.id}
                item={item}
                selected={drawer.selectedId === item.id}
              />
            ) : attachmentKind(item.mimeType ?? '', item.name) === 'audio' ? (
              <AudioPlayer key={item.id} item={item} selected={drawer.selectedId === item.id} />
            ) : (
              <DocumentCard
                key={item.id}
                item={item}
                selected={drawer.selectedId === item.id}
                loadDocument={loadDocument}
                onOpen={(trigger) => drawer.open(item.id, trigger)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
