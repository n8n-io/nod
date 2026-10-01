import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PromptSnapshot } from '../ports/agent.ts';
import type { InspectorPrompt, InspectorPromptsResponse } from '../shared/inspector-prompts.ts';
import { createInspectorRedactor } from './inspector-redaction.ts';

const redactionVersion = 1;
const snapshotSchema = z.object({
  id: z.uuid(),
  system: z.string().max(256_000),
  instruction: z.string().max(256_000),
  resumed: z.boolean(),
  imageCount: z.number().int().min(0).max(10),
  reason: z.enum(['user', 'secure_resume', 'steer']),
  createdAt: z.iso.datetime({ offset: true }),
});
const querySchema = z
  .object({
    turnId: z.uuid().optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.uuid().optional(),
  })
  .refine((value) => Boolean(value.before) === Boolean(value.beforeId));

export function createPromptInspector(
  pool: Pool,
  options: {
    ownerId: string;
    enabled(): boolean;
    secrets?: string[];
    provider: string;
    model: string;
  },
) {
  const redact = createInspectorRedactor(options.secrets, { string: 48_000, payload: 160_000 });
  const pending = new Set<Promise<void>>();
  let accepting = true;
  let dropped = 0;
  let lastPruned = -Infinity;
  let pruning: Promise<void> | undefined;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  function safeText(value: string) {
    const result = redact(value);
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  async function initialize(migrationPool: Pool = pool) {
    await migrationPool.query(`CREATE TABLE IF NOT EXISTS inspector_prompts (
      id uuid PRIMARY KEY, owner_id text NOT NULL,
      thread_id uuid REFERENCES threads(id) ON DELETE CASCADE, turn_id uuid REFERENCES turns(id) ON DELETE CASCADE,
      payload jsonb NOT NULL, provider text NOT NULL, model text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS inspector_prompts_owner ON inspector_prompts(owner_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS inspector_prompts_turn ON inspector_prompts(owner_id, turn_id, created_at DESC, id DESC);`);
    await prune(true, migrationPool);
    if (accepting && !retentionTimer) {
      retentionTimer = setInterval(() => {
        void prune(true).catch(() => {});
      }, 60 * 60_000);
      retentionTimer.unref();
    }
  }
  async function prune(force = false, database: Pool = pool) {
    if (pruning) return pruning;
    if (!force && Date.now() - lastPruned < 60 * 60_000) return;
    pruning = database
      .query(
        "DELETE FROM inspector_prompts WHERE owner_id=$1 AND created_at < now()-interval '7 days'",
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
  function record(turnId: string, snapshot: PromptSnapshot): Promise<void> {
    if (!accepting || !options.enabled()) return Promise.resolve();
    if (pending.size >= 8) {
      dropped++;
      return Promise.resolve();
    }
    const write = Promise.resolve()
      .then(async () => {
        z.uuid().parse(turnId);
        const parsed = snapshotSchema.parse(snapshot);
        const safe = {
          ...parsed,
          redactionVersion,
          system: safeText(parsed.system),
          instruction: safeText(parsed.instruction),
        };
        await prune();
        if (!options.enabled()) return;
        await pool.query(
          `INSERT INTO inspector_prompts(id,owner_id,thread_id,turn_id,payload,provider,model,created_at)
        SELECT $1,$2,thread_id,id,$4,$5,$6,$7 FROM turns WHERE id=$3 AND owner_id=$2 AND status='running'
        ON CONFLICT(id) DO NOTHING`,
          [
            parsed.id,
            options.ownerId,
            turnId,
            JSON.stringify(safe),
            safeText(options.provider).slice(0, 100),
            safeText(options.model).slice(0, 200),
            parsed.createdAt,
          ],
        );
      })
      .catch(() => {
        dropped++;
      });
    pending.add(write);
    void write.finally(() => pending.delete(write));
    return write;
  }
  async function read(
    input: z.infer<typeof querySchema>,
  ): Promise<InspectorPromptsResponse | null> {
    const query = querySchema.parse(input);
    if (
      query.turnId &&
      !(
        await pool.query('SELECT id FROM turns WHERE id=$1 AND owner_id=$2', [
          query.turnId,
          options.ownerId,
        ])
      ).rowCount
    )
      return null;
    await prune();
    const result = await pool.query(
      `SELECT p.id,p.turn_id AS "turnId",left(COALESCE(m.text,u.prompt),100) AS title,p.payload,p.provider,p.model,p.created_at AS "createdAt"
      FROM inspector_prompts p JOIN turns u ON u.id=p.turn_id AND u.owner_id=p.owner_id
      LEFT JOIN messages m ON m.id=u.message_id AND m.owner_id=u.owner_id
      WHERE p.owner_id=$1 AND ($2::uuid IS NULL OR p.turn_id=$2)
      AND p.created_at >= now()-interval '7 days'
      AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3::timestamptz,$4::uuid))
      ORDER BY p.created_at DESC,p.id DESC LIMIT 21`,
      [options.ownerId, query.turnId ?? null, query.before ?? null, query.beforeId ?? null],
    );
    const prompts: InspectorPrompt[] = result.rows.slice(0, 20).map(({ payload, ...row }) => {
      const { redactionVersion: version, ...snapshot } = payload;
      return {
        ...snapshot,
        ...row,
        system: version === redactionVersion ? snapshot.system : safeText(snapshot.system),
        instruction:
          version === redactionVersion ? snapshot.instruction : safeText(snapshot.instruction),
        title: String(redact(row.title)),
        provider: String(redact(row.provider)),
        model: String(redact(row.model)),
        createdAt: row.createdAt.toISOString(),
      };
    });
    const last = prompts.at(-1);
    return {
      prompts,
      captureEnabled: options.enabled(),
      retentionDays: 7,
      dropped,
      hasOlder: result.rows.length > 20,
      ...(result.rows.length > 20 && last
        ? { nextBefore: last.createdAt, nextBeforeId: last.id }
        : {}),
    };
  }
  function registerRoutes(app: FastifyInstance) {
    app.get('/api/inspector/prompts', async (request, reply) => {
      if (!options.enabled()) return reply.code(404).send({ error: 'Inspector is disabled.' });
      reply.header('Cache-Control', 'no-store');
      return (
        (await read(querySchema.parse(request.query))) ??
        reply.code(404).send({ error: 'Turn not found.' })
      );
    });
  }
  return {
    initialize,
    record,
    read,
    registerRoutes,
    async close() {
      accepting = false;
      clearInterval(retentionTimer);
      retentionTimer = undefined;
      await Promise.allSettled([...pending]);
      if (pruning) await Promise.allSettled([pruning]);
    },
  };
}
