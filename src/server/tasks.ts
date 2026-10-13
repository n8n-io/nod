import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Task, TaskStatus } from '../shared/contracts.ts';
import { classifyVerificationReply } from '../shared/verification-code.ts';
import {
  enqueueTurn,
  insertAssistantMessage,
  lockThread,
  withTurnLock,
  type TurnRef,
} from './thread.ts';
import { turnChain } from './turn-chain.ts';
import { personalSecret } from './memory-tree.ts';
import { texts as codeTexts } from './chat-verification.ts';

const credentialUrl = /(?<![\w/])(?:[a-z][a-z\d+.-]*:)?\/\/[^/\s?#<>]*@/iu;
const dispatchInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    ack: z.string().trim().max(200),
    instruction: z.string().trim().min(1).max(4000),
    steps: z.array(z.string().trim().min(1).max(120)).min(2).max(8).optional(),
  })
  .strict();
const progressInput = z
  .object({
    steps: z.array(z.string().trim().min(1).max(120)).min(2).max(8).optional(),
    current: z.number().int().min(1).max(8).optional(),
    now: z.string().trim().max(200).optional(),
    stop: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Give steps, current, now or stop.');

type Row = {
  id: string;
  title: string;
  on_it_message_id: string;
  now_text: string;
  result: string;
  state: 'queued' | 'open' | 'done' | 'stopped' | 'failed';
  turn_status: string | null;
  question: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function status(row: Row): TaskStatus {
  if (row.state !== 'open') return row.state;
  return row.turn_status === 'waiting' ? 'needs_you' : 'working';
}

export function createTasks(options: { pool: Pool; ownerId: string; refresh?: () => void }) {
  const { pool, ownerId } = options;
  const refresh = options.refresh ?? (() => {});

  async function rows(openThreadId: string | null) {
    return (
      await pool.query<Row>(
        `SELECT t.id,t.title,t.on_it_message_id,t.now_text,COALESCE(NULLIF(t.result,''),left(r.text,600),'') AS result,
           t.state,t.created_at,t.updated_at,t.closed_at,l.status AS turn_status,
           CASE WHEN l.status='waiting' THEN (SELECT left(m.text,600) FROM messages m
             WHERE m.owner_id=t.owner_id AND m.turn_id=l.id AND m.role='assistant' AND m.text<>''
             ORDER BY m.created_at DESC,m.id DESC LIMIT 1) END AS question
         FROM tasks t
         LEFT JOIN messages r ON r.id=t.result_message_id AND r.owner_id=t.owner_id
         LEFT JOIN LATERAL (SELECT u.id,u.status FROM turns u WHERE u.owner_id=t.owner_id AND u.session_id=t.id
           ORDER BY u.created_at DESC,u.id DESC LIMIT 1) l ON true
         WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR (t.thread_id=$2 AND t.state IN ('queued','open')))
         ORDER BY t.closed_at IS NULL DESC,COALESCE(t.closed_at,t.updated_at) DESC,t.id LIMIT 100`,
        [ownerId, openThreadId],
      )
    ).rows;
  }

  async function open(threadId: string) {
    return (await rows(threadId)).map((row) => ({
      title: row.title,
      status: status(row),
      onItMessageId: row.on_it_message_id,
    }));
  }

  async function read(): Promise<Task[]> {
    return (await rows(null)).map((row) => {
      const value = status(row);
      return {
        id: row.id,
        title: row.title,
        now: row.now_text,
        result: row.result,
        status: value,
        question: value === 'needs_you' ? row.question : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        closedAt: row.closed_at?.toISOString() ?? null,
      };
    });
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
        `INSERT INTO tasks(id,owner_id,thread_id,title,instruction,source_message_id,on_it_message_id,
           channel,channel_source_id,steps)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          ownerId,
          thread.id,
          request.title,
          source.text,
          source.id,
          onItMessageId,
          current.channel,
          channelSourceId,
          JSON.stringify(request.steps ?? []),
        ],
      );
      await enqueueTurn(request.instruction, {
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

  async function progress(turn: TurnRef, raw: unknown) {
    const input = progressInput.parse(raw);
    const result = await withTurnLock(turn.turnId, async (client) => {
      const task = (
        await client.query<{ id: string; steps: string[]; step_index: number; on_it: string }>(
          `SELECT t.id,t.steps,t.step_index,t.on_it_message_id AS on_it FROM turns u
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
      await client.query(
        `UPDATE tasks SET steps=$2,step_index=$3,now_text=COALESCE($4,now_text),
           state=CASE WHEN $5 THEN 'stopped' ELSE state END,
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
        ],
      );
      if (input.stop === undefined) return 'Progress saved.';
      await insertAssistantMessage(client, turn, input.stop, [], undefined, task.on_it);
      return 'The task is stopped. End now without a final message.';
    });
    refresh();
    return result;
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, now_text text NOT NULL DEFAULT '',
        state text NOT NULL DEFAULT 'open'
          CONSTRAINT tasks_state_check CHECK (state IN ('queued','open','done','stopped','failed')),
        result text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
      );
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES threads(id),
        ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id),
        ADD COLUMN IF NOT EXISTS instruction text,
        ADD COLUMN IF NOT EXISTS on_it_message_id uuid REFERENCES messages(id),
        ADD COLUMN IF NOT EXISTS channel text,
        ADD COLUMN IF NOT EXISTS channel_source_id text,
        ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS step_index integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS check_ins integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_check_in_at timestamptz,
        ADD COLUMN IF NOT EXISTS result_message_id uuid REFERENCES messages(id);
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass
          AND attname IN ('auto','done_when') AND NOT attisdropped) THEN
          ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
          UPDATE tasks SET state='stopped' WHERE state='cancelled';
          UPDATE tasks SET state='stopped',closed_at=now(),updated_at=now()
            WHERE state='open' AND on_it_message_id IS NULL;
          ALTER TABLE tasks DROP COLUMN IF EXISTS auto, DROP COLUMN IF EXISTS turn_id,
            DROP COLUMN IF EXISTS done_when, DROP COLUMN IF EXISTS waiting_for,
            DROP COLUMN IF EXISTS next_check, ALTER COLUMN now_text SET DEFAULT '',
            ADD CONSTRAINT tasks_state_check CHECK (state IN ('queued','open','done','stopped','failed'));
        END IF;
      END $$;
      ALTER TABLE turns DROP COLUMN IF EXISTS task_id;
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_id,state,updated_at DESC);
    `);
  }

  async function scheduleDraft(id: string) {
    z.uuid().parse(id);
    const task = (
      await pool.query<{ title: string; instruction: string | null; has_attachments: boolean }>(
        `SELECT t.title,t.instruction,COALESCE(jsonb_array_length(s.attachments)>0,false) AS has_attachments
         FROM tasks t LEFT JOIN messages s ON s.id=t.source_message_id AND s.owner_id=t.owner_id
         WHERE t.id=$1 AND t.owner_id=$2 AND t.state='done'`,
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

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/tasks', () => read());
    app.get<{ Params: { id: string } }>('/api/tasks/:id/schedule-draft', (request) =>
      scheduleDraft(request.params.id),
    );
  }

  return { initialize, dispatch, progress, open, registerRoutes };
}
