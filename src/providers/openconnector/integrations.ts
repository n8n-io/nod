import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { integrationMetadata, type IntegrationServiceInfo } from '../../shared/integrations.ts';
import { loopbackHost } from '../../shared/loopback.ts';
import {
  IntegrationConnectionError,
  IntegrationPermissionError,
  type IntegrationProvider,
  type IntegrationSession,
} from '../../ports/integrations.ts';
import { googleActivity } from '../google/activity.ts';
import { pollGmailInbox } from '../google/gmail-inbox.ts';
import { readInboxSnippets, readInboxThreads, readSentEmails } from '../google/sent-email.ts';
import { type GoogleProxy, readVerificationEmails } from '../google/verification-email.ts';
import { createOpenConnectorFiles, markTransitFileInputs, unwrapTransitFileIds } from './files.ts';

const service = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const nodAction = /^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/;
const pending = 'request:';
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,190}$/);
const appId = z.string().min(1).max(200);
const label = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const managedConnection = z.object({
  id: appId,
  service,
  status: z.string(),
  alias: z.string().min(1).max(200),
  providerAccountId: z.string().nullish(),
  displayName: z.string().nullish(),
  accountLabel: z.string().nullish(),
});
const actionEntry = z.object({
  id: z.string().max(300),
  service: z.string(),
  description: z.string().max(10_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullish(),
});
const triggerCursor = z
  .object({ accountId: appId, checkpoint: z.object({ historyId: z.string().regex(/^\d{1,32}$/) }) })
  .strict();
const transitFileUpload = z.object({ fileId: z.string().min(1).max(200) });
const responseBytes = 64 * 1024 * 1024;
const signInWindow = 16 * 60_000;

class OpenConnectorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function connectionReason(status: number): IntegrationConnectionError['reason'] {
  return status === 401
    ? 'authorization'
    : status === 403
      ? 'permission'
      : status === 429
        ? 'rate_limit'
        : status === 408 || status === 504
          ? 'timeout'
          : status >= 500
            ? 'unavailable'
            : 'invalid_request';
}

function text(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 1000);
}

function openConnectorAction(id: string) {
  const [prefix, name, ...rest] = id.split('.');
  if (
    rest.length ||
    !prefix ||
    !name ||
    !service.safeParse(prefix).success ||
    !/^[a-z0-9_]+$/.test(name)
  )
    return undefined;
  return `${prefix}_${name}`.toUpperCase();
}

function failureCause(error: unknown) {
  const cause =
    error instanceof Error ? (error.cause as Record<string, unknown> | undefined) : undefined;
  const detail = [cause?.code, cause?.message].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return text([error instanceof Error ? error.message : String(error), ...detail].join(': '));
}

function accountBinding(saved: { service: string; providerAccountId?: string | null }) {
  const account = saved.providerAccountId?.trim();
  return account
    ? `openconnector:${createHash('sha256').update(`${saved.service}\n${account}`).digest('hex').slice(0, 40)}`
    : undefined;
}

export function createOpenConnectorProvider(options: {
  url: string;
  ownerId: string;
  runtimeToken: string;
  adminToken: string;
  request?: typeof fetch;
}): IntegrationProvider {
  const base = new URL(options.url);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('The OpenConnector address must be a plain http or https address.');
  if (base.protocol === 'http:' && !loopbackHost(base.hostname))
    throw new Error('The OpenConnector address must use https unless it is on this computer.');
  const root = base.href.replace(/\/+$/, '');
  const request = options.request ?? fetch;
  const tokens = { runtime: options.runtimeToken.trim(), admin: options.adminToken.trim() };
  if (!tokens.runtime || !tokens.admin)
    throw new Error('OpenConnector needs both a runtime token and an admin token.');
  const files = createOpenConnectorFiles({
    origin: root,
    ...(options.request ? { request: options.request } : {}),
  });
  let catalog: { services: IntegrationServiceInfo[]; expiresAt: number } | undefined;
  const uploads = new Set<string>();

  function owner(ownerId: string) {
    if (ownerId !== options.ownerId)
      throw new Error('This connected account owner is unavailable.');
  }

  async function call(
    what: string,
    scope: 'runtime' | 'admin',
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    input: {
      body?: unknown;
      form?: FormData;
      signal?: AbortSignal;
      timeout?: number;
      account?: string;
      phase?: IntegrationConnectionError['phase'];
    } = {},
  ): Promise<unknown> {
    const limit = input.timeout ?? 30_000;
    const deadline = AbortSignal.timeout(limit);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    input.signal?.throwIfAborted();
    let response: Response;
    let body: string;
    try {
      response = await request(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${tokens[scope]}`,
          accept: path === '/mcp' ? 'application/json, text/event-stream' : 'application/json',
          ...(input.body === undefined || input.form ? {} : { 'content-type': 'application/json' }),
          ...(input.account ? { 'x-oo-connector-app-id': input.account } : {}),
        },
        ...(input.form
          ? { body: input.form }
          : input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        redirect: 'error',
        signal,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > responseBytes) {
          await reader.cancel().catch(() => {});
          throw new OpenConnectorError(
            `OpenConnector returned more than 64 MB while trying to ${what}.`,
            response.status,
          );
        }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof OpenConnectorError) throw error;
      const timedOut = deadline.aborted;
      const reason = timedOut ? 'timeout' : 'unavailable';
      const detail = timedOut
        ? `OpenConnector at ${base.origin} did not answer within ${limit / 1000} s while trying to ${what}.`
        : `OpenConnector at ${base.origin} could not be reached while trying to ${what}: ${failureCause(error)}`;
      if (input.phase) {
        const failure = new IntegrationConnectionError(reason, input.phase);
        failure.message += ` ${detail}`;
        throw failure;
      }
      throw Object.assign(new OpenConnectorError(detail), { reason });
    }
    let payload: unknown;
    try {
      const event = body.startsWith('event:')
        ? body
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .at(-1)
            ?.slice(5)
        : body;
      payload = event ? JSON.parse(event) : undefined;
    } catch {
      payload = undefined;
    }
    const envelope =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (response.ok && envelope.success !== false) return payload;
    const nested =
      envelope.error && typeof envelope.error === 'object'
        ? (envelope.error as Record<string, unknown>)
        : {};
    const code = [envelope.errorCode, nested.code].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const message = [envelope.message, nested.message].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const detail = `${code ? `${text(code)}: ` : ''}${message ? text(message) : body ? text(body) : 'no details'} (HTTP ${response.status})`;
    if (code === 'scope_missing')
      throw new IntegrationPermissionError(`OpenConnector could not ${what}: ${detail}`);
    if (input.phase) {
      const failure = new IntegrationConnectionError(
        connectionReason(response.status),
        input.phase,
        response.status,
      );
      failure.message += ` OpenConnector: ${detail}`;
      throw failure;
    }
    throw new OpenConnectorError(
      `OpenConnector could not ${what}: ${detail}`,
      response.status,
      code,
    );
  }

  function shape<T>(what: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    throw new OpenConnectorError(
      `OpenConnector returned an unexpected response while trying to ${what}: ${issue?.path.join('.') || 'response'} ${issue?.message ?? 'is invalid'}.`,
    );
  }

  async function data(...args: Parameters<typeof call>) {
    return shape(
      args[0],
      z.object({ success: z.literal(true), data: z.unknown() }),
      await call(...args),
    ).data;
  }

  async function policyTool(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const what = 'check the runtime token policy';
    return shape(
      what,
      z.object({
        result: z.object({
          structuredContent: z.object({
            ok: z.boolean(),
            data: z.unknown().optional(),
            error: z.unknown().optional(),
          }),
        }),
      }),
      await call(what, 'runtime', 'POST', '/mcp', {
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } },
        ...(signal ? { signal } : {}),
        timeout: 10_000,
      }),
    ).result.structuredContent;
  }

  async function allowedActions(
    ids: string[],
    query: string,
    slugs: (string | undefined)[],
    signal?: AbortSignal,
  ) {
    if (!ids.length) return new Set<string>();
    if (!query) {
      const guides = await Promise.all(
        ids.map((id) => policyTool('get_action_guide', { actionId: id }, signal)),
      );
      return new Set(
        ids.filter((id, index) => {
          const guide = z
            .union([
              z.object({
                ok: z.literal(true),
                data: z.object({
                  capability: z.object({ policy: z.object({ allowed: z.boolean() }) }),
                }),
              }),
              z.object({
                ok: z.literal(false),
                error: z.object({ code: z.string(), message: z.string() }),
              }),
            ])
            .safeParse(guides[index]);
          if (!guide.success)
            throw new OpenConnectorError(
              `OpenConnector did not report whether the runtime token allows ${text(id)}.`,
            );
          if (guide.data.ok) return guide.data.data.capability.policy.allowed;
          if (guide.data.error.code === 'unknown_action') return false;
          throw new OpenConnectorError(
            `OpenConnector could not check whether the runtime token allows ${text(id)}: ${text(guide.data.error.code)}: ${text(guide.data.error.message)}`,
            undefined,
            guide.data.error.code,
          );
        }),
      );
    }
    const pages = await Promise.all(
      slugs.map((slug) =>
        policyTool(
          'search_actions',
          { query, limit: 20, ...(slug ? { service: slug } : {}) },
          signal,
        ),
      ),
    );
    return new Set(
      pages.flatMap((page) => {
        const parsed = z
          .object({ ok: z.literal(true), data: z.array(z.object({ id: z.string() })).max(50) })
          .safeParse(page);
        if (!parsed.success)
          throw new OpenConnectorError(
            'OpenConnector did not report which actions the runtime token allows.',
          );
        return parsed.data.data.map((entry) => entry.id);
      }),
    );
  }

  function googleProxy(service: string, api: string, label: string): GoogleProxy {
    return {
      async proxyExecute(input, { signal }) {
        if (!input.endpoint.startsWith(api))
          throw new Error(`OpenConnector reads only the ${label} API for this account.`);
        const what = `read ${label}`;
        const names = input.parameters.map((parameter) => parameter.name);
        const repeated = new Set(names.filter((name, index) => names.indexOf(name) !== index));
        for (const name of repeated)
          if (name !== 'metadataHeaders')
            throw new Error(
              `OpenConnector's ${label} proxy cannot send the query parameter ${name} more than once.`,
            );
        const response = shape(
          what,
          z.object({
            status: z.number().int(),
            bodyEncoding: z.string().optional(),
            data: z.unknown().optional(),
          }),
          await data(what, 'runtime', 'POST', `/v1/proxy/${service}`, {
            body: {
              method: input.method,
              endpoint: `/${input.endpoint.slice(api.length)}`,
              query: Object.fromEntries(
                input.parameters
                  .filter((parameter) => !repeated.has(parameter.name))
                  .map((parameter) => [parameter.name, String(parameter.value)]),
              ),
            },
            account: input.connectedAccountId,
            signal,
          }),
        );
        if (response.bodyEncoding)
          throw new OpenConnectorError(
            `OpenConnector returned ${label} data as ${text(response.bodyEncoding)} instead of JSON.`,
          );
        if (response.status === 204 && response.data == null) return { status: 200, data: {} };
        return { status: response.status, data: response.data };
      },
    };
  }
  const gmail = googleProxy('gmail', 'https://gmail.googleapis.com/gmail/v1/', 'Gmail');
  const calendar = googleProxy(
    'googlecalendar',
    'https://www.googleapis.com/calendar/v3/',
    'Google Calendar',
  );

  async function connection(id: string, signal?: AbortSignal) {
    const what = 'read the connected account';
    return shape(
      what,
      managedConnection,
      await data(
        what,
        'admin',
        'GET',
        `/v1/connections/by-id/${encodeURIComponent(appId.parse(id))}`,
        { signal },
      ),
    );
  }

  async function removeUpload(fileId: string) {
    uploads.delete(fileId);
    await call(
      'remove an uploaded file',
      'admin',
      'DELETE',
      `/api/files/${encodeURIComponent(fileId)}`,
      { timeout: 10_000 },
    ).catch(() => {});
  }

  async function disconnect(id: string) {
    const saved = await connection(id);
    await call(
      'disconnect the account',
      'admin',
      'DELETE',
      `/api/connections/${encodeURIComponent(saved.service)}`,
      { body: { connectionName: saved.alias } },
    );
  }

  async function abandon(id: string) {
    const what = 'check an abandoned sign-in';
    const result = shape(
      what,
      z.object({ status: z.string(), appId: appId.nullish() }),
      await data(what, 'admin', 'GET', `/v1/connection-requests/${encodeURIComponent(id)}`, {
        timeout: 10_000,
      }),
    );
    if (result.status === 'connected' && result.appId) await disconnect(result.appId);
    return result.status;
  }

  async function authorize(ownerId: string, slug: string, callbackUrl: string) {
    owner(ownerId);
    const id = service.parse(slug);
    const what = `start ${id} sign-in`;
    const started = shape(
      what,
      z.object({ authorizationUrl: z.string().url().max(16_000), connectionRequestId: requestId }),
      await data(what, 'admin', 'POST', `/v1/connections/${id}/connect`, {
        body: { returnUri: callbackUrl },
        phase: 'link',
      }),
    );
    return { accountId: `${pending}${started.connectionRequestId}`, url: started.authorizationUrl };
  }

  async function listServices(): Promise<IntegrationServiceInfo[]> {
    if (catalog && catalog.expiresAt > Date.now()) return catalog.services;
    const configs = shape(
      'load OAuth client settings',
      z
        .array(
          z.object({
            service: z.string(),
            configured: z.boolean().optional(),
            oauthSource: z.object({ mode: z.string() }).optional(),
          }),
        )
        .max(10_000),
      await call('load OAuth client settings', 'admin', 'GET', '/api/oauth/configs', {
        phase: 'session',
      }),
    );
    const slugs = [
      ...new Set(
        configs
          .filter(
            (entry) =>
              entry.configured &&
              (entry.oauthSource?.mode ?? 'local') === 'local' &&
              service.safeParse(entry.service).success,
          )
          .map((entry) => entry.service),
      ),
    ];
    const providers = slugs.length
      ? shape(
          'load the app catalog',
          z.array(
            z.object({
              service: z.string(),
              displayName: z.string().max(200).optional(),
              categories: z
                .array(z.object({ displayName: z.string() }))
                .max(32)
                .optional(),
            }),
          ),
          await data(
            'load the app catalog',
            'runtime',
            'GET',
            `/v1/providers?${slugs.map((slug) => `service=${encodeURIComponent(slug)}`).join('&')}`,
            { phase: 'session' },
          ),
        )
      : [];
    const services = slugs.map((slug) => {
      const entry = providers.find((item) => item.service === slug);
      const name = label.safeParse(entry?.displayName);
      const categories = [
        ...new Set(
          (entry?.categories ?? []).flatMap((category) => {
            const parsed = label.max(80).safeParse(category.displayName);
            return parsed.success ? [parsed.data] : [];
          }),
        ),
      ].slice(0, 12);
      return {
        slug,
        ...integrationMetadata(slug, name.success ? { name: name.data } : undefined),
        ...(categories.length ? { categories } : {}),
      };
    });
    catalog = { services, expiresAt: Date.now() + 60_000 };
    return services;
  }

  function session(accounts: Map<string, Set<string>>): IntegrationSession {
    function uploaded(value: unknown): string[] {
      if (Array.isArray(value)) return value.flatMap(uploaded);
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, item]) =>
        key === 'fileId' && typeof item === 'string' && uploads.has(item) ? [item] : uploaded(item),
      );
    }
    const enabled = [...accounts.keys()].sort((left, right) => right.length - left.length);
    function actionId(action: string) {
      if (!nodAction.test(action)) return undefined;
      const match = enabled.find((slug) => action.startsWith(`${slug.toUpperCase()}_`));
      return match ? `${match}.${action.slice(match.length + 1).toLowerCase()}` : undefined;
    }
    return {
      id: randomUUID(),
      authorize: (slug, callbackUrl) => authorize(options.ownerId, slug, callbackUrl),
      async search(query, signal) {
        const names = query.split(/[\s,]+/).filter(Boolean);
        const exact =
          names.length > 0 &&
          names.length <= 20 &&
          names.every((name) => actionId(name) !== undefined);
        const found = exact
          ? await Promise.all(
              names.map((name) =>
                data(
                  `read the ${name} schema`,
                  'runtime',
                  'GET',
                  `/v1/actions/${encodeURIComponent(actionId(name)!)}`,
                  { signal },
                ).catch((error: unknown) => {
                  if (error instanceof OpenConnectorError && error.code === 'unknown_action')
                    return undefined;
                  throw error;
                }),
              ),
            )
          : (
              await Promise.all(
                (enabled.length ? enabled : [undefined]).map(async (slug) =>
                  shape(
                    'search app actions',
                    z.array(z.unknown()).max(50),
                    await data(
                      'search app actions',
                      'runtime',
                      'GET',
                      `/v1/actions/search?${new URLSearchParams({
                        q: query.slice(0, 256),
                        limit: '10',
                        ...(slug ? { service: slug } : {}),
                      })}`,
                      { signal },
                    ),
                  ),
                ),
              )
            ).flat();
        signal?.throwIfAborted();
        const entries = found.flatMap((value) => {
          const entry = actionEntry.safeParse(value);
          return entry.success ? [entry.data] : [];
        });
        if (!entries.length && found.some((value) => value !== undefined))
          shape(
            'search app actions',
            actionEntry,
            found.find((value) => value !== undefined),
          );
        const allowed = await allowedActions(
          entries.map((entry) => entry.id),
          exact ? '' : query.slice(0, 256),
          enabled.length ? enabled : [undefined],
          signal,
        );
        signal?.throwIfAborted();
        const tools: Record<string, unknown> = {};
        for (const entry of entries) {
          if (!allowed.has(entry.id)) continue;
          const name = openConnectorAction(entry.id);
          if (
            !name ||
            !entry.id.startsWith(`${entry.service}.`) ||
            (enabled.length && actionId(name) !== entry.id)
          )
            continue;
          tools[name] = {
            toolkit: entry.service,
            description: entry.description ?? name,
            inputSchema: markTransitFileInputs(entry.inputSchema),
            ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
          };
        }
        return { tools, suggestions: [] };
      },
      async offers(action, signal) {
        const id = actionId(action);
        if (!id) throw new Error('This action is outside the connected apps.');
        const allowed = await allowedActions([id], '', [], signal);
        signal?.throwIfAborted();
        return allowed.has(id);
      },
      async execute(action, args, accountId, signal) {
        signal?.throwIfAborted();
        const id = actionId(action);
        if (!id) throw new Error('This action is outside the connected apps.');
        if (!accountId || !accounts.get(id.split('.')[0]!)?.has(accountId))
          throw new Error('Choose a connected account for this action.');
        const input = unwrapTransitFileIds(args);
        const sent = uploaded(input);
        const result = await data(
          `run ${action}`,
          'runtime',
          'POST',
          `/v1/actions/${encodeURIComponent(id)}`,
          { body: { input }, account: accountId, signal, timeout: 300_000 },
        ).finally(() => Promise.all(sent.map(removeUpload)));
        signal?.throwIfAborted();
        return { data: await files(result ?? null, signal ?? new AbortController().signal) };
      },
      async upload(_action, file, signal) {
        signal?.throwIfAborted();
        const what = 'upload the file for this app';
        const form = new FormData();
        form.set(
          'file',
          new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType }),
          file.name,
        );
        const stored = shape(
          what,
          transitFileUpload,
          await call(what, 'admin', 'POST', '/api/files', {
            form,
            ...(signal ? { signal } : {}),
            timeout: 300_000,
          }),
        );
        if (signal?.aborted) {
          await removeUpload(stored.fileId);
          signal.throwIfAborted();
        }
        uploads.add(stored.fileId);
        return { fileId: stored.fileId };
      },
    };
  }

  return {
    id: 'openconnector',
    configured: true,
    configurationId: `openconnector:${createHash('sha256').update(root).digest('hex').slice(0, 32)}`,
    listServices,
    webhooksConfigured: false,
    supportsSubscriptions: [],
    authorize,
    accountBoundReconnect: true,
    async reconnectAccount(ownerId, slug, accountId, callbackUrl) {
      owner(ownerId);
      const saved = await connection(accountId);
      if (saved.service !== service.parse(slug))
        throw new Error('This connected account is unavailable.');
      const authConfigId = accountBinding(saved);
      if (!authConfigId)
        throw new Error(
          'OpenConnector did not report the provider account of this connection, so Nod cannot check that a reconnect keeps the same account. Add the account again instead.',
        );
      return { ...(await authorize(ownerId, saved.service, callbackUrl)), authConfigId };
    },
    async parseCallback(query, request) {
      const { state } = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(query);
      if (!request?.accountId.startsWith(pending))
        throw new Error('This connection request is unavailable.');
      const id = requestId.parse(request.accountId.slice(pending.length));
      const what = 'confirm the sign-in';
      const result = shape(
        what,
        z.object({
          service: z.string(),
          status: z.enum(['initiated', 'connected', 'failed', 'expired']),
          appId: appId.nullish(),
        }),
        await data(what, 'admin', 'GET', `/v1/connection-requests/${encodeURIComponent(id)}`, {
          timeout: 10_000,
        }),
      );
      if (result.service !== request.service)
        throw new Error(
          `This OpenConnector sign-in belongs to ${text(result.service)}, not ${request.service}.`,
        );
      if (result.status === 'initiated')
        throw new Error('OpenConnector has not finished this sign-in.');
      if (result.status !== 'connected' || !result.appId)
        return { state, accountId: request.accountId, success: false };
      return { state, accountId: result.appId, pendingAccountId: request.accountId, success: true };
    },
    async createSession(ownerId, selected, signal) {
      owner(ownerId);
      signal?.throwIfAborted();
      const accounts = new Map<string, Set<string>>();
      for (const [slug, ids] of Object.entries(selected)) {
        if (ids === undefined || !service.safeParse(slug).success) continue;
        accounts.set(slug, new Set(Array.isArray(ids) ? ids : [ids]));
      }
      return session(accounts);
    },
    async deleteSession() {},
    async inspectAccount(id, ownerId) {
      owner(ownerId);
      const saved = await connection(id);
      const email = z
        .email()
        .max(320)
        .safeParse(saved.accountLabel ?? saved.displayName);
      const name = label.safeParse(saved.displayName);
      return {
        active: saved.status === 'active',
        service: saved.service,
        ...(name.success && name.data !== (email.success ? email.data : undefined)
          ? { accountName: name.data }
          : {}),
        ...(email.success ? { accountEmail: email.data } : {}),
        ...(accountBinding(saved) ? { authConfigId: accountBinding(saved) } : {}),
      };
    },
    async deleteAccount(id, ownerId) {
      if (ownerId) owner(ownerId);
      if (!id.startsWith(pending)) return disconnect(id);
      const request = requestId.parse(id.slice(pending.length));
      if ((await abandon(request)) !== 'initiated') return;
      setTimeout(() => void abandon(request).catch(() => {}), signInWindow).unref();
    },
    verificationEmails: (accountId, query, signal) =>
      readVerificationEmails(gmail, accountId, query, signal),
    sentEmails: (accountId, signal) => readSentEmails(gmail, accountId, signal),
    inboxSnippets: (accountId, signal) => readInboxSnippets(gmail, accountId, signal),
    inboxThreads: (accountId, signal) => readInboxThreads(gmail, accountId, signal),
    activity: {
      gmail: googleActivity(gmail).gmail!,
      googlecalendar: googleActivity(calendar).googlecalendar!,
    },
    pollInbox(accountId, cursor, signal) {
      let stored: unknown;
      try {
        stored = cursor === null ? undefined : JSON.parse(cursor);
      } catch {
        stored = undefined;
      }
      const trigger = triggerCursor.safeParse(stored);
      return pollGmailInbox(
        gmail,
        accountId,
        trigger.success
          ? JSON.stringify({
              accountId: trigger.data.accountId,
              historyId: trigger.data.checkpoint.historyId,
            })
          : cursor,
        signal,
      );
    },
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
