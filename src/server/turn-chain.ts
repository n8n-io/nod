import type { TurnRef } from './thread.ts';

export const browserOf = (turn: TurnRef) => turn.browserId ?? turn.threadId;

export const taskMessageSql =
  '(t.message_id=m.id OR mt.task_id=t.id OR m.reply_to_message_id=t.message_id OR pt.task_id=t.id)';

export const chatTaskSql = (turn: string) =>
  `(CASE WHEN ${turn}.session_id<>${turn}.thread_id THEN COALESCE(
    (SELECT k.id FROM tasks k WHERE k.id=${turn}.task_id AND k.owner_id=${turn}.owner_id),
    (SELECT k.id FROM tasks k WHERE k.id=${turn}.session_id AND k.session_id=k.id AND k.owner_id=${turn}.owner_id)) END)`;

export function supersededSql(alias: string, newer: string) {
  return `EXISTS(SELECT 1 FROM turns newer WHERE newer.owner_id=${alias}.owner_id AND newer.session_id=${alias}.session_id
    AND newer.id<>${alias}.id AND ${newer})`;
}

export function waitingTurnSql(alias: string, reason?: 'credentials' | 'question') {
  return `${alias}.status='waiting'${reason ? ` AND ${alias}.waiting_reason='${reason}'` : ''}
    AND EXISTS(SELECT 1 FROM threads wt WHERE wt.id=${alias}.thread_id AND wt.owner_id=${alias}.owner_id AND wt.archived_at IS NULL)
    AND NOT ${supersededSql(alias, `newer.started_at>=${alias}.started_at`)}`;
}

export const laterSupersedingTurnSql = `EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.session_id=u.session_id
  AND (n.created_at,n.id)>(u.created_at,u.id)
  AND NOT (n.status='succeeded' AND n.started_at IS NULL AND n.message_id IS NOT NULL
    AND n.source IN ('user','task')))`;

export const withdrawnSql = (message: string) =>
  `EXISTS(SELECT 1 FROM turns w WHERE w.owner_id=${message}.owner_id AND w.withdrawn
    AND (w.id=${message}.turn_id OR w.message_id=${message}.id))`;

export const reactionReplySql = (message: string) =>
  `EXISTS (SELECT 1 FROM turns reaction_turn
    WHERE reaction_turn.owner_id=${message}.owner_id AND reaction_turn.message_id=${message}.id
      AND starts_with(reaction_turn.source_id,'reaction-reply:'))`;

export function turnChainSql() {
  return `WITH RECURSIVE chain(id,next,thread_id) AS (
    SELECT u.id,u.parent_turn_id,u.thread_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
    UNION
    SELECT u.id,u.parent_turn_id,u.thread_id FROM chain c
    JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=c.thread_id
  )`;
}

export function workOriginSql(row: string) {
  return `LEFT JOIN LATERAL (
      WITH RECURSIVE chain(id,next,thread_id,depth) AS (
        (SELECT f.id,f.parent_turn_id,f.thread_id,0 FROM turns f
          WHERE f.owner_id=${row}.owner_id AND f.session_id=${row}.session_id ORDER BY f.created_at,f.id LIMIT 1)
        UNION ALL
        SELECT u.id,u.parent_turn_id,u.thread_id,c.depth+1 FROM chain c
        JOIN turns u ON u.id=c.next AND u.owner_id=${row}.owner_id AND u.thread_id=c.thread_id WHERE c.depth<200
      )
      SELECT r.source,r.source_id FROM chain c JOIN turns r ON r.id=c.id ORDER BY c.depth DESC LIMIT 1
    ) work_origin ON true
    LEFT JOIN tasks work_task ON work_task.owner_id=${row}.owner_id AND work_task.id=${row}.session_id
    LEFT JOIN schedules work_schedule ON work_origin.source='schedule' AND work_schedule.owner_id=${row}.owner_id
      AND work_schedule.id::text=split_part(work_origin.source_id,':',2)`;
}

export function workKindSql(row: string, thread = `${row}.thread_id`) {
  return `CASE WHEN ${row}.session_id=${thread} THEN 'chat'
    WHEN work_task.activity_key IS NOT NULL THEN 'background'
    WHEN work_origin.source='schedule' THEN 'schedule'
    WHEN work_origin.source='event' THEN 'background' ELSE 'chat' END`;
}
