import type { TurnRef } from './thread.ts';

export const browserOf = (turn: TurnRef) => turn.browserId ?? turn.threadId;

export function supersededSql(alias: string, newer: string) {
  return `EXISTS(SELECT 1 FROM turns newer WHERE newer.owner_id=${alias}.owner_id AND newer.session_id=${alias}.session_id
    AND newer.id<>${alias}.id AND ${newer})`;
}

export const laterSupersedingTurnSql = `EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.session_id=u.session_id
  AND (n.created_at,n.id)>(u.created_at,u.id)
  AND NOT (n.status='succeeded' AND n.started_at IS NULL AND n.message_id IS NOT NULL
    AND n.source IN ('user','task')))`;

export const withdrawnSql = (message: string) =>
  `EXISTS(SELECT 1 FROM turns w WHERE w.owner_id=${message}.owner_id AND w.withdrawn
    AND (w.id=${message}.turn_id OR w.message_id=${message}.id))`;

export function turnChainSql() {
  return `WITH RECURSIVE chain(id,next,thread_id) AS (
    SELECT u.id,u.parent_turn_id,u.thread_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
    UNION
    SELECT u.id,u.parent_turn_id,u.thread_id FROM chain c
    JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=c.thread_id
  )`;
}
