import { feedbackAttachmentMimeType, feedbackLimits } from '../../shared/feedback';

export type FeedbackPoint = { x: number; y: number };

export const feedbackAnnotationColors = [
  { name: 'Yellow', ink: '#facc15', paper: '#fff9db' },
  { name: 'Pink', ink: '#f472b6', paper: '#fce7f3' },
  { name: 'Blue', ink: '#60a5fa', paper: '#e0f2fe' },
  { name: 'Green', ink: '#4ade80', paper: '#dcfce7' },
  { name: 'Ink', ink: '#1f2937', paper: '#f3f4f6' },
] as const;

export type FeedbackAnnotationColor = (typeof feedbackAnnotationColors)[number];
export type FeedbackCommentMark = {
  tool: 'comment';
  point: FeedbackPoint;
  text: string;
  color: FeedbackAnnotationColor;
  fontSize: number;
  width?: number;
};
export type FeedbackDrawingMark =
  | {
      tool: 'highlight' | 'pen';
      points: FeedbackPoint[];
      width: number;
      color: FeedbackAnnotationColor;
    }
  | { tool: 'redact'; from: FeedbackPoint; to: FeedbackPoint };
export type FeedbackMark = FeedbackDrawingMark | FeedbackCommentMark;
export type FeedbackAttachment = {
  id: string;
  file: File;
  image?: { original: File; marks: FeedbackMark[] };
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function point(value: unknown): value is FeedbackPoint {
  return (
    record(value) &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

function mark(value: unknown): value is FeedbackMark {
  if (!record(value)) return false;
  if (value.tool === 'redact') return point(value.from) && point(value.to);
  const color = value.color;
  if (
    !record(color) ||
    !feedbackAnnotationColors.some(
      (option) =>
        option.name === color.name && option.ink === color.ink && option.paper === color.paper,
    )
  )
    return false;
  if (value.tool === 'comment')
    return (
      point(value.point) &&
      typeof value.text === 'string' &&
      value.text.length <= feedbackLimits.text &&
      positive(value.fontSize) &&
      (value.width === undefined || positive(value.width))
    );
  return (
    (value.tool === 'pen' || value.tool === 'highlight') &&
    positive(value.width) &&
    Array.isArray(value.points) &&
    value.points.length > 0 &&
    Array.from(value.points).every(point)
  );
}

function file(value: unknown): value is File {
  return (
    value instanceof File &&
    value.size > 0 &&
    value.size <= feedbackLimits.attachmentBytes &&
    !!feedbackAttachmentMimeType(value)
  );
}

export function parseFeedbackAttachment(value: unknown): FeedbackAttachment | null {
  if (!record(value) || typeof value.id !== 'string' || !value.id || !file(value.file)) return null;
  if (value.image === undefined) return { id: value.id, file: value.file };
  const image = value.image;
  if (
    !record(image) ||
    !file(image.original) ||
    !feedbackAttachmentMimeType(image.original)?.startsWith('image/') ||
    !feedbackAttachmentMimeType(value.file)?.startsWith('image/') ||
    !Array.isArray(image.marks) ||
    !Array.from(image.marks).every(mark)
  )
    return null;
  return {
    id: value.id,
    file: value.file,
    image: { original: image.original, marks: image.marks },
  };
}
