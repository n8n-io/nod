import { z } from 'zod';
import {
  McpRegistryError,
  type McpRegistry,
  type McpRegistryServer,
} from '../ports/mcp-registry.ts';
import { publicEndpoint, safeRemoteFetch } from './discovered/remote.ts';

const origin = 'https://registry.modelcontextprotocol.io';
const requested = 30;
const kept = 8;

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .optional()
    .catch(undefined);
const link = z
  .string()
  .transform((value) => URL.parse(value))
  .refine((url) => url?.protocol === 'https:')
  .transform((url) => url!.href)
  .optional()
  .catch(undefined);
const listing = z.object({
  server: z.object({
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
    title: text(100),
    description: text(500),
    websiteUrl: link,
    repository: z.object({ url: link }).optional().catch(undefined),
    remotes: z
      .array(
        z.object({
          type: z.string(),
          url: z.string().max(2048),
          headers: z
            .array(z.object({ name: z.string().max(100), isRequired: z.boolean().optional() }))
            .optional()
            .catch(undefined),
        }),
      )
      .optional()
      .catch(undefined),
  }),
  _meta: z
    .object({
      'io.modelcontextprotocol.registry/official': z.object({ status: z.string() }).optional(),
    })
    .optional()
    .catch(undefined),
});
const page = z.object({ servers: z.array(z.unknown()) });
const problem = z.object({ title: z.string().optional(), detail: z.string().optional() });

function aborted(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function createMcpRegistry({
  request = safeRemoteFetch,
  validate = publicEndpoint,
  timeoutMs = 5000,
}: {
  request?: typeof safeRemoteFetch;
  validate?: (url: string) => Promise<string>;
  timeoutMs?: number;
} = {}): McpRegistry {
  return {
    async search(query, signal) {
      const deadline = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      const timedOut = () => !signal?.aborted && deadline.aborted;
      const url = new URL('/v0.1/servers', origin);
      url.searchParams.set('search', query);
      url.searchParams.set('version', 'latest');
      url.searchParams.set('limit', String(requested));
      let response: Response;
      let raw: string;
      try {
        response = await Promise.race([
          request(url, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal: deadline,
          }),
          aborted(deadline),
        ]);
        raw = await Promise.race([response.text(), aborted(deadline)]);
      } catch (error) {
        if (timedOut())
          throw new McpRegistryError(
            `The MCP Registry did not answer within ${timeoutMs / 1000} seconds.`,
          );
        if (signal?.aborted) throw error;
        throw new McpRegistryError(
          `The MCP Registry could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const parsed = problem.safeParse(body);
        const reason = parsed.success
          ? [parsed.data.title, parsed.data.detail].filter(Boolean).join(': ')
          : raw.trim().slice(0, 200);
        throw new McpRegistryError(
          `The MCP Registry answered ${response.status}${reason ? `: ${reason}` : ''}.`,
          response.status,
        );
      }
      const servers = page.safeParse(body);
      if (!servers.success)
        throw new McpRegistryError(
          `The MCP Registry sent a response Nod could not read: ${servers.error.issues[0]?.message ?? 'unexpected shape'}.`,
        );
      const candidates = servers.data.servers.flatMap((item) => {
        const entry = listing.safeParse(item);
        if (!entry.success) return [];
        const status = entry.data._meta?.['io.modelcontextprotocol.registry/official']?.status;
        if (status && status !== 'active') return [];
        return [entry.data.server];
      });
      const checked = await Promise.all(
        candidates.slice(0, requested).map(async (server) => {
          const remotes: McpRegistryServer['remotes'] = [];
          for (const remote of server.remotes ?? []) {
            if (remotes.length === 3 || deadline.aborted) break;
            if (
              (remote.type !== 'streamable-http' && remote.type !== 'sse') ||
              /[{}]/.test(remote.url)
            )
              continue;
            const endpoint = await Promise.race([validate(remote.url), aborted(deadline)]).catch(
              () => undefined,
            );
            if (!endpoint) continue;
            const required = (remote.headers ?? [])
              .filter((header) => header.isRequired)
              .map((header) => header.name)
              .slice(0, 5);
            remotes.push({
              transport: remote.type,
              url: endpoint,
              ...(required.length ? { requiredHeaders: required } : {}),
            });
          }
          if (!remotes.length) return [];
          const result: McpRegistryServer = {
            name: server.name,
            version: server.version,
            ...(server.title ? { title: server.title } : {}),
            ...(server.description ? { description: server.description } : {}),
            ...(server.websiteUrl ? { websiteUrl: server.websiteUrl } : {}),
            ...(server.repository?.url ? { repository: server.repository.url } : {}),
            remotes,
          };
          return [result];
        }),
      );
      if (timedOut())
        throw new McpRegistryError(
          `The MCP Registry did not answer within ${timeoutMs / 1000} seconds.`,
        );
      signal?.throwIfAborted();
      return checked.flat().slice(0, kept);
    },
  };
}
