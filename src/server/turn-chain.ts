import type { TurnRef } from './thread.ts';

export const browserOf = (turn: TurnRef) => turn.browserId ?? turn.threadId;

export function supersededSql(alias: string, newer: string) {
  return `EXISTS(SELECT 1 FROM turns newer WHERE newer.owner_id=${alias}.owner_id AND newer.session_id=${alias}.session_id
    AND newer.id<>${alias}.id AND ${newer})`;
}

export function turnChainSql() {
  return `WITH RECURSIVE chain(id,next,thread_id) AS (
    SELECT u.id,u.parent_turn_id,u.thread_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
    UNION
    SELECT u.id,u.parent_turn_id,u.thread_id FROM chain c
    JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=c.thread_id
  )`;
}
