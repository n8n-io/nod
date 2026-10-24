import { useEffect, useRef, useState, type RefObject } from 'react';
import { FileText, Minus, Plus } from './icons';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { localPreviewUrl, ownedArtifactUrl } from '../lib/attachment-url';
import { Button } from './ui';
import { PreviewLoading } from './attachment-data';

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
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
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
  height,
  zoom = 1,
  scrollRoot,
  onError,
  onRendered,
}: {
  document: PreviewPdfDocument;
  number: number;
  width: number;
  height?: number;
  zoom?: number;
  scrollRoot?: RefObject<HTMLDivElement | null>;
  onError(): void;
  onRendered?(): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<{
    source: PDFPageProxy;
    width: number;
    height: number;
  } | null>(null);
  const [visible, setVisible] = useState(!scrollRoot);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setPage(null);
    setLoading(true);
    void document
      .getPage(number)
      .then((source) => {
        if (!active) return;
        const viewport = source.getViewport({ scale: 1 });
        if (
          !Number.isFinite(viewport.width) ||
          !Number.isFinite(viewport.height) ||
          !(viewport.width > 0 && viewport.height > 0)
        )
          throw new Error('Invalid PDF page.');
        setPage({ source, width: viewport.width, height: viewport.height });
      })
      .catch(() => {
        if (active) onError();
      });
    return () => {
      active = false;
    };
  }, [document, number, onError]);
  useEffect(() => {
    if (!scrollRoot || !element.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { root: scrollRoot.current, rootMargin: '100% 0px' },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [scrollRoot]);
  const original = page ?? { width: 612, height: 792 };
  const scale =
    Math.min(
      Math.max(width - 24, 1) / original.width,
      height === undefined ? Infinity : Math.max(height - 24, 1) / original.height,
    ) * zoom;
  const displayWidth = original.width * scale;
  const displayHeight = original.height * scale;
  useEffect(() => {
    const target = canvas.current;
    if (!page || !visible || !target) return;
    let active = true;
    let rendering: RenderTask | undefined;
    setLoading(true);
    void (async () => {
      try {
        const viewport = page.source.getViewport({ scale });
        const density = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(8_388_608 / (viewport.width * viewport.height)),
          8192 / Math.max(viewport.width, viewport.height),
        );
        const context = target.getContext('2d');
        if (!context) throw new Error('PDF canvas unavailable.');
        target.width = Math.max(1, Math.floor(viewport.width * density));
        target.height = Math.max(1, Math.floor(viewport.height * density));
        rendering = page.source.render({
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
      target.width = 0;
      target.height = 0;
      page.source.cleanup();
    };
  }, [page, visible, scale, onError, onRendered]);
  return (
    <div
      className="attachment-pdf-page"
      ref={element}
      aria-busy={visible && loading}
      style={scrollRoot ? { width: displayWidth, height: displayHeight } : undefined}
    >
      {loading && visible && (
        <span className="attachment-pdf-loading" role="status">
          Loading page…
        </span>
      )}
      <canvas
        key={scale}
        ref={canvas}
        width={0}
        height={0}
        role="img"
        aria-label={`PDF page ${number}`}
        hidden={!visible || loading}
        style={{ width: displayWidth, height: displayHeight }}
      />
    </div>
  );
}

export default function PdfPreview({
  url,
  onDetail,
  loadDocument = loadPreviewPdf,
}: {
  url: string;
  onDetail(detail: string): void;
  loadDocument?: LoadPdf;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PreviewPdfDocument | null>(null);
  const [size, setSize] = useState({ width: 720, height: 600 });
  const [fit, setFit] = useState<'page' | 'width'>('width');
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const safe = ownedArtifactUrl(url) || localPreviewUrl(url);
  useEffect(() => {
    if (!safe) return;
    const controller = new AbortController();
    let task: PreviewPdfLoading | undefined;
    setDocument(null);
    setFit('width');
    setZoom(1);
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
        if (controller.signal.aborted) return;
        setDocument(pdf);
        onDetail(`${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}`);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      void task?.destroy().catch(() => {});
    };
  }, [url, safe, attempt, loadDocument, onDetail]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth && element.clientHeight)
        setSize((current) =>
          current.width === element.clientWidth && current.height === element.clientHeight
            ? current
            : { width: element.clientWidth, height: element.clientHeight },
        );
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [document, failed]);
  const fail = useRef(() => setFailed(true)).current;
  function fitTo(value: 'page' | 'width') {
    setFit(value);
    setZoom(1);
  }
  if (!safe) return <div role="status">Preview unavailable</div>;
  return (
    <div
      className="attachment-pdf-preview"
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.stopPropagation();
      }}
    >
      {failed ? (
        <div className="artifact-empty" role="status">
          <FileText size={32} aria-hidden="true" />
          <span>PDF preview unavailable</span>
          <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : document ? (
        <>
          <div
            className="attachment-pdf-scroll"
            ref={scroll}
            tabIndex={0}
            role="region"
            aria-label="PDF document"
            data-artifact-scroll=""
          >
            <div className="attachment-pdf-pages">
              {Array.from({ length: document.numPages }, (_, index) => (
                <PdfPage
                  key={index + 1}
                  document={document}
                  number={index + 1}
                  width={size.width}
                  height={fit === 'page' ? size.height : undefined}
                  zoom={zoom}
                  scrollRoot={scroll}
                  onError={fail}
                />
              ))}
            </div>
          </div>
          <div className="artifact-zoom" role="group" aria-label="PDF view">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={fit === 'page' && zoom === 1}
              onClick={() => fitTo('page')}
            >
              Fit page
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={fit === 'width' && zoom === 1}
              onClick={() => fitTo('width')}
            >
              Fit width
            </Button>
            <span className="artifact-zoom-divider" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom out"
              disabled={zoom <= 0.25}
              onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
            >
              <Minus size={16} aria-hidden="true" />
            </Button>
            <span className="artifact-zoom-value">{Math.round(zoom * 100)}%</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Zoom in"
              disabled={zoom >= 4}
              onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
            >
              <Plus size={16} aria-hidden="true" />
            </Button>
          </div>
        </>
      ) : (
        <PreviewLoading />
      )}
    </div>
  );
}
