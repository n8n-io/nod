import type { Pool } from 'pg';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { IntegrationProvider, IntegrationSession } from '../../ports/integrations.ts';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import type { AppGrantVault } from '../../ports/app-grants.ts';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDirectOAuth, ReconnectRequired, type Service } from './oauth.ts';
import { withDirectMcp } from './mcp.ts';
import { mcpFiles } from '../app-files.ts';

const labels = { notion: 'Notion', linear: 'Linear' } as const;

function actionName(service: Service, tool: string) {
  return `${service.toUpperCase()}_${tool
    .replace(/^notion-/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toUpperCase()}`;
}

function toolFailure(label: string, result: Record<string, unknown>, token: string) {
  const blocks = Array.isArray(result.content)
    ? (result.content as Array<{ type: string; text?: string }>)
    : [];
  const text = blocks
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  return `${label}: ${(text || JSON.stringify(result.content ?? null)).replaceAll(token, '[redacted]').slice(0, 4000)}`;
}
export function createDirectProvider(options: {
  pool: Pool;
  keyStore: CredentialKeyStore;
  grantVault: AppGrantVault;
  ownerId: string;
  request?: typeof fetch;
}): IntegrationProvider {
  const request: typeof fetch = (input, init) =>
    (options.request ?? fetch)(input, {
      ...init,
      redirect: 'error',
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  const supportedServices: Service[] = ['notion', 'linear'];
  const oauth = createDirectOAuth({
    pool: options.pool,
    keyStore: options.keyStore,
    grantVault: options.grantVault,
    ownerId: options.ownerId,
    request,
  });
  const mcp = <T>(
    service: Service,
    token: string,
    operation: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ) => withDirectMcp(service, token, request, operation, signal);

  async function execute(
    ownerId: string,
    action: string,
    args: Record<string, unknown>,
    id?: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!id) throw new Error('Choose a connected account.');
    const account = await oauth.access(ownerId, id, signal);
    const label = labels[account.service];
    return mcp(
      account.service,
      account.accessToken,
      async (client) => {
        const tool = (await client.listTools()).tools.find(
          (entry) => actionName(account.service, entry.name) === action,
        );
        if (!tool) throw new Error(`This ${label} action is unavailable.`);
        const result = await client.callTool({ name: tool.name, arguments: args });
        if (result.isError)
          throw new Error(toolFailure(`The ${label} request failed`, result, account.accessToken));
        return mcpFiles(result);
      },
      signal,
    );
  }

  return {
    id: 'direct',
    configured: options.keyStore.configured,
    supportedServices,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    async createSession(ownerId, accounts, signal) {
      signal?.throwIfAborted();
      const session: IntegrationSession = {
        id: ownerId,
        authorize: (service, callbackUrl) =>
          oauth.authorize(ownerId, service as Service, callbackUrl),
        async search(query, signal) {
          signal?.throwIfAborted();
          const words = query.toLowerCase();
          const matches: Record<string, unknown> = {};
          for (const service of supportedServices.filter((item) =>
            words.includes('notion')
              ? item === 'notion'
              : /linear|project|issue/.test(words)
                ? item === 'linear'
                : true,
          )) {
            const ids = accounts[service];
            for (const id of typeof ids === 'string' ? [ids] : (ids ?? [])) {
              try {
                const account = await oauth.access(ownerId, id, signal);
                const available = await mcp(
                  service,
                  account.accessToken,
                  (client) => client.listTools(),
                  signal,
                );
                for (const tool of available.tools)
                  matches[actionName(service, tool.name)] = {
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                  };
                break;
              } catch {
                signal?.throwIfAborted();
              }
            }
          }
          return { tools: matches, suggestions: [] };
        },
        execute: (action, args, accountId, signal) =>
          execute(ownerId, action, args, accountId, signal),
      };
      return session;
    },
    async restoreSession(id, signal) {
      return this.createSession(id, {}, signal);
    },
    async deleteSession() {},
    async inspectAccount(id, ownerId) {
      try {
        const account = await oauth.access(ownerId, id);
        const details = await mcp(account.service, account.accessToken, async (client) => {
          const available = await client.listTools();
          if (
            account.service !== 'notion' ||
            !available.tools.some((tool) => tool.name === 'notion-get-users')
          )
            return {};
          try {
            const result = await client.callTool({
              name: 'notion-get-users',
              arguments: { user_id: 'self' },
            });
            if (result.isError) return {};
            const blocks = Array.isArray(result.content)
              ? (result.content as Array<{ type: string; text?: string }>)
              : [];
            const content =
              result.structuredContent ??
              JSON.parse(blocks.find((item) => item.type === 'text')?.text ?? '{}');
            const data =
              content && typeof content === 'object' && 'self' in content
                ? content.self
                : content &&
                    typeof content === 'object' &&
                    'results' in content &&
                    Array.isArray(content.results)
                  ? content.results[0]
                  : content;
            if (!data || typeof data !== 'object') return {};
            const record = data as Record<string, unknown>;
            const workspace = record.workspace as Record<string, unknown> | undefined;
            const user = (
              record.user && typeof record.user === 'object' ? record.user : record
            ) as Record<string, unknown>;
            const name = z
              .string()
              .trim()
              .min(1)
              .max(200)
              .safeParse(workspace?.name ?? user.name);
            const email = z
              .email()
              .max(320)
              .safeParse(user.email ?? (user.person as Record<string, unknown> | undefined)?.email);
            return {
              ...(name.success ? { accountName: name.data } : {}),
              ...(email.success ? { accountEmail: email.data } : {}),
            };
          } catch {
            return {};
          }
        }).catch((error) => {
          throw error instanceof StreamableHTTPError && error.code === 401
            ? new ReconnectRequired(account.service)
            : error;
        });
        return {
          active: true,
          service: account.service,
          accountName:
            details.accountName ?? `${labels[account.service]} account ${id.slice(0, 8)}`,
          ...(details.accountEmail ? { accountEmail: details.accountEmail } : {}),
        };
      } catch (error) {
        if (error instanceof ReconnectRequired) return { active: false, service: error.service };
        throw error;
      }
    },
    deleteAccount: oauth.deleteAccount,
    parseCallback: oauth.parseCallback,
    async subscribe() {
      throw new Error('Subscriptions are unavailable.');
    },
    async unsubscribe() {},
    async verifyWebhook() {
      throw new Error('Webhooks are unavailable.');
    },
    matchesSubscription: () => false,
  };
}
