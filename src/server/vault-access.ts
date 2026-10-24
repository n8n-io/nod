import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultActivityReason,
} from '../shared/contracts.ts';
import type { TrustReason } from './trust.ts';
import { becauseOf, type TrustBasis } from './trust-basis.ts';
import type { TurnRef } from './thread.ts';
import { turnOrigin } from './approvals.ts';
import { turnChainSql } from './turn-chain.ts';
import { credentialOrigin, VaultError } from './vault.ts';

type Kind = 'sign_in' | 'session' | 'form';
type Row = {
  id: string;
  at: Date;
  cursor: string;
  action: VaultActivityEntry['action'];
  origin: string;
  item_id: string | null;
  item_kind: VaultActivityEntry['itemKind'] | null;
  amount_minor: string | null;
  currency: string | null;
  task: string;
  reason: VaultActivityReason;
  basis: TrustBasis | null;
  said: boolean;
};

export type VaultAccessVerdict =
  | { ok: true; reason: VaultActivityReason; basis?: TrustBasis }
  | { ok: false; details: Record<string, unknown>; args: Record<string, unknown> };

const cursor = z.object({ at: z.iso.datetime(), id: z.uuid() });

function host(origin: string) {
  return new URL(origin).host;
}

type Chain = { id: string; ids: string[]; task: string };

export async function createVaultAccess(
  pool: Pool,
  options: {
    ownerId: string;
    check(
      turn: TurnRef,
      action: string,
      args: Record<string, unknown>,
    ): Promise<{ confirm: false; basis: TrustBasis } | { confirm: true; reason: TrustReason }>;
    refresh?(): void;
  },
) {
  const { ownerId } = options;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_activity (
      id uuid PRIMARY KEY, owner_id text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
      action text NOT NULL, origin text NOT NULL, item_id uuid, item_kind text,
      turn_id uuid, root_turn_id uuid, task text NOT NULL DEFAULT '', reason text NOT NULL,
      payment_id uuid, amount_minor bigint, currency text
    );
    CREATE INDEX IF NOT EXISTS vault_activity_owner_time ON vault_activity(owner_id,at DESC,id DESC);
    DROP INDEX IF EXISTS vault_activity_once;
    UPDATE vault_activity SET action='card' WHERE action='paid';
    CREATE UNIQUE INDEX IF NOT EXISTS vault_activity_payment ON vault_activity(owner_id,payment_id,action) WHERE payment_id IS NOT NULL;
    ALTER TABLE vault_activity ADD COLUMN IF NOT EXISTS basis jsonb;
    DROP TABLE IF EXISTS vault_grants, vault_browser, vault_browser_holder;
  `);

  async function root(turn: TurnRef, database: Pool | PoolClient = pool): Promise<Chain> {
    const { rows } = await database.query<{ id: string; prompt: string; ids: string[] }>(
      `${turnChainSql()}
       SELECT u.id,u.prompt,(SELECT array_agg(id) FROM chain) AS ids FROM chain c JOIN turns u ON u.id=c.id AND u.owner_id=$2
       WHERE NOT EXISTS (SELECT 1 FROM chain p WHERE p.id=c.next) LIMIT 1`,
      [turn.turnId, ownerId, turn.threadId],
    );
    const row = rows[0];
    if (!row) throw new Error('This turn is no longer running.');
    const task = row.prompt
      .split('\n')[0]!
      .replace(/^Scheduled task:\s*/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      id: row.id,
      ids: row.ids,
      task: task.length > 120 ? `${task.slice(0, 119)}…` : task,
    };
  }

  async function confirmed(chain: Chain, args: Record<string, unknown>) {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM approvals WHERE owner_id=$1 AND action='NOD_vault_allow' AND status='completed'
       AND turn_id=ANY($2::uuid[]) AND args=$3::jsonb LIMIT 1`,
      [ownerId, chain.ids, args],
    );
    return Boolean(rowCount);
  }

  async function log(
    turn: TurnRef,
    chain: Chain,
    entry: {
      action: VaultActivityEntry['action'];
      origin: string;
      reason: VaultActivityReason;
      itemId?: string;
      itemKind?: VaultActivityEntry['itemKind'];
      payment?: { id: string; minor: number; currency: string };
      basis?: TrustBasis;
    },
    database: Pool | PoolClient = pool,
  ) {
    await database.query(
      `INSERT INTO vault_activity(id,owner_id,action,origin,item_id,item_kind,turn_id,root_turn_id,task,reason,payment_id,amount_minor,currency,basis)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ${entry.payment ? 'ON CONFLICT (owner_id,payment_id,action) WHERE payment_id IS NOT NULL DO NOTHING' : ''}`,
      [
        randomUUID(),
        ownerId,
        entry.action,
        entry.origin,
        entry.itemId ?? null,
        entry.itemKind ?? null,
        turn.turnId,
        chain.id,
        chain.task,
        entry.reason,
        entry.payment?.id ?? null,
        entry.payment?.minor ?? null,
        entry.payment?.currency ?? null,
        entry.basis ? JSON.stringify(entry.basis) : null,
      ],
    );
    options.refresh?.();
  }

  async function record(
    turn: TurnRef,
    entry: Parameters<typeof log>[2],
    database: Pool | PoolClient = pool,
  ) {
    await log(turn, await root(turn, database), entry, database);
  }

  async function used(
    turn: TurnRef,
    entry: { origin: string; reason: 'entered' | 'picked'; itemId?: string },
    database: Pool | PoolClient = pool,
  ) {
    await log(
      turn,
      await root(turn, database),
      {
        action: 'sign_in',
        origin: entry.origin,
        reason: entry.reason,
        ...(entry.itemId ? { itemId: entry.itemId, itemKind: 'login' as const } : {}),
      },
      database,
    );
  }

  async function authorize(
    turn: TurnRef,
    target: {
      origin: string;
      kind: Kind;
      account?: string;
      itemId?: string;
      sessionOrigin?: string;
    },
  ): Promise<VaultAccessVerdict> {
    const origin = credentialOrigin(target.origin);
    const sessionOrigin = target.sessionOrigin ? credentialOrigin(target.sessionOrigin) : undefined;
    const work = await turnOrigin(turn.turnId);
    if (!work) throw new Error('This turn is no longer running.');
    const chain = await root(turn);
    const itemKind = target.kind === 'session' ? { itemKind: 'session' as const } : {};
    if (target.kind === 'form') return { ok: true, reason: 'entered' };
    const args = {
      origin,
      kind: target.kind,
      ...(target.itemId ? { itemId: target.itemId } : {}),
      ...(sessionOrigin ? { sessionOrigin } : {}),
    };
    if (await confirmed(chain, args))
      return { ok: true, reason: 'allowed', basis: { kind: 'approved' } };
    const verdict = await options.check(
      turn,
      target.kind === 'session' ? 'NOD_browser_session' : 'NOD_sign_in',
      {
        website: origin,
        ...(target.account ? { account: target.account } : {}),
        ...(sessionOrigin ? { savedSessionWebsite: sessionOrigin } : {}),
      },
    );
    if (!verdict.confirm)
      return {
        ok: true,
        reason: work.source === 'schedule' ? 'schedule' : 'asked',
        basis: verdict.basis,
      };
    await log(turn, chain, { action: 'asked', origin, reason: verdict.reason, ...itemKind });
    return {
      ok: false,
      args,
      details: {
        kind: target.kind,
        origin,
        ...(target.account ? { account: target.account } : {}),
        ...(sessionOrigin ? { savedSessionWebsite: sessionOrigin } : {}),
        reason: verdict.reason,
      },
    };
  }

  async function allow(raw: unknown) {
    const { origin } = z
      .object({
        origin: z.string().max(2048),
        kind: z.enum(['sign_in', 'session', 'form']).optional(),
        itemId: z.string().max(100).optional(),
        sessionOrigin: z.string().max(2048).optional(),
      })
      .strict()
      .parse(raw);
    const exact = credentialOrigin(origin);
    return {
      allowed: true,
      website: exact,
      message: `Access to ${host(exact)} is approved. No credential entry or saved-session use has run. Take a fresh snapshot and call the tool again.`,
    };
  }

  async function activity(query: {
    before?: unknown;
    origin?: unknown;
    item?: unknown;
  }): Promise<VaultActivity> {
    const before = query.before === undefined ? undefined : cursor.parse(query.before);
    const origin =
      typeof query.origin === 'string' && query.origin ? credentialOrigin(query.origin) : undefined;
    const item =
      query.item === undefined || query.item === '' ? undefined : z.uuid().parse(query.item);
    const { rows } = await pool.query<Row>(
      `SELECT id,at,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor,
       action,origin,item_id,item_kind,amount_minor,currency,task,reason,basis,
       EXISTS(SELECT 1 FROM messages m WHERE a.basis->>'kind'='message'
         AND m.owner_id=$1 AND m.id=(a.basis->>'messageId')::uuid) AS said
       FROM vault_activity a
       WHERE owner_id=$1 AND ($2::text IS NULL OR origin=$2) AND ($5::uuid IS NULL OR item_id=$5)
       AND ($3::timestamptz IS NULL OR (at,id)<($3,$4::uuid))
       ORDER BY at DESC,id DESC LIMIT 51`,
      [ownerId, origin ?? null, before?.at ?? null, before?.id ?? null, item ?? null],
    );
    const page = rows.slice(0, 50);
    const week = (
      await pool.query<{ signed: number; paid: number; held: number }>(
        `SELECT count(*) FILTER (WHERE action IN ('sign_in','session'))::int AS signed,
                count(*) FILTER (WHERE action='card')::int AS paid,
                count(*) FILTER (WHERE action='held')::int AS held
         FROM vault_activity WHERE owner_id=$1 AND at>now()-interval '7 days'`,
        [ownerId],
      )
    ).rows[0]!;
    const last = page.at(-1);
    return {
      week: { signIns: week.signed, payments: week.paid, held: week.held },
      entries: page.map((row) => {
        const because = becauseOf(row.basis, row.said);
        return {
          id: row.id,
          at: row.at.toISOString(),
          action: row.action,
          origin: row.origin,
          ...(row.item_id ? { itemId: row.item_id } : {}),
          ...(row.item_kind ? { itemKind: row.item_kind } : {}),
          ...(row.amount_minor !== null && row.currency
            ? { amount: { minor: Number(row.amount_minor), currency: row.currency } }
            : {}),
          task: row.task,
          reason: row.reason,
          ...(because ? { because } : {}),
        };
      }),
      ...(rows.length > 50 && last ? { next: { at: last.cursor, id: last.id } } : {}),
    };
  }

  async function ownerUse(
    entry: {
      action: 'reveal';
      origin: string;
      itemId: string;
      itemKind: 'login' | 'card';
    },
    database: Pool | PoolClient = pool,
  ) {
    await database.query(
      `INSERT INTO vault_activity(id,owner_id,action,origin,item_id,item_kind,reason,task)
      VALUES($1,$2,$3,$4,$5,$6,'owner','')`,
      [randomUUID(), ownerId, entry.action, entry.origin, entry.itemId, entry.itemKind],
    );
    options.refresh?.();
  }

  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof VaultError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        reply.code(status).send({
          error:
            error instanceof VaultError
              ? error.message
              : status === 400
                ? 'Check the request.'
                : 'Login and card activity is unavailable.',
        });
      });
      scope.get<{ Querystring: { at?: string; id?: string; origin?: string; item?: string } }>(
        '/api/vault/activity',
        async (request) =>
          activity({
            ...(request.query.at || request.query.id
              ? { before: { at: request.query.at, id: request.query.id } }
              : {}),
            origin: request.query.origin,
            item: request.query.item,
          }),
      );
    });
  }

  return {
    ownerUse,
    authorize,
    record,
    used,
    allow,
    activity,
    registerRoutes,
  };
}
