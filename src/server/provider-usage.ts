import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProviderUsageEvent } from '../ports/provider-usage.ts';
import type { ProviderUsageResponse } from '../shared/provider-usage.ts';

const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/);
const toolName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/);
const metric = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const schema = z
  .object({
    id: z.uuid().optional(),
    provider: label,
    category: z.enum([
      'agent',
      'relevance',
      'memory',
      'browser',
      'integration',
      'speech',
      'channel',
      'workspace',
    ]),
    operation: label,
    model: label.optional(),
    turnId: z.uuid().optional(),
    toolCallId: z.uuid().optional(),
    toolName: toolName.optional(),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    durationMs: metric.default(0),
    inputTokens: metric,
    outputTokens: metric,
    cacheReadTokens: metric,
    cacheWriteTokens: metric,
    audioSeconds: metric,
    characters: metric,
    messages: metric,
    bytes: metric,
    costUsd: metric.nullable(),
    pricing: z.enum(['reported', 'sdk_estimate', 'unavailable']).optional(),
  })
  .strict()
  .refine((event) => Boolean(event.toolCallId) === Boolean(event.toolName));

export function createProviderUsageStore(
  pool: Pool,
  options: {
    ownerId: string;
    enabled(): boolean;
    coverage: ProviderUsageResponse['coverage'];
  },
) {
  const context = new AsyncLocalStorage<{
    turnId: string;
    toolCallId?: string;
    toolName?: string;
  }>();
  const pending = new Set<Promise<unknown>>();
  let droppedEvents = 0;
  let lastPruned = -Infinity;
  let pruning: Promise<void> | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  function prune(force = false, database: Pool = pool): Promise<void> {
    if (pruning) return pruning;
    if (!force && Date.now() - lastPruned < 3_600_000) return Promise.resolve();
    pruning = database
      .query(
        "DELETE FROM provider_usage WHERE owner_id=$1 AND recorded_at < now()-interval '7 days'",
        [options.ownerId],
      )
      .then(() => {
        lastPruned = Date.now();
      })
      .finally(() => {
        pruning = undefined;
      });
    return pruning;
  }
  async function initialize(migrationPool: Pool = pool) {
    await migrationPool.query(`CREATE TABLE IF NOT EXISTS provider_usage (
      id uuid PRIMARY KEY, owner_id text NOT NULL, turn_id uuid REFERENCES turns(id) ON DELETE SET NULL,
      provider text NOT NULL, category text NOT NULL, operation text NOT NULL, model text,
      status text NOT NULL, duration_ms double precision NOT NULL, metrics jsonb NOT NULL,
      cost_usd double precision, pricing text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
      tool_call_id uuid, tool_name text
    );
    CREATE INDEX IF NOT EXISTS provider_usage_owner_time_idx ON provider_usage(owner_id,recorded_at);
    CREATE INDEX IF NOT EXISTS provider_usage_tool_idx ON provider_usage(owner_id,tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS provider_usage_turn_idx ON provider_usage(owner_id,turn_id,recorded_at);`);
    await prune(true, migrationPool);
    if (!stopped && !retentionTimer) {
      retentionTimer = setInterval(() => {
        void prune(true).catch(() => {});
      }, 3_600_000);
      retentionTimer.unref();
    }
  }
  function record(input: ProviderUsageEvent) {
    if (stopped || !options.enabled()) return;
    const current = context.getStore();
    const inherited = !input.turnId || input.turnId === current?.turnId ? current : undefined;
    const parsed = schema.safeParse({
      ...input,
      turnId: input.turnId ?? current?.turnId,
      toolCallId:
        input.category === 'agent' ? undefined : (input.toolCallId ?? inherited?.toolCallId),
      toolName: input.category === 'agent' ? undefined : (input.toolName ?? inherited?.toolName),
    });
    if (!parsed.success || pending.size >= 128) {
      droppedEvents++;
      return;
    }
    const event = parsed.data;
    const ownedTool =
      event.toolCallId && event.turnId
        ? "EXISTS(SELECT 1 FROM inspector_records r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id WHERE r.id=$13::uuid AND r.owner_id=$2 AND r.turn_id=$3 AND r.kind='tool' AND r.name=$14)"
        : 'false';
    const priced = event.costUsd != null && event.pricing && event.pricing !== 'unavailable';
    const metrics = Object.fromEntries(
      [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'audioSeconds',
        'characters',
        'messages',
        'bytes',
      ].flatMap((key) => {
        const value = event[key as keyof typeof event];
        return typeof value === 'number' ? [[key, value]] : [];
      }),
    );
    const write = (async () => {
      await prune();
      if (!options.enabled()) return;
      await pool.query(
        `INSERT INTO provider_usage(id,owner_id,turn_id,provider,category,operation,model,status,duration_ms,metrics,cost_usd,pricing,tool_call_id,tool_name)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN ${ownedTool} THEN $13::uuid END,CASE WHEN ${ownedTool} THEN $14::text END
        WHERE $3::uuid IS NULL OR EXISTS(SELECT 1 FROM turns WHERE id=$3 AND owner_id=$2)
        ON CONFLICT(id) DO NOTHING`,
        [
          event.id ?? randomUUID(),
          options.ownerId,
          event.turnId ?? null,
          event.provider,
          event.category,
          event.operation,
          event.model ?? null,
          event.status,
          event.durationMs,
          JSON.stringify(metrics),
          priced ? event.costUsd : null,
          priced ? event.pricing : 'unavailable',
          event.toolCallId ?? null,
          event.toolName ?? null,
        ],
      );
    })()
      .catch(() => {
        droppedEvents++;
      })
      .finally(() => pending.delete(write));
    pending.add(write);
  }
  async function track<T>(
    description: Omit<ProviderUsageEvent, 'status' | 'durationMs'>,
    action: () => Promise<T>,
    measure?: (value: T) => Partial<ProviderUsageEvent>,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await action();
      let measured: Partial<ProviderUsageEvent> = {};
      try {
        measured = measure?.(result) ?? {};
      } catch {}
      record({
        ...description,
        status: 'succeeded',
        ...measured,
        durationMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      record({
        ...description,
        status: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
        durationMs: performance.now() - started,
      });
      throw error;
    }
  }
  async function read(turnId?: string): Promise<ProviderUsageResponse> {
    if (turnId) {
      z.uuid().parse(turnId);
      if (
        !(
          await pool.query('SELECT id FROM turns WHERE id=$1 AND owner_id=$2', [
            turnId,
            options.ownerId,
          ])
        ).rowCount
      )
        throw Object.assign(new Error('Turn not found.'), { statusCode: 404 });
    }
    const result = await pool.query(
      `SELECT provider,category,operation,model,count(*)::int AS requests,
      count(*) FILTER(WHERE status='failed')::int AS failures,count(*) FILTER(WHERE status='cancelled')::int AS cancelled,
      sum(duration_ms)::float8 AS "durationMs",
      ${['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'audioSeconds', 'characters', 'messages', 'bytes'].map((key) => `sum((metrics->>'${key}')::numeric)::float8 AS "${key}"`).join(',')},
      sum(cost_usd)::float8 AS "costUsd",count(cost_usd)::int AS "pricedRequests",
      CASE WHEN count(cost_usd)=0 THEN 'unavailable' WHEN count(DISTINCT pricing) FILTER(WHERE cost_usd IS NOT NULL)>1 THEN 'mixed' ELSE min(pricing) FILTER(WHERE cost_usd IS NOT NULL) END AS pricing,
      max(recorded_at) AS "lastRecordedAt"
      FROM provider_usage WHERE owner_id=$1 AND ($2::uuid IS NULL OR turn_id=$2) AND recorded_at>=now()-interval '7 days'
      GROUP BY provider,category,operation,model ORDER BY count(*) DESC,provider,operation`,
      [options.ownerId, turnId ?? null],
    );
    return {
      scope: turnId ? 'turn' : 'owner',
      ...(turnId ? { turnId } : {}),
      retentionDays: 7,
      captureEnabled: options.enabled(),
      droppedEvents,
      providers: result.rows.map((row) => ({
        ...row,
        lastRecordedAt: new Date(row.lastRecordedAt).toISOString(),
      })),
      coverage: options.coverage,
    };
  }
  function registerRoutes(app: FastifyInstance) {
    app.get('/api/inspector/providers', async (request, reply) => {
      if (!options.enabled()) return reply.code(404).send({ error: 'Inspector is disabled.' });
      const query = z.object({ turnId: z.uuid().optional() }).parse(request.query);
      return read(query.turnId);
    });
  }
  return {
    initialize,
    record,
    track,
    read,
    registerRoutes,
    withTurn: <T>(turnId: string, action: () => T) =>
      context.run({ turnId: z.uuid().parse(turnId) }, action),
    withTool: <T>(turnId: string, toolCallId: string, name: string, action: () => T) =>
      context.run(
        {
          turnId: z.uuid().parse(turnId),
          toolCallId: z.uuid().parse(toolCallId),
          toolName: toolName.parse(name),
        },
        action,
      ),
    flush: () => Promise.all([...pending]),
    close: async () => {
      stopped = true;
      if (retentionTimer) clearInterval(retentionTimer);
      await Promise.all([...pending]);
      await pruning;
    },
  };
}

export type ProviderUsageStore = ReturnType<typeof createProviderUsageStore>;
