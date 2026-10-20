import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveredSignInRequired,
  type DiscoveredOAuth,
  type DiscoveredOAuthState,
  type DiscoveredTransport,
} from '../ports/discovered.ts';
import type { ConnectedCli } from '../ports/computer.ts';
import type { Connection } from '../shared/contracts.ts';
import { transaction } from './transaction.ts';
import type { createAppGrantVault } from './vault-app-grants.ts';
import type { TurnRef } from './thread.ts';
import { isIntegrationFile } from './integration-files.ts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';
import {
  captureConnection,
  serviceFailureReason,
  withServiceAnalytics,
  type AnalyticsConnection,
} from './analytics-connections.ts';

const remoteSpec = String.raw`(?:https|git\+https):\/\/[^\s]+`;
const cliSourceSchema = z.union([
  z
    .object({
      npm: z
        .string()
        .max(512)
        .regex(
          new RegExp(
            String.raw`^(?:(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*(?:@(?!(?:file|link|git\+file):|\.{0,2}\/|~)[^@\s](?:[^@\x00-\x1f]*[^@\s])?)?|[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#[^\s#]+)?|(?:github|gitlab|bitbucket):[^\s]+|${remoteSpec})$`,
          ),
        ),
    })
    .strict(),
  z
    .object({
      pypi: z
        .string()
        .max(512)
        .regex(
          new RegExp(
            String.raw`^(?:[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?(?:\[[\w., -]+\])?(?:\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[\w.*+!-]+(?:\s*,\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[\w.*+!-]+)*)?|${remoteSpec})$`,
          ),
        ),
    })
    .strict(),
  z
    .object({
      url: z.url({ protocol: /^https$/, normalize: true }).max(2048),
      sha256: z
        .string()
        .toLowerCase()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}(?:TOKEN|KEY|SECRET|PASSWORD|_ID|_SID)$/);
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
    env: z
      .array(envName)
      .min(1)
      .refine((names) => new Set(names).size === names.length),
    source: cliSourceSchema,
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
  account_id: string;
  paths: AccessPath[];
  reconnect_required: boolean;
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
  oauth_status: 'pending' | 'completing' | 'connected' | 'cancelled' | 'failed' | null;
  connection_id: string | null;
  turn_id: string | null;
  created_at: Date;
};

export const officialMcp = new Map<string, { name: string; endpoint: string; scope?: string }>([
  ['notion', { name: 'Notion', endpoint: 'https://mcp.notion.com/mcp' }],
  ['linear', { name: 'Linear', endpoint: 'https://mcp.linear.app/mcp', scope: 'read write' }],
]);

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
  if (isIntegrationFile(value))
    return Buffer.from(value.bytes).includes(token)
      ? {
          name: redact(value.name, token),
          mimeType: value.mimeType,
          error: 'The file was withheld because it contains the connection credential.',
        }
      : { ...value, name: redact(value.name, token) };
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
    analytics?: CaptureAnalytics;
    analyticsConsent?: () => { enabled: boolean; revision?: string };
    baseUrl: string;
    grantVault: Awaited<ReturnType<typeof createAppGrantVault>>;
    transport: DiscoveredTransport;
    oauth: DiscoveredOAuth;
    runCli?: (
      threadId: string,
      cli: ConnectedCli,
      args: string[],
      environment: Record<string, string>,
      timeoutSeconds?: number,
      signal?: AbortSignal,
    ) => Promise<{ exitCode: number; output: string }>;
    resumeConnection?: (turnId: string, service: string) => Promise<boolean>;
    refresh?: () => void;
  },
) {
  const owner = options.ownerId;
  function connection(path: AccessPath): AnalyticsConnection {
    return {
      connection_method: path.kind,
      ...(path.kind === 'cli' ? {} : { endpoint: path.endpoint }),
      ...(options.analyticsConsent
        ? { consentRevision: options.analyticsConsent().revision ?? 'disabled' }
        : {}),
    };
  }
  function track(
    row: Pick<ProposalRow, 'paths'>,
    status: Extract<AnalyticsEvent, { event: 'otto_connection_changed' }>['properties']['status'],
    failureReason?: Extract<
      AnalyticsEvent,
      { event: 'otto_connection_changed' }
    >['properties']['failure_reason'],
  ) {
    for (const path of row.paths)
      captureConnection(options.analytics, connection(path), status, failureReason);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_connections (
      id uuid PRIMARY KEY,owner_id text NOT NULL,service text NOT NULL,name text NOT NULL,
      account_name text NOT NULL,paths jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS discovered_connection_proposals (
      id uuid PRIMARY KEY,owner_id text NOT NULL,service text NOT NULL,name text NOT NULL,
      paths jsonb NOT NULL,connection_id uuid,turn_id uuid,
      setup_url text,setup_text text,
      account_name text,oauth_state_hash text,
      expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes'
    );
    ALTER TABLE discovered_connections DROP COLUMN IF EXISTS ciphertext,
      ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS reconnect_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS replaced_at timestamptz;
    ALTER TABLE discovered_connection_proposals ADD COLUMN IF NOT EXISTS oauth_status text,
      ADD COLUMN IF NOT EXISTS link_hash text, DROP COLUMN IF EXISTS thread_id,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
  `);
  const interrupted = await transaction(async (recovery) => {
    const interrupted = await recovery.query<ProposalRow>(
      `UPDATE discovered_connection_proposals SET oauth_status='failed',oauth_state_hash=NULL
       WHERE owner_id=$1 AND oauth_status='completing' RETURNING *`,
      [owner],
    );
    for (const row of interrupted.rows) await options.grantVault.remove(row.id, recovery);
    return interrupted.rows;
  }, pool);
  for (const row of interrupted) track(row, 'failed', 'unavailable');
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
      status: row.reconnect_required ? 'disconnected' : 'connected',
      ...(row.reconnect_required ? { canReconnect: true } : {}),
      connectionId: row.id,
      accountId: row.account_id,
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
  async function setupServices(ids: string[], hashes: string[] = []) {
    const requested = z.array(z.uuid()).max(100).parse(ids);
    if (!requested.length && !hashes.length) return [];
    const result = await pool.query<{
      id: string;
      slug: string;
      name: string;
      completed: boolean;
      link_hash: string | null;
    }>(
      `SELECT id,service AS slug,name,oauth_status IS NOT DISTINCT FROM 'connected' AS completed,link_hash
       FROM discovered_connection_proposals WHERE owner_id=$1
       AND (id=ANY($2::uuid[]) OR link_hash=ANY($3::text[]))
       AND (expires_at>now() OR oauth_status='connected')`,
      [owner, requested, hashes],
    );
    return result.rows;
  }
  async function create(input: unknown, turn?: TurnRef) {
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
    if (
      parsed.paths.length > 1 &&
      parsed.paths.some((path) => path.kind === 'cli' && path.env.length > 1)
    )
      throw error('A CLI with several settings needs its own connection.');
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
       (id,owner_id,service,name,paths,connection_id,turn_id,setup_url,setup_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        owner,
        parsed.service,
        name,
        JSON.stringify(paths),
        parsed.connectionId ?? null,
        turn?.turnId ?? null,
        setupUrl,
        parsed.setupText ?? null,
      ],
    );
    return { id, name };
  }
  async function propose(input: unknown, turn?: TurnRef) {
    const { id, name } = await create(input, turn);
    return { name, url: `/apps?connect=${id}` };
  }
  function official(service: string, connectionId?: string) {
    const server = officialMcp.get(service);
    if (!server) throw error('This service is unavailable.', 404);
    return {
      service,
      name: server.name,
      paths: [
        {
          kind: 'mcp',
          endpoint: server.endpoint,
          auth: 'oauth',
          ...(server.scope ? { scope: server.scope } : {}),
        },
      ],
      ...(connectionId ? { connectionId } : {}),
    };
  }
  async function signIn(service: string, turn?: TurnRef, connectionId?: string) {
    return propose(official(service, connectionId), turn);
  }
  async function authorize(service: string, connectionId?: string) {
    const { id, name } = await create(official(service, connectionId));
    return { name, ...(await beginOAuth(id, {})) };
  }
  async function proposal(id: string, client: Pool | PoolClient = pool, lock = false) {
    const row = (
      await client.query<ProposalRow>(
        `SELECT id,owner_id,service,name,paths,connection_id,turn_id,setup_url,setup_text,account_name,oauth_state_hash,oauth_status,created_at
       FROM discovered_connection_proposals
       WHERE id=$1 AND owner_id=$2 AND expires_at>now()${lock ? ' FOR UPDATE' : ''}`,
        [z.uuid().parse(id), owner],
      )
    ).rows[0];
    if (!row) throw error('This connection request expired.', 404);
    return row;
  }
  async function save(pending: ProposalRow, accountName: string, secret: string) {
    const idToSave = pending.connection_id ?? randomUUID();
    await transaction(async (client) => {
      const used = pending.oauth_state_hash
        ? await client.query(
            `UPDATE discovered_connection_proposals SET oauth_status='connected',oauth_state_hash=NULL
             WHERE id=$1 AND owner_id=$2 AND expires_at>now() AND oauth_state_hash=$3
             AND oauth_status='completing' RETURNING id`,
            [pending.id, owner, pending.oauth_state_hash],
          )
        : await client.query(
            'DELETE FROM discovered_connection_proposals WHERE id=$1 AND owner_id=$2 AND expires_at>now() RETURNING id',
            [pending.id, owner],
          );
      if (!used.rowCount) throw error('This connection request expired.', 409);
      if (pending.connection_id) {
        const target = await client.query<{ replaced_at: Date | null }>(
          'SELECT replaced_at FROM discovered_connections WHERE id=$1 AND owner_id=$2 AND service=$3 FOR UPDATE',
          [idToSave, owner, pending.service],
        );
        if (!target.rows[0]) throw error('This connected account is unavailable.', 404);
        const newer = await client.query(
          `SELECT 1 FROM discovered_connection_proposals WHERE owner_id=$1 AND connection_id=$2 AND id<>$3
           AND created_at>$4 AND (oauth_status='connected' OR (expires_at>now()
           AND (oauth_status IS NULL OR oauth_status IN ('pending','completing')))) LIMIT 1`,
          [owner, idToSave, pending.id, pending.created_at],
        );
        const replacedAt = target.rows[0].replaced_at;
        if (newer.rowCount || (replacedAt && replacedAt >= pending.created_at))
          throw error('A newer sign-in exists for this account. Use the newest link.', 409);
        await client.query(
          `UPDATE discovered_connections SET name=$4,account_name=$5,paths=$6,account_id=gen_random_uuid(),
           reconnect_required=false,replaced_at=$7 WHERE id=$1 AND owner_id=$2 AND service=$3`,
          [
            idToSave,
            owner,
            pending.service,
            pending.name,
            accountName,
            JSON.stringify(pending.paths),
            pending.created_at,
          ],
        );
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
      if (pending.oauth_state_hash) await options.grantVault.remove(pending.id, client);
    }, pool);
    track(pending, 'connected');
    options.refresh?.();
    const continued = pending.turn_id
      ? await options.resumeConnection?.(pending.turn_id, pending.name).catch(() => false)
      : false;
    return { ok: true, continued: Boolean(continued) };
  }
  async function complete(id: string, input: unknown) {
    const { token: entered, accountName } = z
      .object({
        token: z.union([z.string().trim().min(8), z.record(envName, z.string().trim().min(8))]),
        accountName: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(input);
    const pending = await proposal(id);
    if (pending.paths[0]?.auth === 'oauth') throw error('Use the service sign-in link.');
    const names = pending.paths.find((path) => path.kind === 'cli')?.env ?? [];
    if (
      typeof entered === 'object'
        ? !names.length || Object.keys(entered).sort().join() !== [...names].sort().join()
        : names.length > 1
    )
      throw error('Enter a value for each setting.');
    const token =
      typeof entered === 'string'
        ? entered
        : names.length === 1
          ? entered[names[0]]
          : JSON.stringify(entered);
    track(pending, 'started');
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
        track(pending, 'failed', 'verification_failed');
        throw error(`The ${path.kind.toUpperCase()} access path could not be verified.`, 409);
      }
    }
    try {
      return await save(pending, accountName, token);
    } catch (error) {
      track(pending, 'failed', 'unknown');
      throw error;
    }
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
    let attempt: ProposalRow | undefined;
    let authorizationFailed = false;
    try {
      const result = await transaction(async (client) => {
        const pending = await proposal(id, client, true);
        const path = pending.paths[0];
        if (path?.kind !== 'mcp' || path.auth !== 'oauth')
          throw error('This connection uses a token.');
        if (pending.oauth_status === 'connected')
          throw error('This app is already connected.', 409);
        if (pending.oauth_status === 'completing')
          throw error('Sign-in is finishing. Wait a moment.', 409);
        if (pending.oauth_state_hash) {
          const saved = JSON.parse((await options.grantVault.read(pending.id, client)).value);
          if (typeof saved.url !== 'string')
            throw error('Continue the sign-in already open in your browser.', 409);
          return { url: saved.url };
        }
        if (path.clientIdRequired && !clientId) throw error('Enter the client ID.');
        attempt = pending;
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
          authorizationFailed = true;
          throw error('The service sign-in could not start. Check its access method.', 502);
        }
        const updated = await client.query(
          `UPDATE discovered_connection_proposals
         SET account_name=$3,oauth_state_hash=$4,oauth_status='pending',link_hash=$5
         WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
          [
            pending.id,
            owner,
            pending.name,
            createHash('sha256').update(state).digest('hex'),
            createHash('sha256').update(started.url).digest('hex'),
          ],
        );
        if (!updated.rowCount) throw error('This connection request expired.', 409);
        await options.grantVault.put(
          pending.id,
          JSON.stringify({ state: started.saved, url: started.url }),
          client,
          new Date(Date.now() + 15 * 60_000),
        );
        return { url: started.url };
      }, pool);
      if (attempt) track(attempt, 'started');
      return result;
    } catch (error) {
      if (attempt) {
        track(attempt, 'started');
        track(attempt, 'failed', authorizationFailed ? 'authorization_failed' : 'unknown');
      }
      throw error;
    }
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
        `UPDATE discovered_connection_proposals SET oauth_status='completing'
         WHERE owner_id=$1 AND oauth_state_hash=$2 AND expires_at>now()
         AND (oauth_status IS NULL OR oauth_status='pending') RETURNING *`,
        [owner, hash],
      )
    ).rows[0];
    if (!pending) return undefined;
    async function failed(
      outcome: 'cancelled' | 'failed',
      reason:
        | 'authorization_failed'
        | 'verification_failed'
        | 'invalid_configuration'
        | 'unknown' = 'authorization_failed',
    ) {
      const changed = await transaction(async (client) => {
        const changed = await client.query(
          `UPDATE discovered_connection_proposals SET oauth_status=$4,oauth_state_hash=NULL
           WHERE id=$1 AND owner_id=$2 AND oauth_state_hash=$3 AND oauth_status='completing' RETURNING id`,
          [pending.id, owner, hash, outcome],
        );
        if (changed.rowCount) await options.grantVault.remove(pending.id, client);
        return Boolean(changed.rowCount);
      }, pool);
      if (changed) track(pending, 'failed', outcome === 'cancelled' ? 'cancelled' : reason);
      return {
        outcome,
        service: pending.service,
        returnTo: pending.turn_id ? ('chat' as const) : ('apps' as const),
      };
    }
    if (parsed.error || !parsed.code) return failed('cancelled');
    const path = pending.paths[0];
    if (path?.kind !== 'mcp' || path.auth !== 'oauth')
      return failed('failed', 'invalid_configuration');
    let failureReason: 'authorization_failed' | 'verification_failed' | 'unknown' =
      'authorization_failed';
    try {
      const grant = JSON.parse((await options.grantVault.read(pending.id)).value);
      const saved = (grant.state ?? grant) as DiscoveredOAuthState;
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
      failureReason = 'verification_failed';
      if (!(await options.transport.listTools(path.endpoint, headers(path, token))).length)
        throw new Error();
      failureReason = 'unknown';
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
      return failed('failed', failureReason);
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
  async function signInRequired(id: string, required: boolean) {
    const changed = await pool.query(
      'UPDATE discovered_connections SET reconnect_required=$3 WHERE id=$1 AND owner_id=$2 AND reconnect_required<>$3',
      [id, owner, required],
    );
    if (changed.rowCount) options.refresh?.();
  }
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
    if (!saved.tokens?.access_token) {
      await signInRequired(row.id, true);
      throw Object.assign(error('Connect this account again.', 409), { reason: 'authentication' });
    }
    if (!saved.expiresAt || saved.expiresAt > Date.now() + 60_000) return saved.tokens.access_token;
    let current = refreshes.get(row.id);
    if (!current || current.controller.signal.aborted) {
      const controller = new AbortController();
      const pending = (async () => {
        const next = await options.oauth
          .refresh(path.endpoint, saved, controller.signal)
          .catch(async (cause: unknown) => {
            if (cause instanceof DiscoveredSignInRequired) await signInRequired(row.id, true);
            throw cause;
          });
        if (!next.tokens?.access_token) throw new Error();
        const changed = await options.grantVault.replace(
          row.id,
          grant.version,
          JSON.stringify(next),
        );
        let token = next.tokens.access_token;
        if (!changed) {
          const latest = JSON.parse(
            (await options.grantVault.read(row.id)).value,
          ) as DiscoveredOAuthState;
          if (!latest.tokens?.access_token || (latest.expiresAt ?? 0) <= Date.now())
            throw new Error();
          token = latest.tokens.access_token;
        }
        await signInRequired(row.id, false);
        return token;
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
        (cause: unknown) =>
          finish(() =>
            reject(
              Object.assign(error('Connect this account again.', 409), {
                reason:
                  cause instanceof DiscoveredSignInRequired
                    ? 'authentication'
                    : serviceFailureReason(cause),
              }),
            ),
          ),
      );
      if (signal?.aborted) abort();
    });
  }
  async function disconnect(connectionId: string, service: string) {
    const removed = await transaction(async (client) => {
      const result = await client.query<AccountRow>(
        'DELETE FROM discovered_connections WHERE id=$1 AND owner_id=$2 AND service=$3 RETURNING *',
        [z.uuid().parse(connectionId), owner, service],
      );
      if (!result.rowCount) throw error('This connected account is unavailable.', 404);
      await options.grantVault.remove(connectionId, client);
      return result.rows[0]!;
    }, pool);
    for (const path of removed.paths)
      captureConnection(options.analytics, connection(path), 'disconnected');
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
      ...(row.reconnect_required ? { connectionId: row.id } : {}),
      paths: row.paths.map((path) => {
        if (path.kind === 'cli') {
          if (!path.source || !path.env) throw error('Ask Otto to set up this CLI again.', 409);
          return {
            kind: path.kind,
            command: path.command,
            auth: path.auth,
            env: path.env,
            source: path.source,
          };
        }
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
  async function selected(action: string, args: Record<string, unknown>) {
    const connectionId = z.uuid().safeParse(args.connectionId);
    const pathId = z.uuid().safeParse(args.pathId);
    const row = connectionId.success
      ? (
          await pool.query<AccountRow>(
            'SELECT * FROM discovered_connections WHERE owner_id=$1 AND id=$2',
            [owner, connectionId.data],
          )
        ).rows[0]
      : undefined;
    const path = row?.paths.find((item) => pathId.success && item.id === pathId.data);
    if (!row || !path)
      throw error(
        "This access path is unavailable. Use a connectionId and pathId listed under discovered by apps SEARCH_TOOLS, or the app's own action.",
        404,
      );
    if (action === 'CONNECTED_HTTP') {
      if (path.kind !== 'http') throw error('Choose an HTTP access path.');
      const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).parse(args.method);
      const url = target(path, z.string().parse(args.path));
      return { row, call: { kind: 'http' as const, path, method, url } };
    }
    if (action === 'CONNECTED_CLI') {
      if (path.kind !== 'cli') throw error('Choose a CLI access path.');
      if (!path.source || !path.env)
        throw error('Propose this CLI again with its install source and connectionId.', 409);
      const argv = z.array(z.string().min(1)).min(1).parse(args.argv);
      const timeoutSeconds = z.number().int().min(1).optional().parse(args.timeoutSeconds);
      return { row, call: { kind: 'cli' as const, path, argv, timeoutSeconds } };
    }
    if (action !== 'CONNECTED_MCP_CALL' || path.kind !== 'mcp')
      throw error('Choose an MCP access path.');
    const tool = z.string().min(1).max(150).parse(args.tool);
    const input = z.record(z.string(), z.unknown()).parse(args.input ?? {});
    return { row, call: { kind: 'mcp' as const, path, tool, input } };
  }
  async function execute(
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
  ) {
    const { row, call } = await selected(action, args);
    const { path } = call;
    let token: string | undefined;
    const secrets: string[] = [];
    const hide = (value: unknown) =>
      secrets.reduce((result, secret) => redact(result, secret), value);
    const succeeded = (value: unknown) => {
      if (!value || typeof value !== 'object') return true;
      if (action === 'CONNECTED_HTTP' && 'status' in value)
        return typeof value.status === 'number' && value.status >= 200 && value.status < 300;
      if (action === 'CONNECTED_CLI' && 'exitCode' in value) return value.exitCode === 0;
      return !('isError' in value && value.isError === true);
    };
    try {
      return await withServiceAnalytics(
        options.analytics,
        connection(path),
        async () => {
          signal?.throwIfAborted();
          token = await tokenFor(row, path, signal);
          secrets.push(token);
          const environment =
            path.kind !== 'cli' || !path.env
              ? {}
              : path.env.length > 1
                ? z.record(envName, z.string()).parse(JSON.parse(token))
                : { [path.env[0]]: token };
          secrets.push(...Object.values(environment));
          let result: unknown;
          if (call.kind === 'http')
            result = await options.transport.http(
              call.url,
              headers(call.path, token),
              call.method,
              call.method === 'GET' ? undefined : args.body,
              signal,
            );
          else if (call.kind === 'cli') {
            if (!turn || !options.runCli) throw error('CLI connections are unavailable.', 503);
            result = await options.runCli(
              turn.threadId,
              { id: call.path.id, command: call.path.command, source: call.path.source },
              call.argv,
              environment,
              call.timeoutSeconds,
              signal,
            );
          } else
            result = await options.transport.callTool(
              call.path.endpoint,
              headers(call.path, token),
              call.tool,
              call.input,
              signal,
            );
          return hide(result);
        },
        signal,
        succeeded,
      );
    } catch (cause) {
      signal?.throwIfAborted();
      if (!token || cause instanceof DiscoveredConnectionError || cause instanceof z.ZodError)
        throw cause;
      const message =
        path.kind === 'http'
          ? 'The connected API request failed'
          : path.kind === 'cli'
            ? 'The connected CLI command failed'
            : 'The connected MCP request failed';
      throw error(
        `${message}: ${String(hide(cause instanceof Error ? cause.message : String(cause)))}`,
        502,
      );
    }
  }
  async function analyticsConnections(): Promise<AnalyticsConnection[]> {
    const rows = await pool.query<AccountRow>(
      'SELECT paths FROM discovered_connections WHERE owner_id=$1 AND reconnect_required=false',
      [owner],
    );
    return rows.rows.flatMap((row) => row.paths.map(connection));
  }
  function registerRoutes(app: FastifyInstance) {
    app.get<{ Params: { id: string } }>('/api/apps/discovery/:id', async (request, reply) => {
      let row = await proposal(request.params.id);
      let authorizationUrl: string | undefined;
      if (row.oauth_state_hash) {
        const grant = await options.grantVault.read(row.id).catch(() => undefined);
        if (grant) authorizationUrl = JSON.parse(grant.value).url;
        else row = await proposal(request.params.id);
      }
      return reply.header('Cache-Control', 'no-store').send({
        name: row.name,
        oauthStatus: row.oauth_status === 'completing' ? 'pending' : row.oauth_status,
        authorizationUrl,
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
                env: path.env,
                source: path.source,
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
    analyticsConnections,
    list,
    setupServices,
    propose,
    signIn,
    authorize,
    completeOAuth,
    reconnect,
    search,
    validate: async (action: string, args: Record<string, unknown>) => {
      await selected(action, args);
    },
    execute,
    disconnect,
    registerRoutes,
  };
}
