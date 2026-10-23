import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskDetail, TaskStatus } from '../shared/contracts.ts';
import { actionTitle, toolTitle } from './action-presentation.ts';
import type { ChannelPresentation } from './channels.ts';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import {
  abortTurns,
  cancelTurns,
  enqueueTurn,
  insertAssistantMessage,
  lockThread,
  withTurnLock,
  type TurnRef,
} from './thread.ts';
import { transaction } from './transaction.ts';
import { personalSecret } from './memory-tree.ts';
import { texts as codeTexts } from './chat-verification.ts';

const now = z.string().trim().min(1);
const waits = z.array(
  z.object({ who: z.string().trim().min(1), via: z.string().trim().min(1) }).strict(),
);
const nextCheck = z.iso.datetime({ offset: true });
const credentialUrl = /(?<![\w/])(?:[a-z][a-z\d+.-]*:)?\/\/[^/\s?#<>]*@/iu;
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('reply'), ids: z.array(z.uuid()).min(1) }).strict(),
  z.object({ action: z.literal('stop'), id: z.uuid().optional() }).strict(),
  z
    .object({
      action: z.literal('start'),
      title: z.string().trim().min(1),
      message: z.string().trim().min(1),
      doneWhen: z.string().trim().min(1),
      now,
      brief: z.string().trim().min(1).optional(),
      steps: z.array(now).optional(),
      waitingFor: waits.optional(),
      nextCheck: nextCheck.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      id: z.uuid(),
      now: now.optional(),
      steps: z.array(now).optional(),
      stepIndex: z.number().int().nonnegative().optional(),
      waitingFor: waits.optional(),
      nextCheck: nextCheck.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      id: z.uuid(),
      status: z.enum(['done', 'cancelled']),
      result: z.string().trim().min(1),
    })
    .strict(),
]);
type Row = {
  id: string;
  message_id: string | null;
  steps: string[];
  step_index: number;
  revision: number;
  applied_revision: number;
  title: string;
  done_when: string;
  now_text: string;
  result: string;
  state: 'open' | 'done' | 'cancelled';
  waiting_for: Task['waitingFor'];
  next_check: Date | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  turn_status: string | null;
  answered: boolean;
  question: string | null;
  question_message_id: string | null;
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function status(row: Row): TaskStatus {
  if (row.state !== 'open') return row.state;
  if (row.turn_status === 'queued') return 'queued';
  if (row.turn_status === 'running') return 'working';
  if (row.turn_status === 'failed') return 'failed';
  if (['waiting', 'failed', 'cancelled'].includes(row.turn_status ?? '') && !row.answered)
    return 'needs_you';
  if (row.waiting_for.length) return 'waiting';
  if (row.next_check && row.next_check.getTime() > Date.now()) return 'scheduled';
  return 'stalled';
}

function taskFacts(task: Task, detail: boolean) {
  const index = task.stepIndex ?? 0;
  return {
    title: task.title,
    status: task.status,
    now: task.now,
    ...(task.question ? { question: task.question } : {}),
    ...(task.result ? { result: task.result } : {}),
    ...(detail
      ? {
          doneWhen: task.doneWhen,
          ...(task.steps?.length ? { steps: task.steps, stepIndex: index } : {}),
        }
      : task.steps?.[index]
        ? { step: task.steps[index], stepNumber: index + 1, stepCount: task.steps.length }
        : {}),
    ...(task.waitingFor.length ? { waitingFor: task.waitingFor } : {}),
    ...(task.nextCheck ? { nextCheck: task.nextCheck } : {}),
  };
}

export function createTasks(options: {
  pool: Pool;
  ownerId: string;
  refresh?: () => void;
  clearBrowser?: (id: string) => Promise<void>;
}) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function read(
    client: Pick<PoolClient, 'query'>,
    filter: { id?: string; closed?: boolean; thread?: string } = {},
  ): Promise<Task[]> {
    const rows = (
      await client.query<Row>(
        `SELECT t.id,t.title,t.done_when,t.now_text,t.result,t.state,t.waiting_for,t.next_check,
           t.message_id,t.steps,t.step_index,t.revision,t.applied_revision,
           t.created_at,t.updated_at,t.closed_at,COALESCE((SELECT r.status FROM turns r WHERE r.owner_id=t.owner_id AND r.session_id=t.session_id AND r.status='running'),u.status) AS turn_status,
           EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.thread_id=u.thread_id
             AND n.session_id=u.session_id AND n.parent_turn_id=u.id) AS answered,
           q.text AS question,q.id AS question_message_id
         FROM tasks t LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         LEFT JOIN LATERAL (SELECT m.id,m.text FROM messages m
           WHERE u.status='waiting' AND m.owner_id=u.owner_id AND m.turn_id=u.id AND m.role='assistant' AND m.text<>''
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1) q ON true
         WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.id=$2) AND ($3 OR t.state='open')
           AND ($4::uuid IS NULL OR u.thread_id=$4)
         ORDER BY t.state='open' DESC,COALESCE(t.closed_at,t.updated_at) DESC,t.id LIMIT 100`,
        [ownerId, filter.id ?? null, filter.closed ?? false, filter.thread ?? null],
      )
    ).rows;
    return rows.map((row) => {
      const value = status(row);
      const open = row.state === 'open';
      return {
        id: row.id,
        messageId: row.message_id,
        steps: row.steps,
        stepIndex: row.step_index,
        revision: row.revision,
        appliedRevision: row.applied_revision,
        title: row.title,
        doneWhen: row.done_when,
        now: row.now_text,
        result: row.result,
        status: value,
        question: value === 'needs_you' ? row.question : null,
        questionMessageId: value === 'needs_you' ? row.question_message_id : null,
        waitingFor: open ? row.waiting_for : [],
        nextCheck:
          open && row.next_check && row.next_check.getTime() > Date.now()
            ? row.next_check.toISOString()
            : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        closedAt: row.closed_at?.toISOString() ?? null,
      };
    });
  }

  async function link(client: Pick<PoolClient, 'query'>, turnId: string, taskId: string) {
    await client.query('UPDATE turns SET task_id=$1 WHERE id=$2 AND owner_id=$3', [
      taskId,
      turnId,
      ownerId,
    ]);
    await client.query(
      `UPDATE tasks t SET turn_id=$2 WHERE t.id=$1 AND t.owner_id=$3
         AND NOT EXISTS(SELECT 1 FROM turns c JOIN turns u ON u.id=$2
           WHERE c.id=t.turn_id AND (c.created_at,c.id)>(u.created_at,u.id))`,
      [taskId, turnId, ownerId],
    );
  }

  async function resolveReply(client: PoolClient, threadId: string, messageId: string) {
    const row = (
      await client.query(
        `SELECT t.id AS task_id,t.turn_id AS id,t.session_id,true AS background FROM tasks t
       JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
       JOIN messages m ON m.owner_id=t.owner_id AND m.thread_id=u.thread_id
       LEFT JOIN turns mt ON mt.id=m.turn_id AND mt.owner_id=m.owner_id
       LEFT JOIN messages parent ON parent.id=m.reply_to_message_id AND parent.owner_id=m.owner_id AND parent.thread_id=m.thread_id
       LEFT JOIN turns pt ON pt.id=parent.turn_id AND pt.owner_id=parent.owner_id
       WHERE t.owner_id=$1 AND u.thread_id=$2 AND m.id=$3
         AND (t.message_id=m.id OR mt.task_id=t.id OR m.reply_to_message_id=t.message_id OR pt.task_id=t.id) ORDER BY t.updated_at DESC LIMIT 1`,
        [ownerId, threadId, messageId],
      )
    ).rows[0];
    return row
      ? { ...row, record: (turnId: string) => recordInput(client, row.task_id, turnId) }
      : undefined;
  }

  async function recordInput(client: PoolClient, id: string, turnId: string) {
    const task = (
      await client.query(
        "UPDATE tasks SET revision=revision+1,state='open',closed_at=NULL,turn_id=$3,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision,session_id",
        [id, ownerId, turnId],
      )
    ).rows[0];
    await client.query('UPDATE turns SET task_id=$1,task_revision=$2 WHERE id=$3 AND owner_id=$4', [
      id,
      task.revision,
      turnId,
      ownerId,
    ]);
    await client.query(
      "UPDATE turns SET status='cancelled',finished_at=now() WHERE session_id=$1 AND owner_id=$2 AND status='waiting' AND id<>$3",
      [task.session_id, ownerId, turnId],
    );
  }

  async function deliver(
    client: PoolClient,
    taskId: string,
    sourceMessageId: string,
    parentTurnId: string,
  ) {
    const task = (
      await client.query(
        `SELECT t.*,u.thread_id,u.channel,u.channel_source_id FROM tasks t
       JOIN turns u ON u.id=$3 AND u.owner_id=t.owner_id
       JOIN turns first ON first.id=t.turn_id AND first.thread_id=u.thread_id
       WHERE t.id=$1 AND t.owner_id=$2 FOR NO KEY UPDATE OF t`,
        [taskId, ownerId, parentTurnId],
      )
    ).rows[0];
    if (!task) throw failure('Task not found.', 404);
    if (task.state !== 'open')
      throw failure(
        'That task is closed. The owner can reopen it by replying to one of its messages; otherwise start a new task.',
      );
    const message = (
      await client.query(
        "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'",
        [sourceMessageId, ownerId, task.thread_id],
      )
    ).rows[0];
    if (!message) throw failure('A task update needs an owner message.');
    const turnId = await enqueueTurn(message.text, {
      source: 'task',
      sessionId: task.session_id,
      parentTurnId,
      background: true,
      channel: task.channel,
      channelSourceId: task.channel_source_id,
      client,
    });
    await client.query('UPDATE turns SET message_id=$1 WHERE id=$2', [sourceMessageId, turnId]);
    await recordInput(client, taskId, turnId);
  }

  async function stop(client: PoolClient, id: string, threadId: string) {
    const task = (
      await client.query(
        `SELECT t.session_id FROM tasks t JOIN turns u ON u.id=t.turn_id
       WHERE t.id=$1 AND t.owner_id=$2 AND u.thread_id=$3 FOR NO KEY UPDATE OF t`,
        [id, ownerId, threadId],
      )
    ).rows[0];
    if (!task) throw failure('Task not found.', 404);
    const cancelled = await cancelTurns(client, threadId, { sessionId: task.session_id });
    await client.query(
      "UPDATE tasks SET state='cancelled',closed_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 AND state='open'",
      [id, ownerId],
    );
    return cancelled;
  }

  async function act(
    client: PoolClient,
    turn: TurnRef,
    raw: unknown,
    sourceMessageId?: string | null,
  ) {
    const request = input.parse(raw);
    if (request.action === 'list') return { tasks: await read(client) };
    const current = (
      await client.query('SELECT * FROM turns WHERE id=$1 AND owner_id=$2', [turn.turnId, ownerId])
    ).rows[0];
    if (request.action === 'reply') {
      if (current.task_id || current.session_id !== turn.threadId || !sourceMessageId)
        throw failure('Only the main chat can send owner updates to tasks.');
      for (const id of new Set(request.ids))
        await deliver(client, id, sourceMessageId, turn.turnId);
      return { tasks: await read(client) };
    }
    if (request.action === 'stop') {
      if (current.task_id) throw failure('Use finish to close your own task.');
      if (current.session_id !== turn.threadId || !sourceMessageId)
        throw failure('Only the main chat can stop tasks.');
      if (!request.id) {
        const cancelled = await cancelTurns(client, turn.threadId, { background: true });
        const sessions = new Set(cancelled.tasks.map((task) => task.sessionId));
        const tasks = cancelled.tasks.map((task) => task.title);
        const otherRuns = cancelled.browsers.filter((id) => !sessions.has(id)).length;
        return { stopped: { tasks, otherRuns }, cancelled };
      }
      const cancelled = await stop(client, request.id, turn.threadId);
      return { task: (await read(client, { id: request.id, closed: true }))[0], cancelled };
    }
    let id: string;
    if (request.action === 'start') {
      if (current.task_id) throw failure('This session already has a task. Use update.');
      id = randomUUID();
      const independent = current.session_id === turn.threadId;
      if (independent && !sourceMessageId) throw failure('A new task needs an owner request.');
      const messageId = await insertAssistantMessage(client, turn, request.message);
      const sessionId = independent ? id : current.session_id;
      await client.query(
        `INSERT INTO tasks(id,owner_id,turn_id,session_id,source_message_id,message_id,title,done_when,brief,now_text,steps,waiting_for,next_check,applied_revision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          ownerId,
          turn.turnId,
          sessionId,
          sourceMessageId ?? current.message_id,
          messageId,
          request.title,
          request.doneWhen,
          request.brief ?? request.doneWhen,
          request.now,
          JSON.stringify(request.steps ?? []),
          JSON.stringify(request.waitingFor ?? []),
          request.nextCheck ?? null,
          independent ? 0 : 1,
        ],
      );
      if (independent) {
        const source = (
          await client.query(
            "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND role='user'",
            [sourceMessageId, ownerId],
          )
        ).rows[0];
        if (!source) throw failure('Owner request not found.');
        const child = await enqueueTurn(source.text, {
          source: 'task',
          sessionId: id,
          parentTurnId: turn.turnId,
          channel: current.channel,
          channelSourceId: current.channel_source_id,
          background: true,
          client,
        });
        await client.query('UPDATE turns SET message_id=$1,task_revision=1 WHERE id=$2', [
          sourceMessageId,
          child,
        ]);
        await link(client, child, id);
      } else await link(client, turn.turnId, id);
    } else {
      id = request.id;
      if (current.task_id !== id)
        throw failure('Only the task session can change its progress or result.');
      const updated =
        request.action === 'update'
          ? await client.query(
              `UPDATE tasks SET now_text=COALESCE($3,now_text),steps=COALESCE($4,steps),step_index=COALESCE($5,step_index),
           waiting_for=COALESCE($6,waiting_for),next_check=COALESCE($7,next_check),updated_at=now()
           WHERE id=$1 AND owner_id=$2 AND state='open'
             AND COALESCE($5,step_index)<GREATEST(jsonb_array_length(COALESCE($4,steps)),1)`,
              [
                id,
                ownerId,
                request.now ?? null,
                request.steps ? JSON.stringify(request.steps) : null,
                request.stepIndex ?? null,
                request.waitingFor ? JSON.stringify(request.waitingFor) : null,
                request.nextCheck ?? null,
              ],
            )
          : await client.query(
              `UPDATE tasks SET state=$3,result=$4,closed_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2 AND state='open'
           AND applied_revision=revision`,
              [id, ownerId, request.status, request.result],
            );
      if (!updated.rowCount)
        throw failure(
          'The task is closed, its step index is out of range, or it has an owner update to read.',
        );
    }
    return (await read(client, { id, closed: true }))[0];
  }

  async function inherit(turn: TurnRef) {
    await withTurnLock(turn.turnId, async (client) => {
      const parent = (
        await client.query(
          `SELECT t.id FROM turns u JOIN tasks t ON t.session_id=u.session_id AND t.owner_id=u.owner_id
         WHERE u.id=$1 AND u.owner_id=$2 AND u.task_id IS NULL ORDER BY t.created_at DESC LIMIT 1`,
          [turn.turnId, ownerId],
        )
      ).rows[0];
      if (parent) await link(client, turn.turnId, parent.id);
      await client.query(
        `UPDATE turns p SET status='cancelled',finished_at=now() FROM turns u
         WHERE u.id=$1 AND u.owner_id=$2 AND u.task_id IS NOT NULL AND u.source IN ('user','task')
           AND p.owner_id=u.owner_id AND p.session_id=u.session_id AND p.id<>u.id AND p.status='waiting'`,
        [turn.turnId, ownerId],
      );
      await client.query(
        `UPDATE tasks t SET applied_revision=GREATEST(t.applied_revision,u.task_revision) FROM turns u
         WHERE u.id=$1 AND u.task_id=t.id AND t.owner_id=$2`,
        [turn.turnId, ownerId],
      );
    });
    refresh();
  }

  async function context(turn: TurnRef) {
    const row = (
      await pool.query(
        `SELECT t.* FROM tasks t JOIN turns u ON u.task_id=t.id AND u.owner_id=t.owner_id WHERE u.id=$1 AND t.owner_id=$2`,
        [turn.turnId, ownerId],
      )
    ).rows[0];
    if (!row) return;
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      doneWhen: row.done_when,
      revision: row.revision,
      messageId: row.message_id,
    };
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY, owner_id text NOT NULL, turn_id uuid REFERENCES turns(id),
        title text NOT NULL, done_when text NOT NULL, now_text text NOT NULL,
        waiting_for jsonb NOT NULL DEFAULT '[]', next_check timestamptz,
        state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','cancelled')),
        result text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
      );
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
          AND table_name='tasks' AND column_name='auto') THEN
          UPDATE turns SET task_id=NULL WHERE task_id IN (SELECT t.id FROM tasks t WHERE t.auto AND t.state<>'open'
            AND NOT EXISTS (SELECT 1 FROM turns x WHERE x.task_id=t.id AND x.source='user'));
          DELETE FROM tasks t WHERE t.auto AND t.state<>'open'
            AND NOT EXISTS (SELECT 1 FROM turns x WHERE x.task_id=t.id AND x.source='user');
          ALTER TABLE tasks DROP COLUMN auto;
        END IF;
      END $$;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS session_id uuid;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES messages(id);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS brief text NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS applied_revision integer NOT NULL DEFAULT 0;
      UPDATE tasks t SET session_id=CASE WHEN u.session_id=u.thread_id THEN t.id ELSE u.session_id END,source_message_id=u.message_id FROM turns u WHERE u.id=t.turn_id AND t.session_id IS NULL;
      ALTER TABLE turns ADD COLUMN IF NOT EXISTS task_revision integer NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS tasks_session ON tasks(owner_id,session_id);
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id,state,updated_at DESC);
      ALTER TABLE turns ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES tasks(id);
      CREATE INDEX IF NOT EXISTS turns_task ON turns(task_id) WHERE task_id IS NOT NULL;
    `);
  }

  async function scheduleDraft(id: string) {
    z.uuid().parse(id);
    const task = (
      await pool.query<{ title: string }>(
        "SELECT title FROM tasks WHERE id=$1 AND owner_id=$2 AND state='done'",
        [id, ownerId],
      )
    ).rows[0];
    if (!task) throw Object.assign(new Error('Completed task not found.'), { statusCode: 404 });
    const messages = (
      await pool.query<{ text: string; has_attachments: boolean }>(
        `SELECT DISTINCT m.id,m.created_at,m.text,jsonb_array_length(m.attachments)>0 AS has_attachments
         FROM messages m JOIN tasks t ON t.id=$1 AND t.owner_id=m.owner_id
         WHERE m.owner_id=$2 AND m.role='user' AND (m.id=t.source_message_id OR m.id IN
           (SELECT u.message_id FROM turns u WHERE u.task_id=t.id AND u.owner_id=t.owner_id) OR m.turn_id IN
           (SELECT u.id FROM turns u WHERE u.task_id=t.id AND u.owner_id=t.owner_id))
         ORDER BY m.created_at,m.id`,
        [id, ownerId],
      )
    ).rows;
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

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/tasks', () => read(pool, { closed: true }));
    app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const task = (await read(pool, { id, closed: true }))[0];
      if (!task) throw failure('Task not found.', 404);
      const events = (
        await pool.query<TaskDetail['events'][number]>(
          `SELECT e.id,e.type,e.summary,e.site,e.run_id AS "runId",e.parent_run_id AS "parentRunId",e.created_at AS "createdAt"
         FROM turn_events e JOIN turns u ON u.id=e.turn_id
         WHERE u.task_id=$1 AND u.owner_id=$2 AND e.type IN ('step','tool_complete','tool_failed')
           AND NOT (e.type='tool_complete' AND e.summary='apps')
         UNION ALL
         SELECT a.id,'action',a.action,NULL,NULL,NULL,a.created_at
         FROM app_actions a JOIN turns u ON u.id=a.turn_id
         WHERE u.task_id=$1 AND u.owner_id=$2 AND a.owner_id=$2
         UNION ALL
         SELECT m.id,'message',m.text,NULL,NULL,NULL,m.created_at
         FROM messages m JOIN turns u ON u.id=m.turn_id
         WHERE u.task_id=$1 AND u.owner_id=$2 AND m.owner_id=$2 AND m.role='assistant' AND m.text<>''
         ORDER BY 7,1`,
          [id, ownerId],
        )
      ).rows.map((event) => {
        if (event.type === 'action') {
          const { app, label } = actionTitle(event.summary);
          return { ...event, type: 'tool_complete', summary: app ? `${app}: ${label}` : label };
        }
        return event.type === 'message' || event.type === 'step'
          ? event
          : { ...event, summary: toolTitle(event.summary) };
      });
      return { task, events };
    });
    app.post<{ Params: { id: string } }>('/api/tasks/:id/stop', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const cancelled = await transaction(
        async (client) => stop(client, id, (await lockThread(client)).id),
        pool,
      );
      await afterStop(cancelled);
      return { ok: true };
    });
    app.get<{ Params: { id: string } }>('/api/tasks/:id/schedule-draft', (request) =>
      scheduleDraft(request.params.id),
    );
  }

  async function afterStop(cancelled: { ids: string[]; browsers: string[] }) {
    abortTurns(cancelled.ids);
    await Promise.allSettled(cancelled.browsers.map((id) => options.clearBrowser?.(id)));
    refresh();
  }

  async function chatCommand(
    client: PoolClient,
    command: 'tasks' | 'status' | 'stop',
    replyToMessageId?: string,
    hasReply = Boolean(replyToMessageId),
  ): Promise<{
    threadId: string;
    replies: Array<{ text: string; replyToMessageId?: string; presentation: ChannelPresentation }>;
    afterCommit?: () => Promise<void>;
  }> {
    const thread = await lockThread(client);
    const timeZone = (
      await client.query<{ time_zone: string | null }>(
        'SELECT time_zone FROM preferences WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.time_zone;
    const reply = (data: object, replyTo?: string | null) => ({
      text: '',
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      presentation: {
        kind: 'command' as const,
        command,
        data: { ...data, ...(timeZone ? { timeZone } : {}) },
      },
    });
    const target = replyToMessageId
      ? await resolveReply(client, thread.id, replyToMessageId)
      : undefined;
    if (hasReply && !target)
      return { threadId: thread.id, replies: [reply({ repliedTo: 'not_a_task_message' })] };
    const cancelled =
      command === 'stop'
        ? target
          ? await stop(client, target.task_id, thread.id)
          : await cancelTurns(client, thread.id)
        : undefined;
    const tasks = await read(client, target ? { id: target.task_id, closed: true } : {});
    return {
      threadId: thread.id,
      replies:
        command === 'stop' && !target
          ? [reply({ stopped: 'all_active_work_and_open_tasks' })]
          : tasks.length
            ? tasks.map((task, index) =>
                reply(
                  {
                    task: taskFacts(task, Boolean(target) || command === 'status'),
                    ...(index === 0 ? { first: true } : {}),
                  },
                  task.questionMessageId ?? task.messageId,
                ),
              )
            : [reply({ tasks: [] })],
      afterCommit: cancelled ? () => afterStop(cancelled) : undefined,
    };
  }

  async function execute(turn: TurnRef, raw: unknown, sourceMessageId: string | null) {
    const result = await transaction(async (client) => {
      await lockThread(client);
      return withTurnLock(turn.turnId, () => act(client, turn, raw, sourceMessageId), client);
    }, pool);
    if ('cancelled' in result && result.cancelled) {
      const { cancelled, ...shown } = result;
      await afterStop(cancelled);
      return shown;
    }
    refresh();
    return result;
  }

  return {
    initialize,
    execute,
    inherit,
    context,
    resolveReply,
    chatCommand,
    read: (thread?: string) => read(pool, { closed: true, thread }),
    registerRoutes,
  };
}
