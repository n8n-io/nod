import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Artifact } from '../shared/contracts.ts';
import type {
  ConversationRouteDecision,
  ConversationRouter,
  ConversationRoutingContext,
} from '../ports/conversation.ts';
import { defaultConversationRoutingTimeoutMs } from '../ports/conversation.ts';
import { conversationRevision, currentConversationSql } from './conversations.ts';

const decisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation') }).strict(),
  z.object({ kind: z.literal('continue'), outcomeId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal('new_outcome'),
      title: z.string().trim().min(1).max(100),
      objective: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);

export interface PreparedUserRoute {
  channel: string;
  conversationRevision: number;
  messageDigest: string;
  candidateIds: string[];
  blockedOutcomeIds: string[];
  decision: ConversationRouteDecision;
}

export class TaskReviewRequiredError extends Error {
  static readonly publicMessage =
    'I can’t safely repeat the earlier action because its outcome is unknown.';
  readonly statusCode = 409;
  readonly code = 'task_review_required';

  constructor(
    readonly taskId: string,
    readonly summary: string,
  ) {
    super(TaskReviewRequiredError.publicMessage);
  }
}

export function taskNeedsReview(
  status: string,
  waitingReason: string | null | undefined,
  externalAction: boolean | null | undefined,
) {
  return (
    (status === 'waiting_user' && waitingReason === 'recovery') ||
    (status === 'failed' && externalAction !== false)
  );
}

export function routingMessageDigest(text: string, attachments: Artifact[], channel: string) {
  return createHash('sha256')
    .update(JSON.stringify([text, attachments.map((attachment) => attachment.id), channel]))
    .digest('hex');
}

export async function initializeOutcomes(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id uuid PRIMARY KEY,owner_id text NOT NULL,channel text NOT NULL,
      conversation_revision integer NOT NULL,title text NOT NULL,objective text NOT NULL,
      status text NOT NULL DEFAULT 'open',created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS outcome_id uuid;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id uuid;
    CREATE INDEX IF NOT EXISTS tasks_outcome ON tasks(owner_id,outcome_id,updated_at DESC);
    CREATE INDEX IF NOT EXISTS outcomes_conversation ON outcomes(owner_id,channel,conversation_revision,updated_at DESC);
    CREATE TABLE IF NOT EXISTS pending_task_inputs (
      id uuid PRIMARY KEY,sequence bigserial UNIQUE NOT NULL,owner_id text NOT NULL,
      task_id uuid NOT NULL REFERENCES tasks(id),message_id uuid UNIQUE NOT NULL REFERENCES messages(id),
      state text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),
      consumed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS pending_task_inputs_task ON pending_task_inputs(owner_id,task_id,state,sequence);
  `);
}

export function createConversationRouting(options: {
  pool: Pool;
  ownerId: string;
  routeConversation?: ConversationRouter;
  timeoutMs?: number;
}) {
  async function prepare(
    text: string,
    attachments: Artifact[],
    request: { channel?: string; conversationRevision?: number; skip?: boolean } = {},
  ): Promise<PreparedUserRoute> {
    const channel = request.channel ?? 'web';
    const revision = await conversationRevision(options.pool, options.ownerId, channel);
    if (request.conversationRevision !== undefined && request.conversationRevision !== revision)
      throw Object.assign(
        new Error('This conversation has been reset. Reload it before continuing.'),
        {
          statusCode: 409,
        },
      );
    const prepared: PreparedUserRoute = {
      channel,
      conversationRevision: revision,
      messageDigest: routingMessageDigest(text, attachments, channel),
      candidateIds: [],
      blockedOutcomeIds: [],
      decision: { kind: 'conversation' },
    };
    if (request.skip || !options.routeConversation) return prepared;
    const rows = await options.pool.query(
      `SELECT o.id AS "outcomeId",o.title,o.objective,t.id AS "taskId",t.status,
         t.waiting_reason AS "waitingReason",t.external_action AS "externalAction"
       FROM outcomes o JOIN LATERAL (
         SELECT * FROM tasks t WHERE t.outcome_id=o.id AND t.owner_id=o.owner_id
           AND t.channel=o.channel AND ${currentConversationSql()}
         ORDER BY t.updated_at DESC,t.id DESC LIMIT 1
       ) t ON true
       WHERE o.owner_id=$1 AND o.channel=$2 AND o.conversation_revision=$3
         AND o.status='open' AND t.status<>'cancelled'
       ORDER BY o.updated_at DESC,o.id DESC LIMIT 8`,
      [options.ownerId, channel, revision],
    );
    const candidateMessageIds: string[] = [];
    const outcomes = await Promise.all(
      rows.rows.map(async ({ externalAction, ...row }, index) => {
        const messages = await options.pool.query<{
          id: string;
          role: 'user' | 'assistant';
          text: string;
        }>(
          `SELECT id,role,text FROM (
               SELECT m.id,m.role,left(m.text,1000) AS text,m.created_at FROM messages m
               WHERE m.owner_id=$1 AND m.task_id=$2 AND m.role IN ('user','assistant')
               ORDER BY m.created_at DESC,m.id DESC LIMIT 4
             ) m ORDER BY created_at,id`,
          [options.ownerId, row.taskId],
        );
        candidateMessageIds.push(...messages.rows.map((message) => message.id));
        return {
          ...row,
          blocked: taskNeedsReview(row.status, row.waitingReason, externalAction),
          recency: index + 1,
          title: String(row.title).slice(0, 100),
          objective: String(row.objective).slice(0, 2000),
          recentMessages: messages.rows.map(({ role, text }) => ({ role, text })),
        };
      }),
    );
    const recentConversation = (
      await options.pool.query<{
        role: 'user' | 'assistant';
        text: string;
        outcomeId: string | null;
      }>(
        `SELECT role,text,"outcomeId" FROM (
           SELECT m.id,m.role,left(m.text,1000) AS text,m.created_at,t.outcome_id AS "outcomeId"
           FROM messages m JOIN tasks t ON t.id=m.task_id
           WHERE m.owner_id=$1 AND t.owner_id=$1 AND t.channel=$2
             AND ${currentConversationSql()} AND m.role IN ('user','assistant')
             AND NOT(m.id=ANY($3::uuid[]))
           ORDER BY m.created_at DESC,m.id DESC LIMIT 12
         ) m ORDER BY created_at,id`,
        [options.ownerId, channel, candidateMessageIds],
      )
    ).rows;
    const candidates = outcomes
      .filter(({ blocked }) => !blocked)
      .map(({ blocked, ...item }) => item);
    const blockedCandidates = outcomes
      .filter(({ blocked }) => blocked)
      .map(({ blocked, ...item }) => item);
    prepared.candidateIds = candidates.map((candidate) => candidate.outcomeId);
    prepared.blockedOutcomeIds = blockedCandidates.map((candidate) => candidate.outcomeId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve()
          .then(() =>
            options.routeConversation!({
              text: text.slice(0, 12_000),
              hasAttachments: attachments.length > 0,
              channel: channel.split(':')[0]!,
              conversationRevision: revision,
              recentConversation,
              candidates,
              blockedCandidates,
              signal: controller.signal,
            }),
          )
          .catch(() => undefined),
        new Promise<ConversationRouteDecision | undefined>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
          }, options.timeoutMs ?? defaultConversationRoutingTimeoutMs);
        }),
      ]);
      const parsed = decisionSchema.safeParse(result);
      if (
        parsed.success &&
        (parsed.data.kind !== 'continue' ||
          prepared.candidateIds.includes(parsed.data.outcomeId) ||
          prepared.blockedOutcomeIds.includes(parsed.data.outcomeId))
      )
        prepared.decision = parsed.data;
      else if (blockedCandidates.length)
        throw Object.assign(new Error('I couldn’t check the earlier request. Please try again.'), {
          statusCode: 503,
        });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    return prepared;
  }

  return { prepare };
}
