import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { getDomain } from 'tldts';
import { z } from 'zod';
import type { Computer } from '../ports/computer.ts';
import type { BrowserConnectionRequest } from '../ports/agent.ts';
import type { Connection, VaultSession } from '../shared/contracts.ts';
import type { TurnRef } from './thread.ts';
import { browserOf } from './turn-chain.ts';
import { loopbackHost } from '../shared/loopback.ts';

const idSchema = z.uuid();
const requestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('connect'),
      url: z.url(),
      label: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('save'),
      url: z.url(),
      connectionId: idSchema,
      signedIn: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('use'),
      url: z.url(),
      connectionId: idSchema,
    })
    .strict(),
]);

type Row = {
  id: string;
  origin: string;
  start_url: string;
  label: string;
  profile_id: string;
  state: 'pending' | 'saved' | 'needs_sign_in' | 'disconnecting';
  browser_id: string | null;
  checked_at: Date | null;
};

export class BrowserConnectionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

function site(raw: string) {
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && !loopbackHost(url.hostname))
  )
    throw new BrowserConnectionError('Use a secure website address.', 400);
  url.hash = '';
  return url;
}

function name(origin: string) {
  const hostname = new URL(origin).hostname;
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

function slug(origin: string) {
  return `browser-${name(origin)
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase()}-${createHash('sha256').update(origin).digest('hex').slice(0, 12)}`;
}

export async function createBrowserConnections(
  pool: Pick<Pool, 'query'>,
  options: { ownerId: string; computer: Computer; refresh?(): void },
) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_connections (
      id uuid PRIMARY KEY,
      owner_id text NOT NULL,
      origin text NOT NULL,
      start_url text NOT NULL,
      label text NOT NULL,
      profile_id uuid NOT NULL UNIQUE,
      state text NOT NULL,
      browser_id uuid,
      checked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS browser_id uuid;
    ALTER TABLE browser_connections DROP COLUMN IF EXISTS updated_at;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='browser_connections' AND column_name='thread_id') THEN
        UPDATE browser_connections SET browser_id=COALESCE(browser_id,thread_id);
        ALTER TABLE browser_connections DROP COLUMN thread_id;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS browser_connections_owner ON browser_connections(owner_id,origin);
  `);
  const browser = options.computer;
  const queues = new Map<string, Promise<unknown>>();

  function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(id, pending);
    void pending
      .finally(() => {
        if (queues.get(id) === pending) queues.delete(id);
      })
      .catch(() => {});
    return pending;
  }

  async function owned(rawId: string, allowDisconnecting = false) {
    const id = idSchema.parse(rawId);
    const row = (
      await pool.query<Row>('SELECT * FROM browser_connections WHERE id=$1 AND owner_id=$2', [
        id,
        options.ownerId,
      ])
    ).rows[0];
    if (!row || (row.state === 'disconnecting' && !allowDisconnecting))
      throw new BrowserConnectionError('This browser connection is unavailable.', 404);
    return row;
  }

  async function current(turn: TurnRef) {
    const active = await pool.query(
      `SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
       WHERE u.id=$1 AND u.thread_id=$2 AND u.owner_id=$3 AND u.status='running' AND th.archived_at IS NULL`,
      [turn.turnId, turn.threadId, options.ownerId],
    );
    if (!active.rowCount)
      throw new BrowserConnectionError('This browser task is no longer active.');
  }

  async function request(
    raw: BrowserConnectionRequest,
    turn: TurnRef,
    signal?: AbortSignal,
    launch?: { timeZone?: string; locale?: string },
  ) {
    signal?.throwIfAborted();
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success)
      return { status: 'rejected' as const, code: 'invalid_browser_connection_arguments' };
    let address: URL;
    try {
      address = site(parsed.data.url);
    } catch {
      return { status: 'rejected' as const, code: 'invalid_browser_connection_arguments' };
    }
    await current(turn);
    if (parsed.data.action === 'connect') {
      const id = randomUUID();
      const profileId = randomUUID();
      await pool.query(
        `INSERT INTO browser_connections(id,owner_id,origin,start_url,label,profile_id,state,browser_id)
         VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`,
        [
          id,
          options.ownerId,
          address.origin,
          address.href,
          parsed.data.label ?? name(address.origin),
          profileId,
          browserOf(turn),
        ],
      );
      let bound = false;
      try {
        await browser.bindProfile(browserOf(turn), profileId);
        bound = true;
        const observation = await browser.act(
          browserOf(turn),
          { action: 'open', url: address.href, ...launch },
          signal,
        );
        await browser.hold(browserOf(turn), true);
        options.refresh?.();
        return { status: 'profile_opened' as const, connectionId: id, observation };
      } catch (error) {
        await pool.query('DELETE FROM browser_connections WHERE id=$1 AND owner_id=$2', [
          id,
          options.ownerId,
        ]);
        if (bound) await browser.close(browserOf(turn)).catch(() => {});
        await browser.deleteProfile(profileId).catch(() => {});
        throw error;
      }
    }
    const connectionId = parsed.data.connectionId;
    return exclusive(connectionId, async () => {
      const row = await owned(connectionId);
      signal?.throwIfAborted();
      if (parsed.data.action === 'save') {
        if (row.origin !== address.origin)
          return { status: 'rejected' as const, code: 'browser_connection_origin_mismatch' };
        if (
          !['pending', 'needs_sign_in', 'saved'].includes(row.state) ||
          row.browser_id !== browserOf(turn)
        )
          return { status: 'rejected' as const, code: 'browser_connection_unavailable' };
        const observation = await browser.act(browserOf(turn), { action: 'snapshot' }, signal);
        const page = await browser.currentPage(browserOf(turn));
        if (new URL(observation.url).origin !== row.origin || page.origin !== row.origin)
          return { status: 'needs_sign_in' as const, connectionId: row.id, observation };
        signal?.throwIfAborted();
        const saved = await pool.query(
          `UPDATE browser_connections SET state='saved',checked_at=now()
           WHERE id=$1 AND owner_id=$2 AND browser_id=$5
           AND EXISTS (
             SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
             WHERE u.id=$4 AND u.thread_id=$3 AND u.owner_id=$2 AND u.status='running'
             AND th.archived_at IS NULL FOR UPDATE OF u
           )`,
          [row.id, options.ownerId, turn.threadId, turn.turnId, browserOf(turn)],
        );
        if (!saved.rowCount)
          throw new BrowserConnectionError('This browser connection is unavailable.');
        await browser.hold(browserOf(turn), false);
        options.refresh?.();
        return { status: 'session_saved' as const, connectionId: row.id };
      }
      if (
        !['saved', 'needs_sign_in', 'pending'].includes(row.state) ||
        (row.browser_id && row.browser_id !== browserOf(turn) && (await inUse(row.browser_id)))
      )
        return { status: 'rejected' as const, code: 'browser_connection_unavailable' };
      try {
        await browser.bindProfile(browserOf(turn), row.profile_id);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 423)
          return { status: 'rejected' as const, code: 'browser_connection_busy' };
        throw error;
      }
      const observation = await browser.act(
        browserOf(turn),
        { action: 'open', url: address.href, ...launch },
        signal,
      );
      const page = await browser.currentPage(browserOf(turn));
      const needsSignIn =
        address.origin === row.origin &&
        (new URL(observation.url).origin !== row.origin || page.origin !== row.origin);
      signal?.throwIfAborted();
      const updated = await pool.query(
        `UPDATE browser_connections SET state=CASE WHEN $3 THEN 'needs_sign_in' ELSE state END,browser_id=$6
         WHERE id=$1 AND owner_id=$2
         AND EXISTS (
           SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
           WHERE u.id=$5 AND u.thread_id=$4 AND u.owner_id=$2 AND u.status='running'
           AND th.archived_at IS NULL FOR UPDATE OF u
         )`,
        [row.id, options.ownerId, needsSignIn, turn.threadId, turn.turnId, browserOf(turn)],
      );
      if (!updated.rowCount)
        throw new BrowserConnectionError('This browser task is no longer active.');
      options.refresh?.();
      return {
        status: needsSignIn ? ('needs_sign_in' as const) : ('session_opened' as const),
        connectionId: row.id,
        observation,
      };
    });
  }

  async function inUse(browserId: string) {
    const latest = await pool.query<{ status: string }>(
      `SELECT u.status FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id
       WHERE u.session_id=$1 AND u.owner_id=$2 AND th.archived_at IS NULL
       ORDER BY u.created_at DESC,u.id DESC LIMIT 1`,
      [browserId, options.ownerId],
    );
    return ['queued', 'running', 'waiting'].includes(latest.rows[0]?.status ?? '');
  }

  async function list(): Promise<Connection[]> {
    const rows = (
      await pool.query<Row>(
        'SELECT * FROM browser_connections WHERE owner_id=$1 ORDER BY created_at DESC',
        [options.ownerId],
      )
    ).rows;
    return rows.map((row) => ({
      slug: slug(row.origin),
      name: name(row.origin),
      status: row.state === 'saved' ? 'connected' : 'disconnected',
      connectionId: row.id,
      accountName: row.label,
      triggersEnabled: false,
      supportsTriggers: false,
      browserState: row.state,
      checkedAt: row.checked_at?.toISOString(),
      browserUrl: row.start_url,
      accessPaths: [{ id: row.id, kind: 'browser' as const, endpoint: row.origin }],
    }));
  }

  async function disconnect(rawId: string) {
    const id = idSchema.parse(rawId);
    return exclusive(id, async () => {
      const row = await owned(id, true);
      if (row.browser_id && (await inUse(row.browser_id)))
        throw new BrowserConnectionError('Stop the active work before disconnecting this account.');
      await pool.query(
        "UPDATE browser_connections SET state='disconnecting' WHERE id=$1 AND owner_id=$2",
        [id, options.ownerId],
      );
      await browser.deleteProfile(row.profile_id);
      await pool.query('DELETE FROM browser_connections WHERE id=$1 AND owner_id=$2', [
        id,
        options.ownerId,
      ]);
      options.refresh?.();
      return { ok: true };
    });
  }

  async function target(
    raw: unknown,
  ): Promise<{ origin: string; account: string; kind: 'session'; itemId: string } | undefined> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.action !== 'use') return undefined;
    let address: URL;
    try {
      address = site(parsed.data.url);
    } catch {
      return undefined;
    }
    const row = (
      await pool.query<Pick<Row, 'origin' | 'label'>>(
        "SELECT origin,label FROM browser_connections WHERE id=$1 AND owner_id=$2 AND state<>'disconnecting'",
        [parsed.data.connectionId, options.ownerId],
      )
    ).rows[0];
    return row?.label
      ? {
          origin: address.origin,
          account: row.label,
          kind: 'session',
          itemId: parsed.data.connectionId,
        }
      : undefined;
  }

  async function sessions(): Promise<VaultSession[]> {
    const rows = (
      await pool.query<Row>(
        'SELECT * FROM browser_connections WHERE owner_id=$1 ORDER BY created_at DESC',
        [options.ownerId],
      )
    ).rows;
    return rows.map((row) => ({
      kind: 'session',
      id: row.id,
      label: row.label,
      origin: row.origin,
      url: (() => {
        const url = new URL(row.start_url);
        url.search = '';
        url.hash = '';
        return url.href;
      })(),
      state: row.state,
      ...(row.checked_at ? { checkedAt: row.checked_at.toISOString() } : {}),
    }));
  }

  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof BrowserConnectionError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : 500;
        reply.code(status).send({
          error:
            error instanceof BrowserConnectionError
              ? error.message
              : status === 400
                ? 'Check the request.'
                : 'The saved session could not be changed.',
        });
      });
      scope.get('/api/vault/sessions', sessions);
      scope.delete<{ Params: { id: string } }>('/api/vault/sessions/:id', async (request) =>
        disconnect(request.params.id),
      );
    });
  }

  return { request, list, sessions, target, disconnect, registerRoutes };
}
