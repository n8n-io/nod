import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, transaction } from './db.ts';
import { ownerId } from './config.ts';
import { refresh } from './events.ts';
import {
  enqueueTurn,
  insertAssistantMessage,
  lockThread,
  noteStream,
  withTurnLock,
  type SubmitUserMessageResult,
  type TurnRef,
} from './thread.ts';
import { isReversiblePlanAction } from './action-policy.ts';
import { actionConfirmation } from './action-presentation.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { sessionOfMessageSql, taskOfTurn, taskSessionSql, turnChain } from './turn-chain.ts';
import { taskFolder } from '../ports/thread-identity.ts';

export interface ApprovalExecutionContext {
  threadId: string;
  turnId: string;
  sourceMessageId: string | null;
  sourceTurnId?: string;
  folder?: string;
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
  answer?: { approvalId: string; approved: boolean };
}

export type ChatConfirmationResult =
  SubmitUserMessageResult | { supersededApprovalId: string } | undefined;

function conflict(message = 'This confirmation is expired, already handled, or its turn changed.') {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const expiredQuestion = 'That question expired, so I did nothing.';
const appOnlyActions = ['OTTO_payment_approve', 'OTTO_payment_setting'];

const confirmationFields = `a.*,u.status AS turn_status,u.background AS turn_background,
  u.session_id AS turn_session_id,u.prompt AS turn_prompt,u.channel AS turn_channel,t.id AS task_id,
  t.channel AS task_channel,t.channel_source_id AS task_channel_source_id,t.on_it_message_id AS task_on_it,
  t.id IS NOT NULL AND a.expires_at<=now() AS timed_out,
  t.id IS NOT NULL AND EXISTS (SELECT 1 FROM turns q WHERE q.owner_id=u.owner_id
    AND q.session_id=u.session_id AND q.status='queued' AND q.source='user') AS task_replied`;
const confirmationFrom = `FROM approvals a
  JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id AND u.thread_id=a.thread_id
  LEFT JOIN tasks t ON t.id=u.session_id AND t.owner_id=u.owner_id`;
const otherOpenTaskQuestion = `EXISTS (SELECT 1 FROM approvals o
  JOIN turns v ON v.id=o.turn_id AND v.owner_id=o.owner_id AND v.thread_id=o.thread_id
  WHERE o.owner_id=a.owner_id AND o.thread_id=a.thread_id AND o.id<>a.id AND o.status='pending'
    AND o.confirmation_message_id IS NOT NULL AND o.expires_at>now()
    AND v.status IN ('running','waiting') AND v.channel=u.channel AND ${taskSessionSql('v')})`;

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

function author(
  origin: { source: string; message_id: string | null },
  task?: { source_message_id: string | null },
) {
  return origin.source === 'user' ? origin.message_id : (task?.source_message_id ?? null);
}

export async function turnOrigin(turn: TurnRef) {
  const client = await pool.connect();
  try {
    const { chain, origin, readOnly } = await turnChain(client, ownerId, turn);
    if (!origin) return undefined;
    const task = await taskOfTurn(client, ownerId, turn.turnId);
    return {
      source: task ? 'task' : origin.source,
      taskId: task?.id,
      channel: chain[0].channel,
      readOnly: readOnly || Boolean(task?.read_only),
      authorMessageId: author(origin, task),
      scheduleInstruction:
        !task && origin.source === 'schedule'
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
  decide?: (turn: TurnRef, action: string, args: Record<string, unknown>) => Promise<boolean>,
  interpret?: (reply: string) => Promise<boolean | undefined>,
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
      const task = await taskOfTurn(pool, ownerId, approval.execution_turn_id);
      const result = await execute(approval.action, approval.args, {
        threadId: approval.thread_id,
        turnId: approval.execution_turn_id,
        sourceMessageId: approval.source_message_id,
        ...(sourceTurnId ? { sourceTurnId } : {}),
        ...(task ? { folder: taskFolder(task.id) } : {}),
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
    options: { confirm?: boolean; question?: string; sourceMessageId?: string | null } = {},
  ) {
    const encoded = JSON.stringify(args);
    if (!encoded) throw new Error('The action has no arguments to save.');
    const snapshot = JSON.parse(encoded) as Record<string, unknown>;
    const allowed =
      !options.confirm && !options.question && decide
        ? await decide(turn, action, snapshot).catch(() => false)
        : false;
    const proposal = await withTurnLock(turn.turnId, async (client) => {
      const { chain, origin, readOnly } = await turnChain(client, ownerId, turn);
      const current = chain[0];
      if (!current) throw conflict('This turn is no longer running.');
      if (!origin) throw new Error('This action needs a direct request from the user.');
      const task = await taskOfTurn(client, ownerId, turn.turnId);
      if (readOnly || task?.read_only)
        throw new Error(
          'This action needs a direct request from the user; this turn is read-only.',
        );
      let steering: { id: string } | undefined;
      if (options.sourceMessageId && options.sourceMessageId !== current.message_id) {
        if (!current.background || task)
          steering = (
            await client.query<{ id: string }>(
              "SELECT id FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND turn_id=$4 AND role='user'",
              [options.sourceMessageId, ownerId, turn.threadId, turn.turnId],
            )
          ).rows[0];
        if (!steering) throw new Error('This action needs a direct request from the user.');
      }
      const background = !steering && !task && ['event', 'schedule'].includes(origin.source);
      let authorMessageId: string | null = null;
      if (steering) authorMessageId = steering.id;
      else if (background)
        authorMessageId =
          origin.source === 'schedule'
            ? ((await scheduleAuthority(client, origin.id))?.authority_source_message_id ?? null)
            : null;
      else {
        authorMessageId =
          (
            await client.query<{ id: string }>(
              "SELECT id FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3 AND role='user'",
              [author(origin, task), ownerId, origin.thread_id],
            )
          ).rows[0]?.id ?? null;
        if (!authorMessageId) throw new Error('This action needs a direct request from the user.');
      }
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
              `SELECT a.* FROM approvals a JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
               WHERE a.thread_id=$1 AND a.owner_id=$2 AND a.source_message_id=$3 AND a.action=$4
                 AND a.args=$5::jsonb AND u.session_id=$6
               ORDER BY a.id LIMIT 1`,
              [turn.threadId, ownerId, authorMessageId, action, snapshot, current.session_id],
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
      const messageId = question
        ? await insertAssistantMessage(
            client,
            turn,
            question,
            [],
            undefined,
            task?.on_it_message_id ?? undefined,
          )
        : null;
      const approval = (
        await client.query(
          `INSERT INTO approvals(id,owner_id,thread_id,turn_id,action,args,status,source_message_id,
             confirmation_message_id,execution_turn_id,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11::interval) RETURNING *`,
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
            task ? '24 hours' : '30 minutes',
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
    const lockRow = lock ? ' FOR UPDATE OF a' : '';
    const exact = (
      await database.query(
        `SELECT ${confirmationFields},${input.replyToMessageId ? 'false' : otherOpenTaskQuestion} AS ambiguous
         ${confirmationFrom}
         WHERE a.confirmation_message_id=$1 AND a.owner_id=$2 AND a.thread_id=$3 AND u.channel=$4${lockRow}`,
        [target, ownerId, input.threadId, input.channel],
      )
    ).rows[0];
    if (exact || !input.replyToMessageId) return exact;
    const pending = (
      await database.query(
        `SELECT ${confirmationFields},false AS ambiguous ${confirmationFrom}
         WHERE a.owner_id=$2 AND a.thread_id=$3 AND u.channel=$4 AND a.status='pending'
           AND a.confirmation_message_id IS NOT NULL AND u.status IN ('running','waiting')
           AND t.id=(SELECT ${sessionOfMessageSql('m')} FROM messages m
             WHERE m.id=$1 AND m.owner_id=$2 AND m.thread_id=$3)
         LIMIT 2${lockRow}`,
        [target, ownerId, input.threadId, input.channel],
      )
    ).rows;
    return pending.length === 1 ? pending[0] : undefined;
  }

  async function answerChat(input: ChatConfirmationInput) {
    if (input.hasAttachments || !interpret) return undefined;
    const approval = await confirmationFor(pool, input, false);
    if (!approval) return undefined;
    const approved = await interpret(input.text).catch(() => undefined);
    return approved === undefined ? undefined : { approvalId: approval.id as string, approved };
  }

  async function resume(
    client: PoolClient,
    approval: Record<string, any>,
    approved: boolean,
    input: Pick<
      ChatConfirmationInput,
      'text' | 'threadId' | 'replyToMessageId' | 'clientMessageId' | 'sourceId'
    >,
  ) {
    if (approved) await preflight?.(approval.action, approval.args);
    const prompt = approved
      ? 'The user confirmed the exact saved action. The trusted worker must execute that snapshot once before continuing. Do not substitute an action or execute it yourself.'
      : 'The user declined the saved action. Do not execute it or ask for it again. Continue only other already-authorized work, or finish quietly.';
    const background = Boolean(approval.turn_background);
    const turnId = await enqueueTurn(
      background && !approval.task_id
        ? `${prompt}\nThe request was: ${approval.turn_prompt}`
        : prompt,
      {
        source: 'resume',
        sourceId:
          input.sourceId ?? `confirmation:${approval.id}:${approved ? 'accepted' : 'declined'}`,
        channel: approval.task_channel ?? approval.turn_channel,
        channelSourceId: approval.task_channel_source_id,
        background,
        sessionId: approval.turn_session_id,
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
    await client.query(
      'UPDATE approvals SET status=$2,confirmation_reply_id=$3,execution_turn_id=$4 WHERE id=$1',
      [approval.id, approved ? 'confirmed' : 'declined', messageId, turnId],
    );
    return { threadId: input.threadId, turnId, messageId };
  }

  async function answerExpired(
    client: PoolClient,
    approval: Record<string, any>,
    input: ChatConfirmationInput,
  ) {
    const messageId = input.clientMessageId ?? randomUUID();
    const turn = { threadId: input.threadId, turnId: approval.turn_id as string };
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,reply_to_message_id) VALUES($1,$2,'user',$3,$4,$5,$6)",
      [messageId, ownerId, input.text, input.threadId, turn.turnId, input.replyToMessageId ?? null],
    );
    await insertAssistantMessage(
      client,
      turn,
      expiredQuestion,
      [],
      noteStream(),
      approval.task_on_it,
    );
    await client.query(
      "UPDATE approvals SET status='expired',confirmation_reply_id=$2 WHERE id=$1 AND owner_id=$3",
      [approval.id, messageId, ownerId],
    );
    return { ...turn, messageId };
  }

  async function acceptChat(
    client: PoolClient,
    input: ChatConfirmationInput,
  ): Promise<ChatConfirmationResult> {
    const approval = await confirmationFor(client, input, true);
    if (!approval) return undefined;
    const answer = input.answer;
    const approved =
      answer && answer.approvalId === approval.id && !approval.ambiguous
        ? answer.approved
        : undefined;
    if (
      approval.task_id &&
      !input.replyToMessageId &&
      (approved === undefined || approval.task_replied)
    )
      return undefined;
    if (approved !== undefined && approval.status === 'pending' && approval.timed_out)
      return answerExpired(client, approval, input);
    if (approved === undefined || approval.task_replied) {
      if (approval.status === 'pending') {
        await client.query("UPDATE approvals SET status='expired' WHERE id=$1 AND owner_id=$2", [
          approval.id,
          ownerId,
        ]);
        return { supersededApprovalId: approval.id };
      }
      return undefined;
    }
    if (approval.status !== 'pending' || !['running', 'waiting'].includes(approval.turn_status))
      return undefined;
    return resume(client, approval, approved, input);
  }

  async function answer(input: { approvalId: string; approved: boolean; channel: string }) {
    const result = await transaction(async (client) => {
      const thread = await lockThread(client);
      const approval = (
        await client.query(
          `SELECT ${confirmationFields} ${confirmationFrom}
           WHERE a.id=$1 AND a.owner_id=$2 AND a.thread_id=$3 FOR UPDATE OF a`,
          [input.approvalId, ownerId, thread.id],
        )
      ).rows[0];
      if (approval?.status === 'pending' && approval.timed_out) throw conflict(expiredQuestion);
      if (
        approval?.status !== 'pending' ||
        approval.task_replied ||
        !['running', 'waiting'].includes(approval.turn_status)
      )
        throw conflict();
      if (input.channel !== 'web' && appOnlyActions.includes(approval.action))
        throw conflict('Answer this question in the Otto app.');
      return resume(client, approval, input.approved, {
        text: input.approved ? 'Yes' : 'No',
        threadId: thread.id,
        replyToMessageId: approval.confirmation_message_id,
      });
    });
    refresh();
    return result;
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

  return { request, answer, chat: { answer: answerChat, accept: acceptChat }, executeConfirmed };
}
