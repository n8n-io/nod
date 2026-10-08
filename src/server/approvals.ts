import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.ts';
import { ownerId } from './config.ts';
import { refresh } from './events.ts';
import { enqueueTurn, withTurnLock, type SubmitUserMessageResult, type TurnRef } from './thread.ts';
import {
  confirmationAnswer,
  explicitlyRequestsAction,
  isReversiblePlanAction,
  requestsSchedule,
} from './action-policy.ts';
import { actionConfirmation } from './action-presentation.ts';
import { untrustedBlock } from '../shared/untrusted.ts';

export interface ApprovalExecutionContext {
  threadId: string;
  turnId: string;
  sourceMessageId: string | null;
  sourceTurnId?: string;
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
}

export type ChatConfirmationResult =
  SubmitUserMessageResult | { supersededApprovalId: string } | undefined;

type TurnRow = {
  id: string;
  thread_id: string;
  source: string;
  source_id: string | null;
  message_id: string | null;
  prompt: string;
  read_only: boolean;
  background: boolean;
  channel: string;
};

function conflict(message = 'This confirmation is expired, already handled, or its turn changed.') {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function turnRow(client: PoolClient, turnId: string) {
  return (
    await client.query<TurnRow>(
      'SELECT id,thread_id,source,source_id,message_id,prompt,read_only,background,channel FROM turns WHERE id=$1 AND owner_id=$2',
      [turnId, ownerId],
    )
  ).rows[0];
}

async function confirmedBy(client: PoolClient, turn: TurnRow) {
  if (turn.source !== 'resume') return undefined;
  return (
    await client.query<{ turn_id: string; status: string }>(
      'SELECT turn_id,status FROM approvals WHERE execution_turn_id=$1 AND owner_id=$2 AND turn_id IS DISTINCT FROM execution_turn_id LIMIT 1',
      [turn.id, ownerId],
    )
  ).rows[0];
}

async function turnChain(client: PoolClient, turn: TurnRow) {
  const chain = [turn];
  let current = turn;
  for (let depth = 0; depth < 20; depth++) {
    if (current.source !== 'resume') return chain;
    const linked =
      (await confirmedBy(client, current))?.turn_id ??
      /^(?:credentials|credentials-retry|connection):([0-9a-f-]{36})(?::|$)/.exec(
        current.source_id ?? '',
      )?.[1];
    if (!linked) return chain;
    const next = await turnRow(client, linked);
    if (!next || next.thread_id !== turn.thread_id) return undefined;
    chain.push(next);
    current = next;
  }
  return undefined;
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

const readOnlyChain = (chain: TurnRow[]) =>
  chain.some((item) => item.read_only || item.source_id?.startsWith('onboarding:'));

export async function turnOrigin(turnId: string) {
  const client = await pool.connect();
  try {
    const current = await turnRow(client, turnId);
    const chain = current && (await turnChain(client, current));
    const origin = chain?.at(-1);
    if (!chain || !origin) return undefined;
    return {
      source: origin.source,
      readOnly: readOnlyChain(chain),
      scheduleInstruction:
        origin.source === 'schedule'
          ? ((await scheduleAuthority(client, origin.id))?.authority_instruction ?? undefined)
          : undefined,
    };
  } finally {
    client.release();
  }
}

async function resumeKind(client: PoolClient, turn: TurnRow) {
  if (turn.source !== 'resume') return null;
  const confirmation = await confirmedBy(client, turn);
  if (confirmation) return confirmation.status === 'declined' ? null : 'approval';
  if (turn.source_id?.startsWith('credentials:')) return 'credentials';
  if (turn.source_id?.startsWith('connection:')) return 'connection';
  return null;
}

export async function createApprovals(
  execute: (
    action: string,
    args: Record<string, unknown>,
    context: ApprovalExecutionContext,
  ) => Promise<unknown>,
  preflight?: (action: string, args: Record<string, unknown>) => Promise<void>,
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id),
    turn_id uuid REFERENCES turns(id), execution_turn_id uuid REFERENCES turns(id),
    action text NOT NULL, args jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
    source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    confirmation_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    confirmation_reply_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    result jsonb
  );
    CREATE INDEX IF NOT EXISTS approvals_turn ON approvals(turn_id);
    CREATE INDEX IF NOT EXISTS approvals_execution_turn ON approvals(execution_turn_id);
    CREATE INDEX IF NOT EXISTS approvals_confirmation_message ON approvals(confirmation_message_id);
    UPDATE approvals SET status='uncertain' WHERE status='executing';
  `);

  async function run(approval: Record<string, any>) {
    try {
      let sourceTurnId: string | undefined;
      if (isReversiblePlanAction(approval.action) && approval.source_message_id) {
        const source = (
          await pool.query<{ turn_id: string }>(
            "SELECT turn_id FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'",
            [approval.source_message_id, ownerId, approval.thread_id],
          )
        ).rows[0];
        if (!source?.turn_id) throw new Error('The schedule instruction is unavailable.');
        sourceTurnId = source.turn_id;
      }
      const result = await execute(approval.action, approval.args, {
        threadId: approval.thread_id,
        turnId: approval.execution_turn_id,
        sourceMessageId: approval.source_message_id,
        ...(sourceTurnId ? { sourceTurnId } : {}),
      });
      const snapshot = JSON.parse(JSON.stringify(result ?? null));
      await pool.query(
        "UPDATE approvals SET status='completed',result=$2 WHERE id=$1 AND owner_id=$3 AND status='executing'",
        [approval.id, snapshot, ownerId],
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
    options: { confirm?: boolean; question?: string; sourceMessageId?: string | null } = {},
  ) {
    const encoded = JSON.stringify(args);
    if (!encoded || encoded.length > 32768) throw new Error('The action is too large.');
    const snapshot = JSON.parse(encoded) as Record<string, unknown>;
    const proposal = await withTurnLock(turn.turnId, async (client) => {
      const current = await turnRow(client, turn.turnId);
      if (!current || current.thread_id !== turn.threadId)
        throw conflict('This turn is no longer running.');
      const chain = await turnChain(client, current);
      const origin = chain?.at(-1);
      if (!chain || !origin) throw new Error('This action needs a direct request from the user.');
      if (readOnlyChain(chain))
        throw new Error(
          'This action needs a direct request from the user; this turn is read-only.',
        );
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
      const revision =
        !background && authorMessageId
          ? Boolean(
              (
                await client.query(
                  "SELECT 1 FROM approvals WHERE owner_id=$1 AND thread_id=$2 AND confirmation_reply_id=$3 AND status='expired' LIMIT 1",
                  [ownerId, turn.threadId, authorMessageId],
                )
              ).rowCount,
            )
          : false;
      const explicit = explicitlyRequestsAction(action, authorInstruction);
      const currentSource = Boolean(steering) || authorInstruction === current.prompt;
      const kind = await resumeKind(client, current);
      const resumedSource =
        requestsSchedule(action, authorInstruction) &&
        (kind === 'connection' ||
          (kind === 'approval' && (await confirmedBy(client, current))?.status === 'completed'));
      if (
        !options.question &&
        !background &&
        !currentSource &&
        !resumedSource &&
        !(revision && kind !== null)
      )
        throw new Error('This action needs a direct request from the user.');
      await preflight?.(action, snapshot);
      if (background)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `approvals:${ownerId}:${turn.threadId}`,
        ]);
      const previous = (
        background
          ? await client.query(
              'SELECT * FROM approvals WHERE turn_id=ANY($1::uuid[]) AND owner_id=$2 AND action=$3 AND args=$4::jsonb ORDER BY id LIMIT 1',
              [chain.map((item) => item.id), ownerId, action, snapshot],
            )
          : await client.query(
              'SELECT * FROM approvals WHERE thread_id=$1 AND owner_id=$2 AND source_message_id=$3 AND action=$4 AND args=$5::jsonb ORDER BY id LIMIT 1',
              [turn.threadId, ownerId, authorMessageId, action, snapshot],
            )
      ).rows[0];
      if (previous) {
        if (previous.status === 'completed')
          return { cached: true as const, result: previous.result };
        throw conflict('This exact action already has a pending or uncertain outcome.');
      }
      if (background) {
        const pending = (
          await client.query(
            `SELECT a.*,m.text AS question FROM approvals a
             JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id AND u.thread_id=a.thread_id
             JOIN messages m ON m.id=a.confirmation_message_id AND m.owner_id=a.owner_id AND m.thread_id=a.thread_id AND m.role='assistant'
             WHERE a.owner_id=$1 AND a.thread_id=$2 AND a.action=$3 AND a.args=$4::jsonb
               AND a.status='pending' AND a.expires_at>now() AND u.status IN ('running','waiting') AND u.channel=$5
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
      const direct =
        !options.confirm &&
        !options.question &&
        !background &&
        ((isReversiblePlanAction(action) && (!revision || currentSource)) ||
          (!revision && explicit));
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
      if (question && question.length > 6000)
        throw new Error('This action is too large to confirm clearly. Use a smaller action.');
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

  async function acceptChat(
    client: PoolClient,
    input: ChatConfirmationInput,
  ): Promise<ChatConfirmationResult> {
    const approved = input.hasAttachments ? undefined : confirmationAnswer(input.text);
    const target =
      input.replyToMessageId ??
      (
        await client.query(
          `SELECT m.id FROM messages m JOIN turns u ON u.id=m.turn_id WHERE m.owner_id=$1 AND u.owner_id=$1 AND m.thread_id=$2 AND u.channel=$3 AND m.role='assistant'
           AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id=$4 AND s.owner_id=$1 AND s.thread_id=$2 AND date_trunc('milliseconds',s.created_at)<date_trunc('milliseconds',m.created_at))
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
          [ownerId, input.threadId, input.channel, input.seenMessageId ?? null],
        )
      ).rows[0]?.id;
    if (!target) return undefined;
    const approval = (
      await client.query(
        `SELECT a.*,u.status AS turn_status FROM approvals a JOIN turns u ON u.id=a.turn_id
       WHERE a.confirmation_message_id=$1 AND a.owner_id=$2 AND u.owner_id=$2 AND a.thread_id=$3 AND u.thread_id=$3 AND u.channel=$4 FOR UPDATE OF a`,
        [target, ownerId, input.threadId, input.channel],
      )
    ).rows[0];
    if (!approval) return undefined;
    if (approved === undefined) {
      if (approval.status === 'pending') {
        await client.query("UPDATE approvals SET status='expired' WHERE id=$1 AND owner_id=$2", [
          approval.id,
          ownerId,
        ]);
        return { supersededApprovalId: approval.id };
      }
      return undefined;
    }
    if (
      approval.status !== 'pending' ||
      !['running', 'waiting'].includes(approval.turn_status) ||
      new Date(approval.expires_at).getTime() <= Date.now()
    )
      throw conflict();
    if (approved) await preflight?.(approval.action, approval.args);
    const prompt = approved
      ? 'The user confirmed the exact saved action. The trusted worker must execute that snapshot once before continuing. Do not substitute an action or execute it yourself.'
      : 'The user declined the saved action. Do not execute it or ask for it again. Continue only other already-authorized work, or finish quietly.';
    const turnId = await enqueueTurn(prompt, {
      source: 'resume',
      sourceId:
        input.sourceId ?? `confirmation:${approval.id}:${approved ? 'accepted' : 'declined'}`,
      channel: input.channel,
      background: false,
      client,
    });
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
    await client.query(
      'UPDATE approvals SET status=$2,confirmation_reply_id=$3,execution_turn_id=$4 WHERE id=$1',
      [approval.id, approved ? 'confirmed' : 'declined', messageId, turnId],
    );
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

  return { request, acceptChat, executeConfirmed };
}
