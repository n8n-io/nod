export interface McpRegistryServer {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  repository?: string;
  remotes: Array<{
    transport: 'streamable-http' | 'sse';
    url: string;
    requiredHeaders?: string[];
  }>;
}

export class McpRegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface McpRegistry {
  search(query: string, signal?: AbortSignal): Promise<McpRegistryServer[]>;
}
