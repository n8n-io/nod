import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { FeedbackDelivery, FeedbackEnvelope, FeedbackFile } from '../ports/feedback.ts';
import { snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import { parseFeedbackActivity, type FeedbackActivity } from '../shared/feedback-activity.ts';
import { feedbackTechnicalContext } from './feedback-context.ts';
import type { FeedbackClientError } from './bug-report.ts';
import {
  feedbackAttachmentMimeTypes,
  feedbackLimits,
  type FeedbackContext,
  type FeedbackReceipt,
  type FeedbackReport,
} from '../shared/feedback.ts';

const uuid = z.uuidv4().transform((value) => value.toLowerCase());
const submission = z
  .object({
    submissionId: uuid,
    category: z.enum(['bug', 'feature', 'other']),
    feedback: z.string().trim().min(1).max(feedbackLimits.text),
    appVersion: z.string().trim().min(1).max(100).nullable(),
    appRelease: z.string().trim().max(200).nullable(),
    platform: z.string().trim().max(100).nullable(),
    development: z.boolean(),
    source: z.enum(['desktop', 'local-web']),
    appModified: z.boolean().nullable(),
    reportId: uuid.nullable(),
    attachments: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(160)
              .regex(/^[^/\\\u0000-\u001f]+$/),
            mimeType: z.enum(feedbackAttachmentMimeTypes),
            data: z.string().max(Math.ceil(feedbackLimits.attachmentBytes / 3) * 4),
          })
          .strict(),
      )
      .max(feedbackLimits.attachments),
  })
  .strict();

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

function attachmentFile(file: z.infer<typeof submission>['attachments'][number]): FeedbackFile {
  const bytes = Buffer.from(file.data, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > feedbackLimits.attachmentBytes ||
    bytes.toString('base64') !== file.data
  )
    throw fail('Choose a supported attachment up to 2 MB.', 400);
  let matches =
    (file.mimeType === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (file.mimeType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) ||
    (file.mimeType === 'image/webp' &&
      bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP') ||
    (file.mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-');
  if (['text/plain', 'application/json', 'text/csv'].includes(file.mimeType)) {
    const content = bytes.toString('utf8');
    matches = Buffer.from(content, 'utf8').equals(bytes) && !content.includes('\0');
    if (matches && file.mimeType === 'application/json') {
      try {
        JSON.parse(content.replace(/^\ufeff/, ''));
      } catch {
        matches = false;
      }
    }
  }
  if (!matches) throw fail('The attachment does not match its file type.', 400);
  return { ...file, sha256: hash(bytes) };
}

export async function registerFeedback(
  app: FastifyInstance,
  options: {
    pool: Pool;
    ownerId: string;
    context: Omit<FeedbackContext, 'enabled' | 'recipient'>;
    delivery: FeedbackDelivery;
    buildReport(
      activity: FeedbackActivity[],
      errors: FeedbackClientError[],
      errorsAvailable: boolean,
    ): Promise<string>;
    analytics?: CaptureAnalytics;
  },
) {
  await options.pool.query(`CREATE TABLE IF NOT EXISTS feedback_submissions (
    owner_id text NOT NULL, id uuid NOT NULL, request_hash text NOT NULL, payload_hash text NOT NULL,
    status text NOT NULL, issue_url text, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,id)
  )`);
  const reports = new Map<string, FeedbackReport>();
  const repairs = new Map<string, { envelope: FeedbackEnvelope; expiresAt: number }>();
  const pending = new Set<string>();
  const rejectionClaim = (row: { status: string; request_hash: string; payload_hash: string }) =>
    row.status === 'rejected' && row.request_hash === '' && row.payload_hash === '';
  const sweep = () => {
    for (const [id, report] of reports)
      if (Date.parse(report.expiresAt) <= Date.now()) reports.delete(id);
    for (const [id, value] of repairs) if (value.expiresAt <= Date.now()) repairs.delete(id);
  };
  const receipt = (row: {
    id: string;
    status: FeedbackReceipt['status'];
    issue_url: string | null;
  }): FeedbackReceipt => ({
    submissionId: row.id,
    status: row.status,
    ...(row.issue_url && { issueUrl: row.issue_url }),
    ...(row.status === 'partial' && { canRetryAttachments: repairs.has(row.id) }),
  });
  const save = async (value: FeedbackReceipt) => {
    const result = await options.pool.query(
      `UPDATE feedback_submissions SET status=CASE WHEN status='partial' AND $3<>'submitted' THEN 'partial' ELSE $3 END,
       issue_url=COALESCE($4,issue_url),updated_at=now()
       WHERE owner_id=$1 AND id=$2 AND status<>'submitted' RETURNING id,status,issue_url`,
      [options.ownerId, value.submissionId, value.status, value.issueUrl ?? null],
    );
    if (result.rows[0]?.status === 'submitted' || result.rows[0]?.status === 'rejected')
      repairs.delete(value.submissionId);
    if (result.rows[0])
      return { ...receipt(result.rows[0]), ...(value.message && { message: value.message }) };
    const stored = await options.pool.query(
      'SELECT id,status,issue_url FROM feedback_submissions WHERE owner_id=$1 AND id=$2',
      [options.ownerId, value.submissionId],
    );
    return receipt(stored.rows[0]);
  };
  app.addHook('onClose', async () => {
    reports.clear();
    repairs.clear();
  });
  app.get('/api/feedback/context', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      ...options.context,
      enabled: options.delivery.configured,
      recipient: options.delivery.recipient,
    } satisfies FeedbackContext;
  });
  app.post('/api/feedback/report', { bodyLimit: 262_144 }, async (request, reply) => {
    sweep();
    const input = z
      .object({
        activity: z.array(z.unknown()).max(100).optional(),
        errorsAvailable: z.boolean().optional(),
        errors: z
          .array(
            z
              .object({
                type: z.enum(['render', 'error', 'rejection']),
                message: z.string().max(8192),
                stack: z.string().max(8192).optional(),
                ageMs: z.number().finite().min(0).max(1_800_000),
              })
              .strict(),
          )
          .max(10)
          .optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const content = await options.buildReport(
      parseFeedbackActivity(input.activity).map((row) => ({ ...row, source: 'app' })),
      input.errors ?? [],
      input.errorsAvailable ?? input.errors !== undefined,
    );
    if (Buffer.byteLength(content) > feedbackLimits.reportBytes)
      throw fail('The diagnostic report is too large.', 413);
    const report = {
      id: randomUUID(),
      content,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    if (reports.size >= 5) reports.delete(reports.keys().next().value!);
    reports.set(report.id, report);
    reply.header('Cache-Control', 'no-store');
    return report;
  });
  app.post('/api/feedback', { bodyLimit: feedbackLimits.requestBytes }, async (request, reply) => {
    const capture = snapshotAnalytics(options.analytics);
    const startedAt = Date.now();
    reply.header('Cache-Control', 'no-store');
    if (!options.delivery.configured) throw fail('Feedback sending is not configured yet.', 503);
    const input = submission.parse(request.body);
    const requestHash = hash(JSON.stringify(input));
    const previous = await options.pool.query(
      'SELECT * FROM feedback_submissions WHERE owner_id=$1 AND id=$2',
      [options.ownerId, input.submissionId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== requestHash && !rejectionClaim(previous.rows[0]))
        throw fail('This submission already has different content.', 409);
      return receipt(previous.rows[0]);
    }
    sweep();
    const snapshot = input.reportId ? reports.get(input.reportId) : undefined;
    if (input.reportId && !snapshot)
      throw fail('Refresh the diagnostic report before sending.', 410);
    const attachments = input.attachments.map(attachmentFile);
    if (
      attachments.reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0) >
      feedbackLimits.totalAttachmentBytes
    )
      throw fail('Attachments must total no more than 4 MB.', 413);
    const report: FeedbackFile | undefined = snapshot
      ? {
          name: 'nod-diagnostic-report.json',
          mimeType: 'application/json',
          data: Buffer.from(snapshot.content).toString('base64'),
          sha256: hash(snapshot.content),
        }
      : undefined;
    const canonical = {
      schemaVersion: 1 as const,
      submissionId: input.submissionId,
      category: input.category,
      feedback: input.feedback,
      computerName: null,
      ...feedbackTechnicalContext(input),
      report: report ?? null,
      attachments,
    };
    const envelope: FeedbackEnvelope = {
      ...canonical,
      report,
      payloadHash: hash(JSON.stringify(canonical)),
    };
    const inserted = await options.pool.query(
      `INSERT INTO feedback_submissions(owner_id,id,request_hash,payload_hash,status)
       VALUES($1,$2,$3,$4,'unknown') ON CONFLICT DO NOTHING RETURNING id`,
      [options.ownerId, input.submissionId, requestHash, envelope.payloadHash],
    );
    if (!inserted.rowCount) {
      const winner = await options.pool.query(
        'SELECT * FROM feedback_submissions WHERE owner_id=$1 AND id=$2',
        [options.ownerId, input.submissionId],
      );
      if (winner.rows[0].request_hash !== requestHash && !rejectionClaim(winner.rows[0]))
        throw fail('This submission already has different content.', 409);
      return receipt(winner.rows[0]);
    }
    pending.add(input.submissionId);
    if (repairs.size >= 5) repairs.delete(repairs.keys().next().value!);
    repairs.set(input.submissionId, { envelope, expiresAt: Date.now() + 3_600_000 });
    try {
      if (request.raw.aborted || reply.raw.destroyed || Date.now() - startedAt > 60_000)
        return await save({ submissionId: input.submissionId, status: 'rejected' });
      const delivered = await save(await options.delivery.submit(envelope));
      if (delivered.status === 'submitted' || delivered.status === 'partial')
        capture?.({
          event: 'feedback_sent',
          properties: {
            category: input.category,
            has_attachments: input.attachments.length > 0,
            has_report: input.reportId !== null,
          },
        });
      return delivered;
    } catch {
      return { submissionId: input.submissionId, status: 'unknown' } satisfies FeedbackReceipt;
    } finally {
      pending.delete(input.submissionId);
    }
  });
  app.get<{ Params: { id: string } }>('/api/feedback/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = uuid.parse(request.params.id);
    await options.pool.query(
      `INSERT INTO feedback_submissions(owner_id,id,request_hash,payload_hash,status)
       VALUES($1,$2,'','','rejected') ON CONFLICT DO NOTHING`,
      [options.ownerId, id],
    );
    const result = await options.pool.query(
      'SELECT * FROM feedback_submissions WHERE owner_id=$1 AND id=$2',
      [options.ownerId, id],
    );
    const row = result.rows[0];
    sweep();
    if (row.status === 'submitted' || row.status === 'rejected' || pending.has(id))
      return receipt(row);
    if (row.status === 'unknown' && Date.now() - new Date(row.created_at).getTime() < 300_000)
      return {
        ...receipt(row),
        message: 'Delivery is still being confirmed. Check again in a few minutes.',
      };
    if (!options.delivery.configured) return receipt(row);
    try {
      return await save(await options.delivery.status(id, row.payload_hash));
    } catch {
      return receipt(row);
    }
  });
  app.post<{ Params: { id: string } }>('/api/feedback/:id/retry', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = uuid.parse(request.params.id);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    sweep();
    const stored = await options.pool.query(
      'SELECT * FROM feedback_submissions WHERE owner_id=$1 AND id=$2',
      [options.ownerId, id],
    );
    const row = stored.rows[0];
    if (!row || row.status !== 'partial')
      throw fail('Check the original submission before retrying attachments.', 409);
    if (pending.has(id)) return receipt(row);
    const repair = repairs.get(id);
    if (!repair)
      throw fail(
        'The original attachments are no longer available. Open the feedback to add them.',
        410,
      );
    if (!options.delivery.configured) throw fail('Feedback sending is not configured yet.', 503);
    pending.add(id);
    try {
      return await save(await options.delivery.submit({ ...repair.envelope, action: 'repair' }));
    } catch {
      return receipt(row);
    } finally {
      pending.delete(id);
    }
  });
}
