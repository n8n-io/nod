import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export type CardInteractionStatus =
  'open' | 'selected' | 'fulfilled' | 'superseded' | 'expired' | 'cancelled';

export interface CardInteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface CardInteractionRecord {
  id: string;
  messageId: string;
  turnId: string | null;
  sessionId: string;
  taskId: string | null;
  taskRevision: number | null;
  options: CardInteractionOption[];
  multiple: boolean;
  status: CardInteractionStatus;
  selectedOptionIds?: string[];
  validUntil?: string;
}

const storedOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export function createCardInteractions(pool: Pool, ownerId: string) {
  async function saveOffers(
    client: Pick<PoolClient, 'query'>,
    threadId: string,
    kind: string,
    offers: Array<{ id: string; payload: unknown; validUntil?: Date }>,
  ) {
    for (const offer of offers) {
      await client.query(
        `INSERT INTO card_offers(id,owner_id,thread_id,kind,payload,valid_until)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (owner_id,thread_id,id) DO UPDATE
           SET kind=EXCLUDED.kind,payload=EXCLUDED.payload,valid_until=EXCLUDED.valid_until,created_at=now()`,
        [
          offer.id,
          ownerId,
          threadId,
          kind,
          JSON.stringify(offer.payload),
          offer.validUntil ?? null,
        ],
      );
    }
  }

  async function loadOffers(
    client: Pick<PoolClient, 'query'>,
    threadId: string,
    kind: string,
    ids: string[],
  ) {
    if (!ids.length) return new Map<string, { payload: unknown; expired: boolean }>();
    const { rows } = await client.query<{
      id: string;
      payload: unknown;
      valid_until: Date | null;
    }>(
      `SELECT id,payload,valid_until FROM card_offers
       WHERE owner_id=$1 AND thread_id=$2 AND kind=$3 AND id=ANY($4::text[])`,
      [ownerId, threadId, kind, ids],
    );
    const now = Date.now();
    return new Map(
      rows.map((row) => [
        row.id,
        {
          payload: row.payload,
          expired: row.valid_until !== null && row.valid_until.getTime() < now,
        },
      ]),
    );
  }

  async function openInteraction(
    client: Pick<PoolClient, 'query'>,
    input: {
      threadId: string;
      messageId: string;
      turnId?: string;
      sessionId: string;
      taskId?: string | null;
      taskRevision?: number | null;
      options: CardInteractionOption[];
      multiple?: boolean;
      validUntil?: Date;
    },
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO card_interactions(id,owner_id,thread_id,message_id,turn_id,session_id,task_id,task_revision,options,multiple,status,valid_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'open',$11)`,
      [
        id,
        ownerId,
        input.threadId,
        input.messageId,
        input.turnId ?? null,
        input.sessionId,
        input.taskId ?? null,
        input.taskRevision ?? null,
        JSON.stringify(input.options),
        input.multiple ?? false,
        input.validUntil ?? null,
      ],
    );
    return id;
  }

  async function supersedeSession(
    client: Pick<PoolClient, 'query'>,
    sessionId: string,
    exceptTurnId?: string,
    status: 'superseded' | 'cancelled' = 'superseded',
  ) {
    await client.query(
      `UPDATE card_interactions SET status=$4,updated_at=now()
       WHERE owner_id=$1 AND session_id=$2 AND status='open'
         AND ($3::uuid IS NULL OR turn_id IS DISTINCT FROM $3)`,
      [ownerId, sessionId, exceptTurnId ?? null, status],
    );
  }

  async function fulfillSession(client: Pick<PoolClient, 'query'>, sessionId: string) {
    await client.query(
      `UPDATE card_interactions SET status='fulfilled',updated_at=now()
       WHERE owner_id=$1 AND session_id=$2 AND status='selected'`,
      [ownerId, sessionId],
    );
  }

  async function selectInteraction(
    client: Pick<PoolClient, 'query'>,
    interactionId: string,
    optionIds: string[],
  ): Promise<
    | {
        ok: true;
        interaction: CardInteractionRecord;
        selected: CardInteractionOption[];
        alreadySelected: boolean;
      }
    | { ok: false; code: 'not_found' | 'closed' | 'expired' | 'invalid_option'; status: string }
  > {
    const row = (
      await client.query<{
        id: string;
        message_id: string;
        turn_id: string | null;
        session_id: string;
        task_id: string | null;
        task_revision: number | null;
        options: unknown;
        multiple: boolean;
        status: CardInteractionStatus;
        selected_option_ids: unknown;
        valid_until: Date | null;
        current_revision: number | null;
      }>(
        `SELECT ci.*,t.revision AS current_revision
         FROM card_interactions ci
         LEFT JOIN tasks t ON t.id=ci.task_id AND t.owner_id=ci.owner_id
         WHERE ci.id=$1 AND ci.owner_id=$2 FOR UPDATE OF ci`,
        [interactionId, ownerId],
      )
    ).rows[0];
    if (!row) return { ok: false, code: 'not_found', status: 'not_found' };
    const options = z.array(storedOption).parse(row.options);
    if (
      row.status === 'selected' &&
      Array.isArray(row.selected_option_ids) &&
      row.selected_option_ids.length === optionIds.length &&
      optionIds.every((id) => (row.selected_option_ids as string[]).includes(id))
    ) {
      const selected = options.filter((opt) => optionIds.includes(opt.id));
      return {
        ok: true,
        alreadySelected: true,
        selected,
        interaction: {
          id: row.id,
          messageId: row.message_id,
          turnId: row.turn_id,
          sessionId: row.session_id,
          taskId: row.task_id,
          taskRevision: row.task_revision,
          options,
          multiple: row.multiple,
          status: row.status,
          selectedOptionIds: row.selected_option_ids as string[],
          ...(row.valid_until ? { validUntil: row.valid_until.toISOString() } : {}),
        },
      };
    }
    if (row.status !== 'open') return { ok: false, code: 'closed', status: row.status };
    if (row.valid_until && row.valid_until.getTime() < Date.now()) {
      await client.query(
        "UPDATE card_interactions SET status='expired',updated_at=now() WHERE id=$1 AND owner_id=$2",
        [interactionId, ownerId],
      );
      return { ok: false, code: 'expired', status: 'expired' };
    }
    if (
      row.task_id &&
      row.task_revision !== null &&
      row.current_revision !== null &&
      row.current_revision !== row.task_revision
    ) {
      await client.query(
        "UPDATE card_interactions SET status='superseded',updated_at=now() WHERE id=$1 AND owner_id=$2",
        [interactionId, ownerId],
      );
      return { ok: false, code: 'closed', status: 'superseded' };
    }
    const unique = [...new Set(optionIds)];
    const selected = options.filter((opt) => unique.includes(opt.id));
    if (
      !unique.length ||
      unique.length !== optionIds.length ||
      selected.length !== unique.length ||
      (!row.multiple && selected.length !== 1)
    )
      return { ok: false, code: 'invalid_option', status: row.status };
    await client.query(
      "UPDATE card_interactions SET status='selected',selected_option_ids=$3::jsonb,updated_at=now() WHERE id=$1 AND owner_id=$2",
      [interactionId, ownerId, JSON.stringify(unique)],
    );
    return {
      ok: true,
      alreadySelected: false,
      selected,
      interaction: {
        id: row.id,
        messageId: row.message_id,
        turnId: row.turn_id,
        sessionId: row.session_id,
        taskId: row.task_id,
        taskRevision: row.task_revision,
        options,
        multiple: row.multiple,
        status: 'selected',
        selectedOptionIds: unique,
        ...(row.valid_until ? { validUntil: row.valid_until.toISOString() } : {}),
      },
    };
  }

  async function expireOffers() {
    await pool.query(
      'DELETE FROM card_offers WHERE owner_id=$1 AND valid_until IS NOT NULL AND valid_until<now()',
      [ownerId],
    );
    await pool.query(
      "UPDATE card_interactions SET status='expired',updated_at=now() WHERE owner_id=$1 AND status='open' AND valid_until IS NOT NULL AND valid_until<now()",
      [ownerId],
    );
  }

  return {
    saveOffers,
    loadOffers,
    openInteraction,
    supersedeSession,
    fulfillSession,
    selectInteraction,
    expireOffers,
  };
}
