import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.ts';
import { ownerId } from './config.ts';
import { refresh } from './events.ts';
import {
  abortTurns,
  enqueueTurn,
  withTurnLock,
  type SubmitUserMessageResult,
  type TurnRef,
  type TurnSource,
} from './thread.ts';
import { appConfirmation } from '../ports/agent.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import { localTimestamp } from '../shared/date-locale.ts';
import { lockKey, locksTable } from './locks.ts';
import { afterCommit } from './transaction.ts';
import type { CaptureAnalytics } from './analytics.ts';

export interface ApprovalExecutionContext {
  threadId: string;
  turnId: string;
  sourceMessageId: string | null;
  signal?: AbortSignal;
  details?: Record<string, unknown>;
  expectedRevision?: number;
}

export interface ApprovalWork {
  kind: 'schedule' | 'task';
  title: string;
  ownerRequest?: string;
  waitsForAnswer?: true;
}

export interface ApprovalDescription {
  turn: TurnRef;
  action: string;
  args: Record<string, unknown>;
  details?: Record<string, unknown>;
  work?: ApprovalWork;
}

export interface ChatConfirmationInput {
  text: string;
  displayText?: string;
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
  task_id: string | null;
  source: string;
  parent_turn_id: string | null;
  message_id: string | null;
  prompt: string;
  background: boolean;
  channel: string;
};

const notRun = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { notRun?: unknown }).notRun === true);

function conflict(message = 'This confirmation is expired, already handled, or its turn changed.') {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function confirmedOutcome(
  action: string,
  { status, result, error }: { status: string; result?: unknown; error?: unknown },
  resumed = false,
) {
  if (status === 'completed') {
    const legacyPause = action === 'NOD_schedule_cancel';
    const schedule = legacyPause
      ? (result as {
          kind?: string;
          enabled?: boolean;
          runAt?: string | null;
          lastRun?: { scheduledFor?: string } | null;
        })
      : null;
    const paused =
      schedule?.enabled === false &&
      (schedule.kind === 'recurring' ||
        (schedule.kind === 'once' && schedule.lastRun?.scheduledFor !== schedule.runAt));
    return `The exact action confirmed by the user was executed once by the trusted worker. Do not repeat it.${resumed ? ' Continue from its result.' : ''}${paused ? ' The schedule is paused, remains in Scheduled, and can be resumed.' : ''}\n${untrustedBlock(`${legacyPause ? 'NOD_schedule_pause' : action} result`, JSON.stringify(result))}`;
  }
  const failure =
    error === undefined
      ? ''
      : `\n${untrustedBlock(`${action} error`, error instanceof Error ? error.message : String(error))}`;
  return status === 'uncertain' || status === 'executing'
    ? `The action the user confirmed failed or was interrupted and will not be retried. Its outcome is uncertain, so check the app before trying it again. Do not report it as done.${failure}`
    : `The action the user confirmed did not run, so nothing was done. Do not report it as done.${failure}`;
}

async function turnRow(client: PoolClient, turnId: string) {
  return (
    await client.query<TurnRow>(
      "SELECT id,thread_id,to_jsonb(turns)->>'task_id' AS task_id,source,parent_turn_id,message_id,prompt,background,channel FROM turns WHERE id=$1 AND owner_id=$2",
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
      scheduled_for: Date;
      time_zone: string;
      title: string;
      kind: string | null;
    }>(
      `SELECT r.authority_instruction,r.authority_source_message_id,r.scheduled_for,r.time_zone,r.title,s.kind
       FROM schedule_runs r LEFT JOIN schedules s ON s.id=r.schedule_id AND s.owner_id=r.owner_id
       WHERE r.turn_id=$1 AND r.owner_id=$2`,
      [turnId, ownerId],
    )
  ).rows[0];
}

async function workOf(
  client: PoolClient,
  taskId: string | null,
  schedule: Awaited<ReturnType<typeof scheduleAuthority>>,
): Promise<ApprovalWork | undefined> {
  if (schedule)
    return {
      kind: 'schedule',
      title: schedule.title,
      ...(schedule.authority_instruction ? { ownerRequest: schedule.authority_instruction } : {}),
      ...(schedule.kind === 'recurring' ? { waitsForAnswer: true as const } : {}),
    };
  if (!taskId) return undefined;
  const task = (
    await client.query<{ title: string; request: string | null }>(
      `SELECT t.title,m.text AS request FROM tasks t
       LEFT JOIN messages m ON m.id=t.source_message_id AND m.owner_id=t.owner_id AND m.role='user'
       WHERE t.id=$1 AND t.owner_id=$2`,
      [taskId, ownerId],
    )
  ).rows[0];
  return (
    task && {
      kind: 'task',
      title: task.title,
      ...(task.request ? { ownerRequest: task.request } : {}),
    }
  );
}

export async function turnOrigin(turnId: string) {
  const client = await pool.connect();
  try {
    const current = await turnRow(client, turnId);
    const chain = current && (await turnChain(client, current));
    const origin = chain?.at(-1);
    if (!chain || !origin) return undefined;
    const run =
      origin.source === 'schedule' ? await scheduleAuthority(client, origin.id) : undefined;
    const task = current.task_id
      ? (
          await client.query<{ source_message_id: string | null }>(
            'SELECT source_message_id FROM tasks WHERE id=$1 AND owner_id=$2',
            [current.task_id, ownerId],
          )
        ).rows[0]
      : undefined;
    const said =
      origin.source === 'user'
        ? [
            ...new Set([
              ...chain.flatMap((turn) => (turn.message_id ? [turn.message_id] : [])),
              ...(task?.source_message_id ? [task.source_message_id] : []),
            ]),
          ]
        : [];
    return {
      taskId: current.task_id,
      source: origin.source,
      messageIds: said,
      channel: current.channel,
      scheduleInstruction: run?.authority_instruction ?? undefined,
      ...(run
        ? {
            scheduledFor: localTimestamp(run.time_zone, run.scheduled_for),
            timeZone: run.time_zone,
          }
        : {}),
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
  preflight?: (
    action: string,
    args: Record<string, unknown>,
    expectedRevision?: number,
    client?: PoolClient,
  ) => Promise<void>,
  interpret?: (reply: string) => Promise<boolean | undefined>,
  describe?: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<string>,
  analytics?: CaptureAnalytics,
) {
  const changed = (
    status: 'asked' | 'approved' | 'declined' | 'executed' | 'expired' | 'uncertain',
    action: string,
    source: string,
  ) => {
    if (!['user', 'schedule', 'event', 'resume', 'task'].includes(source)) return;
    analytics?.({
      event: 'confirmation_changed',
      properties: {
        status,
        action_kind:
          action === 'NOD_browser'
            ? 'browser'
            : action === 'NOD_vault_allow'
              ? 'sign_in'
              : action.startsWith('NOD_memory_')
                ? 'memory'
                : action.startsWith('NOD_')
                  ? 'settings'
                  : 'app',
        source: source as TurnSource,
      },
    });
  };
  await pool.query(`${locksTable};
  CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id),
    turn_id uuid REFERENCES turns(id), execution_turn_id uuid REFERENCES turns(id),
    action text NOT NULL, args jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    confirmation_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    result jsonb
  );
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS expected_revision integer,
      ADD COLUMN IF NOT EXISTS details jsonb;
    CREATE INDEX IF NOT EXISTS approvals_turn ON approvals(turn_id);
    CREATE INDEX IF NOT EXISTS approvals_execution_turn ON approvals(execution_turn_id);
    CREATE INDEX IF NOT EXISTS approvals_confirmation_message ON approvals(confirmation_message_id);
    CREATE INDEX IF NOT EXISTS approvals_memory_save ON approvals(owner_id,source_message_id) WHERE action='NOD_memory_save';
    UPDATE approvals SET status='uncertain' WHERE status='executing';
  `);

  async function request(
    turn: TurnRef,
    action: string,
    args: Record<string, unknown>,
    options: {
      allowed?: boolean;
      run?: () => Promise<unknown>;
      details?: Record<string, unknown>;
      signal?: AbortSignal;
      sourceMessageId?: string | null;
      admit?: (asks: boolean) => Promise<void>;
      validate?: (client: PoolClient) => Promise<void>;
      expectedRevision?: number;
    } = {},
  ) {
    const encoded = JSON.stringify(args);
    if (!encoded) throw new Error('The action has no arguments to save.');
    const snapshot = JSON.parse(encoded) as Record<string, unknown>;
    const details = options.details ? JSON.stringify(options.details) : undefined;
    turn = { ...turn };
    const allowed = options.allowed === true;
    const expectedRevision = options.expectedRevision;
    options.signal?.throwIfAborted();
    await options.admit?.(!allowed);
    const inspect = async (client: PoolClient, describing = false) => {
      options.signal?.throwIfAborted();
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
      let authorMessageId: string | null;
      const schedule =
        origin.source === 'schedule' ? await scheduleAuthority(client, origin.id) : undefined;
      if (steering) {
        authorMessageId = steering.id;
      } else if (origin.source === 'event') {
        authorMessageId = null;
      } else if (origin.source === 'schedule') {
        authorMessageId = schedule?.authority_source_message_id ?? null;
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
        authorMessageId = author.id;
      }
      if (background) await lockKey(client, `approvals:${ownerId}:${turn.threadId}`);
      let previous = (
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
      if (
        previous?.status === 'pending' &&
        !(
          await client.query(
            "SELECT 1 FROM turns WHERE id=$1 AND owner_id=$2 AND status IN ('running','waiting')",
            [previous.turn_id, ownerId],
          )
        ).rowCount
      ) {
        await client.query("UPDATE approvals SET status='expired' WHERE id=$1 AND owner_id=$2", [
          previous.id,
          ownerId,
        ]);
        afterCommit(client, () => changed('expired', action, current.source));
        previous = undefined;
      }
      if (previous) {
        if (previous.status === 'completed')
          return { cached: true as const, result: previous.result };
        throw conflict('This exact action already has a pending or uncertain outcome.');
      }
      await preflight?.(action, snapshot, expectedRevision, client);
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
               AND a.expected_revision IS NOT DISTINCT FROM $6::integer
             ORDER BY a.id LIMIT 1`,
            [ownerId, turn.threadId, action, snapshot, current.channel, expectedRevision ?? null],
          )
        ).rows[0];
        if (pending)
          return {
            cached: false as const,
            approval: pending,
            question: pending.question as string,
          };
      }
      return {
        authorMessageId,
        source: current.source,
        ...(describing ? { work: await workOf(client, current.task_id, schedule) } : {}),
      };
    };
    let question: string | undefined;
    if (!allowed) {
      const existing = await withTurnLock(turn.turnId, (client) => inspect(client, true));
      if ('cached' in existing) {
        if (existing.cached) return existing.result;
        return { [appConfirmation]: existing.question as string };
      }
      if (!describe) throw new Error('The confirmation model is unavailable.');
      question = await describe(
        {
          turn: { ...turn },
          action,
          args: JSON.parse(encoded),
          ...(details ? { details: JSON.parse(details) } : {}),
          ...(existing.work ? { work: existing.work } : {}),
        },
        options.signal,
      );
      options.signal?.throwIfAborted();
      if (typeof question !== 'string' || !question.trim())
        throw new Error('The confirmation model did not produce a valid question.');
    }
    const proposal = await withTurnLock(turn.turnId, async (client) => {
      const inspected = await inspect(client);
      if ('cached' in inspected) return inspected;
      await options.validate?.(client);
      options.signal?.throwIfAborted();
      if (!question) return { cached: false as const, authorMessageId: inspected.authorMessageId };
      const messageId = randomUUID();
      await client.query(
        "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
        [messageId, ownerId, turn.threadId, turn.turnId, question],
      );
      const approval = (
        await client.query(
          "INSERT INTO approvals(id,owner_id,thread_id,turn_id,action,args,status,source_message_id,confirmation_message_id,expected_revision,details) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10::jsonb) RETURNING *",
          [
            randomUUID(),
            ownerId,
            turn.threadId,
            turn.turnId,
            action,
            snapshot,
            inspected.authorMessageId,
            messageId,
            expectedRevision ?? null,
            details ?? null,
          ],
        )
      ).rows[0];
      options.signal?.throwIfAborted();
      return { cached: false as const, approval, question, source: inspected.source };
    });
    if (proposal.cached) return proposal.result;
    if ('question' in proposal) {
      if ('source' in proposal && proposal.source) changed('asked', action, proposal.source);
      refresh();
      return { [appConfirmation]: proposal.question as string };
    }
    if (options.run) return options.run();
    return execute(action, snapshot, {
      threadId: turn.threadId,
      turnId: turn.turnId,
      sourceMessageId: proposal.authorMessageId,
      signal: options.signal,
      ...(options.details ? { details: options.details } : {}),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
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
          `SELECT m.id FROM messages m JOIN turns u ON u.id=m.turn_id WHERE m.owner_id=$1 AND u.owner_id=$1 AND m.thread_id=$2 AND u.channel=$3 AND m.role='assistant' AND m.hidden_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id=$4 AND s.owner_id=$1 AND s.thread_id=$2 AND date_trunc('milliseconds',s.created_at)<date_trunc('milliseconds',m.created_at))
           AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.owner_id=$1 AND n.thread_id=$2 AND n.role='assistant' AND n.turn_id IS NULL AND n.delivered_channel=$3 AND n.hidden_at IS NULL
             AND (n.created_at,n.id)>(m.created_at,m.id)
             AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.id=$4 AND s.owner_id=$1 AND s.thread_id=$2 AND date_trunc('milliseconds',s.created_at)<date_trunc('milliseconds',n.created_at)))
           ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
          [ownerId, input.threadId, input.channel, input.seenMessageId ?? null],
        )
      ).rows[0]?.id;
    if (!target) return undefined;
    return (
      await database.query(
        `SELECT a.*,u.source AS turn_source,u.status AS turn_status,u.background AS turn_background,u.session_id AS turn_session_id,u.prompt AS turn_prompt
       FROM approvals a JOIN turns u ON u.id=a.turn_id
       WHERE a.confirmation_message_id=COALESCE((SELECT m.reply_to_message_id FROM messages m
         WHERE m.id=$1 AND m.owner_id=$2 AND m.thread_id=$3 AND m.role='assistant' AND m.turn_id IS NULL AND m.hidden_at IS NULL),$1)
         AND a.owner_id=$2 AND u.owner_id=$2 AND a.thread_id=$3 AND u.thread_id=$3 AND u.channel=$4
         AND EXISTS (SELECT 1 FROM messages c WHERE c.id=a.confirmation_message_id AND c.owner_id=a.owner_id AND c.hidden_at IS NULL)
         AND (to_jsonb(u)->>'task_id' IS NULL OR NOT EXISTS (
           SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.session_id=u.session_id AND n.id<>u.id
             AND n.source IN ('user','task') AND n.message_id IS NOT NULL AND n.status IN ('queued','running')))
       ${lock ? ' FOR UPDATE OF a' : ''}`,
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
    onInserted?: () => void,
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
      afterCommit(client, () => changed('expired', approval.action, approval.turn_source));
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
      "INSERT INTO messages(id,owner_id,role,text,display_text,thread_id,turn_id,reply_to_message_id) VALUES($1,$2,'user',$3,$4,$5,$6,$7)",
      [
        messageId,
        ownerId,
        input.text,
        input.displayText ?? null,
        input.threadId,
        turnId,
        input.replyToMessageId ?? null,
      ],
    );
    await client.query('UPDATE approvals SET status=$2,execution_turn_id=$3 WHERE id=$1', [
      approval.id,
      approved ? 'confirmed' : 'declined',
      turnId,
    ]);
    afterCommit(client, () =>
      changed(approved ? 'approved' : 'declined', approval.action, approval.turn_source),
    );
    onInserted?.();
    return { threadId: input.threadId, turnId, messageId };
  }

  async function executeConfirmed(turnId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const approval = await withTurnLock(turnId, async (client) => {
      const selected = (
        await client.query(
          "SELECT a.*,u.source AS turn_source FROM approvals a JOIN turns u ON u.id=a.turn_id WHERE a.execution_turn_id=$1 AND a.owner_id=$2 AND a.status='confirmed' FOR UPDATE OF a",
          [turnId, ownerId],
        )
      ).rows[0];
      if (!selected) return undefined;
      const refused = await preflight?.(
        selected.action,
        selected.args,
        selected.expected_revision ?? undefined,
        client,
      ).then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      signal.throwIfAborted();
      await client.query('UPDATE approvals SET status=$2 WHERE id=$1', [
        selected.id,
        refused ? 'expired' : 'executing',
      ]);
      return { ...selected, refused };
    });
    if (!approval) return undefined;
    const outcome: {
      status: 'completed' | 'expired' | 'uncertain';
      result?: unknown;
      error?: unknown;
    } = approval.refused
      ? { status: 'expired', error: approval.refused.error }
      : await execute(approval.action, approval.args, {
          threadId: approval.thread_id,
          turnId,
          sourceMessageId: approval.source_message_id,
          signal,
          ...(approval.details ? { details: approval.details } : {}),
          ...(approval.expected_revision === null
            ? {}
            : { expectedRevision: approval.expected_revision }),
        })
          .then((result) => ({
            status: 'completed' as const,
            result: JSON.parse(JSON.stringify(result ?? null)),
          }))
          .catch((error: unknown) => ({
            status: notRun(error) ? ('expired' as const) : ('uncertain' as const),
            error,
          }));
    if (!approval.refused)
      await pool.query(
        "UPDATE approvals SET status=$2,result=$3 WHERE id=$1 AND owner_id=$4 AND status='executing'",
        [
          approval.id,
          outcome.status,
          outcome.status === 'completed' ? JSON.stringify(outcome.result) : null,
          ownerId,
        ],
      );
    changed(
      outcome.status === 'completed' ? 'executed' : outcome.status,
      approval.action,
      approval.turn_source,
    );
    signal.throwIfAborted();
    return { prompt: confirmedOutcome(approval.action, outcome, true) };
  }

  async function stoppedOutcomes(turnId: string) {
    const { rows } = await pool.query<{ action: string; status: string; result: unknown }>(
      `WITH t AS (SELECT session_id,created_at,id FROM turns WHERE id=$1 AND owner_id=$2),
       finished AS (SELECT d.created_at,d.id FROM turns d JOIN t ON d.session_id=t.session_id
         WHERE d.owner_id=$2 AND d.status IN ('succeeded','waiting') AND (d.created_at,d.id)<(t.created_at,t.id)
         ORDER BY d.created_at DESC,d.id DESC LIMIT 1)
       SELECT a.action,a.status,a.result FROM t
       JOIN turns e ON e.owner_id=$2 AND e.session_id=t.session_id AND e.status IN ('cancelled','failed')
         AND (e.created_at,e.id)<(t.created_at,t.id)
         AND NOT EXISTS (SELECT 1 FROM finished f WHERE (f.created_at,f.id)>(e.created_at,e.id))
       JOIN approvals a ON a.owner_id=$2 AND a.execution_turn_id=e.id AND a.status<>'declined'
       ORDER BY e.created_at,e.id`,
      [turnId, ownerId],
    );
    return rows.map(({ action, ...outcome }) => confirmedOutcome(action, outcome));
  }

  async function retireScheduleConfirmationsInTransaction(
    client: PoolClient,
    id: string,
    waitForSend: boolean,
  ) {
    const pending = (
      await client.query<{
        id: string;
        action: string;
        turn_id: string;
        confirmation_message_id: string | null;
        source: string;
      }>(
        `SELECT a.id,a.action,a.turn_id,a.confirmation_message_id,u.source
         FROM approvals a JOIN turns u ON u.id=a.turn_id AND u.owner_id=a.owner_id
         WHERE a.owner_id=$1 AND a.action IN ('NOD_schedule_pause','NOD_schedule_cancel','NOD_schedule_update')
           AND lower(a.args->>'id')=lower($2::text) AND a.status='pending'
         FOR UPDATE OF a`,
        [ownerId, id],
      )
    ).rows;
    if (!pending.length) return;
    const approvalIds = pending.map((row) => row.id);
    const turnIds = [...new Set(pending.map((row) => row.turn_id))];
    const messageIds = pending.flatMap((row) =>
      row.confirmation_message_id ? [row.confirmation_message_id] : [],
    );
    if (messageIds.length)
      try {
        if (waitForSend) await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query(
          `SELECT id FROM messages WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE${waitForSend ? '' : ' NOWAIT'}`,
          [ownerId, messageIds],
        );
      } catch (cause) {
        if ((cause as { code?: string }).code !== '55P03') throw cause;
        throw Object.assign(new Error('A schedule confirmation is still being sent.'), {
          code: '55P03',
          notRun: true,
          statusCode: 409,
        });
      }
    await client.query(
      'SELECT id FROM turns WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE NOWAIT',
      [ownerId, turnIds],
    );
    await client.query(
      "UPDATE approvals SET status='expired' WHERE owner_id=$1 AND id=ANY($2::uuid[])",
      [ownerId, approvalIds],
    );
    if (messageIds.length)
      await client.query(
        'UPDATE messages SET hidden_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[])',
        [ownerId, messageIds],
      );
    let tasks: Array<{ id: string; turn_id: string; thread_id: string }>;
    try {
      tasks = (
        await client.query<{ id: string; turn_id: string; thread_id: string }>(
          `SELECT t.id,t.turn_id,u.thread_id FROM tasks t
           JOIN turns u ON u.id=t.turn_id AND u.owner_id=t.owner_id AND u.task_id=t.id
           WHERE t.owner_id=$1 AND t.state='open' AND u.id=ANY($2::uuid[])
           ORDER BY t.id FOR UPDATE OF t NOWAIT`,
          [ownerId, turnIds],
        )
      ).rows;
    } catch (cause) {
      if ((cause as { code?: string }).code !== '55P03') throw cause;
      throw Object.assign(new Error('This task is still being updated. Try again.'), {
        code: '55P03',
        notRun: true,
        statusCode: 409,
      });
    }
    for (const task of tasks) {
      const messageId = randomUUID();
      await client.query(
        `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text)
         VALUES($1,$2,$3,$4,'assistant',$5)`,
        [
          messageId,
          ownerId,
          task.thread_id,
          task.turn_id,
          'The schedule has changed. This task is still open. Reply here if you want to continue it.',
        ],
      );
      await client.query(
        'UPDATE tasks SET continuation_message_id=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
        [task.id, ownerId, messageId],
      );
    }
    await client.query(
      "UPDATE turns SET status='cancelled',finished_at=now() WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND status IN ('running','waiting')",
      [ownerId, turnIds],
    );
    afterCommit(client, () => {
      abortTurns(turnIds);
      for (const row of pending) changed('expired', row.action, row.source);
    });
  }

  async function retireScheduleConfirmations(client: PoolClient, id: string, waitForSend: boolean) {
    try {
      await retireScheduleConfirmationsInTransaction(client, id, waitForSend);
    } catch (cause) {
      const error = cause as { code?: string; statusCode?: number };
      if (error?.code !== '55P03' || error.statusCode === 409) throw cause;
      throw Object.assign(new Error('This schedule or task is still being updated. Try again.'), {
        code: '55P03',
        notRun: true,
        statusCode: 409,
      });
    }
  }

  async function isRetirableScheduleConfirmation(messageId: string) {
    const result = await pool.query(
      "SELECT 1 FROM approvals WHERE owner_id=$1 AND confirmation_message_id=$2 AND action IN ('NOD_schedule_pause','NOD_schedule_cancel','NOD_schedule_update') LIMIT 1",
      [ownerId, messageId],
    );
    return Boolean(result.rowCount);
  }

  return {
    request,
    chat: { answer: answerChat, accept: acceptChat },
    executeConfirmed,
    stoppedOutcomes,
    retireScheduleConfirmations,
    isRetirableScheduleConfirmation,
  };
}
