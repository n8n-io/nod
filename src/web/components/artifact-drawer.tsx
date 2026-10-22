import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Copy,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { attachmentKind, fileSize, fileType, vectorImage } from '../lib/attachment-kind';
import { localPreviewUrl, ownedArtifactUrl } from '../lib/attachment-url';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { ArtifactDrawerContext } from './artifact-context';
import { FileGlyph } from './attachment-glyph';
import {
  restoreAttachmentFocus,
  type AttachmentTrigger,
  type ImagePreview,
} from './attachment-images';
import AttachmentData, { PreviewUnavailable } from './attachment-data';
import PdfPreview from './attachment-pdf';
import { Button } from './ui';

const minimumWidth = 360;
const minimumChat = 360;

function duration(seconds: number) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return parts[0]
    ? `${parts[0]}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`
    : `${parts[1]}:${String(parts[2]).padStart(2, '0')}`;
}

function ImageView({
  item,
  onDetail,
  onError,
}: {
  item: ImagePreview;
  onDetail(detail: string): void;
  onError(): void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [zoomable, setZoomable] = useState(false);
  const fits = (image: HTMLImageElement) =>
    image.naturalWidth <= image.clientWidth + 1 && image.naturalHeight <= image.clientHeight + 1;
  return (
    <div
      className={`artifact-stage is-image${zoomed ? ' is-zoomed' : ''}${zoomable ? ' is-zoomable' : ''}`}
      tabIndex={0}
      data-artifact-scroll=""
    >
      <img
        src={item.url}
        alt={item.name}
        className={vectorImage(item.mimeType ?? '', item.name) ? 'is-vector' : undefined}
        onLoad={(event) => {
          const image = event.currentTarget;
          onDetail(`${image.naturalWidth} × ${image.naturalHeight}`);
          setZoomable(!fits(image));
        }}
        onPointerEnter={(event) => setZoomable(zoomed || !fits(event.currentTarget))}
        onError={onError}
        onClick={(event) => {
          const image = event.currentTarget;
          if (!zoomed && fits(image)) return;
          const stage = image.parentElement!;
          const box = image.getBoundingClientRect();
          const x = (event.clientX - box.left) / box.width;
          const y = (event.clientY - box.top) / box.height;
          const pointer = stage.getBoundingClientRect();
          setZoomed((value) => {
            if (!value)
              requestAnimationFrame(() => {
                stage.scrollLeft = x * image.scrollWidth - (event.clientX - pointer.left);
                stage.scrollTop = y * image.scrollHeight - (event.clientY - pointer.top);
              });
            return !value;
          });
        }}
      />
    </div>
  );
}

function VideoView({
  item,
  onDetail,
  onError,
}: {
  item: ImagePreview;
  onDetail(detail: string): void;
  onError(): void;
}) {
  return (
    <div className="artifact-stage is-video">
      <video
        controls
        playsInline
        preload="metadata"
        src={item.url}
        aria-label={item.name}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          onDetail(
            [
              duration(video.duration),
              video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : '',
            ]
              .filter(Boolean)
              .join(' · '),
          );
        }}
        onError={onError}
      />
    </div>
  );
}

function AudioView({
  item,
  onDetail,
  onError,
}: {
  item: ImagePreview;
  onDetail(detail: string): void;
  onError(): void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const frame = useRef(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (item.size > 30_000_000) return;
    void (async () => {
      try {
        const response = await fetch(item.url, {
          signal: controller.signal,
          credentials: 'same-origin',
        });
        const decoded = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(
          await response.arrayBuffer(),
        );
        const channel = decoded.getChannelData(0);
        const step = Math.max(1, Math.floor(channel.length / 96));
        const values = Array.from({ length: 96 }, (_, index) => {
          let sum = 0;
          let count = 0;
          for (let sample = index * step; sample < (index + 1) * step; sample += 8) {
            sum += (channel[sample] ?? 0) ** 2;
            count += 1;
          }
          return Math.sqrt(sum / Math.max(1, count));
        });
        const top = Math.max(...values) || 1;
        if (!controller.signal.aborted)
          setPeaks(values.map((value) => Math.max(0.08, value / top)));
      } catch {}
    })();
    return () => {
      controller.abort();
      cancelAnimationFrame(frame.current);
    };
  }, [item.url, item.size]);
  const follow = () => {
    const element = audio.current;
    if (!element) return;
    setProgress(element.duration ? element.currentTime / element.duration : 0);
    if (!element.paused) frame.current = requestAnimationFrame(follow);
  };
  return (
    <div className="artifact-stage is-audio">
      <div className="artifact-audio">
        {peaks ? (
          <div
            className="artifact-waveform"
            aria-hidden="true"
            onClick={(event) => {
              const element = audio.current;
              if (!element?.duration) return;
              const box = event.currentTarget.getBoundingClientRect();
              element.currentTime = ((event.clientX - box.left) / box.width) * element.duration;
              follow();
            }}
          >
            {peaks.map((peak, index) => (
              <span
                key={index}
                className={index / peaks.length < progress ? 'is-played' : undefined}
                style={{ height: `${peak * 100}%` }}
              />
            ))}
          </div>
        ) : (
          <span className="artifact-audio-art" aria-hidden="true">
            <FileGlyph name={item.name} mimeType={item.mimeType ?? ''} size={48} />
          </span>
        )}
        <audio
          ref={audio}
          controls
          preload="metadata"
          src={item.url}
          aria-label={item.name}
          onLoadedMetadata={(event) => onDetail(duration(event.currentTarget.duration))}
          onPlay={follow}
          onSeeked={follow}
          onError={onError}
        />
      </div>
    </div>
  );
}

const ArtifactView = memo(function ArtifactView({
  item,
  mode,
  stage,
  onDetail,
}: {
  item: ImagePreview;
  mode: 'preview' | 'code';
  stage: string;
  onDetail(detail: string): void;
}) {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const kind = attachmentKind(item.mimeType ?? '', item.name);
  if (failed) return <PreviewUnavailable item={item} />;
  if (!kind) return <PreviewUnavailable item={item} message="No preview for this file type" />;
  if (kind === 'image' && mode === 'code' && ownedArtifactUrl(item.url))
    return <AttachmentData item={item} kind="text" mode="code" stage={stage} onDetail={onDetail} />;
  if (kind === 'image') return <ImageView item={item} onDetail={onDetail} onError={fail} />;
  if (kind === 'video') return <VideoView item={item} onDetail={onDetail} onError={fail} />;
  if (kind === 'audio') return <AudioView item={item} onDetail={onDetail} onError={fail} />;
  if (kind === 'pdf') return <PdfPreview url={item.url} onDetail={onDetail} />;
  return <AttachmentData item={item} kind={kind} mode={mode} stage={stage} onDetail={onDetail} />;
});

function storedWidth() {
  const value = Number(readUiPreference('nod.artifact-width'));
  return Number.isFinite(value) && value >= minimumWidth ? value : null;
}

function ArtifactDrawer({
  items,
  current,
  onSelect,
  onClose,
}: {
  items: ImagePreview[];
  current: ImagePreview;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const root = useRef<HTMLElement>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const [width, setWidth] = useState<number | null>(storedWidth);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [detail, setDetail] = useState('');
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const [stage, setStage] = useState('#f1f1f1');
  const index = items.indexOf(current);
  const kind = attachmentKind(current.mimeType ?? '', current.name);
  const vector = kind === 'image' && vectorImage(current.mimeType ?? '', current.name);
  const modes = kind === 'markdown' || kind === 'html' || kind === 'csv' || vector;
  const copyable =
    ['markdown', 'html', 'csv', 'text'].includes(kind ?? '') &&
    (ownedArtifactUrl(current.url) || localPreviewUrl(current.url));
  const download =
    current.downloadUrl && ownedArtifactUrl(current.downloadUrl) ? current.downloadUrl : null;
  const overlay = expanded || (pageWidth > 0 && pageWidth < minimumWidth + minimumChat + 40);
  const docked = Math.min(
    Math.max(width ?? Math.round(pageWidth * 0.5), minimumWidth),
    Math.max(minimumWidth, pageWidth - minimumChat),
  );
  useLayoutEffect(() => {
    const page = root.current?.parentElement;
    if (!page) return;
    const measure = () => setPageWidth(page.clientWidth);
    const paint = () =>
      setStage(
        getComputedStyle(root.current!).getPropertyValue('--artifact-stage').trim() || '#f1f1f1',
      );
    measure();
    paint();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
      theme.disconnect();
    };
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        '--artifact-drawer-space',
        `${element.offsetWidth}px`,
      );
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--artifact-drawer-space');
    };
  }, []);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setDetail('');
    setMode('preview');
    setCopied(false);
    setClosing(false);
  }, [current.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const close = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) onClose();
    else setClosing(true);
  }, [onClose]);
  useEffect(() => {
    const forward = (event: MessageEvent) => {
      if (
        event.data === 'nod:close' &&
        event.source &&
        event.source === root.current?.querySelector('iframe')?.contentWindow
      )
        close();
    };
    window.addEventListener('message', forward);
    return () => window.removeEventListener('message', forward);
  }, [close]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        document.activeElement === document.body
      )
        close();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [close]);
  const move = (next: number) => {
    if (next < 0 || next >= items.length) return;
    onSelect(items[next].id);
  };
  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if ((event.target as HTMLElement).closest('video:fullscreen')) return;
      event.preventDefault();
      close();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (
      (event.target as HTMLElement).closest(
        'input,textarea,select,audio,video,[contenteditable="true"],[data-artifact-scroll],[role="separator"],[role="tablist"]',
      )
    )
      return;
    event.preventDefault();
    move(index + (event.key === 'ArrowLeft' ? -1 : 1));
  }
  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    const page = root.current?.parentElement;
    if (!page || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = page.getBoundingClientRect().right;
    let latest = docked;
    page.classList.add('is-resizing-artifact');
    const follow = (move: PointerEvent) => {
      latest = Math.round(
        Math.min(Math.max(right - move.clientX, minimumWidth), page.clientWidth - minimumChat),
      );
      setWidth(latest);
    };
    const stop = () => {
      page.classList.remove('is-resizing-artifact');
      handle.removeEventListener('pointermove', follow);
      writeUiPreference('nod.artifact-width', String(latest));
    };
    handle.addEventListener('pointermove', follow);
    handle.addEventListener('pointerup', stop, { once: true });
    handle.addEventListener('pointercancel', stop, { once: true });
  }
  async function copy() {
    try {
      const response = await fetch(current.url, { credentials: 'same-origin' });
      if (!response.ok) return;
      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
    } catch {}
  }
  const meta = [fileType(current.name), detail, fileSize(current.size)].filter(Boolean).join(' · ');
  return (
    <aside
      ref={root}
      className={`artifact-drawer${overlay ? ' is-overlay' : ''}${closing ? ' is-closing' : ''}`}
      style={overlay ? undefined : { width: docked, ['--artifact-width' as string]: `${docked}px` }}
      aria-label={current.name}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onClose();
      }}
    >
      {!overlay && (
        <div
          className="artifact-drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          aria-valuemin={minimumWidth}
          aria-valuemax={Math.max(minimumWidth, pageWidth - minimumChat)}
          aria-valuenow={docked}
          tabIndex={0}
          onPointerDown={resize}
          onDoubleClick={() => {
            setWidth(null);
            writeUiPreference('nod.artifact-width', '');
          }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const next = Math.min(
              Math.max(docked + (event.key === 'ArrowLeft' ? 24 : -24), minimumWidth),
              pageWidth - minimumChat,
            );
            setWidth(next);
            writeUiPreference('nod.artifact-width', String(next));
          }}
        />
      )}
      <div className="artifact-drawer-panel">
        <header className="artifact-drawer-header">
          <FileGlyph
            name={current.name}
            mimeType={current.mimeType ?? ''}
            className="artifact-drawer-glyph"
          />
          <div className="artifact-drawer-title">
            <h2 title={current.name}>{current.name}</h2>
            <span>{meta}</span>
          </div>
          <div className="artifact-drawer-actions">
            {modes && (
              <div className="artifact-segmented" role="group" aria-label="View">
                {(['preview', 'code'] as const).map((value) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={mode === value}
                    aria-label={value === 'preview' ? 'Preview' : 'Code'}
                    title={value === 'preview' ? 'Preview' : 'Code'}
                    onClick={() => setMode(value)}
                  >
                    {value === 'preview' ? <Eye size={16} /> : <CodeXml size={16} />}
                  </button>
                ))}
              </div>
            )}
            {items.length > 1 && (
              <div className="artifact-drawer-nav">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous file"
                  title="Previous file (←)"
                  disabled={index <= 0}
                  onClick={() => move(index - 1)}
                >
                  <ChevronLeft size={16} />
                </Button>
                <span aria-live="polite">
                  {index + 1} / {items.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next file"
                  title="Next file (→)"
                  disabled={index >= items.length - 1}
                  onClick={() => move(index + 1)}
                >
                  <ChevronRight size={16} />
                </Button>
              </div>
            )}
            {copyable && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={copied ? 'Copied' : 'Copy contents'}
                title={copied ? 'Copied' : 'Copy contents'}
                onClick={() => void copy()}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </Button>
            )}
            {download && (
              <Button variant="ghost" size="icon" asChild>
                <a
                  href={download}
                  download={current.name}
                  aria-label={`Download ${current.name}`}
                  title="Download"
                >
                  <Download size={16} />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="artifact-drawer-expand"
              aria-label={expanded ? 'Show chat' : 'Full width'}
              aria-pressed={expanded}
              title={expanded ? 'Show chat' : 'Full width'}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close preview"
              title="Close (Esc)"
              onClick={close}
            >
              <X size={16} />
            </Button>
          </div>
        </header>
        <div className="artifact-drawer-body" key={`${current.id}:${current.url}`}>
          <ArtifactView item={current} mode={mode} stage={stage} onDetail={setDetail} />
        </div>
      </div>
    </aside>
  );
}

export function ArtifactWorkspace({
  files,
  className,
  children,
}: {
  files: ImagePreview[];
  className: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ id: string; source?: 'drafts' } | null>(null);
  const [drafts, setDrafts] = useState<ImagePreview[]>([]);
  const trigger = useRef<AttachmentTrigger | null>(null);
  const items = state?.source === 'drafts' ? drafts : files;
  const current = state ? items.find((item) => item.id === state.id) : undefined;
  const open = useCallback((id: string, from?: AttachmentTrigger, source?: 'drafts') => {
    trigger.current = from ?? null;
    setState({ id, source });
  }, []);
  const close = useCallback(() => {
    setState(null);
    restoreAttachmentFocus(trigger.current);
  }, []);
  const value = useMemo(
    () => ({ selectedId: current?.id ?? null, open, setDrafts }),
    [current?.id, open],
  );
  return (
    <ArtifactDrawerContext.Provider value={value}>
      <div className={className}>
        {children}
        {current && (
          <ArtifactDrawer
            items={items}
            current={current}
            onSelect={(id) => setState((value) => value && { ...value, id })}
            onClose={close}
          />
        )}
      </div>
    </ArtifactDrawerContext.Provider>
  );
}
