import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultActivityReason,
  VaultPermission,
} from '../shared/contracts.ts';
import type { SignInVerdict } from './trust.ts';
import type { TurnRef } from './thread.ts';
import { turnOrigin } from './approvals.ts';
import { parentTurnSql } from './turn-chain.ts';
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

type Chain = { id: string; task: string; conversation: boolean };

const active = "interval '30 minutes'";

export async function createVaultAccess(
  pool: Pool,
  options: {
    ownerId: string;
    account?(itemKey: string): Promise<string | undefined>;
    check(
      turn: TurnRef,
      target: { origin: string; account?: string; destinations?: string[] },
      granted?: VaultActivityReason,
    ): Promise<SignInVerdict>;
    refresh?(): void;
  },
) {
  const { ownerId } = options;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_grants (
      id uuid PRIMARY KEY, owner_id text NOT NULL, origin text NOT NULL, scope text NOT NULL,
      root_turn_id uuid, source text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      used_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS vault_grants_standing ON vault_grants(owner_id,origin) WHERE scope='standing';
    ALTER TABLE vault_grants ADD COLUMN IF NOT EXISTS item_key text NOT NULL DEFAULT '';
    DROP INDEX IF EXISTS vault_grants_task;
    CREATE UNIQUE INDEX IF NOT EXISTS vault_grants_task_item ON vault_grants(owner_id,root_turn_id,origin,item_key) WHERE scope='task';
    DELETE FROM vault_grants WHERE scope='conversation';
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
    CREATE TABLE IF NOT EXISTS vault_browser (
      owner_id text NOT NULL, thread_id uuid NOT NULL, origin text NOT NULL, item_key text NOT NULL DEFAULT '',
      CONSTRAINT vault_browser_item_pkey PRIMARY KEY(owner_id,thread_id,origin,item_key)
    );
    ALTER TABLE vault_browser ADD COLUMN IF NOT EXISTS item_key text NOT NULL DEFAULT '';
    ALTER TABLE vault_browser DROP CONSTRAINT IF EXISTS vault_browser_pkey;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='vault_browser'::regclass AND contype='p') THEN
        ALTER TABLE vault_browser ADD CONSTRAINT vault_browser_item_pkey PRIMARY KEY(owner_id,thread_id,origin,item_key);
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS vault_browser_holder (
      owner_id text NOT NULL, thread_id uuid NOT NULL, root_turn_id uuid NOT NULL, turn_id uuid NOT NULL,
      conversation boolean NOT NULL, used_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_id,thread_id)
    );
    DELETE FROM vault_activity WHERE at<now()-interval '90 days';
    DELETE FROM vault_grants WHERE scope='task' AND created_at<now()-interval '7 days';
  `);

  async function root(turn: TurnRef, database: Pool | PoolClient = pool): Promise<Chain> {
    const link = parentTurnSql('u');
    const { rows } = await database.query<{ id: string; prompt: string; source: string }>(
      `WITH RECURSIVE chain(id,next) AS (
         SELECT u.id,${link} FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
         UNION
         SELECT u.id,${link} FROM chain c JOIN turns u ON u.id=c.next AND u.owner_id=$2
       )
       SELECT u.id,u.prompt,u.source FROM chain c JOIN turns u ON u.id=c.id AND u.owner_id=$2
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
      task: task.length > 120 ? `${task.slice(0, 119)}…` : task,
      conversation: row.source === 'user',
    };
  }

  async function grant(chain: Chain, origin: string, itemKey = '') {
    const { rows } = await pool.query<{ id: string; source: VaultActivityReason; scope: string }>(
      `SELECT id,source,scope FROM vault_grants WHERE owner_id=$1 AND origin=$2 AND (scope='standing'
         OR (scope='task' AND root_turn_id=$3 AND item_key=$4 AND created_at>now()-interval '7 days'))
       ORDER BY scope='standing' DESC LIMIT 1`,
      [ownerId, origin, chain.id, itemKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      reason: row.scope === 'standing' ? ('always' as const) : row.source,
    };
  }

  async function remember(
    chain: { id?: string; conversation: boolean },
    origin: string,
    source: VaultActivityReason,
    itemKey = '',
    database: Pool | PoolClient = pool,
  ) {
    if (chain.id)
      await database.query(
        `INSERT INTO vault_grants(id,owner_id,origin,scope,root_turn_id,source,item_key)
        VALUES($1,$2,$3,'task',$4,$5,$6) ON CONFLICT(owner_id,root_turn_id,origin,item_key) WHERE scope='task' DO UPDATE SET source=EXCLUDED.source,created_at=now() WHERE vault_grants.created_at<=now()-interval '7 days'`,
        [randomUUID(), ownerId, origin, chain.id, source, itemKey],
      );
  }

  async function track(
    threadId: string,
    origin: string,
    itemKey = '',
    database: Pool | PoolClient = pool,
  ) {
    await database.query(
      'INSERT INTO vault_browser(owner_id,thread_id,origin,item_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [ownerId, threadId, origin, itemKey],
    );
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
    },
    database: Pool | PoolClient = pool,
  ) {
    await database.query(
      `INSERT INTO vault_activity(id,owner_id,action,origin,item_id,item_kind,turn_id,root_turn_id,task,reason,payment_id,amount_minor,currency)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
      ],
    );
    if (['sign_in', 'session', 'code'].includes(entry.action))
      await track(
        turn.threadId,
        entry.origin,
        entry.itemId
          ? `${entry.itemKind === 'session' ? 'session' : 'sign_in'}:${entry.itemId}`
          : '',
        database,
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
    const chain = await root(turn, database);
    await remember(
      chain,
      entry.origin,
      entry.reason,
      entry.itemId ? `sign_in:${entry.itemId}` : '',
      database,
    );
    await log(
      turn,
      chain,
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
      destinations?: string[];
    },
  ): Promise<VaultAccessVerdict> {
    const origin = credentialOrigin(target.origin);
    const chain = await root(turn);
    const itemKey = target.itemId ? `${target.kind}:${target.itemId}` : '';
    const origins = [...new Set([origin, ...(target.destinations ?? []).map(credentialOrigin)])];
    const grants = await Promise.all(origins.map((origin) => grant(chain, origin, itemKey)));
    const granted = grants.every(Boolean) ? grants[0] : undefined;
    const verdict = await options.check(
      turn,
      {
        origin,
        ...(target.account ? { account: target.account } : {}),
        ...(origins.length > 1 ? { destinations: origins.slice(1) } : {}),
      },
      granted?.reason,
    );
    const itemKind = target.kind === 'session' ? { itemKind: 'session' as const } : {};
    const hold = async (reason: 'readonly' | 'background' | 'injection') => {
      await log(turn, chain, { action: 'held', origin, reason, ...itemKind });
      return { ok: false as const, message: heldMessages[reason] };
    };
    if ('allowed' in verdict) {
      if (!verdict.allowed) return hold(verdict.reason);
      for (const [index, origin] of origins.entries())
        if (!grants[index]) await remember(chain, origin, verdict.reason, itemKey);
      return { ok: true, reason: verdict.reason };
    }
    if (target.kind === 'form')
      return verdict.reason === 'injection' ? hold('injection') : { ok: true, reason: 'entered' };
    await log(turn, chain, { action: 'asked', origin, reason: verdict.reason, ...itemKind });
    const site = origins.map(host).join(', ');
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

  async function keeps(turn: TurnRef, chain: Chain, conversation: boolean) {
    const held = (
      await pool.query<{ continues: boolean }>(
        `SELECT root_turn_id=$3 OR ($4 AND conversation AND used_at>now()-${active}) AS continues
         FROM vault_browser_holder WHERE owner_id=$1 AND thread_id=$2`,
        [ownerId, turn.threadId, chain.id, conversation],
      )
    ).rows[0];
    if (!held?.continues) return false;
    const { rows } = await pool.query<{ origin: string; item_key: string }>(
      'SELECT origin,item_key FROM vault_browser WHERE owner_id=$1 AND thread_id=$2',
      [ownerId, turn.threadId],
    );
    const passed: Array<() => Promise<void>> = [];
    for (const { origin, item_key } of rows) {
      const granted = await grant(chain, origin, item_key);
      const account = item_key ? await options.account?.(item_key) : undefined;
      if (item_key && !account) return false;
      const verdict = await options.check(
        turn,
        { origin, ...(account ? { account } : {}) },
        granted?.reason,
      );
      if (!('allowed' in verdict) || !verdict.allowed) return false;
      if (!granted) passed.push(() => remember(chain, origin, verdict.reason, item_key));
    }
    for (const done of passed) await done();
    return true;
  }

  async function prepare(turn: TurnRef, signOut: () => Promise<void>) {
    const work = await turnOrigin(turn.turnId);
    if (!work) throw new Error('This turn is no longer running.');
    const chain = await root(turn);
    const conversation = chain.conversation && !work.readOnly;
    if (work.source === 'event' || work.readOnly || !(await keeps(turn, chain, conversation))) {
      await signOut();
      await signedOut(turn.threadId);
    }
    await pool.query(
      `INSERT INTO vault_browser_holder(owner_id,thread_id,root_turn_id,turn_id,conversation)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT (owner_id,thread_id) DO UPDATE
       SET root_turn_id=excluded.root_turn_id,turn_id=excluded.turn_id,
           conversation=excluded.conversation,used_at=now()`,
      [ownerId, turn.threadId, chain.id, turn.turnId, conversation],
    );
  }

  async function released(turn: TurnRef) {
    await pool.query(
      'UPDATE vault_browser_holder SET used_at=now() WHERE owner_id=$1 AND thread_id=$2 AND turn_id=$3',
      [ownerId, turn.threadId, turn.turnId],
    );
  }

  async function signedOut(threadId: string) {
    await pool.query('DELETE FROM vault_browser WHERE owner_id=$1 AND thread_id=$2', [
      ownerId,
      threadId,
    ]);
  }

  async function touched(threadId: string, page: { acted?: string; landed?: string }) {
    const exact = (raw?: string) => {
      try {
        return raw ? credentialOrigin(raw) : undefined;
      } catch {
        return undefined;
      }
    };
    const acted = exact(page.acted);
    const landed = exact(page.landed);
    await pool.query(
      'UPDATE vault_browser_holder SET used_at=now(),conversation=true WHERE owner_id=$1 AND thread_id=$2',
      [ownerId, threadId],
    );
    for (const origin of new Set([acted, landed])) {
      if (origin) await track(threadId, origin);
    }
  }

  async function allow(context: { threadId: string; turnId: string }, raw: unknown) {
    const { origin, kind, itemId, destinations } = z
      .object({
        origin: z.string().max(2048),
        kind: z.enum(['sign_in', 'session', 'form']).optional(),
        itemId: z.string().max(100).optional(),
        destinations: z.array(z.string().max(2048)).max(20).optional(),
      })
      .strict()
      .parse(raw);
    const exact = credentialOrigin(origin);
    const origins = [...new Set([exact, ...(destinations ?? []).map(credentialOrigin)])];
    const chain = await root(context);
    for (const destination of origins)
      await remember(chain, destination, 'allowed', kind && itemId ? `${kind}:${itemId}` : '');
    return {
      allowed: true,
      website: exact,
      message: `Access to ${host(exact)} is approved. No credential entry or saved-session use has run.`,
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
       action,origin,item_id,item_kind,amount_minor,currency,task,reason FROM vault_activity a
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
      entries: page.map((row) => ({
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
      })),
      ...(rows.length > 50 && last ? { next: { at: last.cursor, id: last.id } } : {}),
    };
  }

  async function permissions(): Promise<VaultPermission[]> {
    const { rows } = await pool.query<{ id: string; origin: string; created_at: Date }>(
      "SELECT id,origin,created_at FROM vault_grants WHERE owner_id=$1 AND scope='standing' ORDER BY origin",
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
      `INSERT INTO vault_grants(id,owner_id,origin,scope,source) VALUES($1,$2,$3,'standing','always')
       ON CONFLICT (owner_id,origin) WHERE scope='standing' DO NOTHING`,
      [randomUUID(), ownerId, exact],
    );
    await pool.query(
      "INSERT INTO vault_activity(id,owner_id,action,origin,reason) VALUES($1,$2,'permission',$3,'always')",
      [randomUUID(), ownerId, exact],
    );
    options.refresh?.();
    return permissions();
  }

  async function forget(origin: string) {
    await pool.query('DELETE FROM vault_grants WHERE owner_id=$1 AND origin=$2', [
      ownerId,
      credentialOrigin(origin),
    ]);
    await pool.query(
      "INSERT INTO vault_activity(id,owner_id,action,origin,reason) VALUES($1,$2,'permission',$3,'revoked')",
      [randomUUID(), ownerId, credentialOrigin(origin)],
    );
    options.refresh?.();
  }

  async function ownerUse(
    entry: {
      action: 'reveal' | 'permission';
      origin: string;
      itemId: string;
      itemKind: 'login' | 'card';
      task?: string;
    },
    database: Pool | PoolClient = pool,
  ) {
    await database.query(
      `INSERT INTO vault_activity(id,owner_id,action,origin,item_id,item_kind,reason,task)
      VALUES($1,$2,$3,$4,$5,$6,'owner',$7)`,
      [
        randomUUID(),
        ownerId,
        entry.action,
        entry.origin,
        entry.itemId,
        entry.itemKind,
        entry.task ?? '',
      ],
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
                : 'The Vault activity is unavailable.',
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
      scope.get('/api/vault/permissions', permissions);
      scope.put('/api/vault/permissions', { bodyLimit: 4096 }, async (request) =>
        always(request.body),
      );
      scope.delete<{ Querystring: { origin?: string } }>(
        '/api/vault/permissions',
        async (request) => {
          await forget(z.string().max(2048).parse(request.query.origin));
          return permissions();
        },
      );
    });
  }

  return {
    ownerUse,
    authorize,
    prepare,
    released,
    track,
    touched,
    record,
    used,
    allow,
    activity,
    permissions,
    always,
    forget,
    registerRoutes,
  };
}
