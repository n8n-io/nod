import type { Pool } from 'pg';
import { activeThread } from './thread.ts';
import { createRedactor } from './redaction.ts';
import { feedbackLimits } from '../shared/feedback.ts';

type RecordValue = Record<string, unknown>;

export interface FeedbackReportOptions {
  pool: Pool;
  ownerId: string;
  secrets?: string[];
  provider?: string;
  model?: string;
  sessionEntries?: (threadId: string) => Promise<unknown[]>;
}

export async function buildFeedbackReport(options: FeedbackReportOptions) {
  const thread = await activeThread(options.pool, options.ownerId);
  const values = [options.ownerId, thread.id];
  const [messages, turns] = await Promise.all([
    options.pool.query(
      `SELECT id,role,text,turn_id,created_at FROM messages
       WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '24 hours'
       ORDER BY created_at DESC,id DESC LIMIT 31`,
      values,
    ),
    options.pool.query(
      `SELECT id,source,status,error,background,waiting_reason,created_at,started_at,finished_at FROM turns
       WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '24 hours'
       ORDER BY created_at DESC,id DESC LIMIT 21`,
      values,
    ),
  ]);
  const entries = (await options.sessionEntries?.(thread.id)) ?? [];
  const redact = createRedactor([...(options.secrets ?? []), ...savedCredentialValues(entries)], {
    string: 4000,
    payload: 12_000,
    minimumSecretLength: 1,
  });
  const toolTrace = savedToolTrace(entries, Date.now());
  const report = {
    format: 'otto-feedback-report-v1',
    generatedAt: new Date().toISOString(),
    threadId: thread.id,
    provider: options.provider,
    model: options.model,
    coverage: {
      hours: 24,
      toolTraceSource: 'saved-session',
      maximumMessages: 30,
      maximumTurns: 20,
      maximumToolRecords: 60,
      truncated: messages.rows.length > 30 || turns.rows.length > 20 || toolTrace.truncated,
    },
    messages: messages.rows.slice(0, 30).map(redact).reverse(),
    turns: turns.rows.slice(0, 20).map(redact).reverse(),
    trace: toolTrace.rows
      .map((row) =>
        redact(
          ['sign_in', 'get_credential'].includes(String(row.name))
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

function savedToolTrace(entries: unknown[], now: number) {
  const calls = new Map<string, RecordValue>();
  let truncated = false;
  const privateTools = new Set([
    'sign_in',
    'get_credential',
    'browser_flow',
    'manage_personal_context',
  ]);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = record(entries[index]);
    const message = record(entry?.message);
    if (entry?.type !== 'message' || !message) continue;
    const timestamp =
      typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp
        : typeof entry.timestamp === 'string'
          ? Date.parse(entry.timestamp)
          : NaN;
    if (!Number.isFinite(timestamp) || timestamp < now - 86_400_000 || timestamp > now) continue;
    const time = new Date(timestamp).toISOString();
    const content = Array.isArray(message.content) ? message.content : [];
    const tools: Array<RecordValue | undefined> =
      message.role === 'assistant'
        ? content.map(record).filter((block) => block?.type === 'toolCall')
        : message.role === 'toolResult'
          ? [{ id: message.toolCallId, name: message.toolName }]
          : [];
    for (const tool of tools) {
      if (typeof tool?.id !== 'string' || !tool.id || typeof tool.name !== 'string') continue;
      let call = calls.get(tool.id);
      if (!call) {
        if (calls.size >= 60) {
          truncated = true;
          continue;
        }
        call = { id: tool.id, kind: 'tool', name: tool.name, status: 'unknown' };
        calls.set(tool.id, call);
      }
      const privateTool = privateTools.has(tool.name) || privateTools.has(String(call.name));
      if (message.role === 'assistant') {
        const input = record(tool.arguments);
        call.input = privateTool
          ? '[redacted]'
          : tool.name === 'browser' &&
              ['fill', 'type', 'accept_dialog'].includes(String(input?.action))
            ? { ...input, text: '[redacted]' }
            : tool.arguments;
        call.started_at = time;
      } else {
        call.output = privateTool
          ? '[redacted]'
          : content.flatMap((value) => {
              const block = record(value);
              return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
            });
        call.status = message.isError === true ? 'failed' : 'succeeded';
        call.finished_at = time;
      }
      if (privateTool) {
        call.input = '[redacted]';
        call.output = '[redacted]';
      }
    }
  }
  return { rows: [...calls.values()], truncated };
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
