import { Compile } from 'typebox/compile';

export type AppAccount = {
  connectionId: string;
  binding: string;
  slug: string;
  name: string;
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
  if (!Compile(tool.schema as Parameters<typeof Compile>[0]).Check(args))
    throw Object.assign(new Error('These arguments do not match the tool schema.'), {
      refused: true,
    });
  return {
    ...(tool.action === 'CONNECTED_MCP_CALL' ? { tool: tool.tool, input: args } : args),
    connectionId,
    ...(tool.pathId ? { pathId: tool.pathId } : {}),
  };
}
