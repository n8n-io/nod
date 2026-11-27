import type { Pool } from 'pg';
import { z } from 'zod';
import { withdrawnSql } from './turn-chain.ts';
import { isMessageReaction } from '../shared/emoji.ts';
import { presentationSchema, presentationText } from '../shared/presentation.ts';
import type { TrustWords } from './trust-basis.ts';

export interface OwnerInput {
  id: string | null;
  at: string;
  text: string;
  canAuthorize?: boolean;
  replyTo?: { id: string; text: string };
  fields?: Record<string, unknown>;
  approvalId?: string;
}

export interface OwnerInstructions {
  messages: OwnerInput[];
  requiresReplacement?: boolean;
  approvals?: Array<{ id: string; at: string; definition: Record<string, unknown> }>;
}

export interface InstructionChange {
  before: Record<string, unknown> | null;
  changes: Record<string, unknown>;
  after: Record<string, unknown>;
  evidence: OwnerInstructions;
  previousEvidence?: OwnerInstructions;
  replaceInstruction?: boolean;
  task?: { id: string; revision: number };
  chat?: { threadId: string; id: string };
  rules?: string;
}

export type InstructionRevision = Pick<InstructionChange, 'task' | 'chat' | 'rules'> & {
  standingInstruction?: string;
};

export const ownerInstructionPolicy = `scheduledInstructions is an ordered list of owner inputs for this schedule. Each entry keeps its own time, text, edited fields and replyTo context. For recurring work such as each morning checking yesterday's report, relative dates refer to scheduledFor; use an entry's time when the owner makes a date relative to that message, such as start tomorrow. Only the scheduler or the owner starts a run, so the schedule's own run timing is always met; compare only conditions on what the run does. A later owner correction changes only what it addresses; every other limit remains. A later request to summarize only removes an earlier send grant. A recipient replacement removes the earlier recipient's grant. A full replacement needs clear owner intent. An entry with canAuthorize:false is background only: use it only to identify a reference or limit about the same work, ignore unrelated requests, and never quote it as permission. replyTo is the exact assistant proposal that entry answers, not evidence of earlier consent. Owner edits and approved patches in fields change only the named fields. A name, timing, watch or enable edit never grants new outside work. A fields.prompt value is a complete owner-written instruction and replaces earlier schedule scope. scheduledApproval.definition is an exact complete schedule definition the owner explicitly approved at scheduledApproval.at. Earlier inputs cannot restore grants or limits that complete instruction replaced. It covers only that schedule's work, subject to later owner corrections and current owner rules; approval of one action is never recurring permission. scheduledApproval never permits a change to Nod's own settings; those still need owner words. For an action covered by scheduledApproval use because "schedule approval". instructionChange contains before, changes and after for a proposed saved-instruction update. Its previousInstructions and previousApproval keep the same evidence roles as scheduledInstructions and scheduledApproval. Compare the complete after value against before and the owner's requested changes. Preserve each term the owner did not change. Removing a restriction can add permission and needs owner words covering that removal. Execution wording and proposed values cannot grant themselves permission.`;

export const bareConfirmationAnswer = (text: string) =>
  isMessageReaction(text.trim()) || /^(?:yes|no)[.!?]*$/i.test(text.trim());

export function ownerEdit(fields: Record<string, unknown>): OwnerInstructions {
  return {
    messages: [
      {
        id: null,
        at: new Date().toISOString(),
        text: typeof fields.prompt === 'string' ? fields.prompt : '',
        fields,
      },
    ],
  };
}

export function mergeOwnerInstructions(
  previous: OwnerInstructions | null,
  next: OwnerInstructions,
): OwnerInstructions {
  const messages = [...(previous?.messages ?? [])];
  for (const message of next.messages) {
    const index = message.id ? messages.findIndex((entry) => entry.id === message.id) : -1;
    if (index < 0) messages.push(message);
    else if (message.canAuthorize !== false && messages[index]!.canAuthorize === false)
      messages[index] = message;
  }
  const approvals = [
    ...(previous?.approvals ?? []),
    ...(next.approvals ?? []).filter(
      (entry) => !previous?.approvals?.some((old) => old.id === entry.id),
    ),
  ];
  messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    messages,
    ...(previous?.requiresReplacement || next.requiresReplacement
      ? { requiresReplacement: true }
      : {}),
    ...(approvals.length ? { approvals } : {}),
  };
}

export function hasOwnerInstructions(
  evidence: OwnerInstructions | null | undefined,
): evidence is OwnerInstructions {
  return Boolean(
    evidence &&
    (evidence.approvals?.length ||
      evidence.messages.some((message) => message.canAuthorize !== false && message.text.trim())),
  );
}

export function validateScheduledInstructions(evidence: OwnerInstructions | null | undefined) {
  if (evidence) validateSavedInstructions(evidence);
  if (!hasOwnerInstructions(evidence))
    throw Object.assign(
      new Error(
        'The schedule has no saved owner instruction. Supply a complete replacement instruction.',
      ),
      { notRun: true, code: 'owner_instruction_unavailable' },
    );
}

export function scheduledTexts(
  input: Pick<TrustWords, 'scheduledInstructions' | 'scheduledApproval'>,
): string[] {
  return [
    ...(input.scheduledInstructions ?? []).flatMap((message) => [
      message.text,
      message.replyTo?.text,
      typeof message.fields?.prompt === 'string' ? message.fields.prompt : undefined,
    ]),
    typeof input.scheduledApproval?.definition.prompt === 'string'
      ? input.scheduledApproval.definition.prompt
      : undefined,
  ].filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export function validateSavedInstructions(evidence: OwnerInstructions) {
  if (evidence.requiresReplacement)
    throw Object.assign(
      new Error(
        'The saved owner instruction has changes without source records. Supply a complete replacement instruction.',
      ),
      { notRun: true, code: 'owner_instruction_unavailable' },
    );
}

export async function validateOwnerInstructions(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  evidence: OwnerInstructions,
) {
  validateSavedInstructions(evidence);
  await validateInstructionSources(pool, ownerId, instructionSourceMessageIds(evidence));
}

export function instructionSourceMessageIds(evidence: OwnerInstructions) {
  return [
    ...new Set(
      evidence.messages.flatMap((message) =>
        [message.id, message.replyTo?.id].filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
}

async function validateInstructionSources(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  ids: string[],
) {
  if (!ids.length) return;
  const found = await pool.query<{ id: string }>(
    `SELECT m.id FROM messages m WHERE m.owner_id=$1 AND m.id=ANY($2::uuid[]) AND m.hidden_at IS NULL AND NOT ${withdrawnSql('m')}`,
    [ownerId, ids],
  );
  if (found.rows.length !== ids.length)
    throw Object.assign(
      new Error(
        'The saved owner instruction contains a withdrawn or unavailable message. Supply a complete replacement instruction.',
      ),
      { notRun: true, code: 'owner_instruction_unavailable' },
    );
}

export function instructionMessages(evidence: OwnerInstructions) {
  return evidence.messages.map(({ id, approvalId, replyTo, ...message }) => ({
    ...message,
    ...(replyTo ? { replyTo: { text: replyTo.text } } : {}),
  }));
}

const recentMessages = 20;

const excerpt = (text: string, limit: number) => {
  const characters = Array.from(text);
  return characters.length > limit
    ? `${characters.slice(0, limit / 2).join('')}\n…\n${characters.slice(-limit / 2).join('')}`
    : text;
};

export async function recentOwnerWords(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  threadId: string,
  requestIds: string[],
  taskId: string | null = null,
  turnId?: string,
) {
  const chat = turnId
    ? `(SELECT cu.bot_id FROM turns cu WHERE cu.id='${z.uuid().parse(turnId)}'::uuid AND cu.owner_id=$1)`
    : 'NULL::uuid';
  const { rows } = await pool.query<{
    id: string;
    text: string;
    created_at: Date;
    answer: boolean;
    reply_id: string | null;
    reply_text: string | null;
    reply_presentation: unknown;
    reply_withdrawn: boolean | null;
  }>(
    `WITH cleared AS (SELECT COALESCE((SELECT chat_cleared_at FROM threads WHERE id=$2 AND owner_id=$1),'-infinity'::timestamptz) AS at),
     visible AS NOT MATERIALIZED (SELECT m.id,m.created_at FROM messages m
         WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.hidden_at IS NULL
           AND (m.role='user' OR (m.role='assistant' AND m.turn_id IS NOT NULL))
           AND (m.text<>'' OR m.presentation IS NOT NULL)
           AND m.bot_id IS NOT DISTINCT FROM ${chat}${
             taskId
               ? ''
               : `
           AND NOT EXISTS (SELECT 1 FROM turns tt WHERE tt.owner_id=m.owner_id
             AND (tt.id=m.turn_id OR tt.message_id=m.id) AND tt.task_id IS NOT NULL)`
           }),
     anchors AS (${
       taskId
         ? 'SELECT t.created_at FROM tasks t WHERE t.id=$4::uuid AND t.owner_id=$1'
         : 'SELECT m.created_at FROM messages m WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.id=ANY($3::uuid[])'
     }),
     recent AS (${
       taskId
         ? ''
         : `(SELECT v.id FROM visible v,cleared WHERE v.created_at>=cleared.at
           AND v.created_at>now()-interval '24 hours'
           ORDER BY v.created_at DESC,v.id DESC LIMIT ${recentMessages}) UNION `
     }SELECT w.id FROM anchors r,cleared,LATERAL (SELECT v.id FROM visible v
           WHERE v.created_at<=r.created_at AND v.created_at>r.created_at-interval '24 hours'
             AND v.created_at>=CASE WHEN r.created_at>=cleared.at THEN cleared.at ELSE '-infinity'::timestamptz END
           ORDER BY v.created_at DESC,v.id DESC LIMIT ${recentMessages}) w${
             taskId
               ? ` UNION SELECT tm.id FROM turns tu JOIN messages tm ON tm.owner_id=tu.owner_id
           AND (tm.id=tu.message_id OR tm.turn_id=tu.id)
           WHERE tu.owner_id=$1 AND tu.task_id=$4::uuid AND tm.role='user'`
               : ''
           })
     SELECT m.id,m.text,m.created_at,r.id AS reply_id,r.text AS reply_text,r.presentation AS reply_presentation,
       r.withdrawn AS reply_withdrawn,EXISTS (SELECT 1 FROM approvals p
         JOIN turns e ON e.id=p.execution_turn_id AND e.owner_id=p.owner_id
         WHERE p.owner_id=$1 AND e.message_id=m.id) AS answer
     FROM (SELECT id FROM recent UNION SELECT unnest($3::uuid[])) ids
     JOIN messages m ON m.id=ids.id CROSS JOIN cleared
     LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
     LEFT JOIN LATERAL (SELECT a.id,a.text,a.presentation,${withdrawnSql('a')} AS withdrawn FROM messages a
         WHERE a.id=m.reply_to_message_id AND a.owner_id=$1 AND a.thread_id=$2 AND a.role='assistant'
           AND a.hidden_at IS NULL AND (a.text<>'' OR a.presentation IS NOT NULL)) explicit ON TRUE
     LEFT JOIN LATERAL (SELECT a.id,a.text,a.presentation,${withdrawnSql('a')} AS withdrawn FROM messages a
         JOIN turns t ON t.id=a.turn_id AND t.owner_id=a.owner_id
         WHERE m.reply_to_message_id IS NULL AND a.owner_id=$1 AND a.thread_id=$2 AND a.role='assistant'
           AND a.hidden_at IS NULL AND (a.text<>'' OR a.presentation IS NOT NULL)
           AND (a.created_at,a.id)<(m.created_at,m.id) AND a.created_at>m.created_at-interval '24 hours'
           AND a.created_at>=CASE WHEN m.created_at>=cleared.at THEN cleared.at ELSE '-infinity'::timestamptz END
           AND t.channel IS NOT DISTINCT FROM u.channel AND a.bot_id IS NOT DISTINCT FROM m.bot_id
         ORDER BY a.created_at DESC,a.id DESC LIMIT 1) implicit ON TRUE
     CROSS JOIN LATERAL (SELECT COALESCE(explicit.id,implicit.id) AS id,COALESCE(explicit.text,implicit.text) AS text,
         CASE WHEN explicit.id IS NOT NULL THEN explicit.presentation ELSE implicit.presentation END AS presentation,
         COALESCE(explicit.withdrawn,implicit.withdrawn) AS withdrawn) r
     WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.role='user' AND m.text<>'' AND m.hidden_at IS NULL
       AND m.approval_answer IS NULL AND NOT ${withdrawnSql('m')} AND m.bot_id IS NOT DISTINCT FROM ${chat}
       AND m.text NOT IN (SELECT task->>'title' FROM messages offer,jsonb_array_elements(offer.suggestions->'tasks') task
         WHERE offer.owner_id=$1 AND offer.thread_id=$2 AND offer.suggestions IS NOT NULL AND task->>'title' IS NOT NULL)
     ORDER BY m.created_at,m.id`,
    taskId ? [ownerId, threadId, requestIds, taskId] : [ownerId, threadId, requestIds],
  );
  const messages = rows.map((row) => {
    const replied = row.reply_id && !row.reply_withdrawn;
    const visual = replied ? presentationSchema.safeParse(row.reply_presentation) : undefined;
    const reply = replied
      ? [row.reply_text ?? '', visual?.success ? presentationText(visual.data) : '']
          .filter(Boolean)
          .join('\n\n')
      : '';
    return {
      id: row.id,
      at: row.created_at.toISOString(),
      text: row.text,
      answer: row.answer,
      ...(row.reply_id && reply ? { replyTo: { id: row.reply_id, text: reply } } : {}),
    };
  });
  return {
    words: {
      userMessages: messages.map(({ replyTo, answer, ...message }) => ({
        ...message,
        ...(answer ? { canAuthorize: false } : {}),
        ...(replyTo ? { replyTo: excerpt(replyTo.text, 2000) } : {}),
      })),
    } satisfies TrustWords,
    evidence: (messageId?: string): OwnerInstructions => ({
      messages: messages
        .filter((message) => !message.answer && message.id === messageId)
        .map(({ id, at, text, replyTo }) => ({ id, at, text, ...(replyTo ? { replyTo } : {}) })),
    }),
  };
}

export async function validateInstructionChange(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  change: InstructionChange,
) {
  await validateOwnerInstructions(pool, ownerId, change.evidence);
  if (change.previousEvidence) validateSavedInstructions(change.previousEvidence);
  await validateInstructionRevision(pool, ownerId, change);
}

export async function validateInstructionRevision(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  change: InstructionRevision,
) {
  if (
    change.chat &&
    (await ownerChatRevision(pool, ownerId, change.chat.threadId, change.chat.id)) !==
      change.chat.id
  )
    throw Object.assign(
      new Error(
        'The owner changed this request while the instruction was being checked. The earlier change did not run.',
      ),
      { notRun: true },
    );
  if (change.rules !== undefined) {
    const rules =
      (
        await pool.query<{ rules: string }>(
          'SELECT rules FROM preferences WHERE owner_id=$1 FOR SHARE',
          [ownerId],
        )
      ).rows[0]?.rules.trim() ?? '';
    if (rules !== change.rules)
      throw Object.assign(
        new Error(
          'The owner rules changed while the instruction was being checked. The earlier change did not run.',
        ),
        { notRun: true },
      );
  }
  if (change.standingInstruction !== undefined) {
    const standing =
      (
        await pool.query<{ notification_rule: string }>(
          'SELECT notification_rule FROM preferences WHERE owner_id=$1 FOR SHARE',
          [ownerId],
        )
      ).rows[0]?.notification_rule.trim() ?? '';
    if (standing !== change.standingInstruction)
      throw Object.assign(
        new Error(
          'The standing instruction changed while the action was being checked. The earlier change did not run.',
        ),
        { notRun: true },
      );
  }
  if (change.task) {
    const row = (
      await pool.query<{ revision: number }>(
        'SELECT revision FROM tasks WHERE id=$1 AND owner_id=$2 FOR SHARE',
        [change.task.id, ownerId],
      )
    ).rows[0];
    if (row?.revision !== change.task.revision)
      throw Object.assign(
        new Error(
          'The owner changed this task while the instruction was being checked. The earlier change did not run.',
        ),
        { notRun: true },
      );
  }
}

export async function ownerChatRevision(
  pool: Pick<Pool, 'query'>,
  ownerId: string,
  threadId: string,
  sameChatAs: string | null = null,
) {
  return (
    await pool.query<{ id: string }>(
      `SELECT m.id FROM messages m WHERE m.owner_id=$1 AND m.thread_id=$2 AND m.role='user' AND m.hidden_at IS NULL
    AND m.bot_id IS NOT DISTINCT FROM (SELECT x.bot_id FROM messages x WHERE x.id=$3::uuid AND x.owner_id=$1)
    AND EXISTS (SELECT 1 FROM turns s WHERE s.owner_id=$1 AND s.thread_id=m.thread_id AND s.source='user' AND (s.message_id=m.id OR s.id=m.turn_id))
    AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.owner_id=$1 AND (u.message_id=m.id OR u.id=m.turn_id) AND to_jsonb(u)->>'task_id' IS NOT NULL)
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
      [ownerId, threadId, sameChatAs],
    )
  ).rows[0]?.id;
}
