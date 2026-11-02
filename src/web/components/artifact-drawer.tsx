import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Copy,
  Eye,
  Maximize2,
  Minimize2,
  X,
} from './icons';
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
import { FileActions, fileDrag, prepareFile } from './file-actions';
import { apiResponse } from '../lib/api';
import { Button } from './ui';
import { Tooltip } from './tooltip';
import { SharedMessageCard } from './shared-message-card';
import { StickerPlayer } from './sticker-player';
import { AudioPlayer } from './audio-player';
import {
  analyticsForCurrentSession,
  captureAnalytics,
  observeAnalyticsView,
} from '../lib/analytics';
import { AttachmentVideo } from './attachment-video';
import { MessagePresentation } from './message-presentation';
import { presentationText } from '../../shared/presentation';

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
        draggable
        onDragStart={(event) => fileDrag(event, item)}
        src={item.url}
        alt={item.name}
        className={vectorImage(item.mimeType ?? '', item.name) ? 'is-vector' : undefined}
        onLoad={(event) => {
          const image = event.currentTarget;
          onDetail(`${image.naturalWidth} × ${image.naturalHeight}`);
          setZoomable(!fits(image));
        }}
        onPointerEnter={(event) => {
          prepareFile(item);
          setZoomable(zoomed || !fits(event.currentTarget));
        }}
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
      <AttachmentVideo
        item={item}
        onMetadata={(video) => {
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
  if (item.presentation)
    return (
      <div className="artifact-stage is-presentation" data-artifact-scroll="">
        <MessagePresentation
          value={item.presentation}
          analyticsKey={item.id.slice('presentation:'.length)}
        />
      </div>
    );
  if (
    item.source === 'location' ||
    item.source === 'contact' ||
    item.name === 'location.json' ||
    /\.vcf$/i.test(item.name)
  )
    return (
      <div className="artifact-stage">
        <SharedMessageCard item={item} />
      </div>
    );
  if (!kind) return <PreviewUnavailable item={item} message="No preview for this file type" />;
  if (kind === 'sticker')
    return (
      <div className="artifact-stage is-sticker">
        <StickerPlayer item={item} onError={fail} />
      </div>
    );
  if (kind === 'image' && mode === 'code' && ownedArtifactUrl(item.url))
    return <AttachmentData item={item} kind="text" mode="code" stage={stage} onDetail={onDetail} />;
  if (kind === 'image') return <ImageView item={item} onDetail={onDetail} onError={fail} />;
  if (kind === 'video') return <VideoView item={item} onDetail={onDetail} onError={fail} />;
  if (kind === 'audio')
    return (
      <div className="artifact-stage is-audio">
        <AudioPlayer item={item} onDuration={(seconds) => onDetail(duration(seconds))} />
      </div>
    );
  if (kind === 'pdf') return <PdfPreview url={item.url} onDetail={onDetail} />;
  return <AttachmentData item={item} kind={kind} mode={mode} stage={stage} onDetail={onDetail} />;
});

function storedWidth() {
  const value = Number(readUiPreference('nod.artifact-width'));
  return Number.isFinite(value) && value >= minimumWidth ? value : null;
}

function RetainedArtifact({
  item,
  mode,
  stage,
  report,
}: {
  item: ImagePreview;
  mode: 'preview' | 'code';
  stage: string;
  report(id: string, detail: string): void;
}) {
  const onDetail = useCallback((value: string) => report(item.id, value), [item.id, report]);
  return <ArtifactView item={item} mode={mode} stage={stage} onDetail={onDetail} />;
}

function ArtifactDrawer({
  items,
  current,
  onSelect,
  onClose,
  visible = true,
}: {
  visible?: boolean;
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
  const [details, setDetails] = useState<Record<string, string>>({});
  const detail = details[current.id] ?? '';
  const reportDetail = useCallback(
    (id: string, value: string) =>
      setDetails((values) => (values[id] === value ? values : { ...values, [id]: value })),
    [],
  );
  const [copyError, setCopyError] = useState('');
  const viewed = useRef<ImagePreview[]>([]);
  const modesByFile = useRef(new Map<string, 'preview' | 'code'>());
  viewed.current = [
    ...viewed.current.filter(
      (item) => item.id !== current.id && items.some((value) => value.id === item.id),
    ),
    current,
  ].slice(-8);
  while (
    viewed.current.length > 1 &&
    viewed.current.reduce((total, item) => total + item.size, 0) > 90 * 1024 * 1024
  )
    viewed.current.shift();
  modesByFile.current.set(current.id, mode);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const [stage, setStage] = useState('#f1f1f1');
  const index = items.indexOf(current);
  const kind = current.presentation ? null : attachmentKind(current.mimeType ?? '', current.name);
  useEffect(() => {
    if (!visible || !root.current || current.presentation) return;
    return observeAnalyticsView(root.current, `${current.id}:drawer`, 'artifact_viewed', {
      kind: kind ?? 'file',
      location: 'drawer',
    });
  }, [current.id, current.presentation, kind, visible]);
  const vector = kind === 'image' && vectorImage(current.mimeType ?? '', current.name);
  const modes =
    kind === 'markdown' || kind === 'html' || kind === 'csv' || kind === 'n8n-workflow' || vector;
  const copyable =
    Boolean(current.presentation) ||
    (['markdown', 'html', 'csv', 'text', 'n8n-workflow'].includes(kind ?? '') &&
      (ownedArtifactUrl(current.url) || localPreviewUrl(current.url)));

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
    if (visible && !root.current?.contains(document.activeElement))
      root.current?.focus({ preventScroll: true });
  }, [current.id, visible]);
  useEffect(() => {
    root.current?.querySelectorAll<HTMLMediaElement>('audio,video').forEach((media) => {
      if (!visible || media.closest('.artifact-retained[hidden]')) media.pause();
    });
  }, [current.id, visible]);
  useEffect(() => {
    setMode('preview');
    setCopied(false);
    setCopyError('');
    setClosing(false);
  }, [current.id, visible]);
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
  const move = (next: number) => {
    if (next < 0 || next >= items.length) return;
    onSelect(items[next].id);
  };
  useEffect(() => {
    if (!visible) return;
    const navigate = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        !(target instanceof Element) ||
        (!root.current?.contains(target) && target !== document.body)
      )
        return;
      if (event.key === 'Escape') {
        if (target.closest('video:fullscreen')) return;
        event.preventDefault();
        close();
        return;
      }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (window.getSelection()?.toString()) return;
      if (
        target.closest(
          'input,textarea,select,audio,video,[contenteditable]:not([contenteditable="false"]),[role="separator"],[role="slider"],[role="tablist"],[role="listbox"],[role="menu"],[role="tree"],[role="grid"]',
        ) ||
        (target.closest('.artifact-drawer-body') && target.closest('button,a,[role="button"]'))
      )
        return;
      const scroll = target.closest<HTMLElement>('[data-artifact-scroll]');
      if (
        scroll &&
        scroll.scrollWidth > scroll.clientWidth + 1 &&
        ['auto', 'scroll'].includes(getComputedStyle(scroll).overflowX)
      )
        return;
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (next < 0 || next >= items.length) return;
      event.preventDefault();
      onSelect(items[next].id);
    };
    document.addEventListener('keydown', navigate);
    return () => document.removeEventListener('keydown', navigate);
  }, [close, index, items, onSelect, visible]);
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
    const capture = analyticsForCurrentSession();
    try {
      setCopyError('');
      if (current.presentation) {
        await navigator.clipboard.writeText(presentationText(current.presentation));
        capture('presentation_action', {
          kind: current.presentation.type,
          location: 'drawer',
          action: 'copy',
        });
      } else {
        const response = await apiResponse(current.url);
        if (!response.ok) throw new Error('The file could not be loaded.');
        await navigator.clipboard.writeText(await response.text());
        capture('artifact_action', { kind: kind ?? 'file', location: 'drawer', action: 'copy' });
      }
      setCopied(true);
    } catch {
      setCopyError('Could not copy. Select the text or download the file.');
    }
  }
  const meta = current.presentation
    ? current.presentation.type.charAt(0).toUpperCase() + current.presentation.type.slice(1)
    : [fileType(current.name), detail, fileSize(current.size)].filter(Boolean).join(' · ');
  return (
    <aside
      ref={root}
      hidden={!visible}
      className={`artifact-drawer${overlay ? ' is-overlay' : ''}${closing ? ' is-closing' : ''}`}
      style={overlay ? undefined : { width: docked, ['--artifact-width' as string]: `${docked}px` }}
      aria-label={current.name}
      tabIndex={-1}
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
          <Tooltip content={current.presentation ? undefined : `Drag ${current.name}`}>
            <span
              className="artifact-drawer-glyph"
              draggable={!current.presentation}
              onPointerEnter={() => !current.presentation && prepareFile(current)}
              onDragStart={(event) => !current.presentation && fileDrag(event, current)}
            >
              <FileGlyph name={current.name} mimeType={current.mimeType ?? ''} />
            </span>
          </Tooltip>
          <div className="artifact-drawer-title">
            <h2>
              {items.length > 1 ? (
                <Tooltip content={current.name}>
                  <select
                    aria-label="Choose a file"
                    value={current.id}
                    onChange={(event) => onSelect(event.target.value)}
                  >
                    {items.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Tooltip>
              ) : (
                <Tooltip content={current.name}>
                  <span>{current.name}</span>
                </Tooltip>
              )}
            </h2>
            <span>{meta}</span>
          </div>
          <div className="artifact-drawer-actions">
            {modes && (
              <div className="artifact-segmented" role="group" aria-label="View">
                {(['preview', 'code'] as const).map((value) => (
                  <Tooltip content={value === 'preview' ? 'Preview' : 'Code'} key={value}>
                    <button
                      type="button"
                      aria-pressed={mode === value}
                      aria-label={value === 'preview' ? 'Preview' : 'Code'}
                      onClick={() => setMode(value)}
                    >
                      {value === 'preview' ? <Eye size={16} /> : <CodeXml size={16} />}
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
            {items.length > 1 && (
              <div className="artifact-drawer-nav">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous file"
                  title="Previous file"
                  shortcut="←"
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
                  title="Next file"
                  shortcut="→"
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
            {!current.presentation && <FileActions item={current} location="drawer" />}
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
              title="Close"
              shortcut="Esc"
              onClick={close}
            >
              <X size={16} />
            </Button>
          </div>
        </header>
        {copyError && <p role="status">{copyError}</p>}
        <div className="artifact-drawer-body">
          {viewed.current.map((item) => (
            <div
              key={`${item.id}:${item.url}`}
              hidden={item.id !== current.id}
              className="artifact-retained"
            >
              <RetainedArtifact
                item={item}
                mode={modesByFile.current.get(item.id) ?? 'preview'}
                stage={stage}
                report={reportDetail}
              />
            </div>
          ))}
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
  const retained = useRef<ImagePreview | null>(null);
  const current = state ? items.find((item) => item.id === state.id) : undefined;
  if (current) retained.current = current;
  const displayed =
    current ?? (retained.current && items.find((item) => item.id === retained.current!.id));
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
      <div
        className={className}
        onClick={(event) => {
          if (event.defaultPrevented || !(event.target instanceof Element)) return;
          const link = event.target.closest<HTMLAnchorElement>('a[download]');
          const url = link?.getAttribute('href');
          if (!url || !ownedArtifactUrl(url)) return;
          const file = [...files, ...drafts].find(
            (item) => item.url === url || item.downloadUrl === url,
          );
          if (!file) return;
          captureAnalytics('artifact_action', {
            kind: attachmentKind(file.mimeType ?? '', file.name) ?? 'file',
            location: link?.closest('.artifact-drawer') ? 'drawer' : 'message',
            action: 'download_requested',
          });
        }}
      >
        {children}
        {displayed && (
          <ArtifactDrawer
            visible={Boolean(current)}
            items={items}
            current={displayed}
            onSelect={(id) => setState({ id, source: state?.source })}
            onClose={close}
          />
        )}
      </div>
    </ArtifactDrawerContext.Provider>
  );
}
