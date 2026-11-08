import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveredSignInRequired,
  type DiscoveredCatalog,
  type DiscoveredTool,
  type DiscoveredOAuth,
  type DiscoveredOAuthState,
  type DiscoveredTransport,
} from '../ports/discovered.ts';
import type { ConnectedCli } from '../ports/computer.ts';
import type { ConnectedMcpServer } from '../ports/agent.ts';
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
type AccessPath = z.infer<typeof pathSchema> & { id: string; local?: boolean };
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
  callback_return_to: ReturnTarget | null;
  connection_id: string | null;
  turn_id: string | null;
  created_at: Date;
};
type ReturnTarget = 'apps' | 'onboarding' | 'window' | 'desktop';

const catalogMs = 10 * 60_000;

export const officialMcp = new Map<
  string,
  { name: string; endpoint?: string; scope?: string; instancePath?: string; local?: string }
>([
  ['notion', { name: 'Notion', endpoint: 'https://mcp.notion.com/mcp' }],
  ['linear', { name: 'Linear', endpoint: 'https://mcp.linear.app/mcp', scope: 'read write' }],
  ['n8n', { name: 'n8n', instancePath: '/mcp-server/http', local: 'http://localhost:5678' }],
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

function credentialVariants(token: string) {
  const variants = new Set([token, JSON.stringify(token).slice(1, -1)]);
  try {
    variants.add(encodeURIComponent(token));
    variants.add(encodeURI(token));
    variants.add(new URLSearchParams({ value: token }).toString().slice(6));
  } catch {}
  for (const value of [...variants])
    variants.add(value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()));
  return [...variants].sort((a, b) => b.length - a.length);
}

function credentialExpression(variant: string) {
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    escaped.replace(/%[0-9A-F]{2}/g, (code) =>
      code.replace(/[A-F]/g, (letter) => `[${letter}${letter.toLowerCase()}]`),
    ),
    'g',
  );
}

type CredentialVariant = { value: string; expression: RegExp };

function redactText(value: string, variants: CredentialVariant[]) {
  return variants.reduce((text, variant) => text.replace(variant.expression, '[redacted]'), value);
}

function redact(
  value: unknown,
  token: string,
  variants = credentialVariants(token).map((value) => ({
    value,
    expression: credentialExpression(value),
  })),
): unknown {
  if (typeof value === 'string') return redactText(value, variants);
  if (isIntegrationFile(value))
    return variants.some((variant) => {
      const bytes = Buffer.from(value.bytes);
      return (
        bytes.includes(variant.value) ||
        (variant.value.includes('%') && variant.expression.test(bytes.toString('latin1')))
      );
    })
      ? {
          name: redactText(value.name, variants),
          mimeType: value.mimeType,
          error: 'The file was withheld because it contains the connection credential.',
        }
      : { ...value, name: redactText(value.name, variants) };
  if (Array.isArray(value)) return value.map((item) => redact(item, token, variants));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        redactText(name, variants),
        redact(item, token, variants),
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
    local?: (origin: string) => { transport: DiscoveredTransport; oauth: DiscoveredOAuth };
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
    status: Extract<AnalyticsEvent, { event: 'connection_changed' }>['properties']['status'],
    failureReason?: Extract<
      AnalyticsEvent,
      { event: 'connection_changed' }
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
    ALTER TABLE discovered_connections ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN IF NOT EXISTS reconnect_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS replaced_at timestamptz;
    ALTER TABLE discovered_connection_proposals ADD COLUMN IF NOT EXISTS oauth_status text,
      ADD COLUMN IF NOT EXISTS link_hash text,
      ADD COLUMN IF NOT EXISTS callback_return_to text,
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
  async function list(client?: PoolClient): Promise<Connection[]> {
    const rows = (
      await (client ?? pool).query<AccountRow>(
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
      expired: boolean;
      link_hash: string | null;
      oauth_status: ProposalRow['oauth_status'];
    }>(
      `SELECT id,service AS slug,name,oauth_status IS NOT DISTINCT FROM 'connected' AS completed,
       expires_at<=now() AS expired,link_hash,oauth_status
       FROM discovered_connection_proposals WHERE owner_id=$1
       AND (id=ANY($2::uuid[]) OR link_hash=ANY($3::text[]))`,
      [owner, requested, hashes],
    );
    return result.rows.map(({ oauth_status, ...row }) => ({
      ...row,
      ...(row.link_hash && hashes.includes(row.link_hash)
        ? {
            available:
              !row.expired && (oauth_status === 'pending' || oauth_status === 'completing'),
          }
        : {}),
    }));
  }
  async function create(input: unknown, turn?: TurnRef, returnTo?: ReturnTarget) {
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
       (id,owner_id,service,name,paths,connection_id,turn_id,setup_url,setup_text,callback_return_to)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
        returnTo ?? null,
      ],
    );
    return { id, name };
  }
  async function propose(input: unknown, turn?: TurnRef, returnTo?: ReturnTarget) {
    const { id, name } = await create(input, turn, returnTo);
    return { name, url: `/apps?connect=${id}` };
  }
  const locals = new Map<string, { transport: DiscoveredTransport; oauth: DiscoveredOAuth }>();
  function via(path: AccessPath) {
    if (path.kind === 'cli' || !path.local)
      return { transport: options.transport, oauth: options.oauth };
    if (!options.local) throw error('Connections to local addresses are unavailable.', 503);
    const origin = new URL(path.endpoint).origin;
    let bound = locals.get(origin);
    if (!bound) locals.set(origin, (bound = options.local(origin)));
    return bound;
  }
  async function nearby(service: string) {
    const server = officialMcp.get(service);
    if (!server?.local || !options.local) return undefined;
    const answer = await options
      .local(server.local)
      .transport.http(
        `${server.local}/.well-known/oauth-protected-resource${server.instancePath}`,
        {},
        'GET',
        undefined,
        AbortSignal.timeout(3000),
      )
      .catch(() => undefined);
    const body = answer && 'body' in answer ? (answer.body as { resource?: unknown }) : null;
    return typeof body?.resource === 'string' ? server.local : undefined;
  }
  async function addressProposal(
    service: string,
    turn?: TurnRef,
    connectionId?: string,
    returnTo?: ReturnTarget,
  ) {
    const server = officialMcp.get(service)!;
    let name = server.name;
    if (connectionId) {
      const existing = await account(connectionId);
      if (existing.service !== service) throw error('The selected service changed.');
      name = existing.name;
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO discovered_connection_proposals (id,owner_id,service,name,paths,connection_id,turn_id,callback_return_to)
       VALUES($1,$2,$3,$4,'[]',$5,$6,$7)`,
      [id, owner, service, name, connectionId ?? null, turn?.turnId ?? null, returnTo ?? null],
    );
    return { name, url: `/apps?connect=${id}` };
  }
  async function instance(id: string, input: unknown) {
    const parsed = z
      .object({
        instanceUrl: z.string().trim().min(3).max(2048),
        token: z.string().trim().min(8).max(8192).optional(),
        returnTo: z.enum(['apps', 'onboarding', 'window', 'desktop']).optional(),
      })
      .strict()
      .parse(input);
    const pending = await proposal(id);
    const server = officialMcp.get(pending.service);
    if (!server?.instancePath || pending.paths.length)
      throw error('This connection does not take an address.');
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(parsed.instanceUrl) &&
      !/^https?:\/\//i.test(parsed.instanceUrl)
    )
      throw error(`Enter an http or https address for ${server.name}.`);
    if (/[?#]/.test(parsed.instanceUrl))
      throw error(`Enter your ${server.name} address without ? or #.`);
    const schemeless = !/^https?:\/\//i.test(parsed.instanceUrl);
    const url = URL.parse(schemeless ? `https://${parsed.instanceUrl}` : parsed.instanceUrl);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw error(`Enter your ${server.name} address, such as https://you.app.n8n.cloud.`);
    const typedPath = url.pathname.replace(/\/+$/, '');
    const servicePath = typedPath.endsWith(server.instancePath)
      ? typedPath
      : `${typedPath}${server.instancePath}`;
    let endpoint = `${url.origin}${servicePath}`;
    let local = false;
    await options.transport.validateEndpoint(endpoint).catch(async () => {
      if (!options.local) throw error(`Use a public HTTPS address for ${server.name}.`);
      if (schemeless) url.protocol = 'http:';
      endpoint = `${url.origin}${servicePath}`;
      await options
        .local(url.origin)
        .transport.validateEndpoint(endpoint)
        .catch(() => {
          throw error(`Nod could not reach ${url.host}. Check the address.`);
        });
      local = true;
      const advertised = await options
        .local(url.origin)
        .transport.http(
          `${url.origin}/.well-known/oauth-protected-resource${servicePath}`,
          {},
          'GET',
        )
        .catch(() => undefined);
      const resource = URL.parse(
        String(
          (advertised &&
            'body' in advertised &&
            (advertised.body as { resource?: unknown })?.resource) ??
            '',
        ),
      );
      if (resource && resource.origin !== url.origin)
        await options
          .local(url.origin)
          .transport.validateEndpoint(resource.href)
          .then((checked) => {
            endpoint = checked;
          })
          .catch(() => {});
    });
    const path = {
      kind: 'mcp',
      endpoint,
      auth: parsed.token ? 'bearer' : 'oauth',
      id: pending.id,
      ...(local ? { local: true } : {}),
    };
    const same = pending.connection_id
      ? undefined
      : (
          await pool.query<{ id: string }>(
            `SELECT id FROM discovered_connections WHERE owner_id=$1 AND service=$2
             AND paths->0->>'endpoint'=$3 ORDER BY created_at LIMIT 1`,
            [owner, pending.service, endpoint],
          )
        ).rows[0]?.id;
    const updated = await pool.query(
      `UPDATE discovered_connection_proposals SET paths=$3,account_name=$4,connection_id=COALESCE(connection_id,$5)
       WHERE id=$1 AND owner_id=$2 AND expires_at>now() AND paths='[]'::jsonb`,
      [id, owner, JSON.stringify([path]), url.host, same ?? null],
    );
    if (!updated.rowCount) throw error('This connection request expired.', 409);
    const unreachable = parsed.token
      ? `Nod could not use this token at ${url.host}. Check the address and the token in ${server.name} under Settings, Instance-level MCP.`
      : `${server.name} did not answer at ${url.host}. Check the address, and turn on MCP access in ${server.name} under Settings, Instance-level MCP.`;
    try {
      return parsed.token
        ? await complete(id, { token: parsed.token, accountName: url.host })
        : await beginOAuth(id, { returnTo: parsed.returnTo });
    } catch (cause) {
      await pool.query(
        `UPDATE discovered_connection_proposals SET paths='[]'::jsonb,oauth_status=NULL,oauth_state_hash=NULL
         WHERE id=$1 AND owner_id=$2 AND (oauth_status IS NULL OR oauth_status IN ('pending','failed'))`,
        [id, owner],
      );
      if (
        cause instanceof DiscoveredConnectionError &&
        cause.statusCode < 500 &&
        cause.statusCode !== 409
      )
        throw cause;
      throw error(unreachable, 502);
    }
  }
  function official(service: string, connectionId?: string) {
    const server = officialMcp.get(service);
    if (!server?.endpoint) throw error('This service is unavailable.', 404);
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
    if (officialMcp.get(service)?.instancePath) return addressProposal(service, turn, connectionId);
    return propose(official(service, connectionId), turn);
  }
  async function authorize(
    service: string,
    connectionId?: string,
    returnTo?: ReturnTarget,
    restartAttempt?: string,
  ) {
    if (restartAttempt) {
      const hash = createHash('sha256').update(restartAttempt).digest('hex');
      const pending = (
        await pool.query<Pick<ProposalRow, 'id' | 'name'>>(
          `SELECT id,name FROM discovered_connection_proposals
           WHERE owner_id=$1 AND service=$2 AND connection_id IS NOT DISTINCT FROM $3::uuid
           AND oauth_state_hash=$4 AND expires_at>now()`,
          [owner, service, connectionId ?? null, hash],
        )
      ).rows[0];
      if (!pending) throw error('This sign-in changed. Use the newest window or try again.', 409);
      return {
        name: pending.name,
        ...(await beginOAuth(pending.id, { restart: true, returnTo }, hash)),
      };
    }
    if (officialMcp.get(service)?.instancePath)
      return addressProposal(service, undefined, connectionId, returnTo);
    const { id, name } = await create(official(service, connectionId), undefined, returnTo);
    return { name, ...(await beginOAuth(id, { returnTo })) };
  }
  async function abandonSetup(linkHash: string, reason: 'cancelled' | 'unavailable' | 'unknown') {
    const abandoned = await transaction(async (client) => {
      const { rows } = await client.query<ProposalRow>(
        `UPDATE discovered_connection_proposals SET oauth_status='cancelled',oauth_state_hash=NULL
         WHERE owner_id=$1 AND link_hash=$2 AND oauth_status='pending' RETURNING *`,
        [owner, linkHash],
      );
      for (const row of rows) await options.grantVault.remove(row.id, client);
      return rows;
    }, pool);
    for (const row of abandoned) track(row, 'failed', reason);
    return abandoned.length > 0;
  }
  async function proposal(id: string, client: Pool | PoolClient = pool, lock = false) {
    const row = (
      await client.query<ProposalRow>(
        `SELECT id,owner_id,service,name,paths,connection_id,turn_id,setup_url,setup_text,account_name,oauth_state_hash,oauth_status,callback_return_to,created_at
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
          const { tools } = await via(path).transport.listTools(
            path.endpoint,
            headers(path, token),
          );
          if (!tools.length) throw new Error();
        } else if (path.kind === 'http') {
          if (!path.testPath) throw error('The API path needs a read test.');
          const response = await via(path).transport.http(
            target(path, path.testPath),
            headers(path, token),
            'GET',
          );
          if (response.status < 200 || response.status >= 300)
            throw Object.assign(new Error(), { status: response.status });
        }
      } catch (cause) {
        track(pending, 'failed', 'verification_failed');
        const status = [Object(cause).status, Object(cause).code].find(
          (value) => Number.isInteger(value) && value >= 400 && value < 600,
        );
        throw error(
          `The ${path.kind.toUpperCase()} access path could not be verified${status ? `: the service answered ${status}` : ''}.`,
          409,
        );
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
  async function beginOAuth(id: string, input: unknown, expectedStateHash?: string) {
    const { clientId, returnTo, restart, restartAttempt } = z
      .object({
        clientId: z.string().trim().min(1).max(500).optional(),
        returnTo: z.enum(['apps', 'onboarding', 'window', 'desktop']).optional(),
        restart: z.boolean().default(false),
        restartAttempt: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .nullable()
          .optional(),
      })
      .strict()
      .parse(input);
    const suppliedStateHash = restartAttempt
      ? createHash('sha256').update(restartAttempt).digest('hex')
      : restartAttempt;
    let attempt: ProposalRow | undefined;
    let authorizationFailed = false;
    try {
      const result = await transaction(async (client) => {
        const pending = await proposal(id, client, true);
        if (
          (expectedStateHash && pending.oauth_state_hash !== expectedStateHash) ||
          (suppliedStateHash !== undefined && pending.oauth_state_hash !== suppliedStateHash)
        )
          throw error('This sign-in changed. Use the newest window or try again.', 409);
        const path = pending.paths[0];
        if (path?.kind !== 'mcp' || path.auth !== 'oauth')
          throw error('This connection uses a token.');
        if (pending.oauth_status === 'connected')
          throw error('This app is already connected.', 409);
        if (pending.oauth_status === 'completing')
          throw error('Sign-in is finishing. Wait a moment.', 409);
        let saved: { url?: string; attempt?: string; clientId?: string } | undefined;
        if (pending.oauth_state_hash) {
          saved = JSON.parse((await options.grantVault.read(pending.id, client)).value);
          if (!restart) {
            if (typeof saved?.url !== 'string')
              throw error('Continue the sign-in already open in your browser.', 409);
            if (returnTo)
              await client.query(
                'UPDATE discovered_connection_proposals SET callback_return_to=$3 WHERE id=$1 AND owner_id=$2',
                [pending.id, owner, returnTo],
              );
            return {
              url: saved.url,
              ...(typeof saved.attempt === 'string' &&
              /^[A-Za-z0-9_-]{43}$/.test(saved.attempt) &&
              createHash('sha256').update(saved.attempt).digest('hex') === pending.oauth_state_hash
                ? { attempt: saved.attempt }
                : {}),
            };
          }
        }
        const selectedClientId = clientId ?? saved?.clientId;
        if (path.clientIdRequired && !selectedClientId) throw error('Enter the client ID.');
        attempt = pending;
        const state = randomBytes(32).toString('base64url');
        let started: Awaited<ReturnType<DiscoveredOAuth['begin']>>;
        try {
          started = await via(path).oauth.begin(
            path.endpoint,
            callbackUrl(),
            state,
            path.scope,
            selectedClientId,
          );
        } catch {
          authorizationFailed = true;
          throw error('The service sign-in could not start. Check its access method.', 502);
        }
        const updated = await client.query(
          `UPDATE discovered_connection_proposals
         SET account_name=$3,oauth_state_hash=$4,oauth_status='pending',link_hash=$5,callback_return_to=$6
         WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
          [
            pending.id,
            owner,
            pending.account_name ?? pending.name,
            createHash('sha256').update(state).digest('hex'),
            createHash('sha256').update(started.url).digest('hex'),
            returnTo ?? pending.callback_return_to,
          ],
        );
        if (!updated.rowCount) throw error('This connection request expired.', 409);
        await options.grantVault.put(
          pending.id,
          JSON.stringify({
            state: started.saved,
            url: started.url,
            attempt: state,
            ...(selectedClientId ? { clientId: selectedClientId } : {}),
          }),
          client,
          new Date(Date.now() + 15 * 60_000),
        );
        return { url: started.url, attempt: state };
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
        attempt: parsed.state,
        returnTo:
          pending.callback_return_to ?? (pending.turn_id ? ('chat' as const) : ('apps' as const)),
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
      const connected = await via(path).oauth.finish(path.endpoint, saved, parsed.code);
      const token = connected.tokens?.access_token;
      if (!token) throw new Error();
      failureReason = 'verification_failed';
      if (!(await via(path).transport.listTools(path.endpoint, headers(path, token))).tools.length)
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
        attempt: parsed.state,
        returnTo:
          pending.callback_return_to ?? (pending.turn_id ? ('chat' as const) : ('apps' as const)),
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
  const catalogs = new Map<
    string,
    { at: number; value: Promise<DiscoveredCatalog>; ready?: DiscoveredCatalog }
  >();
  async function catalog(
    row: AccountRow,
    path: Extract<AccessPath, { kind: 'mcp' }>,
    signal?: AbortSignal,
    allowStale = false,
  ): Promise<DiscoveredCatalog> {
    signal?.throwIfAborted();
    const key = `${row.id}:${path.id}:${row.account_id}`;
    const cached = catalogs.get(key);
    if (cached && Date.now() - cached.at < catalogMs)
      return allowStale && cached.ready ? cached.ready : cached.value;
    const value = (async () => {
      const token = await tokenFor(row, path, signal);
      const { tools, instructions } = await via(path).transport.listTools(
        path.endpoint,
        headers(path, token),
        signal,
      );
      return {
        tools: tools.map((tool) => redact(tool, token) as DiscoveredTool),
        ...(instructions
          ? { instructions: String(redact(instructions, token)).slice(0, 20_000) }
          : {}),
      };
    })();
    const entry = { at: Date.now(), value, ready: cached?.ready };
    catalogs.set(key, entry);
    void value.then(
      (ready) => {
        entry.ready = ready;
      },
      () => {
        if (catalogs.get(key) !== entry) return;
        if (cached) catalogs.set(key, { ...cached, at: Date.now() });
        else catalogs.delete(key);
      },
    );
    if (allowStale && entry.ready) return entry.ready;
    return cached ? value.catch(() => cached.value) : value;
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
        const next = await via(path)
          .oauth.refresh(path.endpoint, saved, controller.signal)
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
  async function reconnect(
    service: string,
    templateId?: string,
    returnTo?: ReturnTarget,
    newAccount = false,
  ) {
    const rows = await pool.query<AccountRow>(
      'SELECT * FROM discovered_connections WHERE owner_id=$1 AND service=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at LIMIT 1',
      [owner, service, templateId ? z.uuid().parse(templateId) : null],
    );
    const row = rows.rows[0];
    if (!row) throw error('This service is unavailable.', 404);
    return propose(
      {
        service,
        name: row.name,
        ...(row.reconnect_required && !newAccount ? { connectionId: row.id } : {}),
        paths: row.paths.map((path) => {
          if (path.kind === 'cli') {
            if (!path.source || !path.env) throw error('Ask Nod to set up this CLI again.', 409);
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
      },
      undefined,
      returnTo,
    );
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
              const { tools: available, instructions } = await catalog(row, path, signal);
              const accountMatch = score(row.service) || score(row.name);
              const matching = available
                .map((tool) => ({ tool, score: score(`${tool.name} ${tool.description ?? ''}`) }))
                .filter((entry) => entry.score)
                .sort((left, right) => right.score - left.score)
                .map(({ tool }) => tool);
              const tools =
                matching.length || !connectionId || !accountMatch ? matching : available;
              return {
                id: path.id,
                kind: path.kind,
                endpoint: path.endpoint,
                ...(instructions ? { instructions } : {}),
                ...(accountMatch
                  ? {
                      toolNames: available.slice(0, 200).map((tool) => tool.name),
                      toolCount: available.length,
                    }
                  : {}),
                tools: tools.slice(0, 25).map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
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
  async function servers(): Promise<ConnectedMcpServer[]> {
    const rows = (
      await pool.query<AccountRow>(
        'SELECT * FROM discovered_connections WHERE owner_id=$1 AND NOT reconnect_required ORDER BY created_at',
        [owner],
      )
    ).rows;
    const loaded = await Promise.all(
      rows.flatMap((row) =>
        row.paths.flatMap((path) =>
          path.kind === 'mcp'
            ? [
                catalog(row, path, AbortSignal.timeout(20_000), true).then(
                  ({ tools, instructions }): ConnectedMcpServer => ({
                    connectionId: row.id,
                    pathId: path.id,
                    service: row.service,
                    name: row.name,
                    accountName: row.account_name,
                    ...(instructions ? { instructions } : {}),
                    tools,
                  }),
                  () => undefined,
                ),
              ]
            : [],
        ),
      ),
    );
    return loaded.filter((server) => server !== undefined);
  }
  async function selected(action: string, args: Record<string, unknown>, client?: PoolClient) {
    const connectionId = z.uuid().safeParse(args.connectionId);
    const pathId = z.uuid().safeParse(args.pathId);
    const row = connectionId.success
      ? (
          await (client ?? pool).query<AccountRow>(
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
  async function binding(connectionId: string, client?: PoolClient) {
    const row = (
      await (client ?? pool).query<AccountRow>(
        `SELECT * FROM discovered_connections WHERE owner_id=$1 AND id=$2 AND NOT reconnect_required${client ? ' FOR SHARE' : ''}`,
        [owner, connectionId],
      )
    ).rows[0];
    return row ? JSON.stringify([row.account_id, row.paths]) : undefined;
  }
  async function execute(
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
    expectedBinding?: string,
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
          const currentBinding = await binding(row.id);
          if (
            currentBinding !== JSON.stringify([row.account_id, row.paths]) ||
            (expectedBinding !== undefined && currentBinding !== expectedBinding)
          )
            throw error('This connected account changed.', 409);
          signal?.throwIfAborted();
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
            result = await via(call.path).transport.http(
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
            result = await via(call.path).transport.callTool(
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
    app.post('/api/apps/mcp', async (request, reply) => {
      const parsed = z
        .object({
          name: proposalSchema.shape.name,
          endpoint: z.url().max(2048),
          auth: z.enum(['oauth', 'bearer', 'x-api-key']),
          clientIdRequired: z.boolean().optional(),
        })
        .strict()
        .refine((value) => !value.clientIdRequired || value.auth === 'oauth')
        .safeParse(request.body);
      if (!parsed.success) throw error('Enter a name, server URL and authentication method.');
      const { name, auth } = parsed.data;
      const endpoint = await options.transport.validateEndpoint(parsed.data.endpoint).catch(() => {
        throw error('Use a public HTTPS server address without a query or fragment.');
      });
      const service = `mcp-${createHash('sha256').update(endpoint).digest('hex').slice(0, 24)}`;
      const result = await create(
        {
          name,
          service,
          paths: [
            {
              kind: 'mcp',
              endpoint,
              auth,
              ...(parsed.data.clientIdRequired ? { clientIdRequired: true } : {}),
            },
          ],
        },
        undefined,
        'apps',
      );
      return reply.header('Cache-Control', 'no-store').send(result);
    });
    app.get<{ Params: { id: string } }>('/api/apps/discovery/:id', async (request, reply) => {
      const { row, grant } = await transaction(async (client) => {
        const row = await proposal(request.params.id, client, true);
        const grant = row.oauth_state_hash
          ? await options.grantVault.read(row.id, client).catch(() => undefined)
          : undefined;
        return { row, grant };
      }, pool);
      const saved = grant ? JSON.parse(grant.value) : undefined;
      const attempt =
        typeof saved?.attempt === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.attempt) &&
        createHash('sha256').update(saved.attempt).digest('hex') === row.oauth_state_hash
          ? saved.attempt
          : undefined;
      const authorizationUrl =
        typeof saved?.url === 'string' && (saved.attempt === undefined || attempt)
          ? saved.url
          : undefined;
      const address = officialMcp.get(row.service)?.instancePath && !row.paths.length;
      const localAddress = address ? await nearby(row.service) : undefined;
      return reply.header('Cache-Control', 'no-store').send({
        service: row.service,
        name: row.name,
        ...(address ? { needsAddress: true, localAddress } : {}),
        oauthStatus: row.oauth_status === 'completing' ? 'pending' : row.oauth_status,
        authorizationUrl,
        attempt,
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
      '/api/apps/discovery/:id/instance',
      async (request, reply) =>
        reply
          .header('Cache-Control', 'no-store')
          .send(await instance(request.params.id, request.body)),
    );
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
    binding,
    analyticsConnections,
    list,
    setupServices,
    abandonSetup,
    propose,
    signIn,
    authorize,
    completeOAuth,
    reconnect,
    search,
    servers,
    validate: async (action: string, args: Record<string, unknown>, client?: PoolClient) => {
      await selected(action, args, client);
    },
    execute,
    disconnect,
    registerRoutes,
  };
}
