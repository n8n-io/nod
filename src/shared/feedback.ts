export const feedbackLimits = {
  text: 12_000,
  attachments: 3,
  attachmentBytes: 2 * 1024 * 1024,
  totalAttachmentBytes: 4 * 1024 * 1024,
  reportBytes: 512 * 1024,
  requestBytes: 7 * 1024 * 1024,
};

export const feedbackAttachmentMimeTypes = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/json',
  'text/csv',
] as const;

export type FeedbackAttachmentMimeType = (typeof feedbackAttachmentMimeTypes)[number];

const attachmentExtensions: Record<string, FeedbackAttachmentMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
};

export const feedbackAttachmentAccept = [
  ...feedbackAttachmentMimeTypes,
  ...Object.keys(attachmentExtensions).map((extension) => `.${extension}`),
].join(',');

export function feedbackAttachmentMimeType(file: {
  name: string;
  type: string;
}): FeedbackAttachmentMimeType | null {
  const type = file.type.split(';')[0].trim().toLowerCase();
  const suffix = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? '';
  const extension = Object.hasOwn(attachmentExtensions, suffix)
    ? attachmentExtensions[suffix]
    : undefined;
  if (
    extension &&
    [
      '',
      'application/octet-stream',
      'text/plain',
      'text/markdown',
      'text/json',
      'application/vnd.ms-excel',
    ].includes(type)
  )
    return extension;
  return (feedbackAttachmentMimeTypes as readonly string[]).includes(type)
    ? (type as FeedbackAttachmentMimeType)
    : null;
}

export interface FeedbackContext {
  enabled: boolean;
  recipient: string | null;
  appVersion: string | null;
  appRelease: string | null;
  development: boolean;
  source: 'desktop' | 'local-web';
  appModified: boolean | null;
  platform: string | null;
}

export interface FeedbackReport {
  id: string;
  content: string;
  expiresAt: string;
}

export interface FeedbackAttachment {
  name: string;
  mimeType: FeedbackAttachmentMimeType;
  data: string;
}

export interface FeedbackSubmission {
  submissionId: string;
  category: 'bug' | 'feature' | 'other';
  feedback: string;
  appVersion: string | null;
  appRelease: string | null;
  platform: string | null;
  development: boolean;
  source: 'desktop' | 'local-web';
  appModified: boolean | null;
  reportId: string | null;
  attachments: FeedbackAttachment[];
}

export interface FeedbackReceipt {
  submissionId: string;
  status: 'submitted' | 'partial' | 'unknown' | 'rejected';
  issueUrl?: string;
  message?: string;
  canRetryAttachments?: boolean;
}
