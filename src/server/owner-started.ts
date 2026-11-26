import type { Pool } from 'pg';
import { IntegrationError } from './integration-connection.ts';
import {
  hasOwnerInstructions,
  validateSavedInstructions,
  type OwnerInstructions,
} from './owner-instructions.ts';

export type OwnedTurn = { turnId: string; threadId: string };

export async function assertStartedByOwner(
  database: Pick<Pool, 'query'>,
  ownerId: string,
  turn: OwnedTurn | undefined,
  refusal: string,
) {
  const { rows } = turn
    ? await database.query<{
        id: string;
        parent_turn_id: string | null;
        source: string;
        message_id: string | null;
        proactive: boolean;
      }>(
        `WITH RECURSIVE lineage AS (
          SELECT id,parent_turn_id,source,message_id,proactive,0 AS depth FROM turns WHERE id=$1 AND owner_id=$2 AND thread_id=$3
          UNION ALL SELECT p.id,p.parent_turn_id,p.source,p.message_id,p.proactive,c.depth+1 FROM turns p JOIN lineage c ON c.parent_turn_id=p.id WHERE p.owner_id=$2 AND p.thread_id=$3 AND c.depth<100
        ) SELECT id,parent_turn_id,source,message_id,bool_or(proactive) OVER () AS proactive FROM lineage ORDER BY depth DESC LIMIT 1`,
        [turn.turnId, ownerId, turn.threadId],
      )
    : { rows: [] };
  const root = rows[0];
  const schedule =
    root?.source === 'schedule'
      ? (
          await database.query<{ authority: OwnerInstructions | null }>(
            'SELECT authority FROM schedule_runs WHERE turn_id=$1 AND owner_id=$2',
            [root.id, ownerId],
          )
        ).rows[0]
      : undefined;
  const owned =
    root &&
    !root.parent_turn_id &&
    !root.proactive &&
    ((root.source === 'user' && root.message_id) || hasOwnerInstructions(schedule?.authority));
  if (owned && schedule?.authority) validateSavedInstructions(schedule.authority);
  if (!owned) throw new IntegrationError(refusal, 403);
  return root.id;
}
