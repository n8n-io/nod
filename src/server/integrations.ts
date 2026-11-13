import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { getDomain } from 'tldts';
import type { AppSetupStatus, Connection, VaultLoginEntry } from '../shared/contracts.ts';
import {
  IntegrationCatalogAccessDenied,
  IntegrationCatalogFailure,
  IntegrationConnectionError,
  IntegrationInboxCursorExpired,
  IntegrationInboxTransientError,
  IntegrationPermissionError,
  type ConnectedApp,
  type IntegrationProvider,
  type IntegrationSearch,
  type IntegrationServiceInfo,
  type IntegrationSession,
  type SentEmail,
} from '../ports/integrations.ts';
import { integrationMetadata, integrationServiceIds } from '../shared/integrations.ts';
import { untrustedBlock } from '../shared/untrusted.ts';
import {
  DiscoveredConnectionError,
  officialMcp,
  type createDiscoveredConnections,
} from './discovered-connections.ts';
import { transaction } from './transaction.ts';
import type { WorkAdmission } from './work-admission.ts';
import type { SiteIcon } from '../ports/link-preview.ts';
import { BrowserConnectionError } from './browser-connections.ts';
import type { TurnRef } from './thread.ts';
import { noMailCheck, privateEmailResult, type MailCheck } from './integration-result.ts';
import type { ObservationQuery } from '../ports/proactivity.ts';
import { withoutSecretKeys } from './redaction.ts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';
import {
  captureConnection,
  captureServiceFailure,
  serviceFailureReason,
  withServiceAnalytics,
  type AnalyticsConnection,
} from './analytics-connections.ts';
import {
  fileDigest,
  hasWorkspaceFiles,
  pinnedWorkspaceFiles,
  pinWorkspaceFiles,
  uploadWorkspaceFiles,
  workspaceFileSchemas,
} from './integration-files.ts';
import { fileBytes } from '../shared/files.ts';
import { IntegrationError, verifyIntegrationCompletion } from './integration-connection.ts';
import {
  normalizedEmail,
  verificationCode,
  verificationSenderDomain,
  type EmailCodeRequest,
} from './email-code.ts';
import { logFailure } from './failure-log.ts';
import { isLocalFilesAction, type LocalFiles } from './local-files.ts';

const unverifiedAccount =
  "Nod can't confirm this is the same account, so it can't reconnect it in place. Connect the app again as a new connection; the old one stays in Apps until you remove it.";
const retiredNotionMcp = 'notion_mcp';
const retiredNotionMessage =
  'This older Notion MCP connection cannot read pages. Connect Notion again, then remove this connection in Apps.';

const slugSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
type Slug = z.infer<typeof slugSchema>;
const returnPaths = {
  apps: '/apps',
  onboarding: '/onboarding',
  window: '/connected.html',
  desktop: '/connected.html',
  chat: '/',
} as const;
type ReturnTarget = keyof typeof returnPaths;
type EmailAccount = {
  accountId: string;
  providerId: string;
  configurationId: string | null;
};
const serviceSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
  logoUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  categories: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    )
    .max(12)
    .optional(),
});
type ConnectionRow = {
  id: string;
  owner_id: string;
  slug: Slug;
  account_id: string | null;
  pending_account_id: string | null;
  pending_account_email: string | null;
  pending_auth_config_id: string | null;
  replaces_connection_id: string | null;
  callback_hash: string | null;
  callback_claim_id: string | null;
  callback_verifier: string | null;
  setup_link_hash: string | null;
  callback_expires: Date | null;
  callback_expired?: boolean;
  callback_return_to: ReturnTarget;
  trigger_id: string | null;
  triggers_enabled: boolean;
  watch_requested: boolean;
  watch_attempted: boolean;
  watch_revision: number;
  activity_token: string | null;
  activity_failed: boolean;
  activity_claim_id: string | null;
  inbox_cursor: string | null;
  inbox_poll_at: Date | null;
  inbox_claim_id: string | null;
  inbox_checked_at: Date | null;
  inbox_failed: boolean;
  inbox_reconnect_required: boolean;
  writing_style_pending: EmailAccount | null;
  account_name: string | null;
  account_email: string | null;
  account_active: boolean;
  account_checked_at: Date | null;
  revoked: boolean;
  provider_id: string;
  configuration_id: string | null;
  turn_id: string | null;
};
type IntegrationOptions = {
  admission?: WorkAdmission;
  analytics?: CaptureAnalytics;
  analyticsConsent?: () => { enabled: boolean; revision?: string };
  ownerId: string;
  wake(
    prompt: string,
    eventId: string,
    current?: (client: PoolClient) => Promise<boolean>,
    connectionId?: string,
  ): Promise<unknown>;
  settle?(): Promise<unknown>;
  provider: IntegrationProvider;
  lockActivity?(client: PoolClient): Promise<void>;
  removeActivity?(connectionId: string, client: PoolClient): Promise<void>;
  resumeConnection?(turnId: string, service: Slug): Promise<boolean>;
  writingStyle?: {
    enabled(): Promise<boolean>;
    ready(): boolean;
    learn(
      read: (signal: AbortSignal) => Promise<SentEmail[]>,
      stop: AbortSignal,
      validate: (signal: AbortSignal) => Promise<void>,
    ): Promise<void>;
  };
  readWorkspaceFile?(turn: TurnRef, path: string, maxBytes: number): Promise<Uint8Array>;
  baseUrl: string;
  callbackReturnTo?: 'window';
  refresh?(): void;
  discovered?: Awaited<ReturnType<typeof createDiscoveredConnections>>;
  localFiles?: LocalFiles;
  browserAccounts?: (client?: PoolClient) => Promise<VaultLoginEntry[]>;
  browserConnections?: (client?: PoolClient) => Promise<Connection[]>;
  icon?: (origin: string) => Promise<SiteIcon | null>;
  mailCheck?: MailCheck;
  paused?(): Promise<boolean>;
};

function browserService(origin: string) {
  const url = new URL(origin);
  const domain = getDomain(url.hostname, { allowPrivateDomains: true });
  const name = domain ?? url.hostname;
  return {
    slug: `browser-${name
      .replace(/[^a-z0-9]/gi, '-')
      .toLowerCase()
      .slice(0, 40)}-${createHash('sha256').update(url.origin).digest('hex').slice(0, 12)}`,
    name,
  };
}
function failure(prefix: string, error: unknown) {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
function requestFailure(prefix: string, error: unknown) {
  const status = z.object({ status: z.number().int().min(100).max(599) }).safeParse(error);
  return Object.assign(
    new IntegrationError(failure(prefix, error), 502),
    status.success ? { upstreamStatus: status.data.status } : {},
  );
}
function messageIdentity(data: Record<string, unknown>, field: 'message' | 'thread') {
  const nested = data.message;
  const value =
    data[`${field}_id`] ??
    data[`${field}Id`] ??
    (nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>)[field === 'message' ? 'id' : 'threadId']
      : undefined) ??
    (field === 'message' ? data.id : undefined);
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

async function eventOverview(
  toolkit: string,
  trigger: string,
  data: Record<string, unknown>,
  check: MailCheck,
  signal?: AbortSignal,
) {
  const fields =
    toolkit === 'gmail'
      ? {
          message_id: messageIdentity(data, 'message'),
          thread_id: messageIdentity(data, 'thread'),
          ...data,
        }
      : data;
  return `Connected-app event from ${toolkit}; trigger ${trigger}. Assess whether there is useful background work to do.\n${untrustedBlock(`${toolkit} event`, JSON.stringify(await privateEmailResult(withoutSecretKeys(fields), check, signal)))}`;
}

export async function initializeIntegrationSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text NOT NULL, slug text NOT NULL, account_id text, pending_account_id text,
      callback_hash text, callback_expires timestamptz, trigger_id text,
      triggers_enabled boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false,
      callback_return_to text NOT NULL DEFAULT 'apps', provider_id text NOT NULL DEFAULT 'composio',
      turn_id uuid, account_name text, account_email text,
      account_active boolean NOT NULL DEFAULT true, account_checked_at timestamptz,
      watch_retry_at timestamptz, watch_attempted_at timestamptz,
      watch_failures integer NOT NULL DEFAULT 0, watch_requested boolean NOT NULL DEFAULT true,
      watch_attempted boolean NOT NULL DEFAULT false, watch_revision integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS app_setup_completions (
      owner_id text NOT NULL, link_hash text NOT NULL,
      PRIMARY KEY (owner_id,link_hash)
    );
    CREATE TABLE IF NOT EXISTS app_setup_links (
      owner_id text NOT NULL, link_hash text NOT NULL, slug text NOT NULL,
      PRIMARY KEY (owner_id,link_hash)
    );
    CREATE TABLE IF NOT EXISTS integration_events (
      id text PRIMARY KEY, owner_id text NOT NULL, summary text NOT NULL, state text NOT NULL DEFAULT 'queued',
      slug text, account_id text, trigger_id text, claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      provider_id text NOT NULL DEFAULT 'composio'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_connections_account_key ON app_connections(owner_id,provider_id,account_id) WHERE account_id IS NOT NULL;
    ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS inbox_cursor text,
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS callback_verifier text,
      ADD COLUMN IF NOT EXISTS callback_claim_id text,
      ADD COLUMN IF NOT EXISTS configuration_id text,
      ADD COLUMN IF NOT EXISTS setup_link_hash text,
      ADD COLUMN IF NOT EXISTS pending_account_email text,
      ADD COLUMN IF NOT EXISTS pending_auth_config_id text,
      ADD COLUMN IF NOT EXISTS replaces_connection_id uuid,
      ADD COLUMN IF NOT EXISTS inbox_poll_at timestamptz, ADD COLUMN IF NOT EXISTS inbox_claim_id text,
      ADD COLUMN IF NOT EXISTS inbox_checked_at timestamptz, ADD COLUMN IF NOT EXISTS inbox_failed boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS inbox_reconnect_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS writing_style_pending jsonb,
      ADD COLUMN IF NOT EXISTS activity_token text,
      ADD COLUMN IF NOT EXISTS activity_failed boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS activity_poll_at timestamptz,
      ADD COLUMN IF NOT EXISTS activity_claim_id text;
    INSERT INTO app_setup_links(owner_id,link_hash,slug)
      SELECT owner_id,setup_link_hash,slug FROM app_connections WHERE setup_link_hash IS NOT NULL
      ON CONFLICT DO NOTHING;
    ALTER TABLE integration_events ADD COLUMN IF NOT EXISTS poll_connection_id uuid;
  `);
}

const activeCallbackClaims = new Set<string>();

function protectedCallback(row: Pick<ConnectionRow, 'callback_claim_id' | 'callback_expired'>) {
  return Boolean(
    row.callback_claim_id &&
    (activeCallbackClaims.has(row.callback_claim_id) || row.callback_expired !== true),
  );
}

export async function createIntegrations(pool: Pool, options: IntegrationOptions) {
  const mailCheck = options.mailCheck ?? noMailCheck;
  const configuredOwner = z.string().min(1).max(200).parse(options.ownerId);
  const provider = options.provider;
  function connectionAnalytics(app: string): AnalyticsConnection {
    return {
      app,
      publicApp: slugSchema.safeParse(app).success,
      connection_method: 'managed_app',
      consentRevision: options.analyticsConsent?.().revision ?? 'disabled',
    };
  }
  function track(
    app: string,
    status: Extract<AnalyticsEvent, { event: 'connection_changed' }>['properties']['status'],
    failureReason?: Extract<
      AnalyticsEvent,
      { event: 'connection_changed' }
    >['properties']['failure_reason'],
  ) {
    captureConnection(options.analytics, connectionAnalytics(app), status, failureReason);
  }
  function connectionFailure(error: unknown) {
    return serviceFailureReason(error);
  }
  const providerId = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .parse(provider.id);
  let serviceCatalog: Map<string, IntegrationServiceInfo> | undefined;
  function serviceInfo(slug: string): IntegrationServiceInfo {
    const info = serviceCatalog?.get(slug);
    return { slug, ...info, ...integrationMetadata(slug, info) };
  }
  function providerForRow(row: Pick<ConnectionRow, 'provider_id'>) {
    if (row.provider_id !== providerId)
      throw new IntegrationError('This connection provider is unavailable.', 503);
    return provider;
  }
  function configurationMatches(row: Pick<ConnectionRow, 'provider_id' | 'configuration_id'>) {
    return Boolean(
      row.provider_id === providerId &&
      provider.configured &&
      (!provider.configurationId || row.configuration_id === provider.configurationId),
    );
  }
  function rowProvider(row: Pick<ConnectionRow, 'provider_id' | 'configuration_id'>) {
    return configurationMatches(row) ? provider : undefined;
  }
  await initializeIntegrationSchema(pool);
  let draining = false;
  let closed = false;
  let refreshing: Promise<void> | undefined;
  let polling: Promise<void> | undefined;
  let activityPolling: Promise<void> | undefined;
  const stop = new AbortController();
  function background(operation: () => Promise<void>) {
    if (closed) return undefined;
    return options.admission ? options.admission.run(operation) : Promise.resolve().then(operation);
  }
  function requiredProvider() {
    if (!provider.configured)
      throw new IntegrationError('Configure a connection provider before linking services.', 503);
    return provider;
  }

  function assertOwner(ownerId: string) {
    if (ownerId !== configuredOwner)
      throw new IntegrationError('This account is unavailable.', 403);
  }

  async function connectionRows(ownerId: string, client?: PoolClient) {
    assertOwner(ownerId);
    return (
      await (client ?? pool).query<ConnectionRow>(
        `SELECT *,callback_expires<=now() AS callback_expired FROM app_connections WHERE owner_id=$1 ORDER BY created_at,id${client ? ' FOR SHARE' : ''}`,
        [ownerId],
      )
    ).rows;
  }

  async function boundedRequest<T>(operation: () => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    try {
      return await Promise.race([
        operation(),
        delay(10_000, undefined, {
          signal: AbortSignal.any([signal, timeout.signal]),
          ref: false,
        }).then(() => {
          throw new Error('Account request timed out.');
        }),
      ]);
    } finally {
      timeout.abort();
    }
  }

  async function withAccountSession<T>(
    ownerId: string,
    rows: ConnectionRow[],
    signal: AbortSignal | undefined,
    operation: (session: IntegrationSession) => Promise<T>,
  ) {
    if (rows.some((row) => !configurationMatches(row)))
      throw new IntegrationError('This connected account is unavailable.', 404);
    signal?.throwIfAborted();
    const accounts: Partial<Record<Slug, string[]>> = {};
    for (const row of rows) (accounts[row.slug] ??= []).push(row.account_id!);
    const session = await requiredProvider().createSession(ownerId, accounts, signal);
    try {
      signal?.throwIfAborted();
      const current = await connectionRows(ownerId);
      for (const row of rows) {
        const latest = current.find((connection) => connection.id === row.id);
        if (
          !latest ||
          latest.revoked ||
          !latest.account_active ||
          !configurationMatches(latest) ||
          latest.provider_id !== row.provider_id ||
          latest.watch_revision !== row.watch_revision ||
          latest.account_id !== row.account_id
        )
          throw new IntegrationError('This connected account is unavailable.', 404);
      }
      return await operation(session);
    } finally {
      provider.deleteSession(session.id).catch(() => {});
    }
  }

  function supportsService(slug: Slug) {
    return (
      provider.configured &&
      (serviceCatalog?.has(slug) ||
        (provider.supportedServices
          ? provider.supportedServices.includes(slug)
          : !provider.listServices &&
            (integrationServiceIds as readonly string[]).slice(0, 5).includes(slug)))
    );
  }

  async function providerCatalog() {
    if (!provider.configured) return new Map<string, IntegrationServiceInfo>();
    let entries: IntegrationServiceInfo[];
    try {
      entries = provider.listServices
        ? z
            .array(serviceSchema)
            .max(5000)
            .parse(await provider.listServices())
        : (provider.supportedServices ?? integrationServiceIds.slice(0, 5)).map(serviceInfo);
    } catch (error) {
      if (error instanceof IntegrationCatalogAccessDenied)
        throw new IntegrationError(error.message, 403);
      if (error instanceof IntegrationConnectionError || error instanceof IntegrationCatalogFailure)
        throw error;
      logFailure('app_catalog_failed', error);
      throw new IntegrationError('The app catalog is unavailable. Try again later.', 502);
    }
    serviceCatalog = new Map(
      entries
        .filter((entry) => entry.slug !== retiredNotionMcp)
        .map((entry) => [entry.slug, entry]),
    );
    return serviceCatalog;
  }

  async function requireService(slug: Slug) {
    if (provider.configured && provider.supportedServices?.includes(slug)) return;
    if (!(await providerCatalog()).has(slug))
      throw new IntegrationError('This app is unavailable with the configured provider.', 503);
  }

  async function catalog(): Promise<Connection[]> {
    const services = await providerCatalog();
    if (options.discovered && !services.has('notion'))
      services.set('notion', serviceInfo('notion'));
    return [...services.values()]
      .sort((left, right) => {
        const featured = (slug: string) => {
          const index = (integrationServiceIds as readonly string[]).indexOf(slug);
          return index < 0 ? integrationServiceIds.length : index;
        };
        return featured(left.slug) - featured(right.slug) || left.name.localeCompare(right.name);
      })
      .map((service) => ({
        ...serviceInfo(service.slug),
        status: 'disconnected',
        triggersEnabled: false,
        supportsTriggers: supportsWatch(service.slug),
      }));
  }

  function inboxPolled(slug: string) {
    return slug === 'gmail' && Boolean(provider.pollInbox);
  }
  function activityReader(slug: string) {
    return provider.activity && Object.hasOwn(provider.activity, slug)
      ? provider.activity[slug]
      : undefined;
  }
  function supportsWatch(slug: Slug) {
    return (
      provider.configured && (provider.supportsSubscriptions.includes(slug) || inboxPolled(slug))
    );
  }

  async function activateWatch(id: string) {
    if (!provider.configured || !provider.webhooksConfigured) return;
    const claimed = await pool.query<ConnectionRow>(
      `UPDATE app_connections SET watch_attempted=true,watch_attempted_at=now(),watch_revision=watch_revision+1 WHERE id=$1 AND owner_id=$2 AND provider_id=$3
       AND watch_requested AND (NOT watch_attempted OR watch_attempted_at IS NULL OR watch_attempted_at < now()-interval '5 minutes')
       AND (watch_retry_at IS NULL OR watch_retry_at<=now()) AND NOT revoked AND account_id IS NOT NULL
       AND trigger_id IS NULL AND slug=ANY($4::text[])
       AND ($5::text IS NULL OR configuration_id=$5) RETURNING *`,
      [
        id,
        configuredOwner,
        providerId,
        provider.supportsSubscriptions,
        provider.configurationId ?? null,
      ],
    );
    const row = claimed.rows[0];
    if (!row) return;
    try {
      const trigger = await requiredProvider().subscribe(
        configuredOwner,
        row.slug,
        row.account_id!,
      );
      const saved = await pool.query(
        `UPDATE app_connections SET trigger_id=$2,triggers_enabled=true,watch_failures=0,watch_retry_at=NULL WHERE id=$1 AND owner_id=$3
         AND provider_id=$4 AND watch_requested AND NOT revoked AND watch_revision=$5 AND trigger_id IS NULL
         AND ($6::text IS NULL OR configuration_id=$6)`,
        [
          row.id,
          trigger.id,
          configuredOwner,
          providerId,
          row.watch_revision,
          provider.configurationId ?? null,
        ],
      );
      if (!saved.rowCount) await provider.unsubscribe(trigger.id);
    } catch {
      await pool.query(
        `UPDATE app_connections SET watch_attempted=false,watch_failures=watch_failures+1,
        watch_retry_at=now()+LEAST(3600,5*power(2,LEAST(watch_failures,10)))*interval '1 second'
        WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND watch_revision=$4 AND trigger_id IS NULL
        AND ($5::text IS NULL OR configuration_id=$5)`,
        [row.id, configuredOwner, providerId, row.watch_revision, provider.configurationId ?? null],
      );
    }
  }

  async function syncWatches() {
    if (!provider.configured || !provider.webhooksConfigured) return;
    const rows = await connectionRows(configuredOwner);
    await Promise.all(
      rows
        .filter(
          (row) =>
            row.provider_id === providerId &&
            configurationMatches(row) &&
            provider.supportsSubscriptions.includes(row.slug) &&
            row.watch_requested &&
            !row.revoked &&
            row.account_id &&
            !row.trigger_id,
        )
        .map((row) => activateWatch(row.id)),
    );
  }

  async function refreshAccounts(rows: ConnectionRow[]) {
    const pending = rows.filter(
      (row) =>
        row.account_id &&
        row.slug !== retiredNotionMcp &&
        !row.revoked &&
        configurationMatches(row) &&
        (!row.account_checked_at || Date.now() - row.account_checked_at.getTime() > 60_000),
    );
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && !closed) {
          const row = pending.shift()!;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const remote = await Promise.race([
              provider.inspectAccount(row.account_id!, row.owner_id),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Account inspection timed out.')),
                  10_000,
                );
                timer.unref();
              }),
            ]);
            if (closed) return;
            const active = remote.active && remote.service === row.slug;
            await pool.query(
              `UPDATE app_connections SET account_active=$4,account_name=COALESCE($5,account_name),
            account_email=COALESCE($6,account_email),account_checked_at=now()
            WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$7 AND NOT revoked`,
              [
                row.id,
                row.owner_id,
                row.provider_id,
                active,
                remote.accountName ?? null,
                remote.accountEmail ?? null,
                row.account_id,
              ],
            );
            if (
              active !== row.account_active ||
              (remote.accountName && remote.accountName !== row.account_name) ||
              (remote.accountEmail && remote.accountEmail !== row.account_email)
            )
              options.refresh?.();
          } catch {
            if (!closed)
              await pool.query(
                'UPDATE app_connections SET account_checked_at=now() WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND NOT revoked',
                [row.id, row.owner_id, row.provider_id, row.account_id],
              );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }),
    );
  }

  async function list(
    ownerId = configuredOwner,
    listing: { refresh?: boolean; client?: PoolClient } = {},
  ): Promise<Connection[]> {
    assertOwner(ownerId);
    const [rows, browserAccounts, discovered, browserConnections] = await Promise.all([
      connectionRows(ownerId, listing.client),
      options.browserAccounts?.(listing.client) ?? [],
      options.discovered?.list(listing.client) ?? [],
      options.browserConnections?.(listing.client) ?? [],
    ]);
    if (listing.refresh !== false && provider.configured && !closed && !refreshing) {
      refreshing = background(() => refreshAccounts(rows))
        ?.catch(() => {})
        .finally(() => {
          refreshing = undefined;
        });
    }
    const result: Connection[] = [];
    const services = new Set<string>([
      ...integrationServiceIds,
      ...rows.filter((row) => row.account_id).map((row) => row.slug),
    ]);
    for (const slug of services) {
      const service = serviceInfo(slug);
      if (officialMcp.has(slug)) {
        result.push({
          slug,
          name: service.name,
          direct: true,
          ...(service.logoUrl ? { logoUrl: service.logoUrl } : {}),
          ...(service.categories?.length ? { categories: service.categories } : {}),
          status: options.discovered ? 'disconnected' : 'not_configured',
          triggersEnabled: false,
          supportsTriggers: false,
          description: service.description,
        });
        continue;
      }
      if (slug === retiredNotionMcp) {
        for (const row of rows.filter((entry) => entry.slug === slug && entry.account_id))
          result.push({
            slug,
            name: 'Notion MCP',
            description: retiredNotionMessage,
            status: 'disconnected',
            connectionId: row.id,
            accountId: row.account_id!,
            accountName: row.account_name ?? undefined,
            accountEmail: row.account_email ?? undefined,
            disconnectPending: row.revoked,
            reconnectRequired: true,
            canReconnect: false,
            triggersEnabled: false,
            supportsTriggers: false,
          });
        continue;
      }
      const accounts = rows.filter((row) => row.slug === slug && row.account_id);
      const entries: Array<ConnectionRow | undefined> = accounts.length ? accounts : [undefined];
      for (const row of entries) {
        const changed = Boolean(row && !configurationMatches(row));
        const active = Boolean(row?.account_id && !row.revoked && row.account_active && !changed);
        const accountName = row?.account_name ?? undefined;
        const accountEmail = row?.account_email ?? undefined;
        const supported = supportsWatch(slug);
        const requested = Boolean(supported && row?.watch_requested);
        const pollingSupported = inboxPolled(slug);
        const pollingActive = Boolean(
          pollingSupported &&
          row?.inbox_checked_at &&
          !row.inbox_failed &&
          new Date(row.inbox_checked_at).getTime() > Date.now() - 360_000,
        );
        const triggersActive = Boolean(
          active &&
          requested &&
          !row?.inbox_reconnect_required &&
          ((row?.triggers_enabled && row.trigger_id) || pollingActive),
        );
        result.push({
          slug,
          name: service.name,
          ...(service.logoUrl ? { logoUrl: service.logoUrl } : {}),
          ...(service.categories?.length ? { categories: service.categories } : {}),
          status:
            !provider.configured || (!row && !supportsService(slug))
              ? 'not_configured'
              : active
                ? 'connected'
                : 'disconnected',
          ...(row ? { connectionId: row.id, accountId: row.account_id! } : {}),
          ...(row
            ? {
                disconnectPending: row.revoked,
                reconnectRequired: changed || row.inbox_reconnect_required,
                canReconnect: Boolean(
                  !row.revoked && provider.configured && provider.reconnectAccount,
                ),
              }
            : {}),
          ...(accountName ? { accountName } : {}),
          ...(accountEmail ? { accountEmail } : {}),
          ...(row?.account_checked_at ? { checkedAt: row.account_checked_at.toISOString() } : {}),
          triggersEnabled: requested,
          triggersActive,
          triggerStatus: !requested
            ? 'disabled'
            : triggersActive
              ? 'active'
              : (!provider.webhooksConfigured && !pollingSupported) || row?.inbox_failed
                ? 'unavailable'
                : 'pending',
          supportsTriggers: supported,
          description: changed
            ? "Nod's app connection settings changed since this account was connected. Connect it again to use it."
            : row?.inbox_reconnect_required
              ? 'Inbox history expired. Reconnect this account to resume new email updates. Review the missing interval separately; reconnecting does not recover it.'
              : service.description,
        });
      }
    }
    return [
      ...result,
      ...discovered,
      ...browserConnections,
      ...browserAccounts.map((entry): Connection => {
        const service = browserService(entry.origin);
        return {
          slug: service.slug,
          name: service.name,
          status: 'connected',
          connectionId: entry.id,
          accountName: entry.label,
          savedLogin: true,
          triggersEnabled: false,
          supportsTriggers: false,
          accessPaths: [{ id: entry.id, kind: 'browser', endpoint: entry.origin }],
        };
      }),
    ];
  }

  async function connectedApps(ownerId = configuredOwner, withAccount = false) {
    return (await list(ownerId, { refresh: false }))
      .filter((connection) => connection.status === 'connected' && !connection.savedLogin)
      .map((connection): ConnectedApp & { accountId?: string } => ({
        slug: connection.slug.slice(0, 100),
        name: connection.name.slice(0, 150),
        status: connection.status,
        connectionId: connection.connectionId,
        accountName: connection.accountName?.slice(0, 150),
        accountEmail: connection.accountEmail?.slice(0, 320),
        access: connection.accessPaths?.length
          ? [...new Set(connection.accessPaths.map((path) => path.kind))]
          : ['api'],
        supportsTriggers: connection.supportsTriggers,
        triggersEnabled: connection.triggersEnabled,
        triggerStatus: connection.triggerStatus,
        browserState: connection.browserState,
        checkedAt: connection.checkedAt,
        ...(withAccount && connection.accountId ? { accountId: connection.accountId } : {}),
      }));
  }

  async function analyticsConnections(): Promise<AnalyticsConnection[]> {
    return (await connectionRows(configuredOwner))
      .filter(
        (row) => row.account_id && row.account_active && !row.revoked && configurationMatches(row),
      )
      .map((row) => connectionAnalytics(row.slug));
  }

  async function binding(connectionId: string, client?: PoolClient) {
    const row = (
      await (client ?? pool).query<ConnectionRow>(
        `SELECT * FROM app_connections WHERE owner_id=$1 AND id=$2${client ? ' FOR SHARE' : ''}`,
        [configuredOwner, z.uuid().parse(connectionId)],
      )
    ).rows[0];
    if (row)
      return row.account_id && !row.revoked && row.account_active && configurationMatches(row)
        ? JSON.stringify([
            row.account_id,
            row.provider_id,
            row.configuration_id,
            row.watch_revision,
          ])
        : undefined;
    return options.discovered?.binding(connectionId, client);
  }

  async function icon(connectionId: string) {
    const fetchIcon = options.icon;
    if (!fetchIcon || !z.uuid().safeParse(connectionId).success) return null;
    const connection = (await list(configuredOwner, { refresh: false })).find(
      (item) => item.connectionId === connectionId,
    );
    const endpoint = connection?.accessPaths?.find((path) => path.kind !== 'cli')?.endpoint;
    if (!endpoint) return null;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return fetchIcon(url.origin);
  }

  async function selectConnection(
    ownerId: string,
    slug: Slug,
    connectionId?: string,
    includeRevoked = false,
    client?: PoolClient,
  ) {
    const rows = (await connectionRows(ownerId, client)).filter(
      (row) =>
        row.slug === slug &&
        row.account_id &&
        (!row.revoked || includeRevoked) &&
        ((row.account_active && configurationMatches(row)) || includeRevoked),
    );
    if (connectionId) {
      const row = rows.find((item) => item.id === connectionId);
      if (!row) throw new IntegrationError('This connected account is unavailable.', 404);
      return row;
    }
    if (rows.length > 1)
      throw new IntegrationError(
        'Choose an account using connectionId from the connection list.',
        409,
      );
    if (!rows[0])
      throw new IntegrationError(`Connect ${serviceInfo(slug).name} in Apps first.`, 409);
    return rows[0];
  }

  async function connect(
    slug: Slug,
    returnTo: ReturnTarget = 'apps',
    turn?: TurnRef,
    replacement?: ConnectionRow,
  ) {
    if (slug === retiredNotionMcp) throw new IntegrationError(retiredNotionMessage, 409);
    await requireService(slug);
    await pool.query(
      `DELETE FROM app_connections WHERE owner_id=$1 AND account_id IS NULL AND callback_expires<now()
       AND (configuration_id IS NOT DISTINCT FROM $2 OR callback_expires<now()-interval '10 minutes')
       AND (callback_claim_id IS NULL OR NOT (callback_claim_id=ANY($3::text[])))`,
      [configuredOwner, provider.configurationId ?? null, [...activeCallbackClaims]],
    );
    const saved = await connectionRows(configuredOwner);
    if (saved.some((row) => row.slug === slug && protectedCallback(row) && !row.revoked))
      throw new IntegrationError(
        'This sign-in is finishing. Wait for its result before starting again.',
        409,
      );
    const active = saved.filter(
      (row) => row.slug === slug && row.account_id && !row.revoked && configurationMatches(row),
    );
    if (active.length >= 10)
      throw new IntegrationError('This service supports up to ten connected accounts.', 409);
    const nonce = randomBytes(32).toString('base64url');
    const callbackUrl = new URL('/api/apps/callback', options.baseUrl);
    callbackUrl.searchParams.set('state', nonce);
    const configurationId = provider.configurationId;
    track(slug, 'started');
    let session: IntegrationSession | undefined;
    try {
      if (!provider.authorize) session = await provider.createSession(configuredOwner, {});
      const attempt = provider.authorize
        ? await provider.authorize(configuredOwner, slug, callbackUrl.href)
        : await session!.authorize(slug, callbackUrl.href);
      const redirect = new URL(attempt.url);
      if (
        (redirect.protocol !== 'https:' && !provider.ownsConnectionUrl?.(redirect.href)) ||
        redirect.username ||
        redirect.password
      )
        throw new IntegrationError(
          'The connection provider did not return a valid sign-in link.',
          502,
        );
      const client = await pool.connect();
      let discarded: ConnectionRow[] = [];
      try {
        await client.query('BEGIN');
        const pending = await client.query<ConnectionRow>(
          `SELECT *,callback_expires<=now() AS callback_expired FROM app_connections
           WHERE owner_id=$1 AND slug=$2 AND callback_hash IS NOT NULL FOR UPDATE`,
          [configuredOwner, slug],
        );
        if (pending.rows.some(protectedCallback))
          throw new IntegrationError(
            'This sign-in is finishing. Wait for its result before starting again.',
            409,
          );
        if (replacement) {
          const current = await client.query<ConnectionRow>(
            `SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3
             AND account_id=$4 AND configuration_id IS NOT DISTINCT FROM $5 AND NOT revoked FOR UPDATE`,
            [
              replacement.id,
              configuredOwner,
              replacement.provider_id,
              replacement.account_id,
              replacement.configuration_id,
            ],
          );
          if (
            !current.rows[0] ||
            configurationMatches(current.rows[0]) ||
            current.rows[0].account_email !== replacement.account_email
          )
            throw new IntegrationError('This connected account changed. Try again.', 409);
          discarded = (
            await client.query<ConnectionRow>(
              'DELETE FROM app_connections WHERE owner_id=$1 AND replaces_connection_id=$2 AND account_id IS NULL RETURNING *',
              [configuredOwner, replacement.id],
            )
          ).rows;
        }
        await client.query(
          `INSERT INTO app_connections (owner_id,slug,pending_account_id,callback_hash,callback_expires,provider_id,callback_return_to,turn_id,setup_link_hash,callback_verifier,configuration_id,replaces_connection_id,pending_account_email)
           VALUES ($1,$2,$3,$4,now() + interval '10 minutes',$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            configuredOwner,
            slug,
            attempt.accountId,
            createHash('sha256').update(nonce).digest('hex'),
            providerId,
            returnTo,
            turn?.turnId ?? null,
            createHash('sha256').update(redirect.href).digest('hex'),
            attempt.verificationSecret ?? null,
            configurationId ?? null,
            replacement?.id ?? null,
            replacement ? normalizedEmail(replacement.account_email!) : null,
          ],
        );
        await client.query(
          'INSERT INTO app_setup_links(owner_id,link_hash,slug) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [configuredOwner, createHash('sha256').update(redirect.href).digest('hex'), slug],
        );
        if (provider.configurationId !== configurationId)
          throw new IntegrationError(
            'Your app connection changed while this was starting. Try again.',
            409,
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      for (const previous of discarded) await discardReconnect(previous);
      return {
        url: attempt.url,
        ...(returnTo === 'window' || returnTo === 'desktop' ? { attempt: nonce } : {}),
      };
    } catch (error) {
      track(slug, 'failed', connectionFailure(error));
      throw error;
    } finally {
      if (session) provider.deleteSession(session.id).catch(() => {});
    }
  }

  async function discardReconnect(row: ConnectionRow, accountId = row.pending_account_id) {
    const selected = rowProvider(row);
    if (!accountId || accountId === row.account_id || !selected) return;
    try {
      const retained = await pool.query(
        `SELECT 1 FROM app_connections WHERE owner_id=$1 AND provider_id=$2
         AND (account_id=$3 OR pending_account_id=$3) LIMIT 1`,
        [configuredOwner, row.provider_id, accountId],
      );
      if (!retained.rowCount) await selected.deleteAccount(accountId, configuredOwner);
    } catch {}
  }

  async function clearReconnect(id: string, hash: string, claimId?: string, expiredOnly = false) {
    const discarded = await pool.query<ConnectionRow>(
      `DELETE FROM app_connections WHERE id=$1 AND owner_id=$2 AND callback_hash=$3
       AND account_id IS NULL AND callback_claim_id IS NOT DISTINCT FROM $4
       AND (NOT $5::boolean OR callback_expires<=now()) RETURNING *`,
      [id, configuredOwner, hash, claimId ?? null, expiredOnly],
    );
    if (discarded.rows[0]) {
      await discardReconnect(discarded.rows[0]);
      return discarded.rows[0].pending_account_id;
    }
    const { rows } = await pool.query<ConnectionRow>(
      `WITH pending AS (
         SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND callback_hash=$3 AND account_id IS NOT NULL
         AND callback_claim_id IS NOT DISTINCT FROM $4 AND (NOT $5::boolean OR callback_expires<=now()) FOR UPDATE
       ) UPDATE app_connections c SET pending_account_id=NULL,pending_account_email=NULL,pending_auth_config_id=NULL,
       callback_hash=NULL,callback_claim_id=NULL,callback_verifier=NULL,callback_expires=NULL,setup_link_hash=NULL FROM pending
       WHERE c.id=pending.id RETURNING pending.*`,
      [id, configuredOwner, hash, claimId ?? null, expiredOnly],
    );
    if (rows[0]) await discardReconnect(rows[0]);
    return rows[0]?.pending_account_id;
  }

  async function abandonSetup(linkHash: string, reason: 'cancelled' | 'unavailable' | 'unknown') {
    const { rows } = await pool.query<ConnectionRow>(
      `SELECT * FROM app_connections WHERE owner_id=$1 AND setup_link_hash=$2
       AND callback_hash IS NOT NULL AND callback_claim_id IS NULL`,
      [configuredOwner, linkHash],
    );
    let abandoned = (await options.discovered?.abandonSetup(linkHash, reason)) ?? false;
    for (const row of rows)
      if ((await clearReconnect(row.id, row.callback_hash!)) !== undefined) {
        track(row.slug, 'failed', reason);
        abandoned = true;
      }
    return abandoned;
  }

  async function reconnect(
    slug: Slug,
    connectionId: string,
    returnTo: ReturnTarget,
    turn?: TurnRef,
  ) {
    if (slug === retiredNotionMcp) throw new IntegrationError(retiredNotionMessage, 409);
    const row = await selectConnection(configuredOwner, slug, connectionId, true);
    if (protectedCallback(row))
      throw new IntegrationError(
        'This sign-in is finishing. Wait for its result before starting again.',
        409,
      );
    if (row.callback_claim_id && row.callback_hash)
      await clearReconnect(row.id, row.callback_hash, row.callback_claim_id, true);
    if (!configurationMatches(row)) {
      if (row.revoked || !normalizedEmail(row.account_email ?? ''))
        throw new IntegrationError(unverifiedAccount, 409);
      return {
        ...(await connect(slug, returnTo, turn, row)),
        account: {
          name: row.account_name ?? undefined,
          email: normalizedEmail(row.account_email!),
        },
      };
    }
    const selected = providerForRow(row);
    if (row.revoked || !selected.configured || !selected.reconnectAccount)
      throw new IntegrationError(
        'This account cannot be reconnected. Add an account separately.',
        409,
      );
    let email = normalizedEmail(row.account_email ?? '');
    if (!email) {
      const original = await provider.inspectAccount(row.account_id!, configuredOwner);
      if (original.active && original.service === row.slug)
        email = normalizedEmail(original.accountEmail ?? '');
    }
    if (!email) throw new IntegrationError(unverifiedAccount, 409);
    const nonce = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(nonce).digest('hex');
    const callbackUrl = new URL('/api/apps/callback', options.baseUrl);
    callbackUrl.searchParams.set('state', nonce);
    const reserved = await pool.query<ConnectionRow>(
      `WITH previous AS (
         SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND NOT revoked
         AND (callback_claim_id IS NULL OR callback_expires<=now())
         AND (callback_claim_id IS NULL OR NOT (callback_claim_id=ANY($9::text[]))) FOR UPDATE
       ) UPDATE app_connections c SET pending_account_id=NULL,pending_account_email=$6,pending_auth_config_id=NULL,
       callback_hash=$5,callback_claim_id=NULL,callback_verifier=NULL,callback_expires=now()+interval '10 minutes',callback_return_to=$7,setup_link_hash=NULL,turn_id=$8
       FROM previous WHERE c.id=previous.id RETURNING previous.*`,
      [
        row.id,
        configuredOwner,
        row.provider_id,
        row.account_id,
        hash,
        email,
        returnTo,
        turn?.turnId ?? null,
        [...activeCallbackClaims],
      ],
    );
    if (!reserved.rowCount)
      throw new IntegrationError('This connected account changed. Try again.', 409);
    await discardReconnect(reserved.rows[0]);
    track(slug, 'started');
    let attemptedId: string | undefined;
    try {
      const attempt = await selected.reconnectAccount(
        configuredOwner,
        slug,
        row.account_id!,
        callbackUrl.href,
      );
      attemptedId = z.string().min(1).max(200).parse(attempt.accountId);
      const redirect = new URL(attempt.url);
      if (
        (redirect.protocol !== 'https:' && !provider.ownsConnectionUrl?.(redirect.href)) ||
        redirect.username ||
        redirect.password
      )
        throw new IntegrationError(
          'The connection provider did not return a valid sign-in link.',
          502,
        );
      const saved = await pool.query(
        `UPDATE app_connections SET pending_account_id=$6,pending_auth_config_id=$7,setup_link_hash=$8,callback_verifier=$9
           WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND callback_hash=$5 AND NOT revoked`,
        [
          row.id,
          configuredOwner,
          row.provider_id,
          row.account_id,
          hash,
          attemptedId,
          z.string().min(1).max(200).parse(attempt.authConfigId),
          createHash('sha256').update(redirect.href).digest('hex'),
          attempt.verificationSecret ?? null,
        ],
      );
      if (!saved.rowCount)
        throw new IntegrationError(
          'This connection attempt was replaced. Use the newest sign-in link.',
          409,
        );
      await pool.query(
        'INSERT INTO app_setup_links(owner_id,link_hash,slug) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [configuredOwner, createHash('sha256').update(redirect.href).digest('hex'), slug],
      );
      return {
        url: attempt.url,
        ...(returnTo === 'window' || returnTo === 'desktop' ? { attempt: nonce } : {}),
        account: { name: row.account_name ?? undefined, email },
      };
    } catch (error) {
      const cleared = await clearReconnect(row.id, hash);
      if (attemptedId && cleared !== attemptedId) await discardReconnect(row, attemptedId);
      track(slug, 'failed', connectionFailure(error));
      throw error;
    }
  }

  async function emailAccount(id: string, expected: EmailAccount, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = await selectConnection(configuredOwner, 'gmail', id);
    if (
      current.account_id !== expected.accountId ||
      current.provider_id !== expected.providerId ||
      current.configuration_id !== expected.configurationId
    )
      throw new IntegrationError('This connected account is unavailable.', 404);
    signal.throwIfAborted();
    return expected.accountId;
  }

  async function resumeWritingStyle() {
    const style = options.writingStyle;
    if (!style || closed) return;
    if (!(await style.enabled())) {
      await pool.query(
        'UPDATE app_connections SET writing_style_pending=NULL WHERE owner_id=$1 AND writing_style_pending IS NOT NULL',
        [configuredOwner],
      );
      return;
    }
    if (!style.ready()) return;
    for (const row of await connectionRows(configuredOwner)) {
      const pending = row.writing_style_pending;
      if (!pending) continue;
      stop.signal.throwIfAborted();
      const claimed = await pool.query(
        'UPDATE app_connections SET writing_style_pending=NULL WHERE id=$1 AND owner_id=$2 AND writing_style_pending=$3::jsonb RETURNING id',
        [row.id, configuredOwner, JSON.stringify(pending)],
      );
      if (!claimed.rowCount) continue;
      const selected = rowProvider(row);
      if (!selected?.sentEmails || row.slug !== 'gmail') continue;
      await style
        .learn(
          async (signal) => {
            signal.throwIfAborted();
            if (!(await style.enabled())) throw new Error('Memory saving is disabled.');
            return selected.sentEmails!(await emailAccount(row.id, pending, signal), signal);
          },
          stop.signal,
          async (signal) => {
            await emailAccount(row.id, pending, signal);
          },
        )
        .catch(() => {});
    }
  }

  async function completeConnection(
    parsed: unknown,
    pending: ConnectionRow,
    verifiedAccount?: (accountId: string) => void,
  ) {
    const row = pending;
    const { query, hash, remote } = await verifyIntegrationCompletion({
      parsed,
      provider: providerForRow(row),
      ownerId: configuredOwner,
      pending: {
        service: row.slug,
        callbackHash: row.callback_hash,
        accountId: row.pending_account_id,
        claimed: Boolean(row.callback_claim_id),
        configurationId: row.configuration_id,
        verifyOwner: Boolean(row.account_id || row.replaces_connection_id),
        ...(row.account_id || row.replaces_connection_id
          ? { originalEmail: row.pending_account_email }
          : {}),
        ...(row.account_id ? { originalAuthConfigId: row.pending_auth_config_id } : {}),
      },
      verifiedAccount,
    });
    const email: EmailAccount = {
      accountId: query.accountId,
      providerId: row.provider_id,
      configurationId: row.configuration_id,
    };
    const pendingStyle =
      row.slug === 'gmail' &&
      providerForRow(row).sentEmails &&
      (await options.writingStyle?.enabled().catch(() => false))
        ? email
        : null;
    let connectedId = row.id;
    let previousTrigger = row.trigger_id;
    await transaction(async (client) => {
      let replacement: ConnectionRow | undefined;
      if (row.replaces_connection_id) {
        replacement = (
          await client.query<ConnectionRow>(
            'SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND slug=$3 AND NOT revoked FOR UPDATE',
            [row.replaces_connection_id, configuredOwner, row.slug],
          )
        ).rows[0];
        if (
          !replacement?.account_id ||
          configurationMatches(replacement) ||
          normalizedEmail(replacement.account_email ?? '') !== row.pending_account_email
        )
          throw new IntegrationError('This connected account changed. Start sign-in again.', 409);
      }
      const claimed = await client.query<ConnectionRow>(
        `SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND callback_hash=$4
         AND callback_expires>now() AND pending_account_id=$5 AND account_id IS NOT DISTINCT FROM $6 AND callback_claim_id=$7 AND NOT revoked FOR UPDATE`,
        [
          row.id,
          configuredOwner,
          row.provider_id,
          hash,
          row.pending_account_id,
          row.account_id,
          pending.callback_claim_id,
        ],
      );
      if (!claimed.rows[0])
        throw new IntegrationError('This connection link was already used.', 409);
      previousTrigger = claimed.rows[0].trigger_id;
      if (row.setup_link_hash)
        await client.query(
          'INSERT INTO app_setup_completions (owner_id,link_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [configuredOwner, row.setup_link_hash],
        );
      const existing = await client.query<ConnectionRow>(
        'SELECT * FROM app_connections WHERE owner_id=$1 AND provider_id=$2 AND account_id=$3 AND id<>$4 FOR UPDATE',
        [configuredOwner, row.provider_id, query.accountId, row.id],
      );
      if (row.account_id || replacement) {
        const previous = replacement ?? row;
        connectedId = previous.id;
        if (existing.rows.some((item) => item.id !== connectedId))
          throw new IntegrationError('This account is already saved as another connection.', 409);
        await client.query(
          `UPDATE app_connections SET account_id=$4,pending_account_id=NULL,pending_account_email=NULL,pending_auth_config_id=NULL,
           callback_hash=NULL,callback_claim_id=NULL,callback_verifier=NULL,callback_expires=NULL,setup_link_hash=NULL,replaces_connection_id=NULL,account_active=true,account_checked_at=now(),account_name=$2,account_email=$3,
           trigger_id=NULL,triggers_enabled=false,watch_attempted=false,watch_attempted_at=NULL,watch_failures=0,watch_retry_at=NULL,
           watch_revision=watch_revision+1,inbox_cursor=NULL,inbox_poll_at=NULL,inbox_claim_id=NULL,inbox_checked_at=NULL,inbox_failed=false,inbox_reconnect_required=false,
           provider_id=$5,configuration_id=$6,turn_id=$7 WHERE id=$1 AND owner_id=$8`,
          [
            connectedId,
            remote.accountName ?? previous.account_name,
            remote.accountEmail,
            query.accountId,
            row.provider_id,
            row.configuration_id,
            row.turn_id,
            configuredOwner,
          ],
        );
        await client.query(
          `UPDATE integration_events SET state='discarded' WHERE owner_id=$1 AND state IN ('queued','processing')
           AND (poll_connection_id=$2 OR (provider_id=$3 AND account_id=$4))`,
          [configuredOwner, connectedId, previous.provider_id, previous.account_id],
        );
        if (replacement)
          await client.query('DELETE FROM app_connections WHERE id=$1 AND owner_id=$2', [
            row.id,
            configuredOwner,
          ]);
      } else if (existing.rows[0]) {
        connectedId = existing.rows[0].id;
        await client.query('DELETE FROM app_connections WHERE id=$1', [row.id]);
        await client.query(
          `UPDATE app_connections SET revoked=false,account_active=true,account_checked_at=now(),account_name=$2,account_email=$3,configuration_id=$4,
           watch_requested=true,watch_attempted=CASE WHEN trigger_id IS NULL THEN false ELSE watch_attempted END WHERE id=$1`,
          [
            connectedId,
            remote.accountName ?? null,
            remote.accountEmail ?? null,
            row.configuration_id,
          ],
        );
        if (existing.rows[0].revoked || existing.rows[0].inbox_reconnect_required) {
          await client.query(
            `UPDATE app_connections SET watch_revision=watch_revision+1,inbox_cursor=NULL,inbox_poll_at=NULL,
             inbox_claim_id=NULL,inbox_checked_at=NULL,inbox_failed=false,inbox_reconnect_required=false WHERE id=$1`,
            [connectedId],
          );
          await client.query(
            "UPDATE integration_events SET state='discarded' WHERE poll_connection_id=$1 AND owner_id=$2 AND state IN ('queued','processing')",
            [connectedId, configuredOwner],
          );
        }
      } else {
        await client.query(
          `UPDATE app_connections SET account_id=$4,pending_account_id=NULL,callback_hash=NULL,callback_claim_id=NULL,callback_verifier=NULL,setup_link_hash=NULL,
           callback_expires=NULL,revoked=false,account_active=true,account_checked_at=now(),account_name=$2,account_email=$3 WHERE id=$1`,
          [row.id, remote.accountName ?? null, remote.accountEmail ?? null, query.accountId],
        );
      }
      await client.query(
        'UPDATE app_connections SET writing_style_pending=$3::jsonb WHERE id=$1 AND owner_id=$2',
        [connectedId, configuredOwner, pendingStyle && JSON.stringify(pendingStyle)],
      );
    }, pool);
    options.refresh?.();
    const selected = providerForRow(row);
    track(row.slug, 'connected');
    if (row.account_id) {
      if (previousTrigger) await selected.unsubscribe(previousTrigger).catch(() => {});
      if (row.account_id !== query.accountId)
        await selected.deleteAccount(row.account_id).catch(() => {});
    }
    if (supportsWatch(row.slug)) await activateWatch(connectedId);
    void background(resumeWritingStyle)?.catch(() => {});
    if (row.turn_id)
      return (await options.resumeConnection?.(row.turn_id, row.slug).catch(() => false)) ?? false;
    return false;
  }

  async function disconnect(slug: Slug, connectionId: string) {
    let row = await selectConnection(configuredOwner, slug, connectionId, true);
    await transaction(async (client) => {
      await options.lockActivity?.(client);
      const current = await client.query<ConnectionRow>(
        'SELECT * FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3 FOR UPDATE',
        [row.id, configuredOwner, row.provider_id],
      );
      if (!current.rows[0])
        throw new IntegrationError('This connected account is unavailable.', 404);
      row = current.rows[0];
      await client.query(
        `UPDATE app_connections SET revoked=true,triggers_enabled=false,watch_requested=false,writing_style_pending=NULL,
         callback_hash=NULL,callback_claim_id=NULL,callback_verifier=NULL,callback_expires=NULL,setup_link_hash=NULL,pending_account_email=NULL,pending_auth_config_id=NULL,
         watch_revision=watch_revision+1,inbox_cursor=NULL,inbox_poll_at=NULL,inbox_claim_id=NULL,inbox_checked_at=NULL,inbox_failed=false,inbox_reconnect_required=false
         WHERE id=$1 AND owner_id=$2 AND provider_id=$3`,
        [row.id, configuredOwner, row.provider_id],
      );
      await client.query(
        "UPDATE integration_events SET state='discarded' WHERE poll_connection_id=$1 AND owner_id=$2 AND state IN ('queued','processing')",
        [row.id, configuredOwner],
      );
      await options.removeActivity?.(row.id, client);
    }, pool);
    if (!row.revoked) track(row.slug, 'disconnected');
    const sdk = rowProvider(row);
    if (sdk) {
      if (row.trigger_id) await sdk.unsubscribe(row.trigger_id);
      if (row.account_id) await revokeAccount(sdk, row.account_id);
      if (row.pending_account_id && row.pending_account_id !== row.account_id)
        await sdk.deleteAccount(row.pending_account_id);
    }
    await pool.query(
      'DELETE FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND revoked AND account_id=$4',
      [row.id, configuredOwner, row.provider_id, row.account_id],
    );
    return { ok: true };
  }

  async function revokeAccount(selected: IntegrationProvider, id: string) {
    const missing = (error: unknown) => (error as { status?: unknown } | undefined)?.status === 404;
    const bounded = <T>(operation: () => Promise<T>) =>
      boundedRequest(operation, new AbortController().signal);
    try {
      await bounded(() => selected.deleteAccount(id));
    } catch (error) {
      if (
        !missing(error) ||
        (await bounded(() => selected.inspectAccount(id, configuredOwner)).then(
          () => true,
          (reason: unknown) => !missing(reason),
        ))
      )
        throw error;
    }
  }

  function matchingService(action: string, services: Iterable<string>) {
    return [...services]
      .sort((left, right) => right.length - left.length)
      .find((slug) => action.startsWith(`${slug.toUpperCase()}_`));
  }

  function knownServices(rows: ConnectionRow[]) {
    return new Set([
      ...integrationServiceIds,
      ...(provider.supportedServices ?? []),
      ...(serviceCatalog?.keys() ?? []),
      ...rows.map((row) => row.slug),
    ]);
  }

  async function actionToolkit(
    ownerId: string,
    action: string,
    connectionId?: string,
    client?: PoolClient,
  ): Promise<Slug> {
    if (!/^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(action))
      throw new IntegrationError('This action is outside the connected apps.', 403);
    const rows = await connectionRows(ownerId, client);
    const selected = connectionId ? rows.find((row) => row.id === connectionId) : undefined;
    if (connectionId && !selected)
      throw new IntegrationError('This connected account is unavailable.', 404);
    const slug = matchingService(action, knownServices(rows));
    if (!slug) throw new IntegrationError('This action is outside the connected apps.', 403);
    if (slug === retiredNotionMcp) throw new IntegrationError(retiredNotionMessage, 409);
    if (selected && selected.slug !== slug)
      throw new IntegrationError('This connected account is unavailable.', 404);
    return slug;
  }

  async function selectedConnection(
    ownerId: string,
    action: string,
    args: Record<string, unknown>,
  ) {
    assertOwner(ownerId);
    const connectionId = z.string().uuid().safeParse(args.connectionId);
    if (!connectionId.success)
      throw new IntegrationError('Choose a connected account for this action.', 409);
    const slug = await actionToolkit(ownerId, action, connectionId.data);
    const row = await selectConnection(ownerId, slug, connectionId.data);
    return row;
  }

  async function workspaceBytes(
    turn: TurnRef | undefined,
    input: { workspaceFile: string; size?: number; sha256?: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!turn || !options.readWorkspaceFile)
      throw new IntegrationError('Workspace files are unavailable.', 503);
    const bytes = await options.readWorkspaceFile(turn, input.workspaceFile, fileBytes);
    if (!bytes.byteLength || bytes.byteLength > fileBytes)
      throw new IntegrationError(
        `The file must be between 1 byte and ${fileBytes / 1024 / 1024} MB.`,
      );
    if (
      input.sha256 !== undefined &&
      (bytes.byteLength !== input.size || fileDigest(bytes) !== input.sha256)
    )
      throw new IntegrationError(
        `${input.workspaceFile} changed after this action was confirmed, so nothing was written.`,
        409,
      );
    return bytes;
  }

  async function executeApproved(
    ownerId: string,
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
    expectedBinding?: string,
  ) {
    if (isLocalFilesAction(action)) {
      assertOwner(ownerId);
      signal?.throwIfAborted();
      const localFiles = options.localFiles;
      if (!localFiles) throw new IntegrationError('Local files are unavailable.', 503);
      await localFiles.assertStartedByOwner(turn);
      return withServiceAnalytics(
        options.analytics,
        { connection_method: 'local', consentRevision: options.analyticsConsent?.().revision },
        () =>
          localFiles.execute(action, args, {
            signal,
            read: (input) => workspaceBytes(turn, input, signal),
          }),
        signal,
        (result) => !(result as { failed?: unknown[] }).failed?.length,
      );
    }
    if (
      action === 'CONNECTED_HTTP' ||
      action === 'CONNECTED_MCP_CALL' ||
      action === 'CONNECTED_CLI'
    ) {
      assertOwner(ownerId);
      if (!options.discovered)
        throw new IntegrationError('Discovered connections are unavailable.', 503);
      return options.discovered.execute(action, args, turn, signal, expectedBinding);
    }
    assertOwner(ownerId);
    const connectionId = z.uuid().safeParse(args.connectionId);
    const observed = connectionId.success
      ? (await connectionRows(ownerId)).find((row) => row.id === connectionId.data)
      : undefined;
    const known = observed ?? (await selectedConnection(ownerId, action, args));
    const connection = connectionAnalytics(known.slug);
    try {
      return await withServiceAnalytics(
        options.analytics,
        connection,
        async () => {
          const row = await selectedConnection(ownerId, action, args);
          const { connectionId: _connectionId, ...providerArgs } = args;
          const result = await withAccountSession(ownerId, [row], signal, async (session) => {
            const current = await selectedConnection(ownerId, action, args);
            if (
              current.account_id !== row.account_id ||
              (expectedBinding !== undefined && (await binding(row.id)) !== expectedBinding)
            )
              throw Object.assign(new IntegrationError('The selected account changed.', 409), {
                notRun: true,
              });
            signal?.throwIfAborted();
            return session.execute(action, providerArgs, row.account_id!, signal);
          });
          return result;
        },
        signal,
      );
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (error instanceof IntegrationPermissionError)
        throw new IntegrationError(
          `${failure('The app request failed', error)} The selected ${known.slug} connection (${known.id}) lacks permissions for this action. Preserve this account and prepared work. Do not retry until permissions change. Ask before switching to browser sign-in unless the user already chose that recovery. The connection service's auth configuration must request the missing permission before reconnection can grant it; its operator may need to update it first. If the user chooses to reconnect, use manage_apps connect ${JSON.stringify({ service: known.slug, connectionId: known.id })}.`,
          403,
        );
      throw requestFailure('The app request failed', error);
    }
  }

  async function execute(
    ownerId: string,
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
    expectedBinding?: string,
  ) {
    assertOwner(ownerId);
    signal?.throwIfAborted();
    if (action === 'SEARCH_TOOLS') {
      const input = z
        .object({
          query: z.string().trim().min(1).max(1000),
          connectionId: z.string().uuid().optional(),
        })
        .strict()
        .safeParse(args);
      if (!input.success)
        return {
          status: 'rejected',
          code: 'invalid_search_arguments',
          message:
            'SEARCH_TOOLS requires a query of 1 to 1000 characters and accepts an optional UUID connectionId. No app request was sent. Correct the arguments before continuing.',
        };
      const { query, connectionId } = input.data;
      try {
        const inventory = await connectedApps(ownerId);
        if (
          connectionId &&
          !inventory.some((connection) => connection.connectionId === connectionId)
        )
          throw new IntegrationError('This connected account is unavailable.', 404);
        const ownerRows = await connectionRows(ownerId);
        const rows = ownerRows.filter(
          (row) =>
            row.account_id &&
            !row.revoked &&
            row.account_active &&
            row.slug !== retiredNotionMcp &&
            configurationMatches(row) &&
            (!connectionId || row.id === connectionId),
        );
        const services = knownServices(ownerRows);
        let tools: Record<string, unknown> = {};
        let suggestions: IntegrationSearch['suggestions'] = [];
        let searched = false;
        let failed: unknown;
        if (provider.configured && (!connectionId || rows.length)) {
          try {
            const found = await withAccountSession(ownerId, rows, signal, async (session) => {
              signal?.throwIfAborted();
              return session.search(query, signal);
            });
            tools = Object.fromEntries(
              Object.entries(found.tools as Record<string, unknown>).filter(([action]) => {
                const slug = matchingService(action, services);
                return (
                  !(slug && officialMcp.has(slug)) &&
                  slug !== retiredNotionMcp &&
                  (!connectionId || rows.some((row) => row.slug === slug))
                );
              }),
            );
            suggestions = found.suggestions.filter((suggestion) =>
              suggestion.primaryToolSlugs.every((action) => Object.hasOwn(tools, action)),
            );
            searched = true;
          } catch (error) {
            signal?.throwIfAborted();
            failed = error;
          }
        }
        const search = { tools, suggestions };
        const accounts = inventory
          .filter((connection) => !connectionId || connection.connectionId === connectionId)
          .map(({ connectionId, slug, accountName, accountEmail }) => ({
            connectionId,
            service: slug,
            accountName,
            accountEmail,
          }));
        const discovered = await options.discovered?.search(query, connectionId, signal);
        if (!searched && !discovered?.accounts.length && (failed || !options.discovered))
          throw failed ?? new Error('No app tool catalog is available.');
        if (discovered?.accounts.length) {
          Object.assign(tools, {
            CONNECTED_HTTP: {
              description: 'Call one saved HTTP API path.',
              parameters: {
                connectionId: 'Saved account ID.',
                pathId: 'Saved path ID.',
                method: 'GET, POST, PUT, PATCH or DELETE.',
                path: 'Relative API path.',
                body: 'Optional JSON request body.',
              },
            },
            CONNECTED_MCP_CALL: {
              description: 'Call one discovered MCP tool.',
              parameters: {
                connectionId: 'Saved account ID.',
                pathId: 'Saved path ID.',
                tool: 'Exact MCP tool name.',
                input: 'Exact tool arguments.',
              },
            },
            CONNECTED_CLI: {
              description: 'Run one saved CLI path with its Vault grant.',
              parameters: {
                connectionId: 'Saved account ID.',
                pathId: 'Saved path ID.',
                argv: 'CLI arguments without the program name or a token.',
                timeoutSeconds: 'Optional runtime limit in seconds.',
              },
            },
          });
        }
        const catalog = Object.entries(search.tools);
        const requested = new Set(query.toLowerCase().split(/[\s,]+/));
        const exact = catalog.filter(([name]) => requested.has(name.toLowerCase()));
        const exactMatch = exact.length === requested.size;
        const selected = exactMatch ? exact : catalog;
        const indexed = !exactMatch && selected.length > 6;
        return {
          ...search,
          ...(!exactMatch && /^[A-Z][A-Z0-9_]+$/.test(query)
            ? {
                schemaError: `No tool named ${query} was returned. Choose a returned tool name and read its schema.`,
              }
            : {}),
          tools: workspaceFileSchemas(
            Object.fromEntries(
              selected.map(([name, definition], index) => [
                name,
                !indexed || index < 3 || !definition || typeof definition !== 'object'
                  ? definition
                  : {
                      description: (definition as { description?: unknown }).description,
                      hasFullSchema: false,
                    },
              ]),
            ),
          ),
          ...(indexed
            ? {
                schemaLookup:
                  'For a tool marked hasFullSchema:false, call SEARCH_TOOLS with its exact name as query to read its full schema. Several exact names can be separated by commas.',
              }
            : {}),
          accounts,
          discovered: discovered?.accounts ?? [],
          ...(failed
            ? {
                incomplete: `Could not search ${providerId}. Matching tools may be missing; retry before concluding that no action exists.`,
              }
            : {}),
        };
      } catch (error) {
        throw requestFailure('App tool search failed', error);
      }
    }
    return executeApproved(
      ownerId,
      action,
      await prepare(ownerId, action, args, turn, signal),
      turn,
      signal,
      expectedBinding,
    );
  }

  async function prepare(
    ownerId: string,
    action: string,
    args: Record<string, unknown>,
    turn?: TurnRef,
    signal?: AbortSignal,
    pin = false,
    client?: PoolClient,
  ) {
    assertOwner(ownerId);
    signal?.throwIfAborted();
    if (isLocalFilesAction(action)) {
      if (!options.localFiles) throw new IntegrationError('Local files are unavailable.', 503);
      if (turn) await options.localFiles.assertStartedByOwner(turn);
      const prepared = (await options.localFiles.prepare(action, args)) as Record<string, unknown>;
      if (!hasWorkspaceFiles(prepared) || (!turn && !pin && pinnedWorkspaceFiles(prepared)))
        return prepared;
      return (await pinWorkspaceFiles(prepared, (input) =>
        workspaceBytes(turn, input, signal),
      )) as Record<string, unknown>;
    }
    if (['CONNECTED_HTTP', 'CONNECTED_MCP_CALL', 'CONNECTED_CLI'].includes(action)) {
      if (!options.discovered)
        throw new IntegrationError('Discovered connections are unavailable.', 503);
      await options.discovered.validate(action, args, client);
      return args;
    }
    const started = performance.now();
    const consent = options.analyticsConsent?.();
    let connection: AnalyticsConnection | undefined;
    try {
      const connectionId = z.string().uuid().optional().parse(args.connectionId);
      const slug = await actionToolkit(ownerId, action, connectionId, client);
      connection = connectionAnalytics(slug);
      connection.consentRevision = consent?.revision ?? 'disabled';
      connection.operation_phase = 'preparation';
      const row = await selectConnection(ownerId, slug, connectionId, false, client);
      if (hasWorkspaceFiles(args)) {
        const read = options.readWorkspaceFile;
        if (!turn && !pin && pinnedWorkspaceFiles(args)) return { ...args, connectionId: row.id };
        if (!turn || !read) throw new IntegrationError('Workspace file upload is unavailable.');
        let remaining = fileBytes;
        const load = async (input: { workspaceFile: string; size?: number; sha256?: string }) => {
          signal?.throwIfAborted();
          if (!remaining)
            throw new IntegrationError(
              `The app files must total between 1 byte and ${fileBytes / 1024 / 1024} MB.`,
            );
          const bytes = await read(turn, input.workspaceFile, remaining);
          if (!bytes.byteLength || bytes.byteLength > remaining)
            throw new IntegrationError(
              `The app files must total between 1 byte and ${fileBytes / 1024 / 1024} MB.`,
            );
          if (
            input.sha256 !== undefined &&
            (bytes.byteLength !== input.size || fileDigest(bytes) !== input.sha256)
          )
            throw new IntegrationError(
              `${input.workspaceFile} changed after this action was confirmed, so nothing was sent.`,
              409,
            );
          remaining -= bytes.byteLength;
          signal?.throwIfAborted();
          return bytes;
        };
        if (pin)
          return { ...((await pinWorkspaceFiles(args, load)) as object), connectionId: row.id };
        args = (await withAccountSession(ownerId, [row], signal, async (session) => {
          if (!session.upload) throw new IntegrationError('This app provider cannot upload files.');
          return uploadWorkspaceFiles(
            args,
            async (input) => ({
              name: input.name ?? basename(input.workspaceFile),
              mimeType: input.mimeType,
              bytes: await load(input),
            }),
            async (file) => {
              signal?.throwIfAborted();
              const result = await session.upload!(action, file, signal, row.account_id!);
              signal?.throwIfAborted();
              return result;
            },
          );
        })) as Record<string, unknown>;
        const current = await selectConnection(ownerId, slug, row.id);
        if (current.account_id !== row.account_id)
          throw new IntegrationError('The selected account changed.');
      }
      return { ...args, connectionId: row.id };
    } catch (error) {
      if (connection?.publicApp)
        captureServiceFailure(options.analytics, connection, error, started, signal);
      throw error;
    }
  }

  function gmailMailbox(value: string) {
    const email = normalizedEmail(value);
    if (!email) return;
    const [local, domain] = email.split('@');
    const name = local.split('+')[0];
    if (!name) return;
    const canonicalDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;
    return `${canonicalDomain === 'gmail.com' ? name.replaceAll('.', '') : name}@${canonicalDomain}`;
  }

  async function emailCode(ownerId: string, input: EmailCodeRequest, signal: AbortSignal) {
    try {
      assertOwner(ownerId);
      signal.throwIfAborted();
      const recipient = normalizedEmail(input.recipient);
      const mailbox = recipient && gmailMailbox(recipient);
      const senderDomain = verificationSenderDomain(input.origin);
      const now = Date.now();
      if (
        !provider.verificationEmails ||
        !recipient ||
        !mailbox ||
        !senderDomain ||
        !Number.isFinite(input.after) ||
        !Number.isFinite(input.before) ||
        input.after < now - 6 * 60_000 ||
        input.after > now ||
        input.before < input.after ||
        input.before > now + 30_000
      )
        return;
      const matches = (await connectionRows(ownerId)).filter(
        (row) =>
          row.slug === 'gmail' &&
          row.provider_id === providerId &&
          configurationMatches(row) &&
          row.account_id &&
          row.account_active &&
          !row.revoked &&
          gmailMailbox(row.account_email ?? '') === mailbox,
      );
      if (matches.length !== 1) return;
      const row = matches[0];
      const primaryEmail = normalizedEmail(row.account_email ?? '');
      const remote = await provider.inspectAccount(row.account_id!, ownerId);
      signal.throwIfAborted();
      if (
        !remote.active ||
        remote.service !== 'gmail' ||
        normalizedEmail(remote.accountEmail ?? '') !== primaryEmail
      )
        return;
      const current = async (database: Pick<PoolClient, 'query'> = pool) =>
        (
          await database.query(
            `SELECT id FROM app_connections WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND account_active AND NOT revoked AND lower(trim(account_email))=$5
             AND ($6::text IS NULL OR configuration_id=$6) FOR SHARE NOWAIT`,
            [
              row.id,
              ownerId,
              providerId,
              row.account_id,
              primaryEmail,
              provider.configurationId ?? null,
            ],
          )
        ).rowCount === 1;
      if (!(await current())) return;
      let before = input.before;
      let messages = await provider.verificationEmails(
        row.account_id!,
        { recipient, senderDomain, after: input.after, before },
        signal,
      );
      while (messages?.length === 0) {
        await delay(5000, undefined, { signal });
        before = Date.now();
        messages = await provider.verificationEmails(
          row.account_id!,
          { recipient, senderDomain, after: input.after, before },
          signal,
        );
      }
      signal.throwIfAborted();
      if (!messages || !(await current())) return;
      const code = verificationCode(messages, { ...input, before, recipient });
      return code
        ? {
            code,
            current: async (database?: Pick<PoolClient, 'query'>) =>
              !signal.aborted && (await current(database)),
          }
        : undefined;
    } catch {
      return;
    }
  }

  async function inboxSnippets(signal: AbortSignal) {
    const row = (await connectionRows(configuredOwner)).find(
      (item) =>
        item.slug === 'gmail' &&
        item.account_id &&
        item.account_active &&
        !item.revoked &&
        configurationMatches(item),
    );
    return row && provider.inboxSnippets ? provider.inboxSnippets(row.account_id!, signal) : [];
  }

  const activityRevision = (row: ConnectionRow) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          row.provider_id,
          row.configuration_id,
          row.slug,
          activityReader(row.slug)?.identity?.(row.account_id!, row.account_email) ??
            row.account_id,
        ]),
      )
      .digest('hex');

  async function activitySources(client?: PoolClient) {
    return (await connectionRows(configuredOwner, client))
      .filter(
        (row) =>
          row.account_id && !row.revoked && configurationMatches(row) && activityReader(row.slug),
      )
      .map((row) => {
        const reader = activityReader(row.slug)!;
        const native =
          inboxPolled(row.slug) &&
          row.watch_requested &&
          !row.inbox_failed &&
          !row.inbox_reconnect_required;
        const checked = Boolean(reader.changeToken);
        return {
          connectionId: row.id,
          account: row.account_email || row.account_name || row.slug,
          service: row.slug,
          revision: activityRevision(row),
          active: row.account_active && row.watch_requested && (!checked || !row.activity_failed),
          changeToken: checked ? (row.activity_token ?? 'initial') : undefined,
          eventDriven: Boolean(
            row.watch_requested && (checked || native || (row.triggers_enabled && row.trigger_id)),
          ),
        };
      });
  }

  function changeSignal(row: ConnectionRow) {
    return (
      row.account_id &&
      row.account_active &&
      row.watch_requested &&
      !row.revoked &&
      configurationMatches(row) &&
      ((inboxPolled(row.slug) && !row.inbox_failed && !row.inbox_reconnect_required) ||
        (activityReader(row.slug)?.changeToken && !row.activity_failed) ||
        (row.triggers_enabled && row.trigger_id))
    );
  }

  async function watchable(connectionIds: string[]) {
    const rows = await connectionRows(configuredOwner);
    return connectionIds.every((id) => rows.some((row) => row.id === id && changeSignal(row)));
  }

  async function watchState(connectionIds: string[]) {
    if (!(await watchable(connectionIds))) return null;
    await Promise.all([pollInboxes(connectionIds), pollActivityChanges(connectionIds)]);
    const rows = (await connectionRows(configuredOwner)).filter((row) =>
      connectionIds.includes(row.id),
    );
    if (rows.length !== new Set(connectionIds).size || !rows.every(changeSignal)) return null;
    const events = await pool.query<{ account_id: string; slug: string; latest: string }>(
      `SELECT account_id,slug,max(created_at)::text AS latest FROM integration_events
       WHERE owner_id=$1 AND provider_id=$2 AND account_id=ANY($3::text[]) GROUP BY 1,2`,
      [configuredOwner, providerId, rows.map((row) => row.account_id)],
    );
    return createHash('sha256')
      .update(
        JSON.stringify(
          rows
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => [
              row.id,
              row.watch_revision,
              row.inbox_cursor,
              row.activity_token,
              events.rows.find(
                (event) => event.account_id === row.account_id && event.slug === row.slug,
              )?.latest ?? null,
            ]),
        ),
      )
      .digest('hex');
  }

  async function readActivity(
    input: ObservationQuery & { connectionId: string },
    signal: AbortSignal,
  ) {
    const current = async () =>
      (await connectionRows(configuredOwner)).find(
        (row) =>
          row.id === input.connectionId &&
          row.account_id &&
          row.account_active &&
          !row.revoked &&
          configurationMatches(row),
      );
    const row = await current();
    const reader = row && activityReader(row.slug);
    if (!row || !reader) throw new Error('This connection has no supported activity reader.');
    if (input.revision !== undefined && input.revision !== activityRevision(row))
      throw Object.assign(new Error('The source changed before its read.'), { notRun: true });
    const { connectionId: _, revision: _revision, ...query } = input;
    return withServiceAnalytics(
      options.analytics,
      connectionAnalytics(row.slug),
      async () => {
        const result = await reader.read(row.account_id!, query, signal);
        signal.throwIfAborted();
        const latest = await current();
        if (
          !latest ||
          latest.account_id !== row.account_id ||
          activityRevision(latest) !== activityRevision(row)
        )
          throw new Error('The connection changed during the source check.');
        return result;
      },
      signal,
    );
  }

  function pollActivityChanges(only?: string[]): Promise<void> {
    const services = Object.entries(provider.activity ?? {})
      .filter(([, reader]) => reader.changeToken)
      .map(([service]) => service);
    if (closed || !provider.configured || !services.length) return Promise.resolve();
    if (activityPolling)
      return only ? activityPolling.then(() => pollActivityChanges(only)) : activityPolling;
    activityPolling = (async () => {
      const { rows } = await pool.query<ConnectionRow>(
        `WITH due AS (SELECT id FROM app_connections WHERE owner_id=$1 AND provider_id=$2 AND slug=ANY($3::text[])
        AND watch_requested AND account_active AND NOT revoked AND account_id IS NOT NULL
        AND ($4::text IS NULL OR configuration_id=$4)
        AND ($6::uuid[] IS NULL AND (activity_poll_at IS NULL OR activity_poll_at<=now()) OR id=ANY($6::uuid[]))
        ORDER BY activity_poll_at NULLS FIRST LIMIT CASE WHEN $6::uuid[] IS NULL THEN 4 END FOR UPDATE SKIP LOCKED)
        UPDATE app_connections c SET activity_poll_at=now()+interval '30 minutes',activity_claim_id=$5
        FROM due WHERE c.id=due.id RETURNING c.*`,
        [
          configuredOwner,
          providerId,
          services,
          provider.configurationId ?? null,
          randomBytes(16).toString('hex'),
          only ?? null,
        ],
      );
      await Promise.all(
        rows.map(async (row) => {
          const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]);
          let onAbort = () => {};
          try {
            const token = z
              .string()
              .min(1)
              .max(2048)
              .parse(
                await Promise.race([
                  activityReader(row.slug)!.changeToken!(row.account_id!, signal),
                  new Promise<never>((_, reject) => {
                    onAbort = () => reject(signal.reason);
                    signal.addEventListener('abort', onAbort, { once: true });
                    if (signal.aborted) onAbort();
                  }),
                ]),
              );
            signal.throwIfAborted();
            await pool.query(
              `UPDATE app_connections SET activity_token=$1,activity_failed=false WHERE id=$2 AND owner_id=$3 AND provider_id=$4
            AND account_id=$5 AND watch_revision=$6 AND activity_claim_id=$7 AND watch_requested AND account_active AND NOT revoked
            AND configuration_id IS NOT DISTINCT FROM $8`,
              [
                token,
                row.id,
                configuredOwner,
                providerId,
                row.account_id,
                row.watch_revision,
                row.activity_claim_id,
                row.configuration_id,
              ],
            );
          } catch {
            await pool.query(
              `UPDATE app_connections SET activity_failed=true,activity_poll_at=now()+interval '5 minutes' WHERE id=$1 AND owner_id=$2
            AND provider_id=$3 AND account_id=$4 AND watch_revision=$5 AND activity_claim_id=$6
            AND configuration_id IS NOT DISTINCT FROM $7 AND watch_requested AND account_active AND NOT revoked`,
              [
                row.id,
                configuredOwner,
                providerId,
                row.account_id,
                row.watch_revision,
                row.activity_claim_id,
                row.configuration_id,
              ],
            );
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
        }),
      );
    })().finally(() => {
      activityPolling = undefined;
    });
    return activityPolling;
  }

  function pollInboxes(only?: string[]): Promise<void> {
    if (closed || !provider.configured || !provider.pollInbox) return Promise.resolve();
    if (polling) return only ? polling.then(() => pollInboxes(only)) : polling;
    polling = (async () => {
      if (!only && (await options.paused?.())) return;
      const { rows } = await pool.query<ConnectionRow>(
        `WITH due AS (SELECT id FROM app_connections WHERE owner_id=$1 AND provider_id=$2 AND slug='gmail'
         AND watch_requested AND account_active AND NOT revoked AND NOT inbox_reconnect_required AND account_id IS NOT NULL
         AND ($4::text IS NULL OR configuration_id=$4)
         AND ($5::uuid[] IS NULL AND (inbox_poll_at IS NULL OR inbox_poll_at<=now()) OR id=ANY($5::uuid[]))
         ORDER BY inbox_poll_at NULLS FIRST LIMIT CASE WHEN $5::uuid[] IS NULL THEN 4 END FOR UPDATE SKIP LOCKED)
         UPDATE app_connections c SET inbox_poll_at=now()+interval '15 minutes',inbox_claim_id=$3
         FROM due WHERE c.id=due.id RETURNING c.*`,
        [
          configuredOwner,
          providerId,
          randomBytes(16).toString('hex'),
          provider.configurationId ?? null,
          only ?? null,
        ],
      );
      await Promise.all(
        rows.map(async (row) => {
          let client: PoolClient | undefined;
          const pollDeadline = AbortSignal.timeout(30_000);
          const pollSignal = AbortSignal.any([stop.signal, pollDeadline]);
          let pollFinished = false;
          try {
            const result = await provider.pollInbox!(row.account_id!, row.inbox_cursor, pollSignal);
            pollSignal.throwIfAborted();
            pollFinished = true;
            const overviews = await Promise.all(
              result.messages.map((message) =>
                eventOverview(
                  'gmail',
                  'inbox',
                  {
                    message_id: message.id,
                    thread_id: message.threadId,
                    subject: message.subject,
                    sender: message.sender,
                    timestamp: message.receivedAt,
                  },
                  mailCheck,
                  stop.signal,
                ),
              ),
            );
            stop.signal.throwIfAborted();
            client = await pool.connect();
            await client.query('BEGIN');
            const saved = await client.query(
              `UPDATE app_connections SET inbox_cursor=$1,inbox_checked_at=now(),inbox_failed=false,
             inbox_poll_at=CASE WHEN $2 THEN now()+$10::integer * interval '1 millisecond' ELSE inbox_poll_at END
             WHERE id=$3 AND owner_id=$4 AND provider_id=$5 AND account_id=$6 AND watch_revision=$7 AND inbox_claim_id=$8
             AND watch_requested AND account_active AND NOT revoked
             AND ($9::text IS NULL OR configuration_id=$9) RETURNING id`,
              [
                result.cursor,
                result.hasMore,
                row.id,
                configuredOwner,
                providerId,
                row.account_id,
                row.watch_revision,
                row.inbox_claim_id,
                provider.configurationId ?? null,
                Number.isSafeInteger(result.retryAfterMs) && (result.retryAfterMs ?? 0) > 0
                  ? Math.min(result.retryAfterMs!, 300_000)
                  : 0,
              ],
            );
            if (saved.rowCount) {
              for (const [index, message] of result.messages.entries()) {
                const summary = `Source connectionId: ${row.id}.\n${overviews[index]}`;
                await client.query(
                  `INSERT INTO integration_events (id,owner_id,summary,slug,account_id,provider_id,poll_connection_id)
                 VALUES ($1,$2,$3,'gmail',$4,$5,$6) ON CONFLICT(id) DO UPDATE SET poll_connection_id=EXCLUDED.poll_connection_id,
                 state=CASE WHEN integration_events.state='discarded' THEN 'queued' ELSE integration_events.state END
                 WHERE integration_events.owner_id=EXCLUDED.owner_id AND integration_events.provider_id=EXCLUDED.provider_id
                 AND integration_events.account_id=EXCLUDED.account_id AND integration_events.state<>'delivered'`,
                  [
                    `${providerId}:gmail:${row.account_id}:${message.id}`,
                    configuredOwner,
                    summary,
                    row.account_id,
                    providerId,
                    row.id,
                  ],
                );
              }
            }
            await client.query('COMMIT');
            if (saved.rowCount) options.refresh?.();
          } catch (error) {
            if (client) await client.query('ROLLBACK');
            if (stop.signal.aborted) {
              await (client ?? pool).query(
                `UPDATE app_connections SET inbox_poll_at=now(),inbox_claim_id=NULL
                 WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND watch_revision=$5 AND inbox_claim_id=$6`,
                [
                  row.id,
                  configuredOwner,
                  providerId,
                  row.account_id,
                  row.watch_revision,
                  row.inbox_claim_id,
                ],
              );
              return;
            }
            const retryAfterMs =
              error instanceof IntegrationInboxTransientError
                ? error.retryAfterMs
                : !pollFinished && pollDeadline.aborted
                  ? 60_000
                  : null;
            await (client ?? pool).query(
              `WITH failed AS (UPDATE app_connections SET inbox_failed=true,inbox_reconnect_required=$7,
               inbox_poll_at=CASE WHEN $11::integer IS NULL THEN inbox_poll_at ELSE now()+$11::integer * interval '1 millisecond' END
               WHERE id=$1 AND owner_id=$2 AND provider_id=$3 AND account_id=$4 AND watch_revision=$5 AND inbox_claim_id=$6
               AND watch_requested AND account_active AND NOT revoked
               AND ($10::text IS NULL OR configuration_id=$10) RETURNING id)
               INSERT INTO integration_events (id,owner_id,summary,slug,account_id,provider_id,poll_connection_id)
               SELECT $8,$2,$9,'gmail',$4,$3,id FROM failed WHERE $7 ON CONFLICT(id) DO NOTHING`,
              [
                row.id,
                configuredOwner,
                providerId,
                row.account_id,
                row.watch_revision,
                row.inbox_claim_id,
                error instanceof IntegrationInboxCursorExpired,
                `${providerId}:inbox-expired:${row.id}:${row.watch_revision}`,
                `Gmail inbox updates need reconnection because the saved history expired. Reconnect this account to resume future updates; the missing interval still needs a separate inbox review. Source connectionId: ${row.id}.`,
                provider.configurationId ?? null,
                retryAfterMs,
              ],
            );
            options.refresh?.();
          } finally {
            client?.release();
          }
        }),
      );
    })().finally(() => {
      polling = undefined;
    });
    return polling;
  }

  async function drain() {
    if (draining || !provider.configured) return;
    draining = true;
    const matchingConnection = `c.owner_id=e.owner_id AND c.slug=e.slug
      AND c.account_id=e.account_id AND c.provider_id=e.provider_id AND NOT c.revoked AND (
        (e.poll_connection_id IS NULL AND c.trigger_id=e.trigger_id AND c.triggers_enabled) OR
        (e.poll_connection_id=c.id AND c.watch_requested AND c.account_active))`;
    const currentConnection = `SELECT 1 FROM app_connections c WHERE ${matchingConnection}
      AND ($3::text IS NULL OR c.configuration_id=$3)`;
    const scope = [providerId, configuredOwner, provider.configurationId ?? null];
    try {
      await pool.query(
        `UPDATE integration_events e SET state = 'discarded' WHERE provider_id=$1 AND e.owner_id=$2
         AND state IN ('queued','processing') AND NOT EXISTS (${currentConnection})
         AND NOT EXISTS (SELECT 1 FROM app_connections c WHERE c.owner_id=e.owner_id
           AND c.provider_id=e.provider_id AND c.account_id=e.account_id
           AND $3::text IS NOT NULL AND c.configuration_id IS DISTINCT FROM $3)`,
        scope,
      );
      let delivered = false;
      for (let count = 0; count < 20; count++) {
        const { rows } = await pool.query<{
          id: string;
          summary: string;
          claim: string;
        }>(
          `WITH next AS (SELECT e.id FROM integration_events e WHERE e.provider_id=$1 AND e.owner_id=$2 AND (e.state = 'queued' OR
           (e.state = 'processing' AND e.claimed_at < now() - interval '5 minutes')) AND EXISTS (${currentConnection})
           ORDER BY e.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           UPDATE integration_events e SET state = 'processing', claimed_at = now() FROM next WHERE e.id = next.id
           RETURNING e.id,e.summary,e.claimed_at::text AS claim`,
          scope,
        );
        const event = rows[0];
        if (!event) break;
        const current = async (client?: PoolClient) =>
          Boolean(
            (
              await (client ?? pool).query(
                `SELECT e.id FROM integration_events e JOIN app_connections c ON ${matchingConnection}
                 WHERE e.provider_id=$1 AND e.owner_id=$2 AND ($3::text IS NULL OR c.configuration_id=$3)
                 AND e.id=$4 AND e.state='processing' AND e.claimed_at=$5::timestamptz
                 ${client ? 'FOR SHARE OF c,e' : ''}`,
                [...scope, event.id, event.claim],
              )
            ).rowCount,
          );
        try {
          if (!(await current())) continue;
          const connectionId = (
            await pool.query<{ id: string }>(
              `SELECT c.id FROM integration_events e JOIN app_connections c ON ${matchingConnection}
             WHERE e.id=$4 AND e.provider_id=$1 AND e.owner_id=$2 AND ($3::text IS NULL OR c.configuration_id=$3) LIMIT 1`,
              [...scope, event.id],
            )
          ).rows[0]?.id;
          await options.wake(event.summary, event.id, current, connectionId);
          await pool.query(
            `UPDATE integration_events e SET state='delivered' WHERE e.provider_id=$1 AND e.owner_id=$2 AND e.id=$4
             AND e.state='processing' AND e.claimed_at=$5::timestamptz AND EXISTS (${currentConnection})`,
            [...scope, event.id, event.claim],
          );
          delivered = true;
        } catch {
          await pool.query(
            `UPDATE integration_events e SET state='queued' WHERE e.provider_id=$1 AND e.owner_id=$2 AND e.id=$4
             AND e.state='processing' AND e.claimed_at=$5::timestamptz AND EXISTS (${currentConnection})`,
            [...scope, event.id, event.claim],
          );
          break;
        }
      }
      if (delivered)
        await options.settle?.().catch((error: unknown) => logFailure('proactive_due', error));
    } finally {
      draining = false;
    }
  }
  const timer = setInterval(() => {
    void background(drain)?.catch(() => {});
    void background(syncWatches)?.catch(() => {});
    void background(() => pollInboxes())?.catch(() => {});
    void background(() => pollActivityChanges())?.catch(() => {});
  }, 5000);
  timer.unref();

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', async () => {
      closed = true;
      clearInterval(timer);
      stop.abort();
      await Promise.all([refreshing, polling, activityPolling]);
    });
    app.register(async (scope) => {
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof IntegrationError ||
          error instanceof IntegrationCatalogFailure ||
          error instanceof IntegrationConnectionError ||
          error instanceof DiscoveredConnectionError ||
          error instanceof BrowserConnectionError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : 502;
        if (
          status === 502 &&
          !(error instanceof IntegrationError || error instanceof IntegrationCatalogFailure)
        )
          logFailure('connection_failed', error);
        reply.code(status).send({
          error:
            error instanceof IntegrationError ||
            error instanceof IntegrationCatalogFailure ||
            error instanceof IntegrationConnectionError ||
            error instanceof DiscoveredConnectionError ||
            error instanceof BrowserConnectionError
              ? error.message
              : status === 400
                ? 'Check the connection request.'
                : 'The connection provider could not complete this request.',
        });
      });
      scope.get('/api/apps', async () =>
        (await list()).filter(
          (connection) => !connection.accessPaths?.some((path) => path.kind === 'browser'),
        ),
      );
      scope.get('/api/apps/catalog', async () => catalog());
      scope.post('/api/apps/setup-status', async (request, reply) => {
        const { hashes, connectionIds, pairingUrl } = z
          .object({
            hashes: z
              .array(z.string().regex(/^[a-f0-9]{64}$/))
              .min(1)
              .max(100),
            connectionIds: z.array(z.uuid()).max(100).default([]),
            pairingUrl: z.string().url().max(16_000).optional(),
          })
          .strict()
          .parse(request.body);
        const [links, discovered] = await Promise.all([
          pool.query<{
            hash: string;
            slug: string;
            completed: boolean;
            available: boolean;
            provider_id: string;
            configuration_id: string | null;
          }>(
            `SELECT link_hash AS hash,'' AS slug,true AS completed,false AS available,NULL AS provider_id,NULL AS configuration_id FROM app_setup_completions
             WHERE owner_id=$1 AND link_hash=ANY($2::text[])
             UNION ALL
             SELECT l.link_hash AS hash,l.slug,false AS completed,
               coalesce(c.callback_expires>now() AND NOT c.revoked,false) AS available,c.provider_id,c.configuration_id
             FROM app_setup_links l LEFT JOIN app_connections c ON c.owner_id=l.owner_id AND c.setup_link_hash=l.link_hash
             WHERE l.owner_id=$1 AND l.link_hash=ANY($2::text[])
               AND NOT EXISTS(SELECT 1 FROM app_setup_completions done WHERE done.owner_id=l.owner_id AND done.link_hash=l.link_hash)`,
            [configuredOwner, hashes],
          ),
          options.discovered?.setupServices(connectionIds, hashes) ?? [],
        ]);
        const pairingHash = pairingUrl
          ? createHash('sha256').update(pairingUrl).digest('hex')
          : undefined;
        const pendingPairing = links.rows.find(
          (row) => row.available && row.hash === pairingHash && configurationMatches(row),
        );
        if (
          pairingUrl &&
          pendingPairing &&
          provider.ownsConnectionUrl &&
          !provider.ownsConnectionUrl(pairingUrl) &&
          (await abandonSetup(pendingPairing.hash, 'unavailable'))
        )
          pendingPairing.available = false;
        const connectionStatus =
          pairingUrl && pendingPairing?.available
            ? await provider.connectionStatus?.(configuredOwner, pairingUrl).catch(() => undefined)
            : undefined;
        const discoveredLinks = discovered.flatMap(
          ({ id, link_hash, available, expired, ...service }) => {
            const proposalHash = createHash('sha256').update(`/apps?connect=${id}`).digest('hex');
            return [
              ...(link_hash && hashes.includes(link_hash)
                ? [{ ...service, hash: link_hash, available }]
                : []),
              ...(hashes.includes(proposalHash)
                ? [{ ...service, hash: proposalHash, ...(expired ? { available: false } : {}) }]
                : []),
            ];
          },
        );
        const apps = [...links.rows, ...discoveredLinks]
          .filter((link) => !link.completed)
          .filter(({ hash }) => hashes.includes(hash))
          .map((row) => {
            const info = serviceInfo(row.slug);
            return {
              hash: row.hash,
              slug: row.slug,
              name: 'name' in row && typeof row.name === 'string' ? row.name : info.name,
              ...('available' in row ? { available: row.available } : {}),
              ...(info.logoUrl ? { logoUrl: info.logoUrl } : {}),
              ...(connectionStatus?.pairingConfirmed && row.hash === pairingHash
                ? { pairingConfirmed: true }
                : {}),
            };
          });
        return reply.header('Cache-Control', 'no-store').send({
          completed: [
            ...links.rows.filter((row) => row.completed).map((row) => row.hash),
            ...discoveredLinks
              .filter((link) => link.completed && hashes.includes(link.hash))
              .map((link) => link.hash),
          ],
          apps,
        } satisfies AppSetupStatus);
      });
      scope.get<{ Params: { id: string } }>('/api/apps/:id/icon', async (request, reply) => {
        const value = await icon(request.params.id);
        if (!value) return reply.code(404).send({ error: 'The app icon is unavailable.' });
        return reply
          .header('Content-Type', value.mimeType)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .header('Cache-Control', 'private, max-age=300')
          .header('Referrer-Policy', 'no-referrer')
          .send(Buffer.from(value.bytes));
      });
      options.discovered?.registerRoutes(scope);
      scope.post('/api/apps/setup-return', async (request, reply) => {
        const { hash, returnTo } = z
          .object({ hash: z.string().regex(/^[a-f0-9]{64}$/), returnTo: z.literal('desktop') })
          .strict()
          .parse(request.body);
        const changed = await pool.query(
          `UPDATE app_connections SET callback_return_to=$3
           WHERE owner_id=$1 AND setup_link_hash=$2 AND callback_hash IS NOT NULL
           AND callback_claim_id IS NULL AND callback_expires>now() AND NOT revoked RETURNING id`,
          [configuredOwner, hash, returnTo],
        );
        if (!changed.rowCount)
          throw new IntegrationError('This sign-in link is no longer available.', 409);
        return reply.header('Cache-Control', 'no-store').send({ ok: true });
      });
      scope.post('/api/apps/setup-cancel', async (request, reply) => {
        const { hash } = z
          .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(request.body);
        await abandonSetup(hash, 'cancelled');
        return reply.header('Cache-Control', 'no-store').send({ ok: true });
      });
      scope.post<{ Params: { slug: string } }>('/api/apps/:slug/connect', async (request) => {
        const input = z
          .object({
            returnTo: z.enum(['apps', 'onboarding', 'window', 'desktop']).default('apps'),
            connectionId: z.uuid().optional(),
            newAccount: z.boolean().optional(),
            restartAttempt: z
              .string()
              .regex(/^[A-Za-z0-9_-]{43}$/)
              .optional(),
          })
          .strict()
          .parse(request.body ?? {});
        const service = request.params.slug === retiredNotionMcp ? 'notion' : request.params.slug;
        if (request.params.slug === retiredNotionMcp && input.connectionId)
          throw new IntegrationError(retiredNotionMessage, 409);
        if (officialMcp.has(service)) {
          if (!options.discovered)
            throw new IntegrationError('Discovered connections are unavailable.', 503);
          const selected = (await options.discovered.list()).find(
            (entry) => entry.connectionId === input.connectionId && entry.slug === service,
          );
          if (input.restartAttempt && input.connectionId && !selected)
            throw new IntegrationError(
              'This sign-in changed. Use the newest window or try again.',
              409,
            );
          if (input.connectionId && !selected)
            throw new IntegrationError('This connected account is unavailable.', 404);
          return options.discovered.authorize(
            service,
            selected?.status === 'disconnected' && !input.newAccount
              ? input.connectionId
              : undefined,
            input.returnTo,
            input.restartAttempt,
          );
        }
        const discovered = input.connectionId
          ? (await options.discovered?.list())?.some(
              (entry) =>
                entry.connectionId === input.connectionId && entry.slug === request.params.slug,
            )
          : !supportsService(request.params.slug) &&
            (await options.discovered?.list())?.some((entry) => entry.slug === request.params.slug);
        if (discovered)
          return (
            options.discovered?.reconnect(
              request.params.slug,
              input.connectionId,
              input.returnTo,
              input.newAccount,
            ) ?? Promise.reject(new IntegrationError('This service is unavailable.', 404))
          );
        if (input.connectionId && input.newAccount)
          throw new IntegrationError('An additional account cannot replace a saved account.', 400);
        if (input.restartAttempt) {
          const hash = createHash('sha256').update(input.restartAttempt).digest('hex');
          const previous = (await connectionRows(configuredOwner)).find(
            (row) => row.slug === request.params.slug && row.callback_hash === hash,
          );
          if (
            !previous ||
            protectedCallback(previous) ||
            (previous.account_id
              ? previous.id !== input.connectionId
              : Boolean(input.connectionId)) ||
            (await clearReconnect(
              previous.id,
              hash,
              previous.callback_claim_id ?? undefined,
              Boolean(previous.callback_claim_id),
            )) === undefined
          )
            throw new IntegrationError(
              'This sign-in is finishing or has ended. Wait for its result before starting again.',
              409,
            );
        }
        if (input.connectionId)
          return reconnect(
            slugSchema.parse(request.params.slug),
            input.connectionId,
            input.returnTo,
          );
        return connect(slugSchema.parse(request.params.slug), input.returnTo);
      });
      const callback = async (request: FastifyRequest, reply: FastifyReply) => {
        let returnTo: ReturnTarget = 'apps';
        let outcome: 'connected' | 'continued' | 'cancelled' | 'failed' | 'expired' = 'expired';
        let service: string | undefined;
        let attempt: string | undefined;
        const state = z
          .object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .safeParse(request.query);
        if (state.success) {
          const hash = createHash('sha256').update(state.data.state).digest('hex');
          const row = (
            await pool.query<ConnectionRow>(
              'SELECT * FROM app_connections WHERE owner_id=$1 AND callback_hash=$2',
              [configuredOwner, hash],
            )
          ).rows[0];
          if (row) {
            attempt = state.data.state;
            service = row.slug;
            returnTo = Object.hasOwn(returnPaths, row.callback_return_to)
              ? row.callback_return_to
              : 'apps';
            if (!configurationMatches(row)) {
              outcome = 'failed';
              const pending = await clearReconnect(
                row.id,
                hash,
                row.callback_claim_id ?? undefined,
              );
              const previous = rowProvider(row);
              if (pending && previous)
                try {
                  const result = await previous.parseCallback(request.query, {
                    accountId: pending,
                    verificationSecret: row.callback_verifier,
                    service: row.slug,
                  });
                  if (result.success && result.accountId !== pending)
                    await discardReconnect(row, result.accountId);
                } catch {}
            } else if (
              row.callback_expires &&
              new Date(row.callback_expires).getTime() > Date.now()
            ) {
              const claimId = randomBytes(32).toString('base64url');
              const claimed = (
                await pool.query<ConnectionRow>(
                  `UPDATE app_connections SET callback_claim_id=$4 WHERE id=$1 AND owner_id=$2
                   AND callback_hash=$3 AND callback_claim_id IS NULL AND callback_expires>now() AND NOT revoked RETURNING *`,
                  [row.id, configuredOwner, hash, claimId],
                )
              ).rows[0];
              if (claimed) {
                activeCallbackClaims.add(claimId);
                returnTo = Object.hasOwn(returnPaths, claimed.callback_return_to)
                  ? claimed.callback_return_to
                  : 'apps';
                let verifiedAccountId: string | undefined;
                try {
                  const result = await providerForRow(claimed).parseCallback(request.query, {
                    accountId: claimed.pending_account_id ?? '',
                    verificationSecret: claimed.callback_verifier,
                    service: claimed.slug,
                  });
                  if (!result.success) {
                    outcome = 'cancelled';
                    await clearReconnect(claimed.id, hash, claimId);
                    track(claimed.slug, 'failed', 'cancelled');
                  } else {
                    const resumed = await completeConnection(result, claimed, (id) => {
                      verifiedAccountId = id;
                    });
                    outcome = resumed ? 'continued' : 'connected';
                  }
                } catch {
                  outcome = 'failed';
                  track(claimed.slug, 'failed', 'verification_failed');
                  await clearReconnect(claimed.id, hash, claimId);
                  if (verifiedAccountId) await discardReconnect(claimed, verifiedAccountId);
                } finally {
                  activeCallbackClaims.delete(claimId);
                }
              }
            } else if (!row.callback_claim_id) await clearReconnect(row.id, hash);
          } else if (options.discovered) {
            const result = await options.discovered
              .completeOAuth(request.query)
              .catch(() => undefined);
            if (result) {
              service = result.service;
              outcome = result.outcome;
              returnTo = result.returnTo;
              attempt = result.attempt;
            }
          }
        }
        const destination = options.callbackReturnTo ? 'desktop' : returnTo;
        const completionPage = destination === 'window' || destination === 'desktop';
        return reply
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer')
          .redirect(
            new URL(
              `${returnPaths[destination]}?connection=${outcome}${(destination === 'chat' || completionPage) && service ? `&service=${service}` : ''}${completionPage && service ? `&serviceName=${encodeURIComponent(serviceInfo(service).name)}` : ''}${completionPage && attempt ? `&attempt=${attempt}` : ''}${destination === 'desktop' ? '&desktop=1' : ''}`,
              options.baseUrl,
            ).href,
          );
      };
      scope.get('/api/apps/callback', callback);
      scope.post<{ Params: { slug: string; connectionId: string } }>(
        '/api/apps/:slug/accounts/:connectionId/disconnect',
        async (request) => {
          const id = z.uuid().parse(request.params.connectionId);
          if (
            (await options.discovered?.list())?.some(
              (entry) => entry.connectionId === id && entry.slug === request.params.slug,
            )
          )
            return options.discovered!.disconnect(id, request.params.slug);
          return disconnect(slugSchema.parse(request.params.slug), id);
        },
      );
    });
    app.register(async (scope) => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: 262_144 },
        (_request, body, done) => done(null, body),
      );
      scope.post(`/api/webhooks/${providerId}`, async (request, reply) => {
        if (!provider.webhooksConfigured)
          return reply.code(503).send({ error: 'Connection webhooks are not configured.' });
        let event;
        try {
          event = await provider.verifyWebhook(request.body, request.headers);
        } catch {
          return reply.code(401).send({ error: 'Invalid webhook signature or payload.' });
        }
        const slug = slugSchema.safeParse(event.service);
        if (!slug.success || event.ownerId !== configuredOwner)
          return reply.code(202).send({ ok: true });
        const row = (await connectionRows(configuredOwner)).find(
          (item) => item.slug === slug.data && item.account_id === event.accountId,
        );
        if (
          !row ||
          row.provider_id !== providerId ||
          !configurationMatches(row) ||
          row.revoked ||
          !row.triggers_enabled ||
          row.trigger_id !== event.subscriptionId ||
          row.account_id !== event.accountId ||
          !provider.matchesSubscription(slug.data, event.trigger)
        ) {
          return reply.code(202).send({ ok: true });
        }
        if (!event.id || event.id.length > 200)
          return reply.code(400).send({ error: 'The webhook event has no valid identity.' });
        const messageId = slug.data === 'gmail' && messageIdentity(event.data, 'message');
        const summary = `Source connectionId: ${row.id}.\n${
          (await options.paused?.())
            ? `Connected-app event from ${slug.data}; trigger ${event.trigger}. Read the source for its current state.`
            : await eventOverview(slug.data, event.trigger, event.data, mailCheck)
        }`;
        await pool.query(
          'INSERT INTO integration_events (id,owner_id,summary,slug,account_id,trigger_id,provider_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
          [
            messageId
              ? `${providerId}:gmail:${row.account_id}:${messageId}`
              : `${providerId}:${event.id}`,
            configuredOwner,
            summary,
            slug.data,
            row.account_id,
            row.trigger_id,
            providerId,
          ],
        );
        void background(drain)?.catch(() => {});
        return reply.code(202).send({ ok: true });
      });
    });
  }

  return {
    registerRoutes,
    abandonSetup,
    resumeWritingStyle,
    binding,
    activitySources,
    readActivity,
    watchable,
    watchState,
    execute,
    executeApproved,
    prepare,
    emailCode,
    inboxSnippets,
    list,
    catalog,
    connectedApps,
    analyticsConnections,
    manageConnections: async (
      action: 'list' | 'connect' | 'propose' | 'discover',
      service?: string,
      turn?: TurnRef,
      proposal?: unknown,
      newAccount?: boolean,
      query?: string,
      connectionId?: string,
    ) => {
      if (connectionId !== undefined && (action !== 'connect' || newAccount === true))
        throw new IntegrationError(
          'A saved account can only be selected for reconnecting, without requesting an additional account.',
          400,
        );
      if (newAccount !== undefined && action !== 'connect')
        throw new IntegrationError(
          'Additional accounts can only be requested when connecting.',
          400,
        );
      if (action === 'discover') {
        const search = z.string().trim().max(200).optional().parse(query) ?? '';
        const words = search.toLowerCase().split(/\s+/).filter(Boolean);
        const [services, connections] = await Promise.all([
          catalog(),
          list(configuredOwner, { refresh: false }),
        ]);
        const matches = services.filter((entry) => {
          const text =
            `${entry.slug} ${entry.name} ${entry.description ?? ''} ${entry.categories?.join(' ') ?? ''}`.toLowerCase();
          return words.every((word) => text.includes(word));
        });
        return {
          services: matches
            .slice(0, 30)
            .map(({ slug, name, description, logoUrl, categories }) => ({
              slug,
              name,
              description,
              ...(logoUrl ? { logoUrl } : {}),
              ...(categories?.length ? { categories } : {}),
              connections: connections
                .filter(
                  (connection) =>
                    connection.slug === slug && connection.connectionId && !connection.savedLogin,
                )
                .map(
                  ({
                    connectionId,
                    status,
                    accountName,
                    accountEmail,
                    reconnectRequired,
                    canReconnect,
                    disconnectPending,
                  }) => ({
                    connectionId,
                    status,
                    accountName,
                    accountEmail,
                    reconnectRequired,
                    canReconnect,
                    disconnectPending,
                  }),
                ),
            })),
          total: matches.length,
          hasMore: matches.length > 30,
        };
      }
      if (action === 'list') {
        const site = (z.string().trim().max(200).optional().parse(query) ?? '')
          .toLowerCase()
          .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
          .replace(/^www\./, '')
          .split('/')[0]!;
        const connections = (await list())
          .filter(
            (connection) =>
              !connection.accessPaths?.some((path) => path.kind === 'browser') ||
              !connection.browserState ||
              ['saved', 'needs_sign_in', 'pending'].includes(connection.browserState),
          )
          .map(({ accountId: _accountId, browserUrl: _browserUrl, ...connection }) => ({
            ...connection,
            ...(connection.browserState ? { browserAccess: 'browser_session' } : {}),
          }));
        const logins = connections.filter((connection) => connection.savedLogin);
        const matching = site
          ? logins.filter((connection) => {
              const origin = connection.accessPaths?.[0]?.endpoint;
              if (site.includes('.') || site.includes(':')) {
                try {
                  return new URL(origin!).host.toLowerCase().replace(/^www\./, '') === site;
                } catch {
                  return false;
                }
              }
              return ` ${[connection.name, connection.accountName]
                .join(' ')
                .toLowerCase()
                .replace(/[^\p{L}\p{N}]+/gu, ' ')} `.includes(` ${site} `);
            })
          : logins.slice(0, 20);
        return [
          ...connections.filter((connection) => !connection.savedLogin),
          ...matching,
          ...(matching.length < logins.length && !site
            ? [
                {
                  savedLogins: logins.length,
                  note: 'Call list with query set to the website or service to see its saved logins.',
                },
              ]
            : []),
        ];
      }
      if (action === 'propose') {
        if (!options.discovered)
          throw new IntegrationError('Discovered connections are unavailable.', 503);
        return options.discovered.propose(proposal, turn);
      }
      const slug = slugSchema.parse(service === retiredNotionMcp ? 'notion' : service);
      if (service === retiredNotionMcp && connectionId)
        throw new IntegrationError(retiredNotionMessage, 409);
      if (officialMcp.has(slug)) {
        if (!options.discovered)
          throw new IntegrationError('Discovered connections are unavailable.', 503);
        const accounts = (await options.discovered.list())
          .filter((entry) => entry.slug === slug)
          .map(({ connectionId, accountName }) => ({ connectionId, accountName }));
        if (accounts.length && connectionId === undefined && newAccount !== true)
          return { name: serviceInfo(slug).name, accounts };
        const result = await options.discovered.signIn(slug, turn, connectionId);
        const account = accounts.find((entry) => entry.connectionId === connectionId);
        return {
          ...result,
          operation: connectionId ? 'reconnect' : newAccount ? 'add_account' : 'connect',
          ...(account ? { account: { name: account.accountName } } : {}),
        };
      }
      if (connectionId !== undefined) {
        const result = await reconnect(
          slug,
          z.uuid().parse(connectionId),
          turn ? 'chat' : 'apps',
          turn,
        );
        return { name: serviceInfo(slug).name, ...result, operation: 'reconnect' };
      }
      const accounts = (await connectionRows(configuredOwner))
        .filter(
          (row) =>
            provider.configured &&
            row.slug === slug &&
            row.provider_id === providerId &&
            configurationMatches(row) &&
            row.account_id &&
            !row.revoked &&
            row.account_active,
        )
        .map((row) => ({
          connectionId: row.id,
          accountName: row.account_name ?? undefined,
          accountEmail: row.account_email ?? undefined,
        }));
      if (accounts.length && newAccount !== true) return { name: serviceInfo(slug).name, accounts };
      const result = await connect(slug, turn ? 'chat' : 'apps', turn);
      return {
        name: serviceInfo(slug).name,
        ...result,
        operation: newAccount ? 'add_account' : 'connect',
      };
    },
    status: list,
    drain,
    syncWatches,
    pollInboxes,
    pollActivityChanges,
    ready: provider.configured,
  };
}
