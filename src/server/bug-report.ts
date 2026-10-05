import type { Pool } from 'pg';
import { activeThread } from './thread.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';
import { feedbackLimits } from '../shared/feedback.ts';

type RecordValue = Record<string, unknown>;

export interface FeedbackReportOptions {
  pool: Pool;
  ownerId: string;
  captureEnabled(): boolean;
  secrets?: string[];
  provider?: string;
  model?: string;
  sessionEntries?: (threadId: string) => Promise<unknown[]>;
}

export async function buildFeedbackReport(options: FeedbackReportOptions) {
  const thread = await activeThread(options.pool, options.ownerId);
  const values = [options.ownerId, thread.id];
  const [messages, turns, trace] = await Promise.all([
    options.pool.query(
      `SELECT id,role,text,turn_id,created_at FROM messages
       WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '24 hours'
       ORDER BY created_at DESC,id DESC LIMIT 30`,
      values,
    ),
    options.pool.query(
      `SELECT id,source,status,error,created_at,started_at,finished_at FROM turns
       WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '24 hours'
       ORDER BY created_at DESC,id DESC LIMIT 20`,
      values,
    ),
    options.pool.query(
      `SELECT id,turn_id,kind,name,status,input,output,error,duration_ms,started_at,finished_at
       FROM inspector_records WHERE owner_id=$1 AND thread_id=$2
       AND recorded_at >= now()-interval '24 hours'
       ORDER BY started_at DESC,id DESC LIMIT 60`,
      values,
    ),
  ]);
  const entries = (await options.sessionEntries?.(thread.id)) ?? [];
  const redact = createInspectorRedactor(
    [...(options.secrets ?? []), ...savedCredentialValues(entries)],
    { string: 4000, payload: 12_000, minimumSecretLength: 1 },
  );
  const report = {
    format: 'otto-feedback-report-v1',
    generatedAt: new Date().toISOString(),
    threadId: thread.id,
    provider: options.provider,
    model: options.model,
    coverage: {
      hours: 24,
      toolCaptureEnabled: options.captureEnabled(),
      maximumMessages: 30,
      maximumTurns: 20,
      maximumToolRecords: 60,
      truncated: false,
    },
    messages: messages.rows.map(redact).reverse(),
    turns: turns.rows.map(redact).reverse(),
    trace: trace.rows
      .map((row) =>
        redact(
          row.name === 'get_credential'
            ? { ...row, input: '[redacted]', output: '[redacted]', error: '[redacted]' }
            : row,
        ),
      )
      .reverse(),
  };
  let encoded = JSON.stringify(report, null, 2);
  while (Buffer.byteLength(encoded) > feedbackLimits.reportBytes) {
    const largest = [report.messages, report.turns, report.trace].sort(
      (a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)),
    )[0];
    largest.shift();
    report.coverage.truncated = true;
    encoded = JSON.stringify(report, null, 2);
  }
  return encoded;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function savedCredentialValues(entries: unknown[]): string[] {
  const values: string[] = [];
  for (const entry of entries) {
    const message = record(record(entry)?.message);
    if (message?.role !== 'toolResult' || message.toolName !== 'get_credential') continue;
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const block = record(part);
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const credential = record(JSON.parse(block.text));
        for (const key of ['username', 'password']) {
          const value = credential?.[key];
          if (typeof value === 'string' && value) values.push(value);
        }
      } catch {}
    }
  }
  return values;
}
