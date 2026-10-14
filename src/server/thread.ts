import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PgBoss } from 'pg-boss';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.ts';
import { transaction } from './transaction.ts';
import { dataRoot, databaseUrl, ownerId, runtimeMode } from './config.ts';
import { delta, refresh } from './events.ts';
import { localArtifacts, type ArtifactService } from './artifacts.ts';
import type { SpeechService } from './speech.ts';
import type { Artifact, MessageReaction } from '../shared/contracts.ts';
import type { BrowserConnectionRequest, RuntimeContext, RuntimeResult } from '../ports/agent.ts';
import { appConfirmation } from '../ports/agent.ts';
import { isMessageReaction, reactionEmoji } from '../shared/emoji.ts';
import { defaultPreferences, isQuietTime } from './preferences.ts';
import { formattingLocale, timeZoneRegion } from '../shared/date-locale.ts';
import type { AgentReactionInput } from './agent-reactions.ts';
import type { ChatConfirmationInput, ChatConfirmationResult } from './approvals.ts';
import type { WorkConsumers } from './work-admission.ts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';
import { inlineAppResult } from './integration-result.ts';
import { saveIntegrationFiles } from './integration-files.ts';
import { spendingLimitReached } from './ledger.ts';
import type { ExecutionEvent } from '../shared/execution.ts';

const queue = 'thread-drain';
export const boss = new PgBoss({
  connectionString: databaseUrl,
  schema: process.env.PGBOSS_SCHEMA || 'pgboss',
  createSchema: runtimeMode !== 'tenant',
  max: runtimeMode === 'tenant' ? 2 : 10,
});
const running = new Map<string, AbortController>();
const inflight = new Set<Promise<void>>();
let stopping = false;

export type TurnSource = 'user' | 'schedule' | 'event' | 'resume';
export interface TurnRef {
  threadId: string;
  turnId: string;
  browserId?: string;
}
export interface EnqueueTurnOptions {
  source: Exclude<TurnSource, 'user'>;
  sourceId?: string;
  channel?: string;
  channelSourceId?: string | null;
  background?: boolean;
  sessionId?: string;
  parentTurnId?: string;
  client?: PoolClient;
}
export interface SubmitUserMessageOptions {
  threadId?: string;
  sourceId?: string;
  channel?: string;
  client?: PoolClient;
  replyToMessageId?: string;
  seenMessageId?: string;
  clientMessageId?: string;
  prompt?: string;
  answer?: ChatConfirmationInput['answer'];
}
export interface SubmitUserMessageResult {
  threadId: string;
  turnId: string;
  messageId: string;
}
type ConfirmAction = {
  answer(input: ChatConfirmationInput): Promise<ChatConfirmationInput['answer']>;
  accept(client: PoolClient, input: ChatConfirmationInput): Promise<ChatConfirmationResult>;
};

export interface ThreadDependencies {
  analytics?: CaptureAnalytics;
  consumers?: WorkConsumers;
  artifacts?: ArtifactService;
  writeArtifact?: (
    threadId: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<void>;
  readArtifact?: (threadId: string, path: string, maxBytes: number) => Promise<Uint8Array>;
  executeConfirmation?: (
    turnId: string,
    signal: AbortSignal,
  ) => Promise<{ prompt: string } | undefined>;
  spendingLimitReached?: () => Promise<boolean>;
  skipTurn?: (sourceId: string) => Promise<boolean>;
  accountProfile?: () => Promise<RuntimeContext['account']>;
  connectedApps?: () => Promise<NonNullable<RuntimeContext['connectedApps']>>;
  memoryContext?: () => Promise<RuntimeContext['memory']>;
  task?: (turn: TurnRef, input: unknown) => Promise<unknown>;
  startTurn?: (turn: TurnRef) => Promise<void>;
  runTurn: (context: RuntimeContext) => Promise<RuntimeResult>;
  speech: Pick<SpeechService, 'synthesize'>;
  requestCredential: (
    turn: TurnRef,
    input: Parameters<RuntimeContext['requestCredential']>[0],
  ) => ReturnType<RuntimeContext['requestCredential']>;
  requestPayment?: (
    turn: TurnRef,
    input: unknown,
    show: (image: Uint8Array) => Promise<void>,
  ) => ReturnType<NonNullable<RuntimeContext['requestPayment']>>;
  paymentSetting?: (
    turn: TurnRef,
    input: unknown,
  ) => Promise<string | { [appConfirmation]: string }>;
  integration: (
    turn: TurnRef,
    action: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; admit?: (asks: boolean) => Promise<void> },
  ) => Promise<unknown>;
  connections?: (
    action: 'list' | 'discover' | 'connect' | 'propose',
    service?: string,
    turn?: TurnRef,
    proposal?: unknown,
    newAccount?: boolean,
    query?: string,
    connectionId?: string,
  ) => Promise<unknown>;
  browserConnection?: (
    request: BrowserConnectionRequest,
    turn: TurnRef,
    signal: AbortSignal,
    launch: { timeZone?: string; locale?: string },
  ) => Promise<unknown>;
  reactToMessage?: (
    input: AgentReactionInput,
  ) => ReturnType<NonNullable<RuntimeContext['reactToMessage']>>;
  manage: (
    turn: TurnRef,
    action: string,
    args: Record<string, unknown>,
    provenance: { sourceMessageId: string | null; admit?: (asks: boolean) => Promise<void> },
  ) => Promise<unknown>;
}

export function activeThreadSql(alias = 'm') {
  return `${alias}.thread_id=(SELECT th.id FROM threads th WHERE th.owner_id=${alias}.owner_id AND th.archived_at IS NULL)`;
}

export async function activeThread(database: Pool | PoolClient = pool, owner = ownerId) {
  const select = () =>
    database.query('SELECT id FROM threads WHERE owner_id=$1 AND archived_at IS NULL', [owner]);
  const found = await select();
  if (found.rows[0]) return found.rows[0] as { id: string };
  await database.query(
    'INSERT INTO threads(id,owner_id) VALUES($1,$2) ON CONFLICT (owner_id) WHERE archived_at IS NULL DO NOTHING',
    [randomUUID(), owner],
  );
  return (await select()).rows[0] as { id: string };
}

export async function lockThread(client: PoolClient, owner = ownerId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread:${owner}`]);
  return activeThread(client, owner);
}

function httpError(message: string, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

const turnStopped = () => httpError('This turn is no longer active.');
const messageIdInUse = () =>
  httpError('This message ID is already in use. Send this as a new message.');

export async function withTurnLock<T>(
  turnId: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.status FROM turns u JOIN threads th ON th.id=u.thread_id
       WHERE u.id=$1 AND u.owner_id=$2 AND th.archived_at IS NULL FOR NO KEY UPDATE OF u`,
      [turnId, ownerId],
    );
    if (rows[0]?.status !== 'running') throw turnStopped();
    return operation(client);
  }, pool);
}

async function sendDrain(client: PoolClient | undefined, threadId: string) {
  await boss.send(
    queue,
    { threadId },
    {
      ...(client
        ? { db: { executeSql: (sql: string, values: unknown[]) => client.query(sql, values) } }
        : {}),
      retryLimit: 0,
      expireInSeconds: 86400,
    },
  );
}

async function insertEvent(
  client: PoolClient,
  turnId: string,
  type: string,
  summary: string,
  event?: ExecutionEvent,
) {
  await client.query(
    'INSERT INTO turn_events(id,turn_id,type,summary,run_id,parent_run_id,session_id,browser_id,call_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      randomUUID(),
      turnId,
      type.slice(0, 80),
      summary.slice(0, 2000),
      event?.execution.runId ?? null,
      event?.execution.parentRunId ?? null,
      event?.execution.sessionId ?? null,
      event?.execution.browserId ?? null,
      event?.callId ?? null,
    ],
  );
}

async function assertReplyTarget(client: PoolClient, threadId: string, messageId?: string) {
  if (!messageId) return;
  const target = await client.query(
    'SELECT 1 FROM messages WHERE id=$1 AND owner_id=$2 AND thread_id=$3',
    [messageId, ownerId, threadId],
  );
  if (!target.rowCount) throw httpError('The reply is unavailable in this conversation.', 404);
}

async function insertAssistantMessage(
  client: PoolClient,
  turn: { threadId: string; turnId: string },
  text: string,
  attachments: Artifact[] = [],
  streamId?: string,
  replyToMessageId?: string,
) {
  await assertReplyTarget(client, turn.threadId, replyToMessageId);
  await client.query(
    'INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments,stream_id,reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      randomUUID(),
      ownerId,
      'assistant',
      text,
      turn.threadId,
      turn.turnId,
      JSON.stringify(attachments),
      streamId ?? null,
      replyToMessageId ?? null,
    ],
  );
}

export async function reply(
  turn: TurnRef,
  text: string,
  attachments: Artifact[] = [],
  streamId?: string,
  replyToMessageId?: string,
) {
  await withTurnLock(turn.turnId, (client) =>
    insertAssistantMessage(client, turn, text, attachments, streamId, replyToMessageId),
  );
  refresh();
}

function validateSource(sourceId?: string, channel?: string) {
  if (sourceId !== undefined && (!sourceId.trim() || sourceId.length > 500))
    throw new Error('Invalid turn source identity.');
  if (channel !== undefined && !/^[a-z][a-z0-9:_-]{0,79}$/.test(channel))
    throw new Error('Invalid conversation channel.');
}

export async function enqueueTurn(prompt: string, options: EnqueueTurnOptions) {
  validateSource(options.sourceId, options.channel);
  const create = async (client: PoolClient) => {
    const thread = await lockThread(client);
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO turns(id,owner_id,thread_id,source,source_id,prompt,channel,background,channel_source_id,session_id,parent_turn_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (owner_id,source_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING id`,
      [
        id,
        ownerId,
        thread.id,
        options.source,
        options.sourceId ?? null,
        prompt,
        options.channel ?? 'web',
        options.background ?? options.source !== 'resume',
        options.channelSourceId ?? null,
        options.sessionId ?? null,
        options.parentTurnId ?? null,
      ],
    );
    if (!inserted.rowCount)
      return (
        await client.query('SELECT id FROM turns WHERE owner_id=$1 AND source_id=$2', [
          ownerId,
          options.sourceId,
        ])
      ).rows[0].id as string;
    await sendDrain(client, thread.id);
    return id;
  };
  const turnId = options.client ? await create(options.client) : await transaction(create, pool);
  if (!options.client) refresh();
  return turnId;
}

export function createUserMessageService(options: { confirmAction?: ConfirmAction } = {}) {
  return {
    submit: (text: string, attachments: Artifact[] = [], input: SubmitUserMessageOptions = {}) =>
      submitUserMessage(text, attachments, input, options.confirmAction),
    answer: (text: string, input: SubmitUserMessageOptions = {}) =>
      readAnswer(text, false, input, options.confirmAction),
  };
}

async function readAnswer(
  text: string,
  hasAttachments: boolean,
  options: SubmitUserMessageOptions,
  confirmAction?: ConfirmAction,
) {
  return confirmAction?.answer({
    text,
    channel: options.channel ?? 'web',
    threadId: options.threadId ?? (await activeThread(pool)).id,
    replyToMessageId: options.replyToMessageId,
    seenMessageId: options.seenMessageId,
    hasAttachments,
  });
}

export async function submitUserMessage(
  text: string,
  attachments: Artifact[] = [],
  options: SubmitUserMessageOptions = {},
  confirmAction?: ConfirmAction,
): Promise<SubmitUserMessageResult> {
  validateSource(options.sourceId, options.channel);
  const channel = options.channel ?? 'web';
  const confirmation = {
    text,
    channel,
    replyToMessageId: options.replyToMessageId,
    seenMessageId: options.seenMessageId,
    clientMessageId: options.clientMessageId,
    sourceId: options.sourceId,
    hasAttachments: attachments.length > 0,
  };
  const answer = options.client
    ? options.answer
    : await readAnswer(text, attachments.length > 0, options, confirmAction);
  const submit = async (client: PoolClient): Promise<SubmitUserMessageResult> => {
    const thread = await lockThread(client);
    if (options.threadId !== undefined && options.threadId !== thread.id)
      throw httpError('This conversation has been reset. Reload it before continuing.');
    if (options.clientMessageId) {
      const previous = (
        await client.query(
          'SELECT id,owner_id,role,text,thread_id,turn_id,attachments,reply_to_message_id FROM messages WHERE id=$1',
          [options.clientMessageId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.owner_id !== ownerId ||
          previous.role !== 'user' ||
          previous.thread_id !== thread.id ||
          previous.text !== text ||
          previous.reply_to_message_id !== (options.replyToMessageId ?? null) ||
          JSON.stringify((previous.attachments as Artifact[]).map((item) => item.id)) !==
            JSON.stringify(attachments.map((item) => item.id))
        )
          throw messageIdInUse();
        return { threadId: thread.id, turnId: previous.turn_id, messageId: previous.id };
      }
    }
    if (options.sourceId) {
      const prior = (
        await client.query('SELECT id,message_id FROM turns WHERE owner_id=$1 AND source_id=$2', [
          ownerId,
          options.sourceId,
        ])
      ).rows[0];
      if (prior) return { threadId: thread.id, turnId: prior.id, messageId: prior.message_id };
    }
    await assertReplyTarget(client, thread.id, options.replyToMessageId);
    if (confirmAction) {
      const confirmed = await confirmAction.accept(client, {
        ...confirmation,
        threadId: thread.id,
        answer,
      });
      if (confirmed) return confirmed;
    }
    const messageId = options.clientMessageId ?? randomUUID();
    const turnId = randomUUID();
    const question = (
      await client.query(
        `SELECT u.id,u.session_id,u.background FROM turns u JOIN messages m ON m.turn_id=u.id AND m.owner_id=u.owner_id
       WHERE u.owner_id=$1 AND u.thread_id=$2 AND (u.channel=$3 OR $4::uuid IS NOT NULL) AND u.status='waiting' AND u.waiting_reason='question'
         AND m.role='assistant' AND (($4::uuid IS NOT NULL AND m.id=$4) OR ($4::uuid IS NULL AND u.session_id=$2))
         AND m.id=(SELECT q.id FROM messages q WHERE q.turn_id=u.id AND q.owner_id=u.owner_id AND q.role='assistant' ORDER BY q.created_at DESC,q.id DESC LIMIT 1)
         AND NOT EXISTS(SELECT 1 FROM turns n WHERE n.owner_id=u.owner_id AND n.session_id=u.session_id
           AND (n.created_at,n.id)>(u.created_at,u.id))
       ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
        [ownerId, thread.id, channel, options.replyToMessageId ?? null],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO turns(id,owner_id,thread_id,source,source_id,message_id,prompt,channel,session_id,background,parent_turn_id)
       VALUES($1,$2,$3,'user',$4,$5,$6,$7,$8,$9,$10)`,
      [
        turnId,
        ownerId,
        thread.id,
        options.sourceId ?? null,
        messageId,
        options.prompt ?? text,
        channel,
        question?.session_id ?? thread.id,
        question?.background ?? false,
        question?.id ?? null,
      ],
    );
    await client.query(
      "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments,reply_to_message_id) VALUES($1,$2,'user',$3,$4,$5,$6,$7)",
      [
        messageId,
        ownerId,
        text,
        thread.id,
        turnId,
        JSON.stringify(attachments),
        options.replyToMessageId ?? null,
      ],
    );
    await sendDrain(client, thread.id);
    return { threadId: thread.id, turnId, messageId };
  };
  let result: SubmitUserMessageResult;
  try {
    result = options.client ? await submit(options.client) : await transaction(submit, pool);
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: string; constraint?: string };
    if (options.clientMessageId && code === '23505' && constraint === 'messages_pkey')
      throw messageIdInUse();
    throw error;
  }
  if (!options.client) refresh();
  return result;
}

async function cancelTurns(client: PoolClient, threadId: string) {
  const current = await client.query(
    "UPDATE turns SET status='cancelled',finished_at=now() WHERE thread_id=$1 AND owner_id=$2 AND status IN ('queued','running','waiting') RETURNING id,session_id",
    [threadId, ownerId],
  );
  return {
    ids: current.rows.map((row) => row.id as string),
    browsers: [
      ...new Set(
        current.rows.map((row) => row.session_id as string).filter((id) => id !== threadId),
      ),
    ],
  };
}

function abortTurns(ids: string[]) {
  for (const id of ids) running.get(id)?.abort();
}

export async function stopThread() {
  const cancelled = await transaction(
    async (client) => cancelTurns(client, (await lockThread(client)).id),
    pool,
  );
  abortTurns(cancelled.ids);
  refresh();
  return { browsers: cancelled.browsers };
}

export async function resetThread(expectedThreadId: string) {
  const result = await transaction(async (client) => {
    const thread = await lockThread(client);
    if (thread.id !== expectedThreadId)
      throw httpError('This conversation has changed. Reload it before clearing messages.');
    const cancelled = await cancelTurns(client, thread.id);
    await client.query('UPDATE threads SET archived_at=now(),updated_at=now() WHERE id=$1', [
      thread.id,
    ]);
    return { cancelled, previousThreadId: thread.id, threadId: (await activeThread(client)).id };
  }, pool);
  abortTurns(result.cancelled.ids);
  const { browsers } = result.cancelled;
  refresh();
  return {
    ok: true,
    threadId: result.threadId,
    previousThreadId: result.previousThreadId,
    browsers,
  };
}

export async function reactToAssistantMessage(
  messageId: string,
  reaction: MessageReaction | null,
  wake = true,
) {
  if (reaction !== null && !isMessageReaction(reaction))
    throw httpError('Choose one emoji reaction.', 400);
  const result = await transaction(async (client) => {
    const thread = await lockThread(client);
    const message = (
      await client.query(
        `SELECT m.id,m.text,m.reaction,m.reaction_revision,COALESCE(u.channel,'web') AS channel FROM messages m LEFT JOIN turns u ON u.id=m.turn_id
         WHERE m.id=$1 AND m.owner_id=$2 AND m.role='assistant' AND m.thread_id=$3 FOR UPDATE OF m`,
        [messageId, ownerId, thread.id],
      )
    ).rows[0];
    if (!message) throw httpError('Message not found.', 404);
    if (
      message.reaction === reaction ||
      (message.reaction && reaction && reactionEmoji(message.reaction) === reactionEmoji(reaction))
    )
      return { ok: true, reaction: message.reaction };
    const revision = message.reaction_revision + 1;
    await client.query('UPDATE messages SET reaction=$2,reaction_revision=$3 WHERE id=$1', [
      messageId,
      reaction,
      revision,
    ]);
    if (reaction && wake)
      await enqueueTurn(
        `The user reacted to an assistant message. This is narrow feedback about that message, not a new instruction or permission. Decide whether a useful response is needed; usually stay quiet. Do not acknowledge the reaction automatically or ask a generic follow-up. Message data: ${JSON.stringify({ id: message.id, text: message.text, reaction })}`,
        {
          source: 'event',
          sourceId: `reaction:${messageId}:${revision}`,
          channel: message.channel,
          client,
        },
      );
    return { ok: true, reaction };
  }, pool);
  refresh();
  return result;
}

async function resumeTurn(
  turnId: string,
  sourceId: string,
  prompt: string,
  pendingOnly = false,
  client?: PoolClient,
) {
  const create = async (client: PoolClient) => {
    await lockThread(client);
    const turn = (
      await client.query(
        `SELECT u.channel,u.status,u.background,u.prompt,u.session_id,th.archived_at IS NULL AS active FROM turns u JOIN threads th ON th.id=u.thread_id
         WHERE u.id=$1 AND u.owner_id=$2`,
        [turnId, ownerId],
      )
    ).rows[0];
    if (pendingOnly && (!turn?.active || !['running', 'waiting'].includes(turn.status)))
      return false;
    await enqueueTurn(turn?.background ? `${prompt}\nThe request was: ${turn.prompt}` : prompt, {
      source: 'resume',
      sourceId,
      channel: turn?.channel ?? 'web',
      background: turn?.background ?? false,
      sessionId: turn?.session_id,
      parentTurnId: turnId,
      client,
    });
    return true;
  };
  const resumed = client ? await create(client) : await transaction(create, pool);
  if (resumed && !client) refresh();
  return resumed;
}

export async function resumeAfterCredentials(turnId: string, client?: PoolClient) {
  await resumeTurn(
    turnId,
    `credentials:${turnId}`,
    'The secure credential step has completed. Inspect the current browser and continue the request you were working on. Do not repeat completed external actions.',
    true,
    client,
  );
}

export async function resumeAfterPayment(turnId: string, prompt: string, client?: PoolClient) {
  await resumeTurn(turnId, `credentials:${turnId}`, prompt, true, client);
}

export async function retryCredentials(turnId: string) {
  await resumeTurn(
    turnId,
    `credentials-retry:${turnId}`,
    'The owner asked you to check the previous secure sign-in step. It may have reached the website. Inspect the current browser and check its result before you request a fresh link. Do not repeat a completed or uncertain external action.',
  );
}

export function resumeAfterConnection(turnId: string, service: string) {
  return resumeTurn(
    turnId,
    `connection:${turnId}`,
    `The ${service} connection is ready. Continue the request.`,
    true,
  );
}

export async function initializeThreads() {
  stopping = false;
  boss.on('error', () =>
    console.error('The thread queue reported an error. Check database availability.'),
  );
  await boss.start();
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 86400 });
}

export const interruptedMessage =
  'I was interrupted before I finished. Check anything I may have started outside before asking me to redo it, or say continue and I’ll pick up where I left off.';

async function finishTurn(
  client: PoolClient,
  turnId: string,
  status: string,
  fields: { waitingReason?: string; error?: string } = {},
) {
  const updated = await client.query(
    "UPDATE turns SET status=$2,waiting_reason=$3,error=$4,finished_at=now() WHERE id=$1 AND status='running' RETURNING id",
    [turnId, status, fields.waitingReason ?? null, fields.error ?? null],
  );
  if (updated.rowCount)
    await insertEvent(
      client,
      turnId,
      status,
      status === 'succeeded'
        ? 'Turn finished.'
        : status === 'waiting'
          ? 'Waiting for your input.'
          : (fields.error ?? status),
    );
}

function describeFailure(error: unknown) {
  if (!(error instanceof Error)) return 'a thrown value that is not an Error';
  const fields = [error.name];
  for (const key of ['code', 'statusCode'] as const) {
    const value = (error as { code?: unknown; statusCode?: unknown })[key];
    if (typeof value === 'string' || typeof value === 'number')
      fields.push(`${key}=${String(value).slice(0, 64)}`);
  }
  const frames = (error.stack ?? '')
    .split(/\r?\n/)
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 2)
    .map((line) => line.trim());
  return [...fields, ...frames].join(' | ');
}

async function interruptTurn(turnId: string) {
  return transaction(async (client) => {
    await lockThread(client);
    const turn = (
      await client.query(
        "SELECT thread_id,background FROM turns WHERE id=$1 AND owner_id=$2 AND status='running' FOR UPDATE",
        [turnId, ownerId],
      )
    ).rows[0];
    if (!turn) return false;
    await finishTurn(client, turnId, 'failed', { error: 'Interrupted.' });
    if (!turn.background)
      await insertAssistantMessage(
        client,
        { threadId: turn.thread_id, turnId },
        interruptedMessage,
        [],
        `failure:${turnId}`,
      );
    return true;
  }, pool);
}

export async function startThreadWorkers(dependencies: ThreadDependencies) {
  const interrupted = await pool.query(
    "SELECT id FROM turns WHERE owner_id=$1 AND status='running'",
    [ownerId],
  );
  for (const turn of interrupted.rows) await interruptTurn(turn.id);
  await sendDrain(undefined, (await activeThread()).id);
  const start = () =>
    boss.work<{ threadId: string }>(
      queue,
      { localConcurrency: 1, pollingIntervalSeconds: 0.5, batchSize: 20, burstWhenBatchFull: true },
      async (jobs) => {
        for (const threadId of new Set(jobs.map((job) => job.data.threadId)))
          await drainThread(threadId, dependencies);
      },
    );
  if (dependencies.consumers)
    await dependencies.consumers.register({
      start,
      stop: async (id) => {
        await boss.offWork(queue, { id, wait: true });
        await Promise.allSettled([...inflight]);
      },
    });
  else await start();
}

async function claimTurns(threadId: string) {
  return transaction(async (client) => {
    if ((await lockThread(client)).id !== threadId) return [];
    const busy = await client.query(
      "SELECT DISTINCT session_id FROM turns WHERE thread_id=$1 AND owner_id=$2 AND status='running'",
      [threadId, ownerId],
    );
    const { rows } = await client.query(
      `SELECT * FROM turns WHERE thread_id=$1 AND owner_id=$2 AND status='queued'
       ORDER BY created_at,id FOR UPDATE`,
      [threadId, ownerId],
    );
    const sessions = new Set(busy.rows.map((row) => row.session_id as string));
    const claimed = rows.filter((row) => {
      if (sessions.has(row.session_id)) return false;
      sessions.add(row.session_id);
      return true;
    });
    await client.query(
      "UPDATE turns SET status='running',started_at=now() WHERE id=ANY($1::uuid[])",
      [claimed.map((row) => row.id)],
    );
    return claimed;
  }, pool);
}

async function takeQueuedMessages(turnId: string, sessionId: string, channel: string) {
  return transaction(async (client) => {
    const thread = await lockThread(client);
    const { rows } = await client.query(
      `SELECT u.id,u.status,u.source,u.channel,u.message_id,u.prompt,m.attachments,m.reply_to_message_id
       FROM turns u LEFT JOIN messages m ON m.id=u.message_id AND m.owner_id=u.owner_id
       WHERE u.thread_id=$1 AND u.owner_id=$2 AND u.session_id=$4 AND (u.status='queued' OR u.id=$3)
       ORDER BY u.created_at,u.id FOR UPDATE OF u`,
      [thread.id, ownerId, turnId, sessionId],
    );
    if (!rows.some((row) => row.id === turnId && row.status === 'running')) throw turnStopped();
    const queued = rows.filter((row) => row.status === 'queued');
    const end = queued.findIndex(
      (row) =>
        row.source !== 'user' ||
        row.channel !== channel ||
        !row.message_id ||
        row.attachments.length ||
        row.reply_to_message_id,
    );
    const taken = end < 0 ? queued : queued.slice(0, end);
    if (!taken.length) return [];
    const ids = taken.map((row) => row.id);
    await client.query(
      'UPDATE messages SET turn_id=$1 WHERE turn_id=ANY($2::uuid[]) AND owner_id=$3',
      [turnId, ids, ownerId],
    );
    await client.query(
      "UPDATE turns SET status='succeeded',finished_at=now() WHERE id=ANY($1::uuid[])",
      [ids],
    );
    return taken.map((row) => ({ id: row.message_id as string, text: row.prompt as string }));
  }, pool);
}

async function drainThread(threadId: string, dependencies: ThreadDependencies) {
  if (stopping) return;
  for (const turn of await claimTurns(threadId)) {
    const work = executeTurn(turn, dependencies)
      .catch((error) => console.error(`Turn ${turn.id} did not finish: ${describeFailure(error)}`))
      .then(() => drainNext(threadId))
      .finally(refresh);
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  }
}

async function drainNext(threadId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sendDrain(undefined, threadId);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  console.error('The next turn could not be queued. It runs on the next message or start.');
}

type StoredAttachment = { id?: string; name?: string; mimeType?: string };

async function loadTurnContext(turn: any, dependencies: ThreadDependencies) {
  const threadId = turn.thread_id as string;
  const sourceMessageId: string | null = turn.message_id ?? null;
  const [source, history, preferences, account, memory, connectedApps] = await Promise.all([
    sourceMessageId
      ? pool.query(
          `SELECT s.attachments,r.id,r.role,r.text,r.attachments AS reply_attachments
           FROM messages s LEFT JOIN messages r ON r.id=s.reply_to_message_id AND r.owner_id=s.owner_id AND r.thread_id=s.thread_id
           WHERE s.id=$1 AND s.owner_id=$2`,
          [sourceMessageId, ownerId],
        )
      : undefined,
    pool.query(
      `WITH seen AS (SELECT max(started_at) AS at FROM turns
         WHERE owner_id=$1 AND thread_id=$2 AND session_id=$6 AND id<>$4),
       boundary AS (SELECT created_at AS at FROM turns WHERE owner_id=$1 AND thread_id=$2 AND id=$4)
       SELECT role,text,created_at AS "createdAt",reaction,attachments,unseen FROM (
       SELECT m.role,m.text,m.created_at,m.id,m.reaction,m.attachments,
       COALESCE(u.background AND m.created_at > COALESCE(seen.at,'-infinity'),false) AS unseen
       FROM messages m CROSS JOIN seen CROSS JOIN boundary
       LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.id IS DISTINCT FROM $3::uuid
       AND (NOT $5::boolean OR (m.created_at<=boundary.at AND
         (u.id IS NULL OR u.session_id=$6
          OR (u.status IN ('succeeded','failed','cancelled') AND u.finished_at<=boundary.at))))
       ORDER BY m.created_at DESC,m.id DESC LIMIT 30) m ORDER BY created_at,id`,
      [ownerId, threadId, sourceMessageId, turn.id, Boolean(turn.background), turn.session_id],
    ),
    pool.query(
      'SELECT time_zone,locale,hour_cycle,notification_rule,quiet_hours_enabled,quiet_start,quiet_end FROM preferences WHERE owner_id=$1',
      [ownerId],
    ),
    dependencies.accountProfile?.().catch(() => undefined),
    dependencies.memoryContext?.().catch(() => ''),
    turn.background ? dependencies.connectedApps?.() : undefined,
  ]);
  const message = source?.rows[0];
  const replyTo = message?.id
    ? {
        id: message.id as string,
        role: message.role as string,
        text: message.text as string,
        attachments: message.reply_attachments,
      }
    : undefined;
  const preference = preferences.rows[0];
  const timeZone: string | undefined = preference?.time_zone || undefined;
  return {
    sourceMessageId,
    uploads: [
      ...((message?.attachments ?? []) as StoredAttachment[]),
      ...((replyTo?.attachments ?? []) as StoredAttachment[]),
    ],
    replyTo,
    history: history.rows,
    context: {
      timeZone,
      locale: preference?.locale || formattingLocale(timeZone ? timeZoneRegion(timeZone) : null),
      hourCycle: preference?.hour_cycle || defaultPreferences.hourCycle,
      notificationRule: preference?.notification_rule ?? defaultPreferences.notificationRule,
      quietHours: isQuietTime({
        ...defaultPreferences,
        timeZone: timeZone ?? null,
        quietHoursEnabled: preference?.quiet_hours_enabled ?? defaultPreferences.quietHoursEnabled,
        quietStart: preference?.quiet_start ?? defaultPreferences.quietStart,
        quietEnd: preference?.quiet_end ?? defaultPreferences.quietEnd,
      }),
      ...(account ? { account } : {}),
      memory: memory ?? '',
      ...(connectedApps ? { connectedApps } : {}),
    },
  };
}

async function executeTurn(turn: any, dependencies: ThreadDependencies) {
  const startedAt = Date.now();
  const providerChannel = String(turn.channel).split(':')[0];
  const analyticsProperties = {
    source: turn.source as 'user' | 'schedule' | 'event' | 'resume',
    channel: (['web', 'telegram', 'whatsapp'].includes(providerChannel)
      ? providerChannel
      : 'other') as 'web' | 'telegram' | 'whatsapp' | 'other',
    background: Boolean(turn.background),
  };
  let outcome: Extract<AnalyticsEvent, { event: 'otto_turn_completed' }>['properties']['outcome'] =
    'failed';
  dependencies.analytics?.({ event: 'otto_turn_started', properties: analyticsProperties });
  const turnId = turn.id as string;
  const threadId = turn.thread_id as string;
  const ref: TurnRef = { threadId, turnId, browserId: turn.session_id };
  const artifacts = dependencies.artifacts ?? localArtifacts;
  const controller = new AbortController();
  const { signal } = controller;
  running.set(turnId, controller);
  if (stopping) controller.abort();
  const current = async <T>(operation: (client: PoolClient) => Promise<T>) => {
    if (signal.aborted) throw turnStopped();
    return withTurnLock(turnId, operation);
  };
  const ensureCurrent = () => current(async () => {});
  const fenced =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      await ensureCurrent();
      return call(...args);
    };
  const post = async (
    text: string,
    attachments: Artifact[] = [],
    streamId?: string,
    replyToMessageId?: string,
  ) => {
    await current((client) =>
      insertAssistantMessage(client, ref, text, attachments, streamId, replyToMessageId),
    );
    refresh();
  };
  try {
    if (turn.source_id && (await dependencies.skipTurn?.(turn.source_id))) {
      await current((client) => finishTurn(client, turnId, 'cancelled'));
      outcome = 'cancelled';
      return;
    }
    await dependencies.startTurn?.(ref);
    const workspacePath = join(dataRoot, 'workspaces', threadId);
    await mkdir(workspacePath, { recursive: true });
    const stage = async (
      id: string,
      fileName: string,
      bytes: Uint8Array,
      operation?: AbortSignal,
    ) => {
      operation?.throwIfAborted();
      const name = `${id}-${basename(fileName)}`;
      if (dependencies.writeArtifact)
        await dependencies.writeArtifact(threadId, name, bytes, operation);
      else
        await writeFile(join(workspacePath, name), bytes, {
          mode: 0o600,
          flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
          signal: operation,
        });
      operation?.throwIfAborted();
      return name;
    };
    const inline = async (action: string, result: unknown, operation = signal) => {
      operation.throwIfAborted();
      const value = await inlineAppResult(result, (text) =>
        stage(
          randomUUID(),
          `${action.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.json`,
          Buffer.from(text),
          operation,
        ),
      );
      operation.throwIfAborted();
      return value;
    };
    const confirmed = await dependencies.executeConfirmation?.(turnId, signal);
    if (confirmed) turn.prompt = confirmed.prompt;
    await ensureCurrent();
    const loaded = await loadTurnContext(turn, dependencies);
    let sourceMessageId = loaded.sourceMessageId;
    const ids = loaded.uploads.map((item) => String(item?.id ?? '')).filter(Boolean);
    const uploads = ids.length
      ? (
          await pool.query(
            'SELECT id,name,mime_type FROM artifacts WHERE owner_id=$1 AND id=ANY($2::uuid[])',
            [ownerId, ids],
          )
        ).rows
      : [];
    const stagedFiles = new Map<string, string>();
    const attachments: RuntimeContext['attachments'] = [];
    for (const upload of uploads) {
      const name = await stage(
        upload.id,
        upload.name,
        await artifacts.readArtifact(upload.id),
        signal,
      );
      stagedFiles.set(upload.id, name);
      attachments.push({ path: join(workspacePath, name), mimeType: upload.mime_type });
    }
    const describe = ({ attachments, ...row }: Record<string, any>): any => {
      const files = (Array.isArray(attachments) ? attachments : []) as StoredAttachment[];
      return files.length
        ? {
            ...row,
            attachments: files.map((file) => ({
              name: String(file?.name ?? '').slice(0, 200),
              mimeType: String(file?.mimeType ?? '').slice(0, 100),
              ...(file?.id && stagedFiles.has(file.id)
                ? { workspaceFile: stagedFiles.get(file.id) }
                : {}),
            })),
          }
        : row;
    };
    const attach = async (
      bytes: Uint8Array,
      name: string,
      mimeType: string,
      text = '',
      publish = true,
      source?: Artifact['source'],
    ) => {
      const artifact = await current(async (client) => {
        const artifact = {
          ...(await artifacts.storeArtifact(Buffer.from(bytes), name, mimeType, threadId, client)),
          ...(source ? { source } : {}),
        };
        if (publish) await insertAssistantMessage(client, ref, text, [artifact]);
        return artifact;
      });
      refresh();
      return artifact;
    };
    const attachFile = async (file: { bytes: Uint8Array; name: string; mimeType: string }) => {
      const artifact = await attach(file.bytes, file.name, file.mimeType, '', !turn.background);
      return {
        ...artifact,
        workspaceFile: await stage(
          artifact.id,
          artifact.name,
          file.bytes,
          turn.background ? signal : undefined,
        ),
      };
    };
    const emit = async (type: string, summary: string, event?: ExecutionEvent) => {
      await current((client) => insertEvent(client, turnId, type, summary, event));
      refresh();
    };
    const { reactToMessage, connections, browserConnection } = dependencies;
    if (await dependencies.spendingLimitReached?.()) {
      await current((client) =>
        finishTurn(client, turnId, 'failed', { error: spendingLimitReached }),
      );
      return;
    }
    await emit('started', 'Turn started.');
    const result = await dependencies.runTurn({
      threadId,
      turnId,
      sessionId: turn.session_id,
      resumed: turn.source === 'resume' || Boolean(turn.parent_turn_id),
      prompt: turn.prompt,
      background: turn.background,
      channel: String(turn.channel).split(':')[0],
      ...loaded.context,
      currentMessageId: loaded.sourceMessageId ?? undefined,
      replyTo: loaded.replyTo && describe(loaded.replyTo),
      history: loaded.history.map(describe),
      workspacePath,
      signal,
      attachments,
      emit,
      reply: (text, streamId, replyToMessageId) => post(text, [], streamId, replyToMessageId),
      waitForUser: async (question, browserId) => {
        await current(async (client) => {
          await insertAssistantMessage(client, ref, question);
          await client.query('UPDATE turns SET handoff_browser_id=$2 WHERE id=$1', [
            turnId,
            browserId ?? null,
          ]);
        });
        refresh();
      },
      delta: (text, streamId, done) => {
        if (!signal.aborted && !turn.background && turn.channel === 'web')
          delta({ ownerId, channel: turn.channel, threadId, turnId, text, streamId, done });
      },
      reactToMessage:
        reactToMessage &&
        fenced((messageId, reaction) =>
          reactToMessage({ threadId, turnId, messageId, reaction, signal }),
        ),
      connections:
        connections &&
        fenced((action, service, proposal, newAccount, query, connectionId) =>
          connections(action, service, ref, proposal, newAccount, query, connectionId),
        ),
      browserConnection:
        browserConnection &&
        fenced((request) =>
          browserConnection(request, ref, signal, {
            timeZone: loaded.context.timeZone,
            locale: loaded.context.locale,
          }),
        ),
      requestCredential: fenced((input) => dependencies.requestCredential(ref, input)),
      ...(dependencies.requestPayment
        ? {
            requestPayment: fenced((input: unknown) =>
              dependencies.requestPayment!(ref, input, async (image) => {
                if (turn.channel === 'web')
                  await attach(image, 'checkout.jpg', 'image/jpeg', '', true, 'browser_screenshot');
              }),
            ),
          }
        : {}),
      ...(dependencies.paymentSetting
        ? {
            paymentSetting: fenced((input: unknown) => dependencies.paymentSetting!(ref, input)),
          }
        : {}),
      integration: fenced(async (action, args, callSignal?: AbortSignal, admit?) => {
        const operation = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        operation.throwIfAborted();
        const result = await dependencies.integration(ref, action, args, {
          signal: operation,
          admit,
        });
        operation.throwIfAborted();
        if (result && typeof result === 'object' && appConfirmation in result) return result;
        const saved = await saveIntegrationFiles(result, (file) =>
          stage(randomUUID(), file.name, file.bytes, operation),
        );
        const value = await inline(action, saved.value, operation);
        return saved.images.length
          ? { content: [{ type: 'text', text: JSON.stringify(value) }, ...saved.images] }
          : value;
      }),
      manage: fenced((action, args, admit) =>
        dependencies.manage(ref, action, args, { sourceMessageId, admit }),
      ),
      task: dependencies.task && fenced((input) => dependencies.task!(ref, input)),
      takeMessages: turn.background
        ? undefined
        : async () => {
            if (signal.aborted) throw turnStopped();
            if (await dependencies.spendingLimitReached?.()) return [];
            const taken = await takeQueuedMessages(turnId, turn.session_id, turn.channel);
            if (taken.length) {
              sourceMessageId = taken.at(-1)!.id;
              refresh();
            }
            return taken;
          },
      createAudio: async (text) => {
        const audio = await fenced(() => dependencies.speech.synthesize(text, signal))();
        return attach(audio.bytes, audio.fileName, audio.mimeType, 'Audio generated by AI.');
      },
      publish: async (path, name) => {
        const read = dependencies.readArtifact;
        if (!read) throw new Error('Workspace file delivery is unavailable.');
        const artifact = await current((client) =>
          artifacts.publishArtifact(threadId, path, name, read, client),
        );
        await post('', [artifact]);
        return artifact;
      },
      readWorkspaceFile:
        dependencies.readArtifact &&
        fenced((path, maxBytes) => dependencies.readArtifact!(threadId, path, maxBytes)),
      publishScreenshot: (bytes, name) => {
        const fileName =
          name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.png$/.test(name) ? name : 'screenshot.png';
        return attach(bytes, fileName, 'image/png', '', true, 'browser_screenshot');
      },
      publishBrowserFile: attachFile,
    });
    if (!['succeeded', 'waiting_credentials', 'waiting_user'].includes(result.status))
      throw new Error('Invalid turn result.');
    await current((client) =>
      result.status === 'succeeded'
        ? finishTurn(client, turnId, 'succeeded')
        : finishTurn(client, turnId, 'waiting', {
            waitingReason:
              result.status === 'waiting_credentials'
                ? 'credentials'
                : (result.waitingFor ?? 'question'),
          }),
    ).catch((error) => {
      if (!signal.aborted) throw error;
    });
    outcome = signal.aborted ? 'cancelled' : result.status;
  } catch (error) {
    if (stopping) {
      outcome = 'interrupted';
      return;
    }
    if (signal.aborted) outcome = 'cancelled';
    if (!signal.aborted && error instanceof Error && error.message === spendingLimitReached)
      await current((client) =>
        finishTurn(client, turnId, 'failed', { error: spendingLimitReached }),
      );
    else if (await interruptTurn(turnId))
      console.error(`Turn ${turnId} failed: ${describeFailure(error)}`);
  } finally {
    dependencies.analytics?.({
      event: 'otto_turn_completed',
      properties: {
        ...analyticsProperties,
        outcome,
        duration_ms: Math.max(0, Date.now() - startedAt),
      },
    });
    running.delete(turnId);
  }
}

export async function stopThreadWorkers() {
  stopping = true;
  for (const controller of running.values()) controller.abort();
  await boss.stop({ graceful: true, timeout: 5000 });
  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise((resolve) => setTimeout(resolve, 5000).unref()),
  ]);
}
