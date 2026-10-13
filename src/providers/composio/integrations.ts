import { Composio, type ToolRouterSession } from '@composio/core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { integrationServices, type IntegrationServiceInfo } from '../../shared/integrations.ts';
import { createComposioFiles } from './downloads.ts';
import { readInboxSnippets, readSentEmails } from './sent-email.ts';
import { readVerificationEmails } from './verification-email.ts';
import { safeRemoteFetch } from '../discovered/remote.ts';
import {
  IntegrationAuthConfigurationError,
  IntegrationCatalogAccessDenied,
  IntegrationInboxCursorExpired,
  type IntegrationProvider,
  type IntegrationService,
  type IntegrationSession,
} from '../../ports/integrations.ts';

const toolkitVersions = {
  gmail: '20260915_00',
  googlecalendar: '20260915_00',
  googledrive: '20260921_00',
  googlesheets: '20260915_00',
  googledocs: '20260826_00',
  slack: '20260915_00',
};
const toolkits = Object.keys(toolkitVersions);
const googleOAuthToolkits = new Set([
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
]);
const subscriptions = {
  gmail: {
    trigger: 'GMAIL_NEW_GMAIL_MESSAGE',
    config: { interval: 15, query: 'in:inbox', userId: 'me' },
  },
  googlecalendar: {
    trigger: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER',
    config: { interval: 15, calendarId: 'primary', showDeleted: true },
  },
  slack: { trigger: 'SLACK_DIRECT_MESSAGE_RECEIVED', config: {} },
} as const;
type ManagedSession = Awaited<ReturnType<Composio['sessions']['create']>> &
  Pick<InstanceType<typeof ToolRouterSession>, 'search' | 'execute' | 'update' | 'authorize'>;
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
const authConfigPage = z.object({
  items: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
        toolkit: z.object({ slug: schemaToolkit }),
        status: z.enum(['ENABLED', 'DISABLED']),
        auth_scheme: z.string().optional(),
        is_composio_managed: z.boolean().optional(),
        is_enabled_for_tool_router: z.boolean().optional(),
      }),
    )
    .max(200),
  next_cursor: z.string().max(2048).nullable().optional(),
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function providerFailure(action: string, result: Record<string, unknown>) {
  const data =
    result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : {};
  const detail = [result.error, data.error, data.message].find(
    (value) => value != null && value !== '',
  );
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? result);
  const log = typeof result.logId === 'string' ? ` (Composio log ${result.logId})` : '';
  return `Composio could not complete ${action}: ${text.slice(0, 4000)}${log}`;
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
    .safeParse(data.email ?? data.emailAddress ?? data.id);
  const name = accountDisplayName.safeParse(data.name ?? data.displayName ?? data.display_name);
  if (!email.success && !name.success) return;
  return {
    ...(email.success ? { accountEmail: email.data } : {}),
    ...(name.success ? { accountName: name.data } : {}),
  };
}

export function createComposioProvider(options: {
  apiKey?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  authConfigs?: Partial<Record<IntegrationService, string>>;
  client?: Composio;
  fileDownload?: Parameters<typeof createComposioFiles>[0];
  fileUploadRequest?: typeof fetch;
}): IntegrationProvider {
  let webhookUrl: string | undefined;
  if (options.webhookUrl !== undefined) {
    try {
      const url = new URL(options.webhookUrl);
      if (
        url.protocol !== 'https:' ||
        url.pathname !== '/api/webhooks/composio' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      webhookUrl = url.href;
    } catch {
      throw new Error('The Composio webhook URL is invalid.');
    }
  }
  const files = createComposioFiles(options.fileDownload);
  const identities = new Map<string, AccountIdentity>();
  const pendingIdentities = new Map<string, Promise<AccountIdentity>>();
  const authConfigs = Object.fromEntries(
    Object.entries(options.authConfigs ?? {})
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].trim().length > 0,
      )
      .map(([slug, id]) => [schemaToolkit.parse(slug), id]),
  );
  let catalog: { services: IntegrationServiceInfo[]; expiresAt: number } | undefined;
  let catalogRequest: Promise<IntegrationServiceInfo[]> | undefined;
  let catalogRetryAfter = 0;
  function connect(apiKey?: string) {
    return apiKey
      ? new Composio({
          apiKey,
          allowTracking: false,
          fileUploadDirs: false,
          toolkitVersions,
        })
      : undefined;
  }
  let client = options.client ?? connect(options.apiKey);
  function required() {
    if (!client) throw new Error('The connection provider is not configured.');
    return client;
  }
  async function ownedAccount(sdk: Composio, id: string, ownerId: string, signal: AbortSignal) {
    const account = accountRouting.parse(
      await sdk.getClient().connectedAccounts.retrieve(id, { signal }),
    );
    if (sdk !== client) throw new Error('The connection provider changed. Try again.');
    if (account.id !== id || account.user_id !== ownerId)
      throw new Error('This connected account is unavailable.');
    return account;
  }
  async function projectAuthConfig(sdk: Composio, slug: string, signal: AbortSignal) {
    const candidates = new Set<string>();
    const cursors = new Set<string>();
    let custom = false;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      signal.throwIfAborted();
      let result;
      try {
        result = authConfigPage.parse(
          await sdk.getClient().authConfigs.list(
            {
              toolkit_slug: slug,
              is_composio_managed: false,
              show_disabled: false,
              limit: 200,
              ...(cursor ? { cursor } : {}),
            },
            { signal },
          ),
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 403)
          throw new IntegrationAuthConfigurationError('permission');
        throw new Error('The project sign-in configuration could not be loaded.');
      }
      if (sdk !== client) throw new Error('The connection provider changed. Try again.');
      for (const item of result.items) {
        if (
          item.toolkit.slug !== slug ||
          item.status !== 'ENABLED' ||
          item.is_composio_managed !== false ||
          item.auth_scheme !== 'OAUTH2'
        )
          continue;
        custom = true;
        if (item.is_enabled_for_tool_router === true) candidates.add(item.id);
      }
      if (candidates.size > 1) throw new IntegrationAuthConfigurationError('ambiguous');
      if (!result.next_cursor) {
        if (custom && !candidates.size) throw new IntegrationAuthConfigurationError('unavailable');
        return candidates.values().next().value;
      }
      if (cursors.has(result.next_cursor))
        throw new Error('The project sign-in configuration could not be loaded.');
      cursors.add(result.next_cursor);
      cursor = result.next_cursor;
    }
    throw new Error('The project sign-in configuration could not be loaded.');
  }
  function legacyServices(): IntegrationServiceInfo[] {
    return [...new Set([...toolkits, ...Object.keys(authConfigs)])].map((slug) => ({
      slug,
      name: integrationServices[slug]?.name ?? slug.replaceAll('_', ' '),
      description: integrationServices[slug]?.description ?? '',
    }));
  }
  async function listServices(): Promise<IntegrationServiceInfo[]> {
    const sdk = required();
    if (catalog && catalog.expiresAt > Date.now()) return catalog.services;
    if (catalogRequest) return catalogRequest;
    const pending = (async () => {
      const operation = AbortSignal.timeout(10_000);
      const services = new Map(legacyServices().map((service) => [service.slug, service]));
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        operation.throwIfAborted();
        const page = catalogPage.parse(
          await sdk.getClient().toolkits.list(
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
      if (client !== sdk) throw new Error('The connection provider changed.');
      const result = [...services.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      catalog = { services: result, expiresAt: Date.now() + 15 * 60_000 };
      catalogRetryAfter = 0;
      return result;
    })().catch((error: unknown) => {
      if (client === sdk) catalogRetryAfter = Date.now() + 30_000;
      const status =
        error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (status === 403) throw new IntegrationCatalogAccessDenied();
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
    let services = legacyServices();
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
        inspection = await required().sessions.create(
          ownerId,
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
            premiumUsage: false,
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
            await required().sessions.delete(inspection.sessionId, {
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
    for (const endpoint of endpoints) {
      try {
        const response = await required().tools.proxyExecute(
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
  function session(
    value: ManagedSession,
    selectedToolkits: string[],
    sdk: Composio,
  ): IntegrationSession {
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
        if (sdk !== client) throw new Error('The connection provider changed. Try again.');
        if (
          !enabled.has(slug) ||
          (!toolkits.includes(slug) &&
            !authConfigs[slug] &&
            !(await listServices()).some((entry) => entry.slug === slug))
        )
          throw new Error('This app is not available for connection.');
        const signal = AbortSignal.timeout(15_000);
        if (googleOAuthToolkits.has(slug) && !authConfigs[slug]) {
          const id = await projectAuthConfig(sdk, slug, signal);
          if (sdk !== client) throw new Error('The connection provider changed. Try again.');
          if (id)
            await value.update(
              {
                authConfigs: { ...value.config?.auth_configs, ...authConfigs, [slug]: id },
                expectedConfigVersion: value.configVersion,
              },
              { signal },
            );
        }
        if (sdk !== client) throw new Error('The connection provider changed. Try again.');
        const result = await value.authorize(service, { callbackUrl }, { signal });
        if (sdk !== client) throw new Error('The connection provider changed. Try again.');
        if (
          !result.redirectUrl ||
          new URL(result.redirectUrl).origin !== 'https://connect.composio.dev'
        )
          throw new Error('The connection sign-in address is invalid.');
        return { accountId: result.id, url: result.redirectUrl };
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
          for (let start = 0; start < missing.length; start += 20) {
            const batch = missing.slice(start, start + 20);
            const operation = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
              : AbortSignal.timeout(15_000);
            const response = await required()
              .getClient()
              .toolRouter.session.executeMeta(
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
          throw new Error(`The app tool schemas could not be loaded: ${errorText(error)}`);
        }
      },
      async execute(action, args, accountId, signal) {
        signal?.throwIfAborted();
        actionToolkit(action);
        const result = await value.execute(
          action,
          args,
          accountId ? { account: accountId } : undefined,
          { signal, maxRetries: 0 } as Parameters<typeof value.execute>[3],
        );
        signal?.throwIfAborted();
        if (
          result.error != null ||
          ('successful' in result && result.successful === false) ||
          (result.data &&
            typeof result.data === 'object' &&
            'successful' in result.data &&
            result.data.successful === false)
        )
          throw new Error(providerFailure(action, result as Record<string, unknown>));
        return files(result, signal ?? new AbortController().signal);
      },
      async upload(action, file, signal) {
        const operation = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000);
        try {
          operation.throwIfAborted();
          const toolkit = actionToolkit(action);
          if (!file.bytes.byteLength || file.bytes.byteLength > 15 * 1024 * 1024)
            throw new Error('The file size is unsupported.');
          const result = await required()
            .getClient()
            .files.createPresignedURL(
              {
                filename: file.name,
                mimetype: file.mimeType,
                md5: createHash('md5').update(file.bytes).digest('hex'),
                tool_slug: action,
                toolkit_slug: toolkit,
              },
              { signal: operation, maxRetries: 0 },
            );
          operation.throwIfAborted();
          const upload = z
            .object({ key: z.string().min(1), new_presigned_url: z.url() })
            .parse(result);
          const request =
            options.fileUploadRequest ??
            ((url, init) => safeRemoteFetch(url, init, undefined, 15 * 1024 * 1024));
          const response = await request(upload.new_presigned_url, {
            method: 'PUT',
            body: Buffer.from(file.bytes),
            headers: { 'Content-Type': file.mimeType },
            signal: operation,
            redirect: 'error',
          });
          await response.body?.cancel();
          operation.throwIfAborted();
          if (!response.ok) throw new Error(`File storage returned HTTP ${response.status}.`);
          return { name: file.name, mimetype: file.mimeType, s3key: upload.key };
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          throw new Error(
            `The app file could not be uploaded: ${errorText(error).replace(/https?:\/\/\S+/g, '[file URL]')}`,
          );
        }
      },
    };
  }
  return {
    id: 'composio',
    get configured() {
      return Boolean(client);
    },
    setApiKey(apiKey) {
      client = connect(apiKey);
      catalog = undefined;
      catalogRequest = undefined;
      catalogRetryAfter = 0;
    },
    async verifyApiKey(apiKey) {
      try {
        await connect(apiKey)!.connectedAccounts.list(
          { limit: 1 },
          { signal: AbortSignal.timeout(10_000) },
        );
        return true;
      } catch (error) {
        if ([401, 403].includes((error as { status?: number }).status ?? 0)) return false;
        throw error;
      }
    },
    supportedServices: legacyServices().map((service) => service.slug),
    listServices,
    get webhooksConfigured() {
      return Boolean(client && options.webhookSecret);
    },
    supportsSubscriptions: ['gmail', 'googlecalendar', 'slack'],
    verificationEmails: (accountId, query, signal) =>
      readVerificationEmails(required().tools, accountId, query, signal),
    sentEmails: (accountId, signal) => readSentEmails(required().tools, accountId, signal),
    inboxSnippets: (accountId, signal) => readInboxSnippets(required().tools, accountId, signal),
    async pollInbox(accountId, cursor, signal) {
      const deadline = AbortSignal.timeout(25_000);
      const operation = AbortSignal.any([signal, deadline]);
      let phase = 'cursor';
      let category = 'cursor';
      let status: number | undefined;
      const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
      const historyId = z.string().regex(/^\d{1,32}$/);
      const addedMessage = z.object({ message: z.object({ id }) });
      const mailHeader = z.object({ name: z.string().max(100), value: z.string().max(8192) });
      const stateSchema = z.object({
        accountId: z.string().min(1).max(200),
        historyId,
        pageToken: z.string().min(1).max(2048).optional(),
        pending: z.array(id).max(1000).default([]),
        finalHistoryId: historyId.optional(),
      });
      async function get(path: string, parameters: Array<[string, string | number]>) {
        operation.throwIfAborted();
        phase = path === 'profile' ? 'baseline' : path === 'history' ? 'history' : 'message';
        category = 'request';
        status = undefined;
        const response = await required().tools.proxyExecute(
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
        if (response.status !== 200) throw new Error();
        category = 'response_size';
        if (JSON.stringify(response.data).length > 1_000_000) {
          if (path === 'history') throw new IntegrationInboxCursorExpired();
          throw new Error();
        }
        category = 'response';
        return response.data;
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
        for (const pendingId of state.pending.slice(0, 20)) {
          let response;
          try {
            response = await get(`messages/${pendingId}`, [
              ['format', 'metadata'],
              ['fields', 'id,threadId,internalDate,labelIds,payload/headers'],
            ]);
          } catch (error) {
            if (!signal.aborted && deadline.aborted && consumed) break;
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
              labelIds: z.array(z.string().max(200)).max(100),
              payload: z.object({
                headers: z.array(mailHeader).max(200).default([]),
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
        throw new Error('The Gmail inbox could not be checked.');
      }
    },
    async createSession(ownerId, accounts, signal) {
      signal?.throwIfAborted();
      const sdk = required();
      const connectedAccounts = Object.fromEntries(
        Object.entries(accounts).filter(
          (entry): entry is [string, string | string[]] => entry[1] !== undefined,
        ),
      );
      const selectedToolkits = [
        ...new Set([
          ...(await sessionServices(signal)),
          ...Object.keys(connectedAccounts).map((slug) => schemaToolkit.parse(slug)),
        ]),
      ];
      signal?.throwIfAborted();
      if (sdk !== client) throw new Error('The connection provider changed. Try again.');
      const value = await sdk.sessions.create(
        ownerId,
        {
          toolkits: selectedToolkits,
          connectedAccounts,
          multiAccount: {
            enable: true,
            maxAccountsPerToolkit: 10,
            requireExplicitSelection: true,
          },
          ...(Object.keys(authConfigs).length ? { authConfigs } : {}),
          manageConnections: false,
          sandbox: { enable: false },
          premiumUsage: false,
        },
        { signal },
      );
      if (sdk !== client) {
        await sdk.sessions
          .delete(value.sessionId, { signal: AbortSignal.timeout(5_000) })
          .catch(() => {});
        throw new Error('The connection provider changed. Try again.');
      }
      return session(value, selectedToolkits, sdk);
    },
    async deleteSession(id) {
      await required().sessions.delete(id, { signal: AbortSignal.timeout(5_000) });
    },
    async reconnectAccount(ownerId, service, accountId, callbackUrl) {
      const sdk = required();
      const slug = schemaToolkit.parse(service);
      const signal = AbortSignal.timeout(30_000);
      const original = await ownedAccount(sdk, accountId, ownerId, signal);
      if (original.toolkit.slug !== slug || original.auth_config.is_disabled)
        throw new Error('This connection sign-in configuration is unavailable.');
      const value = await sdk.sessions.create(
        ownerId,
        {
          toolkits: [slug],
          authConfigs: { [slug]: original.auth_config.id },
          multiAccount: {
            enable: true,
            maxAccountsPerToolkit: 10,
            requireExplicitSelection: true,
          },
          connectedAccounts: {},
          manageConnections: false,
          sandbox: { enable: false },
          premiumUsage: false,
        },
        { signal },
      );
      try {
        if (sdk !== client) throw new Error('The connection provider changed. Try again.');
        const result = await (value as ManagedSession).authorize(slug, { callbackUrl }, { signal });
        if (sdk !== client) throw new Error('The connection provider changed. Try again.');
        if (
          !result.redirectUrl ||
          new URL(result.redirectUrl).origin !== 'https://connect.composio.dev'
        )
          throw new Error('The connection sign-in address is invalid.');
        return {
          accountId: result.id,
          url: result.redirectUrl,
          authConfigId: original.auth_config.id,
        };
      } finally {
        await sdk.sessions
          .delete(value.sessionId, { signal: AbortSignal.timeout(5_000) })
          .catch(() => {});
      }
    },
    async inspectAccount(id, ownerId, inspection) {
      const sdk = required();
      const routing = inspection?.verifyOwner
        ? await ownedAccount(sdk, id, ownerId, AbortSignal.timeout(10_000))
        : undefined;
      const account = await sdk.connectedAccounts.get(id, {
        signal: AbortSignal.timeout(10_000),
      });
      if (sdk !== client) throw new Error('The connection provider changed. Try again.');
      const active = account.status === 'ACTIVE' && !account.isDisabled;
      const service = account.toolkit.slug.toLowerCase();
      if (routing && (routing.toolkit.slug !== service || routing.auth_config.is_disabled))
        throw new Error('This connected account is unavailable.');
      const details = active ? await identity(id, service, ownerId) : undefined;
      if (sdk !== client) throw new Error('The connection provider changed. Try again.');
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
      const sdk = required();
      if (ownerId) await ownedAccount(sdk, id, ownerId, AbortSignal.timeout(10_000));
      if (sdk !== client) throw new Error('The connection provider changed. Try again.');
      await sdk.connectedAccounts.delete(id);
      for (const key of identities.keys()) if (JSON.parse(key)[1] === id) identities.delete(key);
    },
    parseCallback(query) {
      const result = z
        .object({
          state: z.string(),
          connected_account_id: z.string().optional(),
          status: z.string(),
        })
        .parse(query);
      return {
        state: result.state,
        accountId: result.connected_account_id ?? '',
        success: result.status === 'success',
      };
    },
    async subscribe(ownerId, service, accountId) {
      if (!(service in subscriptions))
        throw new Error('Automatic updates are unavailable for this service.');
      const subscription = subscriptions[service as keyof typeof subscriptions];
      if (webhookUrl) {
        const sdk = required();
        const result = await sdk.getClient().triggerInstances.upsert(subscription.trigger, {
          connected_account_id: accountId,
          trigger_config: subscription.config,
          toolkit_versions: sdk.getConfig().toolkitVersions,
          user_id: ownerId,
          egress_url: webhookUrl,
        });
        return { id: result.trigger_id };
      }
      const result = await required().triggers.create(ownerId, subscription.trigger, {
        connectedAccountId: accountId,
        triggerConfig: subscription.config,
      });
      return { id: result.triggerId };
    },
    async unsubscribe(id) {
      await required().triggers.delete(id);
    },
    matchesSubscription(service, trigger) {
      return (
        service in subscriptions &&
        subscriptions[service as keyof typeof subscriptions].trigger === trigger
      );
    },
    async verifyWebhook(body, headers) {
      if (!options.webhookSecret) throw new Error('The webhook is not configured.');
      const result = await required().triggers.parse(
        { body, headers },
        { verifySecret: options.webhookSecret },
      );
      const event = result.payload;
      const id = String('id' in result.rawPayload ? result.rawPayload.id : headers['webhook-id']);
      if (!id || id.length > 200 || id === 'undefined')
        throw new Error('The event identity is invalid.');
      return {
        id,
        ownerId: event.userId,
        service: event.toolkitSlug.toLowerCase(),
        accountId: event.metadata.connectedAccount.id,
        subscriptionId: event.id,
        trigger: event.triggerSlug,
        data: event.payload ?? {},
      };
    },
  };
}
