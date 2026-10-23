import { transaction as inTransaction } from './transaction.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Job, PgBoss } from 'pg-boss';
import { z } from 'zod';
import type {
  Schedule,
  ScheduleObservation,
  ScheduleRun,
  TurnStatus,
} from '../shared/contracts.ts';
import { activeThreadSql, type enqueueTurn } from './thread.ts';
import type { WorkConsumers } from './work-admission.ts';
import type { CaptureAnalytics } from './analytics.ts';

const queue = 'scheduled-task';
const timingSchema = z.object({
  kind: z.enum(['once', 'recurring']).default('recurring'),
  cron: z.string().trim().min(1).nullable().optional(),
  runAt: z.iso.datetime({ offset: true }).nullable().optional(),
  timeZone: z.string().trim().min(1),
});
const observationFields = {
  sourceUrl: z.url({ protocol: /^https?$/ }),
  summary: z.string().trim().min(1),
};
const verifiedObservationSchema = z
  .object({
    status: z.literal('verified'),
    ...observationFields,
    value: z.string().trim().min(1),
  })
  .strict();
const observationSchema = z.discriminatedUnion('status', [
  verifiedObservationSchema,
  z.object({ status: z.literal('unavailable'), ...observationFields, value: z.null() }).strict(),
]);
const createSchema = timingSchema
  .extend({
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    baselineObservation: verifiedObservationSchema.optional(),
  })
  .strict();
const updateSchema = createSchema
  .omit({ kind: true })
  .partial()
  .extend({ kind: z.enum(['once', 'recurring']).optional(), enabled: z.boolean().optional() })
  .strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
const historySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(500).optional(),
  })
  .strict();
const columns =
  'id,title,prompt,kind,cron,run_at AS "runAt",time_zone AS "timeZone",enabled,revision,next_run_at AS "nextRun",job_id AS "jobId",delivery_channel AS "deliveryChannel",channel_source_id AS "channelSourceId",authority_instruction AS "authorityInstruction",authority_source_message_id AS "authoritySourceMessageId",baseline_observation AS "baselineObservation"';

export interface ScheduleDependencies {
  analytics?: CaptureAnalytics;
  consumers?: WorkConsumers;
  pool: Pool;
  ownerId: string;
  scheduler: Pick<
    PgBoss,
    'createQueue' | 'work' | 'send' | 'cancel' | 'getJobById' | 'previewSchedule'
  >;
  stopConsumer?: (id: string) => Promise<void>;
  enqueueTurn: typeof enqueueTurn;
  refresh(): void;
  now?: () => Date;
  sessionCosts?(sessionIds: string[]): Promise<Record<string, number | null>>;
}

interface ScheduleRow {
  id: string;
  title: string;
  prompt: string;
  kind: 'once' | 'recurring';
  cron: string | null;
  runAt: Date | null;
  timeZone: string;
  enabled: boolean;
  revision: number;
  nextRun: Date | null;
  jobId: string | null;
  deliveryChannel: string;
  channelSourceId: string | null;
  authorityInstruction: string | null;
  authoritySourceMessageId: string | null;
  baselineObservation: ScheduleObservation | null;
}

interface ScheduleJob {
  scheduleId: string;
  revision: number;
  scheduledFor: string;
}

interface ScheduleProvenance {
  turnId?: string;
  sourceMessageId: string | null;
  expectedRevision?: number;
}

interface RunRow {
  id: string;
  scheduleId: string;
  title: string;
  turnId: string;
  scheduledFor: Date;
  timeZone: string;
  createdAt: Date;
  status: TurnStatus;
  error: string | null;
  messageId: string | null;
  messageText: string | null;
  cursorAt: string;
  observation: ScheduleObservation | null;
  observedAt: Date | null;
}

function invalid(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function preview(text: string) {
  const value = Array.from(text.replace(/\s+/g, ' ').trim());
  return value.length > 160 ? `${value.slice(0, 159).join('').trimEnd()}…` : value.join('');
}

function scheduleAnalytics(row: ScheduleRow) {
  const [minute, hour, day, month, weekday] = row.cron?.trim().split(/\s+/) ?? [];
  const numeric = (value: string | undefined) => value !== undefined && /^\d+$/.test(value);
  let cadence: 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom' = 'custom';
  if (row.kind === 'once') cadence = 'once';
  else if (numeric(minute) && month === '*') {
    if (hour === '*' && day === '*' && weekday === '*') cadence = 'hourly';
    else if (numeric(hour)) {
      if (day === '*' && weekday === '*') cadence = 'daily';
      else if (day === '*' && numeric(weekday)) cadence = 'weekly';
      else if (numeric(day) && weekday === '*') cadence = 'monthly';
    }
  }
  return { schedule_kind: row.kind, cadence };
}

function runValue(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    title: row.title,
    turnId: row.turnId,
    scheduledFor: row.scheduledFor.toISOString(),
    timeZone: row.timeZone,
    createdAt: row.createdAt.toISOString(),
    status: row.status,
    error: row.error,
    observation: row.observation
      ? { ...row.observation, checkedAt: row.observedAt!.toISOString() }
      : null,
    messageId: row.messageId,
    messagePreview: row.messageText && preview(row.messageText),
    messageText: row.messageText,
  };
}

export function createSchedules(dependencies: ScheduleDependencies) {
  const { pool, ownerId, scheduler, enqueueTurn, refresh } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  let workerStarted = false;

  const transaction = <T>(operation: (client: PoolClient) => Promise<T>) =>
    inTransaction(operation, pool);

  function validateTiming(input: z.infer<typeof timingSchema>, enabled: boolean) {
    try {
      scheduler.previewSchedule('0 0 * * *', { tz: input.timeZone, count: 1 });
    } catch {
      throw invalid('Choose a valid time zone.');
    }
    if (input.kind === 'once') {
      if (!input.runAt || input.cron)
        throw invalid('A one-off schedule needs one exact date and time, with its UTC offset.');
      if (enabled && new Date(input.runAt).getTime() <= now().getTime())
        throw invalid('Choose a future date and time.');
    } else {
      if (!input.cron || input.runAt || input.cron.split(/\s+/).length !== 5)
        throw invalid('Use a five-field cron schedule for recurring work.');
      try {
        scheduler.previewSchedule(input.cron, { tz: input.timeZone, count: 1 });
      } catch {
        throw invalid('Check the schedule and time zone.');
      }
    }
  }

  function nextOccurrence(schedule: ScheduleRow, after = now()) {
    if (!schedule.enabled) return null;
    if (schedule.kind === 'once') return schedule.runAt;
    return scheduler.previewSchedule(schedule.cron!, {
      tz: schedule.timeZone,
      count: 1,
      from: after,
    })[0]!;
  }

  async function enqueue(client: PoolClient, schedule: ScheduleRow, due: Date | null) {
    let jobId: string | null = null;
    if (due) {
      jobId = await scheduler.send(
        queue,
        {
          scheduleId: schedule.id,
          revision: schedule.revision,
          scheduledFor: due.toISOString(),
        },
        {
          startAfter: due,
          retryLimit: 5,
          retryDelay: 15,
          retryBackoff: true,
          expireInSeconds: 60,
          db: { executeSql: (sql, values) => client.query(sql, values) },
        },
      );
      if (!jobId) throw new Error('The schedule could not be queued.');
    }
    await client.query(
      'UPDATE schedules SET job_id=$3,next_run_at=$4 WHERE id=$1 AND owner_id=$2',
      [schedule.id, ownerId, jobId, due],
    );
    return { ...schedule, jobId, nextRun: due };
  }

  async function cancelPending(client: PoolClient, schedule: ScheduleRow) {
    if (schedule.jobId)
      await scheduler.cancel(queue, schedule.jobId, {
        db: { executeSql: (sql, values) => client.query(sql, values) },
      });
  }

  async function dispatch(job: Job<ScheduleJob>) {
    job.signal.throwIfAborted();
    const accepted = await transaction(async (client) => {
      const row = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [job.data.scheduleId, ownerId],
        )
      ).rows[0];
      if (
        !row?.enabled ||
        row.jobId !== job.id ||
        row.revision !== job.data.revision ||
        row.nextRun?.toISOString() !== job.data.scheduledFor
      )
        return false;
      job.signal.throwIfAborted();
      const turnId = await enqueueTurn(
        `Scheduled task: ${row.title}\n${row.prompt}\nDeliver what this schedule asks for in this run, even when an earlier message covered the same ground. When it asks for nothing to be sent, message the owner only about a useful result, a problem or a necessary question.`,
        {
          sourceId: `schedule:${row.id}:${row.revision}:${job.data.scheduledFor}`,
          source: 'schedule',
          channel: row.deliveryChannel,
          channelSourceId: row.channelSourceId,
          background: true,
          client,
        },
      );
      await client.query(
        `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority_instruction,authority_source_message_id,baseline_observation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          ownerId,
          row.id,
          row.revision,
          job.id,
          row.title,
          turnId,
          row.nextRun,
          row.timeZone,
          row.authorityInstruction,
          row.authoritySourceMessageId,
          row.baselineObservation ? JSON.stringify(row.baselineObservation) : null,
        ],
      );
      if (row.kind === 'once') {
        await client.query('UPDATE schedules SET enabled=false WHERE id=$1 AND owner_id=$2', [
          row.id,
          ownerId,
        ]);
        await enqueue(client, { ...row, enabled: false }, null);
      } else {
        await enqueue(
          client,
          row,
          nextOccurrence(row, new Date(Math.max(now().getTime(), row.nextRun!.getTime()))),
        );
      }
      job.signal.throwIfAborted();
      return true;
    });
    if (accepted) refresh();
  }

  async function initialize(options: { workers?: boolean } = {}) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schedules (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, prompt text NOT NULL,
        cron text, time_zone text NOT NULL, enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL DEFAULT 'recurring',
        run_at timestamptz, revision integer NOT NULL DEFAULT 0, next_run_at timestamptz,
        job_id uuid, delivery_channel text NOT NULL DEFAULT 'web', channel_source_id text,
        authority_instruction text, authority_source_message_id uuid, baseline_observation jsonb
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id uuid PRIMARY KEY, owner_id text NOT NULL, schedule_id uuid NOT NULL,
        schedule_revision integer NOT NULL, job_id uuid UNIQUE NOT NULL,
        title text NOT NULL, turn_id uuid REFERENCES turns(id), scheduled_for timestamptz NOT NULL,
        time_zone text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        authority_instruction text, authority_source_message_id uuid,
        baseline_observation jsonb, observation jsonb, observed_at timestamptz,
        UNIQUE(schedule_id,schedule_revision,scheduled_for)
      );
      ALTER TABLE schedule_runs DROP COLUMN IF EXISTS action_prompt;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS baseline_observation jsonb;
      ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS baseline_observation jsonb,
        ADD COLUMN IF NOT EXISTS observation jsonb, ADD COLUMN IF NOT EXISTS observed_at timestamptz;
      CREATE INDEX IF NOT EXISTS schedule_runs_owner_time ON schedule_runs(owner_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(owner_id,schedule_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS schedule_runs_turn ON schedule_runs(owner_id,turn_id);
    `);
    await scheduler.createQueue(queue, { retryLimit: 5, retryDelay: 15, retryBackoff: true });
    const schedules = await pool.query<{ id: string }>(
      'SELECT id FROM schedules WHERE owner_id=$1 ORDER BY id',
      [ownerId],
    );
    for (const { id } of schedules.rows) {
      await transaction(async (client) => {
        const row = (
          await client.query<ScheduleRow>(
            `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
            [id, ownerId],
          )
        ).rows[0];
        if (!row) return;
        const existing = row.jobId
          ? await scheduler.getJobById(queue, row.jobId, {
              db: { executeSql: (sql, values) => client.query(sql, values) },
            })
          : null;
        if (row.enabled && existing && ['created', 'retry', 'active'].includes(existing.state))
          return;
        await cancelPending(client, row);
        await enqueue(client, row, row.enabled ? (row.nextRun ?? nextOccurrence(row)) : null);
      });
    }
    if (options.workers !== false && !workerStarted) {
      const start = () =>
        scheduler.work<ScheduleJob>(queue, async (jobs) => {
          for (const job of jobs) await dispatch(job);
        });
      if (dependencies.consumers) {
        if (!dependencies.stopConsumer) throw invalid('Schedule consumer control is unavailable.');
        await dependencies.consumers.register({ start, stop: dependencies.stopConsumer });
      } else await start();
      workerStarted = true;
    }
  }

  async function history(raw: unknown = {}, scheduleId?: string) {
    const input = historySchema.parse(raw);
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (input.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
        );
      } catch {
        throw invalid('This history cursor is invalid.');
      }
    }
    if (scheduleId) {
      z.uuid().parse(scheduleId);
      const owned = await pool.query(
        'SELECT id FROM schedules WHERE id=$1 AND owner_id=$2 UNION ALL SELECT id FROM schedule_runs WHERE schedule_id=$1 AND owner_id=$2 LIMIT 1',
        [scheduleId, ownerId],
      );
      if (!owned.rowCount)
        throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
    }
    const rows = (
      await pool.query<RunRow>(
        `SELECT r.id,r.schedule_id AS "scheduleId",r.title,r.turn_id AS "turnId",
           r.scheduled_for AS "scheduledFor",r.time_zone AS "timeZone",r.created_at AS "createdAt",
           u.status,u.error,r.observation,r.observed_at AS "observedAt",m.id AS "messageId",m.text AS "messageText",
           to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
         FROM schedule_runs r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
         LEFT JOIN LATERAL (
           SELECT m.id,left(m.text,4000) AS text FROM messages m
           WHERE m.turn_id=u.id AND m.owner_id=u.owner_id AND m.role='assistant'
             AND u.channel='web' AND ${activeThreadSql('m')}
           ORDER BY date_trunc('milliseconds',m.created_at),m.id LIMIT 1
         ) m ON true
         WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.schedule_id=$2)
           AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
         ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,
        [
          ownerId,
          scheduleId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      runs: page.map(runValue),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify({ createdAt: last.cursorAt, id: last.id })).toString(
              'base64url',
            )
          : null,
    };
  }

  async function recordObservation(turnId: string, raw: unknown) {
    z.uuid().parse(turnId);
    const input = observationSchema.parse(raw);
    const result = await transaction(async (client) => {
      const row = (
        await client.query<{
          id: string;
          scheduleId: string;
          baselineObservation: ScheduleObservation | null;
          observation: ScheduleObservation | null;
        }>(
          `SELECT r.id,r.schedule_id AS "scheduleId",r.baseline_observation AS "baselineObservation",
             r.observation
           FROM schedule_runs r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
           JOIN threads th ON th.id=u.thread_id AND th.archived_at IS NULL
           WHERE r.turn_id=$1 AND r.owner_id=$2 AND u.status='running'
           FOR UPDATE OF r,u`,
          [turnId, ownerId],
        )
      ).rows[0];
      if (!row) throw invalid('This task has no active scheduled run.');
      if (row.observation) throw invalid('This run already has a saved observation.');
      const previous = (
        await client.query<{ observation: ScheduleObservation }>(
          `SELECT observation FROM schedule_runs
           WHERE owner_id=$1 AND schedule_id=$2 AND observation->>'status'='verified'
           ORDER BY observed_at DESC,id DESC LIMIT 1`,
          [ownerId, row.scheduleId],
        )
      ).rows[0]?.observation;
      const prior = [previous, row.baselineObservation]
        .filter((item): item is ScheduleObservation => Boolean(item))
        .toSorted((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
      const checkedAt = now().toISOString();
      const observation = { ...input, checkedAt };
      await client.query(
        'UPDATE schedule_runs SET observation=$3,observed_at=$4 WHERE id=$1 AND owner_id=$2',
        [row.id, ownerId, JSON.stringify(observation), checkedAt],
      );
      return {
        observation,
        previous: prior,
      };
    });
    refresh();
    return result;
  }

  async function monthlyCosts(rows: ScheduleRow[]) {
    const recurring = rows.filter((row) => row.kind === 'recurring' && row.enabled && row.cron);
    const monthly = new Map<string, number>();
    if (!recurring.length || !dependencies.sessionCosts) return monthly;
    const runs = (
      await pool.query<{ schedule_id: string; turn_id: string }>(
        `SELECT schedule_id,turn_id FROM (
           SELECT r.schedule_id,r.turn_id,
             row_number() OVER (PARTITION BY r.schedule_id ORDER BY r.scheduled_for DESC) AS recent
           FROM schedule_runs r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
           WHERE r.schedule_id=ANY($1::uuid[]) AND r.owner_id=$2
             AND u.status NOT IN ('queued','running','waiting')) runs
         WHERE recent<=10`,
        [recurring.map((row) => row.id), ownerId],
      )
    ).rows;
    const costs = await dependencies.sessionCosts(runs.map((run) => run.turn_id));
    const from = now();
    const month = 30 * 86_400_000;
    for (const row of recurring) {
      const priced = runs.flatMap((run) => {
        const cost = run.schedule_id === row.id ? costs[run.turn_id] : undefined;
        return typeof cost === 'number' ? [cost] : [];
      });
      if (!priced.length) continue;
      const upcoming = scheduler.previewSchedule(row.cron!, { tz: row.timeZone, count: 200, from });
      const last = upcoming.at(-1)?.getTime();
      const count =
        last !== undefined && last - from.getTime() < month
          ? (upcoming.length * month) / Math.max(last - from.getTime(), 1)
          : upcoming.filter((date) => date.getTime() - from.getTime() <= month).length;
      monthly.set(row.id, (priced.reduce((sum, cost) => sum + cost, 0) / priced.length) * count);
    }
    return monthly;
  }

  async function value(row: ScheduleRow, monthly?: Map<string, number>): Promise<Schedule> {
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      kind: row.kind,
      cron: row.cron,
      runAt: row.runAt?.toISOString() ?? null,
      timeZone: row.timeZone,
      enabled: row.enabled,
      revision: row.revision,
      nextRun: row.nextRun?.toISOString() ?? null,
      lastRun: (await history({ limit: 1 }, row.id)).runs[0] ?? null,
      baselineObservation: row.baselineObservation,
      monthlyUsd: (monthly ?? (await monthlyCosts([row]))).get(row.id) ?? null,
    };
  }

  async function list() {
    const rows = (
      await pool.query<ScheduleRow>(
        `SELECT ${columns} FROM schedules WHERE owner_id=$1 ORDER BY created_at DESC,id`,
        [ownerId],
      )
    ).rows;
    const monthly = await monthlyCosts(rows);
    return Promise.all(rows.map((row) => value(row, monthly)));
  }

  function validateCreate(raw: unknown) {
    const input = createSchema.parse(raw);
    validateTiming(input, true);
    return input;
  }

  function updateValue(previous: ScheduleRow, input: z.infer<typeof updateSchema>) {
    const next = {
      ...previous,
      ...(input.kind && input.kind !== previous.kind ? { cron: null, runAt: null } : {}),
      ...input,
      runAt:
        input.runAt === undefined
          ? input.kind === 'recurring'
            ? null
            : previous.runAt?.toISOString()
          : input.runAt,
    };
    validateTiming(next, next.enabled && (input.enabled === true || input.runAt !== undefined));
    return next;
  }

  async function read(id: string) {
    z.uuid().parse(id);
    const row = (
      await pool.query<ScheduleRow>(
        `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2`,
        [id, ownerId],
      )
    ).rows[0];
    if (!row) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
    return row;
  }

  function assertRevision(previous: ScheduleRow, expectedRevision?: number) {
    if (expectedRevision !== undefined && previous.revision !== expectedRevision)
      throw Object.assign(new Error('The schedule changed. Review it before asking again.'), {
        statusCode: 409,
      });
  }

  async function validateUpdate(id: string, raw: unknown, expectedRevision?: number) {
    const input = updateSchema.parse(raw);
    if (!Object.keys(input).length) throw invalid('Choose a schedule detail to update.');
    const previous = await read(id);
    assertRevision(previous, expectedRevision);
    updateValue(previous, input);
    return input;
  }

  async function sourceProvenance(client: PoolClient, provenance?: ScheduleProvenance) {
    if (!provenance?.sourceMessageId) return provenance;
    const source = (
      await client.query<{ turn_id: string }>(
        `SELECT m.turn_id FROM turns u JOIN messages m ON m.thread_id=u.thread_id AND m.owner_id=u.owner_id
         JOIN threads th ON th.id=u.thread_id AND th.archived_at IS NULL
         WHERE u.id=$1 AND u.owner_id=$2 AND m.id=$3 AND m.role='user' AND m.turn_id IS NOT NULL FOR SHARE OF u`,
        [z.uuid().parse(provenance.turnId), ownerId, z.uuid().parse(provenance.sourceMessageId)],
      )
    ).rows[0];
    if (!source) throw invalid('The schedule instruction is unavailable.');
    return { turnId: source.turn_id, sourceMessageId: provenance.sourceMessageId };
  }

  async function deliveryRoute(
    client: PoolClient,
    provenance?: { turnId?: string; sourceMessageId: string | null },
  ) {
    if (!provenance?.turnId) return { channel: 'web', sourceId: null };
    const turnId = z.uuid().parse(provenance.turnId);
    const sourceMessageId = z.uuid().nullable().parse(provenance.sourceMessageId);
    const turn = (
      await client.query<{ channel: string; source: string }>(
        `SELECT u.channel,u.source FROM turns u JOIN threads th ON th.id=u.thread_id
         WHERE u.id=$1 AND u.owner_id=$2 AND th.archived_at IS NULL
           AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM messages m
             WHERE m.id=$3 AND m.turn_id=u.id AND m.owner_id=u.owner_id AND m.role='user'))
         FOR SHARE OF u`,
        [turnId, ownerId, sourceMessageId],
      )
    ).rows[0];
    const unavailable = () => invalid('The schedule delivery conversation is unavailable.');
    if (!turn) throw unavailable();
    if (turn.channel === 'web') return { channel: 'web', sourceId: null };
    if (!sourceMessageId) {
      if (turn.source === 'user') throw unavailable();
      return { channel: turn.channel, sourceId: null };
    }
    const route = (
      await client.query<{
        source_id: string;
        provider: string;
        account_id: string;
        sender_id: string;
      }>(
        `SELECT i.source_id,i.provider,i.account_id,i.sender_id FROM channel_inbox i
         WHERE i.state='submitted' AND i.owner_id=$1 AND i.message_id=$2`,
        [ownerId, sourceMessageId],
      )
    ).rows[0];
    if (!route) throw unavailable();
    const identity = createHash('sha256')
      .update(JSON.stringify([route.account_id, route.sender_id]))
      .digest('hex')
      .slice(0, 32);
    if (turn.channel !== `${route.provider}:${identity}`) throw unavailable();
    return { channel: turn.channel, sourceId: route.source_id };
  }

  async function authority(
    client: PoolClient,
    prompt: string,
    provenance?: { turnId?: string; sourceMessageId: string | null },
  ) {
    if (!provenance) return { instruction: prompt, sourceMessageId: null };
    if (!provenance.sourceMessageId) return { instruction: null, sourceMessageId: null };
    const row = (
      await client.query<{ text: string; offered: boolean }>(
        `SELECT m.text,EXISTS(
           SELECT 1 FROM messages offer, jsonb_array_elements(offer.suggestions->'tasks') task
           WHERE offer.owner_id=m.owner_id AND offer.thread_id=m.thread_id AND offer.suggestions IS NOT NULL AND task->>'title'=m.text
         ) AS offered
         FROM messages m WHERE m.id=$1 AND m.owner_id=$2 AND m.role='user' AND ($3::uuid IS NULL OR m.turn_id=$3)
         FOR SHARE OF m`,
        [provenance.sourceMessageId, ownerId, provenance.turnId ?? null],
      )
    ).rows[0];
    if (!row) throw invalid('The schedule instruction is unavailable.');
    return {
      instruction: row.offered ? null : row.text,
      sourceMessageId: provenance.sourceMessageId,
    };
  }

  async function create(raw: unknown, provenance?: ScheduleProvenance) {
    const input = validateCreate(raw);
    const row = await transaction(async (client) => {
      const source = await sourceProvenance(client, provenance);
      const route = await deliveryRoute(client, source);
      const authorized = await authority(client, input.prompt, source);
      const saved = (
        await client.query<ScheduleRow>(
          `INSERT INTO schedules(id,owner_id,title,prompt,kind,cron,run_at,time_zone,delivery_channel,channel_source_id,authority_instruction,authority_source_message_id,baseline_observation)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${columns}`,
          [
            randomUUID(),
            ownerId,
            input.title,
            input.prompt,
            input.kind,
            input.cron ?? null,
            input.runAt ?? null,
            input.timeZone,
            route.channel,
            route.sourceId,
            authorized.instruction,
            authorized.sourceMessageId,
            input.baselineObservation
              ? JSON.stringify({ ...input.baselineObservation, checkedAt: now().toISOString() })
              : null,
          ],
        )
      ).rows[0]!;
      return enqueue(client, saved, nextOccurrence(saved));
    });
    refresh();
    dependencies.analytics?.({
      event: 'nod_schedule_changed',
      properties: {
        operation: 'create',
        ...scheduleAnalytics(row),
        actor: provenance ? 'agent' : 'user',
      },
    });
    return value(row);
  }

  async function update(id: string, raw: unknown, provenance?: ScheduleProvenance) {
    z.uuid().parse(id);
    const input = updateSchema.parse(raw);
    if (!Object.keys(input).length) throw invalid('Choose a schedule detail to update.');
    const row = await transaction(async (client) => {
      const previous = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [id, ownerId],
        )
      ).rows[0];
      if (!previous) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      assertRevision(previous, provenance?.expectedRevision);
      const next = updateValue(previous, input);
      const authorized =
        input.prompt === undefined
          ? {
              instruction: previous.authorityInstruction,
              sourceMessageId: previous.authoritySourceMessageId,
            }
          : await authority(client, input.prompt, await sourceProvenance(client, provenance));
      await cancelPending(client, previous);
      const saved = (
        await client.query<ScheduleRow>(
          `UPDATE schedules SET title=$3,prompt=$4,kind=$5,cron=$6,run_at=$7,time_zone=$8,
             enabled=$9,authority_instruction=$10,authority_source_message_id=$11,
             baseline_observation=COALESCE($12::jsonb,baseline_observation),revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
          [
            id,
            ownerId,
            next.title,
            next.prompt,
            next.kind,
            next.cron,
            next.runAt ?? null,
            next.timeZone,
            next.enabled,
            authorized.instruction,
            authorized.sourceMessageId,
            input.baselineObservation
              ? JSON.stringify({ ...input.baselineObservation, checkedAt: now().toISOString() })
              : null,
          ],
        )
      ).rows[0]!;
      const timingChanged = ['kind', 'cron', 'runAt', 'timeZone', 'enabled'].some(
        (key) => key in input,
      );
      return enqueue(
        client,
        saved,
        !timingChanged && saved.enabled && previous.nextRun
          ? previous.nextRun
          : nextOccurrence(saved),
      );
    });
    refresh();
    dependencies.analytics?.({
      event: 'nod_schedule_changed',
      properties: {
        operation: 'update',
        ...scheduleAnalytics(row),
        actor: provenance ? 'agent' : 'user',
      },
    });
    return value(row);
  }

  async function remove(id: string) {
    z.uuid().parse(id);
    const row = await transaction(async (client) => {
      const row = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [id, ownerId],
        )
      ).rows[0];
      if (!row) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      await cancelPending(client, row);
      await client.query('DELETE FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId]);
      return row;
    });
    refresh();
    dependencies.analytics?.({
      event: 'nod_schedule_changed',
      properties: { operation: 'delete', ...scheduleAnalytics(row), actor: 'user' },
    });
    return { ok: true };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/schedules', list);
    app.post('/api/schedules', (request) => create(request.body));
    app.patch<{ Params: { id: string } }>('/api/schedules/:id', (request) =>
      update(request.params.id, request.body),
    );
    app.delete<{ Params: { id: string } }>('/api/schedules/:id', (request) =>
      remove(request.params.id),
    );
    app.get('/api/schedule-runs', (request) => history(request.query));
    app.get<{ Params: { id: string } }>('/api/schedules/:id/runs', (request) =>
      history(request.query, request.params.id),
    );
  }

  return {
    initialize,
    list,
    get: async (id: string) => value(await read(id)),
    create,
    update,
    remove,
    history,
    registerRoutes,
    validateCreate,
    validateUpdate,
    recordObservation,
  };
}
