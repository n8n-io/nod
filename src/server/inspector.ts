import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { RuntimeObservation } from '../ports/agent.ts';
import type { InspectorObservationsResponse, ModelUsage, ToolCall } from '../shared/inspector.ts';
import { createInspectorRedactor, inspectorPayloadLimit } from './inspector-redaction.ts';
import { createRetention } from './retention.ts';

export const inspectorRetentionDays = 7;
export { inspectorPayloadLimit };
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  totalTokens: count,
  costUsd: z.number().nonnegative().finite().nullable(),
  costSource: z.enum(['sdk_estimate', 'unavailable']),
});
const iso = (value: string | Date) => new Date(value).toISOString();
const time = z.iso.datetime({ offset: true });
const directUsageFields = `count(*)::int AS "providerOperations",count(u.cost_usd)::int AS "pricedOperations",
  sum(u.cost_usd)::float8 AS "directCostUsd",
  CASE WHEN count(u.cost_usd)=0 THEN 'unavailable' WHEN count(DISTINCT u.pricing) FILTER(WHERE u.cost_usd IS NOT NULL)>1 THEN 'mixed' ELSE min(u.pricing) FILTER(WHERE u.cost_usd IS NOT NULL) END AS pricing`;
const noDirectUsage = {
  providerOperations: 0,
  pricedOperations: 0,
  directCostUsd: null,
  pricing: 'unavailable' as const,
};

export function createInspectorStore(
  pool: Pool,
  options: { ownerId: string; enabled(): boolean; secrets?: string[] },
) {
  const redact = createInspectorRedactor(options.secrets);
  const pendingFailures = new Set<Promise<void>>();
  let acceptingFailures = true;
  const { prune } = createRetention(pool, options.ownerId, 'inspector_records', 'recorded_at');
  async function record(turnId: string, event: RuntimeObservation) {
    if (!options.enabled()) return;
    z.uuid().parse(turnId);
    z.uuid().parse(event.id);
    await prune();
    if (event.type === 'tool_start') {
      const name = z.string().min(1).max(100).parse(event.name);
      await pool.query(
        `INSERT INTO inspector_records(id,owner_id,thread_id,turn_id,kind,name,status,input,started_at)
        SELECT $1,$2,thread_id,id,'tool',$4,'running',$5,$6 FROM turns
        WHERE id=$3 AND owner_id=$2 AND status='running'
        ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          options.ownerId,
          turnId,
          name,
          JSON.stringify(redact(event.input)),
          iso(time.parse(event.startedAt)),
        ],
      );
    } else if (event.type === 'tool_end') {
      const result = z.enum(['succeeded', 'failed', 'cancelled']).parse(event.status);
      const duration = z.number().nonnegative().finite().parse(event.durationMs);
      await pool.query(
        `UPDATE inspector_records r SET
          status=CASE WHEN u.status NOT IN ('cancelled','failed') THEN $4 ELSE 'interrupted' END,
          output=CASE WHEN u.status NOT IN ('cancelled','failed') THEN $5::jsonb ELSE NULL END,
          error=CASE WHEN u.status NOT IN ('cancelled','failed') THEN $6 ELSE 'The turn ended before its result was recorded.' END,
          duration_ms=$7,finished_at=$8
        FROM turns u WHERE r.id=$1 AND r.owner_id=$2 AND r.turn_id=$3
          AND r.kind='tool' AND r.status='running' AND u.id=r.turn_id AND u.owner_id=$2`,
        [
          event.id,
          options.ownerId,
          turnId,
          result,
          event.output === undefined ? null : JSON.stringify(redact(event.output)),
          event.error ? String(redact(event.error)).slice(0, 1000) : null,
          duration,
          iso(time.parse(event.finishedAt)),
        ],
      );
    } else {
      const usage = usageSchema.parse(event);
      if (usage.costSource === 'unavailable') usage.costUsd = null;
      if (usage.costUsd === null) usage.costSource = 'unavailable';
      usage.provider = String(redact(usage.provider));
      usage.model = String(redact(usage.model));
      await pool.query(
        `INSERT INTO inspector_records(id,owner_id,thread_id,turn_id,kind,name,status,usage,started_at,finished_at)
        SELECT $1,$2,thread_id,id,'model','model_request','succeeded',$4,$5,$5 FROM turns
        WHERE id=$3 AND owner_id=$2 ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          options.ownerId,
          turnId,
          JSON.stringify(usage),
          iso(time.parse(event.createdAt)),
        ],
      );
    }
  }
  function recordFailure(turnId: string, error: unknown): Promise<void> {
    if (!acceptingFailures || !options.enabled() || pendingFailures.size >= 8)
      return Promise.resolve();
    const write = Promise.resolve()
      .then(async () => {
        z.uuid().parse(turnId);
        const seen = new Set<Error>();
        function detail(value: unknown, depth = 0): unknown {
          if (!(value instanceof Error))
            return {
              name: 'ThrownValue',
              message: 'A non-Error value was thrown; details omitted.',
            };
          if (seen.has(value) || depth > 2) return { name: 'Cause omitted' };
          seen.add(value);
          return {
            name: value.name,
            message: value.message,
            ...('code' in value &&
            (typeof value.code === 'string' || typeof value.code === 'number')
              ? { code: value.code }
              : {}),
            stack: value.stack
              ?.split(/\r?\n/)
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 12)
              .join('\n'),
            ...(value.cause instanceof Error ? { cause: detail(value.cause, depth + 1) } : {}),
          };
        }
        const diagnostic = redact(detail(error));
        const hash = createHash('sha256')
          .update(`failure:${options.ownerId}:${turnId}`)
          .digest('hex');
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        await prune();
        if (!options.enabled()) return;
        await pool.query(
          `INSERT INTO inspector_records(id,owner_id,thread_id,turn_id,kind,name,status,output,started_at,finished_at)
           SELECT $1,$2,u.thread_id,u.id,'failure','turn_failure','failed',$4,COALESCE(u.finished_at,now()),COALESCE(u.finished_at,now())
           FROM turns u JOIN threads th ON th.id=u.thread_id
           WHERE u.id=$3 AND u.owner_id=$2 AND u.status='failed' AND th.archived_at IS NULL
           ON CONFLICT(id) DO NOTHING`,
          [id, options.ownerId, turnId, JSON.stringify(diagnostic)],
        );
      })
      .catch(() => {});
    pendingFailures.add(write);
    void write.finally(() => pendingFailures.delete(write));
    return write;
  }
  async function close() {
    acceptingFailures = false;
    await Promise.allSettled(pendingFailures);
  }
  async function recover() {
    await prune();
    await pool.query(
      `UPDATE inspector_records SET status='interrupted',finished_at=now(),
      error='The server stopped before this call completed.' WHERE owner_id=$1 AND kind='tool' AND status='running'`,
      [options.ownerId],
    );
  }
  async function finishSegment(turnId: string) {
    if (!options.enabled()) return;
    await pool.query(
      `UPDATE inspector_records SET status='interrupted',finished_at=now(),
      error='The turn ended without a recorded result.'
      WHERE owner_id=$1 AND turn_id=$2 AND kind='tool' AND status='running'`,
      [options.ownerId, turnId],
    );
  }
  async function read(
    turnId?: string,
    cursor: { before?: string; beforeId?: string; tool?: string } = {},
  ): Promise<InspectorObservationsResponse | null> {
    if (turnId) z.uuid().parse(turnId);
    await prune();
    if (turnId) {
      const owner = await pool.query('SELECT id FROM turns WHERE id=$1 AND owner_id=$2', [
        turnId,
        options.ownerId,
      ]);
      if (!owner.rowCount) return null;
    }
    const [records, totals, toolUsage, toolCosts] = await Promise.all([
      pool.query(
        `SELECT r.*,
          CASE WHEN r.status='running' AND u.status<>'running' THEN 'interrupted' ELSE r.status END AS current_status
        FROM inspector_records r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
        WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.turn_id=$2) AND r.recorded_at >= now() - interval '7 days'
          AND ($3::timestamptz IS NULL OR r.started_at < $3 OR (r.started_at=$3 AND r.id<$4::uuid))
          AND ($5::text IS NULL OR (r.kind='tool' AND r.name=$5))
        ORDER BY r.started_at DESC,r.id DESC LIMIT 101`,
        [
          options.ownerId,
          turnId ?? null,
          cursor.before ?? null,
          cursor.beforeId ?? null,
          cursor.tool ?? null,
        ],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE kind='tool')::int AS calls,
          count(*) FILTER (WHERE kind='model')::int AS "modelRequests",
          count(*) FILTER (WHERE kind='failure')::int AS failures,
          coalesce(sum((usage->>'inputTokens')::bigint),0)::float8 AS "inputTokens",
          coalesce(sum((usage->>'outputTokens')::bigint),0)::float8 AS "outputTokens",
          coalesce(sum((usage->>'cacheReadTokens')::bigint),0)::float8 AS "cacheReadTokens",
          coalesce(sum((usage->>'cacheWriteTokens')::bigint),0)::float8 AS "cacheWriteTokens",
          coalesce(sum((usage->>'totalTokens')::bigint),0)::float8 AS "totalTokens",
          sum((usage->>'costUsd')::numeric)::float8 AS "knownCostUsd",
          count(*) FILTER (WHERE kind='model' AND (usage->>'costUsd') IS NULL)::int AS "unpricedRequests"
        FROM inspector_records WHERE owner_id=$1 AND ($2::uuid IS NULL OR turn_id=$2) AND recorded_at >= now() - interval '7 days'`,
        [options.ownerId, turnId ?? null],
      ),
      pool.query(
        `SELECT name,count(*)::int AS calls,
          count(*) FILTER (WHERE current_status='succeeded')::int AS succeeded,
          count(*) FILTER (WHERE current_status='failed')::int AS failed,
          count(*) FILTER (WHERE current_status='running')::int AS running,
          count(*) FILTER (WHERE current_status='cancelled')::int AS cancelled,
          count(*) FILTER (WHERE current_status='interrupted')::int AS interrupted,
          count(duration_ms)::int AS "durationSamples",
          sum(duration_ms)::float8 AS "totalDurationMs",
          avg(duration_ms)::float8 AS "averageDurationMs",
          max(duration_ms)::float8 AS "maxDurationMs",
          max(started_at) AS "lastStartedAt"
        FROM (
          SELECT r.name,r.duration_ms,r.started_at,
            CASE WHEN r.status='running' AND u.status<>'running' THEN 'interrupted' ELSE r.status END AS current_status
          FROM inspector_records r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
          WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.turn_id=$2) AND r.kind='tool'
            AND r.recorded_at >= now() - interval '7 days'
        ) retained GROUP BY name ORDER BY calls DESC,name`,
        [options.ownerId, turnId ?? null],
      ),
      pool.query(
        `SELECT r.name,${directUsageFields}
        FROM provider_usage u JOIN inspector_records r ON r.id=u.tool_call_id AND r.owner_id=u.owner_id AND r.turn_id=u.turn_id AND r.name=u.tool_name
        JOIN turns tn ON tn.id=r.turn_id AND tn.owner_id=r.owner_id
        WHERE u.owner_id=$1 AND ($2::uuid IS NULL OR u.turn_id=$2) AND r.kind='tool' AND u.category<>'agent'
          AND u.recorded_at >= now()-interval '7 days' AND r.recorded_at >= now()-interval '7 days'
        GROUP BY r.name`,
        [options.ownerId, turnId ?? null],
      ),
    ]);
    const page = records.rows.slice(0, 100);
    const pageIds = page.filter((row) => row.kind === 'tool').map((row) => row.id);
    const callCosts = pageIds.length
      ? await pool.query(
          `SELECT u.tool_call_id,${directUsageFields}
      FROM provider_usage u JOIN inspector_records r ON r.id=u.tool_call_id AND r.owner_id=u.owner_id AND r.turn_id=u.turn_id AND r.name=u.tool_name
      WHERE u.owner_id=$1 AND u.tool_call_id=ANY($2::uuid[]) AND r.kind='tool' AND u.category<>'agent'
        AND u.recorded_at >= now()-interval '7 days' AND r.recorded_at >= now()-interval '7 days'
      GROUP BY u.tool_call_id`,
          [options.ownerId, pageIds],
        )
      : { rows: [] };
    const costsByCall = new Map(
      callCosts.rows.map(({ tool_call_id, ...cost }) => [tool_call_id, cost]),
    );
    const costsByTool = new Map(toolCosts.rows.map(({ name, ...cost }) => [name, cost]));
    const calls: ToolCall[] = page
      .filter((row) => row.kind === 'tool')
      .map((row) => ({
        id: row.id,
        turnId: row.turn_id,
        name: row.name,
        input: redact(row.input),
        output: row.output === null ? null : redact(row.output),
        status: row.current_status,
        startedAt: iso(row.started_at),
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
        durationMs: row.duration_ms,
        error: row.error ? String(redact(row.error)) : null,
        ...(costsByCall.get(row.id) ?? noDirectUsage),
      }));
    const usage: ModelUsage[] = page
      .filter((row) => row.kind === 'model')
      .map((row) => ({
        ...row.usage,
        id: row.id,
        turnId: row.turn_id,
        createdAt: iso(row.started_at),
      }));
    const hasOlder = records.rows.length > 100;
    const last = page.at(-1);
    return {
      scope: turnId ? 'turn' : 'owner',
      ...(turnId ? { turnId } : {}),
      calls,
      usage,
      failures: page
        .filter((row) => row.kind === 'failure')
        .map((row) => ({
          id: row.id,
          turnId: row.turn_id,
          occurredAt: iso(row.started_at),
          diagnostic: redact(row.output),
        })),
      summary: {
        ...totals.rows[0],
        providerOperations: toolCosts.rows.reduce((sum, row) => sum + row.providerOperations, 0),
        pricedProviderOperations: toolCosts.rows.reduce(
          (sum, row) => sum + row.pricedOperations,
          0,
        ),
        directProviderCostUsd: toolCosts.rows.some((row) => row.directCostUsd !== null)
          ? toolCosts.rows.reduce((sum, row) => sum + (row.directCostUsd ?? 0), 0)
          : null,
      },
      toolUsage: toolUsage.rows.map((row) => ({
        ...row,
        lastStartedAt: iso(row.lastStartedAt),
        ...(costsByTool.get(row.name) ?? noDirectUsage),
      })),
      hasOlder,
      ...(hasOlder && last ? { nextBefore: iso(last.started_at), nextBeforeId: last.id } : {}),
    };
  }
  return { record, recordFailure, read, recover, finishSegment, close };
}

export type InspectorStore = ReturnType<typeof createInspectorStore>;
