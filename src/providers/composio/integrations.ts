import { Composio } from '@composio/core';
import { z } from 'zod';
import { integrationServiceIds } from '../../shared/integrations.ts';
import { createIntegrationFileDownloader, downloadArguments } from './downloads.ts';
import { readVerificationEmails } from './verification-email.ts';
import type {
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../../ports/integrations.ts';

const toolkits = integrationServiceIds.filter((service) => service !== 'linear');
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
  notion: { trigger: 'NOTION_PAGE_CONTENT_UPDATED', config: {} },
} as const;
type ManagedSession = Awaited<ReturnType<Composio['sessions']['use']>>;
type AccountIdentity = { expiresAt: number; accountName?: string; accountEmail?: string };
const toolSlug = z
  .string()
  .max(200)
  .regex(/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/);
const writeHints = ['destructiveHint', 'createHint', 'updateHint', 'deleteHint'];
const schemaToolkit = z.string().toLowerCase().pipe(z.enum(integrationServiceIds));

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
  notion: { action: 'NOTION_WHO_AM_I', args: {} },
  googlecalendar: { action: 'GOOGLECALENDAR_GET_CURRENT_USER', args: {} },
  googledrive: {
    action: 'GOOGLEDRIVE_GET_ABOUT',
    args: { fields: 'user(displayName,emailAddress)' },
  },
} as const;

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
    if (
      service === 'notion' &&
      (typeof data.workspace_name === 'string' || typeof data.owner_email === 'string')
    ) {
      data = { name: data.workspace_name ?? data.name, email: data.owner_email };
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
  const name = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .safeParse(data.name ?? data.displayName ?? data.display_name);
  if (!email.success && !name.success) return;
  return {
    ...(email.success ? { accountEmail: email.data } : {}),
    ...(name.success ? { accountName: name.data.replace(/[\u0000-\u001f]/g, ' ') } : {}),
  };
}

export function createComposioProvider(options: {
  apiKey?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  authConfigs?: Partial<Record<IntegrationService, string>>;
  client?: Composio;
  fileDownload?: Parameters<typeof createIntegrationFileDownloader>[0];
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
  const downloadFile = createIntegrationFileDownloader(options.fileDownload);
  const identities = new Map<string, AccountIdentity>();
  const pendingIdentities = new Map<string, Promise<AccountIdentity>>();
  const readTools = new Map<string, Promise<boolean>>();
  const authConfigs = Object.fromEntries(
    Object.entries(options.authConfigs ?? {}).filter(
      ([, id]) => typeof id === 'string' && id.trim().length > 0,
    ),
  );
  const client =
    options.client ??
    (options.apiKey
      ? new Composio({
          apiKey: options.apiKey,
          allowTracking: false,
          fileUploadDirs: false,
          toolkitVersions: {
            gmail: '20260915_00',
            googlecalendar: '20260915_00',
            googledrive: '20260921_00',
            googlesheets: '20260915_00',
            googledocs: '20260826_00',
            slack: '20260915_00',
            notion: '20260915_00',
          },
        })
      : undefined);
  function required() {
    if (!client) throw new Error('The connection provider is not configured.');
    return client;
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
  function session(value: ManagedSession): IntegrationSession {
    return {
      id: value.sessionId,
      async authorize(service, callbackUrl) {
        const result = await value.authorize(service, { callbackUrl });
        if (
          !result.redirectUrl ||
          new URL(result.redirectUrl).origin !== 'https://connect.composio.dev'
        )
          throw new Error('The connection sign-in address is invalid.');
        return { accountId: result.id, url: result.redirectUrl };
      },
      async search(query) {
        try {
          const result = await value.search({ query, toolkits });
          if (!result.success || result.error != null) throw new Error();
          const entries = Object.entries(result.toolSchemas).map(
            ([slug, tool]) =>
              [slug, { ...tool, toolkit: schemaToolkit.parse(tool.toolkit) }] as const,
          );
          const advertised = new Set(entries.map(([slug]) => slug));
          for (const [slug, tool] of entries) {
            toolSlug.parse(slug);
            if (tool.toolSlug !== slug || !slug.startsWith(`${tool.toolkit.toUpperCase()}_`))
              throw new Error();
          }
          const missing = entries.filter(
            ([, tool]) =>
              tool.hasFullSchema === false || !schemaFields.safeParse(tool.inputSchema).success,
          );
          if (missing.length > 20) throw new Error();
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
          if (missing.length) {
            const signal = AbortSignal.timeout(15_000);
            const response = await required()
              .getClient()
              .toolRouter.session.executeMeta(
                value.sessionId,
                {
                  slug: 'COMPOSIO_GET_TOOL_SCHEMAS',
                  arguments: {
                    tool_slugs: missing.map(([slug]) => slug),
                    include: ['input_schema'],
                  },
                },
                { signal, maxRetries: 0 },
              );
            signal.throwIfAborted();
            const envelope = toolSchemasResponse.parse(response).data;
            const schemas =
              'tool_schemas' in envelope ? envelope.tool_schemas : envelope.data.tool_schemas;
            if (Object.keys(schemas).length !== missing.length) throw new Error();
            for (const [slug, tool] of missing) {
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
          throw new Error(`The app tool schemas could not be loaded: ${errorText(error)}`);
        }
      },
      async download(action, args, accountId, signal) {
        const operation = signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000);
        try {
          operation.throwIfAborted();
          const input = downloadArguments(action, args);
          const result = await required()
            .getClient()
            .toolRouter.session.execute(
              value.sessionId,
              { tool_slug: action, arguments: input, account: accountId },
              { signal: operation },
            );
          operation.throwIfAborted();
          return await downloadFile(action, result, operation);
        } catch (error) {
          if (signal?.aborted) throw new DOMException('File download was cancelled.', 'AbortError');
          throw new Error(
            `The app file could not be downloaded: ${errorText(error).replace(/https?:\/\/\S+/g, '[file URL]')}`,
          );
        }
      },
      async execute(action, args, accountId) {
        const result = await value.execute(
          action,
          args,
          accountId ? { account: accountId } : undefined,
        );
        if (
          result.error != null ||
          ('successful' in result && result.successful === false) ||
          (result.data &&
            typeof result.data === 'object' &&
            'successful' in result.data &&
            result.data.successful === false)
        )
          throw new Error(providerFailure(action, result as Record<string, unknown>));
        return result;
      },
    };
  }
  return {
    id: 'composio',
    configured: Boolean(client),
    supportedServices: toolkits,
    webhooksConfigured: Boolean(client && options.webhookSecret),
    supportsSubscriptions: ['gmail', 'googlecalendar', 'slack', 'notion'],
    verificationEmails: (accountId, query, signal) =>
      readVerificationEmails(required().tools, accountId, query, signal),
    async createSession(ownerId, accounts) {
      return session(
        await required().sessions.create(ownerId, {
          toolkits,
          connectedAccounts: accounts,
          multiAccount: { enable: true, maxAccountsPerToolkit: 10, requireExplicitSelection: true },
          ...(Object.keys(authConfigs).length ? { authConfigs } : {}),
          manageConnections: false,
          sandbox: { enable: false },
          premiumUsage: false,
        }),
      );
    },
    async restoreSession(id) {
      return session(await required().sessions.use(id));
    },
    async deleteSession(id) {
      await required().sessions.delete(id, { signal: AbortSignal.timeout(5_000) });
    },
    async readOnly(action) {
      if (!toolSlug.safeParse(action).success) return false;
      let pending = readTools.get(action);
      if (!pending) {
        pending = required()
          .tools.getRawComposioToolBySlug(action, undefined, {
            signal: AbortSignal.timeout(10_000),
          })
          .then(
            ({ tags = [] }) =>
              tags.includes('readOnlyHint') && !tags.some((tag) => writeHints.includes(tag)),
          );
        readTools.set(action, pending);
        pending.catch(() => readTools.delete(action));
      }
      return pending.catch(() => false);
    },
    async inspectAccount(id, ownerId) {
      const account = await required().connectedAccounts.get(id, {
        signal: AbortSignal.timeout(10_000),
      });
      const active = account.status === 'ACTIVE' && !account.isDisabled;
      const service = account.toolkit.slug.toLowerCase();
      const details = active ? await identity(id, service, ownerId) : undefined;
      return {
        active,
        service,
        ...(details?.accountName ? { accountName: details.accountName } : {}),
        ...(details?.accountEmail ? { accountEmail: details.accountEmail } : {}),
      };
    },
    async deleteAccount(id) {
      await required().connectedAccounts.delete(id);
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
