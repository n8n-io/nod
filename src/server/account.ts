import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountUser, SessionResponse } from '../shared/account.ts';
import type { AuthenticatedSession, AuthenticationProvider } from '../ports/authentication.ts';
import type { AccountStore } from './account-store.ts';
import type { Analytics } from './analytics.ts';

const accountUpdate = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    onboardingCompleted: z.boolean().optional(),
    usageData: z.boolean().optional(),
  })
  .strict();

export function authenticationHeaders(request: FastifyRequest) {
  const headers = new Headers();
  for (const name of ['cookie', 'origin', 'user-agent', 'content-type']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

export function sendFetchResponse(reply: FastifyReply, response: Response) {
  for (const [name, value] of response.headers) {
    if (!['set-cookie', 'content-length', 'transfer-encoding', 'connection'].includes(name))
      reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  reply.code(response.status);
  return reply.send(response.body ? Readable.fromWeb(response.body as never) : undefined);
}

export function createAccountSession(options: {
  accounts: AccountStore;
  origin: string;
  authentication?: AuthenticationProvider;
  localUser?: AccountUser;
  developerIds?: ReadonlySet<string>;
  analytics?: Analytics;
  prepare?(ownerId: string): Promise<void>;
  start?(ownerId: string, name?: string): Promise<void>;
  warm?(ownerId: string): void;
  withProfile?(
    session: AuthenticatedSession,
    name: string | undefined,
    operation: () => Promise<void>,
    current: () => Promise<boolean>,
  ): Promise<void>;
}) {
  const origin = new URL(options.origin).origin;
  const mode = options.authentication ? 'google' : 'local';
  const principals = new WeakMap<FastifyRequest, AuthenticatedSession | null>();
  async function principal(request: FastifyRequest, reply: FastifyReply) {
    if (principals.has(request)) return principals.get(request) ?? null;
    const session = options.authentication
      ? await options.authentication.session(authenticationHeaders(request), true)
      : options.localUser
        ? { id: 'local', expiresAt: new Date('9999-01-01'), user: options.localUser }
        : null;
    if (session?.cookies) reply.header('set-cookie', session.cookies);
    principals.set(request, session);
    return session;
  }
  async function response(request: FastifyRequest, reply: FastifyReply): Promise<SessionResponse> {
    const session = await principal(request, reply);
    const account = session ? await options.accounts.read(session.user.id) : null;
    if (session && account) options.analytics?.setUsageData(session.user.id, account.usageData);
    return {
      auth: { mode, googleAvailable: options.authentication?.configured ?? false },
      user: session
        ? {
            ...session.user,
            name: account?.displayName ?? session.user.name,
            avatarUrl:
              session.avatarSource && options.authentication?.avatar
                ? `/api/account/avatar?account=${encodeURIComponent(session.user.id)}`
                : null,
          }
        : null,
      settings: account
        ? {
            theme: account.theme,
            onboardingCompleted: account.onboardingCompleted,
            usageData: account.usageData,
          }
        : null,
      capabilities: {
        developer: Boolean(session && options.developerIds?.has(session.user.id)),
      },
      ...(options.analytics
        ? { analytics: options.analytics.configuration(session?.user.id ?? null) }
        : {}),
    };
  }
  async function requirePrincipal(request: FastifyRequest, reply: FastifyReply) {
    const session = await principal(request, reply);
    const expected = request.headers['x-otto-account'];
    if (!session || (expected !== undefined && expected !== session.user.id)) {
      reply.code(401).send({ error: 'Sign in to continue.' });
      return null;
    }
    return session;
  }
  function sameOrigin(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      reply.code(403).send({ error: 'This origin is not permitted.' });
      return false;
    }
    return true;
  }
  async function prepare(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AuthenticatedSession,
  ) {
    try {
      await options.prepare?.(session.user.id);
    } catch {
      reply.code(503).send({ error: 'Setup could not be completed. Try again.' });
      return false;
    }
    return currentPrincipal(request, reply, session);
  }
  async function currentPrincipal(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AuthenticatedSession,
  ) {
    if (options.authentication) {
      const current = await options.authentication.session(authenticationHeaders(request));
      if (
        !current ||
        current.id !== session.id ||
        current.user.id !== session.user.id ||
        current.expiresAt <= new Date()
      ) {
        reply.code(401).send({ error: 'Sign in to continue.' });
        return false;
      }
    }
    return true;
  }
  async function start(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AuthenticatedSession,
    name?: string,
    complete?: () => Promise<unknown>,
  ) {
    let completed = false;
    const operation = async () => {
      if (!(await currentPrincipal(request, reply, session))) return;
      await options.start?.(
        session.user.id,
        (
          name ??
          (await options.accounts.read(session.user.id)).displayName ??
          (options.authentication ? session.user.name : undefined)
        )?.slice(0, 100),
      );
      await complete?.();
      completed = true;
    };
    try {
      const current = () => currentPrincipal(request, reply, session);
      if (!(await current())) return false;
      if (options.withProfile) await options.withProfile(session, name, operation, current);
      else await operation();
      return completed;
    } catch {
      reply.code(503).send({ error: 'Setup could not be completed. Try again.' });
      return false;
    }
  }
  function register(app: FastifyInstance) {
    app.get('/api/session', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const result = await response(request, reply);
      if (result.user) options.warm?.(result.user.id);
      return result;
    });
    app.get('/api/account/avatar', async (request, reply) => {
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');
      const session = await requirePrincipal(request, reply);
      if (!session) return;
      const input = z.object({ account: z.uuid() }).strict().parse(request.query);
      if (input.account !== session.user.id)
        return reply.code(401).send({ error: 'Sign in to continue.' });
      if (!options.authentication?.avatar || !session.avatarSource)
        return reply.code(404).send({ error: 'Avatar is unavailable.' });
      try {
        const image = await options.authentication.avatar(session);
        const current = await options.authentication.session(authenticationHeaders(request));
        if (!current || current.id !== session.id || current.user.id !== session.user.id)
          return reply.code(401).send({ error: 'Sign in to continue.' });
        if (
          !image ||
          image.bytes.byteLength > 2 * 1024 * 1024 ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
        )
          return reply.code(404).send({ error: 'Avatar is unavailable.' });
        return reply
          .header('cache-control', 'private, max-age=60, must-revalidate')
          .type(image.mimeType)
          .send(Buffer.from(image.bytes));
      } catch {
        return reply.code(404).send({ error: 'Avatar is unavailable.' });
      }
    });
    app.post('/api/login', async (request, reply) => {
      if (!sameOrigin(request, reply)) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!options.authentication)
        return reply.code(503).send({ error: 'Google sign-in is not configured.' });
      return sendFetchResponse(
        reply,
        await options.authentication.signIn(authenticationHeaders(request)),
      );
    });
    app.get('/api/auth/callback/google', async (request, reply) => {
      if (!options.authentication) return reply.code(404).send({ error: 'Route not found.' });
      const callback = new Request(new URL(request.url, origin), {
        headers: authenticationHeaders(request),
      });
      return sendFetchResponse(reply, await options.authentication.callback(callback));
    });
    app.post('/api/logout', async (request, reply) => {
      if (!sameOrigin(request, reply)) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!(await requirePrincipal(request, reply))) return;
      if (options.authentication) {
        const result = await options.authentication.signOut(authenticationHeaders(request));
        const cookies = result.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        if (!result.ok) return reply.code(503).send({ error: 'Sign-out could not be completed.' });
        await result.body?.cancel();
      }
      return { ok: true };
    });
    app.post('/api/account/prepare', async (request, reply) => {
      if (!sameOrigin(request, reply)) return;
      const session = await requirePrincipal(request, reply);
      if (!session) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!(await prepare(request, reply, session))) return;
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
    app.patch('/api/account', async (request, reply) => {
      if (!sameOrigin(request, reply)) return;
      const session = await requirePrincipal(request, reply);
      if (!session) return;
      const input = accountUpdate.parse(request.body);
      let onboardingCompletedNow = false;
      let usageData: boolean | undefined;
      if (input.onboardingCompleted) {
        if (!(await prepare(request, reply, session))) return;
        if (
          !(await start(request, reply, session, input.name, async () => {
            const account = await options.accounts.update(session.user.id, input);
            onboardingCompletedNow = account.onboardingCompletedNow === true;
            usageData = account.usageData;
          }))
        )
          return;
      } else usageData = (await options.accounts.update(session.user.id, input)).usageData;
      if (usageData !== undefined) options.analytics?.setUsageData(session.user.id, usageData);
      if (onboardingCompletedNow)
        options.analytics?.capture(session.user.id, { event: 'otto_onboarding_completed' });
      if (input.name !== undefined || input.theme !== undefined)
        options.analytics?.capture(session.user.id, {
          event: 'otto_settings_updated',
          properties: { section: 'account', operation: 'update' },
        });
      reply.header('cache-control', 'no-store');
      return response(request, reply);
    });
    app.post('/api/account/welcome', async (request, reply) => {
      if (!sameOrigin(request, reply)) return;
      const session = await requirePrincipal(request, reply);
      if (!session) return;
      z.object({})
        .strict()
        .parse(request.body ?? {});
      if (!(await options.accounts.read(session.user.id)).onboardingCompleted)
        return reply.code(409).send({ error: 'Finish setup first.' });
      if (!(await start(request, reply, session))) return;
      reply.header('cache-control', 'no-store');
      return { ok: true };
    });
  }
  return { principal, requirePrincipal, response, register };
}
