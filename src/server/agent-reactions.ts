import type { Pool } from 'pg';
import { isMessageReaction, reactionEmoji } from '../shared/emoji.ts';
import type { AgentReactionResult, MessageReaction } from '../shared/contracts.ts';
import { transaction } from './transaction.ts';
import { lockThread } from './thread.ts';

export interface AgentReactionInput {
  threadId: string;
  turnId: string;
  messageId: string;
  reaction: MessageReaction | null;
  signal?: AbortSignal;
}

export function createAgentReactionService(dependencies: {
  pool: Pool;
  ownerId: string;
  refresh(): void;
}) {
  async function react(input: AgentReactionInput): Promise<AgentReactionResult> {
    input.signal?.throwIfAborted();
    if (input.reaction !== null && !isMessageReaction(input.reaction))
      throw new Error('Choose one emoji reaction.');
    const result = await transaction(async (client): Promise<AgentReactionResult> => {
      let result: AgentReactionResult;
      const thread = await lockThread(client, dependencies.ownerId);
      input.signal?.throwIfAborted();
      const current =
        thread.id === input.threadId
          ? await client.query(
              `SELECT u.channel,u.source FROM turns u
               WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND u.status='running' FOR NO KEY UPDATE`,
              [input.turnId, dependencies.ownerId, thread.id],
            )
          : { rowCount: 0, rows: [] };
      if (!current.rowCount) throw new Error('This turn is no longer active.');
      input.signal?.throwIfAborted();
      const turn = current.rows[0];
      if (turn.channel !== 'web' || turn.source !== 'user') {
        result = { status: 'skipped', reason: 'unavailable' };
      } else {
        const target = await client.query(
          `SELECT m.assistant_reaction,m.assistant_reacted_at FROM messages m
           WHERE m.id=$1 AND m.owner_id=$2 AND m.role='user' AND m.thread_id=$3
           FOR UPDATE OF m`,
          [input.messageId, dependencies.ownerId, thread.id],
        );
        if (!target.rowCount) throw new Error('The message cannot receive this reaction.');
        const message = target.rows[0];
        const unchanged =
          input.reaction === null
            ? message.assistant_reaction === null
            : message.assistant_reaction !== null &&
              reactionEmoji(message.assistant_reaction) === reactionEmoji(input.reaction);
        if (unchanged) result = { status: 'unchanged' };
        else if (input.reaction === null) {
          await client.query('UPDATE messages SET assistant_reaction=NULL WHERE id=$1', [
            input.messageId,
          ]);
          result = { status: 'updated' };
        } else if (message.assistant_reacted_at || message.assistant_reaction) {
          result = { status: 'skipped', reason: 'already_reacted' };
        } else {
          const recent = await client.query(
            `SELECT m.id FROM messages m
             WHERE m.owner_id=$1 AND m.thread_id=$2
               AND m.assistant_reacted_at > clock_timestamp()-interval '5 minutes'
             LIMIT 1`,
            [dependencies.ownerId, thread.id],
          );
          if (recent.rowCount) result = { status: 'skipped', reason: 'cooldown' };
          else {
            await client.query(
              'UPDATE messages SET assistant_reaction=$2,assistant_reacted_at=clock_timestamp() WHERE id=$1',
              [input.messageId, reactionEmoji(input.reaction)],
            );
            result = { status: 'updated' };
          }
        }
      }
      input.signal?.throwIfAborted();
      return result;
    }, dependencies.pool);
    if (result.status === 'updated') dependencies.refresh();
    return result;
  }
  return { react };
}
