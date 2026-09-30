import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { activeThread } from './thread.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function content(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): unknown[] => {
    const block = record(item);
    if (block?.type === 'text') return [{ type: 'text', text: block.text }];
    if (block?.type === 'thinking')
      return [{ type: 'thinking', thinking: block.thinking, redacted: block.redacted }];
    if (block?.type === 'toolCall')
      return [
        {
          type: 'toolCall',
          id: block.id,
          name: block.name,
          namespace: block.namespace,
          arguments: block.arguments,
        },
      ];
    if (block?.type === 'image')
      return [{ type: 'image', mimeType: block.mimeType, data: '[binary omitted]' }];
    return [];
  });
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

export function piSessionReport(entries: unknown[], secrets: string[] = []): unknown[] {
  const redact = createInspectorRedactor([...secrets, ...savedCredentialValues(entries)], {
    string: 64_000,
    payload: 160_000,
    minimumSecretLength: 1,
  });
  const credentialResults = new Set(
    entries.flatMap((value) => {
      const entry = record(value);
      const message = record(entry?.message);
      return entry?.type === 'message' &&
        message?.role === 'toolResult' &&
        message.toolName === 'get_credential' &&
        typeof entry.id === 'string'
        ? [entry.id]
        : [];
    }),
  );
  return entries.flatMap((value) => {
    const entry = record(value);
    if (!entry || typeof entry.type !== 'string') return [];
    const base = {
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
    };
    const message = record(entry.message);
    if (entry.type === 'message' && message) {
      const common = { role: message.role, timestamp: message.timestamp };
      if (message.role === 'toolResult')
        return [
          redact({
            ...base,
            message: {
              ...common,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              isError: message.isError,
              usage: message.usage,
              content:
                message.toolName === 'get_credential' ? '[redacted]' : content(message.content),
              details: message.toolName === 'get_credential' ? '[redacted]' : message.details,
            },
          }),
        ];
      if (message.role === 'assistant')
        return [
          redact({
            ...base,
            message: {
              ...common,
              api: message.api,
              provider: message.provider,
              model: message.model,
              responseModel: message.responseModel,
              responseId: message.responseId,
              providerThinkingLevel: message.providerThinkingLevel,
              stopReason: message.stopReason,
              rawStopReason: message.rawStopReason,
              endTurn: message.endTurn,
              errorMessage: message.errorMessage,
              diagnostics: message.diagnostics,
              usage: message.usage,
              content: content(message.content),
            },
          }),
        ];
      if (message.role === 'user' || message.role === 'system')
        return [redact({ ...base, message: { ...common, content: content(message.content) } })];
      return [];
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary')
      return [
        redact({
          ...base,
          summaryOmitted: true,
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
          fromId: entry.fromId,
          usage: entry.usage,
          fromHook: entry.fromHook,
        }),
      ];
    if (entry.type === 'custom_message')
      return [
        redact({
          ...base,
          customType: entry.customType,
          display: entry.display,
          content: content(entry.content),
          details: entry.details,
        }),
      ];
    if (entry.type === 'context_edit')
      return [
        redact({
          ...base,
          targetId: entry.targetId,
          replacement: credentialResults.has(String(entry.targetId))
            ? '[redacted]'
            : entry.replacement === null
              ? null
              : content(record(entry.replacement)?.content),
        }),
      ];
    if (entry.type === 'custom')
      return [redact({ ...base, customType: entry.customType, data: entry.data })];
    if (
      entry.type === 'model_change' ||
      entry.type === 'thinking_level_change' ||
      entry.type === 'usage'
    )
      return [
        redact({
          ...base,
          provider: entry.provider,
          model: entry.model,
          modelId: entry.modelId,
          thinkingLevel: entry.thinkingLevel,
          kind: entry.kind,
          usage: entry.usage,
          note: entry.note,
        }),
      ];
    if (entry.type === 'label' || entry.type === 'session_info')
      return [redact({ ...base, targetId: entry.targetId, label: entry.label, name: entry.name })];
    return [];
  });
}

export function registerBugReport(
  app: FastifyInstance,
  options: {
    pool: Pool;
    ownerId: string;
    captureEnabled(): boolean;
    secrets?: string[];
    provider?: string;
    model?: string;
    sessionEntries?: (threadId: string) => Promise<unknown[]>;
  },
) {
  app.get('/api/conversation/bug-report', async (_request, reply) => {
    const thread = await activeThread(options.pool, options.ownerId);
    let sessionEntries: unknown[] = [];
    let sessionAvailable = true;
    try {
      sessionEntries = (await options.sessionEntries?.(thread.id)) ?? [];
    } catch {
      sessionAvailable = false;
    }
    const sessionSecrets = [
      ...(options.secrets ?? []).filter((value) => value.length >= 8),
      ...savedCredentialValues(sessionEntries),
    ];
    const redact = createInspectorRedactor(sessionSecrets, {
      string: 64_000,
      payload: 160_000,
      minimumSecretLength: 1,
    });
    const values = [options.ownerId, thread.id];
    const [
      messages,
      turns,
      events,
      records,
      prompts,
      approvals,
      notifications,
      profile,
      goals,
      schedules,
    ] = await Promise.all([
      options.pool.query(
        `SELECT id,role,text,turn_id,attachments,reaction,assistant_reaction,reply_to_message_id,created_at
           FROM messages WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,source,prompt,channel,status,waiting_reason,background,read_only,error,created_at,started_at,finished_at
           FROM turns WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT e.id,e.turn_id,e.type,e.summary,e.created_at FROM turn_events e
           JOIN turns t ON t.id=e.turn_id AND t.owner_id=$1 AND t.thread_id=$2
           ORDER BY e.created_at,e.id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,kind,name,status,input,output,error,usage,duration_ms,started_at,finished_at
           FROM inspector_records WHERE owner_id=$1 AND thread_id=$2 AND recorded_at >= now()-interval '7 days'
           ORDER BY started_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,payload,provider,model,created_at FROM inspector_prompts
           WHERE owner_id=$1 AND thread_id=$2 AND created_at >= now()-interval '7 days'
           ORDER BY created_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT id,turn_id,execution_turn_id,action,args,status,result,expires_at
           FROM approvals WHERE owner_id=$1 AND thread_id=$2 ORDER BY expires_at,id`,
        values,
      ),
      options.pool.query(
        `SELECT n.id,n.turn_id,n.summary,n.decision,n.reason,n.feedback,n.kind,n.created_at
           FROM notifications n JOIN turns t ON t.id=n.turn_id AND t.owner_id=$1 AND t.thread_id=$2
           WHERE n.owner_id=$1 ORDER BY n.created_at,n.id`,
        values,
      ),
      options.pool.query('SELECT data FROM profiles WHERE owner_id=$1', [options.ownerId]),
      options.pool.query(
        'SELECT id,title,description,progress,status,next_action,target_date,updated_at FROM goals WHERE owner_id=$1 ORDER BY updated_at,id',
        [options.ownerId],
      ),
      options.pool.query(
        'SELECT id,title,prompt,kind,enabled,time_zone,next_run_at FROM schedules WHERE owner_id=$1 ORDER BY id',
        [options.ownerId],
      ),
    ]);
    reply.header('Cache-Control', 'no-store');
    return {
      purpose: 'Explain an incorrect Otto answer using the saved conversation and trace.',
      generatedAt: new Date().toISOString(),
      threadId: thread.id,
      provider: options.provider,
      model: options.model,
      coverage: {
        toolAndPromptCaptureEnabled: options.captureEnabled(),
        traceRetentionDays: 7,
        note: 'Values are masked and may be shortened. The Pi session includes saved readable thinking. Compaction summary text is omitted because it may retain saved login values. Provider-opaque reasoning, attachment bytes, and expired traces are unavailable.',
      },
      piSession: {
        available: sessionAvailable,
        entries: piSessionReport(sessionEntries, sessionSecrets),
      },
      messages: messages.rows.map(redact),
      turns: turns.rows.map(redact),
      events: events.rows.map(redact),
      trace: records.rows.map(redact),
      prompts: prompts.rows.map(redact),
      approvals: approvals.rows.map(redact),
      notificationDecisions: notifications.rows.map(redact),
      memory: {
        profile: redact(profile.rows[0]?.data ?? {}),
        goals: goals.rows.map(redact),
        schedules: schedules.rows.map(redact),
      },
    };
  });
}
