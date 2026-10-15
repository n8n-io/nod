import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.ts';
import { ownerId } from './config.ts';
import { refresh } from './events.ts';
import { enqueueTurn, withTurnLock, type SubmitUserMessageResult, type TurnRef } from './thread.ts';
import { actionConfirmation } from './action-presentation.ts';
import { untrustedBlock } from '../shared/untrusted.ts';

export interface ApprovalExecutionContext {
  threadId: string;
  turnId: string;
  sourceMessageId: string | null;
}

export interface ChatConfirmationInput {
  text: string;
  channel: string;
  threadId: string;
  replyToMessageId?: string;
  seenMessageId?: string;
  clientMessageId?: string;
  sourceId?: string;
  hasAttachments?: boolean;
  answer?: { approvalId: string; approved?: boolean };
}

export type ChatConfirmationResult =
  | SubmitUserMessageResult
  | { waiting: { id: string; session_id: string; background: boolean } }
  | undefined;

type TurnRow = {
  id: string;
  thread_id: string;
  source: string;
  parent_turn_id: string | null;
  message_id: string | null;
  prompt: string;
  background: boolean;
  channel: string;
};

function conflict(message = 'This confirmation is expired, already handled, or its turn changed.') {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function turnRow(client: PoolClient, turnId: string) {
  return (
    await client.query<TurnRow>(
      'SELECT id,thread_id,source,parent_turn_id,message_id,prompt,background,channel FROM turns WHERE id=$1 AND owner_id=$2',
      [turnId, ownerId],
    )
  ).rows[0];
}

async function turnChain(client: PoolClient, turn: TurnRow) {
  const chain = [turn];
  for (let current = turn; current.parent_turn_id;) {
    const next = await turnRow(client, current.parent_turn_id);
    if (!next || next.thread_id !== turn.thread_id || chain.some((item) => item.id === next.id))
      return undefined;
    chain.push(next);
    current = next;
  }
  return chain;
}

async function scheduleAuthority(client: PoolClient, turnId: string) {
  if (
    !(await client.query("SELECT to_regclass('schedule_runs') AS table_name")).rows[0]?.table_name
  )
    return undefined;
  return (
    await client.query<{
      authority_instruction: string | null;
      authority_source_message_id: string | null;
    }>(
      'SELECT authority_instruction,authority_source_message_id FROM schedule_runs WHERE turn_id=$1 AND owner_id=$2',
      [turnId, ownerId],
    )
  ).rows[0];
}

export async function turnOrigin(turnId: string) {
  const client = await pool.connect();
  try {
    const current = await turnRow(client, turnId);
    const chain = current && (await turnChain(client, current));
    const origin = chain?.at(-1);
    if (!chain || !origin) return undefined;
    return {
      source: origin.source,
      messageId: origin.source === 'user' ? origin.message_id : null,
      channel: current.channel,
      scheduleInstruction:
        origin.source === 'schedule'
          ? ((await scheduleAuthority(client, origin.id))?.authority_instruction ?? undefined)
          : undefined,
    };
  } finally {
    client.release();
  }
}

export async function createApprovals(
  execute: (
    action: string,
    args: Record<string, unknown>,
    context: ApprovalExecutionContext,
  ) => Promise<unknown>,
  preflight?: (action: string, args: Record<string, unknown>) => Promise<void>,
  interpret?: (reply: string) => Promise<boolean | undefined>,
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id),
    turn_id uuid REFERENCES turns(id), execution_turn_id uuid REFERENCES turns(id),
    action text NOT NULL, args jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    confirmation_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    result jsonb
  );
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS confirmation_reply_id;
    CREATE INDEX IF NOT EXISTS approvals_turn ON approvals(turn_id);
    CREATE INDEX IF NOT EXISTS approvals_execution_turn ON approvals(execution_turn_id);
    CREATE INDEX IF NOT EXISTS approvals_confirmation_message ON approvals(confirmation_message_id);
    CREATE INDEX IF NOT EXISTS approvals_memory_save ON approvals(owner_id,source_message_id) WHERE action='OTTO_memory_save';
    UPDATE approvals SET status='uncertain' WHERE status='executing';
  `);

  async function run(approval: Record<string, any>) {
    try {
      const result = await execute(approval.action, approval.args, {
        threadId: approval.thread_id,
        turnId: approval.execution_turn_id,
        sourceMessageId: approval.source_message_id,
      });
      const snapshot = JSON.parse(JSON.stringify(result ?? null));
      await pool.query(
        "UPDATE approvals SET status='completed',result=$2 WHERE id=$1 AND owner_id=$3 AND status='executing'",
        [approval.id, JSON.stringify(snapshot), ownerId],
      );
      return snapshot;
    } catch (error) {
      await pool.query(
        "UPDATE approvals SET status='uncertain' WHERE id=$1 AND owner_id=$2 AND status='executing'",
        [approval.id, ownerId],
      );
      throw Object.assign(
        new Error(
          `The action outcome is uncertain: ${error instanceof Error ? error.message : String(error)} Check the app before trying it again.`,
        ),
        { statusCode: 502 },
      );
    }
  }

  async function request(
    turn: TurnRef,
    action: string,
    args: Record<string, unknown>,
    options: {
      allowed?: boolean;
      question?: string;
      sourceMessageId?: string | null;
      admit?: (asks: boolean) => Promise<void>;
    } = {},
  ) {
    const encoded = JSON.stringify(args);
    if (!encoded) throw new Error('The action has no arguments to save.');
    const snapshot = JSON.parse(encoded) as Record<string, unknown>;
    const allowed = options.allowed === true;
    await options.admit?.(!allowed);
    const proposal = await withTurnLock(turn.turnId, async (client) => {
      const current = await turnRow(client, turn.turnId);
      if (!current || current.thread_id !== turn.threadId)
        throw conflict('This turn is no longer running.');
      const chain = await turnChain(client, current);
      const origin = chain?.at(-1);
      if (!chain || !origin) throw new Error('This action needs a direct request from the user.');
      let steering: { id: string; text: string } | undefined;
      if (options.sourceMessageId && options.sourceMessageId !== current.message_id) {
        if (!current.background)
          steering = (
            await client.query<{ id: string; text: string }>(
              "SELECT id,text FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND turn_id=$4 AND role='user'",
              [options.sourceMessageId, ownerId, turn.threadId, turn.turnId],
            )
          ).rows[0];
        if (!steering) throw new Error('This action needs a direct request from the user.');
      }
      const background = !steering && ['event', 'schedule'].includes(origin.source);
      let authorInstruction: string;
      let authorMessageId: string | null;
      if (steering) {
        authorInstruction = steering.text;
        authorMessageId = steering.id;
      } else if (origin.source === 'event') {
        authorInstruction = '';
        authorMessageId = null;
      } else if (origin.source === 'schedule') {
        const grant = await scheduleAuthority(client, origin.id);
        authorInstruction = grant?.authority_instruction ?? '';
        authorMessageId = grant?.authority_source_message_id ?? null;
      } else {
        const author =
          origin.source === 'user' && origin.message_id
            ? (
                await client.query<{ id: string; text: string }>(
                  "SELECT id,text FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'",
                  [origin.message_id, ownerId, origin.thread_id],
                )
              ).rows[0]
            : undefined;
        if (!author) throw new Error('This action needs a direct request from the user.');
        authorInstruction = author.text;
        authorMessageId = author.id;
      }
      await preflight?.(action, snapshot);
      if (background)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `approvals:${ownerId}:${turn.threadId}`,
        ]);
      const previous = (
        background
          ? await client.query(
              "SELECT * FROM approvals WHERE turn_id=ANY($1::uuid[]) AND owner_id=$2 AND action=$3 AND args=$4::jsonb AND status<>'expired' ORDER BY id LIMIT 1",
              [chain.map((item) => item.id), ownerId, action, snapshot],
            )
          : await client.query(
              "SELECT * FROM approvals WHERE thread_id=$1 AND owner_id=$2 AND source_message_id=$3 AND action=$4 AND args=$5::jsonb AND status<>'expired' ORDER BY id LIMIT 1",
              [turn.threadId, ownerId, authorMessageId, action, snapshot],
            )
      ).rows[0];
      if (previous) {
        if (previous.status === 'completed')
          return { cached: true as const, result: previous.result };
        throw conflict('This exact action already has a pending or uncertain outcome.');
      }
      if (
        !allowed &&
        (
          await client.query(
            "SELECT 1 FROM approvals WHERE turn_id=$1 AND owner_id=$2 AND status='pending'",
            [turn.turnId, ownerId],
          )
        ).rowCount
      )
        throw conflict('This turn is already waiting for an answer. Ask again after it.');
      if (background) {
        const pending = (
          await client.query(
            `SELECT a.*,m.text AS question FROM approvals a
             JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id AND u.thread_id=a.thread_id
             JOIN messages m ON m.id=a.confirmation_message_id AND m.owner_id=a.owner_id AND m.thread_id=a.thread_id AND m.role='assistant'
             WHERE a.owner_id=$1 AND a.thread_id=$2 AND a.action=$3 AND a.args=$4::jsonb
               AND a.status='pending' AND u.status IN ('running','waiting') AND u.channel=$5
             ORDER BY a.id LIMIT 1`,
            [ownerId, turn.threadId, action, snapshot, current.channel],
          )
        ).rows[0];
        if (pending)
          return {
            cached: false as const,
            approval: pending,
            question: pending.question as string,
          };
      }
      const direct = allowed;
      const id = randomUUID();
      let targetTitle: string | undefined;
      if (!direct && typeof snapshot.id === 'string') {
        const table = ['OTTO_schedule_update', 'OTTO_schedule_cancel'].includes(action)
          ? 'schedules'
          : undefined;
        if (table)
          targetTitle = (
            await client.query(`SELECT title FROM ${table} WHERE id=$1 AND owner_id=$2`, [
              snapshot.id,
              ownerId,
            ])
          ).rows[0]?.title;
      }
      const question = direct
        ? undefined
        : (options.question ?? actionConfirmation(action, snapshot, targetTitle));
      const messageId = question ? randomUUID() : null;
      if (messageId)
        await client.query(
          "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
          [messageId, ownerId, turn.threadId, turn.turnId, question],
        );
      const approval = (
        await client.query(
          'INSERT INTO approvals(id,owner_id,thread_id,turn_id,action,args,status,source_message_id,confirmation_message_id,execution_turn_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [
            id,
            ownerId,
            turn.threadId,
            turn.turnId,
            action,
            snapshot,
            direct ? 'executing' : 'pending',
            authorMessageId,
            messageId,
            direct ? turn.turnId : null,
          ],
        )
      ).rows[0];
      return { cached: false as const, approval, question };
    });
    if (proposal.cached) return proposal.result;
    if (proposal.question) {
      refresh();
      return { requiresConfirmation: true, question: proposal.question };
    }
    return run(proposal.approval);
  }

  async function confirmationFor(
    database: Pick<PoolClient, 'query'>,
    input: ChatConfirmationInput,
    lock: boolean,
  ) {
    const target =
      input.replyToMessageId ??
      (
        await database.query(
          `SELECT m.id FROM messages m JOIN turns u ON u.id=m.turn_id WHERE m.owner_id=$1 AND u.owner_id=$1 AND m.thread_id=$2 AND u.channel=$3 AND m.role='assistant'
           AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id=$4 AND s.owner_id=$1 AND s.thread_id=$2 AND date_trunc('milliseconds',s.created_at)<date_trunc('milliseconds',m.created_at))
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
          [ownerId, input.threadId, input.channel, input.seenMessageId ?? null],
        )
      ).rows[0]?.id;
    if (!target) return undefined;
    return (
      await database.query(
        `SELECT a.*,u.status AS turn_status,u.background AS turn_background,u.session_id AS turn_session_id,u.prompt AS turn_prompt
       FROM approvals a JOIN turns u ON u.id=a.turn_id
       WHERE a.confirmation_message_id=$1 AND a.owner_id=$2 AND u.owner_id=$2 AND a.thread_id=$3 AND u.thread_id=$3 AND u.channel=$4${lock ? ' FOR UPDATE OF a' : ''}`,
        [target, ownerId, input.threadId, input.channel],
      )
    ).rows[0];
  }

  async function answerChat(input: ChatConfirmationInput) {
    if (!interpret) return undefined;
    const approval = await confirmationFor(pool, input, false);
    if (!approval) return undefined;
    const approvalId = approval.id as string;
    if (input.hasAttachments) return { approvalId };
    try {
      const approved = await interpret(input.text);
      return approved === undefined ? { approvalId } : { approvalId, approved };
    } catch {
      return undefined;
    }
  }

  async function acceptChat(
    client: PoolClient,
    input: ChatConfirmationInput,
  ): Promise<ChatConfirmationResult> {
    const approval = await confirmationFor(client, input, true);
    if (!approval || !input.answer || approval.status !== 'pending') return undefined;
    const approved = input.answer.approvalId === approval.id ? input.answer.approved : undefined;
    const active = ['running', 'waiting'].includes(approval.turn_status);
    if (approved === undefined) {
      await client.query("UPDATE approvals SET status='expired' WHERE id=$1 AND owner_id=$2", [
        approval.id,
        ownerId,
      ]);
      if (active && approval.turn_background && input.replyToMessageId)
        return {
          waiting: {
            id: approval.turn_id as string,
            session_id: approval.turn_session_id as string,
            background: true,
          },
        };
      await client.query(
        "UPDATE turns SET status='cancelled',finished_at=now() WHERE id=$1 AND owner_id=$2 AND status='waiting'",
        [approval.turn_id, ownerId],
      );
      return undefined;
    }
    if (!active) return undefined;
    if (approved) await preflight?.(approval.action, approval.args);
    const prompt = approved
      ? 'The user confirmed the exact saved action. The trusted worker must execute that snapshot once before continuing. Do not substitute an action or execute it yourself.'
      : 'The user declined the saved action. Do not execute it or ask for it again. Continue only other already-authorized work, or finish quietly.';
    const background = Boolean(approval.turn_background);
    const turnId = await enqueueTurn(
      background ? `${prompt}\nThe request was: ${approval.turn_prompt}` : prompt,
      {
        source: 'resume',
        sourceId:
          input.sourceId ?? `confirmation:${approval.id}:${approved ? 'accepted' : 'declined'}`,
        channel: input.channel,
        background,
        sessionId: approval.turn_session_id,
        parentTurnId: approval.turn_id,
        client,
      },
    );
    const messageId = input.clientMessageId ?? randomUUID();
    await client.query('UPDATE turns SET message_id=$2 WHERE id=$1 AND owner_id=$3', [
      turnId,
      messageId,
      ownerId,
    ]);
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,reply_to_message_id) VALUES($1,$2,'user',$3,$4,$5,$6)",
      [messageId, ownerId, input.text, input.threadId, turnId, input.replyToMessageId ?? null],
    );
    await client.query('UPDATE approvals SET status=$2,execution_turn_id=$3 WHERE id=$1', [
      approval.id,
      approved ? 'confirmed' : 'declined',
      turnId,
    ]);
    return { threadId: input.threadId, turnId, messageId };
  }

  async function executeConfirmed(turnId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const approval = await withTurnLock(turnId, async (client) => {
      const selected = (
        await client.query(
          "SELECT * FROM approvals WHERE execution_turn_id=$1 AND owner_id=$2 AND status='confirmed' FOR UPDATE",
          [turnId, ownerId],
        )
      ).rows[0];
      if (!selected) return undefined;
      await preflight?.(selected.action, selected.args);
      signal.throwIfAborted();
      await client.query("UPDATE approvals SET status='executing' WHERE id=$1", [selected.id]);
      return selected;
    });
    if (!approval) return undefined;
    const result = await run(approval);
    const prompt = `The exact action confirmed by the user was executed once by the trusted worker. Do not repeat it. Continue from its result.\n${untrustedBlock(`${approval.action} result`, JSON.stringify(result) ?? 'null')}`;
    signal.throwIfAborted();
    return { prompt };
  }

  return { request, chat: { answer: answerChat, accept: acceptChat }, executeConfirmed };
}
