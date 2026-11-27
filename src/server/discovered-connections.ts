import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { bundledApps, appAccessPath, type BundledApp } from './app-catalog.ts';
import { appRequestUrl, appRequestHeaders } from './app-requests.ts';
import { appEnvironmentNameSchema, appDefinitionSchema } from '../shared/app-definitions.ts';
import { appAccessSchema } from './app-access.ts';
import { isDeepStrictEqual } from 'node:util';
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
import type { ConnectedCli, ConnectedCliResult } from '../ports/computer.ts';
import type { ConnectedMcpServer } from '../ports/agent.ts';
import type { Connection } from '../shared/contracts.ts';
import { transaction } from './transaction.ts';
import { logFailure } from './failure-log.ts';
import type { createAppGrantVault } from './vault-app-grants.ts';
import type { TurnRef } from './thread.ts';
import { isIntegrationFile } from './integration-files.ts';
import { redactSecretText } from './redaction.ts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';
import {
  captureConnection,
  serviceFailureReason,
  withServiceAnalytics,
  type AnalyticsConnection,
} from './analytics-connections.ts';

const envName = appEnvironmentNameSchema;
const manualMcpService = /^mcp-[0-9a-f]{24}$/;

const proposalSchema = z.object({
  service: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().trim().pipe(appDefinitionSchema.shape.displayName),
  paths: z.array(appAccessSchema).min(1).max(4),
  setupUrl: z.url().max(2048).optional(),
  setupText: z.string().trim().min(1).max(500).optional(),
  connectionId: z.uuid().optional(),
});
type AccessPath = z.infer<typeof appAccessSchema> & { id: string; local?: boolean };
type AccountRow = {
  id: string;
  owner_id: string;
  service: string;
  name: string;
  display_name: string | null;
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
  display_name?: string | null;
  setup_url: string | null;
  setup_text: string | null;
  account_name: string | null;
  oauth_state_hash: string | null;
  oauth_status: 'pending' | 'completing' | 'connected' | 'cancelled' | 'failed' | null;
  oauth_error: string | null;
  callback_return_to: ReturnTarget | null;
  connection_id: string | null;
  turn_id: string | null;
  created_at: Date;
};
type ReturnTarget = 'apps' | 'onboarding' | 'window' | 'desktop';

const catalogMs = 10 * 60_000;

const oauthErrors = [
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'interaction_required',
  'login_required',
  'consent_required',
  'account_selection_required',
];

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
  return appRequestHeaders(path, token);
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
  try {
    return appRequestUrl(path.endpoint, relative);
  } catch (cause) {
    throw error(cause instanceof Error ? cause.message : String(cause));
  }
}

export async function createDiscoveredConnections(
  pool: Pool,
  options: {
    ownerId: string;
    apps?: ReadonlyMap<string, BundledApp>;
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
    ) => Promise<ConnectedCliResult>;
    verifyCli?: (
      cli: ConnectedCli,
      args: string[],
      environment: Record<string, string>,
      timeoutSeconds: number,
      signal?: AbortSignal,
    ) => Promise<ConnectedCliResult>;
    resumeConnection?: (turnId: string, service: string) => Promise<boolean>;
    local?: (origin: string) => { transport: DiscoveredTransport; oauth: DiscoveredOAuth };
    refresh?: () => void;
  },
) {
  const owner = options.ownerId;
  const apps = options.apps ?? bundledApps;
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
    failure?: { step: string; error?: unknown; path?: AccessPath },
  ) {
    for (const path of row.paths)
      captureConnection(options.analytics, connection(path), status, failureReason);
    const path = failure?.path ?? row.paths[0];
    if (status === 'failed')
      logFailure(
        'connection_setup_failed',
        { name: 'ConnectionSetupError' },
        {
          method: path?.kind,
          transport: path?.kind === 'mcp' ? 'streamable-http' : undefined,
          authMode: path?.auth,
          step: failure?.step,
          status: [Object(failure?.error).status, Object(failure?.error).code].find(
            (value) => Number.isInteger(value) && value >= 400 && value < 600,
          ),
          reason: failureReason,
        },
      );
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
      ADD COLUMN IF NOT EXISTS replaced_at timestamptz,
      ADD COLUMN IF NOT EXISTS display_name text;
    ALTER TABLE discovered_connection_proposals ADD COLUMN IF NOT EXISTS oauth_status text,
      ADD COLUMN IF NOT EXISTS link_hash text,
      ADD COLUMN IF NOT EXISTS callback_return_to text,
      ADD COLUMN IF NOT EXISTS oauth_error text,
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
  for (const row of interrupted) track(row, 'failed', 'unavailable', { step: 'restart' });
  async function account(id: string) {
    const result = await pool.query<AccountRow>(
      'SELECT * FROM discovered_connections WHERE owner_id=$1 AND id=$2',
      [owner, z.uuid().parse(id)],
    );
    if (!result.rows[0]) throw error('This connected account is unavailable.', 404);
    return result.rows[0];
  }
  async function lockDisplayName(client: PoolClient, service: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
      `discovered-mcp-name:${owner}`,
      service,
    ]);
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
      name: row.display_name ?? row.name,
      ...(manualMcpService.test(row.service) &&
      !apps.has(row.service) &&
      row.paths.some((path) => path.kind === 'mcp')
        ? { canRename: true }
        : {}),
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
      oauth_error: string | null;
    }>(
      `SELECT id,service AS slug,
       COALESCE((SELECT min(display_name) FROM discovered_connections
                 WHERE owner_id=p.owner_id AND service=p.service),name) AS name,
       oauth_status IS NOT DISTINCT FROM 'connected' AS completed,
       expires_at<=now() AS expired,link_hash,oauth_status,oauth_error
       FROM discovered_connection_proposals p WHERE owner_id=$1
       AND (id=ANY($2::uuid[]) OR link_hash=ANY($3::text[]))`,
      [owner, requested, hashes],
    );
    return result.rows.map(({ oauth_status, oauth_error, ...row }) => ({
      ...row,
      ...(row.link_hash && hashes.includes(row.link_hash)
        ? {
            available:
              !row.expired && (oauth_status === 'pending' || oauth_status === 'completing'),
            ...(oauth_status === 'failed' && oauth_error ? { error: oauth_error } : {}),
          }
        : {}),
    }));
  }
  async function create(
    input: unknown,
    turn?: TurnRef,
    returnTo?: ReturnTarget,
    localOrigin?: string,
  ) {
    const parsed = proposalSchema.parse(input);
    const reviewed = apps.get(parsed.service);
    if (
      reviewed &&
      !reviewed.instancePath &&
      !isDeepStrictEqual(parsed.paths, [appAccessSchema.parse(appAccessPath(reviewed))])
    )
      throw error('Use the reviewed connection definition for this app.', 409);
    let name = parsed.name;
    if (parsed.paths.some((path) => path.auth === 'oauth')) {
      if (parsed.paths.length !== 1 || parsed.paths[0].kind === 'cli')
        throw error('OAuth needs one app access path.');
    }
    if (
      parsed.paths.some(
        (path) => path.kind !== 'cli' && path.clientIdRequired && path.auth !== 'oauth',
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
      const local =
        localOrigin !== undefined &&
        options.local !== undefined &&
        new URL(path.endpoint).origin === localOrigin;
      const checked = {
        ...path,
        endpoint: local
          ? await options.local!(localOrigin!).transport.validateEndpoint(path.endpoint)
          : await options.transport.validateEndpoint(path.endpoint),
        id: pathId,
        ...(local ? { local: true } : {}),
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
    const server = apps.get(service);
    const local = service === 'n8n' ? 'http://localhost:5678' : undefined;
    if (!server?.instancePath || !local || !options.local) return undefined;
    const answer = await options
      .local(local)
      .transport.http(
        `${local}/.well-known/oauth-protected-resource${server.instancePath}`,
        {},
        'GET',
        undefined,
        AbortSignal.timeout(3000),
      )
      .catch(() => undefined);
    const body = answer && 'body' in answer ? (answer.body as { resource?: unknown }) : null;
    return typeof body?.resource === 'string' ? local : undefined;
  }
  async function addressProposal(
    service: string,
    turn?: TurnRef,
    connectionId?: string,
    returnTo?: ReturnTarget,
  ) {
    const server = apps.get(service)!;
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
    const server = apps.get(pending.service);
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
      if (pending.service !== 'n8n' || !options.local)
        throw error(`Use a public HTTPS address for ${server.name}.`);
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
    const unreachable =
      pending.service !== 'n8n'
        ? `${server.name} MCP setup failed.`
        : parsed.token
          ? `Nod could not use this token at ${url.host}. Check the address and the token in ${server.name} under Settings, Instance-level MCP.`
          : `${server.name} did not answer at ${url.host}. Check the address, and turn on MCP access in ${server.name} under Settings, Instance-level MCP.`;
    try {
      return parsed.token
        ? await complete(id, { token: parsed.token, accountName: url.host })
        : await beginOAuth(id, { returnTo: parsed.returnTo });
    } catch (cause) {
      await pool.query(
        `UPDATE discovered_connection_proposals SET paths='[]'::jsonb,oauth_status=NULL,oauth_error=NULL,oauth_state_hash=NULL
         WHERE id=$1 AND owner_id=$2 AND (oauth_status IS NULL OR oauth_status IN ('pending','failed'))`,
        [id, owner],
      );
      if (
        cause instanceof DiscoveredConnectionError &&
        cause.statusCode < 500 &&
        cause.statusCode !== 409
      )
        throw cause;
      const detail = cause instanceof Error ? cause.message : 'The MCP setup failed.';
      throw error(
        `${unreachable} ${parsed.token ? String(redact(detail, parsed.token)) : detail}`,
        502,
      );
    }
  }
  function official(service: string, connectionId?: string) {
    const server = apps.get(service);
    if (!server) throw error('This service is unavailable.', 404);
    if (server.kind === 'cli' && !options.verifyCli)
      throw error(
        'This app cannot check its connection because connected command tools are unavailable.',
        503,
      );
    return {
      service,
      name: server.name,
      paths: [appAccessPath(server)],
      ...(connectionId ? { connectionId } : {}),
    };
  }
  async function signIn(service: string, turn?: TurnRef, connectionId?: string) {
    if (apps.get(service)?.instancePath) return addressProposal(service, turn, connectionId);
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
    if (apps.get(service)?.instancePath)
      return addressProposal(service, undefined, connectionId, returnTo);
    const { id, name } = await create(official(service, connectionId), undefined, returnTo);
    const server = apps.get(service)!;
    const access = appAccessPath(server);
    return {
      name,
      ...(server.auth === 'oauth' && !('clientIdRequired' in access && access.clientIdRequired)
        ? await beginOAuth(id, { returnTo })
        : { url: `/apps?connect=${id}` }),
    };
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
    for (const row of abandoned) track(row, 'failed', reason, { step: 'authorize' });
    return abandoned.length > 0;
  }
  async function proposal(id: string, client: Pool | PoolClient = pool, lock = false) {
    const row = (
      await client.query<ProposalRow>(
        `SELECT id,owner_id,service,name,paths,connection_id,turn_id,setup_url,setup_text,account_name,oauth_state_hash,oauth_status,oauth_error,callback_return_to,created_at,
       (SELECT min(display_name) FROM discovered_connections WHERE owner_id=p.owner_id AND service=p.service) AS display_name
       FROM discovered_connection_proposals p
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
        const sharesName =
          manualMcpService.test(pending.service) &&
          pending.paths.some((path) => path.kind === 'mcp');
        if (sharesName) await lockDisplayName(client, pending.service);
        await client.query(
          `INSERT INTO discovered_connections (id,owner_id,service,name,account_name,paths,display_name)
           VALUES($1,$2,$3,$4,$5,$6,
             CASE WHEN $7 THEN
               (SELECT min(display_name) FROM discovered_connections WHERE owner_id=$2 AND service=$3)
             END)`,
          [
            idToSave,
            owner,
            pending.service,
            pending.name,
            accountName,
            JSON.stringify(pending.paths),
            sharesName,
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
  async function verifyHttp(path: Extract<AccessPath, { kind: 'http' }>, token: string) {
    if (!path.testPath) throw error('The API path needs a read test.');
    const response = await via(path).transport.http(
      target(path, path.testPath),
      headers(path, token),
      path.testMethod ?? 'GET',
      path.testBody,
    );
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(
        new Error(
          `The service answered ${response.status}: ${JSON.stringify('body' in response ? response.body : null).slice(0, 4000)}`,
        ),
        { status: response.status },
      );
  }
  async function complete(id: string, input: unknown) {
    const { token: entered, accountName } = z
      .object({
        token: z.union([
          z.string().trim().min(1).max(8192),
          z.record(envName, z.string().trim().min(1).max(8192)),
        ]),
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
          if (!tools.length) throw new Error('The server listed no tools.');
        } else if (path.kind === 'http') {
          await verifyHttp(path, token);
        } else if (path.testArgv) {
          if (!options.verifyCli) throw error('The app connection check is unavailable.', 503);
          const environment =
            path.env.length > 1
              ? z.record(envName, z.string()).parse(JSON.parse(token))
              : { [path.env[0]]: token };
          const result = await options.verifyCli(
            { id: path.id, command: path.command, source: path.source },
            path.testArgv,
            environment,
            path.testTimeoutSeconds ?? 30,
          );
          if (result.exitCode !== 0)
            throw new Error(
              `The app read check exited with status ${result.exitCode}: ${result.output.slice(0, 4000)}`,
            );
          const output = result.stdout ?? result.output;
          if (!output.trim()) throw new Error('The app read check returned no data.');
          if (path.testFormat !== 'text') {
            try {
              JSON.parse(output);
            } catch {
              throw new Error('The app read check did not return valid JSON.');
            }
          }
        }
      } catch (cause) {
        const status = [Object(cause).status, Object(cause).code].find(
          (value) => Number.isInteger(value) && value >= 400 && value < 600,
        );
        track(pending, 'failed', 'verification_failed', {
          step: path.kind === 'mcp' ? 'list_tools' : 'read_test',
          error: cause,
          path,
        });
        const values = typeof entered === 'string' ? [entered] : Object.values(entered);
        const reason =
          cause instanceof Error && cause.message
            ? cause.message
            : status
              ? `The service answered ${status}.`
              : 'The service did not confirm access.';
        const safe = [token, ...values].reduce(
          (value, secret) => String(redact(value, secret)),
          reason,
        );
        throw error(`The connection could not be verified: ${safe}`, 409);
      }
    }
    try {
      return await save(pending, accountName, token);
    } catch (error) {
      track(pending, 'failed', 'unknown', { step: 'save', error });
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
    let authorizationError: unknown;
    try {
      const result = await transaction(async (client) => {
        const pending = await proposal(id, client, true);
        if (
          (expectedStateHash && pending.oauth_state_hash !== expectedStateHash) ||
          (suppliedStateHash !== undefined && pending.oauth_state_hash !== suppliedStateHash)
        )
          throw error('This sign-in changed. Use the newest window or try again.', 409);
        const path = pending.paths[0];
        if (!path || path.kind === 'cli' || path.auth !== 'oauth')
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
            path.kind === 'http' ? path.oauth : undefined,
          );
        } catch (cause) {
          authorizationFailed = true;
          authorizationError = cause;
          const reason =
            (cause instanceof Error && (cause.message || Object(cause).errorCode)) || String(cause);
          throw error(
            `The service sign-in could not start: ${redactSecretText(String(reason)).slice(0, 500)}`,
            502,
          );
        }
        const updated = await client.query(
          `UPDATE discovered_connection_proposals
         SET account_name=$3,oauth_state_hash=$4,oauth_status='pending',oauth_error=NULL,link_hash=$5,callback_return_to=$6
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
        track(attempt, 'failed', authorizationFailed ? 'authorization_failed' : 'unknown', {
          step: authorizationFailed ? 'authorize' : 'save',
          error: authorizationFailed ? authorizationError : error,
        });
        await pool
          .query(
            'UPDATE discovered_connection_proposals SET oauth_error=NULL WHERE id=$1 AND owner_id=$2',
            [attempt.id, owner],
          )
          .catch((cause: unknown) => logFailure('connection_reason_clear_failed', cause));
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
        error_description: z.string().optional().catch(undefined),
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
      failure: { step: string; error?: unknown } = { step: 'callback' },
      message?: string,
    ) {
      const changed = await transaction(async (client) => {
        const changed = await client.query(
          `UPDATE discovered_connection_proposals SET oauth_status=$4,oauth_error=$5,oauth_state_hash=NULL
           WHERE id=$1 AND owner_id=$2 AND oauth_state_hash=$3 AND oauth_status='completing' RETURNING id`,
          [
            pending.id,
            owner,
            hash,
            outcome,
            message &&
              `Sign-in could not finish: ${redactSecretText(message.replaceAll('\0', ''))}`.slice(
                0,
                500,
              ),
          ],
        );
        if (changed.rowCount) await options.grantVault.remove(pending.id, client);
        return Boolean(changed.rowCount);
      }, pool);
      if (changed)
        track(pending, 'failed', outcome === 'cancelled' ? 'cancelled' : reason, failure);
      return {
        outcome,
        service: pending.service,
        attempt: parsed.state,
        returnTo:
          pending.callback_return_to ?? (pending.turn_id ? ('chat' as const) : ('apps' as const)),
      };
    }
    if (parsed.error || !parsed.code)
      return failed(
        parsed.error === 'access_denied' ? 'cancelled' : 'failed',
        undefined,
        {
          step: 'callback',
          error: {
            code: !parsed.error
              ? 'missing_code'
              : oauthErrors.includes(parsed.error)
                ? parsed.error
                : 'other',
          },
        },
        parsed.error === 'access_denied'
          ? undefined
          : [parsed.error || 'no authorization code', parsed.error_description]
              .filter(Boolean)
              .join(': '),
      );
    const path = pending.paths[0];
    if (!path || path.kind === 'cli' || path.auth !== 'oauth')
      return failed('failed', 'invalid_configuration');
    let failureReason: 'authorization_failed' | 'verification_failed' | 'unknown' =
      'authorization_failed';
    let step = 'callback';
    const secrets: string[] = [];
    try {
      const grant = JSON.parse((await options.grantVault.read(pending.id)).value);
      const saved = (grant.state ?? grant) as DiscoveredOAuthState;
      const metadata = saved.discovery?.authorizationServerMetadata;
      const issuer = metadata?.issuer;
      if (parsed.iss && parsed.iss !== issuer) throw new Error('The issuer does not match.');
      if (
        metadata &&
        'authorization_response_iss_parameter_supported' in metadata &&
        metadata.authorization_response_iss_parameter_supported === true &&
        parsed.iss !== issuer
      )
        throw new Error('The issuer does not match.');
      step = 'token';
      const connected = await via(path).oauth.finish(path.endpoint, saved, parsed.code);
      const token = connected.tokens?.access_token;
      secrets.push(token ?? '', connected.tokens?.refresh_token ?? '');
      if (!token) throw new Error('The service returned no access token.');
      failureReason = 'verification_failed';
      step = path.kind === 'http' ? 'read_test' : 'list_tools';
      if (path.kind === 'http') await verifyHttp(path, token);
      else if (
        !(await via(path).transport.listTools(path.endpoint, headers(path, token))).tools.length
      )
        throw new Error('The server listed no tools.');
      failureReason = 'unknown';
      step = 'save';
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
    } catch (error) {
      const message = (error instanceof Error && error.message) || String(error);
      return failed(
        'failed',
        failureReason,
        {
          step,
          error,
        },
        secrets.reduce((text, secret) => (secret ? String(redact(text, secret)) : text), message),
      );
    }
  }
  const refreshes = new Map<string, Promise<string>>();
  async function signInRequired(row: AccountRow, required: boolean) {
    const changed = await pool.query(
      'UPDATE discovered_connections SET reconnect_required=$3 WHERE id=$1 AND owner_id=$2 AND reconnect_required<>$3 AND account_id=$4 AND paths=$5::jsonb',
      [row.id, owner, required, row.account_id, JSON.stringify(row.paths)],
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
    const key = JSON.stringify([row.id, row.account_id, path]);
    const cached = catalogs.get(key);
    if (cached && Date.now() - cached.at < catalogMs)
      return allowStale && cached.ready ? cached.ready : cached.value;
    const value = (async () => {
      await assertBinding(row);
      signal?.throwIfAborted();
      const token = await tokenFor(row, path, signal);
      await assertBinding(row);
      signal?.throwIfAborted();
      const { tools, instructions } = await via(path)
        .transport.listTools(path.endpoint, headers(path, token), signal)
        .catch((cause: unknown) => {
          signal?.throwIfAborted();
          const fields =
            cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : {};
          const status = [fields.status, fields.statusCode].find(
            (value) =>
              typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
          );
          const code =
            (typeof fields.code === 'number' && Number.isFinite(fields.code)) ||
            typeof fields.code === 'string'
              ? String(redact(String(fields.code), token)).slice(0, 100)
              : undefined;
          const detail = [
            status === undefined ? undefined : `status ${status}`,
            code === undefined ? undefined : `code ${code}`,
          ]
            .filter(Boolean)
            .join('; ');
          throw Object.assign(
            error(
              `The connected MCP tool list failed${detail ? ` (${detail})` : ''}: ${String(redact(cause instanceof Error ? cause.message : String(cause), token)).slice(0, 4000)}`,
              502,
            ),
            { notRun: true, ...(status === undefined ? {} : { upstreamStatus: status }) },
          );
        });
      signal?.throwIfAborted();
      await assertBinding(row);
      signal?.throwIfAborted();
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
        if (cached) catalogs.set(key, cached);
        else catalogs.delete(key);
      },
    );
    if (allowStale && entry.ready) return entry.ready;
    return cached && allowStale ? value.catch(() => cached.value) : value;
  }
  async function tokenFor(
    row: AccountRow,
    path: AccessPath,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    const readGrant = () =>
      transaction(
        async (client) => {
          await assertBinding(row, undefined, client);
          return options.grantVault.read(row.id, client);
        },
        pool,
        signal,
      );
    const grant = await readGrant();
    signal?.throwIfAborted();
    const secret = grant.value;
    if (path.auth !== 'oauth') return secret;
    const saved = JSON.parse(secret) as DiscoveredOAuthState;
    if (!saved.tokens?.access_token) {
      await signInRequired(row, true);
      throw Object.assign(error('Connect this account again.', 409), { reason: 'authentication' });
    }
    if (!saved.expiresAt || saved.expiresAt > Date.now() + 60_000) return saved.tokens.access_token;
    const refreshKey = JSON.stringify([row.id, row.account_id, row.paths]);
    let refresh = refreshes.get(refreshKey);
    if (!refresh) {
      const pending = (async () => {
        await assertBinding(row);
        const next = await via(path)
          .oauth.refresh(path.endpoint, saved, AbortSignal.timeout(30_000))
          .catch(async (cause: unknown) => {
            logFailure('connected_sign_in_refresh_failed', cause);
            if (cause instanceof DiscoveredSignInRequired) await signInRequired(row, true);
            throw cause;
          });
        if (!next.tokens?.access_token) throw new Error('The service returned no access token.');
        const token = await transaction(async (client) => {
          await assertBinding(row, undefined, client);
          const changed = await options.grantVault.replace(
            row.id,
            grant.version,
            JSON.stringify(next),
            client,
          );
          if (changed) return next.tokens!.access_token!;
          const latest = JSON.parse(
            (await options.grantVault.read(row.id, client)).value,
          ) as DiscoveredOAuthState;
          if (!latest.tokens?.access_token || (latest.expiresAt ?? 0) <= Date.now())
            throw new Error('The saved sign-in changed during the refresh.');
          return latest.tokens.access_token;
        }, pool);
        await assertBinding(row);
        await signInRequired(row, false);
        return token;
      })();
      refreshes.set(refreshKey, pending);
      void pending
        .finally(() => {
          if (refreshes.get(refreshKey) === pending) refreshes.delete(refreshKey);
        })
        .catch(() => {});
      refresh = pending;
    }
    let abort = () => {};
    try {
      return await Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } catch (cause) {
      if (
        (signal?.aborted && cause === signal.reason) ||
        cause instanceof DiscoveredConnectionError
      )
        throw cause;
      const secrets = [saved.tokens.access_token, saved.tokens.refresh_token];
      const message = secrets.reduce<string>(
        (text, secret) => (secret ? String(redact(text, secret)) : text),
        cause instanceof Error ? cause.message : String(cause),
      );
      if (cause instanceof DiscoveredSignInRequired)
        throw Object.assign(error(message, 409), { reason: 'authentication' });
      throw Object.assign(
        error(`Refreshing the sign-in failed, so nothing ran: ${message.slice(0, 4000)}`, 502),
        { notRun: true, reason: serviceFailureReason(cause) },
      );
    } finally {
      signal?.removeEventListener('abort', abort);
    }
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
    const reviewed = apps.get(service);
    if (reviewed && !reviewed.instancePath) {
      const { id, name } = await create(
        official(service, row.reconnect_required && !newAccount ? row.id : undefined),
        undefined,
        returnTo,
      );
      return { name, url: `/apps?connect=${id}` };
    }
    const localOrigin = row.paths.flatMap((path) =>
      path.kind !== 'cli' && path.local ? [new URL(path.endpoint).origin] : [],
    )[0];
    const { id, name } = await create(
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
              ...(path.testArgv
                ? {
                    testArgv: path.testArgv,
                    testTimeoutSeconds: path.testTimeoutSeconds,
                    testFormat: path.testFormat,
                  }
                : {}),
            };
          }
          return {
            kind: path.kind,
            endpoint: path.endpoint,
            auth: path.auth,
            ...(path.testPath ? { testPath: path.testPath } : {}),
            ...(path.kind === 'http'
              ? {
                  apiKeyHeader: path.apiKeyHeader,
                  testMethod: path.testMethod,
                  testBody: path.testBody,
                  oauth: path.oauth,
                }
              : {}),
            ...(path.scope ? { scope: path.scope } : {}),
            ...(path.clientIdRequired ? { clientIdRequired: path.clientIdRequired } : {}),
          };
        }),
      },
      undefined,
      returnTo,
      localOrigin,
    );
    return { name: row.display_name ?? name, url: `/apps?connect=${id}` };
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
                ...(path.kind === 'http'
                  ? {
                      readCheck: {
                        method: path.testMethod ?? 'GET',
                        path: path.testPath,
                        ...(path.testBody !== undefined ? { body: path.testBody } : {}),
                      },
                    }
                  : path.testArgv
                    ? { readCheck: { argv: path.testArgv } }
                    : {}),
              };
            try {
              const { tools: available, instructions } = await catalog(row, path, signal);
              const accountMatch =
                score(row.service) || score(row.name) || score(row.display_name ?? '');
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
        const app = apps.get(row.service);
        return {
          connectionId: row.id,
          service: row.service,
          ...(row.display_name ? { name: row.display_name } : {}),
          accountName: row.account_name,
          ...(app ? { description: app.description, documentation: app.contract.source } : {}),
          paths,
        };
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
                    name: row.display_name ?? row.name,
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
      const argv = z
        .array(
          z
            .string()
            .min(1)
            .refine((value) => !value.includes('\0')),
        )
        .min(1)
        .parse(args.argv);
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
  async function assertBinding(
    row: AccountRow,
    expectedBinding = JSON.stringify([row.account_id, row.paths]),
    client?: PoolClient,
  ) {
    const current = await binding(row.id, client);
    if (current !== JSON.stringify([row.account_id, row.paths]) || current !== expectedBinding)
      throw Object.assign(error('This connected account changed.', 409), { notRun: true });
  }
  async function approvalDetails(
    action: 'CONNECTED_HTTP' | 'CONNECTED_MCP_CALL',
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    args = structuredClone(args);
    signal?.throwIfAborted();
    const { row, call } = await selected(action, args);
    const verifiedBinding = JSON.stringify([row.account_id, row.paths]);
    await assertBinding(row);
    signal?.throwIfAborted();
    const account = { name: row.display_name ?? row.name, identity: row.account_name };
    if (call.kind === 'http')
      return {
        account,
        request: {
          method: call.method,
          url: call.url,
          ...(call.method !== 'GET' && args.body !== undefined ? { body: args.body } : {}),
        },
        verifiedBinding,
      };
    if (call.kind !== 'mcp') throw error('Choose an MCP access path.');
    const { tools } = await catalog(row, call.path, signal);
    await assertBinding(row);
    signal?.throwIfAborted();
    const matches = tools.filter((tool) => tool.name === call.tool);
    if (matches.length !== 1)
      throw error('The selected MCP tool is unavailable in this connection’s tool list.', 409);
    return {
      account: {
        ...account,
        method: call.path.kind,
        endpoint: call.path.endpoint,
      },
      tool: matches[0]!,
      verifiedBinding,
    };
  }
  async function execute(
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
    expectedBinding?: string,
  ) {
    const { row, call } = await selected(action, args).catch((cause: unknown) => {
      throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), {
        notRun: true,
      });
    });
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
          await assertBinding(row, expectedBinding);
          token = await tokenFor(row, path, signal);
          await assertBinding(row, expectedBinding);
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
          if (call.kind === 'cli') {
            const { stdout: _stdout, stderr: _stderr, ...value } = result as ConnectedCliResult;
            return hide(value);
          }
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
    app.patch<{ Params: { service: string } }>('/api/apps/mcp/:service', async (request) => {
      const { service } = request.params;
      if (!manualMcpService.test(service) || apps.has(service))
        throw error('This custom MCP server is unavailable.', 404);
      const input = z.object({ name: proposalSchema.shape.name }).strict().safeParse(request.body);
      if (!input.success) throw error('To rename this server, enter a name of 1 to 80 characters.');

      await transaction(async (client) => {
        await lockDisplayName(client, service);
        const result = await client.query(
          `UPDATE discovered_connections SET display_name=$3
           WHERE owner_id=$1 AND service=$2 AND paths @> '[{"kind":"mcp"}]'::jsonb`,
          [owner, service, input.data.name],
        );
        if (!result.rowCount) throw error('This custom MCP server is unavailable.', 404);
      }, pool);
      options.refresh?.();
      return { name: input.data.name };
    });
    app.post('/api/apps/mcp', async (request, reply) => {
      const parsed = z
        .object({
          name: proposalSchema.shape.name,
          endpoint: z
            .string()
            .trim()
            .transform((value) =>
              /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
            )
            .pipe(z.url({ protocol: /^https?$/ }).max(2048)),
          auth: z.enum(['oauth', 'bearer', 'x-api-key']),
          clientIdRequired: z.boolean().optional(),
        })
        .strict()
        .refine((value) => !value.clientIdRequired || value.auth === 'oauth')
        .safeParse(request.body);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path[0];
        throw error(
          field === 'name'
            ? 'Enter a name of 1 to 80 characters.'
            : field === 'endpoint'
              ? 'Enter a valid server URL, such as https://example.com/mcp.'
              : 'Enter a name, server URL and authentication method.',
        );
      }
      const { name, auth } = parsed.data;
      let localOrigin: string | undefined;
      const endpoint = await options.transport
        .validateEndpoint(parsed.data.endpoint)
        .catch(async (cause: unknown) => {
          const reason = cause instanceof Error ? cause.message : String(cause);
          if (!options.local)
            throw error(`Use a public HTTPS server address without a query or fragment. ${reason}`);
          const origin = new URL(parsed.data.endpoint).origin;
          const checked = await options
            .local(origin)
            .transport.validateEndpoint(parsed.data.endpoint)
            .catch((local: unknown) => {
              throw error(
                `Nod could not use ${origin}: ${local instanceof Error ? local.message : String(local)}`,
              );
            });
          localOrigin = origin;
          return checked;
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
        localOrigin,
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
      const address = apps.get(row.service)?.instancePath && !row.paths.length;
      const localAddress = address ? await nearby(row.service) : undefined;
      const catalogApp = Boolean(
        apps.get(row.service) &&
        (address ||
          row.paths.every((path) => {
            const app = apps.get(row.service)!;
            if (app.instancePath) return path.kind === 'mcp';
            const { id: _id, local: _local, ...saved } = path;
            return isDeepStrictEqual(saved, appAccessPath(app));
          })),
      );
      return reply.header('Cache-Control', 'no-store').send({
        service: row.service,
        name: row.display_name ?? row.name,
        catalogApp,
        hints: catalogApp ? apps.get(row.service)?.hints : undefined,
        credentialLabels:
          apps.get(row.service)?.kind === 'cli'
            ? (apps.get(row.service) as Extract<BundledApp, { kind: 'cli' }>).environment
            : undefined,
        ...(address ? { needsAddress: true, localAddress } : {}),
        oauthStatus: row.oauth_status === 'completing' ? 'pending' : row.oauth_status,
        oauthError: row.oauth_error ?? undefined,
        authorizationUrl,
        attempt,
        callbackUrl: row.paths.some((path) => path.kind !== 'cli' && path.clientIdRequired)
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
                ...(path.testArgv ? { testArgv: path.testArgv } : {}),
              }
            : {
                kind: path.kind,
                endpoint: path.endpoint,
                auth: path.auth,
                ...(path.testPath ? { testPath: path.testPath } : {}),
                ...(path.kind === 'http'
                  ? {
                      apiKeyHeader: path.apiKeyHeader,
                      testMethod: path.testMethod,
                      testBody: path.testBody,
                    }
                  : {}),
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
    apps,
    binding,
    approvalDetails,
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
