import type { Pool } from 'pg';
import { feedbackLimits, type FeedbackContext } from '../shared/feedback.ts';
import { parseFeedbackActivity, type FeedbackActivity } from '../shared/feedback-activity.ts';
import { integrationServiceIds } from '../shared/integrations.ts';
import { feedbackTechnicalContext } from './feedback-context.ts';
import { createFeedbackRedactor } from './feedback-redaction.ts';
import type { PersonalProfile } from './personal-data.ts';
import type { FeedbackLogSnapshot } from './feedback-log.ts';

type Row = Record<string, unknown>;

export interface FeedbackClientError {
  type: 'render' | 'error' | 'rejection';
  message: string;
  stack?: string;
  ageMs: number;
}

export interface FeedbackReportOptions {
  pool: Pool;
  ownerId: string;
  provider?: string;
  model?: string;
  activity?: FeedbackActivity[];
  context?: Omit<FeedbackContext, 'enabled' | 'recipient'>;
  secrets?: string[];
  profile?: () => Promise<PersonalProfile>;
  logs?: () => Promise<FeedbackLogSnapshot>;
  errors?: FeedbackClientError[];
  errorsAvailable?: boolean;
}

const providers = [
  'openai',
  'anthropic',
  'openrouter',
  'amazon-bedrock',
  'google-vertex',
  'google',
  'azure',
  'typesafe',
  'compatible',
];
const tools = [
  'apps',
  'ask_user',
  'browser',
  'browser_session',
  'create_audio',
  'delegate',
  'follow_up',
  'manage_apps',
  'manage_personal_context',
  'pay',
  'react_to_message',
  'send_message',
  'share_file',
  'sign_in',
  'skills',
  'task',
];
const channels = ['web', 'telegram', 'whatsapp'];
const outcomes = ['succeeded', 'failed', 'cancelled'];
const choice = (value: unknown, allowed: readonly string[], fallback = 'unknown') =>
  typeof value === 'string' && allowed.includes(value) ? value : fallback;
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : null;
const cost = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
const record = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const timestamp = (value: unknown) =>
  value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
const duration = (end: unknown, start: unknown) => amount(timestamp(end) - timestamp(start));

function modelFamily(value: unknown) {
  if (typeof value !== 'string') return 'unknown';
  const family = /^(gpt|claude|gemini|llama|deepseek|qwen|mistral)(?:[-./\d]|$)/i.exec(value)?.[1];
  return family?.toLowerCase() ?? 'custom';
}

function tool(value: unknown) {
  const name = typeof value === 'string' ? value.replaceAll(' ', '_') : '';
  if (['read', 'bash', 'edit', 'write', 'find', 'ls', 'grep'].includes(name)) return 'workspace';
  if (['web_search', 'fetch_content', 'get_search_content', 'code_search'].includes(name))
    return 'web';
  return choice(name, tools, 'other');
}

export async function buildFeedbackReport(options: FeedbackReportOptions) {
  const now = Date.now();
  let redact: ReturnType<typeof createFeedbackRedactor> | undefined;
  let profileTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.profile) {
      const candidate = createFeedbackRedactor({
        secrets: [...(options.secrets ?? []), options.ownerId],
        profile: await Promise.race([
          options.profile(),
          new Promise<never>((_, reject) => {
            profileTimer = setTimeout(
              () => reject(new Error('Diagnostic profile unavailable.')),
              3000,
            );
          }),
        ]),
      });
      if (candidate.isReady()) redact = candidate;
    }
  } catch {
  } finally {
    clearTimeout(profileTimer);
  }
  const recent = [options.ownerId, new Date(now - 86_400_000), new Date(now)];
  const aliases = new Map<string, Map<unknown, string>>();
  function alias(kind: string, value: unknown) {
    if (typeof value !== 'string' || !value) return null;
    let values = aliases.get(kind);
    if (!values) aliases.set(kind, (values = new Map()));
    if (!values.has(value)) values.set(value, `${kind}${values.size + 1}`);
    return values.get(value)!;
  }
  const age = (value: unknown) => amount(now - timestamp(value));
  const references = (row: Row) => ({
    turnId: alias('t', row.turn_id),
    sessionId: alias('s', row.session_id),
    runId: alias('r', row.run_id),
    parentRunId: alias('r', row.parent_run_id),
  });
  const sections: Record<
    string,
    {
      status: 'collected' | 'unavailable';
      scope: 'recent' | 'current';
      rows: number;
      truncated: boolean;
    }
  > = {};
  const lists: Record<string, Row[]> = {};
  async function collect(
    name: string,
    sql: string,
    project: (row: Row) => Row,
    values: unknown[] = recent,
    limit = 200,
  ) {
    try {
      const result = await options.pool.query<Row>(`${sql} LIMIT ${limit + 1}`, values);
      const rows = result.rows.slice(0, limit).reverse().map(project);
      sections[name] = {
        status: 'collected',
        scope: values.length === 1 ? 'current' : 'recent',
        rows: rows.length,
        truncated: result.rows.length > limit,
      };
      lists[name] = rows;
    } catch {
      sections[name] = {
        status: 'unavailable',
        scope: values.length === 1 ? 'current' : 'recent',
        rows: 0,
        truncated: false,
      };
      lists[name] = [];
    }
  }
  await Promise.all([
    collect(
      'messages',
      `SELECT id,turn_id,role,created_at,char_length(text) AS characters,
       CASE WHEN octet_length(text)<=65536 THEN text ELSE '[message omitted: content limit]' END AS text,
       CASE WHEN jsonb_typeof(attachments)='array' THEN jsonb_array_length(attachments) ELSE 0 END AS attachment_count,
       reply_to_message_id IS NOT NULL AS has_reply
       FROM messages WHERE owner_id=$1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('m', row.id),
        turnId: alias('t', row.turn_id),
        role: choice(row.role, ['user', 'assistant', 'system']),
        ageMs: age(row.created_at),
        characters: amount(row.characters),
        attachmentCount: amount(row.attachment_count),
        hasReply: row.has_reply === true,
        ...(redact && row.role !== 'system' && typeof row.text === 'string'
          ? { text: redact.text(row.text) }
          : {}),
      }),
    ),
    collect(
      'turns',
      `SELECT id,parent_turn_id,session_id,source,channel,status,background,waiting_reason,
       error IS NOT NULL AS error_present,
       CASE WHEN octet_length(error)<=65536 THEN error ELSE '[error omitted: content limit]' END AS error,
       created_at,started_at,finished_at
       FROM turns WHERE owner_id=$1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('t', row.id),
        parentTurnId: alias('t', row.parent_turn_id),
        sessionId: alias('s', row.session_id),
        source: choice(row.source, ['user', 'schedule', 'event', 'resume', 'task']),
        channel: choice(row.channel, channels, 'other'),
        status: choice(row.status, ['queued', 'running', 'waiting', ...outcomes]),
        background: row.background === true,
        waitingReason: choice(row.waiting_reason, ['question', 'approval', 'credentials']),
        errorPresent: row.error_present === true,
        ...(redact && typeof row.error === 'string' ? { error: redact.text(row.error) } : {}),
        ageMs: age(row.created_at),
        queueMs: duration(row.started_at, row.created_at),
        durationMs: duration(row.finished_at, row.started_at),
      }),
    ),
    collect(
      'execution',
      `SELECT e.id,e.turn_id,e.run_id,e.parent_run_id,e.session_id,e.call_id,e.type,
       CASE WHEN e.type IN ('tool_start','tool_complete','tool_failed') THEN e.summary END AS tool,
       e.created_at FROM turn_events e JOIN turns t ON t.id=e.turn_id
       WHERE t.owner_id=$1 AND e.created_at BETWEEN $2 AND $3 ORDER BY e.created_at DESC,e.id DESC`,
      (row) => ({
        id: alias('e', row.id),
        ...references(row),
        callId: alias('c', row.call_id),
        type: choice(row.type, [
          'started',
          'steered',
          'step',
          'final',
          'queued',
          'running',
          'waiting',
          ...outcomes,
          'tool_start',
          'tool_complete',
          'tool_failed',
          'agent_start',
          'agent_complete',
          'agent_cancelled',
          'agent_failed',
          'agent_waiting',
        ]),
        tool: tool(row.tool),
        ageMs: age(row.created_at),
      }),
      recent,
      400,
    ),
    collect(
      'modelUsage',
      `SELECT u.turn_id,u.session_id,u.run_id,u.parent_run_id,u.cost_usd,u.details,u.created_at FROM model_usage u
       LEFT JOIN turns t ON t.id=u.turn_id
       WHERE u.owner_id=$1 AND (u.turn_id IS NULL OR t.owner_id=$1)
       AND u.created_at BETWEEN $2 AND $3 ORDER BY u.created_at DESC,u.id DESC`,
      (row) => {
        const details = record(row.details);
        return {
          ...references(row),
          provider: choice(details.provider, providers, 'other'),
          modelFamily: modelFamily(details.model),
          category: choice(details.category, ['agent', 'memory', 'review', 'tasks', 'analytics']),
          status: choice(details.status, outcomes),
          durationMs: amount(details.durationMs),
          inputTokens: amount(details.inputTokens),
          outputTokens: amount(details.outputTokens),
          cacheReadTokens: amount(details.cacheReadTokens),
          cacheWriteTokens: amount(details.cacheWriteTokens),
          costUsd: cost(row.cost_usd),
          estimateUsd: cost(details.estimateUsd),
          pricing: choice(details.pricing, ['reported', 'sdk_estimate', 'unavailable']),
          ageMs: age(row.created_at),
        };
      },
    ),
    collect(
      'tasks',
      `SELECT id,turn_id,session_id,state,step_index,jsonb_array_length(steps) AS step_count,
       revision,applied_revision,updated_at FROM tasks
       WHERE owner_id=$1 AND updated_at BETWEEN $2 AND $3 ORDER BY updated_at DESC,id DESC`,
      (row) => ({
        id: alias('task', row.id),
        turnId: alias('t', row.turn_id),
        sessionId: alias('s', row.session_id),
        state: choice(row.state, ['open', 'done', 'cancelled']),
        step: amount(row.step_index),
        steps: amount(row.step_count),
        revision: amount(row.revision),
        appliedRevision: amount(row.applied_revision),
        ageMs: age(row.updated_at),
      }),
    ),
    collect(
      'connections',
      `SELECT id,slug,account_id IS NOT NULL AS connected,account_active,revoked,
       callback_expires>now() AS pending,triggers_enabled,watch_failures,inbox_failed,inbox_reconnect_required,
       account_checked_at,inbox_checked_at,created_at FROM app_connections
       WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('connection', row.id),
        method: 'managed_app',
        app: choice(row.slug, integrationServiceIds, 'custom'),
        status:
          row.revoked === true
            ? 'disconnected'
            : row.pending === true
              ? 'connecting'
              : row.connected === true
                ? row.account_active === true
                  ? 'connected'
                  : 'reconnect'
                : 'disconnected',
        triggersEnabled: row.triggers_enabled === true,
        watchFailures: amount(row.watch_failures),
        inboxFailed: row.inbox_failed === true,
        reconnectRequired: row.inbox_reconnect_required === true,
        checkedAgeMs: age(row.account_checked_at),
        inboxCheckedAgeMs: age(row.inbox_checked_at),
      }),
      [options.ownerId],
    ),
    collect(
      'browserConnections',
      `SELECT id,state,checked_at,created_at FROM browser_connections
       WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('connection', row.id),
        method: 'browser',
        status: choice(row.state, ['pending', 'saved', 'needs_sign_in', 'disconnecting']),
        checkedAgeMs: age(row.checked_at),
      }),
      [options.ownerId],
    ),
    collect(
      'directConnections',
      `SELECT id,reconnect_required,replaced_at IS NOT NULL AS replaced,
       ARRAY(SELECT p->>'kind' FROM jsonb_array_elements(paths) p) AS methods,created_at
       FROM discovered_connections WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('connection', row.id),
        methods: Array.isArray(row.methods)
          ? [...new Set(row.methods.map((value) => choice(value, ['http', 'mcp', 'cli'], 'other')))]
          : [],
        reconnectRequired: row.reconnect_required === true,
        replaced: row.replaced === true,
      }),
      [options.ownerId],
    ),
    collect(
      'modelConnections',
      `SELECT provider,method,status,managed,created_at FROM model_connections
       WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        provider: choice(row.provider, providers, 'other'),
        method: choice(row.method, ['api_key', 'subscription', 'oauth']),
        status: choice(row.status, ['connected', 'reconnect', 'loading']),
        managed: row.managed === true,
      }),
      [options.ownerId],
    ),
    collect(
      'integrationEvents',
      `SELECT slug,state,created_at FROM integration_events
       WHERE owner_id=$1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        app: choice(row.slug, integrationServiceIds, 'custom'),
        status: choice(row.state, ['queued', 'processing', 'discarded', 'delivered']),
        ageMs: age(row.created_at),
      }),
    ),
    collect(
      'schedules',
      `SELECT s.id,s.kind,s.enabled,s.delivery_channel,s.next_run_at,
       (SELECT count(*)::int FROM schedule_runs r WHERE r.owner_id=s.owner_id AND r.schedule_id=s.id
         AND r.created_at BETWEEN $2 AND $3) AS recent_runs,
       (SELECT count(*)::int FROM schedule_runs r JOIN turns t ON t.id=r.turn_id AND t.owner_id=r.owner_id
         WHERE r.owner_id=s.owner_id AND r.schedule_id=s.id AND r.created_at BETWEEN $2 AND $3
         AND t.status='failed') AS failed_runs
       FROM schedules s WHERE s.owner_id=$1 ORDER BY s.created_at DESC,s.id DESC`,
      (row) => ({
        id: alias('schedule', row.id),
        kind: choice(row.kind, ['once', 'recurring']),
        enabled: row.enabled === true,
        channel: choice(row.delivery_channel, channels, 'other'),
        overdue: row.enabled === true && timestamp(row.next_run_at) < now,
        recentRuns: amount(row.recent_runs),
        failedRuns: amount(row.failed_runs),
      }),
    ),
    collect(
      'channels',
      `SELECT i.provider,i.state AS receive_state,o.state AS delivery_state,o.reason,
       i.turn_id,i.created_at,o.updated_at FROM channel_inbox i
       LEFT JOIN channel_outbox o ON o.source_id=i.source_id
       WHERE i.owner_id=$1 AND i.created_at BETWEEN $2 AND $3 ORDER BY i.created_at DESC,i.source_id DESC`,
      (row) => ({
        provider: choice(row.provider, channels, 'other'),
        turnId: alias('t', row.turn_id),
        receiveState: choice(row.receive_state, ['pending', 'discarded', 'submitted']),
        deliveryState: choice(row.delivery_state, [
          'pending',
          'preparing',
          'sending',
          'sent',
          'blocked',
          'uncertain',
        ]),
        reason: choice(row.reason, [
          'interrupted_send',
          'send_not_confirmed',
          'message_owner_changed',
          'channel_access_changed',
          'thread_changed',
          'reply_window_closed',
          'presentation_unavailable',
        ]),
        ageMs: age(row.created_at),
        deliveryAgeMs: age(row.updated_at),
      }),
    ),
  ]);
  let logCoverage: FeedbackLogSnapshot['coverage'] = {
    hours: 24,
    dropped: 0,
    truncated: false,
    unavailable: true,
  };
  lists.logs = [];
  if (redact && options.logs) {
    try {
      const snapshot = await options.logs();
      logCoverage = snapshot.coverage;
      lists.logs = snapshot.entries
        .filter((entry) => entry.at <= now && entry.at >= now - 86_400_000)
        .map((entry) => ({
          event: entry.event,
          ageMs: amount(now - entry.at),
          turnId: alias('t', entry.scope.turnId),
          sessionId: alias('s', entry.scope.sessionId),
          runId: alias('r', entry.scope.runId),
          parentRunId: alias('r', entry.scope.parentRunId),
          callId: alias('c', entry.scope.callId),
          data: redact!.value(entry.data),
        }));
    } catch {}
  }
  sections.logs = {
    status: logCoverage.unavailable ? 'unavailable' : 'collected',
    scope: 'recent',
    rows: lists.logs.length,
    truncated: logCoverage.truncated || logCoverage.dropped > 0,
  };
  lists.clientErrors = [];
  const errorsAvailable = options.errorsAvailable ?? options.errors !== undefined;
  if (redact && errorsAvailable)
    lists.clientErrors = (options.errors ?? []).slice(-10).map((error) => ({
      event: 'client_error',
      ageMs: amount(error.ageMs),
      data: redact!.value({ type: error.type, message: error.message, stack: error.stack }),
    }));
  sections.clientErrors = {
    status: !redact || !errorsAvailable ? 'unavailable' : 'collected',
    scope: 'recent',
    rows: lists.clientErrors.length,
    truncated: false,
  };
  const report = {
    format: 'nod-feedback-report-v3',
    purpose: 'support-debugging-and-product-improvement',
    ...(options.context ? { environment: feedbackTechnicalContext(options.context) } : {}),
    runtime: {
      provider: choice(options.provider, providers, 'other'),
      modelFamily: modelFamily(options.model),
    },
    coverage: {
      hours: 24,
      contentIncluded: Boolean(redact),
      redaction: redact ? 'best-effort' : 'unavailable',
      logs: logCoverage,
      truncated: Object.values(sections).some((section) => section.truncated),
      sections,
    },
    ...lists,
    appActivity: {
      windowMinutes: 30,
      source: 'current-runtime-and-window',
      entries: parseFeedbackActivity(options.activity ?? []),
    },
  };
  let encoded = JSON.stringify(report, null, 2);
  while (Buffer.byteLength(encoded) > feedbackLimits.reportBytes) {
    const largest = Object.entries(lists)
      .filter(([, rows]) => rows.length)
      .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
    if (!largest) throw new Error('The diagnostic report is too large.');
    largest[1].shift();
    sections[largest[0]].truncated = true;
    sections[largest[0]].rows = largest[1].length;
    report.coverage.truncated = true;
    encoded = JSON.stringify(report, null, 2);
  }
  return encoded;
}
