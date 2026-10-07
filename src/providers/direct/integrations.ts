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

const linearTools = {
  LINEAR_LIST_PROJECTS: 'list_projects',
  LINEAR_GET_PROJECT: 'get_project',
  LINEAR_LIST_ISSUES: 'list_issues',
  LINEAR_GET_ISSUE: 'get_issue',
  LINEAR_LIST_TEAMS: 'list_teams',
  LINEAR_GET_STATUS_UPDATES: 'get_status_updates',
  LINEAR_GET_IMAGES: 'extract_images',
  LINEAR_GET_ATTACHMENT: 'get_attachment',
} as const;
const notionTools = {
  NOTION_RETRIEVE_PAGE: 'notion-fetch',
  NOTION_GET_PAGE_MARKDOWN: 'notion-fetch',
  NOTION_CREATE_PAGES: 'notion-create-pages',
  NOTION_UPDATE_PAGE: 'notion-update-page',
  NOTION_GET_ASYNC_TASK: 'notion-get-async-task',
} as const;

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
    if (account.service === 'notion') {
      const searching = action === 'NOTION_SEARCH_NOTION_PAGE';
      const mappedTool = notionTools[action as keyof typeof notionTools];
      if (!searching && !mappedTool) throw new Error('This Notion action is unavailable.');
      return mcp(
        'notion',
        account.accessToken,
        async (client) => {
          const tools = (await client.listTools()).tools;
          let toolName = searching ? 'notion-search' : mappedTool;
          if (searching) {
            if (!tools.some((tool) => tool.name === 'notion-get-tool-access'))
              throw new Error('The Notion search access check is unavailable.');
            const access = await client.callTool({ name: 'notion-get-tool-access', arguments: {} });
            if (access.isError)
              throw new Error(
                toolFailure('The Notion search access check failed', access, account.accessToken),
              );
            const blocks = Array.isArray(access.content)
              ? (access.content as Array<{ type: string; text?: string }>)
              : [];
            const content =
              access.structuredContent ??
              JSON.parse(blocks.find((item) => item.type === 'text')?.text ?? '{}');
            const map =
              content && typeof content === 'object' && 'current_tool_access' in content
                ? content.current_tool_access
                : undefined;
            const ai =
              map && typeof map === 'object' && 'ai_search' in map
                ? (map.ai_search as { status?: string })
                : undefined;
            if (
              ai?.status === 'available' &&
              tools.some((tool) => tool.name === 'notion-ai-search')
            )
              toolName = 'notion-ai-search';
            else if (
              !tools.some((tool) => tool.name === toolName) &&
              ['upgrade_required', 'plan_required'].includes(ai?.status ?? '') &&
              tools.some((tool) => tool.name === 'notion-ai-search')
            )
              toolName = 'notion-ai-search';
          }
          const selected = tools.find((tool) => tool.name === toolName);
          if (!selected) throw new Error('The Notion tool is unavailable for this account.');
          const result = await client.callTool({ name: selected.name, arguments: args });
          if (result.isError)
            throw new Error(toolFailure('The Notion request failed', result, account.accessToken));
          return mcpFiles(result);
        },
        signal,
      );
    }
    if (account.service === 'linear') {
      const toolName = linearTools[action as keyof typeof linearTools];
      if (!toolName) throw new Error('This Linear action is unavailable.');
      return mcp(
        'linear',
        account.accessToken,
        async (client) => {
          const result = await client.callTool({ name: toolName, arguments: args });
          if (result.isError)
            throw new Error(toolFailure('The Linear read failed', result, account.accessToken));
          return mcpFiles(result);
        },
        signal,
      );
    }
    throw new Error('This service action is unavailable.');
  }

  const tools = {
    NOTION_SEARCH_NOTION_PAGE: {
      description: 'Search Notion pages and projects by text.',
      parameters: { query: 'Search text.' },
    },
    NOTION_RETRIEVE_PAGE: {
      description: 'Read a Notion page by ID or URL.',
      parameters: { id: 'Page ID or URL.' },
    },
    NOTION_GET_PAGE_MARKDOWN: {
      description: 'Read a Notion page by ID or URL.',
      parameters: { id: 'Page ID or URL.' },
    },
    NOTION_CREATE_PAGES: {
      description: 'Create Notion pages, including entries under a database or data source.',
    },
    NOTION_UPDATE_PAGE: {
      description: 'Update the content or properties of a Notion page.',
    },
    NOTION_GET_ASYNC_TASK: {
      description: 'Check completion of a Notion page write that returned an async task.',
    },
    LINEAR_LIST_PROJECTS: {
      description: 'List Linear projects. Use query to find a project by name.',
      parameters: { query: 'Optional project name.', limit: 'Optional result limit.' },
    },
    LINEAR_GET_PROJECT: {
      description: 'Read a Linear project by ID or name.',
      parameters: { query: 'Project ID or name.' },
    },
    LINEAR_LIST_ISSUES: {
      description: 'List Linear issues. Filter by project and status to find next work.',
      parameters: { project: 'Project ID or name.', limit: 'Optional result limit.' },
    },
    LINEAR_GET_ISSUE: {
      description: 'Read a Linear issue by ID or identifier.',
      parameters: { id: 'Issue ID or identifier.' },
    },
    LINEAR_LIST_TEAMS: { description: 'List Linear teams.', parameters: {} },
    LINEAR_GET_STATUS_UPDATES: {
      description: 'Read recent Linear project status updates.',
      parameters: { project: 'Project ID or name.' },
    },
    LINEAR_GET_IMAGES: {
      description: 'Open images embedded in Linear issue or comment markdown.',
      parameters: { markdown: 'Markdown that contains the images.' },
    },
    LINEAR_GET_ATTACHMENT: {
      description: 'Open a Linear issue attachment by ID.',
      parameters: { id: 'Attachment ID.' },
    },
  };

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
          const matches: Record<string, unknown> = Object.fromEntries(
            Object.entries(tools).filter(([name]) =>
              words.includes('notion')
                ? name.startsWith('NOTION_')
                : words.includes('linear') || words.includes('project') || words.includes('issue')
                  ? name.startsWith('LINEAR_')
                  : true,
            ),
          );
          for (const service of supportedServices) {
            const actions = Object.keys(matches).filter((name) =>
              name.startsWith(`${service.toUpperCase()}_`),
            );
            if (!actions.length) continue;
            let available: Awaited<ReturnType<Client['listTools']>> | undefined;
            const ids = accounts[service];
            for (const id of typeof ids === 'string' ? [ids] : (ids ?? [])) {
              try {
                const account = await oauth.access(ownerId, id, signal);
                available = await mcp(
                  service,
                  account.accessToken,
                  (client) => client.listTools(),
                  signal,
                );
                break;
              } catch {
                signal?.throwIfAborted();
              }
            }
            if (!available) {
              for (const action of actions) delete matches[action];
              continue;
            }
            const names =
              service === 'linear'
                ? linearTools
                : {
                    NOTION_SEARCH_NOTION_PAGE: available.tools.some(
                      (entry) => entry.name === 'notion-search',
                    )
                      ? 'notion-search'
                      : 'notion-ai-search',
                    ...notionTools,
                  };
            for (const [action, toolName] of Object.entries(names)) {
              const tool = available.tools.find((entry) => entry.name === toolName);
              if (
                !tool ||
                (action === 'NOTION_SEARCH_NOTION_PAGE' &&
                  !available.tools.some((entry) => entry.name === 'notion-get-tool-access'))
              )
                delete matches[action];
              else if (matches[action])
                matches[action] = {
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                };
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
            details.accountName ??
            `${account.service === 'notion' ? 'Notion' : 'Linear'} account ${id.slice(0, 8)}`,
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
