import { logFailure } from './failure-log.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Agent, AgentSessionOptions } from '../ports/agent.ts';
import type { ExecutionScope } from '../shared/execution.ts';
import type { ProviderUsageEvent, UsageTelemetry } from '../ports/provider-usage.ts';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import type { DecisionModel } from '../ports/decisions.ts';
import type { SpeechProvider } from '../ports/speech.ts';
import type {
  TrustAction,
  TrustEntry,
  TrustOutside,
  TrustStep,
  TrustView,
} from '../shared/trust.ts';
import { trustStepPage as stepPage } from '../shared/trust.ts';
import { becauseOf, type TrustBasis } from './trust-basis.ts';
import { recordedAction, toolTitle } from './action-presentation.ts';
import { workspaceCommandsSql, workspaceCommand } from './workspace-commands.ts';
import { formattingLocale, localeRegion, timeZoneRegion } from '../shared/date-locale.ts';
import type { UsageReport } from './usage-report.ts';
import { afterCommit, transaction } from './transaction.ts';
import { analyticsModel, snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import { captureSettingChanges, type SettingActor } from './analytics-settings.ts';

export const spendingLimitReached = 'This month’s spending limit is reached.';
export const spendingLimitText = (monthlyUsd: number) =>
  `This month’s $${Number.isInteger(monthlyUsd) ? monthlyUsd : monthlyUsd.toFixed(2)} spending limit is reached.`;
const defaultTaskUsd = 5;
const newOwnerMonthlyUsd = 200;
const defaultPreparationUsd = 5;
const usd = z
  .number()
  .min(1)
  .refine(
    (value) =>
      Number.isSafeInteger(Math.round(value * 100)) && Math.round(value * 100) / 100 === value,
  )
  .nullable();
export const activityRange = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    session: z.uuid().optional(),
  })
  .strict();
export type ActivityRange = z.infer<typeof activityRange>;
export const limitsInput = z
  .object({
    monthlyUsd: usd.optional(),
    taskUsd: usd.optional(),
    preparationUsd: usd.unwrap().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose a limit to change.');

const zone = `COALESCE((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC')`;
const monthStart = `(date_trunc('month', now() AT TIME ZONE ${zone}) AT TIME ZONE ${zone})`;
const spentThisMonth = `COALESCE((SELECT sum(cost_usd::text::numeric) FROM model_usage WHERE owner_id=$1 AND created_at>=${monthStart}),0)::float8`;
const pageSize = 30;
const planUsage = `(cost_usd IS NULL AND (details->>'estimateUsd')::float8>0)`;
const unpricedUsage = `(details->>'status'='succeeded' AND COALESCE(cost_usd,(details->>'estimateUsd')::float8,0)=0)`;
const cost = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const titleMarkdown = unified().use(remarkParse).use(remarkGfm);

function visibleText(node: Nodes): string {
  if (node.type === 'html') return '';
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return '\n';
  if ('value' in node) return node.value;
  if ('children' in node)
    return node.children
      .map(visibleText)
      .join(
        node.type === 'tableRow'
          ? ' | '
          : ['root', 'blockquote', 'list', 'listItem', 'table'].includes(node.type)
            ? '\n'
            : '',
      );
  return '';
}

function messageTitle(value: string | null) {
  const excerpt = value?.trim().slice(0, 2_000);
  return excerpt
    ? (visibleText(titleMarkdown.parse(excerpt)).trim().split('\n', 1)[0]?.trim().slice(0, 120) ??
        '')
    : '';
}

function describe(row: Record<string, any>): Pick<TrustEntry, 'title' | 'source'> {
  const id: string = row.source_id ?? '';
  const first = (text: string | null) => text?.trim().split('\n')[0]?.slice(0, 120);
  const task = row.task as { title: string; started: boolean } | null;
  if (row.source === 'user')
    return { source: 'chat', title: messageTitle(row.text) || 'Your message' };
  if (row.source === 'task')
    return { source: 'task', title: messageTitle(row.text) || 'Task work' };
  if (row.source === 'schedule')
    return { source: 'schedule', title: first(row.schedule) || 'Scheduled task' };
  if (id.startsWith('task-check:'))
    return {
      source: task?.started ? 'started' : 'task',
      title: task ? `Checked on ${task.title}` : 'Checked on a task',
    };
  if (row.source === 'resume')
    return {
      source: 'resume',
      title: id.startsWith('confirmation:') ? 'Ran an action you approved' : 'Continued a task',
    };
  if (id.startsWith('proactivity:'))
    return {
      source: 'check',
      title: row.screened ? 'Checked source changes' : 'Assessed source changes',
    };
  if (id.startsWith('activity-check:'))
    return { source: 'check', title: 'Checked a connected app' };
  if (id.startsWith('reaction:')) return { source: 'chat', title: 'Your reaction' };
  if (task?.started) return { source: 'started', title: task.title };
  return { source: 'event', title: 'Woke for an email or app event' };
}

function reasonOf(basis: TrustBasis | null, said: boolean, whole: boolean | null) {
  const reason = becauseOf(basis, said);
  return reason?.kind === 'message' && whole ? { ...reason, whole: true as const } : reason;
}

const modelKinds: Record<string, string> = {
  review: 'Check',
  memory: 'Memory',
  task_classification: 'Sorting',
  tasks: 'Planning',
};

const tokens = (value: unknown) => {
  const count = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(count);
};

function presentStep(row: Record<string, any>): TrustStep {
  const at = row.at.toISOString();
  const helper = row.helper ? { helper: true as const } : {};
  if (row.kind === 'command') {
    const command: TrustStep['command'] = row.command;
    return {
      at,
      kind: 'tool',
      title: 'Workspace command',
      command,
      ...(command?.state === 'failed' || (command?.exitCode != null && command.exitCode !== 0)
        ? { failed: true as const }
        : {}),
      ...helper,
    };
  }
  if (row.kind === 'model') {
    const usage = row.usage ?? {};
    const input =
      (Number(usage.inputTokens) || 0) +
      (Number(usage.cacheReadTokens) || 0) +
      (Number(usage.cacheWriteTokens) || 0);
    const output = Number(usage.outputTokens) || 0;
    const plan = row.cost === null && Number(usage.estimateUsd) > 0 ? 'ChatGPT plan' : '';
    return {
      at,
      kind: 'model',
      title: [modelKinds[usage.category], usage.model || 'Model'].filter(Boolean).join(' · '),
      ...(input || output || plan
        ? {
            detail: [input || output ? `${tokens(input)} in · ${tokens(output)} out` : '', plan]
              .filter(Boolean)
              .join(' · '),
          }
        : {}),
      ...(row.cost > 0 ? { costUsd: row.cost } : {}),
      ...(usage.status === 'failed' ? { failed: true as const } : {}),
      ...helper,
    };
  }
  if (row.kind === 'action') {
    const because = reasonOf(row.basis, row.said, row.whole);
    const { label, target } = recordedAction(row.summary, row.detail);
    return {
      at,
      kind: 'action',
      title: label,
      ...(target ? { detail: target } : {}),
      ...(because ? { because } : {}),
      ...helper,
    };
  }
  if (row.kind === 'reply')
    return {
      at,
      kind: 'reply',
      title: 'Replied',
      detail: String(row.summary)
        .split('\n')[0]!
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replaceAll('**', ''),
    };
  if (row.type === 'step' || row.type === 'thought')
    return { at, kind: 'note', title: String(row.summary).slice(0, 500), ...helper };
  return {
    at,
    kind: 'tool',
    title: toolTitle(String(row.summary)),
    ...(row.detail ? { detail: String(row.detail) } : {}),
    ...(row.type === 'tool_failed' ? { failed: true as const } : {}),
    ...helper,
  };
}

function modelUsed(
  usage: ProviderUsageEvent,
  execution?: (ExecutionScope & Pick<AgentSessionOptions, 'restricted'>) | null,
): Parameters<CaptureAnalytics>[0] {
  const tokens = (value: number | undefined) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const charged = cost(usage.costUsd);
  const estimated = cost(usage.estimateUsd);
  const apiPriced =
    usage.pricing !== 'unavailable' &&
    charged !== null &&
    (charged > 0 || usage.pricing === 'reported');
  const planPriced = estimated !== null && estimated > 0;
  const spent = apiPriced ? charged : planPriced ? estimated : null;
  return {
    event: 'model_used',
    properties: {
      ...analyticsModel(usage.provider, usage.model),
      purpose: usage.category,
      request_kind:
        usage.category !== 'agent'
          ? usage.category
          : usage.operation === 'compaction' || usage.operation === 'cache_warm'
            ? usage.operation
            : usage.operation !== 'request'
              ? 'auxiliary'
              : execution?.parentRunId
                ? 'helper'
                : execution?.restricted
                  ? 'observer'
                  : execution
                    ? execution.sessionId === execution.threadId
                      ? 'chat'
                      : 'task'
                    : 'unclassified',
      ...(Number.isSafeInteger(usage.attempt) && usage.attempt! > 0 && usage.attempt! <= 4
        ? { attempt: usage.attempt }
        : {}),
      outcome: usage.status,
      input_tokens:
        tokens(usage.inputTokens) + tokens(usage.cacheReadTokens) + tokens(usage.cacheWriteTokens),
      output_tokens: tokens(usage.outputTokens),
      ...(usage.cacheReadTokens !== undefined
        ? { cached_input_tokens: tokens(usage.cacheReadTokens) }
        : {}),
      ...(spent !== null ? { cost_usd: Math.round(spent * 1e6) / 1e6 } : {}),
      pricing: apiPriced ? 'api' : planPriced ? 'plan_estimate' : 'unavailable',
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
  const activeTurn = new AsyncLocalStorage<{ id: string; automatic: boolean }>();
  const pastLimit = new AsyncLocalStorage<true>();
  const preparation = new AsyncLocalStorage<{ id: string; closed?: boolean }>();
  let preparationDeclined: { month: number; maximumUsd: number } | undefined;
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
    ALTER TABLE app_actions ADD COLUMN IF NOT EXISTS basis jsonb;
    ALTER TABLE app_actions ADD COLUMN IF NOT EXISTS target text;
    ALTER TABLE app_actions ADD COLUMN IF NOT EXISTS parent_run_id uuid;
    CREATE INDEX IF NOT EXISTS app_actions_owner_time ON app_actions(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS app_actions_turn ON app_actions(turn_id);
    CREATE TABLE IF NOT EXISTS spending_limits (
      owner_id text PRIMARY KEY, monthly_usd double precision CHECK (monthly_usd > 0)
    );
    ALTER TABLE spending_limits ADD COLUMN IF NOT EXISTS task_usd double precision
      DEFAULT ${defaultTaskUsd} CHECK (task_usd > 0);
    ALTER TABLE spending_limits ADD COLUMN IF NOT EXISTS preparation_usd double precision
      DEFAULT ${defaultPreparationUsd} CHECK (preparation_usd > 0);
    CREATE TABLE IF NOT EXISTS preparation_reservations (
      owner_id text NOT NULL, id uuid NOT NULL, month timestamptz NOT NULL,
      maximum_usd numeric NOT NULL CHECK (maximum_usd >= 0),
      PRIMARY KEY(owner_id,id,month)
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='preparation_reservations'::regclass
        AND attname='maximum_usd' AND atttypid='double precision'::regtype AND NOT attisdropped) THEN
        ALTER TABLE preparation_reservations ALTER COLUMN maximum_usd TYPE numeric USING maximum_usd::text::numeric;
      END IF;
    END $$;`);
  }

  function save(sql: string, values: unknown[]) {
    return pool.query(sql, values).then(
      () => undefined,
      (error) => logFailure('ledger_record_failed', error),
    );
  }

  const usageSql = `INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,created_at,run_id,parent_run_id,session_id,browser_id,details)
    SELECT $1,$2,t.id,$4,$5::timestamptz,$6,$7,$8,$9,$10::jsonb
    FROM (VALUES($3::uuid)) u(id) LEFT JOIN turns t ON t.id=u.id
    WHERE t.id IS NULL OR t.owner_id=$2
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
    if (preparation.getStore())
      Object.assign(details, { preparation: true, preparationId: preparation.getStore()!.id });
    const attributedTurn =
      execution === null
        ? null
        : (execution?.turnId ?? turnId ?? activeTurn.getStore()?.id ?? null);
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
      async () => {
        pendingUsage.delete(id);
        const scope = preparation.getStore();
        if (scope?.closed) await releasePreparation(scope.id);
      },
      (error) => logFailure('ledger_usage_failed', error, { turnId: attributedTurn }),
    );
    pendingUsage.set(id, { values, pending });
    analytics?.(modelUsed(usage, execution));
    telemetry?.record({ ...usage, turnId: attributedTurn ?? undefined });
  }

  async function preparationLimit(database: Pick<PoolClient, 'query'> = pool) {
    const { rows } = await database.query(
      `WITH budget AS (SELECT COALESCE((SELECT preparation_usd FROM spending_limits WHERE owner_id=$1),${defaultPreparationUsd})::text::numeric AS maximum, ${monthStart} AS month,
        COALESCE((SELECT sum(COALESCE(cost_usd::text::numeric,(details->>'estimateUsd')::numeric,0)) FROM model_usage
          WHERE owner_id=$1 AND created_at>=${monthStart} AND details->>'preparation'='true'),0) AS spent,
        COALESCE((SELECT sum(GREATEST(0,r.maximum_usd-COALESCE((SELECT sum(COALESCE(m.cost_usd::text::numeric,(m.details->>'estimateUsd')::numeric,0))
          FROM model_usage m WHERE m.owner_id=$1 AND m.details->>'preparationId'=r.id::text AND m.created_at>=r.month),0)))
          FROM preparation_reservations r WHERE r.owner_id=$1 AND r.month=${monthStart}),0) AS reserved)
        SELECT maximum::float8,spent::float8,reserved::float8,
          spent+reserved>=maximum OR (COALESCE(month=$2::timestamptz,false) AND spent+reserved+$3::numeric>maximum) AS reached
        FROM budget`,
      [
        ownerId,
        preparationDeclined ? new Date(preparationDeclined.month) : null,
        preparationDeclined?.maximumUsd ?? 0,
      ],
    );
    return {
      monthlyUsd: rows[0].maximum as number,
      spentUsd: rows[0].spent as number,
      reservedUsd: rows[0].reserved as number,
      reached: rows[0].reached as boolean,
    };
  }

  async function reserve(maximum: number | null | (() => number | null)) {
    const scope = preparation.getStore();
    if (!scope) return async () => {};
    if (scope.closed) throw new Error('This automatic preparation has stopped.');
    const maximumUsd = typeof maximum === 'function' ? maximum() : maximum;
    if (maximumUsd === null || !Number.isFinite(maximumUsd) || maximumUsd < 0)
      throw new Error('Automatic preparation stopped because this model has no cost estimate.');
    await flushUsage();
    let month: Date | undefined;
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `preparation-budget:${ownerId}`,
      ]);
      await client.query(
        `DELETE FROM preparation_reservations WHERE owner_id=$1 AND month<${monthStart}`,
        [ownerId],
      );
      const { rows } = await client.query(
        `WITH budget AS (SELECT COALESCE((SELECT preparation_usd FROM spending_limits WHERE owner_id=$1),${defaultPreparationUsd})::text::numeric AS maximum,
          ${monthStart} AS month,
          COALESCE((SELECT proactive_paused FROM preferences WHERE owner_id=$1),true) AS paused,
          (COALESCE((SELECT sum(COALESCE(m.cost_usd::text::numeric,(m.details->>'estimateUsd')::numeric,0)) FROM model_usage m
            WHERE m.owner_id=$1 AND m.created_at>=${monthStart} AND m.details->>'preparation'='true'
              AND NOT EXISTS(SELECT 1 FROM preparation_reservations r WHERE r.owner_id=$1 AND r.id::text=m.details->>'preparationId' AND r.month=${monthStart})),0)
          + COALESCE((SELECT sum(GREATEST(r.maximum_usd,COALESCE((SELECT sum(COALESCE(m.cost_usd::text::numeric,(m.details->>'estimateUsd')::numeric,0))
            FROM model_usage m WHERE m.owner_id=$1 AND m.details->>'preparationId'=r.id::text AND m.created_at>=r.month),0)))
            FROM preparation_reservations r WHERE r.owner_id=$1 AND r.month=${monthStart}),0)) AS committed)
          SELECT maximum::float8,month,paused,committed>=maximum OR committed+$2::numeric>maximum AS exceeded FROM budget`,
        [ownerId, maximumUsd],
      );
      if (scope.closed) throw new Error('This automatic preparation has stopped.');
      if (rows[0].paused && activeTurn.getStore()?.automatic !== false)
        throw new Error('Automatic preparation is paused.');
      month = rows[0].month;
      if (rows[0].exceeded) {
        preparationDeclined = { month: rows[0].month.getTime(), maximumUsd };
        throw new Error(
          `The next model request does not fit the $${rows[0].maximum} monthly preparation allowance. Change the preparation limit in Usage to continue.`,
        );
      }
      preparationDeclined = undefined;
      await client.query(
        `INSERT INTO preparation_reservations(owner_id,id,month,maximum_usd) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner_id,id,month) DO UPDATE SET maximum_usd=preparation_reservations.maximum_usd+EXCLUDED.maximum_usd`,
        [ownerId, scope.id, rows[0].month, maximumUsd],
      );
    }, pool);
    let settled = false;
    const settle = async (spentUsd: number | null) => {
      if (settled || spentUsd === null || !Number.isFinite(spentUsd) || spentUsd < 0) return;
      settled = true;
      await pool
        .query(
          'UPDATE preparation_reservations SET maximum_usd=GREATEST(0,maximum_usd+$4::numeric-$5::numeric) WHERE owner_id=$1 AND id=$2 AND month=$3',
          [ownerId, scope.id, month, spentUsd, maximumUsd],
        )
        .catch((error) => logFailure('preparation_reservation_settle', error));
      if (scope.closed) await releasePreparation(scope.id);
    };
    if (scope.closed) {
      await settle(0);
      throw new Error('This automatic preparation has stopped.');
    }
    return settle;
  }

  async function releasePreparation(id: string) {
    await pool
      .query(
        `DELETE FROM preparation_reservations r WHERE r.owner_id=$1 AND r.id=$2
        AND r.maximum_usd<=COALESCE((SELECT sum(COALESCE(m.cost_usd::text::numeric,(m.details->>'estimateUsd')::numeric,0))
          FROM model_usage m WHERE m.owner_id=$1 AND m.details->>'preparationId'=$2::text
          AND m.created_at>=r.month),0)`,
        [ownerId, id],
      )
      .catch((error) => logFailure('preparation_reservation_release', error));
  }

  async function withPreparation<T>(id: string, run: () => Promise<T>): Promise<T> {
    const scope = { id, closed: false };
    return preparation.run(scope, async () => {
      try {
        return await run();
      } finally {
        scope.closed = true;
        try {
          await flushUsage();
        } finally {
          await releasePreparation(id);
        }
      }
    });
  }
  function agent(base: Agent): Agent {
    return {
      ...base,
      open: async (session) => {
        if (await limitReached()) throw new Error(spendingLimitReached);
        let attempt = 1;
        const opened = await base.open({
          ...session,
          onEvent(event) {
            if (event.type === 'retry') attempt = event.attempt + 1;
            if (event.type === 'model_usage') {
              const { type: _, costSource, totalTokens: __, createdAt: ___, ...value } = event;
              record(
                {
                  ...value,
                  turnId: session.turnId,
                  category: 'agent',
                  operation: 'request',
                  attempt,
                  status: value.status ?? 'succeeded',
                  durationMs: Math.max(0, Date.now() - Date.parse(event.createdAt)) || 0,
                  pricing: costSource,
                },
                session,
              );
              if (value.status !== 'failed') attempt = 1;
            }
            if (event.type === 'provider_usage')
              record({ ...event.usage, turnId: session.turnId }, session);
            session.onEvent(event);
          },
        });
        return {
          ...opened,
          async prompt(...args) {
            attempt = 1;
            try {
              await activeExecution.run(session, () => opened.prompt(...args));
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
        request = {
          ...request,
          automatic: request.automatic ?? activeTurn.getStore()?.automatic ?? true,
        };
        try {
          return await base.curate(request, signal, (value) => {
            const usage: ProviderUsageEvent = {
              provider: value.provider ?? 'model',
              category:
                request.task === 'classify'
                  ? 'task_classification'
                  : request.task === 'vision' || request.task === 'attention'
                    ? 'agent'
                    : request.task === 'review' || request.task === 'access'
                      ? 'review'
                      : request.task === 'plan'
                        ? 'tasks'
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
    async function run(
      work: (report: (usage: ProviderUsageEvent) => void) => Promise<unknown>,
      signal?: AbortSignal,
      report?: (usage: ProviderUsageEvent) => void,
    ) {
      signal?.throwIfAborted();
      if (await limitReached()) throw new Error(spendingLimitReached);
      try {
        return await work((usage) => {
          record(usage);
          activeExecution.getStore()?.onEvent({ type: 'provider_usage', usage });
          report?.(usage);
        });
      } finally {
        await flushUsage();
      }
    }
    return {
      get configured() {
        return base.configured;
      },
      ...(base.select
        ? {
            async select(signal?: AbortSignal) {
              const selected = await base.select!(signal);
              return selected && decisions(selected);
            },
          }
        : {}),
      async check(request, signal, report) {
        signal?.throwIfAborted();
        if (base.configured === false) return undefined;
        return run((usage) => base.check(request, signal, usage), signal, report);
      },
    };
  }

  function action(turnId: string, name: string, basis: TrustBasis, target?: string) {
    return save(
      `INSERT INTO app_actions(owner_id,turn_id,action,basis,target,parent_run_id)
       SELECT $1,id,$3,$4,$5,$6 FROM turns WHERE id=$2 AND owner_id=$1`,
      [
        ownerId,
        turnId,
        name.slice(0, 200),
        JSON.stringify(basis),
        target?.slice(0, 300) ?? null,
        activeExecution.getStore()?.parentRunId ?? null,
      ],
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
      get voices() {
        return base.voices;
      },
      get defaultVoice() {
        return base.defaultVoice;
      },
      async synthesize(text, signal, onUsage, options) {
        if (preparation.getStore())
          throw new Error(
            'Automatic preparation cannot reserve the cost of speech generation. Ask for the audio in chat.',
          );
        if (await limitReached()) throw new Error(spendingLimitReached);
        try {
          return await base.synthesize(
            text,
            signal,
            (usage) => {
              report(usage);
              onUsage?.(usage);
            },
            options,
          );
        } finally {
          await flushUsage();
        }
      },
      ...(base.transcribe
        ? ({
            async transcribe(audio, signal, onUsage) {
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

  async function limits(database: Pick<PoolClient, 'query'> = pool) {
    const row = (
      await database.query(
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

  async function onboard(client: PoolClient) {
    await client.query(
      `INSERT INTO spending_limits(owner_id,monthly_usd) VALUES($1,${newOwnerMonthlyUsd}) ON CONFLICT DO NOTHING`,
      [ownerId],
    );
  }

  async function reachedLimit() {
    await flushUsage();
    const { limit } = await limits();
    return limit?.reached ? limit : null;
  }

  async function limitReached() {
    return !pastLimit.getStore() && Boolean(await reachedLimit());
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
         ) SELECT COALESCE(sum(COALESCE(cost_usd,(details->>'estimateUsd')::float8)),0)::float8 AS spent,
           COALESCE(sum((details->>'estimateUsd')::float8) FILTER (WHERE cost_usd IS NULL),0)::float8 AS plan
         FROM model_usage m LEFT JOIN turns t ON t.id=m.turn_id AND t.owner_id=m.owner_id
         WHERE m.owner_id=$1 AND COALESCE(m.session_id,t.session_id)=$2
           AND (m.created_at>=COALESCE((SELECT created_at FROM boundary),'-infinity')
             OR m.turn_id=(SELECT id FROM boundary))`,
        [ownerId, sessionId, turnId],
      ),
    ]);
    const { spent: spentUsd, plan: planUsd } = spent.rows[0];
    return taskUsd === null
      ? undefined
      : { budgetUsd: taskUsd, spentUsd, ...(planUsd > 0 ? { planUsd } : {}) };
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

  async function recentTurnCost(turnId?: string) {
    const { rows } = await pool.query<{ cost: number | null }>(
      `SELECT COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) FROM (
         SELECT sum(m.cost_usd) AS cost FROM model_usage m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
         WHERE m.owner_id=$1 AND u.status='succeeded' GROUP BY m.turn_id
         HAVING count(m.cost_usd)=count(*) AND sum(m.cost_usd)>0 ORDER BY max(m.created_at) DESC LIMIT 20) recent),
         (SELECT sum(cost_usd) FROM model_usage WHERE owner_id=$1 AND turn_id=$2::uuid
           HAVING count(cost_usd)=count(*) AND sum(cost_usd)>0))::float8 AS cost`,
      [ownerId, turnId ?? null],
    );
    return rows[0]?.cost ?? null;
  }

  async function select({
    before,
    after,
    session,
    start,
    end,
    limit,
  }: {
    before?: { at: string; id: string };
    after?: { at: string; id: string } | null;
    session?: string;
    start?: Date | null;
    end?: Date | null;
    limit: number | null;
  }) {
    const { rows } = await pool.query(
      `SELECT u.id,u.source,u.source_id,u.channel,u.status,u.error,u.created_at,
         to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor,
         (SELECT m.id FROM messages m JOIN threads th ON th.id=m.thread_id
           WHERE m.owner_id=$1 AND th.owner_id=$1 AND th.archived_at IS NULL AND m.hidden_at IS NULL
             AND m.thread_id=u.thread_id AND ((m.turn_id=u.id AND m.role='assistant') OR m.id=u.message_id)
           ORDER BY (m.turn_id=u.id AND m.role='assistant') DESC NULLS LAST,m.created_at DESC,m.id DESC LIMIT 1) AS message_id,
         left(COALESCE((SELECT text FROM messages WHERE id=u.message_id AND owner_id=$1),u.prompt),400) AS text,c.cost,c.models,c.plan,c.unpriced,
         (SELECT title FROM schedules WHERE owner_id=$1 AND id::text=split_part(u.source_id,':',2)) AS schedule,
         (SELECT json_build_object('title',t.title,'started',t.activity_key IS NOT NULL) FROM tasks t
           WHERE t.owner_id=$1 AND t.session_id=u.session_id LIMIT 1) AS task,
         EXISTS(SELECT 1 FROM turn_events e WHERE e.turn_id=u.id AND e.type='source_screened') AS screened,
         (SELECT json_agg(json_build_object('action',a.action,'target',a.target,'basis',a.basis,'said',m.id IS NOT NULL,
             'whole',regexp_replace(lower(m.text),'[^[:alnum:]]+','','g')=regexp_replace(lower(a.basis->>'quote'),'[^[:alnum:]]+','','g')) ORDER BY a.created_at)
           FROM app_actions a LEFT JOIN messages m ON a.basis->>'kind'='message'
             AND m.owner_id=$1 AND m.id=(a.basis->>'messageId')::uuid
           WHERE a.turn_id=u.id AND a.owner_id=$1) AS actions
       FROM turns u
       LEFT JOIN LATERAL (SELECT count(*) AS used,sum(cost_usd)::float8 AS cost,
           bool_or(${planUsage}) AS plan,bool_or(${unpricedUsage}) AS unpriced,
           jsonb_agg(DISTINCT jsonb_build_object(
             'provider',NULLIF(details->>'provider',''),
             'model',NULLIF(details->>'model',''),
             'billing',CASE WHEN cost_usd IS NULL AND details ? 'estimateUsd' THEN 'plan' ELSE 'api' END)) AS models
         FROM model_usage WHERE turn_id=u.id AND owner_id=$1) c ON true
       WHERE u.owner_id=$1 AND ($2::timestamptz IS NULL OR (u.created_at,u.id)<($2,$3::uuid))
         AND ($4::uuid IS NULL OR u.session_id=$4)
         AND ($5::timestamptz IS NULL OR u.created_at>=$5) AND ($6::timestamptz IS NULL OR u.created_at<$6)
         AND ($8::timestamptz IS NULL OR (u.created_at,u.id)>($8,$9::uuid))
         AND (c.used>0 OR EXISTS(SELECT 1 FROM app_actions a WHERE a.turn_id=u.id AND a.owner_id=$1))
       ORDER BY u.created_at ${after === undefined ? 'DESC' : 'ASC'},u.id ${after === undefined ? 'DESC' : 'ASC'} LIMIT $7`,
      [
        ownerId,
        before?.at ?? null,
        before?.id ?? null,
        session ?? null,
        start ?? null,
        end ?? null,
        limit,
        after?.at ?? null,
        after?.id ?? null,
      ],
    );
    const cursors = rows.map((row) => ({ at: String(row.cursor), id: String(row.id) }));
    const entries = rows.map((row): TrustEntry => ({
      id: row.id,
      messageId: row.message_id ?? null,
      at: row.created_at.toISOString(),
      ...describe(row),
      channel: String(row.channel).split(':')[0]!,
      error: row.status === 'failed' ? row.error : null,
      costUsd: row.cost > 0 ? row.cost : null,
      ...(row.cost > 0
        ? {}
        : row.plan
          ? { pricing: 'plan' }
          : row.unpriced
            ? { pricing: 'unpriced' }
            : {}),
      models: (row.models ?? []).sort(
        (a: TrustEntry['models'][number], b: TrustEntry['models'][number]) =>
          `${a.provider ?? ''}:${a.model ?? ''}:${a.billing}`.localeCompare(
            `${b.provider ?? ''}:${b.model ?? ''}:${b.billing}`,
          ),
      ),
      actions: (row.actions ?? []).map(
        (item: {
          action: string;
          target: string | null;
          basis: TrustBasis | null;
          said: boolean;
          whole: boolean | null;
        }): TrustAction => {
          const because = reasonOf(item.basis, item.said, item.whole);
          return {
            ...recordedAction(item.action, item.target),
            ...(because ? { because } : {}),
            ...(item.basis?.kind === 'read' ? { read: true as const } : {}),
          };
        },
      ),
    }));
    return { entries, cursors };
  }

  async function entries(before?: { at: string; id: string }, session?: string) {
    const { entries: rows, cursors } = await select({ before, session, limit: pageSize + 1 });
    const page = rows.slice(0, pageSize);
    return {
      entries: page,
      next: rows.length > pageSize ? (cursors[pageSize - 1] ?? null) : null,
    };
  }

  const stepUnion = `         SELECT e.turn_id,e.created_at AS at,'event' AS kind,e.type,e.summary,e.site AS detail,NULL::jsonb AS basis,
           false AS said,false AS whole,NULL::jsonb AS usage,NULL::float8 AS cost,e.parent_run_id IS NOT NULL AS helper,e.id::text AS id,NULL::jsonb AS command
         FROM turn_events e JOIN turns u ON u.id=e.turn_id AND u.owner_id=$1
         WHERE e.turn_id=ANY($2::uuid[]) AND e.type IN ('step','thought','tool_complete','tool_failed')
           AND e.command IS NULL
           AND NOT (e.type<>'step' AND e.type<>'thought' AND e.summary IN ('apps','files'))
         UNION ALL
         SELECT a.turn_id,a.created_at,'action',NULL,a.action,a.target,a.basis,m.id IS NOT NULL,
           COALESCE(regexp_replace(lower(m.text),'[^[:alnum:]]+','','g')=regexp_replace(lower(a.basis->>'quote'),'[^[:alnum:]]+','','g'),false),
           NULL,NULL,a.parent_run_id IS NOT NULL,a.id::text,NULL
         FROM app_actions a LEFT JOIN messages m ON a.basis->>'kind'='message'
           AND m.owner_id=$1 AND m.id=(a.basis->>'messageId')::uuid
         WHERE a.owner_id=$1 AND a.turn_id=ANY($2::uuid[])
         UNION ALL
         SELECT turn_id,created_at,'model',NULL,NULL,NULL,NULL,false,false,details,cost_usd,parent_run_id IS NOT NULL,id,NULL
         FROM model_usage WHERE owner_id=$1 AND turn_id=ANY($2::uuid[])
         UNION ALL
         SELECT turn_id,created_at,'reply',NULL,left(text,300),NULL,NULL,false,false,NULL,NULL,false,id::text,NULL
         FROM messages WHERE owner_id=$1 AND turn_id=ANY($2::uuid[]) AND role='assistant' AND hidden_at IS NULL AND text<>''
         UNION ALL
         SELECT turn_id,"startedAt",'command',NULL,NULL,NULL,NULL,false,false,NULL,NULL,helper,id::text,
           jsonb_build_object('id',id,'command',command,'state',state,'exitCode',result->'exitCode') ||
             CASE WHEN $3::boolean THEN jsonb_build_object('output',COALESCE(result->>'output','')) ELSE '{}'::jsonb END
         FROM (${workspaceCommandsSql}) commands WHERE owner_id=$1 AND turn_id=ANY($2::uuid[])`;

  async function steps(turnIds: string[], page?: { offset: number; limit: number; output?: true }) {
    const { rows } = await pool.query(
      `SELECT * FROM (${stepUnion}) s ORDER BY array_position($2::uuid[],s.turn_id),s.at,s.id OFFSET $4 LIMIT $5`,
      [ownerId, turnIds, page?.output === true, page?.offset ?? 0, page ? page.limit : null],
    );
    const grouped = new Map<string, TrustStep[]>();
    for (const row of rows) {
      const list = grouped.get(row.turn_id);
      if (list) list.push(presentStep(row));
      else grouped.set(row.turn_id, [presentStep(row)]);
    }
    return grouped;
  }

  async function stepCount(turnId: string) {
    const { rows } = await pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM (${stepUnion}) s`,
      [ownerId, [turnId], false],
    );
    return rows[0]?.total ?? 0;
  }

  async function bounds(range: ActivityRange) {
    const row = (
      await pool.query<{
        zone: string;
        locale: string | null;
        start_at: Date | null;
        end_at: Date | null;
      }>(
        `SELECT ${zone} AS zone,(SELECT locale FROM preferences WHERE owner_id=$1),
           ($2::date::timestamp AT TIME ZONE ${zone}) AS start_at,
           (($3::date+1)::timestamp AT TIME ZONE ${zone}) AS end_at`,
        [ownerId, range.from ?? null, range.to ?? range.from ?? null],
      )
    ).rows[0]!;
    return {
      session: range.session,
      timeZone: row.zone,
      locale: formattingLocale(localeRegion(row.locale) ?? timeZoneRegion(row.zone)),
      start: row.start_at,
      end: row.end_at,
    };
  }

  async function within(range: ActivityRange, limit: number) {
    const span = await bounds(range);
    const { entries } = await select({
      session: span.session,
      start: span.start,
      end: span.end,
      limit: limit + 1,
    });
    return { ...span, entries: entries.slice(0, limit), complete: entries.length <= limit };
  }

  async function chunk(
    span: Awaited<ReturnType<typeof bounds>>,
    after: { at: string; id: string } | null,
    size: number,
  ) {
    const { entries, cursors } = await select({
      session: span.session,
      start: span.start,
      end: span.end,
      after,
      limit: size,
    });
    return { entries, next: cursors.at(-1) ?? null };
  }

  async function read(): Promise<TrustView> {
    const [summary, daily, background, page, current] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM turn_events e JOIN turns u ON u.id=e.turn_id
             WHERE u.owner_id=$1 AND e.type='tool_complete' AND e.created_at>now()-interval '7 days')::int AS things,
           (SELECT count(*) FROM app_actions WHERE owner_id=$1
             AND created_at>now()-interval '7 days')::int AS actions,
           (SELECT COALESCE(sum(cost_usd),0) FROM model_usage WHERE owner_id=$1
             AND created_at>now()-interval '7 days')::float8 AS week,
           (SELECT COALESCE(sum((details->>'estimateUsd')::float8),0) FROM model_usage WHERE owner_id=$1
             AND ${planUsage} AND created_at>now()-interval '7 days')::float8 AS week_plan,
           (SELECT COALESCE(sum((details->>'estimateUsd')::float8),0) FROM model_usage WHERE owner_id=$1
             AND ${planUsage} AND created_at>=${monthStart})::float8 AS month_plan,
           EXISTS(SELECT 1 FROM model_usage WHERE owner_id=$1 AND ${unpricedUsage}
             AND created_at>=${monthStart}) AS unpriced,
           EXISTS(SELECT 1 FROM model_usage WHERE owner_id=$1 AND cost_usd IS NULL AND details ? 'estimateUsd'
             AND created_at>=${monthStart}) AS plan_usage,
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
      pool.query<{
        outside: boolean;
        category: string | null;
        operation: string | null;
        cost: number;
      }>(
        `WITH spent AS (
           SELECT m.cost_usd,m.turn_id,m.details,u.session_id,u.thread_id,u.source FROM model_usage m
           LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
           WHERE m.owner_id=$1 AND m.created_at>=${monthStart} AND m.cost_usd>0),
         origin AS (
           SELECT DISTINCT ON (f.session_id) f.session_id,f.source FROM turns f
           WHERE f.owner_id=$1 AND f.session_id IN (SELECT session_id FROM spent) ORDER BY f.session_id,f.created_at,f.id)
         SELECT s.turn_id IS NULL AS outside,CASE WHEN s.turn_id IS NULL THEN s.details->>'category' END AS category,
           CASE WHEN s.turn_id IS NULL THEN s.details->>'operation' END AS operation,sum(s.cost_usd)::float8 AS cost
         FROM spent s LEFT JOIN origin o ON o.session_id=s.session_id
         WHERE s.turn_id IS NULL OR (s.session_id<>s.thread_id AND s.source<>'user' AND o.source NOT IN ('user','task'))
         GROUP BY 1,2,3`,
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
    const outside = new Map<TrustOutside['kind'], number>();
    for (const { outside: turnless, category, operation, cost } of background.rows)
      if (turnless) {
        const kind: TrustOutside['kind'] =
          category === 'review' && operation === 'access'
            ? 'email'
            : category === 'memory'
              ? operation === 'style'
                ? 'style'
                : 'memory'
              : category === 'tasks'
                ? 'ideas'
                : 'other';
        outside.set(kind, (outside.get(kind) ?? 0) + cost);
      }
    return {
      week: {
        things: row.things,
        actions: row.actions,
        spentUsd: row.week,
        planUsd: row.week_plan,
      },
      month: {
        start: row.start.toISOString(),
        days: row.days,
        elapsedDays: elapsed,
        spentUsd: spent,
        forecastUsd: (spent / Math.max(elapsed, 1)) * row.days,
        planUsd: row.month_plan,
        daily: days,
        unpriced: row.unpriced,
        planUsage: row.plan_usage,
        backgroundUsd: background.rows.reduce((sum, item) => sum + item.cost, 0),
        outside: [...outside].map(([kind, costUsd]) => ({ kind, costUsd })),
      },
      ...current,
      preparation: await preparationLimit(),
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
    app.get<{ Params: { id: string } }>('/api/trust/entries/:id/steps', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const { offset } = z
        .object({ offset: z.coerce.number().int().min(0).default(0) })
        .strict()
        .parse(request.query);
      const [found, total] = await Promise.all([
        steps([id], { offset, limit: stepPage }),
        stepCount(id),
      ]);
      return { steps: found.get(id) ?? [], total };
    });
    app.get<{ Params: { id: string } }>('/api/trust/commands/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const { rows } = await pool.query(
        `SELECT * FROM (${workspaceCommandsSql}) commands WHERE id=$1 AND owner_id=$2`,
        [id, ownerId],
      );
      if (!rows[0])
        throw Object.assign(new Error('Workspace command not found.'), { statusCode: 404 });
      return { command: workspaceCommand(rows[0]) };
    });
    app.put('/api/trust/limit', (request) => setLimits(request.body));
  }

  async function setLimits(input: unknown, actor: SettingActor = 'owner', shared?: PoolClient) {
    const body = limitsInput.parse(input);
    const capture = snapshotAnalytics(analytics);
    const write = async (client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `preparation-budget:${ownerId}`,
      ]);
      await client.query(
        'INSERT INTO spending_limits(owner_id,monthly_usd) VALUES($1,NULL) ON CONFLICT DO NOTHING',
        [ownerId],
      );
      const before = (
        await client.query(
          'SELECT monthly_usd,task_usd,preparation_usd FROM spending_limits WHERE owner_id=$1 FOR UPDATE',
          [ownerId],
        )
      ).rows[0];
      for (const [key, column] of [
        ['monthlyUsd', 'monthly_usd'],
        ['taskUsd', 'task_usd'],
        ['preparationUsd', 'preparation_usd'],
      ] as const)
        if (body[key] !== undefined)
          await client.query(`UPDATE spending_limits SET ${column}=$2 WHERE owner_id=$1`, [
            ownerId,
            body[key],
          ]);
      const after = (
        await client.query(
          'SELECT monthly_usd,task_usd,preparation_usd FROM spending_limits WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0];
      await client.query(
        `DELETE FROM spending_limits WHERE owner_id=$1 AND monthly_usd IS NULL AND task_usd=${defaultTaskUsd} AND preparation_usd=${defaultPreparationUsd}`,
        [ownerId],
      );
      afterCommit(client, () =>
        captureSettingChanges(capture, actor, before, after, {
          monthly_usd: 'monthly_spending_limit',
          task_usd: 'task_spending_limit',
          preparation_usd: 'preparation_spending_limit',
        }),
      );
    };
    if (shared) {
      await write(shared);
      return limits(shared);
    }
    await transaction(write, pool);
    return limits();
  }

  return {
    initialize,
    reserve,
    withPreparation,
    preparationLimit,
    flush: flushUsage,
    agent,
    curator,
    decisions,
    speech,
    attributeMediaUsage,
    action,
    limitReached,
    reachedLimit,
    checkIn,
    limits,
    setLimits,
    onboard,
    sessionCosts,
    recentTurnCost,
    withTurn: <T>(turnId: string, run: () => T, overLimit = false, automatic = true) =>
      activeTurn.run({ id: turnId, automatic }, () =>
        overLimit ? pastLimit.run(true, run) : run(),
      ),
    withExecution: <T>(
      execution: ExecutionScope & Pick<AgentSessionOptions, 'onEvent'>,
      run: () => T,
    ) => activeExecution.run(execution, run),
    read,
    within,
    bounds,
    chunk,
    steps,
    report,
    registerRoutes,
  };
}
