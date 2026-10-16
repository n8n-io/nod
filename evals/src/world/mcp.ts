import { createHash, randomBytes } from 'node:crypto';
import type { WriteKind } from './app-kit.ts';
import type { Page, Site } from './sites.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: WriteKind | ((args: Record<string, any>) => WriteKind);
  run(args: Record<string, any>): unknown;
}

export interface McpRecorder {
  calls: Array<{ at: number; slug: string; args: Record<string, any>; error?: string }>;
  writes: Array<{ at: number; slug: string; kind: WriteKind; args: Record<string, any> }>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Page => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const token = () => randomBytes(24).toString('base64url');

export function remoteMcp(options: {
  host: string;
  name: string;
  tools: McpTool[];
  recorder: McpRecorder;
}): Site {
  const { host, tools, recorder } = options;
  const origin = `https://${host}`;
  const resource = `${origin}/mcp`;
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const metadata = {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
  const issue = () => {
    const accessToken = token();
    const refreshToken = token();
    access.add(accessToken);
    refresh.add(refreshToken);
    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
    });
  };
  const call = (name: string, args: Record<string, any>) => {
    const tool = tools.find((item) => item.name === name);
    const entry: McpRecorder['calls'][number] = {
      at: Date.now(),
      slug: name,
      args: structuredClone(args),
    };
    recorder.calls.push(entry);
    try {
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = tool.run(args);
      if (tool.write)
        recorder.writes.push({
          at: Date.now(),
          slug: name,
          kind: typeof tool.write === 'function' ? tool.write(args) : tool.write,
          args: structuredClone(args),
        });
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: entry.error }], isError: true };
    }
  };
  const answer = (message: Record<string, any>) => {
    const { id, method, params } = message;
    if (id === undefined || id === null) return undefined;
    const result = (value: unknown) => ({ jsonrpc: '2.0', id, result: value });
    if (method === 'initialize')
      return result({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.name, version: '1.0.0' },
      });
    if (method === 'ping') return result({});
    if (method === 'tools/list')
      return result({
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    if (method === 'tools/call') return result(call(String(params?.name), params?.arguments ?? {}));
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
  return ({ url, request, form, text }) => {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path.startsWith('/.well-known/oauth-protected-resource'))
      return json({
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
      });
    if (path.startsWith('/.well-known/oauth-authorization-server')) return json(metadata);
    if (path.startsWith('/.well-known/')) return json({ error: 'not_found' }, 404);
    if (path === '/register' && request.method === 'POST') {
      const body = JSON.parse(text || '{}');
      const id = `client_${token()}`;
      clients.set(id, body.redirect_uris ?? []);
      return json(
        { ...body, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) },
        201,
      );
    }
    if (path === '/authorize') {
      const client = url.searchParams.get('client_id') ?? '';
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      if (!clients.get(client)?.includes(redirect) || !challenge)
        return json({ error: 'invalid_request' }, 400);
      const code = token();
      codes.set(code, { client, challenge, redirect });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      return { status: 302, headers: { Location: target.href }, body: '' };
    }
    if (path === '/token' && request.method === 'POST') {
      if (form.get('grant_type') === 'refresh_token') {
        const old = form.get('refresh_token') ?? '';
        if (!refresh.delete(old)) return json({ error: 'invalid_grant' }, 400);
        return issue();
      }
      const grant = codes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !grant ||
        grant.client !== form.get('client_id') ||
        grant.redirect !== form.get('redirect_uri') ||
        grant.challenge !== challenge
      )
        return json({ error: 'invalid_grant' }, 400);
      codes.delete(form.get('code') ?? '');
      return issue();
    }
    if (path === '/mcp') {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ''))?.[1];
      if (!bearer || !access.has(bearer))
        return json({ error: 'invalid_token' }, 401, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        });
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const message = JSON.parse(text || 'null');
      if (Array.isArray(message)) {
        const replies = message.map(answer).filter(Boolean);
        return replies.length ? json(replies) : { status: 202, body: '' };
      }
      const reply = answer(message ?? {});
      return reply ? json(reply) : { status: 202, body: '' };
    }
    return json({ error: 'not_found' }, 404);
  };
}
