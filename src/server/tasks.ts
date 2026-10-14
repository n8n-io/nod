import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskStatus } from '../shared/contracts.ts';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import {
  boss,
  cancelPlannedChecks,
  endSessionApprovals,
  enqueueTurn,
  insertAssistantMessage,
  insertUserTurn,
  lockThread,
  withTurnLock,
  type TaskTarget,
  type TurnRef,
} from './thread.ts';
import { turnChain, untakenTurnSql } from './turn-chain.ts';
import { personalSecret } from './memory-tree.ts';
import { texts as codeTexts } from './chat-verification.ts';
import { answered } from './trust.ts';
import { appOnlyActions } from './approvals.ts';
import { isQuietTime, readPreferences } from './preferences.ts';
import { taskChanged } from './events.ts';
import type { WorkConsumers } from './work-admission.ts';

const credentialUrl = /(?<![\w/])(?:[a-z][a-z\d+.-]*:)?\/\/[^/\s?#<>]*@/iu;
const dispatchInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    ack: z.string().trim().max(200),
    brief: z.string().trim().min(1).max(4000),
    steps: z.array(z.string().trim().min(1).max(120)).min(2).max(8).optional(),
  })
  .strict();
const routeInput = z.object({ taskId: z.uuid() }).strict();
const waits = z
  .array(
    z
      .object({ who: z.string().trim().min(1).max(80), via: z.string().trim().min(1).max(40) })
      .strict(),
  )
  .min(1)
  .max(10);
const progressInput = z
  .object({
    steps: z.array(z.string().trim().min(1).max(120)).min(2).max(8).optional(),
    current: z.number().int().min(1).max(8).optional(),
    now: z.string().trim().max(200).optional(),
    waitingFor: waits.optional(),
    nextCheck: z.iso.datetime({ offset: true }).optional(),
    stop: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Give steps, current, now, waitingFor or stop.')
  .refine(
    (input) => !input.waitingFor === !input.nextCheck && !(input.nextCheck && input.stop),
    'Give waitingFor and nextCheck together, and never with stop.',
  );
const checkInInput = z.object({ text: z.string().trim().min(1).max(280) }).strict();
const minute = 60_000;
const maxChecks = 24;
const maxCheckIns = 3;
const checkPrompt =
  "Planned check. See whether the people this task waits for have answered, then continue the task. If they haven't, plan the next check with task_progress, or give the result when waiting no longer helps.";

type Row = {
  id: string;
  thread_id: string | null;
  title: string;
  on_it_message_id: string | null;
  steps: string[];
  step_index: number;
  now_text: string;
  result: string;
  result_message_id: string | null;
  artifact: Task['artifact'];
  approval_id: string | null;
  approval_message_id: string | null;
  turn_error: string | null;
  state: 'queued' | 'open' | 'waiting' | 'done' | 'stopped' | 'failed';
  waiting_for: Task['waitingFor'];
  next_check: Date | null;
  due: boolean | null;
  running: boolean;
  turn_status: string | null;
  turn_finished_at: Date | null;
  question: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
};

const latest: Record<string, TaskStatus> = {
  queued: 'queued',
  waiting: 'needs_you',
  failed: 'failed',
  cancelled: 'stopped',
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function status(row: Row): TaskStatus {
  if (row.state === 'done' || row.state === 'stopped' || row.state === 'failed') return row.state;
  if (row.running) return 'working';
  if (row.state === 'waiting') return row.due ? 'queued' : 'waiting';
  return latest[row.turn_status ?? ''] ?? (row.state === 'queued' ? 'queued' : 'working');
}

const ended = (value: TaskStatus) => value === 'failed' || value === 'stopped';
const retention = 'task-retention';
const forgettable = `t.state IN ('done','stopped','failed')
  AND (t.closed_at<now()-interval '30 days' OR th.archived_at IS NOT NULL)
  AND (t.forgotten_at IS NULL OR t.forgotten_at<t.closed_at)`;

export function createTasks(options: {
  pool: Pool;
  ownerId: string;
  refresh?: () => void;
  forgetSession?: (taskId: string, threadId: string | null) => Promise<void>;
}) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function rows(
    threadId: string | null,
    openOnly = false,
    taskId: string | null = null,
    messageIds: string[] | null = null,
  ) {
    return (
      await pool.query<Row>(
        `SELECT t.id,t.thread_id,t.title,t.on_it_message_id,t.steps,t.step_index,t.now_text,
           COALESCE(NULLIF(t.result,''),left(r.text,600),'') AS result,t.result_message_id,
           r.attachments->0 AS artifact,
           t.state,t.waiting_for,t.next_check,t.next_check<=now() AS due,t.created_at,t.updated_at,t.closed_at,l.status AS turn_status,
           l.finished_at AS turn_finished_at,l.error AS turn_error,EXISTS (SELECT 1 FROM turns w WHERE w.owner_id=t.owner_id
             AND w.session_id=t.id AND w.status='running') AS running,
           CASE WHEN l.status='waiting' THEN COALESCE(p.question,(SELECT left(m.text,600) FROM messages m
             WHERE m.owner_id=t.owner_id AND m.turn_id=l.id AND m.role='assistant' AND m.text<>''
             ORDER BY m.created_at DESC,m.id DESC LIMIT 1)) END AS question,
           p.id AS approval_id,p.message_id AS approval_message_id
         FROM tasks t
         LEFT JOIN messages r ON r.id=t.result_message_id AND r.owner_id=t.owner_id
         LEFT JOIN LATERAL (SELECT u.id,u.status,u.finished_at,u.error FROM turns u WHERE u.owner_id=t.owner_id AND u.session_id=t.id
           AND ${untakenTurnSql('u')} ORDER BY u.created_at DESC,u.id DESC LIMIT 1) l ON true
         LEFT JOIN LATERAL (SELECT a.id,a.confirmation_message_id AS message_id,left(c.text,600) AS question
           FROM approvals a JOIN messages c ON c.id=a.confirmation_message_id AND c.owner_id=a.owner_id
           WHERE l.status='waiting' AND a.owner_id=t.owner_id AND a.turn_id=l.id AND a.status='pending'
             AND a.expires_at>now() AND NOT EXISTS (SELECT 1 FROM approvals o WHERE o.owner_id=a.owner_id
               AND o.turn_id=a.turn_id AND o.status='pending' AND o.confirmation_message_id IS NOT NULL
               AND o.id<>a.id)) p ON true
         WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.thread_id=$2)
           AND (NOT $3::boolean OR t.state IN ('queued','open','waiting'))
           AND ($4::uuid IS NULL OR t.id=$4)
           AND ($5::uuid[] IS NULL OR t.on_it_message_id=ANY($5) OR t.result_message_id=ANY($5)
             OR t.state IN ('queued','open','waiting'))
         ORDER BY t.closed_at IS NULL DESC,COALESCE(t.closed_at,t.updated_at) DESC,t.id LIMIT 100`,
        [ownerId, threadId, openOnly, taskId, messageIds],
      )
    ).rows;
  }

  async function open(threadId: string) {
    return (await rows(threadId, true)).flatMap((row) => {
      const value = status(row);
      return ended(value) || !row.on_it_message_id
        ? []
        : [
            {
              taskId: row.id,
              title: row.title,
              status: value,
              onItMessageId: row.on_it_message_id,
            },
          ];
    });
  }

  function view(row: Row): Task {
    const value = status(row);
    return {
      id: row.id,
      threadId: row.thread_id,
      title: row.title,
      onItMessageId: row.on_it_message_id,
      steps: row.steps,
      stepIndex: row.step_index,
      now: row.now_text,
      result: row.result,
      resultMessageId: row.result_message_id,
      artifact: row.artifact ?? null,
      status: value,
      question: value === 'needs_you' ? row.question : null,
      approvalId: value === 'needs_you' ? row.approval_id : null,
      approvalMessageId: value === 'needs_you' ? row.approval_message_id : null,
      error: value === 'failed' ? row.turn_error : null,
      waitingFor: value === 'waiting' ? row.waiting_for : [],
      nextCheck: value === 'waiting' ? (row.next_check?.toISOString() ?? null) : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      closedAt:
        (row.closed_at ?? (ended(value) ? row.turn_finished_at : null))?.toISOString() ?? null,
    };
  }

  async function read(threadId?: string): Promise<Task[]> {
    return (await rows(threadId ?? null)).map(view);
  }

  async function channelMessages(messageIds: string[]) {
    const [tasks, confirmations] = await Promise.all([
      rows(null, false, null, messageIds),
      pool.query<{ id: string; messageId: string }>(
        `SELECT a.id,a.confirmation_message_id AS "messageId" FROM approvals a
         JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
         JOIN tasks t ON t.id=u.session_id AND t.owner_id=u.owner_id
         WHERE a.owner_id=$1 AND a.confirmation_message_id=ANY($2::uuid[]) AND a.status='pending'
           AND a.expires_at>now() AND a.action<>ALL($3::text[]) AND u.status IN ('running','waiting')
           AND NOT EXISTS (SELECT 1 FROM approvals o WHERE o.owner_id=a.owner_id AND o.turn_id=a.turn_id
             AND o.status='pending' AND o.confirmation_message_id IS NOT NULL AND o.id<>a.id)`,
        [ownerId, messageIds, appOnlyActions],
      ),
    ]);
    return { tasks: tasks.map(view), confirmations: confirmations.rows };
  }

  async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function dispatch(
    turn: TurnRef,
    raw: unknown,
    provenance: { sourceMessageId: string | null },
  ) {
    const request = dispatchInput.parse(raw);
    const started = await transaction(async (client) => {
      const thread = await lockThread(client, ownerId);
      const current = (
        await client.query<{ channel: string }>(
          `SELECT channel FROM turns WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND status='running'
             AND session_id=thread_id AND NOT background FOR NO KEY UPDATE`,
          [turn.turnId, ownerId, thread.id],
        )
      ).rows[0];
      if (!current) throw failure('Only a running chat turn can start a task.', 409);
      const { chain, origin, readOnly } = await turnChain(client, ownerId, turn);
      if (readOnly) throw failure('This turn can only read, so it cannot start a task.');
      const steered =
        provenance.sourceMessageId && provenance.sourceMessageId !== chain[0]?.message_id
          ? provenance.sourceMessageId
          : undefined;
      const source = (
        await client.query<{ id: string; text: string }>(
          `SELECT id,text FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'
             AND turn_id=$4`,
          steered
            ? [steered, ownerId, thread.id, turn.turnId]
            : origin?.source === 'user'
              ? [origin.message_id, ownerId, thread.id, origin.id]
              : [null, ownerId, thread.id, null],
        )
      ).rows[0];
      if (!source) throw failure('A task needs a direct request from the user.');
      const channelSourceId =
        current.channel === 'web'
          ? null
          : (
              await client.query<{ source_id: string }>(
                `SELECT source_id FROM channel_inbox
                 WHERE owner_id=$1 AND message_id=$2 AND channel=$3 AND state='submitted'`,
                [ownerId, provenance.sourceMessageId ?? source.id, current.channel],
              )
            ).rows[0]?.source_id;
      if (channelSourceId === undefined)
        throw failure('The task delivery conversation is unavailable.');
      const answeredText = await answered(client, ownerId, thread.id, thread.id, source.id);
      const id = randomUUID();
      const onItMessageId = await insertAssistantMessage(
        client,
        { threadId: thread.id, turnId: turn.turnId },
        request.ack || 'On it.',
        [],
        undefined,
        source.id,
      );
      await client.query(
        `INSERT INTO tasks(id,owner_id,thread_id,title,instruction,answered_text,source_message_id,
           on_it_message_id,channel,channel_source_id,steps,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued')`,
        [
          id,
          ownerId,
          thread.id,
          request.title,
          source.text,
          answeredText ?? null,
          source.id,
          onItMessageId,
          current.channel,
          channelSourceId,
          JSON.stringify(request.steps ?? []),
        ],
      );
      await enqueueTurn(request.brief, {
        source: 'task',
        sourceId: `task:${id}`,
        background: true,
        sessionId: id,
        channel: current.channel,
        channelSourceId,
        client,
      });
      return { taskId: id, onItMessageId };
    });
    refresh();
    return started;
  }

  async function route(
    turn: TurnRef,
    raw: unknown,
    provenance: { sourceMessageId: string | null },
  ) {
    const { taskId } = routeInput.parse(raw);
    await transaction(async (client) => {
      const thread = await lockThread(client, ownerId);
      const current = await client.query(
        `SELECT 1 FROM turns WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND status='running'
           AND session_id=thread_id AND NOT background FOR NO KEY UPDATE`,
        [turn.turnId, ownerId, thread.id],
      );
      if (!current.rowCount) throw failure('Only a running chat turn can route a message.', 409);
      if ((await turnChain(client, ownerId, turn)).readOnly)
        throw failure('This turn can only read, so it cannot route a message to a task.');
      const message = (
        await client.query<{ id: string; text: string }>(
          `SELECT id,text FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'
             AND turn_id=$4`,
          [provenance.sourceMessageId, ownerId, thread.id, turn.turnId],
        )
      ).rows[0];
      if (!message) throw failure("Only the user's current message can go to a task.");
      const task = (
        await client.query<TaskTarget>(
          `SELECT id,channel,channel_source_id FROM tasks
           WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND on_it_message_id IS NOT NULL
           FOR NO KEY UPDATE`,
          [taskId, ownerId, thread.id],
        )
      ).rows[0];
      if (!task) throw failure('Task not found.', 404);
      const confirming = await client.query(
        `SELECT 1 FROM approvals a JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
         WHERE a.owner_id=$1 AND a.status='pending' AND a.expires_at>now() AND u.session_id=$2 LIMIT 1`,
        [ownerId, task.id],
      );
      if (confirming.rowCount)
        throw failure(
          'This task waits for the user to answer its confirmation. Ask them to reply to that confirmation instead.',
          409,
        );
      const routed = await insertUserTurn(
        client,
        thread.id,
        { messageId: message.id, prompt: message.text, channel: 'web' },
        task,
      );
      await client.query('UPDATE messages SET turn_id=$1 WHERE id=$2 AND owner_id=$3', [
        routed,
        message.id,
        ownerId,
      ]);
    });
    refresh();
    return 'The message is with the task now. The task answers it, so write nothing more about it.';
  }

  async function progress(turn: TurnRef, raw: unknown) {
    const input = progressInput.parse(raw);
    const check = input.nextCheck ? new Date(input.nextCheck) : undefined;
    const lead = check ? check.getTime() - Date.now() : 0;
    if (check && (lead < 15 * minute || lead > 30 * 1440 * minute))
      throw failure('nextCheck must be 15 minutes to 30 days from now.');
    const result = await withTurnLock(
      turn.turnId,
      async (client) => {
        const task = (
          await client.query<{
            id: string;
            steps: string[];
            step_index: number;
            on_it: string;
            channel: string | null;
            channel_source_id: string | null;
          }>(
            `SELECT t.id,t.steps,t.step_index,t.on_it_message_id AS on_it,t.channel,t.channel_source_id FROM turns u
           JOIN tasks t ON t.id=u.session_id AND t.owner_id=u.owner_id AND t.thread_id=u.thread_id
           WHERE u.id=$1 AND u.owner_id=$2 AND t.state='open' FOR NO KEY UPDATE OF t`,
            [turn.turnId, ownerId],
          )
        ).rows[0];
        if (!task) throw failure('Only an open task can change its progress.', 409);
        const steps = input.steps ?? task.steps;
        if (input.current !== undefined && input.current > steps.length)
          throw failure(
            steps.length
              ? `current must be a step number from 1 to ${steps.length}.`
              : 'Set steps before current.',
          );
        if (
          check &&
          (
            await client.query<{ checks: number }>(
              `SELECT count(*)::int AS checks FROM turns q WHERE q.owner_id=$1 AND q.session_id=$2
                 AND q.not_before IS NOT NULL AND q.started_at IS NOT NULL
                 AND q.created_at>COALESCE((SELECT max(r.created_at) FROM turns r
                   WHERE r.owner_id=$1 AND r.session_id=$2 AND r.source='user'),'-infinity')`,
              [ownerId, task.id],
            )
          ).rows[0]!.checks >= maxChecks
        )
          throw failure(
            `This task ran ${maxChecks} planned checks since the user last wrote to it. Give the result now.`,
            409,
          );
        await client.query(
          `UPDATE tasks SET steps=$2,step_index=$3,now_text=COALESCE($4,now_text),
           state=CASE WHEN $5 THEN 'stopped' WHEN $7::timestamptz IS NOT NULL THEN 'waiting' ELSE state END,
           waiting_for=COALESCE($8::jsonb,waiting_for),next_check=COALESCE($7,next_check),
           closed_at=CASE WHEN $5 THEN now() ELSE closed_at END,updated_at=now()
         WHERE id=$1 AND owner_id=$6`,
          [
            task.id,
            JSON.stringify(steps),
            input.current === undefined
              ? Math.max(0, Math.min(task.step_index, steps.length - 1))
              : input.current - 1,
            input.now ?? null,
            input.stop !== undefined,
            ownerId,
            check ?? null,
            input.waitingFor ? JSON.stringify(input.waitingFor) : null,
          ],
        );
        if (check) {
          await cancelPlannedChecks(client, [task.id]);
          await enqueueTurn(checkPrompt, {
            source: 'task',
            sourceId: `task-check:${task.id}:${check.toISOString()}`,
            background: true,
            sessionId: task.id,
            channel: task.channel ?? undefined,
            channelSourceId: task.channel_source_id,
            notBefore: check,
            client,
          });
          return 'The task waits now. It continues in this session at nextCheck, or sooner when the user replies to it. End now without a final message.';
        }
        if (input.stop === undefined) return { saved: task.id };
        await endSessionApprovals(client, [task.id], 'declined');
        await insertAssistantMessage(client, turn, input.stop, [], undefined, task.on_it);
        return 'The task is stopped. End now without a final message.';
      },
      check !== undefined,
    );
    if (typeof result === 'string') {
      refresh();
      return result;
    }
    const [saved] = await rows(null, false, result.saved).catch(() => []);
    if (saved?.thread_id) taskChanged({ ownerId, threadId: saved.thread_id, task: view(saved) });
    else refresh();
    return 'Progress saved.';
  }

  async function checkIn(turn: TurnRef, raw: unknown) {
    const { text } = checkInInput.parse(raw);
    const result = await withTurnLock(turn.turnId, async (client) => {
      const task = (
        await client.query<{
          id: string;
          on_it: string;
          check_ins: number;
          recent: boolean;
          read_only: boolean;
        }>(
          `SELECT t.id,t.on_it_message_id AS on_it,t.check_ins,t.read_only,
             COALESCE(t.last_check_in_at>now()-interval '2 minutes',false) AS recent FROM turns u
           JOIN tasks t ON t.id=u.session_id AND t.owner_id=u.owner_id AND t.thread_id=u.thread_id
           WHERE u.id=$1 AND u.owner_id=$2 AND t.state='open' FOR NO KEY UPDATE OF t`,
          [turn.turnId, ownerId],
        )
      ).rows[0];
      if (!task) throw failure('Only an open task can check in.', 409);
      const preferences = await readPreferences(client, ownerId);
      const [reason, note] =
        task.read_only || (await turnChain(client, ownerId, turn)).readOnly
          ? ['read_only', 'This turn can only read, so it sends no check-ins.']
          : preferences.progressMode === 'quiet'
            ? ['quiet_mode', 'The user turned check-ins off. Send no more in this run.']
            : task.check_ins >= maxCheckIns
              ? ['limit', `This task sent ${maxCheckIns} check-ins in this run. Send no more.`]
              : task.recent
                ? ['too_soon', 'The last check-in was less than 2 minutes ago.']
                : isQuietTime(preferences)
                  ? ['quiet_hours', "It's the user's quiet hours."]
                  : [];
      if (reason)
        return {
          status: 'skipped',
          reason,
          message: `${note} Nothing was sent. Carry on with the task.`,
        };
      await insertAssistantMessage(client, turn, text, [], undefined, task.on_it);
      await client.query(
        'UPDATE tasks SET check_ins=check_ins+1,last_check_in_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2',
        [task.id, ownerId],
      );
      return 'Check-in sent.';
    });
    if (typeof result === 'string') refresh();
    return result;
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, now_text text NOT NULL DEFAULT '',
        state text NOT NULL DEFAULT 'open'
          CONSTRAINT tasks_state_check CHECK (state IN ('queued','open','waiting','done','stopped','failed')),
        result text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES threads(id),
        ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id),
        ADD COLUMN IF NOT EXISTS instruction text,
        ADD COLUMN IF NOT EXISTS answered_text text,
        ADD COLUMN IF NOT EXISTS on_it_message_id uuid REFERENCES messages(id),
        ADD COLUMN IF NOT EXISTS channel text,
        ADD COLUMN IF NOT EXISTS channel_source_id text,
        ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS check_ins integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_check_in_at timestamptz,
        ADD COLUMN IF NOT EXISTS result_message_id uuid REFERENCES messages(id),
        ADD COLUMN IF NOT EXISTS forgotten_at timestamptz;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass
          AND attname IN ('auto','done_when') AND NOT attisdropped) THEN
          ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
          UPDATE tasks SET state='stopped' WHERE state='cancelled';
          UPDATE tasks SET state='stopped',closed_at=now(),updated_at=now()
            WHERE state='open' AND on_it_message_id IS NULL;
          ALTER TABLE tasks DROP COLUMN IF EXISTS auto, DROP COLUMN IF EXISTS turn_id,
            DROP COLUMN IF EXISTS done_when, DROP COLUMN IF EXISTS waiting_for,
            DROP COLUMN IF EXISTS next_check, ALTER COLUMN now_text SET DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='tasks'::regclass
          AND conname='tasks_state_check' AND pg_get_constraintdef(oid) LIKE '%''waiting''%') THEN
          ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check,
            ADD CONSTRAINT tasks_state_check
              CHECK (state IN ('queued','open','waiting','done','stopped','failed'));
        END IF;
      END $$;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS waiting_for jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS next_check timestamptz;
      ALTER TABLE turns DROP COLUMN IF EXISTS task_id;
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id,state,updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_on_it ON tasks(on_it_message_id);
    `);
  }

  async function scheduleDraft(id: string) {
    z.uuid().parse(id);
    const task = (
      await pool.query<{ title: string; instruction: string | null; has_attachments: boolean }>(
        `SELECT t.title,t.instruction,COALESCE(jsonb_array_length(s.attachments)>0,false) AS has_attachments
         FROM tasks t LEFT JOIN messages s ON s.id=t.source_message_id AND s.owner_id=t.owner_id
         WHERE t.id=$1 AND t.owner_id=$2 AND t.state='done' AND t.on_it_message_id IS NOT NULL`,
        [id, ownerId],
      )
    ).rows[0];
    if (!task) throw Object.assign(new Error('Completed task not found.'), { statusCode: 404 });
    const replies = (
      await pool.query<{ text: string; has_attachments: boolean }>(
        `SELECT m.text,jsonb_array_length(m.attachments)>0 AS has_attachments
         FROM messages m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
         WHERE u.session_id=$1 AND u.owner_id=$2 AND m.role='user'
           AND (u.source='user' OR m.id IS DISTINCT FROM u.message_id)
         ORDER BY m.created_at,m.id`,
        [id, ownerId],
      )
    ).rows;
    const messages = [
      ...(task.instruction === null
        ? []
        : [{ text: task.instruction, has_attachments: task.has_attachments }]),
      ...replies,
    ];
    const placeholders = new Set(
      Object.values(codeTexts).flatMap((text) => [text.masked, text.pending]),
    );
    const requests = messages.filter(
      (message) =>
        !placeholders.has(message.text) &&
        !personalSecret.test(message.text) &&
        !credentialUrl.test(message.text) &&
        classifyVerificationReply(message.text).kind === 'ordinary',
    );
    return {
      title: task.title,
      prompt: requests.map((message) => message.text).join('\n\n'),
      omittedSensitive: requests.length !== messages.length,
      hasAttachments: messages.some((message) => message.has_attachments),
    };
  }

  async function forget(ids: string[]) {
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        await transaction(async (client) => {
          const closed = (
            await client.query<{ thread_id: string | null }>(
              `SELECT t.thread_id FROM tasks t LEFT JOIN threads th ON th.id=t.thread_id AND th.owner_id=t.owner_id
               WHERE t.id=$1 AND t.owner_id=$2 AND ${forgettable} FOR NO KEY UPDATE OF t`,
              [id, ownerId],
            )
          ).rows[0];
          if (!closed) return;
          await options.forgetSession?.(id, closed.thread_id);
          await client.query('UPDATE tasks SET forgotten_at=now() WHERE id=$1 AND owner_id=$2', [
            id,
            ownerId,
          ]);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  async function expire() {
    const expired = await pool.query<{ id: string }>(
      `SELECT t.id FROM tasks t LEFT JOIN threads th ON th.id=t.thread_id AND th.owner_id=t.owner_id
       WHERE t.owner_id=$1 AND ${forgettable} ORDER BY t.closed_at,t.id`,
      [ownerId],
    );
    await forget(expired.rows.map((row) => row.id));
  }

  async function startRetention(consumers?: WorkConsumers) {
    await boss.createQueue(retention, { retryLimit: 0 });
    await boss.schedule(retention, '17 * * * *', {}, { tz: 'UTC' });
    const start = () =>
      boss.work(retention, () =>
        expire().catch(() =>
          console.error('Old task sessions could not be deleted. The next run tries again.'),
        ),
      );
    if (consumers)
      await consumers.register({
        start,
        stop: (id) => boss.offWork(retention, { id, wait: true }),
      });
    else await start();
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/tasks', () => read());
    app.get<{ Params: { id: string } }>('/api/tasks/:id/schedule-draft', (request) =>
      scheduleDraft(request.params.id),
    );
  }

  return {
    initialize,
    dispatch,
    route,
    progress,
    checkIn,
    open,
    read,
    channelMessages,
    forget,
    expire,
    startRetention,
    registerRoutes,
  };
}
