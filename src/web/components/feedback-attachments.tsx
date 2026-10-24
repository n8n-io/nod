import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import {
  FileJson,
  FileSpreadsheet,
  FileText,
  Hand,
  Highlighter,
  MessageSquare,
  MousePointer2,
  Minus,
  PenLine,
  Plus,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Undo2,
  X,
} from './icons';
import { feedbackLimits } from '../../shared/feedback';
import {
  feedbackAnnotationColors as annotationColors,
  type FeedbackAnnotationColor as AnnotationColor,
  type FeedbackAttachment,
  type FeedbackCommentMark as CommentMark,
  type FeedbackDrawingMark as DrawingMark,
  type FeedbackMark as Mark,
  type FeedbackPoint as Point,
} from '../lib/feedback-attachment';
import { Button, Dialog, DialogContent, DialogTitle } from './ui';

type Bounds = { x: number; y: number; width: number; height: number };
type Corner = 'nw' | 'ne' | 'sw' | 'se';
const resizeCorners: { corner: Corner; label: string }[] = [
  { corner: 'nw', label: 'top left' },
  { corner: 'ne', label: 'top right' },
  { corner: 'sw', label: 'bottom left' },
  { corner: 'se', label: 'bottom right' },
];

function commentLayout(
  context: CanvasRenderingContext2D,
  mark: CommentMark,
  bounds: { width: number; height: number },
) {
  const padding = mark.fontSize * 0.7;
  const lineHeight = mark.fontSize * 1.4;
  const maxWidth = Math.min(bounds.width, mark.width ?? mark.fontSize * 22);
  const textWidth = maxWidth - padding * 2;
  context.font = `${mark.fontSize}px system-ui, sans-serif`;
  const lines: string[] = [];
  for (const paragraph of mark.text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= textWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const character of word) {
        if (line && context.measureText(line + character).width > textWidth) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  const width = Math.min(
    maxWidth,
    Math.max(mark.fontSize * 3, ...lines.map((line) => context.measureText(line).width)) +
      padding * 2,
  );
  const height = lines.length * lineHeight + padding * 2;
  return {
    x: Math.max(0, Math.min(mark.point.x, bounds.width - width)),
    y: Math.max(0, Math.min(mark.point.y, bounds.height - height)),
    width,
    height,
    padding,
    lineHeight,
    lines,
    fits:
      height <= bounds.height &&
      lines.every((line) => context.measureText(line).width <= textWidth),
  };
}

function markBounds(
  context: CanvasRenderingContext2D,
  mark: Mark,
  canvas: HTMLCanvasElement,
): Bounds {
  if (mark.tool === 'comment') return commentLayout(context, mark, canvas);
  if (mark.tool === 'redact')
    return {
      x: Math.min(mark.from.x, mark.to.x),
      y: Math.min(mark.from.y, mark.to.y),
      width: Math.abs(mark.to.x - mark.from.x),
      height: Math.abs(mark.to.y - mark.from.y),
    };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of mark.points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return {
    x: left - mark.width / 2,
    y: top - mark.width / 2,
    width: right - left + mark.width,
    height: bottom - top + mark.width,
  };
}

function hitMark(
  context: CanvasRenderingContext2D,
  mark: Mark,
  canvas: HTMLCanvasElement,
  point: Point,
  tolerance: number,
) {
  if (mark.tool === 'redact' || mark.tool === 'comment') {
    const box = markBounds(context, mark, canvas);
    return (
      point.x >= box.x - tolerance &&
      point.x <= box.x + box.width + tolerance &&
      point.y >= box.y - tolerance &&
      point.y <= box.y + box.height + tolerance
    );
  }
  return mark.points.some((from, index) => {
    const to = mark.points[index + 1] ?? from;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = dx * dx + dy * dy;
    const fraction = length
      ? Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length))
      : 0;
    return (
      Math.hypot(point.x - from.x - fraction * dx, point.y - from.y - fraction * dy) <=
      mark.width / 2 + tolerance
    );
  });
}

function translateMark(
  context: CanvasRenderingContext2D,
  mark: Mark,
  canvas: HTMLCanvasElement,
  delta: Point,
): Mark {
  const box = markBounds(context, mark, canvas);
  const dx = Math.max(
    -Math.max(0, box.x),
    Math.min(delta.x, canvas.width - Math.min(canvas.width, box.x + box.width)),
  );
  const dy = Math.max(
    -Math.max(0, box.y),
    Math.min(delta.y, canvas.height - Math.min(canvas.height, box.y + box.height)),
  );
  if (!dx && !dy) return mark;
  const move = (point: Point) => ({ x: point.x + dx, y: point.y + dy });
  if (mark.tool === 'comment') return { ...mark, point: { x: box.x + dx, y: box.y + dy } };
  if (mark.tool === 'redact') return { ...mark, from: move(mark.from), to: move(mark.to) };
  return { ...mark, points: mark.points.map(move) };
}

function resizeMark(
  context: CanvasRenderingContext2D,
  mark: Mark,
  canvas: HTMLCanvasElement,
  corner: Corner,
  delta: Point,
  minimum: number,
): Mark {
  const box = markBounds(context, mark, canvas);
  const east = corner.includes('e');
  const south = corner.includes('s');
  const anchor = { x: east ? box.x : box.x + box.width, y: south ? box.y : box.y + box.height };
  const maxWidth = east
    ? Math.max(canvas.width, box.x + box.width) - anchor.x
    : anchor.x - Math.min(0, box.x);
  const maxHeight = south
    ? Math.max(canvas.height, box.y + box.height) - anchor.y
    : anchor.y - Math.min(0, box.y);
  const horizontal = east ? delta.x : -delta.x;
  const vertical = south ? delta.y : -delta.y;
  if (mark.tool === 'redact') {
    const width = Math.max(
      Math.min(minimum, box.width),
      Math.min(box.width + horizontal, maxWidth),
    );
    const height = Math.max(
      Math.min(minimum, box.height),
      Math.min(box.height + vertical, maxHeight),
    );
    if (width === box.width && height === box.height) return mark;
    const from = { x: east ? anchor.x : anchor.x - width, y: south ? anchor.y : anchor.y - height };
    return { ...mark, from, to: { x: from.x + width, y: from.y + height } };
  }
  const minScale = Math.min(
    1,
    Math.max(
      (mark.tool === 'pen' ? minimum / 12 : minimum) / box.width,
      (mark.tool === 'pen' ? minimum / 12 : minimum) / box.height,
      mark.tool === 'comment' ? (minimum * 5) / 6 / mark.fontSize : 0,
    ),
  );
  const desired =
    1 +
    (horizontal * box.width + vertical * box.height) /
      (box.width * box.width + box.height * box.height);
  let scale = Math.max(minScale, Math.min(desired, maxWidth / box.width, maxHeight / box.height));
  if (scale === 1) return mark;
  if (mark.tool !== 'comment')
    return {
      ...mark,
      points: mark.points.map((point) => ({
        x: anchor.x + (point.x - anchor.x) * scale,
        y: anchor.y + (point.y - anchor.y) * scale,
      })),
      width: mark.width * scale,
    };
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = { ...mark, fontSize: mark.fontSize * scale, width: box.width * scale };
    const note = commentLayout(context, next, canvas);
    if (note.fits && note.width <= maxWidth && note.height <= maxHeight)
      return {
        ...next,
        point: {
          x: east ? anchor.x : anchor.x - note.width,
          y: south ? anchor.y : anchor.y - note.height,
        },
      };
    scale *= Math.min(maxWidth / note.width, maxHeight / note.height) * 0.999;
    if (scale < minScale) break;
  }
  return mark;
}

function useImageUrl(file: File) {
  const [image, setImage] = useState<{ file: File; url: string }>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImage({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return image?.file === file ? image.url : undefined;
}

function paint(canvas: HTMLCanvasElement, image: HTMLImageElement, marks: Mark[]) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image editing is unavailable in this browser.');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  for (const mark of marks) {
    context.save();
    if (mark.tool === 'redact') {
      const x = Math.floor(Math.min(mark.from.x, mark.to.x));
      const y = Math.floor(Math.min(mark.from.y, mark.to.y));
      context.fillStyle = '#000000';
      context.fillRect(
        x,
        y,
        Math.ceil(Math.max(mark.from.x, mark.to.x)) - x,
        Math.ceil(Math.max(mark.from.y, mark.to.y)) - y,
      );
    } else if (mark.tool === 'comment') {
      const note = commentLayout(context, mark, canvas);
      context.fillStyle = mark.color.paper;
      context.fillRect(note.x, note.y, note.width, note.height);
      context.fillStyle = mark.color.ink;
      context.fillRect(note.x, note.y, mark.fontSize * 0.2, note.height);
      context.fillStyle = '#1f2937';
      context.textBaseline = 'top';
      note.lines.forEach((line, index) =>
        context.fillText(
          line,
          note.x + note.padding,
          note.y + note.padding + index * note.lineHeight,
        ),
      );
    } else {
      context.globalAlpha = mark.tool === 'pen' ? 1 : 0.4;
      context.strokeStyle = mark.color.ink;
      context.fillStyle = mark.color.ink;
      context.lineWidth = mark.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      if (
        mark.points.every((point) => point.x === mark.points[0].x && point.y === mark.points[0].y)
      ) {
        context.arc(mark.points[0].x, mark.points[0].y, mark.width / 2, 0, 2 * Math.PI);
        context.fill();
      } else {
        context.moveTo(mark.points[0].x, mark.points[0].y);
        for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y);
        context.stroke();
      }
    }
    context.restore();
  }
}

async function encodeImage(canvas: HTMLCanvasElement, name: string) {
  const encode = (target: HTMLCanvasElement, type: string, quality?: number) =>
    new Promise<Blob>((resolve, reject) =>
      target.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t save this image.'))),
        type,
        quality,
      ),
    );
  let blob = await encode(canvas, 'image/png');
  if (blob.size > feedbackLimits.attachmentBytes) {
    const opaque = document.createElement('canvas');
    opaque.width = canvas.width;
    opaque.height = canvas.height;
    const context = opaque.getContext('2d');
    if (!context) throw new Error('Couldn’t save this image.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, opaque.width, opaque.height);
    context.drawImage(canvas, 0, 0);
    for (const quality of [0.9, 0.75, 0.6, 0.45]) {
      blob = await encode(opaque, 'image/jpeg', quality);
      if (blob.size <= feedbackLimits.attachmentBytes) break;
    }
  }
  if (blob.size > feedbackLimits.attachmentBytes)
    throw new Error('The edited image is larger than 2 MB. Your original is unchanged.');
  const base = name
    .replace(/\.[^.]*$/, '')
    .replace(/[/\\\u0000-\u001f]/g, '-')
    .slice(0, 150);
  return new File([blob], `${base || 'screenshot'}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, {
    type: blob.type,
  });
}

function AttachmentEditor({
  attachment,
  disabled,
  onClose,
  onSave,
}: {
  attachment: FeedbackAttachment;
  disabled: boolean;
  onClose(): void;
  onSave(attachment: FeedbackAttachment): boolean;
}) {
  const file = attachment.image?.original ?? attachment.file;
  const url = useImageUrl(file);
  const description = useId();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const commentEditor = useRef<HTMLDivElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const marks = useRef<Mark[]>(attachment.image?.marks ?? []);
  const savedMarks = useRef(JSON.stringify(marks.current));
  const history = useRef<Mark[][]>([]);
  const future = useRef<Mark[][]>([]);
  const drawing = useRef<{ pointer: number; mark: DrawingMark } | null>(null);
  const moving = useRef<{
    pointer: number;
    index: number;
    from: Point;
    original: Mark;
    mark: Mark;
    moved: boolean;
    corner?: Corner;
  } | null>(null);
  const pan = useRef<{ pointer: number; from: Point; scroll: Point } | null>(null);
  const zoomAnchor = useRef<{ image: Point; viewport: Point } | null>(null);
  const zoomValue = useRef(1);
  const toolColors = useRef<Partial<Record<Mark['tool'], AnnotationColor>>>({
    highlight: annotationColors[0],
    pen: annotationColors[4],
    comment: annotationColors[0],
  });
  const mounted = useRef(true);
  const [tool, setTool] = useState<Mark['tool'] | 'move'>('highlight');
  const [selectedMark, setSelectedMark] = useState<number>();
  const [movePreview, setMovePreview] = useState<{ index: number; mark: Mark; corner?: Corner }>();
  const [color, setColor] = useState<AnnotationColor>(annotationColors[0]);
  const [draft, setDraft] = useState<{ mark: CommentMark; index?: number }>();
  const [editorPosition, setEditorPosition] = useState<Point>({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [panning, setPanning] = useState(false);
  const [scroll, setScroll] = useState<Point>({ x: 0, y: 0 });
  const [fit, setFit] = useState<{
    width: number;
    height: number;
    areaWidth: number;
    areaHeight: number;
  }>();
  const [historySize, setHistorySize] = useState(0);
  const [futureSize, setFutureSize] = useState(0);
  const [discard, setDiscard] = useState<'editor' | 'comment'>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || saving || !ready;
  const dirty = JSON.stringify(marks.current) !== savedMarks.current;
  const draftChanged =
    !!draft &&
    (draft.index === undefined
      ? !!draft.mark.text.trim()
      : JSON.stringify(draft.mark) !== JSON.stringify(marks.current[draft.index]));
  const fitted = useMemo(
    () =>
      fit && {
        width: fit.width * zoom,
        height: fit.height * zoom,
        areaWidth: Math.max(fit.areaWidth, fit.width * zoom),
        areaHeight: Math.max(fit.areaHeight, fit.height * zoom),
      },
    [fit, zoom],
  );
  const fitScale = fit && canvas.current ? fit.width / canvas.current.width : 1;
  const minZoom = Math.min(1, 0.25 / fitScale);
  const maxZoom = Math.max(1, 4 / fitScale);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        draftChanged ||
        JSON.stringify(marks.current) !== savedMarks.current ||
        drawing.current ||
        moving.current?.moved
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draftChanged]);

  useEffect(() => {
    if (!url) return;
    let active = true;
    const source = new Image();
    source.onload = () => {
      if (!active || !canvas.current) return;
      if (
        source.naturalWidth > 16_384 ||
        source.naturalHeight > 16_384 ||
        source.naturalWidth * source.naturalHeight > 32_000_000
      ) {
        setError('This image is too large to edit. Your original is unchanged.');
        return;
      }
      try {
        canvas.current.width = source.naturalWidth;
        canvas.current.height = source.naturalHeight;
        image.current = source;
        paint(canvas.current, source, marks.current);
        setReady(true);
      } catch {
        setError('Couldn’t open this image for editing. Your original is unchanged.');
      }
    };
    source.onerror = () => {
      if (active) setError('Couldn’t open this image. Your original is unchanged.');
    };
    source.src = url;
    return () => {
      active = false;
      image.current = null;
    };
  }, [url]);

  useLayoutEffect(() => {
    const area = stage.current;
    const target = canvas.current;
    if (!ready || !area || !target) return;
    const fit = () => {
      if (!area.clientWidth || !area.clientHeight) return;
      const scale = Math.min(area.clientWidth / target.width, area.clientHeight / target.height);
      const next = {
        width: target.width * scale,
        height: target.height * scale,
        areaWidth: area.clientWidth,
        areaHeight: area.clientHeight,
      };
      setFit((current) =>
        current?.width === next.width &&
        current.height === next.height &&
        current.areaWidth === next.areaWidth &&
        current.areaHeight === next.areaHeight
          ? current
          : next,
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, [ready]);

  useLayoutEffect(() => {
    const area = stage.current;
    const anchor = zoomAnchor.current;
    if (!area || !fitted || !anchor) return;
    area.scrollLeft = Math.max(
      0,
      Math.min(
        fitted.areaWidth - area.clientWidth,
        (fitted.areaWidth - fitted.width) / 2 + anchor.image.x * fitted.width - anchor.viewport.x,
      ),
    );
    area.scrollTop = Math.max(
      0,
      Math.min(
        fitted.areaHeight - area.clientHeight,
        (fitted.areaHeight - fitted.height) / 2 +
          anchor.image.y * fitted.height -
          anchor.viewport.y,
      ),
    );
    zoomAnchor.current = null;
    setScroll({ x: area.scrollLeft, y: area.scrollTop });
  }, [fitted]);

  useEffect(() => {
    const area = stage.current;
    if (!area) return;
    const wheel = (event: WheelEvent) => {
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLInputElement
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? area.clientHeight : 1);
      changeZoom(zoomValue.current * Math.exp(-delta * 0.005), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    area.addEventListener('wheel', wheel, { passive: false });
    return () => area.removeEventListener('wheel', wheel);
  }, [fitted, locked, draft]);

  useEffect(() => {
    const release = () => {
      setSpaceHeld(false);
      endPan();
    };
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, []);

  useLayoutEffect(() => {
    const editor = commentEditor.current;
    const target = canvas.current;
    const area = stage.current;
    if (!draft || !fitted || !editor || !target || !area) return;
    const x =
      (fitted.areaWidth - fitted.width) / 2 + (draft.mark.point.x / target.width) * fitted.width;
    const y =
      (fitted.areaHeight - fitted.height) / 2 +
      (draft.mark.point.y / target.height) * fitted.height;
    setEditorPosition({
      x: Math.max(
        area.scrollLeft,
        Math.min(x, area.scrollLeft + area.clientWidth - editor.offsetWidth),
      ),
      y: Math.max(
        area.scrollTop,
        Math.min(y, area.scrollTop + area.clientHeight - editor.offsetHeight),
      ),
    });
  }, [draft, fitted, scroll]);

  useEffect(() => {
    if (draft) commentInput.current?.focus({ preventScroll: true });
  }, [!!draft]);

  function changeTool(next: typeof tool) {
    setPanMode(false);
    setTool(next);
    if (next !== 'move' && next !== 'comment') setSelectedMark(undefined);
    if (next !== 'move' && toolColors.current[next]) setColor(toolColors.current[next]!);
    canvas.current?.focus({ preventScroll: true });
  }

  function changeZoom(value: number, pointer?: Point) {
    const area = stage.current;
    const target = canvas.current;
    if (
      locked ||
      draft ||
      drawing.current ||
      moving.current ||
      pan.current ||
      !area ||
      !target ||
      !fitted
    )
      return;
    const next = Math.max(minZoom, Math.min(maxZoom, value));
    if (next === zoomValue.current) return;
    const viewport = area.getBoundingClientRect();
    const screen = pointer ?? {
      x: viewport.left + area.clientWidth / 2,
      y: viewport.top + area.clientHeight / 2,
    };
    const rect = target.getBoundingClientRect();
    zoomAnchor.current = {
      image: {
        x: Math.max(0, Math.min(1, (screen.x - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (screen.y - rect.top) / rect.height)),
      },
      viewport: { x: screen.x - viewport.left, y: screen.y - viewport.top },
    };
    zoomValue.current = next;
    setZoom(next);
    target.focus({ preventScroll: true });
  }

  function beginPan(event: PointerEvent<HTMLElement>) {
    const area = stage.current;
    if (
      locked ||
      draft ||
      drawing.current ||
      moving.current ||
      pan.current ||
      !area ||
      event.isPrimary === false ||
      (event.button !== 0 && event.button !== 1) ||
      (area.scrollWidth <= area.clientWidth && area.scrollHeight <= area.clientHeight)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    pan.current = {
      pointer: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      scroll: { x: area.scrollLeft, y: area.scrollTop },
    };
    setPanning(true);
    canvas.current?.focus({ preventScroll: true });
    area.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const current = pan.current;
    if (!current || current.pointer !== event.pointerId || locked) return;
    event.preventDefault();
    event.stopPropagation();
    const area = event.currentTarget;
    area.scrollLeft = current.scroll.x - event.clientX + current.from.x;
    area.scrollTop = current.scroll.y - event.clientY + current.from.y;
    setScroll({ x: area.scrollLeft, y: area.scrollTop });
  }

  function endPan(cancel = false) {
    const current = pan.current;
    const area = stage.current;
    pan.current = null;
    setPanning(false);
    if (!current || !area) return;
    if (cancel) {
      area.scrollLeft = current.scroll.x;
      area.scrollTop = current.scroll.y;
      setScroll(current.scroll);
    }
    if (area.hasPointerCapture(current.pointer)) area.releasePointerCapture(current.pointer);
  }

  function redraw() {
    if (canvas.current && image.current)
      paint(canvas.current, image.current, [
        ...marks.current.map((mark, index) =>
          moving.current?.index === index ? moving.current.mark : mark,
        ),
        ...(drawing.current ? [drawing.current.mark] : []),
      ]);
  }

  function position(target: HTMLCanvasElement, event: { clientX: number; clientY: number }): Point {
    const rect = target.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(target.width, ((event.clientX - rect.left) / rect.width) * target.width),
      ),
      y: Math.max(
        0,
        Math.min(target.height, ((event.clientY - rect.top) / rect.height) * target.height),
      ),
    };
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (moving.current) {
      const current = moving.current;
      const target = canvas.current;
      const context = target?.getContext('2d');
      if (locked || current.pointer !== event.pointerId || !target || !context || !fitted) return;
      const point = position(target, event);
      const delta = { x: point.x - current.from.x, y: point.y - current.from.y };
      if (!current.moved && Math.hypot(delta.x, delta.y) < (3 * target.width) / fitted.width)
        return;
      current.moved = true;
      current.mark = current.corner
        ? resizeMark(
            context,
            current.original,
            target,
            current.corner,
            delta,
            (12 * target.width) / fitted.width,
          )
        : translateMark(context, current.original, target, delta);
      setMovePreview({ index: current.index, mark: current.mark, corner: current.corner });
      redraw();
      return;
    }
    const current = drawing.current;
    if (locked || !current || current.pointer !== event.pointerId) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of [...samples, event]) {
      const point = position(event.currentTarget, sample);
      if (current.mark.tool !== 'redact') {
        const previous = current.mark.points.at(-1)!;
        if (point.x !== previous.x || point.y !== previous.y) current.mark.points.push(point);
      } else current.mark.to = point;
    }
    redraw();
  }

  function finish(event: PointerEvent<HTMLCanvasElement>, cancelled = false) {
    if (moving.current?.pointer === event.pointerId) {
      const cancel = cancelled || locked || event.type === 'lostpointercapture';
      if (!cancel) move(event);
      const current = moving.current;
      endMove();
      if (!cancel && current.moved && current.mark !== current.original)
        changeMarks(
          marks.current.map((mark, index) => (index === current.index ? current.mark : mark)),
          current.index,
        );
      redraw();
      if (
        !cancel &&
        !current.moved &&
        !current.corner &&
        tool === 'comment' &&
        current.original.tool === 'comment'
      )
        openComment(current.original.point, current.index);
      return;
    }
    if (drawing.current?.pointer !== event.pointerId) return;
    if (!cancelled && !locked) {
      if (event.type === 'pointerup') move(event);
      const mark = drawing.current.mark;
      if (mark.tool !== 'redact' || (mark.from.x !== mark.to.x && mark.from.y !== mark.to.y))
        changeMarks([...marks.current, mark]);
    }
    drawing.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    redraw();
  }

  function changeMarks(next: Mark[], selected?: number) {
    history.current.push(marks.current);
    future.current = [];
    marks.current = next;
    setSelectedMark(selected);
    setHistorySize(history.current.length);
    setFutureSize(0);
  }

  function beginMove(event: PointerEvent<HTMLElement>, index: number, corner?: Corner) {
    const target = canvas.current;
    if (
      locked ||
      draft ||
      moving.current ||
      drawing.current ||
      event.button !== 0 ||
      event.isPrimary === false ||
      !target
    )
      return;
    event.preventDefault();
    const mark = marks.current[index];
    moving.current = {
      pointer: event.pointerId,
      index,
      from: position(target, event),
      original: mark,
      mark,
      moved: false,
      corner,
    };
    setSelectedMark(index);
    setMovePreview({ index, mark, corner });
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
  }

  function endMove() {
    const current = moving.current;
    moving.current = null;
    setMovePreview(undefined);
    if (current && canvas.current?.hasPointerCapture(current.pointer))
      canvas.current.releasePointerCapture(current.pointer);
  }

  function cancelMove() {
    endMove();
    redraw();
  }

  function closeComment() {
    setDraft(undefined);
    canvas.current?.focus({ preventScroll: true });
  }

  function requestClose(target: 'editor' | 'comment' = 'editor') {
    if (saving) return;
    if (
      draftChanged ||
      (target === 'editor' && (dirty || drawing.current || moving.current?.moved))
    ) {
      setDiscard(target);
      return;
    }
    if (target === 'comment') closeComment();
    else onClose();
  }

  function openComment(point: Point, index?: number) {
    const target = canvas.current;
    if (locked || draft || moving.current || !target || !fitted) return;
    setPanMode(false);
    setSpaceHeld(false);
    const existing = index === undefined ? undefined : marks.current[index];
    const mark: CommentMark =
      existing?.tool === 'comment'
        ? existing
        : {
            tool: 'comment',
            point,
            text: '',
            color,
            fontSize: Math.min(
              (14 * target.width) / fitted.width,
              target.height / 4,
              target.width / 4,
            ),
          };
    setColor(mark.color);
    setDraft({ mark, index });
  }

  const context = canvas.current?.getContext('2d');
  const draftLayout =
    draft && context && canvas.current
      ? commentLayout(context, { ...draft.mark, text: draft.mark.text.trim() }, canvas.current)
      : undefined;
  const selected =
    movePreview?.mark ?? (selectedMark === undefined ? undefined : marks.current[selectedMark]);
  const selectedBounds =
    selected && context && canvas.current
      ? markBounds(context, selected, canvas.current)
      : undefined;

  function saveComment() {
    if (locked || !draft || !draft.mark.text.trim() || !draftLayout?.fits) return;
    const mark = { ...draft.mark, text: draft.mark.text.trim() };
    changeMarks(
      draft.index === undefined
        ? [...marks.current, mark]
        : marks.current.map((current, index) => (index === draft.index ? mark : current)),
    );
    closeComment();
    redraw();
  }

  function navigateHistory(redo = false) {
    if (locked || draft || drawing.current || moving.current || pan.current) return;
    const from = redo ? future : history;
    const to = redo ? history : future;
    const next = from.current.pop();
    if (!next) return;
    to.current.push(marks.current);
    marks.current = next;
    setSelectedMark(undefined);
    setHistorySize(history.current.length);
    setFutureSize(future.current.length);
    redraw();
  }

  function deleteSelected() {
    if (
      locked ||
      draft ||
      drawing.current ||
      moving.current ||
      pan.current ||
      panMode ||
      spaceHeld ||
      selectedMark === undefined ||
      (tool !== 'move' && tool !== 'comment')
    )
      return;
    changeMarks(marks.current.filter((_, index) => index !== selectedMark));
    redraw();
    canvas.current?.focus({ preventScroll: true });
  }

  async function save() {
    if (
      locked ||
      draft ||
      drawing.current ||
      moving.current ||
      pan.current ||
      !dirty ||
      !canvas.current
    )
      return;
    setSaving(true);
    setError('');
    try {
      const result: FeedbackAttachment = marks.current.length
        ? {
            id: attachment.id,
            file: await encodeImage(canvas.current, file.name),
            image: { original: file, marks: marks.current },
          }
        : { id: attachment.id, file };
      if (mounted.current && !onSave(result))
        setError('The edited image exceeds the 4 MB attachment total. Your edits are preserved.');
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Couldn’t save this image.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          className="feedback-image-dialog"
          aria-describedby={description}
          data-busy={saving}
          onPaste={(event) => event.stopPropagation()}
          onDragEnter={(event) => {
            event.stopPropagation();
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDragOver={(event) => {
            event.stopPropagation();
            if (event.dataTransfer.types.includes('Files')) event.preventDefault();
          }}
          onDrop={(event) => {
            event.stopPropagation();
            if (event.dataTransfer.files.length) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (pan.current) {
              event.preventDefault();
              endPan(true);
              setSpaceHeld(false);
              return;
            }
            if (drawing.current) {
              event.preventDefault();
              const pointer = drawing.current.pointer;
              drawing.current = null;
              if (canvas.current?.hasPointerCapture(pointer))
                canvas.current.releasePointerCapture(pointer);
              redraw();
              return;
            }
            if (moving.current) {
              event.preventDefault();
              cancelMove();
              return;
            }
            if (!draft) return;
            event.preventDefault();
            requestClose('comment');
          }}
          onKeyDown={(event) => {
            if (
              event.target instanceof HTMLTextAreaElement ||
              event.target instanceof HTMLInputElement ||
              (event.target instanceof HTMLElement && event.target.isContentEditable)
            )
              return;
            if (
              (event.key === 'Delete' || event.key === 'Backspace') &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229 &&
              selectedMark !== undefined
            ) {
              event.preventDefault();
              event.stopPropagation();
              deleteSelected();
              return;
            }
            if (
              event.key === ' ' &&
              !(event.target instanceof Element && event.target.closest('button'))
            ) {
              event.preventDefault();
              setSpaceHeld(true);
              return;
            }
            if (
              (event.metaKey || event.ctrlKey) &&
              !event.altKey &&
              ['+', '=', '-', '_', '0'].includes(event.key)
            ) {
              event.preventDefault();
              event.stopPropagation();
              changeZoom(
                event.key === '0'
                  ? 1
                  : zoomValue.current * (event.key === '-' || event.key === '_' ? 0.8 : 1.25),
              );
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
              event.preventDefault();
              event.stopPropagation();
              navigateHistory(event.shiftKey);
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ') setSpaceHeld(false);
          }}
        >
          <header className="feedback-image-heading">
            <DialogTitle>Annotate image</DialogTitle>
          </header>
          <div className="feedback-image-toolbar">
            <div className="feedback-image-tools" role="group" aria-label="Image tools">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                aria-pressed={tool === 'move'}
                onClick={() => changeTool('move')}
              >
                <MousePointer2 size={15} aria-hidden="true" />
                Move
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                aria-pressed={tool === 'pen'}
                onClick={() => changeTool('pen')}
              >
                <PenLine size={16} aria-hidden="true" />
                Pen
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                aria-pressed={tool === 'highlight'}
                onClick={() => changeTool('highlight')}
              >
                <Highlighter size={16} aria-hidden="true" />
                Highlight
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                aria-pressed={tool === 'redact'}
                onClick={() => changeTool('redact')}
              >
                <Square size={14} fill="currentColor" aria-hidden="true" />
                Cover
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                aria-pressed={tool === 'comment'}
                onClick={() => changeTool('comment')}
              >
                <MessageSquare size={15} aria-hidden="true" />
                Comment
              </Button>
            </div>
            <div className="feedback-image-colors" role="group" aria-label="Annotation color">
              {annotationColors.map((option) => (
                <button
                  type="button"
                  key={option.name}
                  aria-label={option.name}
                  aria-pressed={color.name === option.name}
                  disabled={
                    locked || !!movePreview || panning || tool === 'redact' || tool === 'move'
                  }
                  style={{ backgroundColor: option.ink }}
                  onClick={() => {
                    setColor(option);
                    if (tool !== 'move') toolColors.current[tool] = option;
                    setDraft((current) =>
                      current ? { ...current, mark: { ...current.mark, color: option } } : current,
                    );
                  }}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                locked ||
                !!draft ||
                !!movePreview ||
                panning ||
                panMode ||
                spaceHeld ||
                selectedMark === undefined
              }
              onClick={deleteSelected}
            >
              <Trash2 size={16} aria-hidden="true" />
              Delete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked || !!draft || !!movePreview || panning || !historySize}
              onClick={() => navigateHistory()}
            >
              <Undo2 size={16} aria-hidden="true" />
              Undo
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked || !!draft || !!movePreview || panning || !futureSize}
              onClick={() => navigateHistory(true)}
            >
              <Redo2 size={16} aria-hidden="true" />
              Redo
            </Button>
            <span id={description} className="feedback-image-help">
              {panMode || spaceHeld
                ? 'Drag image to pan'
                : tool === 'move'
                  ? 'Drag marks to move · drag empty space to pan'
                  : tool === 'pen'
                    ? 'Draw with pen'
                    : tool === 'highlight'
                      ? 'Draw over a detail'
                      : tool === 'redact'
                        ? 'Drag over private information'
                        : 'Click to add or edit a note'}
            </span>
          </div>
          <div className="feedback-image-stage">
            <div
              className="feedback-image-area"
              ref={stage}
              data-space-pan={spaceHeld || undefined}
              data-pan-mode={panMode || undefined}
              data-panning={panning || undefined}
              onScroll={(event) =>
                setScroll({ x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })
              }
              onPointerDownCapture={(event) => {
                if (!draft && (panMode || spaceHeld || event.button === 1)) {
                  beginPan(event);
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onPointerMoveCapture={movePan}
              onPointerUpCapture={(event) => {
                if (pan.current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                endPan(locked);
              }}
              onPointerCancelCapture={(event) => {
                if (pan.current?.pointer !== event.pointerId) return;
                event.stopPropagation();
                endPan(true);
              }}
              onLostPointerCapture={(event) => {
                if (pan.current?.pointer === event.pointerId) endPan(true);
              }}
            >
              <div
                className="feedback-image-content"
                style={fitted && { width: fitted.areaWidth, height: fitted.areaHeight }}
              >
                <canvas
                  ref={canvas}
                  role="img"
                  aria-label={`Image annotation area. ${panMode || spaceHeld ? 'Drag image to pan. Arrow keys scroll the image.' : tool === 'move' ? 'Drag a mark to move it, or drag empty space to pan. Use arrow keys to move the selected mark.' : tool === 'pen' ? 'Draw with pen.' : tool === 'highlight' ? 'Draw to highlight.' : tool === 'redact' ? 'Drag to cover private details.' : 'Click or press Enter to add a comment. Drag notes to move them.'}`}
                  tabIndex={
                    (panMode || tool === 'comment' || tool === 'move') && !locked && !draft ? 0 : -1
                  }
                  data-ready={ready && !!fitted}
                  data-tool={tool}
                  data-moving={!!movePreview}
                  data-resizing={movePreview?.corner}
                  style={
                    fitted && {
                      width: fitted.width,
                      height: fitted.height,
                      left: (fitted.areaWidth - fitted.width) / 2,
                      top: (fitted.areaHeight - fitted.height) / 2,
                    }
                  }
                  onKeyDown={(event) => {
                    const directions: Record<string, Point> = {
                      ArrowLeft: { x: -1, y: 0 },
                      ArrowRight: { x: 1, y: 0 },
                      ArrowUp: { x: 0, y: -1 },
                      ArrowDown: { x: 0, y: 1 },
                    };
                    const direction = directions[event.key];
                    if (panMode || spaceHeld) {
                      const area = stage.current;
                      if (direction && area && !locked && !draft && !pan.current) {
                        event.preventDefault();
                        event.stopPropagation();
                        const distance = event.shiftKey ? 160 : 40;
                        area.scrollLeft += direction.x * distance;
                        area.scrollTop += direction.y * distance;
                        setScroll({ x: area.scrollLeft, y: area.scrollTop });
                      }
                      return;
                    }
                    if (event.key === 'Escape' && moving.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelMove();
                      return;
                    }
                    if (
                      (tool === 'move' || tool === 'comment') &&
                      !locked &&
                      !draft &&
                      !moving.current &&
                      fitted &&
                      context
                    ) {
                      if (tool === 'move' && event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelectedMark((current) =>
                          marks.current.length
                            ? current === undefined
                              ? marks.current.length - 1
                              : (current + marks.current.length - 1) % marks.current.length
                            : undefined,
                        );
                        return;
                      }
                      if (direction && selectedMark !== undefined) {
                        event.preventDefault();
                        event.stopPropagation();
                        const mark = marks.current[selectedMark];
                        const distance =
                          ((event.shiftKey ? 10 : 1) * event.currentTarget.width) / fitted.width;
                        const next = translateMark(context, mark, event.currentTarget, {
                          x: direction.x * distance,
                          y: direction.y * distance,
                        });
                        if (next !== mark)
                          changeMarks(
                            marks.current.map((current, index) =>
                              index === selectedMark ? next : current,
                            ),
                            selectedMark,
                          );
                        redraw();
                        return;
                      }
                    }
                    if (tool !== 'comment' || event.key !== 'Enter') return;
                    event.preventDefault();
                    event.stopPropagation();
                    openComment({
                      x: event.currentTarget.width / 2,
                      y: event.currentTarget.height / 2,
                    });
                  }}
                  onPointerDown={(event) => {
                    if (
                      locked ||
                      draft ||
                      !fitted ||
                      event.button !== 0 ||
                      event.isPrimary === false ||
                      drawing.current ||
                      moving.current ||
                      pan.current
                    )
                      return;
                    event.preventDefault();
                    const point = position(event.currentTarget, event);
                    if (tool === 'comment' || tool === 'move') {
                      const context = event.currentTarget.getContext('2d');
                      if (!context) return;
                      const tolerance = (4 * event.currentTarget.width) / fitted.width;
                      for (let index = marks.current.length - 1; index >= 0; index--) {
                        const mark = marks.current[index];
                        if (tool === 'comment' && mark.tool !== 'comment') continue;
                        if (!hitMark(context, mark, event.currentTarget, point, tolerance))
                          continue;
                        beginMove(event, index);
                        return;
                      }
                      setSelectedMark(undefined);
                      if (tool === 'comment') openComment(point);
                      else beginPan(event);
                      return;
                    }
                    drawing.current = {
                      pointer: event.pointerId,
                      mark:
                        tool === 'highlight' || tool === 'pen'
                          ? {
                              tool,
                              color,
                              points: [point],
                              width:
                                ((tool === 'pen' ? 3 : 16) * event.currentTarget.width) /
                                (fit?.width ?? fitted.width),
                            }
                          : { tool, from: point, to: point },
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    redraw();
                  }}
                  onPointerMove={move}
                  onPointerUp={(event) => finish(event)}
                  onPointerCancel={(event) => finish(event, true)}
                  onLostPointerCapture={(event) => finish(event, true)}
                />
                {tool === 'comment' &&
                  fitted &&
                  canvas.current &&
                  context &&
                  marks.current.map((mark, index) => {
                    if (mark.tool !== 'comment') return null;
                    const note = commentLayout(context, mark, canvas.current!);
                    const scale = fitted.width / canvas.current!.width;
                    return (
                      <button
                        type="button"
                        className="feedback-image-note"
                        key={index}
                        aria-label={`Edit comment: ${mark.text}`}
                        disabled={locked || !!draft || panMode}
                        style={{
                          left: (fitted.areaWidth - fitted.width) / 2 + note.x * scale,
                          top: (fitted.areaHeight - fitted.height) / 2 + note.y * scale,
                          width: note.width * scale,
                          height: note.height * scale,
                        }}
                        onPointerDown={(event) => beginMove(event, index)}
                        onClick={(event) => {
                          if (!event.detail) openComment(mark.point, index);
                        }}
                      />
                    );
                  })}
                {selectedBounds &&
                  fitted &&
                  canvas.current &&
                  !draft &&
                  (tool === 'move' || tool === 'comment') && (
                    <span
                      className="feedback-image-selection"
                      style={{
                        left:
                          (fitted.areaWidth - fitted.width) / 2 +
                          (Math.max(0, selectedBounds.x) * fitted.width) / canvas.current.width,
                        top:
                          (fitted.areaHeight - fitted.height) / 2 +
                          (Math.max(0, selectedBounds.y) * fitted.height) / canvas.current.height,
                        width:
                          ((Math.min(
                            canvas.current.width,
                            selectedBounds.x + selectedBounds.width,
                          ) -
                            Math.max(0, selectedBounds.x)) *
                            fitted.width) /
                          canvas.current.width,
                        height:
                          ((Math.min(
                            canvas.current.height,
                            selectedBounds.y + selectedBounds.height,
                          ) -
                            Math.max(0, selectedBounds.y)) *
                            fitted.height) /
                          canvas.current.height,
                      }}
                    >
                      {resizeCorners.map(({ corner, label }) => (
                        <button
                          type="button"
                          key={corner}
                          className="feedback-image-resize"
                          data-corner={corner}
                          aria-label={`Resize ${label}`}
                          disabled={locked || panMode}
                          style={{
                            left: corner.includes('e') ? '100%' : 0,
                            top: corner.includes('s') ? '100%' : 0,
                          }}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            if (selectedMark !== undefined) beginMove(event, selectedMark, corner);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            const x =
                              event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                            const y =
                              event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                            if (!x && !y) return;
                            event.stopPropagation();
                            event.preventDefault();
                            if (
                              locked ||
                              moving.current ||
                              selectedMark === undefined ||
                              !canvas.current ||
                              !context
                            )
                              return;
                            const distance =
                              ((event.shiftKey ? 10 : 1) * canvas.current.width) / fitted.width;
                            const mark = marks.current[selectedMark];
                            const next = resizeMark(
                              context,
                              mark,
                              canvas.current,
                              corner,
                              { x: x * distance, y: y * distance },
                              (12 * canvas.current.width) / fitted.width,
                            );
                            if (next !== mark)
                              changeMarks(
                                marks.current.map((current, index) =>
                                  index === selectedMark ? next : current,
                                ),
                                selectedMark,
                              );
                            redraw();
                          }}
                        />
                      ))}
                    </span>
                  )}
                {draft && (
                  <div
                    ref={commentEditor}
                    className="feedback-comment-editor"
                    style={{
                      left: editorPosition.x,
                      top: editorPosition.y,
                      width: Math.min(288, fit?.areaWidth ?? 288),
                      maxHeight: fit?.areaHeight,
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        requestClose('comment');
                      }
                    }}
                    onPaste={(event) => event.stopPropagation()}
                    onDragOver={(event) => event.stopPropagation()}
                    onDrop={(event) => {
                      event.stopPropagation();
                      if (event.dataTransfer.files.length) event.preventDefault();
                    }}
                  >
                    <label htmlFor={`${description}-comment`}>
                      {draft.index === undefined ? 'Add comment' : 'Edit comment'}
                    </label>
                    <textarea
                      id={`${description}-comment`}
                      ref={commentInput}
                      rows={3}
                      maxLength={600}
                      disabled={locked}
                      value={draft.mark.text}
                      placeholder="Describe this detail…"
                      onChange={(event) =>
                        setDraft({ ...draft, mark: { ...draft.mark, text: event.target.value } })
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key !== 'Enter' ||
                          event.shiftKey ||
                          event.altKey ||
                          event.nativeEvent.isComposing ||
                          event.nativeEvent.keyCode === 229
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        saveComment();
                      }}
                    />
                    {draftLayout && !draftLayout.fits && (
                      <p role="alert">Shorten this comment to fit the image.</p>
                    )}
                    <div className="feedback-comment-actions">
                      {draft.index !== undefined && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={locked}
                          onClick={() => {
                            changeMarks(marks.current.filter((_, index) => index !== draft.index));
                            closeComment();
                            redraw();
                          }}
                        >
                          Delete
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => requestClose('comment')}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={locked || !draft.mark.text.trim() || !draftLayout?.fits}
                        onClick={saveComment}
                      >
                        {draft.index === undefined ? 'Add' : 'Update'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {error && (
            <p className="feedback-image-error" role="alert">
              {error}
            </p>
          )}
          <footer className="feedback-image-footer">
            <div className="feedback-image-zoom" role="group" aria-label="Image zoom">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Pan image"
                aria-pressed={panMode}
                disabled={locked || !!draft || !!movePreview || panning}
                onClick={() => {
                  setPanMode(!panMode);
                  canvas.current?.focus({ preventScroll: true });
                }}
              >
                <Hand size={15} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Zoom out"
                disabled={locked || !!draft || !!movePreview || panning || zoom <= minZoom}
                onClick={() => changeZoom(zoomValue.current * 0.8)}
              >
                <Minus size={15} aria-hidden="true" />
              </Button>
              <output aria-label="Zoom level">{Math.round(fitScale * zoom * 100)}%</output>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Zoom in"
                disabled={locked || !!draft || !!movePreview || panning || zoom >= maxZoom}
                onClick={() => changeZoom(zoomValue.current * 1.25)}
              >
                <Plus size={15} aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={locked || !!draft || !!movePreview || panning}
                onClick={() => changeZoom(1)}
              >
                Fit
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => requestClose()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={locked || !!draft || !!movePreview || panning || !dirty}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog open={!!discard} onOpenChange={(open) => !open && setDiscard(undefined)}>
        <DialogContent
          className="feedback-image-discard"
          aria-describedby={`${description}-discard`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (commentInput.current ?? canvas.current)?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <DialogTitle>Discard changes?</DialogTitle>
          <p id={`${description}-discard`}>
            {discard === 'comment'
              ? 'Your comment has unsaved changes.'
              : 'Your image has unsaved changes.'}
          </p>
          <div>
            <Button type="button" variant="ghost" onClick={() => setDiscard(undefined)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (discard === 'comment') closeComment();
                else onClose();
                setDiscard(undefined);
              }}
            >
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Thumbnail({ file, onOpen }: { file: File; onOpen(): void }) {
  const url = useImageUrl(file);
  return (
    <button
      type="button"
      className="feedback-thumbnail"
      onClick={onOpen}
      aria-label={`Preview and annotate ${file.name}`}
    >
      {url && <img src={url} alt="" draggable={false} />}
      <span className="feedback-thumbnail-edit">
        <Pencil size={13} aria-hidden="true" />
        Annotate
      </span>
    </button>
  );
}

function DocumentPreview({ file }: { file: File }) {
  const type =
    file.type === 'application/pdf'
      ? 'PDF'
      : file.type === 'application/json'
        ? 'JSON'
        : file.type === 'text/csv'
          ? 'CSV'
          : 'Text';
  const Icon = type === 'JSON' ? FileJson : type === 'CSV' ? FileSpreadsheet : FileText;
  const size =
    file.size >= 1024 * 1024
      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return (
    <div className="feedback-document">
      <Icon size={25} strokeWidth={1.5} aria-hidden="true" />
      <span className="feedback-document-name" title={file.name}>
        {file.name}
      </span>
      <span className="feedback-document-meta">
        <span>{type}</span>
        <span>{size}</span>
      </span>
    </div>
  );
}

export function FeedbackAttachments({
  files,
  disabled,
  onRemove,
  onReplace,
}: {
  files: FeedbackAttachment[];
  disabled: boolean;
  onRemove(index: number): void;
  onReplace(index: number, attachment: FeedbackAttachment): boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedIndex = files.findIndex((attachment) => attachment.id === selected);
  const attachment = files[selectedIndex];
  if (!files.length) return null;
  return (
    <>
      <div className="feedback-thumbnails">
        {files.map(({ id, file }, index) => (
          <div className="feedback-thumbnail-item" key={id}>
            {file.type.startsWith('image/') ? (
              <Thumbnail file={file} onOpen={() => setSelected(id)} />
            ) : (
              <DocumentPreview file={file} />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="feedback-thumbnail-remove"
              disabled={disabled}
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(index)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
      {attachment && (
        <AttachmentEditor
          key={attachment.id}
          attachment={attachment}
          disabled={disabled}
          onClose={() => setSelected(null)}
          onSave={(result) => {
            if (!onReplace(selectedIndex, result)) return false;
            setSelected(null);
            return true;
          }}
        />
      )}
    </>
  );
}
