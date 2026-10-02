import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  DiscoveredOAuth,
  DiscoveredOAuthState,
  DiscoveredTransport,
} from '../ports/discovered.ts';
import type { Connection } from '../shared/contracts.ts';
import type { createAppGrantVault } from './vault-app-grants.ts';
import type { TurnRef } from './thread.ts';

const pathSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    endpoint: z.url().max(2048),
    auth: z.enum(['bearer', 'x-api-key']).default('bearer'),
    testPath: z.string().min(1).max(500),
    scope: z.never().optional(),
    clientIdRequired: z.never().optional(),
  }),
  z.object({
    kind: z.literal('mcp'),
    endpoint: z.url().max(2048),
    auth: z.enum(['bearer', 'x-api-key', 'oauth']).default('bearer'),
    testPath: z.string().max(500).optional(),
    scope: z.string().trim().min(1).max(500).optional(),
    clientIdRequired: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('cli'),
    command: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    auth: z.literal('env').default('env'),
    envName: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}(?:TOKEN|API_KEY|SECRET|PASSWORD)$/),
  }),
]);
const proposalSchema = z.object({
  service: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 .&'_-]{1,79}$/),
  paths: z.array(pathSchema).min(1).max(4),
  setupUrl: z.url().max(2048).optional(),
  setupText: z.string().trim().min(1).max(500).optional(),
  connectionId: z.uuid().optional(),
});
type AccessPath = z.infer<typeof pathSchema> & { id: string };
type AccountRow = {
  id: string;
  owner_id: string;
  service: string;
  name: string;
  account_name: string;
  paths: AccessPath[];
};
type ProposalRow = {
  id: string;
  owner_id: string;
  service: string;
  name: string;
  paths: AccessPath[];
  setup_url: string | null;
  setup_text: string | null;
  account_name: string | null;
  oauth_state_hash: string | null;
  connection_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
};

export class DiscoveredConnectionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function error(message: string, statusCode = 400) {
  return new DiscoveredConnectionError(message, statusCode);
}

function headers(
  path: Extract<AccessPath, { kind: 'http' | 'mcp' }>,
  token: string,
): Record<string, string> {
  return path.auth === 'x-api-key' ? { 'X-API-Key': token } : { Authorization: `Bearer ${token}` };
}

function redact(value: unknown, token: string): unknown {
  if (typeof value === 'string') return value.replaceAll(token, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, token));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name.replaceAll(token, '[redacted]'),
        redact(item, token),
      ]),
    );
  return value;
}

function target(path: Extract<AccessPath, { kind: 'http' }>, relative: string) {
  if (!relative || relative.length > 2048 || relative.startsWith('//') || relative.includes('\\'))
    throw error('Use a path in the saved API address.');
  try {
    const base = new URL(path.endpoint);
    const url = new URL(
      relative.startsWith('/') ? relative.slice(1) : relative,
      base.href.endsWith('/') ? base : `${base.href}/`,
    );
    if (/%(?:2e|2f|5c|25)/i.test(url.pathname) || /%(?:2e|2f|5c|25)/i.test(base.pathname))
      throw new Error();
    const saved = posix.normalize(decodeURIComponent(base.pathname));
    const requested = posix.normalize(decodeURIComponent(url.pathname));
    const prefix = saved.endsWith('/') ? saved : `${saved}/`;
    if (url.origin !== base.origin || !requested.startsWith(prefix)) throw new Error();
    return url.href;
  } catch {
    throw error('The request must stay in the saved API address.');
  }
}

export async function createDiscoveredConnections(
  pool: Pool,
  options: {
    ownerId: string;
    baseUrl: string;
    grantVault: Awaited<ReturnType<typeof createAppGrantVault>>;
    transport: DiscoveredTransport;
    oauth: DiscoveredOAuth;
    runCli?: (
      threadId: string,
      command: string,
      args: string[],
      envName: string,
      token: string,
      timeoutSeconds?: number,
      signal?: AbortSignal,
    ) => Promise<{ exitCode: number; output: string }>;
    resumeConnection?: (turnId: string, service: string) => Promise<boolean>;
    accountReplaced?: (connectionId: string, client: PoolClient) => Promise<void>;
    refresh?: () => void;
  },
) {
  const owner = options.ownerId;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_connections (
      id uuid PRIMARY KEY,owner_id text NOT NULL,service text NOT NULL,name text NOT NULL,
      account_name text NOT NULL,paths jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS discovered_connection_proposals (
      id uuid PRIMARY KEY,owner_id text NOT NULL,service text NOT NULL,name text NOT NULL,
      paths jsonb NOT NULL,connection_id uuid,thread_id uuid,turn_id uuid,
      setup_url text,setup_text text,
      account_name text,oauth_state_hash text,
      expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
    );
    ALTER TABLE discovered_connections DROP COLUMN IF EXISTS ciphertext;
  `);
  async function account(id: string) {
    const result = await pool.query<AccountRow>(
      'SELECT * FROM discovered_connections WHERE owner_id=$1 AND id=$2',
      [owner, z.uuid().parse(id)],
    );
    if (!result.rows[0]) throw error('This connected account is unavailable.', 404);
    return result.rows[0];
  }
  async function list(): Promise<Connection[]> {
    const rows = (
      await pool.query<AccountRow>(
        'SELECT * FROM discovered_connections WHERE owner_id=$1 ORDER BY created_at',
        [owner],
      )
    ).rows;
    return rows.map((row) => ({
      slug: row.service,
      name: row.name,
      status: 'connected',
      connectionId: row.id,
      accountName: row.account_name,
      triggersEnabled: false,
      supportsTriggers: false,
      description: row.paths.map((path) => path.kind.toUpperCase()).join(' · '),
      accessPaths: row.paths.map((path) => ({
        id: path.id,
        kind: path.kind,
        endpoint: path.kind === 'cli' ? path.command : path.endpoint,
      })),
    }));
  }
  async function propose(input: unknown, turn?: TurnRef) {
    const parsed = proposalSchema.parse(input);
    let name = parsed.name;
    if (parsed.paths.some((path) => path.auth === 'oauth')) {
      if (parsed.paths.length !== 1 || parsed.paths[0].kind !== 'mcp')
        throw error('OAuth needs one MCP access path.');
    }
    if (
      parsed.paths.some(
        (path) => path.kind === 'mcp' && path.clientIdRequired && path.auth !== 'oauth',
      )
    )
      throw error('A client ID needs an OAuth access path.');
    const setupUrl = parsed.setupUrl
      ? (await options.transport.validateEndpoint(parsed.setupUrl)).replace(/\/$/, '')
      : null;
    if (parsed.connectionId) {
      const existing = await account(parsed.connectionId);
      if (existing.service !== parsed.service) throw error('The selected service changed.');
      name = existing.name;
    }
    const id = randomUUID();
    const paths: AccessPath[] = [];
    for (const [index, path] of parsed.paths.entries()) {
      const pathId = index === 0 ? id : randomUUID();
      if (path.kind === 'cli') {
        if (!options.runCli) throw error('CLI connections are unavailable.', 503);
        if (
          /^(?:bash|dash|env|fish|node|npx|npm|python(?:3(?:\.\d+)?)?|sh|su|sudo|zsh)$/i.test(
            path.command,
          )
        )
          throw error('Choose a service CLI, not a shell or interpreter.');
        paths.push({ ...path, id: pathId });
        continue;
      }
      const checked = {
        ...path,
        endpoint: await options.transport.validateEndpoint(path.endpoint),
        id: pathId,
      };
      if (checked.kind === 'http') target(checked, checked.testPath);
      paths.push(checked);
    }
    await pool.query(
      `INSERT INTO discovered_connection_proposals
       (id,owner_id,service,name,paths,connection_id,thread_id,turn_id,setup_url,setup_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        owner,
        parsed.service,
        name,
        JSON.stringify(paths),
        parsed.connectionId ?? null,
        turn?.threadId ?? null,
        turn?.turnId ?? null,
        setupUrl,
        parsed.setupText ?? null,
      ],
    );
    return { name, url: `/apps?connect=${id}` };
  }
  async function proposal(id: string) {
    const row = (
      await pool.query<ProposalRow>(
        `SELECT id,owner_id,service,name,paths,connection_id,thread_id,turn_id,setup_url,setup_text,account_name,oauth_state_hash
       FROM discovered_connection_proposals
       WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
        [z.uuid().parse(id), owner],
      )
    ).rows[0];
    if (!row) throw error('This connection request expired.', 404);
    return row;
  }
  async function save(pending: ProposalRow, accountName: string, secret: string) {
    const idToSave = pending.connection_id ?? randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const used = await client.query(
        'DELETE FROM discovered_connection_proposals WHERE id=$1 AND owner_id=$2 AND expires_at>now() RETURNING id',
        [pending.id, owner],
      );
      if (!used.rowCount) throw error('This connection request expired.', 409);
      if (pending.connection_id) {
        const updated = await client.query(
          `UPDATE discovered_connections SET name=$4,account_name=$5,paths=$6
           WHERE id=$1 AND owner_id=$2 AND service=$3`,
          [
            idToSave,
            owner,
            pending.service,
            pending.name,
            accountName,
            JSON.stringify(pending.paths),
          ],
        );
        if (!updated.rowCount) throw error('This connected account is unavailable.', 404);
      } else {
        await client.query(
          `INSERT INTO discovered_connections
           (id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            idToSave,
            owner,
            pending.service,
            pending.name,
            accountName,
            JSON.stringify(pending.paths),
          ],
        );
      }
      await options.grantVault.put(idToSave, secret, client);
      if (pending.connection_id) await options.accountReplaced?.(idToSave, client);
      if (pending.oauth_state_hash) await options.grantVault.remove(pending.id, client);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    options.refresh?.();
    const continued = pending.turn_id
      ? await options.resumeConnection?.(pending.turn_id, pending.name).catch(() => false)
      : false;
    return { ok: true, continued: Boolean(continued) };
  }
  async function complete(id: string, input: unknown) {
    const { token, accountName } = z
      .object({
        token: z.string().trim().min(8).max(8192),
        accountName: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(input);
    const pending = await proposal(id);
    if (pending.paths[0]?.auth === 'oauth') throw error('Use the service sign-in link.');
    for (const path of pending.paths) {
      try {
        if (path.kind === 'mcp') {
          const tools = await options.transport.listTools(path.endpoint, headers(path, token));
          if (!tools.length) throw new Error();
        } else if (path.kind === 'http') {
          if (!path.testPath) throw error('The API path needs a read test.');
          const response = await options.transport.http(
            target(path, path.testPath),
            headers(path, token),
            'GET',
          );
          if (response.status < 200 || response.status >= 300) throw new Error();
        }
      } catch {
        throw error(`The ${path.kind.toUpperCase()} access path could not be verified.`, 409);
      }
    }
    return save(pending, accountName, token);
  }
  function callbackUrl() {
    const callback = new URL('/api/apps/callback', options.baseUrl);
    if (callback.hostname === 'localhost') callback.hostname = '127.0.0.1';
    return callback.href;
  }
  async function beginOAuth(id: string, input: unknown) {
    const { clientId } = z
      .object({
        clientId: z.string().trim().min(1).max(500).optional(),
      })
      .strict()
      .parse(input);
    const pending = await proposal(id);
    const path = pending.paths[0];
    if (path?.kind !== 'mcp' || path.auth !== 'oauth') throw error('This connection uses a token.');
    if (path.clientIdRequired && !clientId) throw error('Enter the client ID.');
    const state = randomBytes(32).toString('base64url');
    let started: Awaited<ReturnType<DiscoveredOAuth['begin']>>;
    try {
      started = await options.oauth.begin(
        path.endpoint,
        callbackUrl(),
        state,
        path.scope,
        clientId,
      );
    } catch {
      throw error('The service sign-in could not start. Check its access method.', 502);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE discovered_connection_proposals
         SET account_name=$3,oauth_state_hash=$4
         WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
        [pending.id, owner, pending.name, createHash('sha256').update(state).digest('hex')],
      );
      if (!updated.rowCount) throw error('This connection request expired.', 409);
      await options.grantVault.put(
        pending.id,
        JSON.stringify(started.saved),
        client,
        new Date(Date.now() + 15 * 60_000),
      );
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    return { url: started.url };
  }
  async function completeOAuth(input: unknown) {
    const parsed = z
      .object({
        state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code: z.string().min(1).optional(),
        error: z.string().optional(),
        iss: z.string().optional(),
      })
      .parse(input);
    const hash = createHash('sha256').update(parsed.state).digest('hex');
    const pending = (
      await pool.query<ProposalRow>(
        `SELECT * FROM discovered_connection_proposals
         WHERE owner_id=$1 AND oauth_state_hash=$2 AND expires_at>now()`,
        [owner, hash],
      )
    ).rows[0];
    if (!pending) return undefined;
    if (parsed.error || !parsed.code) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'DELETE FROM discovered_connection_proposals WHERE id=$1 AND owner_id=$2 AND oauth_state_hash=$3',
          [pending.id, owner, hash],
        );
        await options.grantVault.remove(pending.id, client);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
      return {
        outcome: 'cancelled' as const,
        service: pending.service,
        returnTo: pending.turn_id ? ('chat' as const) : ('apps' as const),
      };
    }
    const path = pending.paths[0];
    if (path?.kind !== 'mcp' || path.auth !== 'oauth')
      return {
        outcome: 'failed' as const,
        service: pending.service,
        returnTo: pending.turn_id ? ('chat' as const) : ('apps' as const),
      };
    try {
      const saved = JSON.parse(
        (await options.grantVault.read(pending.id)).value,
      ) as DiscoveredOAuthState;
      const metadata = saved.discovery?.authorizationServerMetadata;
      const issuer = metadata?.issuer;
      if (parsed.iss && parsed.iss !== issuer) throw new Error();
      if (
        metadata &&
        'authorization_response_iss_parameter_supported' in metadata &&
        metadata.authorization_response_iss_parameter_supported === true &&
        parsed.iss !== issuer
      )
        throw new Error();
      const connected = await options.oauth.finish(path.endpoint, saved, parsed.code);
      const token = connected.tokens?.access_token;
      if (!token) throw new Error();
      if (!(await options.transport.listTools(path.endpoint, headers(path, token))).length)
        throw new Error();
      const result = await save(
        pending,
        pending.account_name ?? 'Account',
        JSON.stringify(connected),
      );
      return {
        outcome: result.continued ? ('continued' as const) : ('connected' as const),
        service: pending.service,
        returnTo: pending.turn_id ? ('chat' as const) : ('apps' as const),
      };
    } catch {
      return {
        outcome: 'failed' as const,
        service: pending.service,
        returnTo: pending.turn_id ? ('chat' as const) : ('apps' as const),
      };
    }
  }
  const refreshes = new Map<
    string,
    {
      promise: Promise<string>;
      controller: AbortController;
      waiters: number;
      settled: boolean;
    }
  >();
  async function tokenFor(
    row: AccountRow,
    path: AccessPath,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const grant = await options.grantVault.read(row.id);
    signal?.throwIfAborted();
    const secret = grant.value;
    if (path.auth !== 'oauth') return secret;
    const saved = JSON.parse(secret) as DiscoveredOAuthState;
    if (!saved.tokens?.access_token) throw error('Connect this account again.', 409);
    if (!saved.expiresAt || saved.expiresAt > Date.now() + 60_000) return saved.tokens.access_token;
    let current = refreshes.get(row.id);
    if (!current || current.controller.signal.aborted) {
      const controller = new AbortController();
      const pending = (async () => {
        const next = await options.oauth.refresh(path.endpoint, saved, controller.signal);
        if (!next.tokens?.access_token) throw new Error();
        const changed = await options.grantVault.replace(
          row.id,
          grant.version,
          JSON.stringify(next),
        );
        if (!changed) {
          const latest = JSON.parse(
            (await options.grantVault.read(row.id)).value,
          ) as DiscoveredOAuthState;
          if (!latest.tokens?.access_token || (latest.expiresAt ?? 0) <= Date.now())
            throw new Error();
          return latest.tokens.access_token;
        }
        return next.tokens.access_token;
      })();
      const created = { promise: pending, controller, waiters: 0, settled: false };
      refreshes.set(row.id, created);
      void pending
        .finally(() => {
          created.settled = true;
          if (refreshes.get(row.id) === created) refreshes.delete(row.id);
        })
        .catch(() => {});
      current = created;
    }
    const refresh = current;
    refresh.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (operation: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        refresh.waiters--;
        if (!refresh.waiters && !refresh.settled) refresh.controller.abort();
        operation();
      };
      const abort = () => finish(() => reject(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      refresh.promise.then(
        (value) => finish(() => resolve(value)),
        () => finish(() => reject(error('Connect this account again.', 409))),
      );
      if (signal?.aborted) abort();
    });
  }
  async function disconnect(connectionId: string, service: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM discovered_connections WHERE id=$1 AND owner_id=$2 AND service=$3',
        [z.uuid().parse(connectionId), owner, service],
      );
      if (!result.rowCount) throw error('This connected account is unavailable.', 404);
      await options.grantVault.remove(connectionId, client);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    options.refresh?.();
    return { ok: true };
  }
  async function reconnect(service: string, templateId?: string) {
    const rows = await pool.query<AccountRow>(
      'SELECT * FROM discovered_connections WHERE owner_id=$1 AND service=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at LIMIT 1',
      [owner, service, templateId ? z.uuid().parse(templateId) : null],
    );
    const row = rows.rows[0];
    if (!row) throw error('This service is unavailable.', 404);
    return propose({
      service,
      name: row.name,
      paths: row.paths.map((path) => {
        if (path.kind === 'cli')
          return {
            kind: path.kind,
            command: path.command,
            auth: path.auth,
            envName: path.envName,
          };
        return {
          kind: path.kind,
          endpoint: path.endpoint,
          auth: path.auth,
          ...(path.testPath ? { testPath: path.testPath } : {}),
          ...(path.scope ? { scope: path.scope } : {}),
          ...(path.clientIdRequired ? { clientIdRequired: path.clientIdRequired } : {}),
        };
      }),
    });
  }
  async function search(query: string, connectionId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const words = terms.some((word) => word.length > 2)
      ? terms.filter((word) => word.length > 2)
      : terms;
    const score = (text: string) =>
      words.filter((word) => text.toLowerCase().includes(word)).length;
    const rows = (
      await pool.query<AccountRow>(
        'SELECT * FROM discovered_connections WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2)',
        [owner, connectionId ?? null],
      )
    ).rows;
    const accounts = await Promise.all(
      rows.map(async (row) => {
        const paths = await Promise.all(
          row.paths.map(async (path) => {
            if (path.kind !== 'mcp')
              return {
                id: path.id,
                kind: path.kind,
                endpoint: path.kind === 'cli' ? path.command : path.endpoint,
              };
            try {
              const token = await tokenFor(row, path, signal);
              const available = await options.transport.listTools(
                path.endpoint,
                headers(path, token),
                signal,
              );
              return {
                id: path.id,
                kind: path.kind,
                endpoint: path.endpoint,
                ...(score(row.service) || score(row.name)
                  ? {
                      toolNames: available.slice(0, 200).map((tool) => redact(tool.name, token)),
                      toolCount: available.length,
                    }
                  : {}),
                tools: available
                  .map((tool) => ({ tool, score: score(`${tool.name} ${tool.description ?? ''}`) }))
                  .filter((entry) => entry.score)
                  .sort((left, right) => right.score - left.score)
                  .slice(0, 25)
                  .map(({ tool }) => ({
                    name: redact(tool.name, token),
                    description: redact(tool.description, token),
                    inputSchema: redact(tool.inputSchema, token),
                  })),
              };
            } catch {
              signal?.throwIfAborted();
              return { id: path.id, kind: path.kind, endpoint: path.endpoint, unavailable: true };
            }
          }),
        );
        return { connectionId: row.id, service: row.service, accountName: row.account_name, paths };
      }),
    );
    return { accounts };
  }
  async function selected(args: Record<string, unknown>) {
    const connectionId = z.uuid().parse(args.connectionId);
    const pathId = z.uuid().parse(args.pathId);
    const row = await account(connectionId);
    const path = row.paths.find((item) => item.id === pathId);
    if (!path) throw error('This access path is unavailable.', 404);
    if (JSON.stringify(args).length > 32_768) throw error('The app request is too large.');
    return { row, path };
  }
  async function execute(
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
  ) {
    const { row, path } = await selected(args);
    signal?.throwIfAborted();
    const token = await tokenFor(row, path, signal);
    const safeResult = (value: unknown) => redact(value, token);
    const failed = (message: string, cause: unknown) => {
      signal?.throwIfAborted();
      return error(
        `${message}: ${String(redact(cause instanceof Error ? cause.message : String(cause), token))}`,
        502,
      );
    };
    if (action === 'CONNECTED_HTTP') {
      if (path.kind !== 'http') throw error('Choose an HTTP access path.');
      const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).parse(args.method);
      const url = target(path, z.string().parse(args.path));
      try {
        return safeResult(
          await options.transport.http(
            url,
            headers(path, token),
            method,
            method === 'GET' ? undefined : args.body,
            signal,
          ),
        );
      } catch (cause) {
        throw failed('The connected API request failed', cause);
      }
    }
    if (action === 'CONNECTED_CLI') {
      if (path.kind !== 'cli') throw error('Choose a CLI access path.');
      if (!turn || !options.runCli) throw error('CLI connections are unavailable.', 503);
      const argv = z.array(z.string().min(1).max(1000)).min(1).max(32).parse(args.argv);
      try {
        const result = await options.runCli(
          turn.threadId,
          path.command,
          argv,
          path.envName,
          token,
          z
            .number()
            .int()
            .min(1)
            .max(120)
            .parse(args.timeoutSeconds ?? 30),
          signal,
        );
        return safeResult(result);
      } catch (cause) {
        throw failed('The connected CLI command failed', cause);
      }
    }
    if (action !== 'CONNECTED_MCP_CALL' || path.kind !== 'mcp')
      throw error('Choose an MCP access path.');
    const name = z.string().min(1).max(150).parse(args.tool);
    const input = z.record(z.string(), z.unknown()).parse(args.input ?? {});
    try {
      return safeResult(
        await options.transport.callTool(path.endpoint, headers(path, token), name, input, signal),
      );
    } catch (cause) {
      throw failed('The connected MCP request failed', cause);
    }
  }
  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/apps/discovery/:id', async (request, reply) => {
      const row = await proposal(request.params.id);
      return reply.header('Cache-Control', 'no-store').send({
        name: row.name,
        callbackUrl: row.paths.some((path) => path.kind === 'mcp' && path.clientIdRequired)
          ? callbackUrl()
          : undefined,
        setupUrl: row.setup_url,
        setupText: row.setup_text,
        paths: row.paths.map((path) =>
          path.kind === 'cli'
            ? {
                kind: path.kind,
                command: path.command,
                auth: path.auth,
                envName: path.envName,
              }
            : {
                kind: path.kind,
                endpoint: path.endpoint,
                auth: path.auth,
                ...(path.testPath ? { testPath: path.testPath } : {}),
                ...(path.scope ? { scope: path.scope } : {}),
                ...(path.clientIdRequired ? { clientIdRequired: path.clientIdRequired } : {}),
              },
        ),
      });
    });
    app.post<{ Params: { id: string } }>(
      '/api/apps/discovery/:id/authorize',
      async (request, reply) =>
        reply
          .header('Cache-Control', 'no-store')
          .send(await beginOAuth(request.params.id, request.body)),
    );
    app.post<{ Params: { id: string } }>(
      '/api/apps/discovery/:id/complete',
      async (request, reply) =>
        reply
          .header('Cache-Control', 'no-store')
          .send(await complete(request.params.id, request.body)),
    );
  }
  return {
    list,
    propose,
    completeOAuth,
    reconnect,
    search,
    execute,
    disconnect,
    registerRoutes,
  };
}
