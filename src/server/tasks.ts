import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskStatus } from '../shared/contracts.ts';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import type { TurnRef } from './thread.ts';
import { personalSecret } from './memory-tree.ts';
import { texts as codeTexts } from './chat-verification.ts';

const now = z.string().trim().min(1).max(200);
const waits = z
  .array(
    z
      .object({ who: z.string().trim().min(1).max(80), via: z.string().trim().min(1).max(40) })
      .strict(),
  )
  .max(10);
const nextCheck = z.iso.datetime({ offset: true });
const credentialUrl = /(?<![\w/])(?:[a-z][a-z\d+.-]*:)?\/\/[^/\s?#<>]*@/iu;
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z
    .object({
      action: z.literal('start'),
      title: z.string().trim().min(1).max(120),
      doneWhen: z.string().trim().min(1).max(300),
      now,
      waitingFor: waits.optional(),
      nextCheck: nextCheck.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      id: z.uuid(),
      now: now.optional(),
      waitingFor: waits.optional(),
      nextCheck: nextCheck.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      id: z.uuid(),
      status: z.enum(['done', 'cancelled']),
      result: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
type Row = {
  id: string;
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
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function status(row: Row): TaskStatus {
  if (row.state !== 'open') return row.state;
  if (row.turn_status === 'queued' || row.turn_status === 'running') return 'working';
  if (['waiting', 'failed', 'cancelled'].includes(row.turn_status ?? '') && !row.answered)
    return 'needs_you';
  if (row.waiting_for.length) return 'waiting';
  if (row.next_check && row.next_check.getTime() > Date.now()) return 'scheduled';
  return 'stalled';
}

export function createTasks(options: { pool: Pool; ownerId: string; refresh?: () => void }) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function read(
    client: Pick<PoolClient, 'query'>,
    filter: { id?: string; closed?: boolean } = {},
  ): Promise<Task[]> {
    const rows = (
      await client.query<Row>(
        `SELECT t.id,t.title,t.done_when,t.now_text,t.result,t.state,t.waiting_for,t.next_check,
           t.created_at,t.updated_at,t.closed_at,u.status AS turn_status,
           EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.thread_id=u.thread_id
             AND n.source='user' AND n.created_at>u.created_at) AS answered,
           CASE WHEN u.status='waiting' THEN (SELECT left(m.text,600) FROM messages m
             WHERE m.owner_id=u.owner_id AND m.turn_id=u.id AND m.role='assistant' AND m.text<>''
             ORDER BY m.created_at DESC,m.id DESC LIMIT 1) END AS question
         FROM tasks t LEFT JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id
         WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.id=$2) AND ($3 OR t.state='open')
         ORDER BY t.state='open' DESC,COALESCE(t.closed_at,t.updated_at) DESC,t.id LIMIT 100`,
        [ownerId, filter.id ?? null, filter.closed ?? false],
      )
    ).rows;
    return rows.map((row) => {
      const value = status(row);
      const open = row.state === 'open';
      return {
        id: row.id,
        title: row.title,
        doneWhen: row.done_when,
        now: row.now_text,
        result: row.result,
        status: value,
        question: value === 'needs_you' ? row.question : null,
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

  async function act(client: PoolClient, turn: TurnRef, raw: unknown) {
    const request = input.parse(raw);
    if (request.action === 'list') return { tasks: await read(client) };
    let id: string;
    if (request.action === 'start') {
      id =
        (
          await client.query<{ id: string }>(
            `SELECT id FROM tasks WHERE owner_id=$1 AND state='open' AND title=$2
             ORDER BY updated_at DESC LIMIT 1 FOR NO KEY UPDATE`,
            [ownerId, request.title],
          )
        ).rows[0]?.id ?? randomUUID();
      await client.query(
        `INSERT INTO tasks(id,owner_id,turn_id,title,done_when,now_text,waiting_for,next_check)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET turn_id=$3,title=$4,done_when=$5,now_text=$6,waiting_for=$7,
           next_check=COALESCE($8,tasks.next_check),updated_at=now()`,
        [
          id,
          ownerId,
          turn.turnId,
          request.title,
          request.doneWhen,
          request.now,
          JSON.stringify(request.waitingFor ?? []),
          request.nextCheck ?? null,
        ],
      );
    } else {
      id = request.id;
      const updated =
        request.action === 'update'
          ? await client.query(
              `UPDATE tasks SET turn_id=$3,now_text=COALESCE($4,now_text),
                 waiting_for=COALESCE($5,waiting_for),next_check=COALESCE($6,next_check),updated_at=now()
               WHERE id=$1 AND owner_id=$2 AND state='open'`,
              [
                id,
                ownerId,
                turn.turnId,
                request.now ?? null,
                request.waitingFor ? JSON.stringify(request.waitingFor) : null,
                request.nextCheck ?? null,
              ],
            )
          : await client.query(
              `UPDATE tasks SET turn_id=$3,state=$4,result=$5,closed_at=now(),updated_at=now()
               WHERE id=$1 AND owner_id=$2 AND state='open'`,
              [id, ownerId, turn.turnId, request.status, request.result],
            );
      if (!updated.rowCount) throw failure('This task is not open. Use task list for open tasks.');
    }
    await link(client, turn.turnId, id);
    return (await read(client, { id, closed: true }))[0];
  }

  async function inherit(turn: TurnRef) {
    const parent = (
      await pool.query<{ id: string }>(
        `SELECT t.id FROM turns u JOIN turns p ON p.id=u.parent_turn_id AND p.owner_id=u.owner_id
         JOIN tasks t ON t.id=p.task_id AND t.owner_id=p.owner_id AND t.state='open'
         WHERE u.id=$1 AND u.owner_id=$2 AND u.task_id IS NULL`,
        [turn.turnId, ownerId],
      )
    ).rows[0];
    if (!parent) return;
    await link(pool, turn.turnId, parent.id);
    refresh();
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
        `SELECT m.text,jsonb_array_length(m.attachments)>0 AS has_attachments
         FROM messages m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
         WHERE u.task_id=$1 AND u.owner_id=$2 AND u.source='user' AND m.role='user'
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
    app.get<{ Params: { id: string } }>('/api/tasks/:id/schedule-draft', (request) =>
      scheduleDraft(request.params.id),
    );
  }

  return { initialize, act, inherit, registerRoutes };
}
