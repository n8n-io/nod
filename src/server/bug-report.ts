import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { feedbackLimits, type FeedbackContext } from '../shared/feedback.ts';
import { parseFeedbackActivity, type FeedbackActivity } from '../shared/feedback-activity.ts';
import { integrationServiceIds } from '../shared/integrations.ts';
import { browserSignInGuard } from '../shared/browser-errors.ts';
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

export interface FeedbackClientState {
  online?: boolean;
  visibility?: 'visible' | 'hidden';
  stream?: 'open' | 'connecting' | 'closed' | 'unknown';
  lastEventAgeMs?: number | null;
  streamReconnects?: number;
  savedMessages?: number | null;
  renderedMessages?: number | null;
  pendingTurn?: boolean | null;
  viewport?: { width: number; height: number };
  locale?: string;
  timeZone?: string;
  clockOffsetMs?: number | null;
  uptimeMs?: number;
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
  failures?: () => Promise<FeedbackLogSnapshot>;
  dataRoot?: string;
  trustModel?: string;
  client?: FeedbackClientState;
  environment?: NodeJS.ProcessEnv;
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
  'codemode',
  'files',
  'flights',
  'history_search',
  'limits_update',
  'memory_learn',
  'nod_docs',
  'prepared_list',
  'prepared_update',
  'proactive_issue',
  'read_source',
  'tool_search',
  'usage_get',
  'ask_user',
  'browser',
  'computer',
  'create_audio',
  'delegate',
  'follow_up',
  'manage_apps',
  'manage_personal_context',
  'memory',
  'nod',
  'pay',
  'react_to_message',
  'send_message',
  'share_file',
  'sign_in',
  'skills',
  'task',
];
const usageCategories = ['agent', 'memory', 'review', 'tasks', 'analytics', 'task_classification'];
const usageOperations = [
  'request',
  'compaction',
  'cache_warm',
  'auxiliary',
  'models',
  'attention',
  'review',
  'access',
  'trust',
  'read_only',
  'approval_reply',
  'reflect',
  'style',
  'plan',
  'ideas',
  'classify',
  'vision',
  'recall',
  'remember',
  'skill',
  'transcribe',
  'synthesize',
];
const protectedLists = ['failures', 'startupLog', 'settings', 'modelSettings', 'channelSettings'];
const channels = ['web', 'telegram', 'whatsapp'];
const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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

const modelWords = new Set(
  `gpt claude gemini gemma llama deepseek qwen qwq mistral mixtral codestral devstral phi grok kimi glm
  minimax command nova titan sonnet opus haiku fable mythos mini nano pro max flash lite turbo preview
  latest instruct chat coder code codex reasoner thinking vision large medium small tiny base plus ultra
  exp experimental it gguf openai anthropic google meta mistralai xai ai microsoft amazon cohere
  moonshotai zai nvidia bedrock vertex us eu global oss free nitro online high low compatible`.split(
    /\s+/,
  ),
);

function modelName(value: unknown) {
  return typeof value === 'string' &&
    value.length <= 120 &&
    /^[A-Za-z0-9][\w.:/@-]*$/.test(value) &&
    (value.toLowerCase().match(/[a-z]+/g) ?? []).every(
      (word) => word.length <= 2 || modelWords.has(word),
    )
    ? value
    : null;
}

function clip(value: unknown) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return encoded.length <= 6000
    ? value
    : { preview: encoded.slice(0, 4000), tail: encoded.slice(-1500), truncated: true };
}

function tool(value: unknown) {
  const name = typeof value === 'string' ? value.replaceAll(' ', '_') : '';
  if (name.startsWith('mcp__')) return 'mcp';
  if (['read', 'bash', 'edit', 'write', 'find', 'ls', 'grep'].includes(name)) return 'workspace';
  if (['web_search', 'fetch_content', 'get_search_content', 'code_search'].includes(name))
    return 'web';
  return choice(name, tools, 'other');
}

export async function buildFeedbackReport(options: FeedbackReportOptions) {
  const now = Date.now();
  const databasePool = {
    max: amount(options.pool.options?.max),
    total: amount(options.pool.totalCount),
    idle: amount(options.pool.idleCount),
    waiting: amount(options.pool.waitingCount),
  };
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
  const modelId = (value: unknown) => {
    const id = modelName(value);
    return id && redact?.text(id) === id ? id : null;
  };
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
       CASE WHEN text IS NULL THEN NULL WHEN octet_length(text)<=65536 THEN text ELSE '[message omitted: content limit]' END AS text,
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
      `SELECT id,parent_turn_id,session_id,source,channel,status,background,proactive,waiting_reason,
       EXISTS(SELECT 1 FROM turn_events e WHERE e.turn_id=turns.id AND e.type='source_screened') AS screened,
       error IS NOT NULL AS error_present,
       CASE WHEN error IS NULL THEN NULL WHEN octet_length(error)<=65536 THEN error ELSE '[error omitted: content limit]' END AS error,
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
        proactive: row.proactive === true,
        screened: row.screened === true,
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
          'thought',
          'intent',
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
          'source_screened',
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
          model: modelId(details.model),
          category: choice(details.category, usageCategories),
          operation: choice(details.operation, usageOperations),
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
      `SELECT id,provider,method,status,managed,created_at,
       to_jsonb(model_connections)->'models' AS models,
       to_jsonb(model_connections)->'request_failures' AS request_failures
       FROM model_connections WHERE owner_id=$1 ORDER BY created_at DESC,id DESC`,
      (row) => ({
        id: alias('modelConnection', row.id),
        models: (Array.isArray(row.models) ? row.models : []).slice(0, 30).map((item) => {
          const model = record(item);
          return {
            id: modelId(model.id),
            contextWindow: amount(model.contextWindow),
            images: model.images === true,
            efforts: Array.isArray(model.efforts)
              ? model.efforts.map((effort) => choice(effort, efforts))
              : [],
          };
        }),
        modelCount: Array.isArray(row.models) ? row.models.length : null,
        requestFailures: Object.keys(record(row.request_failures)).length,
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
      `SELECT s.id,s.kind,s.enabled,s.next_run_at,
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
    collect(
      'modelSettings',
      `SELECT selection,to_jsonb(model_settings)->'routes' AS routes FROM model_settings WHERE owner_id=$1`,
      (row) => {
        const selected = (value: unknown) => {
          if (value === 'light') return 'light';
          const selection = record(value);
          return typeof selection.modelId === 'string'
            ? {
                connection: alias('modelConnection', selection.connectionId),
                model: modelId(selection.modelId),
                effort: choice(selection.effort, efforts),
              }
            : null;
        };
        const routes = record(row.routes);
        return {
          selection: selected(row.selection),
          schedule: selected(routes.schedule),
          background: selected(routes.background),
        };
      },
      [options.ownerId],
    ),
    collect(
      'modelUsageSummary',
      `SELECT u.details->>'provider' AS provider,u.details->>'model' AS model,u.details->>'category' AS category,
       u.details->>'operation' AS operation,u.details->>'status' AS status,count(*)::int AS requests,
       sum(u.cost_usd)::float8 AS cost_usd,max(u.created_at) AS created_at
       FROM model_usage u WHERE u.owner_id=$1 AND u.created_at BETWEEN $2 AND $3
       GROUP BY 1,2,3,4,5 ORDER BY max(u.created_at) DESC`,
      (row) => ({
        provider: choice(row.provider, providers, 'other'),
        model: modelId(row.model),
        category: choice(row.category, usageCategories),
        operation: choice(row.operation, usageOperations),
        status: choice(row.status, outcomes),
        requests: amount(row.requests),
        costUsd: cost(row.cost_usd),
        lastAgeMs: age(row.created_at),
      }),
      recent,
      100,
    ),
    collect(
      'settings',
      `SELECT p.time_zone,p.locale,p.hour_cycle,p.quiet_hours_enabled,p.quiet_start,p.quiet_end,
       to_jsonb(p)->'proactive_paused' AS proactive_paused,
       to_jsonb(p)->'local_files_enabled' AS local_files_enabled,
       to_jsonb(p)->>'speech_reply' AS speech_reply,
       p.notification_rule<>'' AS notification_rule_set,
       COALESCE(to_jsonb(p)->>'rules','')<>'' AS rules_set,
       l.monthly_usd,to_jsonb(l)->'task_usd' AS task_usd,to_jsonb(l)->'preparation_usd' AS preparation_usd
       FROM preferences p LEFT JOIN spending_limits l ON l.owner_id=p.owner_id WHERE p.owner_id=$1`,
      (row) => ({
        timeZone:
          typeof row.time_zone === 'string' && /^[A-Za-z0-9_+/-]{1,64}$/.test(row.time_zone)
            ? row.time_zone
            : null,
        locale:
          typeof row.locale === 'string' && /^[A-Za-z0-9-]{1,35}$/.test(row.locale)
            ? row.locale
            : null,
        hourCycle: choice(row.hour_cycle, ['auto', 'h12', 'h23']),
        quietHours: row.quiet_hours_enabled === true,
        quietStart: /^\d{2}:\d{2}$/.test(String(row.quiet_start)) ? row.quiet_start : null,
        quietEnd: /^\d{2}:\d{2}$/.test(String(row.quiet_end)) ? row.quiet_end : null,
        proactivePaused: row.proactive_paused === true,
        localFiles: row.local_files_enabled === true,
        speechReply: choice(row.speech_reply, ['auto', 'voice', 'always', 'never']),
        notificationRuleSet: row.notification_rule_set === true,
        rulesSet: row.rules_set === true,
        monthlyLimitUsd: cost(row.monthly_usd),
        taskCheckInUsd: cost(row.task_usd),
        preparationAllowanceUsd: cost(row.preparation_usd),
      }),
      [options.ownerId],
    ),
    collect(
      'channelSettings',
      `SELECT provider,enabled,summary,updated_at FROM channel_settings WHERE owner_id=$1 ORDER BY provider`,
      (row) => {
        const summary = record(row.summary);
        return {
          provider: choice(row.provider, channels, 'other'),
          enabled: row.enabled === true,
          managed: summary.managed === true,
          mode: choice(summary.mode, ['polling', 'webhook', 'linked']),
          connectionState: choice(summary.connectionState, [
            'connecting',
            'awaiting_scan',
            'connected',
            'disconnected',
            'logged_out',
            'expired',
            'failed',
          ]),
          webhookStatus: choice(summary.webhookStatus, [
            'registered',
            'manual_setup',
            'registration_pending',
          ]),
          updatedAgeMs: age(row.updated_at),
        };
      },
      [options.ownerId],
    ),
  ]);
  let database: string | null = null;
  try {
    const result = await options.pool.query<{ version: string }>(
      `SELECT current_setting('server_version') AS version`,
    );
    database = String(result.rows[0]?.version ?? '').slice(0, 40) || null;
  } catch {}
  const unavailableCoverage = { hours: 24, dropped: 0, truncated: false, unavailable: true };
  async function journal(name: string, read?: () => Promise<FeedbackLogSnapshot>) {
    let coverage: FeedbackLogSnapshot['coverage'] = unavailableCoverage;
    let entries: FeedbackLogSnapshot['entries'] = [];
    if (redact && read) {
      try {
        const snapshot = await read();
        coverage = snapshot.coverage;
        entries = snapshot.entries.filter(
          (entry) => entry.at <= now && entry.at >= now - 86_400_000,
        );
      } catch {}
    }
    sections[name] = {
      status: coverage.unavailable ? 'unavailable' : 'collected',
      scope: 'recent',
      rows: entries.length,
      truncated: coverage.truncated || coverage.dropped > 0,
    };
    return { coverage, entries };
  }
  const entryRow = (entry: FeedbackLogSnapshot['entries'][number]) => ({
    event: entry.event,
    ageMs: amount(now - entry.at),
    turnId: alias('t', entry.scope.turnId),
    sessionId: alias('s', entry.scope.sessionId),
    runId: alias('r', entry.scope.runId),
    parentRunId: alias('r', entry.scope.parentRunId),
    callId: alias('c', entry.scope.callId),
  });
  const recorded = await journal('logs', options.logs);
  const failed = await journal('failures', options.failures);
  const logCoverage = recorded.coverage;
  lists.logs = recorded.entries
    .filter((entry) => entry.event !== 'failure')
    .map((entry) => {
      const data = record(redact!.value(entry.data));
      return {
        ...entryRow(entry),
        data: entry.event === 'tool_end' ? { ...data, output: clip(data.output) } : data,
      };
    });
  const repeated = new Map<string, Row>();
  for (const entry of [
    ...recorded.entries.filter((entry) => entry.event === 'failure'),
    ...failed.entries,
  ].sort((a, b) => a.at - b.at)) {
    const data = record(redact!.value(entry.data));
    const error = record(data.error);
    const key = JSON.stringify([
      data.event,
      error.name,
      error.message,
      error.code,
      error.status,
      record(data.context).reason,
      browserSignInGuard(record(data.context).signInGuard),
      choice(record(data.context).method, ['signInMethods', 'selectSignInMethod']),
    ]);
    const previous = repeated.get(key);
    repeated.delete(key);
    repeated.set(key, {
      ...entryRow(entry),
      count:
        ((previous?.count as number) ?? 0) + Math.max(1, amount(record(data.context).count) ?? 1),
      firstAgeMs: previous?.firstAgeMs ?? amount(now - entry.at),
      data,
    });
  }
  lists.failures = [...repeated.values()].slice(-150);
  sections.failures.rows = lists.failures.length;
  sections.failures.truncated ||= repeated.size > lists.failures.length;
  lists.startupLog = [];
  let startupLog: 'collected' | 'unavailable' = 'unavailable';
  let startupTruncated = false;
  if (redact && options.dataRoot) {
    try {
      const handle = await open(
        join(options.dataRoot, 'logs', 'startup.log'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe startup log.');
        const { size } = stat;
        const bytes = Buffer.alloc(Math.min(size, 48_000));
        await handle.read(bytes, 0, bytes.length, size - bytes.length);
        const lines = bytes
          .toString('utf8')
          .split('\n')
          .slice(size > bytes.length ? 1 : 0)
          .filter(Boolean);
        startupTruncated = size > bytes.length || lines.length > 200;
        lists.startupLog = lines.slice(-200).map((line) => {
          const stamp = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /.exec(line);
          return {
            ageMs: stamp ? amount(now - Date.parse(stamp[1])) : null,
            line: redact!.text(line.slice(stamp?.[0].length ?? 0)).slice(0, 4000),
          };
        });
        startupLog = 'collected';
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') startupLog = 'collected';
    }
  }
  sections.startupLog = {
    status: startupLog,
    scope: 'recent',
    rows: lists.startupLog.length,
    truncated: startupTruncated,
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
  const environment = options.environment ?? process.env;
  const bounded = (value: unknown, pattern: RegExp) =>
    typeof value === 'string' && pattern.test(value) ? value : null;
  const megabytes = (value: number) => Math.round(value / 1_048_576);
  const report = {
    format: 'nod-feedback-report-v3',
    revision: 2,
    purpose: 'support-debugging-and-product-improvement',
    generatedAt: new Date(now).toISOString(),
    ...(options.context ? { environment: feedbackTechnicalContext(options.context) } : {}),
    system: {
      os: bounded(os.type(), /^[\w .-]{1,40}$/),
      osRelease: bounded(os.release(), /^[\w .+~-]{1,80}$/),
      osVersion: bounded(environment.NOD_OS_VERSION, /^[\w .+~-]{1,80}$/),
      arch: bounded(os.arch(), /^[\w-]{1,20}$/),
      cpus: os.cpus().length,
      memoryMb: megabytes(os.totalmem()),
      freeMemoryMb: megabytes(os.freemem()),
      processMemoryMb: megabytes(process.memoryUsage.rss()),
      node: bounded(process.versions.node, /^[\w.+-]{1,40}$/),
      electron: bounded(environment.NOD_ELECTRON_VERSION, /^[\w.+-]{1,40}$/),
      database,
      databasePool,
      container: existsSync('/.dockerenv'),
      uptimeSeconds: Math.round(process.uptime()),
      timeZone: bounded(Intl.DateTimeFormat().resolvedOptions().timeZone, /^[\w+/-]{1,64}$/),
      utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    },
    runtime: {
      provider: choice(options.provider, providers, 'other'),
      modelFamily: modelFamily(options.model),
      model: modelId(options.model),
      trustModel: choice(options.trustModel, ['selected', 'llm', 'decision']),
    },
    ...(options.client ? { client: options.client } : {}),
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
    const filled = Object.entries(lists).filter(([, rows]) => rows.length);
    const largest = (
      filled.some(([name]) => !protectedLists.includes(name))
        ? filled.filter(([name]) => !protectedLists.includes(name))
        : filled
    ).sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0];
    if (!largest) throw new Error('The diagnostic report is too large.');
    largest[1].shift();
    sections[largest[0]].truncated = true;
    sections[largest[0]].rows = largest[1].length;
    report.coverage.truncated = true;
    encoded = JSON.stringify(report, null, 2);
  }
  return encoded;
}
