import { useEffect, useRef, useState } from 'react';
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from 'lucide-react';
import type { Artifact } from '../../shared/contracts';
import { Button } from './ui';
import {
  artifactPreview,
  attachmentKind,
  ImageGallery,
  ImageViewer,
  ownedArtifactUrl,
  type ImagePreview,
} from './attachment-images';
import {
  loadPreviewPdf,
  PdfPage,
  type PreviewPdfDocument,
  type PreviewPdfLoading,
} from './attachment-pdf';

type LoadPdf = typeof loadPreviewPdf;

export function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileType(name: string) {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() ?? 'File';
}

function FileGlyph({ name, mimeType }: { name: string; mimeType: string }) {
  const type = mimeType.split(';', 1)[0].trim().toLowerCase();
  const Icon = type.startsWith('image/')
    ? FileImage
    : type.startsWith('audio/')
      ? FileAudio
      : type.startsWith('video/')
        ? FileVideo
        : /zip|tar|compressed|rar/.test(type) || /\.(zip|tar|gz|tgz|7z|rar)$/i.test(name)
          ? FileArchive
          : /csv|spreadsheet|excel/.test(type)
            ? FileSpreadsheet
            : /json|javascript|html|xml|x-sh/.test(type)
              ? FileCode
              : /pdf|^text\/|document|msword/.test(type)
                ? FileText
                : File;
  return <Icon className="attachment-card-glyph" size={20} aria-hidden="true" />;
}

function CardDetails({ name, mimeType, meta }: { name: string; mimeType: string; meta: string }) {
  return (
    <span className="attachment-card-details">
      <FileGlyph name={name} mimeType={mimeType} />
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
  onOpen,
  loadDocument,
}: {
  item: ImagePreview;
  onOpen(trigger: HTMLButtonElement): void;
  loadDocument: LoadPdf;
}) {
  const mimeType = item.mimeType ?? '';
  const [pages, setPages] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState(attachmentKind(mimeType) === 'pdf');
  const meta = [
    fileType(item.name),
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : '',
    fileSize(item.size),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`attachment-card is-${attachmentKind(mimeType)}`}>
      <button
        type="button"
        className="attachment-card-open"
        onClick={(event) => onOpen(event.currentTarget)}
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

function FileAttachment({ artifact }: { artifact: Artifact }) {
  if (!ownedArtifactUrl(artifact.url)) return null;
  return (
    <a
      className="attachment-card attachment-file"
      href={artifact.url}
      download={artifact.name}
      aria-label={`Download ${artifact.name}`}
    >
      <CardDetails
        name={artifact.name}
        mimeType={artifact.mimeType}
        meta={`${fileType(artifact.name)} · ${fileSize(artifact.size)}`}
      />
      <Download className="attachment-file-action" size={16} aria-hidden="true" />
    </a>
  );
}

export function MessageAttachments({
  attachments,
  loadDocument = loadPreviewPdf,
}: {
  attachments: Artifact[];
  loadDocument?: LoadPdf;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const owned = attachments.filter((artifact) => ownedArtifactUrl(artifact.url));
  const previews = owned.flatMap((artifact) => {
    const preview = artifactPreview(artifact);
    return preview ? [preview] : [];
  });
  const visual = previews.filter((item) =>
    ['image', 'video'].includes(attachmentKind(item.mimeType ?? '') ?? ''),
  );
  const documents = previews.filter((item) => !visual.includes(item));
  const rest = owned.filter((artifact) => !visual.some((item) => item.id === artifact.id));
  if (!owned.length) return null;
  return (
    <div className="message-attachments">
      {visual.length > 0 && <ImageGallery images={visual} />}
      {rest.length > 0 && (
        <div className="attachment-cards">
          {rest.map((artifact) => {
            const item = documents.find((document) => document.id === artifact.id);
            return item ? (
              <DocumentCard
                key={artifact.id}
                item={item}
                loadDocument={loadDocument}
                onOpen={(button) => {
                  trigger.current = button;
                  setSelectedId(item.id);
                }}
              />
            ) : (
              <FileAttachment key={artifact.id} artifact={artifact} />
            );
          })}
        </div>
      )}
      <ImageViewer
        images={documents}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setSelectedId(null)}
        restoreFocus={() => trigger.current?.focus()}
      />
    </div>
  );
}
