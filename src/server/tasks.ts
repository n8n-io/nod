import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskBrief } from '../ports/agent.ts';
import type { Task, TaskStatus } from '../shared/contracts.ts';
import { ownerId } from './config.ts';
import { pool, transaction } from './db.ts';
import { refresh } from './events.ts';
import { enqueueTurn, type TurnRef } from './thread.ts';
import { actionEffect, actionRecipients } from './trust.ts';
import type { WorkConsumers } from './work-admission.ts';

const queue = 'task-check';
const year = 366 * 24 * 3_600_000;
const wait = z
  .object({
    who: z.string().trim().min(1).max(120),
    via: z.string().trim().min(1).max(40),
    address: z.email().max(320).optional(),
  })
  .strict();
const now = z.string().trim().min(1).max(200);
const waits = z.array(wait).max(10);
const checkAt = z.iso.datetime({ offset: true }).refine((value) => {
  const time = Date.parse(value) - Date.now();
  return time > 0 && time < year;
}, 'checkAt must be a future time within a year.');
const id = z.uuid();
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z
    .object({
      action: z.literal('start'),
      title: z.string().trim().min(1).max(120),
      doneWhen: z.string().trim().min(1).max(300),
      now,
      waitingFor: waits.optional(),
      checkAt: checkAt.optional(),
    })
    .strict(),
  z.object({ action: z.literal('use'), id }).strict(),
  z
    .object({
      action: z.literal('update'),
      id: id.optional(),
      now: now.optional(),
      waitingFor: waits.optional(),
      checkAt: checkAt.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      id: id.optional(),
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
  waiting_for: Array<z.infer<typeof wait>>;
  check_at: Date | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  active: boolean;
  last_status: string | null;
  question: string | null;
};

function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function status(row: Row): TaskStatus {
  if (row.state !== 'open') return row.state;
  if (row.active) return 'working';
  if (row.last_status && ['waiting', 'failed', 'cancelled'].includes(row.last_status))
    return 'needs_you';
  if (row.waiting_for.length) return 'waiting';
  if (row.check_at) return 'scheduled';
  return 'stalled';
}

const nextMorning = `(SELECT CASE WHEN c>now()+interval '6 hours' THEN c ELSE c+interval '1 day' END FROM (
  SELECT (date_trunc('day',now() AT TIME ZONE z.tz)+interval '9 hours') AT TIME ZONE z.tz AS c FROM (
    SELECT COALESCE((SELECT NULLIF(time_zone,'') FROM preferences WHERE owner_id=$2),'UTC') AS tz) z) n)`;

async function read(
  client: Pick<PoolClient, 'query'>,
  filter: { ids?: string[]; closed?: boolean } = {},
): Promise<Task[]> {
  const rows = (
    await client.query<Row>(
      `SELECT t.id,t.title,t.done_when,t.now_text,t.result,t.state,t.waiting_for,t.check_at,
         t.created_at,t.updated_at,t.closed_at,
         EXISTS(SELECT 1 FROM turns a WHERE a.owner_id=t.owner_id AND a.task_id=t.id AND a.status IN ('queued','running')) AS active,
         last.status AS last_status,
         CASE WHEN last.status='waiting' THEN (SELECT left(m.text,600) FROM messages m
           WHERE m.owner_id=t.owner_id AND m.turn_id=last.id AND m.role='assistant' AND m.text<>''
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1) END AS question
       FROM tasks t
       LEFT JOIN LATERAL (SELECT u.id,u.status FROM turns u
         WHERE u.owner_id=t.owner_id AND u.task_id=t.id AND u.status NOT IN ('queued','running')
         ORDER BY u.finished_at DESC NULLS LAST,u.created_at DESC,u.id DESC LIMIT 1) last ON true
       WHERE t.owner_id=$1 AND ($2::uuid[] IS NULL OR t.id=ANY($2)) AND ($3 OR t.state='open')
       ORDER BY t.state='open' DESC,COALESCE(t.closed_at,t.updated_at) DESC,t.id LIMIT 100`,
      [ownerId, filter.ids ?? null, filter.closed ?? false],
    )
  ).rows;
  const sends = new Map<string, Date>();
  if (rows.length)
    for (const send of (
      await client.query<{ task_id: string; recipient: string; sent_at: Date }>(
        `SELECT u.task_id,s.recipient,max(s.sent_at) AS sent_at FROM turn_sends s
         JOIN turns u ON u.id=s.turn_id AND u.owner_id=s.owner_id
         WHERE s.owner_id=$1 AND u.task_id=ANY($2::uuid[]) GROUP BY u.task_id,s.recipient`,
        [ownerId, rows.map((row) => row.id)],
      )
    ).rows)
      sends.set(`${send.task_id} ${send.recipient}`, send.sent_at);
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
      waitingFor: open
        ? row.waiting_for.map((item) => ({
            who: item.who,
            via: item.via,
            address: item.address ?? null,
            since:
              (item.address &&
                sends.get(`${row.id} ${item.address.toLowerCase()}`)?.toISOString()) ||
              null,
          }))
        : [],
      checkAt: open ? (row.check_at?.toISOString() ?? null) : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      closedAt: row.closed_at?.toISOString() ?? null,
    };
  });
}

function brief(task: Task): TaskBrief {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    now: task.now,
    doneWhen: task.doneWhen,
    waitingFor: task.waitingFor,
    checkAt: task.checkAt,
    question: task.question,
  };
}

export function createTasks(options: { boss: PgBoss; consumers?: WorkConsumers }) {
  async function act(
    client: PoolClient,
    turn: TurnRef,
    raw: unknown,
    provenance: { sourceMessageId: string | null },
  ) {
    const request = input.parse(raw);
    if (request.action === 'list') return { tasks: (await read(client)).map(brief) };
    const current = (
      await client.query<{ task_id: string | null; channel: string; channel_source_id: string }>(
        'SELECT task_id,channel,channel_source_id FROM turns WHERE id=$1 AND owner_id=$2',
        [turn.turnId, ownerId],
      )
    ).rows[0];
    if (!current) throw failure('This turn is no longer running.', 409);
    let taskId: string;
    if (request.action === 'start') {
      const values = [
        ownerId,
        request.title,
        request.doneWhen,
        request.now,
        JSON.stringify(request.waitingFor ?? []),
        request.checkAt ?? null,
        provenance.sourceMessageId,
        current.channel,
        current.channel_source_id,
      ];
      taskId =
        (
          await client.query(
            `INSERT INTO tasks(id,owner_id,title,done_when,now_text,waiting_for,check_at,source_message_id,channel,channel_source_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (owner_id,source_message_id,title) WHERE source_message_id IS NOT NULL DO NOTHING RETURNING id`,
            [randomUUID(), ...values],
          )
        ).rows[0]?.id ??
        (
          await client.query(
            'SELECT id FROM tasks WHERE owner_id=$1 AND source_message_id=$2 AND title=$3',
            [ownerId, provenance.sourceMessageId, request.title],
          )
        ).rows[0].id;
    } else {
      taskId = request.id ?? current.task_id ?? '';
      if (!taskId) throw failure('Start a task first, or pass its id.');
      const task = (
        await client.query<{ state: string }>(
          'SELECT state FROM tasks WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE',
          [taskId, ownerId],
        )
      ).rows[0];
      if (!task) throw failure('Task not found.', 404);
      if (task.state !== 'open') throw failure('This task is already finished.');
      if (request.action === 'update')
        await client.query(
          `UPDATE tasks SET now_text=COALESCE($3,now_text),waiting_for=COALESCE($4,waiting_for),
           check_at=COALESCE($5,check_at),updated_at=now() WHERE id=$1 AND owner_id=$2`,
          [
            taskId,
            ownerId,
            request.now ?? null,
            request.waitingFor ? JSON.stringify(request.waitingFor) : null,
            request.checkAt ?? null,
          ],
        );
      if (request.action === 'finish')
        await client.query(
          `UPDATE tasks SET state=$3,result=$4,check_at=NULL,waiting_for='[]',closed_at=now(),updated_at=now()
           WHERE id=$1 AND owner_id=$2`,
          [taskId, ownerId, request.status, request.result],
        );
    }
    if (request.action === 'start' || request.action === 'use' || !current.task_id)
      await client.query('UPDATE turns SET task_id=$1 WHERE id=$2 AND owner_id=$3', [
        taskId,
        turn.turnId,
        ownerId,
      ]);
    return brief((await read(client, { ids: [taskId], closed: true }))[0]!);
  }

  async function recordSend(
    turnId: string,
    action: string,
    args: Record<string, unknown>,
    result: unknown,
  ) {
    const outcome = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    if (
      outcome.successful === false ||
      outcome.success === false ||
      outcome.isError ||
      outcome.error
    )
      return;
    const effect = actionEffect(action, args);
    if (effect !== 'outbound' && effect !== 'unknown') return;
    const recipients = [...actionRecipients(args)].slice(0, 20);
    if (!recipients.length) return;
    await pool.query(
      `INSERT INTO turn_sends(id,owner_id,turn_id,via,recipient)
       SELECT gen_random_uuid(),$1,$2,$3,recipient FROM unnest($4::text[]) AS recipient`,
      [
        ownerId,
        turnId,
        action.startsWith('CONNECTED_') ? 'app' : action.split('_')[0]!.toLowerCase(),
        recipients,
      ],
    );
  }

  async function settle(client: PoolClient, turnId: string) {
    const row = (
      await client.query<{
        id: string;
        check_at: Date | null;
        idle_checks: number;
        idle: boolean;
        status: string;
      }>(
        `SELECT t.id,t.check_at,t.idle_checks,u.status,
           (u.source_id LIKE 'task-check:%' AND t.updated_at<u.started_at) AS idle
         FROM turns u JOIN tasks t ON t.id=u.task_id AND t.owner_id=u.owner_id
         WHERE u.id=$1 AND u.owner_id=$2 AND t.state='open' FOR NO KEY UPDATE OF t`,
        [turnId, ownerId],
      )
    ).rows[0];
    if (!row || row.status !== 'succeeded') return;
    const idle = row.idle ? row.idle_checks + 1 : 0;
    await client.query(
      `UPDATE tasks SET idle_checks=$3,check_at=CASE WHEN check_at>now() THEN check_at
         WHEN $3>=2 THEN NULL ELSE ${nextMorning} END WHERE id=$1 AND owner_id=$2`,
      [row.id, ownerId, idle],
    );
  }

  async function sweep() {
    const due = await pool.query<{ id: string }>(
      "SELECT id FROM tasks WHERE owner_id=$1 AND state='open' AND check_at<=now() ORDER BY check_at,id LIMIT 20",
      [ownerId],
    );
    for (const { id } of due.rows)
      await transaction(async (client) => {
        const task = (
          await client.query<{
            title: string;
            check_at: Date;
            channel: string;
            channel_source_id: string | null;
          }>(
            `SELECT title,check_at,channel,channel_source_id FROM tasks
             WHERE id=$1 AND owner_id=$2 AND state='open' AND check_at<=now() FOR NO KEY UPDATE`,
            [id, ownerId],
          )
        ).rows[0];
        if (!task) return;
        const busy = await client.query(
          "SELECT 1 FROM turns WHERE owner_id=$1 AND task_id=$2 AND status IN ('queued','running') LIMIT 1",
          [ownerId, id],
        );
        if (busy.rowCount) return;
        await enqueueTurn(
          `Task check: ${JSON.stringify(task.title)}. See how this task is going: check replies, pages, bookings and anything else it depends on before contacting anyone. Do the next useful step that the user's request already covers, then update or finish the task. Send a message only for a useful result, a problem or a necessary question.`,
          {
            client,
            source: 'event',
            sourceId: `task-check:${id}:${task.check_at.toISOString()}`,
            channel: task.channel,
            channelSourceId: task.channel_source_id,
            background: true,
            taskId: id,
          },
        );
        await client.query('UPDATE tasks SET check_at=NULL WHERE id=$1 AND owner_id=$2', [
          id,
          ownerId,
        ]);
      });
    if (due.rowCount) refresh();
  }

  async function context(turnId: string) {
    const [tasks, turn] = await Promise.all([
      read(pool),
      pool.query<{ task_id: string | null }>(
        'SELECT task_id FROM turns WHERE id=$1 AND owner_id=$2',
        [turnId, ownerId],
      ),
    ]);
    return {
      tasks: tasks.slice(0, 10).map(brief),
      ...(turn.rows[0]?.task_id ? { taskId: turn.rows[0].task_id } : {}),
    };
  }

  async function initialize() {
    const { boss, consumers } = options;
    await boss.createQueue(queue, { retryLimit: 0 });
    await boss.schedule(queue, '* * * * *', {}, { tz: 'UTC' });
    const start = () => boss.work(queue, () => sweep());
    if (consumers)
      await consumers.register({ start, stop: (id) => boss.offWork(queue, { id, wait: true }) });
    else await start();
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/tasks', () => read(pool, { closed: true }));
    app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request) => {
      const taskId = id.parse(request.params.id);
      const removed = await pool.query('DELETE FROM tasks WHERE id=$1 AND owner_id=$2', [
        taskId,
        ownerId,
      ]);
      if (!removed.rowCount) throw failure('Task not found.', 404);
      refresh();
      return { ok: true };
    });
  }

  return {
    act,
    recordSend,
    settle,
    sweep,
    context,
    open: async () => (await read(pool)).map(brief),
    initialize,
    registerRoutes,
  };
}
