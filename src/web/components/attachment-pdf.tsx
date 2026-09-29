import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { localPreviewUrl, ownedArtifactUrl } from '../lib/attachment-url';
import { Button } from './ui';

export type PreviewPdfDocument = Pick<PDFDocumentProxy, 'numPages' | 'getPage'>;
export type PreviewPdfLoading = {
  promise: Promise<PreviewPdfDocument>;
  destroy(): Promise<void>;
};
type LoadPdf = (url: string, signal: AbortSignal) => Promise<PreviewPdfLoading>;

export const loadPreviewPdf: LoadPdf = async (url, signal) => {
  if (!ownedArtifactUrl(url) && !localPreviewUrl(url)) throw new Error('Invalid PDF source.');
  if (typeof Worker === 'undefined') throw new Error('PDF worker unavailable.');
  const [pdf, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  signal.throwIfAborted();
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  return pdf.getDocument({
    url,
    verbosity: 0,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    maxImageSize: 16_777_216,
    canvasMaxAreaInBytes: 67_108_864,
  });
};

export function PdfPage({
  document,
  number,
  width,
  onError,
  onRendered,
}: {
  document: PreviewPdfDocument;
  number: number;
  width: number;
  onError(): void;
  onRendered?(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let rendering: RenderTask | undefined;
    void (async () => {
      try {
        const page = await document.getPage(number);
        if (!active || !canvas.current) return;
        const original = page.getViewport({ scale: 1 });
        if (
          !Number.isFinite(original.width) ||
          !Number.isFinite(original.height) ||
          !(original.width > 0 && original.height > 0)
        )
          throw new Error('Invalid PDF page.');
        const density = Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min(
          Math.max(width - 24, 100) / original.width,
          Math.sqrt(8_388_608 / (original.width * original.height)) / density,
          8192 / Math.max(original.width, original.height) / density,
        );
        const viewport = page.getViewport({ scale });
        const target = canvas.current;
        const context = target.getContext('2d');
        if (!context) throw new Error('PDF canvas unavailable.');
        target.width = Math.max(1, Math.floor(viewport.width * density));
        target.height = Math.max(1, Math.floor(viewport.height * density));
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        rendering = page.render({
          canvas: target,
          canvasContext: context,
          viewport,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
        });
        await rendering.promise;
        if (!active) return;
        setLoading(false);
        onRendered?.();
      } catch {
        if (active) onError();
      }
    })();
    return () => {
      active = false;
      rendering?.cancel();
    };
  }, [document, number, width, onError, onRendered]);
  return (
    <div className="attachment-pdf-page" aria-busy={loading}>
      {loading && (
        <span className="attachment-pdf-loading" role="status">
          Loading page…
        </span>
      )}
      <canvas ref={canvas} role="img" aria-label={`PDF page ${number}`} hidden={loading} />
    </div>
  );
}

export default function PdfPreview({
  url,
  name,
  loadDocument = loadPreviewPdf,
}: {
  url: string;
  name: string;
  loadDocument?: LoadPdf;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PreviewPdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(720);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const safe = ownedArtifactUrl(url) || localPreviewUrl(url);
  useEffect(() => {
    if (!safe) return;
    const controller = new AbortController();
    let task: PreviewPdfLoading | undefined;
    setDocument(null);
    setPage(1);
    setFailed(false);
    void (async () => {
      try {
        const loading = await loadDocument(url, controller.signal);
        if (controller.signal.aborted) {
          void loading.promise.catch(() => {});
          await loading.destroy();
          return;
        }
        task = loading;
        const pdf = await loading.promise;
        if (!controller.signal.aborted) setDocument(pdf);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      void task?.destroy().catch(() => {});
    };
  }, [url, safe, attempt, loadDocument]);
  useEffect(() => {
    const resize = () => {
      if (container.current?.clientWidth) setWidth(container.current.clientWidth);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (container.current) observer?.observe(container.current);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);
  const fail = useRef(() => setFailed(true)).current;
  if (!safe) return <div role="status">Preview unavailable</div>;
  return (
    <div className="attachment-pdf-preview" ref={container}>
      {failed ? (
        <div className="attachment-preview-unavailable" role="status">
          <FileText size={32} aria-hidden="true" />
          <span>PDF preview unavailable</span>
          <a href={url} download={name}>
            Download
          </a>
          <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : document ? (
        <>
          <PdfPage
            key={`${page}:${width}`}
            document={document}
            number={page}
            width={width}
            onError={fail}
          />
          {document.numPages > 1 && (
            <div
              className="attachment-pdf-controls"
              aria-label="PDF pages"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                event.stopPropagation();
                setPage((value) =>
                  event.key === 'Home'
                    ? 1
                    : event.key === 'End'
                      ? document.numPages
                      : Math.max(
                          1,
                          Math.min(document.numPages, value + (event.key === 'ArrowLeft' ? -1 : 1)),
                        ),
                );
              }}
            >
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous PDF page"
                disabled={page === 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeft size={18} />
              </Button>
              <span role="status">
                Page {page} of {document.numPages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next PDF page"
                disabled={page === document.numPages}
                onClick={() => setPage((value) => Math.min(document.numPages, value + 1))}
              >
                <ChevronRight size={18} />
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="attachment-preview-unavailable" role="status">
          Loading PDF…
        </div>
      )}
    </div>
  );
}
