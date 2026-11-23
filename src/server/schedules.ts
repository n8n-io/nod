import { afterCommit, transaction as inTransaction } from './transaction.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cancellationTransaction } from './db.ts';
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
import { abortTurns, cancelTurns, lockThread, type enqueueTurn } from './thread.ts';
import { modelSelectionInput } from './models.ts';
import {
  canReuseWorkCost,
  repriceUsd,
  type ModelChoice,
  type ModelSelection,
  type WorkUsage,
} from '../shared/models.ts';
import { activeThreadSql } from './history.ts';
import { waitingTurnSql } from './turn-chain.ts';
import type { WorkConsumers } from './work-admission.ts';
import { snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import { logFailure } from './failure-log.ts';
import { ianaTimeZone } from './preferences.ts';
import { lockKey } from './locks.ts';
import {
  mergeOwnerInstructions,
  ownerEdit,
  validateInstructionChange,
  type OwnerInstructions,
  type InstructionChange,
} from './owner-instructions.ts';

const queue = 'scheduled-task';
const lateAfterMs = 10 * 60_000;
const skippedCountLimit = 100;
const runTurn = `JOIN LATERAL (
  SELECT u.* FROM turns u WHERE u.owner_id=r.owner_id AND (u.id=r.turn_id OR u.session_id=r.turn_id)
    AND (u.id=r.turn_id OR NOT (u.status='succeeded' AND u.started_at IS NULL
      AND u.message_id IS NOT NULL AND u.source IN ('user','task')))
  ORDER BY CASE WHEN u.status='running' THEN 0 WHEN u.status='queued' THEN 1
    WHEN ${waitingTurnSql('u')} THEN 2 ELSE 3 END,u.created_at DESC,u.id DESC LIMIT 1
) u ON true`;
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
const watchSchema = z.array(z.uuid()).min(1).max(10);
const createSchema = timingSchema
  .extend({
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    baselineObservation: verifiedObservationSchema.optional(),
    watch: watchSchema.optional(),
    model: modelSelectionInput.optional(),
  })
  .strict();
const updateSchema = createSchema
  .omit({ kind: true, watch: true, model: true })
  .partial()
  .extend({
    kind: z.enum(['once', 'recurring']).optional(),
    enabled: z.boolean().optional(),
    watch: watchSchema.nullable().optional(),
  })
  .strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
const historySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(500).optional(),
    scheduleId: z.uuid().optional(),
  })
  .strict();
const columns =
  'id,title,prompt,kind,cron,run_at AS "runAt",time_zone AS "timeZone",enabled,revision,next_run_at AS "nextRun",job_id AS "jobId",delivery_channel AS "deliveryChannel",channel_source_id AS "channelSourceId",authority,baseline_observation AS "baselineObservation",watch,watch_marker AS "watchMarker",model';

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
  clearBrowser?(id: string): Promise<void>;
  retireScheduleConfirmations?(client: PoolClient, id: string, waitForSend: boolean): Promise<void>;
  now?: () => Date;
  sessionCosts?(sessionIds: string[]): Promise<Record<string, number | null>>;
  watchable?(connectionIds: string[]): Promise<boolean>;
  watchState?(connectionIds: string[]): Promise<string | null>;
  modelPaused?(model: ModelSelection | null): boolean;
  recentTurnUsage?(
    turnId?: string,
    projectAtApiRates?: boolean,
  ): Promise<Array<WorkUsage & { recordedUsd: number; work?: boolean }>>;
  validateModel?(choice: ModelSelection): ModelSelection;
  sessionUsage?(sessionIds: string[]): Promise<Record<string, WorkUsage & { unpriced: boolean }>>;
  workPricing?(own: ModelSelection | null): WorkPrice | undefined;
}

type WorkPrice = {
  modelId: string;
  pricing: ModelChoice['pricing'];
  audio?: boolean;
  plan?: boolean;
};

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
  authority: OwnerInstructions | null;
  baselineObservation: ScheduleObservation | null;
  watch: string[] | null;
  watchMarker: string | null;
  model: ModelSelection | null;
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
  instructionChange?: InstructionChange;
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

  const transaction = <T>(operation: (client: PoolClient) => Promise<T>, shared?: PoolClient) =>
    shared ? operation(shared) : inTransaction(operation, pool);

  const retirementTransaction = <T>(
    operation: (client: PoolClient) => Promise<T>,
    shared?: PoolClient,
  ) => (shared ? operation(shared) : cancellationTransaction(operation, pool));

  function validateTiming(input: z.infer<typeof timingSchema>, enabled: boolean) {
    if (!ianaTimeZone(input.timeZone)) throw invalid('Choose a valid time zone.');
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

  async function scheduleCache(turnId: string): Promise<'short' | 'long' | undefined> {
    const row = (
      await pool.query<{ cron: string; timeZone: string; scheduledFor: Date }>(
        `SELECT s.cron,s.time_zone AS "timeZone",r.scheduled_for AS "scheduledFor"
         FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id AND s.owner_id=r.owner_id
         WHERE r.turn_id=$1 AND r.owner_id=$2 AND r.schedule_revision=s.revision
           AND s.enabled AND s.kind='recurring' AND s.cron IS NOT NULL`,
        [turnId, ownerId],
      )
    ).rows[0];
    if (!row) return;
    const next = scheduler.previewSchedule(row.cron, {
      tz: row.timeZone,
      count: 1,
      from: row.scheduledFor,
    })[0];
    const gap = next ? next.getTime() - row.scheduledFor.getTime() : Number.NaN;
    if (!Number.isFinite(gap) || gap <= 0 || gap > 55 * 60_000) return;
    return gap > 5 * 60_000 ? 'long' : 'short';
  }

  function missedFires(schedule: ScheduleRow, due: Date, started: Date) {
    const fires: Date[] = [];
    if (schedule.kind === 'recurring' && started.getTime() - due.getTime() > lateAfterMs)
      for (
        let next = nextOccurrence(schedule, due)!;
        next <= started && fires.length < skippedCountLimit;
        next = nextOccurrence(schedule, next)!
      )
        fires.push(next);
    return fires;
  }

  function lateNote(schedule: ScheduleRow, due: Date, started: Date, skipped: number) {
    if (started.getTime() - due.getTime() <= lateAfterMs) return '';
    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone: schedule.timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    const gap = skipped
      ? ` ${skipped >= skippedCountLimit ? `${skippedCountLimit} or more` : skipped} later ${skipped === 1 ? 'run was' : 'runs were'} skipped.`
      : '';
    return `\nThis run was due at ${format.format(due)} and started at ${format.format(started)}.${gap}`;
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

  async function activeRun(client: Pick<Pool, 'query'>, scheduleId: string) {
    const { rows } = await client.query<NonNullable<Schedule['activeRun']>>(
      `SELECT u.id AS "turnId",u.status,
          (SELECT m.id FROM messages m WHERE u.status='waiting'
            AND m.owner_id=u.owner_id AND m.thread_id=u.thread_id AND m.turn_id=u.id
            AND m.role='assistant' AND m.text<>'' AND m.hidden_at IS NULL AND ${activeThreadSql('m')}
            ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS "questionMessageId"
          FROM schedule_runs r
         JOIN turns u ON u.owner_id=r.owner_id AND u.session_id=r.turn_id
         WHERE r.owner_id=$1 AND r.schedule_id=$2 AND (u.status IN ('queued','running')
           OR (${waitingTurnSql('u')}))
         ORDER BY (u.status='running') DESC,(u.status='queued') DESC,u.created_at DESC,u.id DESC LIMIT 1`,
      [ownerId, scheduleId],
    );
    return rows[0] ?? null;
  }

  async function startRun(
    client: PoolClient,
    row: ScheduleRow,
    jobId: string,
    scheduledFor: Date,
    note = '',
    missed: Date[] = [],
  ) {
    const turnId = await enqueueTurn(
      `Scheduled task: ${row.title}\n${row.prompt}\nDo this run now; the schedule already decided its timing. Deliver what this schedule asks for in this run, even when an earlier message covered the same ground. When it asks for nothing to be sent, message the owner only about a useful result, a problem or a necessary question.${note}`,
      {
        sourceId: `schedule:${row.id}:${jobId}`,
        source: 'schedule',
        channel: row.deliveryChannel,
        channelSourceId: row.channelSourceId,
        background: true,
        client,
      },
    );
    const paused =
      (
        await client.query<{ skipped: { at: string; reason: 'paused' }[] }>(
          `UPDATE schedules s SET skipped='[]'::jsonb FROM (SELECT skipped FROM schedules WHERE id=$1 AND owner_id=$2) old
           WHERE s.id=$1 AND s.owner_id=$2 RETURNING old.skipped`,
          [row.id, ownerId],
        )
      ).rows[0]?.skipped ?? [];
    const skipped = [
      ...paused,
      ...missed.map((at) => ({ at: at.toISOString(), reason: 'stopped' as const })),
    ].slice(-skippedCountLimit);
    await client.query(
      `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority,baseline_observation,skipped)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        ownerId,
        row.id,
        row.revision,
        jobId,
        row.title,
        turnId,
        scheduledFor,
        row.timeZone,
        row.authority ? JSON.stringify(row.authority) : null,
        row.baselineObservation ? JSON.stringify(row.baselineObservation) : null,
        JSON.stringify(skipped),
      ],
    );
    return { turnId };
  }

  async function runNow(id: string, raw: unknown) {
    z.uuid().parse(id);
    const input = z
      .object({
        requestId: z.uuid(),
        expectedRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(raw);
    const run = await transaction(async (client) => {
      const row = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [id, ownerId],
        )
      ).rows[0];
      if (!row) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      const previous = (
        await client.query<{ turnId: string }>(
          'SELECT turn_id AS "turnId" FROM schedule_runs WHERE job_id=$1 AND schedule_id=$2 AND owner_id=$3',
          [input.requestId, id, ownerId],
        )
      ).rows[0];
      if (previous) return previous;
      assertRevision(row, input.expectedRevision);
      if (await activeRun(client, id))
        throw Object.assign(
          new Error('This schedule already has a run in progress or waiting for your answer.'),
          { statusCode: 409 },
        );
      return startRun(
        client,
        row,
        input.requestId,
        now(),
        '\nThe owner started this run with Run now.',
      );
    });
    refresh();
    return { ...run, activeRun: await activeRun(pool, id) };
  }

  async function stopRun(id: string, turnId: string) {
    z.uuid().parse(id);
    z.uuid().parse(turnId);
    const capture = snapshotAnalytics(dependencies.analytics);
    const cancelled = await cancellationTransaction(async (client) => {
      const thread = await lockThread(client, ownerId);
      const run = (
        await client.query<{ sessionId: string }>(
          `SELECT r.turn_id AS "sessionId" FROM schedule_runs r
           JOIN turns u ON u.session_id=r.turn_id AND u.owner_id=r.owner_id
           WHERE r.owner_id=$1 AND r.schedule_id=$2 AND u.id=$3 AND u.thread_id=$4`,
          [ownerId, id, turnId, thread.id],
        )
      ).rows[0];
      if (!run) throw Object.assign(new Error('Schedule run not found.'), { statusCode: 404 });
      return cancelTurns(client, thread.id, { sessionId: run.sessionId }, capture, 'owner');
    }, pool);
    abortTurns(cancelled.ids);
    await Promise.allSettled(cancelled.browsers.map((id) => dependencies.clearBrowser?.(id)));
    refresh();
    return { ok: true };
  }

  async function dispatch(job: Job<ScheduleJob>) {
    job.signal.throwIfAborted();
    const watched = (
      await pool.query<Pick<ScheduleRow, 'watch' | 'kind'>>(
        'SELECT watch,kind FROM schedules WHERE id=$1 AND owner_id=$2 AND enabled AND job_id=$3 AND revision=$4 AND next_run_at=$5',
        [job.data.scheduleId, ownerId, job.id, job.data.revision, job.data.scheduledFor],
      )
    ).rows[0];
    const marker =
      watched?.kind === 'recurring' && watched.watch?.length
        ? await dependencies.watchState?.(watched.watch).catch(() => null)
        : null;
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
      const busy = await activeRun(client, row.id);
      if (row.kind === 'once' && busy) {
        await enqueue(client, row, new Date(now().getTime() + 60_000));
        job.signal.throwIfAborted();
        return true;
      }
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
      if (busy) return true;
      if (row.kind === 'recurring' && dependencies.modelPaused?.(row.model)) {
        await client.query(
          `UPDATE schedules SET skipped=(CASE WHEN jsonb_array_length(skipped)>=$4 THEN skipped-0 ELSE skipped END)
             ||jsonb_build_array(jsonb_build_object('at',$3::text,'reason','paused'))
           WHERE id=$1 AND owner_id=$2`,
          [row.id, ownerId, row.nextRun!.toISOString(), skippedCountLimit],
        );
        return true;
      }
      const unchanged = marker ? `${row.revision}:${marker}` : null;
      if (unchanged) {
        if (
          row.watchMarker === unchanged &&
          (
            await client.query<{ status: TurnStatus }>(
              `SELECT u.status FROM schedule_runs r ${runTurn}
               WHERE r.owner_id=$1 AND r.schedule_id=$2 ORDER BY r.scheduled_for DESC,r.created_at DESC,r.id DESC LIMIT 1`,
              [ownerId, row.id],
            )
          ).rows[0]?.status === 'succeeded'
        )
          return true;
        await client.query('UPDATE schedules SET watch_marker=$3 WHERE id=$1 AND owner_id=$2', [
          row.id,
          ownerId,
          unchanged,
        ]);
      }
      const due = row.kind === 'once' ? row.runAt! : row.nextRun!;
      const started = now();
      const missed = missedFires(row, due, started);
      await startRun(client, row, job.id, due, lateNote(row, due, started, missed.length), missed);
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
        authority jsonb, baseline_observation jsonb
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id uuid PRIMARY KEY, owner_id text NOT NULL, schedule_id uuid NOT NULL,
        schedule_revision integer NOT NULL, job_id uuid UNIQUE NOT NULL,
        title text NOT NULL, turn_id uuid REFERENCES turns(id), scheduled_for timestamptz NOT NULL,
        time_zone text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        authority jsonb,
        baseline_observation jsonb, observation jsonb, observed_at timestamptz
      );
      ALTER TABLE schedule_runs DROP CONSTRAINT IF EXISTS schedule_runs_schedule_id_schedule_revision_scheduled_for_key;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS baseline_observation jsonb;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS authority jsonb;
      ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS authority jsonb;
      UPDATE schedules s SET authority=jsonb_build_object('messages',jsonb_build_array(jsonb_build_object(
        'id',to_jsonb(s)->'authority_source_message_id',
        'at',COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=s.owner_id AND m.id::text=to_jsonb(s)->>'authority_source_message_id'),s.created_at),
        'text',to_jsonb(s)->>'authority_instruction')),
        'requiresReplacement',COALESCE(jsonb_array_length(to_jsonb(s)->'authority_context'->'changes'),0)>0)
        WHERE authority IS NULL AND to_jsonb(s)->>'authority_instruction' IS NOT NULL;
      UPDATE schedule_runs s SET authority=jsonb_build_object('messages',jsonb_build_array(jsonb_build_object(
        'id',to_jsonb(s)->'authority_source_message_id',
        'at',COALESCE((SELECT m.created_at FROM messages m WHERE m.owner_id=s.owner_id AND m.id::text=to_jsonb(s)->>'authority_source_message_id'),s.created_at),
        'text',to_jsonb(s)->>'authority_instruction')),
        'requiresReplacement',COALESCE(jsonb_array_length(to_jsonb(s)->'authority_context'->'changes'),0)>0)
        WHERE authority IS NULL AND to_jsonb(s)->>'authority_instruction' IS NOT NULL;
      ALTER TABLE schedules DROP COLUMN IF EXISTS authority_instruction, DROP COLUMN IF EXISTS authority_source_message_id, DROP COLUMN IF EXISTS authority_context;
      ALTER TABLE schedule_runs DROP COLUMN IF EXISTS authority_instruction, DROP COLUMN IF EXISTS authority_source_message_id, DROP COLUMN IF EXISTS authority_context;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS watch jsonb, ADD COLUMN IF NOT EXISTS watch_marker text;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS model jsonb;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE schedule_runs ADD COLUMN IF NOT EXISTS skipped jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS notice_shown boolean NOT NULL DEFAULT true;
      ALTER TABLE schedule_runs ALTER COLUMN notice_shown SET DEFAULT false;
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

  async function history(raw: unknown = {}, includeCosts = true) {
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
    const rows = (
      await pool.query<RunRow>(
        `SELECT r.id,r.schedule_id AS "scheduleId",r.title,r.turn_id AS "turnId",
           r.scheduled_for AS "scheduledFor",r.time_zone AS "timeZone",r.created_at AS "createdAt",
           u.status,u.error,r.observation,r.observed_at AS "observedAt",m.id AS "messageId",m.text AS "messageText",
           to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
         FROM schedule_runs r ${runTurn}
         LEFT JOIN LATERAL (
           SELECT m.id,left(m.text,4000) AS text FROM messages m
           WHERE m.turn_id=u.id AND m.owner_id=u.owner_id AND m.role='assistant'
             AND m.hidden_at IS NULL AND u.channel='web' AND ${activeThreadSql('m')}
           ORDER BY date_trunc('milliseconds',m.created_at),m.id LIMIT 1
         ) m ON true
         WHERE r.owner_id=$1 AND ($2::uuid IS NULL OR r.schedule_id=$2)
           AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
         ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,
        [
          ownerId,
          input.scheduleId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const costs = includeCosts
      ? await dependencies.sessionCosts?.(page.map((run) => run.turnId)).catch((cause) => {
          logFailure('schedule_costs_unavailable', cause);
          return undefined;
        })
      : undefined;
    return {
      runs: page.map((row) => ({
        ...runValue(row),
        ...(costs ? { costUsd: costs[row.turnId] ?? null } : {}),
      })),
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

  async function monthlyCosts(rows: ScheduleRow[], turnId?: string) {
    const recurring = rows.filter((row) => row.kind === 'recurring' && row.enabled && row.cron);
    const monthly = new Map<string, number>();
    if (!recurring.length || !dependencies.sessionCosts) return monthly;
    const runs = (
      await pool.query<{ schedule_id: string; turn_id: string; latest: boolean }>(
        `SELECT schedule_id,turn_id,latest FROM (
           SELECT r.schedule_id,r.turn_id,
             row_number() OVER (PARTITION BY r.schedule_id ORDER BY r.scheduled_for DESC,r.created_at DESC,r.id DESC) AS recent,
             row_number() OVER (ORDER BY r.scheduled_for DESC,r.created_at DESC,r.id DESC)<=10 AS latest
           FROM schedule_runs r ${runTurn}
           WHERE r.owner_id=$2 AND u.status NOT IN ('queued','running','waiting')) runs
         WHERE (recent<=10 AND schedule_id=ANY($1::uuid[])) OR latest`,
        [recurring.map((row) => row.id), ownerId],
      )
    ).rows;
    const sessions = runs.map((run) => run.turn_id);
    const usage = dependencies.workPricing
      ? await dependencies.sessionUsage?.(sessions)
      : undefined;
    const costs = usage ? {} : await dependencies.sessionCosts(sessions);
    const forecast = (
      spent: WorkUsage | undefined,
      recorded: number | null | undefined,
      target: WorkPrice | undefined,
    ) => {
      if (!spent || !target) return typeof recorded === 'number' && recorded > 0 ? recorded : null;
      if (canReuseWorkCost(spent, target.modelId, target.pricing)) return recorded;
      const cost = repriceUsd(spent, target.pricing, target.audio);
      const tokens = spent.input + spent.output + spent.cacheRead + spent.cacheWrite;
      return cost === 0 && tokens === 0 ? null : cost;
    };
    const hasPrice = (cost: number | null | undefined): cost is number =>
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
    const pricedRuns = (
      target: WorkPrice | undefined,
      keep: (run: (typeof runs)[number]) => boolean,
    ) =>
      runs.flatMap((run) => {
        const spent = usage?.[run.turn_id];
        const recorded = spent ? spent.agentUsd + spent.otherUsd : costs[run.turn_id];
        if (!keep(run) || spent?.unpriced) return [];
        const cost = forecast(spent, recorded, target);
        return hasPrice(cost) ? [cost] : [];
      });
    let fallback: Promise<Array<WorkUsage & { recordedUsd: number; work?: boolean }>> | undefined;
    const recentTurnMedian = async (target: WorkPrice | undefined) => {
      const recent = await (fallback ??=
        dependencies.recentTurnUsage?.(turnId, target !== undefined) ?? Promise.resolve([]));
      const priced = recent.flatMap((sample) => {
        const cost = forecast(sample, sample.recordedUsd, target);
        return hasPrice(cost) ? [{ cost, work: sample.work }] : [];
      });
      const work = priced.filter((sample) => sample.work);
      const samples = (work.length ? work : priced)
        .map((sample) => sample.cost)
        .sort((a, b) => a - b);
      if (!samples.length) return [];
      const middle = Math.floor(samples.length / 2);
      return [(samples[middle]! + samples[Math.ceil(samples.length / 2) - 1]!) / 2];
    };
    const from = now();
    const month = 30 * 86_400_000;
    for (const row of recurring) {
      const target = dependencies.workPricing?.(row.model);
      if (target?.plan || (dependencies.workPricing && !target)) continue;
      const own = pricedRuns(target, (run) => run.schedule_id === row.id);
      const recent = pricedRuns(target, (run) => run.latest);
      const priced = runs.some((run) => run.schedule_id === row.id)
        ? own
        : recent.length
          ? recent
          : await recentTurnMedian(target);
      if (!priced.some((cost) => cost > 0)) continue;
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

  async function value(
    row: ScheduleRow,
    monthly?: Map<string, number>,
    turnId?: string,
  ): Promise<Schedule> {
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
      lastRun: (await history({ limit: 1, scheduleId: row.id }, false)).runs[0] ?? null,
      activeRun: await activeRun(pool, row.id),
      baselineObservation: row.baselineObservation,
      watch: row.watch,
      model: row.model,
      monthlyUsd: (monthly ?? (await monthlyCosts([row], turnId))).get(row.id) ?? null,
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

  async function validateWatch(watch: string[] | null | undefined, kind: string) {
    if (!watch) return;
    if (kind !== 'recurring') throw invalid('Only a recurring schedule can watch accounts.');
    if (!(await dependencies.watchable?.(watch)))
      throw invalid(
        'One of these accounts has no change signal, so this schedule cannot skip unchanged runs. Save it without watch.',
      );
  }

  function validateModel<T extends { model?: ModelSelection | null }>(input: T) {
    if (!input.model) return input;
    if (!dependencies.validateModel) throw invalid('Model choices are unavailable.');
    return { ...input, model: dependencies.validateModel(input.model) };
  }

  function validateCreate(raw: unknown) {
    const input = validateModel(createSchema.parse(raw));
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

  async function read(id: string, client?: PoolClient) {
    z.uuid().parse(id);
    const row = (
      await (client ?? pool).query<ScheduleRow>(
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

  async function validateUpdate(
    id: string,
    raw: unknown,
    expectedRevision?: number,
    client?: PoolClient,
  ) {
    const input = updateSchema.parse(raw);
    if (!Object.keys(input).length) throw invalid('Choose a schedule detail to update.');
    const previous = await read(id, client);
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
    input: Record<string, unknown>,
    provenance?: ScheduleProvenance,
  ): Promise<OwnerInstructions | null> {
    if (!provenance) return ownerEdit(input);
    if (provenance.instructionChange) {
      await validateInstructionChange(client, ownerId, provenance.instructionChange);
      return provenance.instructionChange.evidence;
    }
    throw Object.assign(
      new Error('The schedule change has no checked owner instruction. Ask for this change again.'),
      { notRun: true },
    );
  }

  function definition(row: {
    title: string;
    prompt: string;
    kind: 'once' | 'recurring';
    timeZone: string;
    cron?: string | null;
    runAt?: Date | string | null;
    enabled?: boolean;
    watch?: string[] | null;
  }): Record<string, unknown> {
    return {
      title: row.title,
      prompt: row.prompt,
      kind: row.kind,
      cron: row.cron ?? null,
      runAt: row.runAt instanceof Date ? row.runAt.toISOString() : (row.runAt ?? null),
      timeZone: row.timeZone,
      enabled: row.enabled ?? true,
      watch: row.watch ?? null,
    };
  }

  async function prepareChange(action: string, args: Record<string, unknown>) {
    if (action === 'schedule_create') {
      const input = validateCreate(args);
      return { input, before: null, changes: input, after: definition(input) };
    }
    const { id, ...fields } = args;
    const input =
      action === 'schedule_pause' || action === 'schedule_cancel'
        ? { enabled: false }
        : updateSchema.parse(fields);
    const previous = await read(z.uuid().parse(id));
    return {
      input:
        action === 'schedule_pause' || action === 'schedule_cancel'
          ? { id: String(id) }
          : { id: String(id), ...input },
      evidence: previous.authority ?? { messages: [] },
      before: definition(previous),
      changes: input,
      after: definition(updateValue(previous, input)),
      revision: previous.revision,
    };
  }

  function assertChange(
    provenance: ScheduleProvenance | undefined,
    next: Parameters<typeof definition>[0],
  ) {
    if (
      provenance?.instructionChange &&
      !isDeepStrictEqual(provenance.instructionChange.after, definition(next))
    )
      throw Object.assign(
        new Error(
          'The proposed schedule differs from the schedule that was checked. The change did not run.',
        ),
        { notRun: true },
      );
  }

  async function duplicate(
    client: PoolClient,
    input: ReturnType<typeof validateCreate>,
    route: { channel: string; sourceId: string | null },
  ) {
    await lockKey(client, `schedules:${ownerId}`);
    return (
      await client.query<ScheduleRow>(
        `SELECT ${columns} FROM schedules WHERE owner_id=$1 AND enabled AND kind=$2
           AND cron IS NOT DISTINCT FROM $3 AND run_at IS NOT DISTINCT FROM $4::timestamptz AND time_zone=$5
           AND watch IS NOT DISTINCT FROM $9::jsonb AND delivery_channel=$8 AND ${
             route.sourceId
               ? `channel_source_id IN (SELECT source_id FROM channel_inbox WHERE owner_id=$1
                    AND thread_id=(SELECT thread_id FROM channel_inbox WHERE source_id=$10 AND owner_id=$1))`
               : 'channel_source_id IS NULL'
           }
           AND (lower(btrim(title))=lower(btrim($6)) OR prompt=$7) ORDER BY created_at LIMIT 1`,
        [
          ownerId,
          input.kind,
          input.cron ?? null,
          input.runAt ?? null,
          input.timeZone,
          input.title,
          input.prompt,
          route.channel,
          input.watch ? JSON.stringify(input.watch) : null,
          ...(route.sourceId ? [route.sourceId] : []),
        ],
      )
    ).rows[0];
  }

  async function create(raw: unknown, provenance?: ScheduleProvenance, shared?: PoolClient) {
    const input = validateCreate(raw);
    await validateWatch(input.watch, input.kind);
    const created = await transaction(async (client) => {
      const source = await sourceProvenance(client, provenance);
      const route = await deliveryRoute(client, source);
      assertChange(provenance, input);
      const authorized = await authority(client, input, provenance);
      const existing = provenance && (await duplicate(client, input, route));
      if (existing) {
        const updated = input.model
          ? (
              await client.query<ScheduleRow>(
                `UPDATE schedules SET model=$3::jsonb WHERE id=$1 AND owner_id=$2 AND model IS DISTINCT FROM $3::jsonb RETURNING ${columns}`,
                [existing.id, ownerId, JSON.stringify(input.model)],
              )
            ).rows[0]
          : undefined;
        if (updated) modelChanged(client, 'agent', input.model ?? null);
        return { row: updated ?? existing, existing: true };
      }
      const saved = (
        await client.query<ScheduleRow>(
          `INSERT INTO schedules(id,owner_id,title,prompt,kind,cron,run_at,time_zone,delivery_channel,channel_source_id,authority,baseline_observation,watch,model)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${columns}`,
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
            authorized ? JSON.stringify(authorized) : null,
            input.baselineObservation
              ? JSON.stringify({ ...input.baselineObservation, checkedAt: now().toISOString() })
              : null,
            input.watch ? JSON.stringify(input.watch) : null,
            input.model ? JSON.stringify(input.model) : null,
          ],
        )
      ).rows[0]!;
      return { row: await enqueue(client, saved, nextOccurrence(saved)), existing: false };
    }, shared);
    const { row, existing } = created;
    if (existing) return { ...(await value(row)), existing };
    afterCommit(shared ?? pool, () => {
      refresh();
      dependencies.analytics?.({
        event: 'schedule_changed',
        properties: {
          operation: 'create',
          ...scheduleAnalytics(row),
          actor: provenance ? 'agent' : 'user',
        },
      });
    });
    return value(row, undefined, provenance?.turnId);
  }

  async function update(
    id: string,
    raw: unknown,
    provenance?: ScheduleProvenance,
    expectedRevision?: number,
    shared?: PoolClient,
  ) {
    z.uuid().parse(id);
    const input = updateSchema.parse(raw);
    if (!Object.keys(input).length) throw invalid('Choose a schedule detail to update.');
    if (input.watch) await validateWatch(input.watch, input.kind ?? (await read(id)).kind);
    const mutate = input.enabled === false ? retirementTransaction : transaction;
    const row = await mutate(async (client) => {
      const previous = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [id, ownerId],
        )
      ).rows[0];
      if (!previous) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      assertRevision(previous, provenance?.expectedRevision ?? expectedRevision);
      if (!previous.enabled && input.enabled === false && Object.keys(input).length === 1)
        return previous;
      const next = updateValue(previous, input);
      if (provenance) await sourceProvenance(client, provenance);
      assertChange(provenance, next);
      const fresh = await authority(client, input, provenance);
      const authorized =
        (!provenance && input.prompt !== undefined) ||
        provenance?.instructionChange?.replaceInstruction
          ? fresh
          : fresh
            ? mergeOwnerInstructions(previous.authority, fresh)
            : previous.authority;
      await cancelPending(client, previous);
      const saved = (
        await client.query<ScheduleRow>(
          `UPDATE schedules SET title=$3,prompt=$4,kind=$5,cron=$6,run_at=$7,time_zone=$8,
             enabled=$9,authority=$10::jsonb,
             baseline_observation=COALESCE($11::jsonb,baseline_observation),
             watch=CASE WHEN $12 THEN $13::jsonb ELSE watch END,skipped='[]'::jsonb,revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING ${columns}`,
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
            authorized ? JSON.stringify(authorized) : null,
            input.baselineObservation
              ? JSON.stringify({ ...input.baselineObservation, checkedAt: now().toISOString() })
              : null,
            'watch' in input,
            input.watch ? JSON.stringify(input.watch) : null,
          ],
        )
      ).rows[0]!;
      const timingChanged = ['kind', 'cron', 'runAt', 'timeZone', 'enabled'].some(
        (key) => key in input,
      );
      const updated = await enqueue(
        client,
        saved,
        !timingChanged && saved.enabled && previous.nextRun
          ? previous.nextRun
          : nextOccurrence(saved),
      );
      if (input.enabled === false)
        await dependencies.retireScheduleConfirmations?.(client, id, !shared);
      return updated;
    }, shared);
    afterCommit(shared ?? pool, () => {
      refresh();
      dependencies.analytics?.({
        event: 'schedule_changed',
        properties: {
          operation: 'update',
          ...scheduleAnalytics(row),
          actor: provenance ? 'agent' : 'user',
        },
      });
    });
    return value(row, undefined, provenance?.turnId);
  }

  async function setModel(
    id: string,
    model: ModelSelection | null,
    actor: 'owner' | 'agent',
    shared?: PoolClient,
  ) {
    z.uuid().parse(id);
    const choice = validateModel({ model }).model ?? null;
    const changed = await transaction(async (client) => {
      const { rowCount } = await client.query(
        'UPDATE schedules SET model=$3::jsonb WHERE id=$1 AND owner_id=$2 AND model IS DISTINCT FROM $3::jsonb',
        [id, ownerId, choice ? JSON.stringify(choice) : null],
      );
      if (!rowCount) await read(id, client);
      return Boolean(rowCount);
    }, shared);
    if (changed) modelChanged(shared ?? pool, actor, choice);
    return value(await read(id, shared));
  }

  function modelChanged(client: object, actor: 'owner' | 'agent', choice: ModelSelection | null) {
    afterCommit(client, () => {
      refresh();
      dependencies.analytics?.({
        event: 'setting_changed',
        properties: { setting: 'schedule_model', actor, state: choice ? 'configured' : 'default' },
      });
    });
  }

  async function remove(id: string) {
    z.uuid().parse(id);
    const row = await retirementTransaction(async (client) => {
      const row = (
        await client.query<ScheduleRow>(
          `SELECT ${columns} FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
          [id, ownerId],
        )
      ).rows[0];
      if (!row) throw Object.assign(new Error('Schedule not found.'), { statusCode: 404 });
      await cancelPending(client, row);
      await client.query('DELETE FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId]);
      await dependencies.retireScheduleConfirmations?.(client, id, true);
      return row;
    });
    refresh();
    dependencies.analytics?.({
      event: 'schedule_changed',
      properties: { operation: 'delete', ...scheduleAnalytics(row), actor: 'user' },
    });
    return { ok: true };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/schedules', list);
    app.post<{ Params: { id: string } }>('/api/schedules/:id/run', (request) =>
      runNow(request.params.id, request.body),
    );
    app.post<{ Params: { id: string; turnId: string } }>(
      '/api/schedules/:id/runs/:turnId/stop',
      (request) => stopRun(request.params.id, request.params.turnId),
    );
    app.post<{ Params: { id: string } }>('/api/schedules/:id/preview', async (request) => {
      const previous = await read(z.uuid().parse(request.params.id));
      const input = updateSchema
        .pick({ cron: true, runAt: true, timeZone: true })
        .parse(request.body);
      const next = updateValue(previous, input);
      validateTiming(next, false);
      if (next.kind === 'once' && next.runAt && new Date(next.runAt) <= now())
        return { nextRun: null };
      return {
        nextRun:
          nextOccurrence({
            ...previous,
            cron: next.cron,
            timeZone: next.timeZone,
            runAt: next.runAt ? new Date(next.runAt) : null,
            enabled: true,
          })?.toISOString() ?? null,
      };
    });
    app.post('/api/schedules', (request) => create(request.body));
    app.patch<{ Params: { id: string } }>('/api/schedules/:id', (request) => {
      const { expectedRevision, ...body } = updateSchema
        .extend({ expectedRevision: z.number().int().nonnegative().optional() })
        .parse(request.body);
      return update(request.params.id, body, undefined, expectedRevision);
    });
    app.put<{ Params: { id: string } }>('/api/schedules/:id/model', (request) => {
      const { model } = z
        .object({ model: modelSelectionInput.nullable() })
        .strict()
        .parse(request.body);
      return setModel(request.params.id, model, 'owner');
    });
    app.delete<{ Params: { id: string } }>('/api/schedules/:id', (request) =>
      remove(request.params.id),
    );
    app.get('/api/schedule-runs', (request) => history(request.query));
  }

  return {
    initialize,
    scheduleCache,
    list,
    get: async (id: string) => value(await read(id)),
    create,
    update,
    setModel,
    remove,
    history,
    registerRoutes,
    validateCreate,
    validateUpdate,
    prepareChange,
    recordObservation,
  };
}
