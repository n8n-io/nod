import type { TurnRef } from './thread.ts';

export const browserOf = (turn: TurnRef) => turn.browserId ?? turn.threadId;

export function parentTurnSql(alias = 'u') {
  return `COALESCE(CASE WHEN ${alias}.source='resume' THEN substring(${alias}.source_id from '^(?:credentials|credentials-retry|connection|control):([0-9a-f-]{36})(?::|$)')::uuid END,
      (SELECT a.turn_id FROM approvals a WHERE a.execution_turn_id=${alias}.id AND a.owner_id=${alias}.owner_id AND a.turn_id<>${alias}.id LIMIT 1))`;
}

export function turnChainSql() {
  const link = parentTurnSql('u');
  return `WITH RECURSIVE chain(id,next,thread_id) AS (
    SELECT u.id,${link},u.thread_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
    UNION
    SELECT u.id,${link},u.thread_id FROM chain c
    JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=c.thread_id
  )`;
}
