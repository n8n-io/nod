import { setTimeout as delay } from 'node:timers/promises';
import type { Composio, ToolRouterSession } from '@composio/core';
import { z } from 'zod';
import { composioActivity } from './activity.ts';
import { integrationServices, type IntegrationServiceInfo } from '../../shared/integrations.ts';
import { createComposioFiles } from './downloads.ts';
import type { createComposioProxy } from './proxy.ts';
import { readInboxSnippets, readInboxThreads, readSentEmails } from './sent-email.ts';
import { readVerificationEmails } from './verification-email.ts';
import {
  IntegrationCatalogAccessDenied,
  IntegrationCatalogFailure,
  IntegrationConnectionError,
  IntegrationInboxCursorExpired,
  IntegrationInboxTransientError,
  IntegrationPermissionError,
  type IntegrationProvider,
  type IntegrationSession,
} from '../../ports/integrations.ts';

const toolkits = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'outlook',
];
type ManagedSession = Awaited<ReturnType<Composio['sessions']['create']>> &
  Pick<InstanceType<typeof ToolRouterSession>, 'search' | 'execute'>;
type AccountIdentity = { expiresAt: number; accountName?: string; accountEmail?: string };
const toolSlug = z
  .string()
  .max(200)
  .regex(/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/);
const schemaToolkit = z
  .string()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,79}$/);
const catalogLogo = z
  .string()
  .max(2048)
  .regex(
    /^https:\/\/(?:logos\.composio\.dev\/api\/[a-z0-9_-]+|assets\.composio\.dev\/logos\/[a-z0-9][a-z0-9_.-]*\.(?:svg|png|webp|jpe?g|ico))$/i,
  );
const catalogCategory = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
});
const catalogPage = z.object({
  items: z.array(z.unknown()).max(1000),
  next_cursor: z.string().max(2048).nullable().optional(),
});
const catalogItem = z.object({
  slug: schemaToolkit,
  name: z.string().trim().min(1).max(200),
  no_auth: z.boolean().optional(),
  meta: z
    .object({
      description: z.string().max(10_000).optional().catch(undefined),
      logo: z.unknown().optional(),
      categories: z.unknown().optional(),
    })
    .catch({}),
  auth_schemes: z.array(z.string().max(100)).max(30).optional(),
  composio_managed_auth_schemes: z.array(z.string().max(100)).max(30).optional(),
});
const accountRouting = z.object({
  id: z.string().min(1).max(200),
  user_id: z.string().min(1).max(200),
  toolkit: z.object({ slug: schemaToolkit }),
  auth_config: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    is_disabled: z.boolean(),
  }),
});

function providerFailure(action: string, result: Record<string, unknown>) {
  const data =
    result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : {};
  const detail = [
    ...new Set(
      [result.error, data.error, data.message]
        .filter((value) => value != null && value !== '')
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value))),
    ),
  ].join('; ');
  const permissions = ['needed', 'provided'].flatMap((field) => {
    const value = data[field] ?? result[field];
    return typeof value === 'string' && value
      ? [`${field}: ${value.length > 1000 ? `${value.slice(0, 1000)}…` : value}`]
      : [];
  });
  const text = [...permissions, detail || JSON.stringify(result)].join('; ');
  const log = typeof result.logId === 'string' ? ` (Composio log ${result.logId})` : '';
  const message = `Composio could not complete ${action}: ${text.slice(0, 4000)}${log}`;
  const missingScope =
    /\b(?:missing_scope|insufficient_scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT)\b|insufficient (?:authentication )?scopes/i.test(
      detail,
    );
  return missingScope ? new IntegrationPermissionError(message) : new Error(message);
}
const schemaFields = z.record(z.string(), z.unknown());
const toolSchemasResult = z.object({
  success: z.literal(true),
  successful: z.literal(true).optional(),
  error: z.null().optional(),
  not_found: z.array(z.string()).max(0).optional(),
  tool_schemas: z.record(
    toolSlug,
    z.object({
      tool_slug: toolSlug,
      toolkit: schemaToolkit,
      description: z.string().optional(),
      input_schema: schemaFields,
      output_schema: schemaFields.optional(),
      hasFullSchema: z.literal(true).optional(),
      schemaRef: z.never().optional(),
    }),
  ),
});
const toolSchemasResponse = z.object({
  error: z.null(),
  successful: z.literal(true).optional(),
  data: z.union([
    toolSchemasResult,
    z.object({
      successful: z.literal(true),
      error: z.null().optional(),
      data: toolSchemasResult,
    }),
  ]),
});
const identityTools = {
  gmail: { action: 'GMAIL_GET_PROFILE', args: { user_id: 'me' } },
  slack: { action: 'SLACK_WHO_AM_I', args: {} },
  sentry: { action: 'SENTRY_VALIDATE_CREDENTIAL', args: {} },
  googlecalendar: { action: 'GOOGLECALENDAR_GET_CURRENT_USER', args: {} },
  googledrive: {
    action: 'GOOGLEDRIVE_GET_ABOUT',
    args: { fields: 'user(displayName,emailAddress)' },
  },
} as const;
const accountDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .refine((value) => !/^(?:\[?redacted\]?|<redacted>|\*{3,})$/i.test(value));

function identityFields(
  value: unknown,
  service?: string,
): Omit<AccountIdentity, 'expiresAt'> | undefined {
  let data = z.record(z.string(), z.unknown()).parse(value);
  for (let depth = 0; depth < 4; depth++) {
    if (data.error != null || data.successful === false) return;
    if (service === 'slack' && (typeof data.user === 'string' || typeof data.team === 'string')) {
      data = {
        name: [data.user, data.team]
          .filter((value) => typeof value === 'string' && value.trim())
          .join(' · '),
      };
      break;
    }
    if (data.user && typeof data.user === 'object') {
      data = z.record(z.string(), z.unknown()).parse(data.user);
      break;
    }
    if (!data.data || typeof data.data !== 'object') break;
    data = z.record(z.string(), z.unknown()).parse(data.data);
  }
  if (data.error != null || data.successful === false) return;
  const email = z
    .email()
    .max(320)
    .safeParse(
      service === 'outlook'
        ? (data.mail ?? data.userPrincipalName)
        : (data.email ?? data.emailAddress ?? data.id),
    );
  const name = accountDisplayName.safeParse(data.name ?? data.displayName ?? data.display_name);
  if (!email.success && !name.success) return;
  return {
    ...(email.success ? { accountEmail: email.data } : {}),
    ...(name.success ? { accountName: name.data } : {}),
  };
}

function proxyRequestFailure(
  error: unknown,
  signal?: AbortSignal,
):
  | {
      reason: IntegrationConnectionError['reason'];
      status?: number;
      code?: unknown;
    }
  | undefined {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  const kind = error instanceof Error ? error.constructor.name : '';
  const reason =
    status === 401
      ? 'authorization'
      : status === 403
        ? 'permission'
        : status === 429
          ? 'rate_limit'
          : status === 408 ||
              status === 504 ||
              kind === 'APIConnectionTimeoutError' ||
              (signal?.aborted && signal.reason?.name === 'TimeoutError')
            ? 'timeout'
            : (typeof status === 'number' && status >= 500 && status <= 599) ||
                kind === 'APIConnectionError'
              ? 'unavailable'
              : typeof status === 'number' && status >= 400 && status <= 499
                ? 'invalid_request'
                : undefined;
  if (!reason) return;
  const body = error && typeof error === 'object' && 'error' in error ? error.error : undefined;
  const code = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
  return {
    reason,
    status: typeof status === 'number' ? status : undefined,
    code,
  };
}

function connectionFailure(phase: IntegrationConnectionError['phase'], signal?: AbortSignal) {
  return (error: unknown): never => {
    const failure = proxyRequestFailure(error, signal);
    if (failure) {
      const code = z
        .enum([
          'installation_busy',
          'public_budget_exceeded',
          'service_unavailable',
          'security_service_unavailable',
        ])
        .safeParse(failure.code);
      throw new IntegrationConnectionError(
        failure.reason,
        phase,
        failure.status,
        code.success ? code.data : undefined,
      );
    }
    throw error;
  };
}

export function createComposioProvider(options: {
  proxy: ReturnType<typeof createComposioProxy>;
  fileDownload?: Parameters<typeof createComposioFiles>[0];
}): IntegrationProvider {
  const files = createComposioFiles(options.fileDownload);
  const identities = new Map<string, AccountIdentity>();
  const pendingIdentities = new Map<string, Promise<AccountIdentity>>();
  const client = options.proxy.client;
  let catalog: { services: IntegrationServiceInfo[]; expiresAt: number } | undefined;
  let catalogRequest: Promise<IntegrationServiceInfo[]> | undefined;
  let catalogRetryAfter = 0;
  function userId(ownerId: string) {
    if (ownerId !== options.proxy.ownerId)
      throw new Error('This connected account owner is unavailable.');
    return options.proxy.userId;
  }
  async function ownedAccount(id: string, ownerId: string, signal: AbortSignal) {
    const expectedUserId = userId(ownerId);
    const account = accountRouting.parse(
      await client.getClient().connectedAccounts.retrieve(id, { signal }),
    );
    if (account.id !== id || account.user_id !== expectedUserId)
      throw new Error('This connected account is unavailable.');
    return account;
  }
  function builtInServices(): IntegrationServiceInfo[] {
    return toolkits.map((slug) => ({
      slug,
      name: integrationServices[slug].name,
      description: integrationServices[slug].description,
    }));
  }
  async function listServices(): Promise<IntegrationServiceInfo[]> {
    if (catalog && catalog.expiresAt > Date.now()) return catalog.services;
    if (catalogRequest) return catalogRequest;
    const operation = AbortSignal.timeout(10_000);
    const pending = (async () => {
      const services = new Map(builtInServices().map((service) => [service.slug, service]));
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        operation.throwIfAborted();
        const page = catalogPage.parse(
          await client.getClient().toolkits.list(
            {
              type: 'native',
              include_deprecated: false,
              limit: 1000,
              ...(cursor ? { cursor } : {}),
            },
            { signal: operation },
          ),
        );
        for (const entry of page.items) {
          const parsed = catalogItem.safeParse(entry);
          if (!parsed.success) continue;
          const item = parsed.data;
          if (
            item.slug === 'notion_mcp' ||
            item.no_auth ||
            (item.auth_schemes?.length &&
              item.auth_schemes.every((scheme) => scheme.toUpperCase() === 'NO_AUTH'))
          )
            continue;
          if (
            !item.composio_managed_auth_schemes?.length &&
            !item.auth_schemes?.some((scheme) => scheme.toUpperCase() === 'DCR_OAUTH') &&
            !services.has(item.slug)
          )
            continue;
          const logo = catalogLogo.safeParse(item.meta.logo);
          const categories = Array.isArray(item.meta.categories)
            ? [
                ...new Set(
                  item.meta.categories.slice(0, 32).flatMap((category) => {
                    const parsed = catalogCategory.safeParse(category);
                    return parsed.success ? [parsed.data.name] : [];
                  }),
                ),
              ].slice(0, 12)
            : [];
          services.set(item.slug, {
            slug: item.slug,
            name: item.name,
            description: item.meta.description?.slice(0, 1000) ?? '',
            ...(logo.success ? { logoUrl: logo.data } : {}),
            ...(categories.length ? { categories } : {}),
          });
        }
        cursor = page.next_cursor ?? undefined;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size >= 10)
            throw new Error('The app catalog pagination is invalid.');
          cursors.add(cursor);
        }
      } while (cursor);
      operation.throwIfAborted();
      const result = [...services.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      catalog = { services: result, expiresAt: Date.now() + 15 * 60_000 };
      catalogRetryAfter = 0;
      return result;
    })().catch((error: unknown) => {
      catalogRetryAfter = Date.now() + 30_000;
      if (error instanceof IntegrationConnectionError || error instanceof IntegrationCatalogFailure)
        throw error;
      const failure = proxyRequestFailure(error, operation);
      if (failure?.reason === 'permission') {
        const code = z
          .enum([
            'installation_enrollment_required',
            'installation_revoked',
            'browser_pairing_required',
          ])
          .safeParse(failure.code);
        throw new IntegrationCatalogAccessDenied(code.success ? code.data : undefined);
      }
      if (failure) {
        const code = z
          .enum([
            'rate_limited',
            'installation_busy',
            'public_budget_exceeded',
            'provider_rate_limited',
            'service_unavailable',
            'security_service_unavailable',
            'public_access_unavailable',
            'provider_unavailable',
            'provider_request_failed',
            'catalog_unavailable',
            'operation_timeout',
            'invalid_limit_configuration',
            'invalid_provider_response',
            'unsafe_provider_response',
          ])
          .safeParse(failure.code);
        throw new IntegrationCatalogFailure(
          failure.reason,
          failure.status,
          code.success ? code.data : undefined,
        );
      }
      throw new Error('The app catalog could not be loaded. Try again later.');
    });
    catalogRequest = pending;
    try {
      return await pending;
    } finally {
      if (catalogRequest === pending) catalogRequest = undefined;
    }
  }
  async function sessionServices(signal?: AbortSignal) {
    let services = builtInServices();
    if (Date.now() < catalogRetryAfter) return services.map((service) => service.slug);
    let abort: (() => void) | undefined;
    try {
      const pending = listServices();
      services = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            }),
          ])
        : await pending;
    } catch {
      signal?.throwIfAborted();
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
    }
    return services.map((service) => service.slug);
  }
  async function fetchIdentity(
    id: string,
    service: string,
    ownerId: string,
  ): Promise<AccountIdentity> {
    const tool = identityTools[service as keyof typeof identityTools];
    if (tool) {
      let inspection: ManagedSession | undefined;
      try {
        inspection = await client.sessions.create(
          userId(ownerId),
          {
            toolkits: [service],
            tools: { [service]: [tool.action] },
            connectedAccounts: { [service]: id },
            multiAccount: {
              enable: true,
              maxAccountsPerToolkit: 2,
              requireExplicitSelection: true,
            },
            manageConnections: false,
            sandbox: { enable: false },
          },
          { signal: AbortSignal.timeout(15_000) },
        );
        const response = await inspection.execute(tool.action, tool.args, { account: id });
        const fields = identityFields(response, service);
        if (fields) return { ...fields, expiresAt: Date.now() + 15 * 60_000 };
      } catch {
      } finally {
        if (inspection) {
          try {
            await client.sessions.delete(inspection.sessionId, {
              signal: AbortSignal.timeout(5_000),
            });
          } catch {}
        }
      }
    }
    const endpoints = [
      'gmail',
      'googlecalendar',
      'googledrive',
      'googledocs',
      'googlesheets',
    ].includes(service)
      ? ['https://www.googleapis.com/oauth2/v2/userinfo']
      : [];
    if (service === 'gmail')
      endpoints.push('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    else if (service === 'googlecalendar')
      endpoints.push('https://www.googleapis.com/calendar/v3/calendars/primary');
    else if (['googledrive', 'googledocs', 'googlesheets'].includes(service))
      endpoints.push(
        'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
      );
    else if (service === 'outlook')
      endpoints.push(
        'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName',
      );
    for (const endpoint of endpoints) {
      try {
        const response = await client.tools.proxyExecute(
          {
            connectedAccountId: id,
            endpoint,
            method: 'GET',
          },
          { signal: AbortSignal.timeout(15_000) },
        );
        if (response.status !== 200) continue;
        const fields = identityFields(response.data, service);
        if (fields) return { ...fields, expiresAt: Date.now() + 15 * 60_000 };
      } catch {}
    }
    return { expiresAt: Date.now() + 60_000 };
  }
  async function identity(id: string, service: string, ownerId: string) {
    const key = JSON.stringify([ownerId, id]);
    const saved = identities.get(key);
    if (saved && saved.expiresAt > Date.now()) return saved;
    let pending = pendingIdentities.get(key);
    if (!pending) {
      pending = fetchIdentity(id, service, ownerId)
        .then((result) => {
          identities.set(key, result);
          return result;
        })
        .finally(() => pendingIdentities.delete(key));
      pendingIdentities.set(key, pending);
    }
    return pending;
  }
  function session(value: ManagedSession, selectedToolkits: string[]): IntegrationSession {
    const enabled = new Set(selectedToolkits);
    function actionToolkit(action: string) {
      toolSlug.parse(action);
      const toolkit = [...enabled]
        .sort((left, right) => right.length - left.length)
        .find((slug) => action.startsWith(`${slug.toUpperCase()}_`));
      if (!toolkit) throw new Error('This action is outside the connected apps.');
      return toolkit;
    }
    return {
      id: value.sessionId,
      async authorize(service, callbackUrl) {
        const slug = schemaToolkit.parse(service);
        if (
          !enabled.has(slug) ||
          (!toolkits.includes(slug) && !(await listServices()).some((entry) => entry.slug === slug))
        )
          throw new Error('This app is not available for connection.');
        return options.proxy.authorize(slug, callbackUrl);
      },
      async search(query, signal) {
        try {
          signal?.throwIfAborted();
          const result = await value.search({ query, toolkits: [...enabled] }, { signal });
          signal?.throwIfAborted();
          if (!result.success || result.error != null) throw new Error();
          const entries = Object.entries(result.toolSchemas).map(
            ([slug, tool]) =>
              [slug, { ...tool, toolkit: schemaToolkit.parse(tool.toolkit) }] as const,
          );
          const advertised = new Set(entries.map(([slug]) => slug));
          for (const [slug, tool] of entries) {
            toolSlug.parse(slug);
            if (
              !enabled.has(tool.toolkit) ||
              tool.toolSlug !== slug ||
              actionToolkit(slug) !== tool.toolkit
            )
              throw new Error();
          }
          const missing = entries.filter(
            ([, tool]) =>
              tool.hasFullSchema === false || !schemaFields.safeParse(tool.inputSchema).success,
          );
          for (const [slug, tool] of missing) {
            const reference = tool.schemaRef;
            const slugs = reference?.args.toolSlugs;
            if (
              reference?.tool !== 'COMPOSIO_GET_TOOL_SCHEMAS' ||
              !slugs?.includes(slug) ||
              slugs.length > 20 ||
              new Set(slugs).size !== slugs.length ||
              slugs.some((item) => !advertised.has(item))
            )
              throw new Error();
          }
          const tools = Object.fromEntries(
            entries.map(([slug, { schemaRef: _, ...tool }]) => [slug, tool]),
          );
          const requested = new Set(query.toLowerCase().split(/[\s,]+/));
          const exact = entries.filter(([slug]) => requested.has(slug.toLowerCase()));
          const exactMatch = exact.length === requested.size;
          const visible = exactMatch ? exact : entries;
          const full = !exactMatch && visible.length > 6 ? visible.slice(0, 3) : visible;
          const fullNames = new Set(full.map(([slug]) => slug));
          const hydrate =
            enabled.size > 0 && [...enabled].every((slug) => toolkits.includes(slug))
              ? missing.filter(([slug]) => fullNames.has(slug))
              : missing;
          for (let start = 0; start < hydrate.length; start += 20) {
            const batch = hydrate.slice(start, start + 20);
            const operation = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000);
            const response = await client.getClient().toolRouter.session.executeMeta(
              value.sessionId,
              {
                slug: 'COMPOSIO_GET_TOOL_SCHEMAS',
                arguments: {
                  tool_slugs: batch.map(([slug]) => slug),
                  include: ['input_schema'],
                },
              },
              { signal: operation },
            );
            operation.throwIfAborted();
            const envelope = toolSchemasResponse.parse(response).data;
            const schemas =
              'tool_schemas' in envelope ? envelope.tool_schemas : envelope.data.tool_schemas;
            if (Object.keys(schemas).length !== batch.length) throw new Error();
            for (const [slug, tool] of batch) {
              const schema = schemas[slug];
              if (!schema || schema.tool_slug !== slug || schema.toolkit !== tool.toolkit)
                throw new Error();
              tools[slug] = {
                ...tools[slug],
                ...(schema.description === undefined ? {} : { description: schema.description }),
                inputSchema: schema.input_schema,
                ...(schema.output_schema === undefined
                  ? {}
                  : { outputSchema: schema.output_schema }),
                hasFullSchema: true,
              };
            }
          }
          return {
            tools,
            suggestions: result.results.map((item) => ({
              useCase: item.useCase,
              primaryToolSlugs: item.primaryToolSlugs,
            })),
          };
        } catch (error) {
          signal?.throwIfAborted();
          throw new Error(
            `The app tool schemas could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      async execute(action, args, accountId, signal) {
        signal?.throwIfAborted();
        const toolkit = actionToolkit(action);
        const result = await value
          .execute(action, args, accountId ? { account: accountId } : undefined, {
            signal,
            maxRetries: 0,
          } as Parameters<typeof value.execute>[3])
          .catch((error: unknown) => {
            const kind = error instanceof Error ? error.constructor.name : '';
            const reason =
              kind === 'APIConnectionTimeoutError'
                ? 'timeout'
                : kind === 'APIConnectionError'
                  ? 'unavailable'
                  : undefined;
            if (reason) Object.assign(error!, { reason });
            throw error;
          });
        signal?.throwIfAborted();
        if (
          result.error != null ||
          result.resultType !== 'completed' ||
          (result.data &&
            typeof result.data === 'object' &&
            'successful' in result.data &&
            result.data.successful === false) ||
          ((toolkit === 'slack' || toolkit === 'slackbot') &&
            result.data &&
            typeof result.data === 'object' &&
            'ok' in result.data &&
            result.data.ok === false)
        )
          throw providerFailure(action, result as Record<string, unknown>);
        return files(result, signal ?? new AbortController().signal);
      },
      async upload(action, file, signal, accountId) {
        actionToolkit(action);
        if (!accountId) throw new Error('Select an account before uploading a file.');
        return options.proxy.upload(value.sessionId, action, file, accountId, signal);
      },
    };
  }
  return {
    id: 'composio',
    ownsConnectionUrl: (url) => options.proxy.ownsConnectionUrl(url),
    configured: true,
    get configurationId() {
      return options.proxy.configurationId;
    },
    supportedServices: toolkits,
    listServices,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    async authorize(ownerId, service, callbackUrl) {
      userId(ownerId);
      return options.proxy.authorize(schemaToolkit.parse(service), callbackUrl);
    },
    async connectionStatus(ownerId, url, signal) {
      userId(ownerId);
      return options.proxy.connectionStatus(url, signal);
    },
    verificationEmails: (accountId, query, signal) =>
      readVerificationEmails(client.tools, accountId, query, signal),
    sentEmails: (accountId, signal) => readSentEmails(client.tools, accountId, signal),
    inboxSnippets: (accountId, signal) => readInboxSnippets(client.tools, accountId, signal),
    inboxThreads: (accountId, signal) => readInboxThreads(client.tools, accountId, signal),
    activity: composioActivity(client.tools),
    async pollInbox(accountId, cursor, signal) {
      const deadline = AbortSignal.timeout(25_000);
      const operation = AbortSignal.any([signal, deadline]);
      let phase = 'cursor';
      let category = 'cursor';
      let status: number | undefined;
      const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
      const historyId = z.string().regex(/^\d{1,32}$/);
      const addedMessage = z.object({ message: z.object({ id }) });
      const mailHeader = z.object({ name: z.string(), value: z.string() });
      const stateSchema = z.object({
        accountId: z.string().min(1).max(200),
        historyId,
        pageToken: z.string().min(1).max(2048).optional(),
        pending: z.array(id).max(1000).default([]),
        finalHistoryId: historyId.optional(),
      });
      let retriesRemaining = 2;
      const retryableStatus = (value: unknown): value is number =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        (value === 408 || value === 429 || (value >= 500 && value <= 599));
      function proxyCode(value: unknown) {
        if (!value || typeof value !== 'object') return undefined;
        const detail = (value as Record<string, unknown>).error;
        const candidate =
          typeof detail === 'string'
            ? detail
            : detail && typeof detail === 'object'
              ? ((detail as Record<string, unknown>).code ??
                (detail as Record<string, unknown>).error)
              : undefined;
        const code = z
          .enum([
            'installation_busy',
            'public_budget_exceeded',
            'service_unavailable',
            'security_service_unavailable',
          ])
          .safeParse(candidate);
        return code.success ? code.data : undefined;
      }
      function transientFailure(error: unknown) {
        let current = error;
        for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
          const detail = current as Record<string, unknown>;
          const code = proxyCode(detail.error);
          if (retryableStatus(detail.status))
            return new IntegrationInboxTransientError(detail.status, code);
          if (current instanceof Error) {
            const kind = current.constructor.name;
            if (kind === 'APIConnectionError' || kind === 'APIConnectionTimeoutError')
              return new IntegrationInboxTransientError(undefined, code);
          }
          current = detail.cause;
        }
      }
      async function get(path: string, parameters: Array<[string, string | number]>) {
        for (;;) {
          operation.throwIfAborted();
          phase = path === 'profile' ? 'baseline' : path === 'history' ? 'history' : 'message';
          category = 'request';
          status = undefined;
          try {
            const response = await client.tools.proxyExecute(
              {
                connectedAccountId: accountId,
                endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
                method: 'GET',
                parameters: parameters.map(([name, value]) => ({ in: 'query', name, value })),
              },
              { signal: operation },
            );
            operation.throwIfAborted();
            status = response.status;
            if (response.status === 404 && path.startsWith('messages/')) return null;
            if (response.status === 404 && path === 'history')
              throw new IntegrationInboxCursorExpired();
            category = 'http';
            if (response.status !== 200) {
              if (retryableStatus(response.status))
                throw new IntegrationInboxTransientError(response.status, proxyCode(response.data));
              throw new Error();
            }
            category = 'response_size';
            if (JSON.stringify(response.data).length > 1_000_000) {
              if (path === 'history') throw new IntegrationInboxCursorExpired();
              throw new Error();
            }
            category = 'response';
            return response.data;
          } catch (error) {
            if (operation.aborted) throw error;
            const transient =
              error instanceof IntegrationInboxTransientError ? error : transientFailure(error);
            if (!transient) throw error;
            if (!retriesRemaining || transient.code === 'public_budget_exceeded') throw transient;
            const attempt = 2 - retriesRemaining;
            retriesRemaining--;
            await delay(350 * 2 ** attempt + Math.floor(Math.random() * 150), undefined, {
              signal: operation,
            });
          }
        }
      }
      try {
        if (cursor === null) {
          const baseline = z
            .object({ historyId })
            .parse(await get('profile', [['fields', 'historyId']]));
          return {
            cursor: JSON.stringify(stateSchema.parse({ accountId, historyId: baseline.historyId })),
            hasMore: false,
            messages: [],
          };
        }
        if (cursor.length > 220_000) throw new Error();
        const state = stateSchema.parse(JSON.parse(cursor));
        if (state.accountId !== accountId) throw new Error();
        if (!state.pending.length) {
          const page = z
            .object({
              historyId,
              nextPageToken: z.string().min(1).max(2048).optional(),
              history: z
                .array(
                  z.object({
                    messagesAdded: z.array(addedMessage).optional(),
                  }),
                )
                .max(20)
                .optional(),
            })
            .parse(
              await get('history', [
                ['startHistoryId', state.historyId],
                ['historyTypes', 'messageAdded'],
                ['labelId', 'INBOX'],
                ['maxResults', 20],
                ['fields', 'history/messagesAdded/message/id,historyId,nextPageToken'],
                ...(state.pageToken ? [['pageToken', state.pageToken] as [string, string]] : []),
              ]),
            );
          const pending = stateSchema.shape.pending.safeParse([
            ...new Set(
              page.history?.flatMap(
                (entry) => entry.messagesAdded?.map(({ message }) => message.id) ?? [],
              ),
            ),
          ]);
          if (!pending.success) throw new IntegrationInboxCursorExpired();
          state.pending = pending.data;
          state.pageToken = page.nextPageToken;
          state.finalHistoryId = page.nextPageToken ? undefined : page.historyId;
        }
        const messages = [];
        let consumed = 0;
        let retryAfterMs: number | undefined;
        for (const pendingId of state.pending.slice(0, 20)) {
          let response;
          try {
            response = await get(`messages/${pendingId}`, [
              ['format', 'metadata'],
              ['fields', 'id,threadId,internalDate,labelIds,payload/headers'],
            ]);
          } catch (error) {
            if (!signal.aborted && consumed) {
              if (deadline.aborted) {
                retryAfterMs = 60_000;
                break;
              }
              if (error instanceof IntegrationInboxTransientError) {
                retryAfterMs = error.retryAfterMs;
                console.warn(
                  JSON.stringify({
                    event: 'gmail_inbox_poll_deferred',
                    timestamp: new Date().toISOString(),
                    phase,
                    category,
                    ...(error.status === undefined ? {} : { status: error.status }),
                    ...(error.code ? { code: error.code } : {}),
                    consumed,
                  }),
                );
                break;
              }
            }
            throw error;
          }
          if (response === null) {
            consumed++;
            continue;
          }
          const message = z
            .object({
              id,
              threadId: id,
              internalDate: z.string().regex(/^\d{1,16}$/),
              labelIds: z.array(z.string().max(200)).max(100).default([]),
              payload: z.object({
                headers: z.array(mailHeader).default([]),
              }),
            })
            .parse(response);
          if (message.id !== pendingId) {
            category = 'identity';
            throw new Error();
          }
          consumed++;
          if (!message.labelIds.includes('INBOX')) continue;
          const header = (name: string) =>
            message.payload.headers
              .find((item) => item.name.toLowerCase() === name)
              ?.value.replace(/[\u0000-\u001f]/g, ' ')
              .slice(0, 1000) ?? '';
          messages.push({
            id: message.id,
            threadId: message.threadId,
            subject: header('subject'),
            sender: header('from'),
            receivedAt: new Date(Number(message.internalDate)).toISOString(),
          });
        }
        signal.throwIfAborted();
        state.pending = state.pending.slice(consumed);
        if (!state.pending.length && state.finalHistoryId) {
          state.historyId = state.finalHistoryId;
          delete state.finalHistoryId;
        }
        return {
          cursor: JSON.stringify(state),
          hasMore: Boolean(state.pending.length || state.pageToken),
          ...(retryAfterMs ? { retryAfterMs } : {}),
          messages,
        };
      } catch (error) {
        if (signal.aborted) throw new DOMException('Inbox check was cancelled.', 'AbortError');
        const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
        const errorKind =
          error instanceof Error
            ? new Map([
                ['APIConnectionError', 'connection'],
                ['APIConnectionTimeoutError', 'connection_timeout'],
                ['APIUserAbortError', 'request_aborted'],
                ['ComposioRequestCancelledError', 'request_cancelled'],
                ['ValidationError', 'validation'],
                ['SyntaxError', 'invalid_json'],
                ['TypeError', 'type'],
              ]).get(error.constructor.name)
            : undefined;
        const causes: Record<string, unknown>[] = [];
        let cause: unknown = error;
        for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
          const current = cause as Record<string, unknown>;
          causes.push(current);
          cause = current.cause;
        }
        const httpStatus = [
          status,
          ...causes.flatMap((cause) => [cause.status, cause.statusCode]),
        ].find(
          (value): value is number =>
            typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
        );
        const causeCode = causes
          .map((cause) => cause.code)
          .find(
            (code): code is string =>
              typeof code === 'string' &&
              [
                'ECONNRESET',
                'ECONNREFUSED',
                'EHOSTUNREACH',
                'ENETUNREACH',
                'ENOTFOUND',
                'EAI_AGAIN',
                'ETIMEDOUT',
                'UND_ERR_CONNECT_TIMEOUT',
                'UND_ERR_HEADERS_TIMEOUT',
                'UND_ERR_BODY_TIMEOUT',
                'UND_ERR_SOCKET',
              ].includes(code),
          );
        const fields = [
          'accountId',
          'historyId',
          'pending',
          'pageToken',
          'finalHistoryId',
          'history',
          'messagesAdded',
          'message',
          'id',
          'threadId',
          'internalDate',
          'labelIds',
          'payload',
          'headers',
          'name',
          'value',
        ];
        console.warn(
          JSON.stringify({
            event: 'gmail_inbox_poll_failed',
            timestamp: new Date().toISOString(),
            phase,
            category: issue
              ? 'schema'
              : error instanceof IntegrationInboxCursorExpired
                ? 'expired'
                : error instanceof RangeError
                  ? 'date'
                  : operation.aborted
                    ? 'timeout'
                    : category,
            ...(httpStatus === undefined ? {} : { status: httpStatus }),
            ...(error instanceof IntegrationInboxTransientError && error.code
              ? { code: error.code }
              : {}),
            ...(errorKind ? { errorKind } : {}),
            ...(causeCode ? { causeCode } : {}),
            ...(issue
              ? {
                  issue: issue.code,
                  field: issue.path
                    .slice(0, 8)
                    .map((part) =>
                      typeof part === 'number'
                        ? '[]'
                        : typeof part === 'string' && fields.includes(part)
                          ? part
                          : 'unknown',
                    )
                    .join('.'),
                }
              : {}),
          }),
        );
        if (error instanceof IntegrationInboxCursorExpired) throw error;
        if (error instanceof IntegrationInboxTransientError) throw error;
        if (deadline.aborted) throw new IntegrationInboxTransientError(httpStatus);
        throw new Error('The Gmail inbox could not be checked.');
      }
    },
    async createSession(ownerId, accounts, signal) {
      userId(ownerId);
      signal ??= AbortSignal.timeout(15_000);
      signal.throwIfAborted();
      const connectedAccounts = Object.fromEntries(
        Object.entries(accounts).filter(
          (entry): entry is [string, string | string[]] =>
            entry[1] !== undefined && entry[0] !== 'notion_mcp',
        ),
      );
      const accountToolkits = [
        ...new Set(Object.keys(connectedAccounts).map((slug) => schemaToolkit.parse(slug))),
      ];
      const selectedToolkits = accountToolkits.length
        ? accountToolkits
        : await sessionServices(signal);
      signal?.throwIfAborted();
      const requestOptions = { signal, maxRetries: 0 };
      const value = await client.sessions
        .create(
          userId(ownerId),
          {
            toolkits: selectedToolkits,
            connectedAccounts,
            multiAccount: {
              enable: true,
              maxAccountsPerToolkit: 10,
              requireExplicitSelection: true,
            },
            manageConnections: false,
            sandbox: { enable: false },
          },
          requestOptions,
        )
        .catch(connectionFailure('session', signal));
      return session(value, selectedToolkits);
    },
    async deleteSession(id) {
      await client.sessions.delete(id, { signal: AbortSignal.timeout(5_000) });
    },
    async reconnectAccount(ownerId, service, accountId, callbackUrl) {
      const slug = schemaToolkit.parse(service);
      const signal = AbortSignal.timeout(30_000);
      const original = await ownedAccount(accountId, ownerId, signal);
      if (original.toolkit.slug !== slug || original.auth_config.is_disabled)
        throw new Error('This connection sign-in configuration is unavailable.');
      return {
        ...(await options.proxy.authorize(slug, callbackUrl, accountId)),
        authConfigId: original.auth_config.id,
      };
    },
    async inspectAccount(id, ownerId, inspection) {
      userId(ownerId);
      const routing = inspection?.verifyOwner
        ? await ownedAccount(id, ownerId, AbortSignal.timeout(10_000))
        : undefined;
      const account = await client.connectedAccounts.get(id, {
        signal: AbortSignal.timeout(10_000),
      });
      const active = account.status === 'ACTIVE' && !account.isDisabled;
      const service = account.toolkit.slug.toLowerCase();
      if (routing && (routing.toolkit.slug !== service || routing.auth_config.is_disabled))
        throw new Error('This connected account is unavailable.');
      const details = active ? await identity(id, service, ownerId) : undefined;
      const displayName = accountDisplayName.safeParse(account.state?.val.displayName);
      const accountName =
        details?.accountName ?? (active && displayName.success ? displayName.data : undefined);
      return {
        active,
        service,
        ...(accountName ? { accountName } : {}),
        ...(details?.accountEmail ? { accountEmail: details.accountEmail } : {}),
        ...(routing ? { authConfigId: routing.auth_config.id } : {}),
      };
    },
    async deleteAccount(id, ownerId) {
      if (ownerId) userId(ownerId);
      if (options.proxy.isPendingAccount(id)) return;
      if (ownerId) await ownedAccount(id, ownerId, AbortSignal.timeout(10_000));
      await client.connectedAccounts.delete(id);
      for (const key of identities.keys()) if (JSON.parse(key)[1] === id) identities.delete(key);
    },
    parseCallback: (query, pending) => options.proxy.parseCallback(query, pending),
    async subscribe() {
      throw new Error('Automatic updates are unavailable for this service.');
    },
    async unsubscribe() {
      throw new Error('Automatic updates are unavailable for this service.');
    },
    matchesSubscription() {
      return false;
    },
    async verifyWebhook() {
      throw new Error('The webhook is not configured.');
    },
  };
}
