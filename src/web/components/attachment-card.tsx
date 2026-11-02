import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';
import { FileActions, fileDrag, prepareFile } from './file-actions';
import type { Artifact, Message } from '../../shared/contracts';
import { presentationSchema } from '../../shared/presentation';
import { attachmentKind, fileSize, fileType } from '../lib/attachment-kind';
import { FileGlyph } from './attachment-glyph';
import { AudioPlayer } from './audio-player';
import { SharedMessageCard } from './shared-message-card';
import { useArtifactDrawer } from './artifact-context';
import { observeAnalyticsView } from '../lib/analytics';
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
const AttachmentData = lazy(() => import('./attachment-data'));
type DataKind = ComponentProps<typeof AttachmentData>['kind'];
const ignoreDetail = () => {};
const thumbnailKinds = new Set([
  'markdown',
  'text',
  'csv',
  'spreadsheet',
  'document',
  'presentation',
  'html',
  'archive',
  'n8n-workflow',
]);

function DataThumbnail({ item, kind }: { item: ImagePreview; kind: DataKind }) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target) return;
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
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="attachment-card-preview is-data" ref={element} aria-hidden="true" inert>
      {visible && (
        <div className="attachment-card-preview-content">
          <Suspense fallback={null}>
            <AttachmentData
              item={item}
              kind={kind}
              mode="preview"
              stage="#f1f1f1"
              thumbnail
              onDetail={ignoreDetail}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

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
  const kind = attachmentKind(mimeType, item.name);
  const [pages, setPages] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState(kind === 'pdf');
  const dataThumbnail = thumbnailKinds.has(kind ?? '');
  const meta = [
    fileType(item.name),
    pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : '',
    fileSize(item.size),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      draggable
      onDragStart={(event) => fileDrag(event, item)}
      onPointerEnter={() => prepareFile(item)}
      className={`attachment-card is-${kind ?? 'file'}${thumbnail || dataThumbnail ? ' has-preview' : ''}${selected ? ' is-selected' : ''}`}
    >
      {thumbnail && (
        <PdfThumbnail
          url={item.url}
          loadDocument={loadDocument}
          onPages={setPages}
          onThumbnail={setThumbnail}
        />
      )}
      {dataThumbnail && <DataThumbnail item={item} kind={kind as DataKind} />}
      <button
        type="button"
        className="attachment-card-open"
        aria-current={selected || undefined}
        onClick={(event) => onOpen({ element: event.currentTarget, keyboard: event.detail === 0 })}
      >
        <CardDetails name={item.name} mimeType={mimeType} meta={meta} />
      </button>
      <FileActions item={item} />
    </div>
  );
}

function messageFiles(attachments: Artifact[]) {
  const owned = [...new Map(attachments.map((artifact) => [artifact.id, artifact])).values()]
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
  const all = owned.filter((item) => !preview(item));
  const visual = all.filter((item) =>
    ['image', 'video', 'sticker'].includes(attachmentKind(item.mimeType ?? '', item.name) ?? ''),
  );
  return {
    all,
    visual,
    rest: all.filter((item) => !visual.includes(item)),
  };
}

export function conversationFiles(
  messages: (Pick<Message, 'attachments'> & Partial<Pick<Message, 'id' | 'presentation'>>)[],
) {
  const files = messages.flatMap((message) => {
    const { all } = messageFiles(message.attachments);
    const parsed = presentationSchema.safeParse(message.presentation);
    const presentation: ImagePreview[] =
      message.id && parsed.success && parsed.data.type !== 'image' && parsed.data.type !== 'apps'
        ? [
            {
              id: `presentation:${message.id}`,
              url: '',
              name: parsed.data.title,
              size: 0,
              presentation: parsed.data,
            },
          ]
        : [];
    return [...presentation, ...all];
  });
  return [...new Map(files.map((file) => [file.id, file])).values()];
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
  const exposure = JSON.stringify(
    [...visual.slice(0, 4), ...rest].map((item) => [item.id, item.mimeType, item.name]),
  );
  useEffect(() => {
    if (!container.current) return;
    const elements = [
      ...container.current.querySelectorAll<HTMLElement>('.attachment-image-item'),
      ...container.current.querySelectorAll<HTMLElement>('.attachment-cards > *'),
    ];
    const files = JSON.parse(exposure) as [string, string | undefined, string][];
    const stop = files.flatMap(([id, mimeType, name], index) =>
      elements[index]
        ? [
            observeAnalyticsView(elements[index], `${id}:message`, 'artifact_viewed', {
              kind: attachmentKind(mimeType ?? '', name) ?? 'file',
              location: 'message',
            }),
          ]
        : [],
    );
    return () => stop.forEach((release) => release());
  }, [exposure]);
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
