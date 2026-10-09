import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultActivityReason,
  VaultPermission,
} from '../shared/contracts.ts';
import type { SignInVerdict } from './trust.ts';
import type { TurnRef } from './thread.ts';
import { parentTurnSql } from './turn-chain.ts';
import { credentialOrigin } from './vault.ts';

type Kind = 'sign_in' | 'session' | 'form';
type Row = {
  id: string;
  at: Date;
  action: VaultActivityEntry['action'];
  origin: string;
  item_id: string | null;
  item_kind: 'login' | 'session' | null;
  task: string;
  reason: VaultActivityReason;
};

export type VaultAccessVerdict =
  | { ok: true; reason: VaultActivityReason }
  | { ok: false; message: string }
  | { ok: false; question: string };

const heldMessages = {
  readonly: 'This turn can only read. Do not sign in.',
  background:
    'Work Otto starts on its own does not sign in or open saved sessions. Tell the owner this site needs them.',
  injection:
    'Sign-in is held because a page or result contained instructions for AI assistants. Ask the owner before signing in.',
} as const;

const cursor = z.object({ at: z.iso.datetime(), id: z.uuid() });

function host(origin: string) {
  return new URL(origin).host;
}

export async function createVaultAccess(
  pool: Pool,
  options: {
    ownerId: string;
    check(
      turn: TurnRef,
      target: { origin: string; account?: string },
      granted: boolean,
    ): Promise<SignInVerdict>;
    refresh?(): void;
  },
) {
  const { ownerId } = options;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_grants (
      id uuid PRIMARY KEY, owner_id text NOT NULL, origin text NOT NULL,
      root_turn_id uuid, standing boolean NOT NULL DEFAULT false,
      source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vault_grants_standing ON vault_grants(owner_id,origin) WHERE standing;
    CREATE UNIQUE INDEX IF NOT EXISTS vault_grants_turn ON vault_grants(owner_id,root_turn_id,origin) WHERE NOT standing;
    CREATE TABLE IF NOT EXISTS vault_activity (
      id uuid PRIMARY KEY, owner_id text NOT NULL, at timestamptz NOT NULL DEFAULT now(),
      action text NOT NULL, origin text NOT NULL, item_id uuid, item_kind text,
      turn_id uuid, root_turn_id uuid, task text NOT NULL DEFAULT '', reason text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vault_activity_owner_time ON vault_activity(owner_id,at DESC,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS vault_activity_once ON vault_activity(owner_id,root_turn_id,origin,action);
    DELETE FROM vault_activity WHERE at<now()-interval '90 days';
    DELETE FROM vault_grants WHERE NOT standing AND created_at<now()-interval '7 days';
  `);

  async function root(turn: TurnRef) {
    const link = parentTurnSql('u');
    const { rows } = await pool.query<{ id: string; prompt: string }>(
      `WITH RECURSIVE chain(id,next) AS (
         SELECT u.id,${link} FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
         UNION
         SELECT u.id,${link} FROM chain c JOIN turns u ON u.id=c.next AND u.owner_id=$2
       )
       SELECT u.id,u.prompt FROM chain c JOIN turns u ON u.id=c.id AND u.owner_id=$2
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
    return { id: row.id, task: task.length > 120 ? `${task.slice(0, 119)}…` : task };
  }

  async function grant(rootTurnId: string, origin: string) {
    const { rows } = await pool.query<{ source: string; standing: boolean }>(
      `SELECT source,standing FROM vault_grants WHERE owner_id=$1 AND origin=$2
       AND (standing OR root_turn_id=$3) ORDER BY standing LIMIT 1`,
      [ownerId, origin, rootTurnId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return (row.standing ? 'always' : row.source) as VaultActivityReason;
  }

  async function record(
    turn: TurnRef,
    entry: {
      action: VaultActivityEntry['action'];
      origin: string;
      reason: VaultActivityReason;
      itemId?: string;
      itemKind?: 'login' | 'session';
    },
  ) {
    const chain = await root(turn);
    await pool.query(
      `INSERT INTO vault_activity(id,owner_id,action,origin,item_id,item_kind,turn_id,root_turn_id,task,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (owner_id,root_turn_id,origin,action) DO UPDATE
       SET item_id=COALESCE(vault_activity.item_id,excluded.item_id),item_kind=COALESCE(vault_activity.item_kind,excluded.item_kind)`,
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
      ],
    );
    options.refresh?.();
  }

  async function authorize(
    turn: TurnRef,
    target: { origin: string; kind: Kind; account?: string },
  ): Promise<VaultAccessVerdict> {
    const origin = credentialOrigin(target.origin);
    const chain = await root(turn);
    const granted = await grant(chain.id, origin);
    const verdict = await options.check(
      turn,
      { origin, ...(target.account ? { account: target.account } : {}) },
      Boolean(granted),
    );
    const itemKind = target.kind === 'session' ? { itemKind: 'session' as const } : {};
    const pass = async (reason: VaultActivityReason) => {
      if (!granted)
        await pool.query(
          `INSERT INTO vault_grants(id,owner_id,origin,root_turn_id,source) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (owner_id,root_turn_id,origin) WHERE NOT standing DO NOTHING`,
          [randomUUID(), ownerId, origin, chain.id, reason],
        );
      return { ok: true as const, reason };
    };
    const hold = async (reason: 'readonly' | 'background' | 'injection') => {
      await record(turn, { action: 'held', origin, reason, ...itemKind });
      return { ok: false as const, message: heldMessages[reason] };
    };
    if ('allowed' in verdict) {
      if (!verdict.allowed) return hold(verdict.reason);
      return pass(verdict.reason === 'granted' ? (granted ?? 'allowed') : verdict.reason);
    }
    if (target.kind === 'form')
      return verdict.reason === 'injection' ? hold('injection') : pass('entered');
    await record(turn, { action: 'asked', origin, reason: verdict.reason, ...itemKind });
    const site = host(origin);
    return {
      ok: false,
      question:
        target.kind === 'session'
          ? `Use your saved session on ${site}?`
          : target.account
            ? `Sign in to ${site} as ${target.account}?`
            : `Sign in to ${site}?`,
    };
  }

  async function permitted(turn: TurnRef, rawOrigin: string) {
    const origin = credentialOrigin(rawOrigin);
    const granted = await grant((await root(turn)).id, origin);
    if (!granted) return false;
    const verdict = await options.check(turn, { origin }, true);
    return 'allowed' in verdict && verdict.allowed;
  }

  async function allow(context: { threadId: string; turnId: string }, raw: unknown) {
    const { origin } = z
      .object({ origin: z.string().max(2048) })
      .strict()
      .parse(raw);
    const exact = credentialOrigin(origin);
    const chain = await root(context);
    await pool.query(
      `INSERT INTO vault_grants(id,owner_id,origin,root_turn_id,source) VALUES($1,$2,$3,$4,'allowed')
       ON CONFLICT (owner_id,root_turn_id,origin) WHERE NOT standing DO UPDATE SET source='allowed'`,
      [randomUUID(), ownerId, exact, chain.id],
    );
    return { allowed: true, website: exact, message: `You allowed signing in to ${host(exact)}.` };
  }

  async function activity(query: { before?: unknown; origin?: unknown }): Promise<VaultActivity> {
    const before = query.before === undefined ? undefined : cursor.parse(query.before);
    const origin =
      typeof query.origin === 'string' && query.origin ? credentialOrigin(query.origin) : undefined;
    const { rows } = await pool.query<Row>(
      `SELECT id,at,action,origin,item_id,item_kind,task,reason FROM vault_activity
       WHERE owner_id=$1 AND ($2::text IS NULL OR origin=$2)
       AND ($3::timestamptz IS NULL OR (at,id)<($3,$4::uuid))
       ORDER BY at DESC,id DESC LIMIT 51`,
      [ownerId, origin ?? null, before?.at ?? null, before?.id ?? null],
    );
    const page = rows.slice(0, 50);
    const week = (
      await pool.query<{ signed: number; held: number; asked: number }>(
        `SELECT count(*) FILTER (WHERE action IN ('sign_in','session'))::int AS signed,
                count(*) FILTER (WHERE action='held')::int AS held,
                count(*) FILTER (WHERE action='asked')::int AS asked
         FROM vault_activity WHERE owner_id=$1 AND at>now()-interval '7 days'`,
        [ownerId],
      )
    ).rows[0]!;
    const last = page.at(-1);
    return {
      week: { signIns: week.signed, held: week.held, asked: week.asked },
      entries: page.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        origin: row.origin,
        ...(row.item_id ? { itemId: row.item_id } : {}),
        ...(row.item_kind ? { itemKind: row.item_kind } : {}),
        task: row.task,
        reason: row.reason,
      })),
      ...(rows.length > 50 && last ? { next: { at: last.at.toISOString(), id: last.id } } : {}),
    };
  }

  async function permissions(): Promise<VaultPermission[]> {
    const { rows } = await pool.query<{ id: string; origin: string; created_at: Date }>(
      'SELECT id,origin,created_at FROM vault_grants WHERE owner_id=$1 AND standing ORDER BY origin',
      [ownerId],
    );
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async function always(raw: unknown) {
    const { origin } = z
      .object({ origin: z.string().max(2048) })
      .strict()
      .parse(raw);
    const exact = credentialOrigin(origin);
    await pool.query(
      `INSERT INTO vault_grants(id,owner_id,origin,standing,source) VALUES($1,$2,$3,true,'always')
       ON CONFLICT (owner_id,origin) WHERE standing DO NOTHING`,
      [randomUUID(), ownerId, exact],
    );
    options.refresh?.();
    return permissions();
  }

  async function revoke(origin: string) {
    await pool.query('DELETE FROM vault_grants WHERE owner_id=$1 AND origin=$2 AND standing', [
      ownerId,
      credentialOrigin(origin),
    ]);
    options.refresh?.();
  }

  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status = error instanceof z.ZodError ? 400 : 500;
        reply.code(status).send({
          error: status === 400 ? 'Check the request.' : 'The Vault activity is unavailable.',
        });
      });
      scope.get<{ Querystring: { at?: string; id?: string; origin?: string } }>(
        '/api/vault/activity',
        async (request) =>
          activity({
            ...(request.query.at || request.query.id
              ? { before: { at: request.query.at, id: request.query.id } }
              : {}),
            origin: request.query.origin,
          }),
      );
      scope.get('/api/vault/permissions', permissions);
      scope.put('/api/vault/permissions', { bodyLimit: 4096 }, async (request) =>
        always(request.body),
      );
      scope.delete<{ Querystring: { origin?: string } }>(
        '/api/vault/permissions',
        async (request) => {
          await revoke(z.string().max(2048).parse(request.query.origin));
          return permissions();
        },
      );
    });
  }

  return {
    authorize,
    permitted,
    record,
    allow,
    activity,
    permissions,
    always,
    revoke,
    registerRoutes,
  };
}
