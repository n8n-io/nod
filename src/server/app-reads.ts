import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Compile } from 'typebox/compile';
import type {
  ObservationBatch,
  ObservationProvider,
  ObservationQuery,
  ObservationSource,
} from '../ports/proactivity.ts';
import { withoutSchemaPatterns } from '../shared/json-schema.ts';

export type AppAccount = {
  connectionId: string;
  binding: string;
  slug: string;
  name: string;
  email?: string;
};
export type AppTool = {
  name: string;
  action: string;
  description: string;
  schema: Record<string, unknown>;
  pathId?: string;
  tool?: string;
};

export function appTools(raw: unknown, connectionId: string): AppTool[] {
  const search = raw as {
    tools?: Record<string, { description?: string; inputSchema?: Record<string, unknown> }>;
    discovered?: Array<{
      connectionId: string;
      paths: Array<{
        id: string;
        kind: string;
        endpoint?: string;
        tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
      }>;
    }>;
  };
  const tools = Object.entries(search?.tools ?? {}).flatMap(([action, tool]) =>
    tool.inputSchema
      ? [
          {
            name: action,
            action,
            description: tool.description ?? action,
            schema: tool.inputSchema,
          },
        ]
      : [],
  );
  return [
    ...tools,
    ...(search?.discovered ?? []).flatMap((account) =>
      account.connectionId !== connectionId
        ? []
        : account.paths.flatMap((path): AppTool[] => {
            if (path.kind === 'mcp')
              return (path.tools ?? []).map((tool) => ({
                name: `${path.id}:${tool.name}`,
                action: 'CONNECTED_MCP_CALL',
                description: tool.description ?? tool.name,
                schema: tool.inputSchema,
                pathId: path.id,
                tool: tool.name,
              }));
            if (path.kind === 'http')
              return [
                {
                  name: path.id,
                  action: 'CONNECTED_HTTP',
                  description: `Read a documented API path at ${path.endpoint}.`,
                  schema: {
                    type: 'object',
                    properties: {
                      method: { const: 'GET' },
                      path: { type: 'string', minLength: 1 },
                    },
                    required: ['method', 'path'],
                    additionalProperties: false,
                  },
                  pathId: path.id,
                },
              ];
            return [];
          }),
    ),
  ].slice(0, 40);
}

export function appToolArgs(tool: AppTool, args: Record<string, unknown>, connectionId: string) {
  if (!Compile(withoutSchemaPatterns(tool.schema) as Parameters<typeof Compile>[0]).Check(args))
    throw Object.assign(new Error('These arguments do not match the tool schema.'), {
      refused: true,
    });
  return {
    ...(tool.action === 'CONNECTED_MCP_CALL' ? { tool: tool.tool, input: args } : args),
    connectionId,
    ...(tool.pathId ? { pathId: tool.pathId } : {}),
  };
}

export const connectionSources = 'connections';
const checkInterval = 30 * 60000;
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createConnectionSources(options: {
  recorded(client?: PoolClient): Promise<
    Array<{
      connectionId: string;
      account: string;
      service: string;
      revision: string;
      active: boolean;
      eventDriven: boolean;
      changeToken?: string;
    }>
  >;
  readRecorded(
    connectionId: string,
    input: ObservationQuery,
    signal: AbortSignal,
  ): Promise<ObservationBatch>;
  accounts(client?: PoolClient): Promise<AppAccount[]>;
  search(account: AppAccount, query: string, signal: AbortSignal): Promise<unknown>;
  read(
    account: AppAccount,
    tool: AppTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}): ObservationProvider & { sources(client?: PoolClient): Promise<ObservationSource[]> } {
  const catalogs = new Map<string, { binding: string; tools: AppTool[] }>();
  async function readTools(
    connectionId: string,
    input: ObservationQuery,
    signal: AbortSignal,
  ): Promise<ObservationBatch> {
    const account = (await options.accounts()).find((item) => item.connectionId === connectionId);
    if (
      !account ||
      (input.revision !== undefined && input.revision !== fingerprint(account.binding))
    )
      throw Object.assign(new Error('The source changed before its read.'), { notRun: true });
    if (input.query) {
      const found = await options.search(account, input.query, signal);
      const tools = appTools(found, connectionId);
      const index = Object.entries(
        (found as { tools?: Record<string, { description?: string; hasFullSchema?: boolean }> })
          .tools ?? {},
      )
        .filter(([, tool]) => tool.hasFullSchema === false)
        .slice(0, 40)
        .map(([name, tool]) => ({ name, description: tool.description }));
      catalogs.set(connectionId, { binding: account.binding, tools });
      return {
        records: [
          {
            id: 'tools',
            version: fingerprint([tools, index]),
            available: true,
            data: {
              tools: tools.map(({ name, description, schema }) => ({ name, description, schema })),
              ...(index.length
                ? {
                    index,
                    schemaLookup:
                      'Search this source with an exact tool name as query to load its schema before calling it.',
                  }
                : {}),
            },
          },
        ],
      };
    }
    const catalog = catalogs.get(connectionId);
    const tool =
      catalog?.binding === account.binding
        ? catalog.tools.find((item) => item.name === input.tool)
        : undefined;
    if (!tool)
      throw Object.assign(
        new Error('Search this source with query first, then read one of the tools it returns.'),
        { refused: true },
      );
    const args = input.args ?? {};
    const result = await options.read(account, tool, appToolArgs(tool, args, connectionId), signal);
    return {
      records: [
        {
          id: fingerprint([tool.name, args]),
          version: fingerprint(result ?? null),
          available: true,
          data: { tool: tool.name, args, result },
        },
      ],
    };
  }
  return {
    id: connectionSources,
    async sources(client?: PoolClient): Promise<ObservationSource[]> {
      const [recorded, accounts] = await Promise.all([
        options.recorded(client),
        options.accounts(client),
      ]);
      return [
        ...recorded.map((source) => ({
          id: source.connectionId,
          label: source.account,
          description: 'Read-only records from ' + source.service,
          revision: source.revision,
          readable: source.active,
          pollIntervalMs: source.eventDriven ? undefined : checkInterval,
          changeToken: source.changeToken,
        })),
        ...accounts
          .filter(
            (account) => !recorded.some((source) => source.connectionId === account.connectionId),
          )
          .map((account) => ({
            id: account.connectionId,
            label: account.name,
            description: `Read-only data from ${account.name}, through its own read tools.`,
            revision: fingerprint(account.binding),
            readable: true,
            tools: true,
            pollIntervalMs: checkInterval,
          })),
      ];
    },
    read: (connectionId, input, signal) =>
      input.query || input.tool
        ? readTools(connectionId, input, signal)
        : options.readRecorded(connectionId, input, signal),
  };
}
