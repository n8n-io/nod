import type { FeedbackReceipt, FeedbackSubmission } from '../shared/feedback.ts';

export interface FeedbackFile {
  name: string;
  mimeType: string;
  data: string;
  sha256: string;
}

export interface FeedbackEnvelope extends Omit<FeedbackSubmission, 'reportId' | 'attachments'> {
  schemaVersion: 1;
  computerName: null;
  action?: 'repair';
  payloadHash: string;
  report?: FeedbackFile;
  attachments: FeedbackFile[];
}

export interface FeedbackDelivery {
  configured: boolean;
  recipient: string | null;
  submit(envelope: FeedbackEnvelope): Promise<FeedbackReceipt>;
  status(submissionId: string, payloadHash: string): Promise<FeedbackReceipt>;
}
