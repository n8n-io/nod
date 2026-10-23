import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Agent, AgentSessionOptions } from '../ports/agent.ts';
import type { ExecutionScope } from '../shared/execution.ts';
import type { ProviderUsageEvent, UsageTelemetry } from '../ports/provider-usage.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { DecisionModel } from '../ports/decisions.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type { TrustAction, TrustEntry, TrustSource, TrustView } from '../shared/trust.ts';
import type { MessageReceipt } from '../shared/contracts.ts';
import { becauseOf, type TrustBasis } from './trust-basis.ts';
import { actionTitle } from './action-presentation.ts';
import { formattingLocale, localeRegion, timeZoneRegion } from '../shared/date-locale.ts';
import type { UsageReport } from './usage-report.ts';
import { transaction } from './transaction.ts';
import { analyticsModel, type CaptureAnalytics } from './analytics.ts';

export const spendingLimitReached =
  'Paused because this month’s spending limit was reached. Raise the limit in Usage to resume.';
export const defaultTaskUsd = 5;
const usd = z
  .number()
  .min(1)
  .refine(
    (value) =>
      Number.isSafeInteger(Math.round(value * 100)) && Math.round(value * 100) / 100 === value,
  )
  .nullable();
export const limitsInput = z
  .object({ monthlyUsd: usd.optional(), taskUsd: usd.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose a limit to change.');

const zone = `COALESCE((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC')`;
const monthStart = `(date_trunc('month', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
const spentThisMonth = `COALESCE((SELECT sum(cost_usd::numeric) FROM model_usage WHERE owner_id=$1 AND created_at>=${monthStart}),0)::float8`;
const pageSize = 30;
const cost = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function describe(row: Record<string, any>): Pick<TrustEntry, 'title' | 'source'> {
  const id: string = row.source_id ?? '';
  const first = (text: string | null) => text?.trim().split('\n')[0]?.slice(0, 120);
  if (row.source === 'user') return { source: 'chat', title: first(row.text) || 'Your message' };
  if (row.source === 'task') return { source: 'task', title: first(row.text) || 'Task work' };
  if (row.source === 'schedule')
    return { source: 'schedule', title: first(row.schedule) || 'Scheduled task' };
  if (row.source === 'resume')
    return {
      source: 'resume',
      title: id.startsWith('confirmation:') ? 'Ran an action you approved' : 'Continued a task',
    };
  if (id.startsWith('activity-check:'))
    return { source: 'check', title: 'Checked a connected app' };
  if (id.startsWith('reaction:')) return { source: 'chat', title: 'Your reaction' };
  return { source: 'event', title: 'Woke for an email or app event' };
}

function modelUsed(usage: ProviderUsageEvent): Parameters<CaptureAnalytics>[0] {
  const tokens = (value: number | undefined) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const charged = cost(usage.costUsd);
  const estimated = cost(usage.estimateUsd);
  const spent = charged ?? estimated;
  return {
    event: 'nod_model_used',
    properties: {
      ...analyticsModel(usage.provider, usage.model),
      purpose: usage.category,
      outcome: usage.status,
      input_tokens:
        tokens(usage.inputTokens) + tokens(usage.cacheReadTokens) + tokens(usage.cacheWriteTokens),
      output_tokens: tokens(usage.outputTokens),
      ...(usage.cacheReadTokens !== undefined
        ? { cached_input_tokens: tokens(usage.cacheReadTokens) }
        : {}),
      ...(spent !== null ? { cost_usd: Math.round(spent * 1e6) / 1e6 } : {}),
      pricing: charged !== null ? 'api' : estimated !== null ? 'plan_estimate' : 'unavailable',
      ...(usage.durationMs > 0 && Number.isFinite(usage.durationMs)
        ? { duration_ms: Math.round(usage.durationMs) }
        : {}),
    },
  };
}

export function createLedger({
  pool,
  ownerId,
  analytics,
  telemetry,
}: {
  pool: Pool;
  ownerId: string;
  analytics?: CaptureAnalytics;
  telemetry?: UsageTelemetry;
}) {
  const activeTurn = new AsyncLocalStorage<string>();
  const activeExecution = new AsyncLocalStorage<
    ExecutionScope & Pick<AgentSessionOptions, 'onEvent'>
  >();
  async function initialize() {
    await pool.query(`CREATE TABLE IF NOT EXISTS model_usage (
      id text PRIMARY KEY, owner_id text NOT NULL, turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
      cost_usd double precision, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS run_id uuid;
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS parent_run_id uuid;
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS session_id uuid;
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS browser_id text;
    ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS model_usage_owner_time ON model_usage(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS model_usage_turn ON model_usage(turn_id);
    CREATE INDEX IF NOT EXISTS model_usage_session_time ON model_usage(session_id,created_at);
    CREATE TABLE IF NOT EXISTS app_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL,
      turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE app_actions DROP COLUMN IF EXISTS effect;
    ALTER TABLE app_actions ADD COLUMN IF NOT EXISTS basis jsonb;
    CREATE INDEX IF NOT EXISTS app_actions_owner_time ON app_actions(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS app_actions_turn ON app_actions(turn_id);
    CREATE TABLE IF NOT EXISTS spending_limits (
      owner_id text PRIMARY KEY, monthly_usd double precision CHECK (monthly_usd > 0)
    );
    ALTER TABLE spending_limits ALTER COLUMN monthly_usd DROP NOT NULL;
    ALTER TABLE spending_limits ADD COLUMN IF NOT EXISTS task_usd double precision
      DEFAULT ${defaultTaskUsd} CHECK (task_usd > 0);`);
  }

  function save(sql: string, values: unknown[]) {
    return pool.query(sql, values).then(
      () => undefined,
      (error) => console.error(`The ledger skipped a record: ${error?.name ?? 'error'}`),
    );
  }

  const usageSql = `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,created_at,run_id,parent_run_id,session_id,browser_id,details)
    SELECT $1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10::jsonb
    WHERE $3::uuid IS NULL OR EXISTS(SELECT 1 FROM turns WHERE id=$3 AND owner_id=$2)
    ON CONFLICT(id) DO NOTHING`;
  const pendingUsage = new Map<string, { values: unknown[]; pending: Promise<void> }>();
  async function flushUsage() {
    await Promise.all([...pendingUsage.values()].map(({ pending }) => pending));
    for (const [id, { values }] of pendingUsage) {
      await pool.query(usageSql, values);
      pendingUsage.delete(id);
    }
  }

  function record(
    usage: ProviderUsageEvent,
    execution: ExecutionScope | null | undefined = activeExecution.getStore(),
  ) {
    const { id, costUsd, turnId, ...details } = usage;
    const attributedTurn =
      execution === null ? null : (execution?.turnId ?? turnId ?? activeTurn.getStore() ?? null);
    const values = [
      id,
      ownerId,
      attributedTurn,
      cost(costUsd),
      new Date().toISOString(),
      execution?.runId ?? null,
      execution?.parentRunId ?? null,
      execution?.sessionId ?? null,
      execution?.browserId ?? null,
      JSON.stringify(details),
    ];
    const pending = pool.query(usageSql, values).then(
      () => {
        pendingUsage.delete(id);
      },
      (error) => console.error(`The ledger could not save usage: ${error?.name ?? 'error'}`),
    );
    pendingUsage.set(id, { values, pending });
    analytics?.(modelUsed(usage));
    telemetry?.record({ ...usage, turnId: attributedTurn ?? undefined });
  }

  function agent(base: Agent): Agent {
    return {
      ...base,
      open: async (session) => {
        if (await limitReached()) throw new Error(spendingLimitReached);
        const opened = await base.open({
          ...session,
          onEvent(event) {
            if (event.type === 'model_usage') {
              const { type: _, costSource, totalTokens: __, createdAt: ___, ...value } = event;
              record(
                {
                  ...value,
                  turnId: session.turnId,
                  category: 'agent',
                  operation: 'request',
                  status: value.status ?? 'succeeded',
                  durationMs: Math.max(0, Date.now() - Date.parse(event.createdAt)) || 0,
                  pricing: costSource,
                },
                session,
              );
            }
            if (event.type === 'provider_usage')
              record({ ...event.usage, turnId: session.turnId }, session);
            session.onEvent(event);
          },
        });
        return {
          ...opened,
          async prompt(text, images) {
            try {
              await activeExecution.run(session, () => opened.prompt(text, images));
            } finally {
              await flushUsage();
            }
          },
        };
      },
    };
  }

  function curator(base: MemoryCurator): MemoryCurator {
    return {
      ...base,
      get configured() {
        return base.configured;
      },
      curate: async (request, signal, report) => {
        if (await limitReached()) throw new Error(spendingLimitReached);
        try {
          return await base.curate(request, signal, (value) => {
            const usage: ProviderUsageEvent = {
              provider: value.provider ?? 'model',
              category:
                request.task === 'vision'
                  ? 'agent'
                  : request.task === 'review' || request.task === 'access'
                    ? 'review'
                    : request.task === 'plan'
                      ? 'tasks'
                      : request.task === 'analytics'
                        ? 'analytics'
                        : 'memory',
              operation: request.task,
              status: 'succeeded',
              durationMs: 0,
              ...value,
            };
            record(usage);
            activeExecution.getStore()?.onEvent({ type: 'provider_usage', usage });
            report?.(value);
          });
        } finally {
          await flushUsage();
        }
      },
    };
  }

  function decisions(base: DecisionModel): DecisionModel {
    return {
      async check(request, signal, report) {
        if (await limitReached()) throw new Error(spendingLimitReached);
        try {
          return await base.check(request, signal, (usage) => {
            record(usage);
            activeExecution.getStore()?.onEvent({ type: 'provider_usage', usage });
            report?.(usage);
          });
        } finally {
          await flushUsage();
        }
      },
    };
  }

  function action(turnId: string, name: string, basis: TrustBasis) {
    return save(
      `INSERT INTO app_actions(owner_id,turn_id,action,basis)
       SELECT $1,id,$3,$4 FROM turns WHERE id=$2 AND owner_id=$1`,
      [ownerId, turnId, name.slice(0, 200), JSON.stringify(basis)],
    );
  }

  function speech(base: SpeechProvider): SpeechProvider {
    const report = (usage: ProviderUsageEvent, preprocessing = false) => {
      record(usage, preprocessing ? null : undefined);
      activeExecution.getStore()?.onEvent({ type: 'provider_usage', usage });
    };
    return {
      ...base,
      get configured() {
        return base.configured;
      },
      get transcriptionConfigured() {
        return base.transcriptionConfigured;
      },
      async synthesize(text, signal, onUsage) {
        if (await limitReached()) throw new Error(spendingLimitReached);
        try {
          return await base.synthesize(text, signal, (usage) => {
            report(usage);
            onUsage?.(usage);
          });
        } finally {
          await flushUsage();
        }
      },
      ...(base.transcribe
        ? ({
            async transcribe(audio, signal, onUsage) {
              if (await limitReached()) throw new Error(spendingLimitReached);
              try {
                return await base.transcribe!(audio, signal, (usage) => {
                  report(usage, true);
                  onUsage?.(usage);
                });
              } finally {
                await flushUsage();
              }
            },
          } satisfies Pick<SpeechProvider, 'transcribe'>)
        : {}),
    };
  }

  async function limits() {
    const row = (
      await pool.query(
        `SELECT monthly_usd,task_usd,${spentThisMonth} AS spent FROM spending_limits WHERE owner_id=$1`,
        [ownerId],
      )
    ).rows[0];
    return {
      limit:
        typeof row?.monthly_usd === 'number'
          ? { monthlyUsd: row.monthly_usd, reached: row.spent >= row.monthly_usd }
          : null,
      taskUsd: row ? (row.task_usd as number | null) : defaultTaskUsd,
    };
  }

  async function limitReached() {
    await flushUsage();
    return Boolean((await limits()).limit?.reached);
  }

  async function checkIn(sessionId: string, turnId: string) {
    await flushUsage();
    const [{ taskUsd }, spent] = await Promise.all([
      limits(),
      pool.query(
        `WITH boundary AS (
           SELECT t.id,t.created_at FROM turns t JOIN turns c ON c.id=$3 AND c.owner_id=$1
             WHERE t.owner_id=$1 AND t.session_id=$2 AND t.source IN ('user','task')
               AND (t.created_at,t.id)<=(c.created_at,c.id)
           ORDER BY t.created_at DESC,t.id DESC LIMIT 1
         ) SELECT COALESCE(sum(COALESCE(cost_usd,(details->>'estimateUsd')::float8)),0)::float8 AS spent
         FROM model_usage WHERE owner_id=$1 AND session_id=$2
           AND (created_at>=COALESCE((SELECT created_at FROM boundary),'-infinity')
             OR turn_id=(SELECT id FROM boundary))`,
        [ownerId, sessionId, turnId],
      ),
    ]);
    return taskUsd === null ? undefined : { budgetUsd: taskUsd, spentUsd: spent.rows[0].spent };
  }

  async function attributeMediaUsage(client: PoolClient, ids: string[], turnId: string) {
    if (!ids.length) return;
    await client.query(
      `UPDATE model_usage m SET turn_id=u.id,session_id=u.session_id,
         run_id=NULL,parent_run_id=NULL,browser_id=NULL
       FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND m.owner_id=$2
         AND m.id=ANY($3::text[]) AND m.turn_id IS NULL
         AND m.details->>'operation'='transcribe'`,
      [turnId, ownerId, ids],
    );
  }

  async function sessionCosts(sessionIds: string[]): Promise<Record<string, number | null>> {
    if (!sessionIds.length) return {};
    const { rows } = await pool.query<{ sessionId: string; costUsd: number | null }>(
      `SELECT u.session_id AS "sessionId",
         CASE WHEN count(m.cost_usd)=count(*) THEN sum(m.cost_usd)::float8 END AS "costUsd"
       FROM model_usage m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND u.session_id=ANY($2::uuid[]) GROUP BY u.session_id`,
      [ownerId, [...new Set(sessionIds)]],
    );
    return Object.fromEntries(rows.map(({ sessionId, costUsd }) => [sessionId, costUsd]));
  }

  async function receipts(turnIds: string[]): Promise<Record<string, MessageReceipt>> {
    if (!turnIds.length) return {};
    const { rows } = await pool.query<{
      sessionId: string;
      messageId: string;
      actions: string[] | null;
    }>(
      `WITH sessions AS (
         SELECT DISTINCT u.session_id FROM turns u
         WHERE u.owner_id=$1 AND u.id=ANY($2::uuid[]) AND u.session_id<>u.thread_id)
       SELECT s.session_id AS "sessionId",
         (SELECT m.id FROM messages m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
           WHERE m.owner_id=$1 AND u.session_id=s.session_id AND m.role='assistant' AND m.text<>''
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS "messageId",
         (SELECT array_agg(a.action ORDER BY a.created_at) FROM app_actions a
           JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
           WHERE a.owner_id=$1 AND u.session_id=s.session_id
             AND a.basis IS NOT NULL AND a.basis->>'kind'<>'read') AS actions
       FROM sessions s
       WHERE (SELECT u.source FROM turns u WHERE u.owner_id=$1 AND u.session_id=s.session_id
           ORDER BY u.created_at,u.id LIMIT 1) IN ('task','schedule')
         AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.owner_id=$1 AND u.session_id=s.session_id
           AND u.status IN ('queued','running','waiting'))`,
      [ownerId, [...new Set(turnIds)]],
    );
    const costs = await sessionCosts(rows.map((row) => row.sessionId));
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (!row.messageId) return [];
        const counts = new Map<string, number>();
        for (const name of row.actions ?? []) {
          const { app, label } = actionTitle(name);
          const title = app ? `${app}: ${label}` : label;
          counts.set(title, (counts.get(title) ?? 0) + 1);
        }
        const costUsd = costs[row.sessionId] ?? null;
        if (!counts.size && costUsd === null) return [];
        return [
          [
            row.messageId,
            {
              sessionId: row.sessionId,
              actions: [...counts].map(([label, count]) => ({ label, count })),
              costUsd,
            },
          ],
        ];
      }),
    );
  }

  async function entries(before?: { at: string; id: string }, session?: string) {
    const { rows } = await pool.query(
      `SELECT u.id,u.source,u.source_id,u.channel,u.status,u.error,u.created_at,
         left(COALESCE((SELECT text FROM messages WHERE id=u.message_id AND owner_id=$1),u.prompt),400) AS text,c.cost,
         (SELECT title FROM schedules WHERE owner_id=$1 AND id::text=split_part(u.source_id,':',2)) AS schedule,
         (SELECT json_agg(json_build_object('action',a.action,'basis',a.basis,'said',m.id IS NOT NULL) ORDER BY a.created_at)
           FROM app_actions a LEFT JOIN messages m ON a.basis->>'kind'='message'
             AND m.owner_id=$1 AND m.id=(a.basis->>'messageId')::uuid
           WHERE a.turn_id=u.id) AS actions
       FROM turns u
       LEFT JOIN LATERAL (SELECT sum(cost_usd)::float8 AS cost,bool_or(cost_usd IS NULL) AS unpriced
         FROM model_usage WHERE turn_id=u.id) c ON true
       WHERE u.owner_id=$1 AND ($2::timestamptz IS NULL OR (u.created_at,u.id)<($2,$3::uuid))
         AND ($4::uuid IS NULL OR u.session_id=$4)
         AND (c.cost>0 OR c.unpriced OR EXISTS(SELECT 1 FROM app_actions a WHERE a.turn_id=u.id))
       ORDER BY u.created_at DESC,u.id DESC LIMIT ${pageSize + 1}`,
      [ownerId, before?.at ?? null, before?.id ?? null, session ?? null],
    );
    const page = rows.slice(0, pageSize).map((row): TrustEntry => ({
      id: row.id,
      at: row.created_at.toISOString(),
      ...describe(row),
      channel: String(row.channel).split(':')[0]!,
      error: row.status === 'failed' ? row.error : null,
      costUsd: row.cost,
      actions: (row.actions ?? []).map(
        (item: { action: string; basis: TrustBasis | null; said: boolean }): TrustAction => {
          const { app, label } = actionTitle(item.action);
          const because = becauseOf(item.basis, item.said);
          return { label: app ? `${app}: ${label}` : label, ...(because ? { because } : {}) };
        },
      ),
    }));
    const last = page.at(-1);
    return {
      entries: page,
      next: rows.length > pageSize && last ? { at: last.at, id: last.id } : null,
    };
  }

  async function read(): Promise<TrustView> {
    const [summary, daily, page, current] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM turn_events e JOIN turns u ON u.id=e.turn_id
             WHERE u.owner_id=$1 AND e.type='tool_complete' AND e.created_at>now()-interval '7 days')::int AS things,
           (SELECT count(*) FROM app_actions WHERE owner_id=$1
             AND created_at>now()-interval '7 days')::int AS actions,
           (SELECT COALESCE(sum(cost_usd),0) FROM model_usage WHERE owner_id=$1
             AND created_at>now()-interval '7 days')::float8 AS week,
           EXISTS(SELECT 1 FROM model_usage WHERE owner_id=$1 AND cost_usd IS NULL
             AND created_at>=${monthStart}) AS unpriced,
           ${monthStart} AS start,
           extract(day FROM date_trunc('month', now() AT TIME ZONE ${zone}) + interval '1 month - 1 day')::int AS days,
           extract(epoch FROM now()-${monthStart})::float8/86400 AS elapsed`,
        [ownerId],
      ),
      pool.query(
        `SELECT extract(day FROM created_at AT TIME ZONE ${zone})::int AS day,sum(cost_usd)::float8 AS cost
         FROM model_usage WHERE owner_id=$1 AND created_at>=${monthStart} GROUP BY 1`,
        [ownerId],
      ),
      entries(),
      limits(),
    ]);
    const row = summary.rows[0];
    const elapsed = Math.min(row.days, Math.max(row.elapsed, 0));
    const days: number[] = Array.from({ length: Math.ceil(elapsed) || 1 }, () => 0);
    for (const { day, cost } of daily.rows) if (day <= days.length) days[day - 1] = cost ?? 0;
    const spent = days.reduce((sum, value) => sum + value, 0);
    return {
      week: { things: row.things, actions: row.actions, spentUsd: row.week },
      month: {
        start: row.start.toISOString(),
        days: row.days,
        elapsedDays: elapsed,
        spentUsd: spent,
        forecastUsd: (spent / Math.max(elapsed, 1)) * row.days,
        daily: days,
        unpriced: row.unpriced,
      },
      ...current,
      ...page,
    };
  }

  async function report(): Promise<UsageReport> {
    const view = await read();
    const start = Date.parse(view.month.start);
    const items = [...view.entries];
    let next = view.next;
    while (next && Date.parse(next.at) >= start) {
      const page = await entries(next);
      items.push(...page.entries);
      next = page.next;
    }
    const preference = (
      await pool.query(
        `SELECT ${zone} AS zone,(SELECT locale FROM preferences WHERE owner_id=$1),
           COALESCE((SELECT hour_cycle FROM preferences WHERE owner_id=$1),'auto') AS hour_cycle`,
        [ownerId],
      )
    ).rows[0];
    return {
      view,
      entries: items.filter((entry) => Date.parse(entry.at) >= start),
      timeZone: preference.zone,
      locale: formattingLocale(localeRegion(preference.locale) ?? timeZoneRegion(preference.zone)),
      hourCycle: preference.hour_cycle,
    };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/trust', () => read());
    app.get('/api/trust/entries', (request) => {
      const query = z
        .object({
          at: z.iso.datetime().optional(),
          id: z.uuid().optional(),
          session: z.uuid().optional(),
        })
        .strict()
        .refine((value) => Boolean(value.at) === Boolean(value.id))
        .parse(request.query);
      return entries(
        query.at && query.id ? { at: query.at, id: query.id } : undefined,
        query.session,
      );
    });
    app.put('/api/trust/limit', (request) => setLimits(request.body));
  }

  async function setLimits(input: unknown) {
    const body = limitsInput.parse(input);
    await transaction(async (client) => {
      await client.query(
        'INSERT INTO spending_limits(owner_id,monthly_usd) VALUES($1,NULL) ON CONFLICT DO NOTHING',
        [ownerId],
      );
      for (const [key, column] of [
        ['monthlyUsd', 'monthly_usd'],
        ['taskUsd', 'task_usd'],
      ] as const)
        if (body[key] !== undefined)
          await client.query(`UPDATE spending_limits SET ${column}=$2 WHERE owner_id=$1`, [
            ownerId,
            body[key],
          ]);
      await client.query(
        `DELETE FROM spending_limits WHERE owner_id=$1 AND monthly_usd IS NULL AND task_usd=${defaultTaskUsd}`,
        [ownerId],
      );
    }, pool);
    return limits();
  }

  return {
    initialize,
    agent,
    curator,
    decisions,
    speech,
    attributeMediaUsage,
    action,
    limitReached,
    checkIn,
    limits,
    setLimits,
    sessionCosts,
    receipts,
    withTurn: <T>(turnId: string, run: () => T) => activeTurn.run(turnId, run),
    withExecution: <T>(
      execution: ExecutionScope & Pick<AgentSessionOptions, 'onEvent'>,
      run: () => T,
    ) => activeExecution.run(execution, run),
    read,
    report,
    registerRoutes,
  };
}
