import type { PoolClient } from 'pg';
import type { TurnRef } from './thread.ts';

export const browserOf = (turn: TurnRef) => turn.browserId ?? turn.threadId;

type ChainTurn = {
  id: string;
  thread_id: string;
  source: string;
  source_id: string | null;
  message_id: string | null;
  prompt: string;
  read_only: boolean;
  background: boolean;
  channel: string;
  session_id: string;
};

export function taskSessionSql(alias = 'u') {
  return `EXISTS (SELECT 1 FROM tasks t WHERE t.id=${alias}.session_id AND t.owner_id=${alias}.owner_id)`;
}

export function sessionOfMessageSql(alias = 'm') {
  return `COALESCE((SELECT t.id FROM tasks t WHERE t.on_it_message_id=${alias}.id AND t.owner_id=${alias}.owner_id),
    (SELECT u.session_id FROM turns u WHERE u.id=${alias}.turn_id AND u.owner_id=${alias}.owner_id))`;
}

export async function taskOfTurn(
  database: Pick<PoolClient, 'query'>,
  ownerId: string,
  turnId: string,
) {
  return (
    await database.query<{ id: string; source_message_id: string | null; read_only: boolean }>(
      `SELECT t.id,t.source_message_id,t.read_only FROM turns u
       JOIN tasks t ON t.id=u.session_id AND t.owner_id=u.owner_id AND t.thread_id=u.thread_id
       WHERE u.id=$1 AND u.owner_id=$2`,
      [turnId, ownerId],
    )
  ).rows[0];
}

export function parentTurnSql(alias = 'u') {
  return `CASE WHEN ${alias}.source='resume' THEN COALESCE(
      substring(${alias}.source_id from '^(?:credentials|credentials-retry|connection):([0-9a-f-]{36})(?::|$)')::uuid,
      (SELECT a.turn_id FROM approvals a WHERE a.execution_turn_id=${alias}.id AND a.owner_id=${alias}.owner_id AND a.turn_id<>${alias}.id LIMIT 1)) END`;
}

export async function turnChain(
  database: Pick<PoolClient, 'query'>,
  ownerId: string,
  turn: Pick<TurnRef, 'turnId' | 'threadId'>,
) {
  const link = parentTurnSql('u');
  const { rows } = await database.query<ChainTurn & { next: string | null }>(
    `WITH RECURSIVE chain(id,next) AS (
       SELECT u.id,${link} FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
       UNION
       SELECT u.id,${link} FROM chain c JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=$3
     )
     SELECT c.next,u.* FROM chain c JOIN turns u ON u.id=c.id`,
    [turn.turnId, ownerId, turn.threadId],
  );
  const turns = new Map(rows.map((row) => [row.id, row]));
  const chain: ChainTurn[] = [];
  let id: string | null = turn.turnId;
  while (id) {
    const current = turns.get(id);
    if (!current || chain.includes(current)) break;
    chain.push(current);
    id = current.next;
  }
  return {
    chain,
    origin: id ? undefined : chain.at(-1),
    readOnly: chain.some((item) => item.read_only || item.source_id?.startsWith('onboarding:')),
  };
}
