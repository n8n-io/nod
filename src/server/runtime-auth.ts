import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fileBytes } from '../shared/files.ts';

const envelope = z
  .object({
    version: z.literal(1),
    ownerId: z.uuid(),
    environment: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    generation: z.string().regex(/^[1-9]\d{0,19}$/),
    nonce: z.uuid(),
    expiresAt: z.number().int(),
    method: z.enum(['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD', 'OPTIONS']),
    target: z.string().min(1).startsWith('/'),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
    developer: z.boolean(),
    kind: z.enum(['user', 'webhook', 'wake', 'deployment']),
  })
  .strict();

export type RuntimeClaims = z.infer<typeof envelope>;
export const runtimeHeader = 'x-otto-runtime';

export function canonicalRequestPath(target: string): string | null {
  if (!target.startsWith('/') || /[\\#\u0000-\u0020\u007f]/.test(target)) return null;
  const path = target.split('?')[0];
  if (
    path.includes('%') ||
    path.includes('//') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    return null;
  return path;
}

export function deriveRuntimeSecret(master: Uint8Array, environment: string, ownerId: string) {
  if (master.length < 32 || !z.uuid().safeParse(ownerId).success)
    throw new Error('Runtime signing configuration is invalid.');
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.from('otto-runtime-v1'),
      Buffer.from(JSON.stringify([environment, ownerId.toLowerCase()])),
      32,
    ),
  ).toString('base64url');
}

export function runtimeBodyHash(body: Uint8Array) {
  return createHash('sha256').update(body).digest('hex');
}

export function signRuntimeRequest(options: {
  secret: string;
  ownerId: string;
  environment: string;
  generation: string;
  method: string;
  target: string;
  body: Uint8Array;
  developer: boolean;
  kind?: RuntimeClaims['kind'];
  now?: number;
}) {
  if (Buffer.from(options.secret, 'base64url').length < 32)
    throw new Error('Runtime signing configuration is invalid.');
  const claims = envelope.parse({
    version: 1,
    ownerId: options.ownerId,
    environment: options.environment,
    generation: options.generation,
    nonce: randomUUID(),
    expiresAt: (options.now ?? Date.now()) + 30_000,
    method: options.method,
    target: options.target,
    bodyHash: runtimeBodyHash(options.body),
    developer: options.developer,
    kind: options.kind ?? 'user',
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(options.secret, 'base64url'))
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyRuntimeSignature(
  options: {
    secret: string;
    ownerId: string;
    environment: string;
    now?: () => number;
  },
  token: unknown,
  method: string,
  target: string,
): RuntimeClaims | null {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', Buffer.from(options.secret, 'base64url'))
    .update(payload)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let claims: RuntimeClaims;
  try {
    claims = envelope.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
  const time = (options.now ?? Date.now)();
  if (
    claims.ownerId !== options.ownerId ||
    claims.environment !== options.environment ||
    claims.method !== method ||
    claims.target !== target ||
    claims.expiresAt <= time ||
    claims.expiresAt > time + 35_000
  )
    return null;
  return claims;
}

export function createRuntimeVerifier(options: {
  secret: string;
  ownerId: string;
  environment: string;
  generation: string;
  now?: () => number;
}) {
  if (
    Buffer.from(options.secret, 'base64url').length < 32 ||
    !z.uuid().safeParse(options.ownerId).success
  )
    throw new Error('Runtime verification configuration is invalid.');
  const accepted = new Map<string, number>();
  const now = options.now ?? Date.now;
  function verify(token: unknown, method: string, target: string): RuntimeClaims | null {
    const claims = verifyRuntimeSignature(options, token, method, target);
    if (!claims || claims.generation !== options.generation) return null;
    const time = now();
    for (const [nonce, expires] of accepted) {
      if (expires > time) break;
      accepted.delete(nonce);
    }
    if (accepted.has(claims.nonce)) return null;
    accepted.set(claims.nonce, claims.expiresAt);
    return claims;
  }
  return { verify };
}

export function registerRuntimeAccess(
  app: FastifyInstance,
  options: Parameters<typeof createRuntimeVerifier>[0],
) {
  const verifier = createRuntimeVerifier(options);
  const claims = new WeakMap<FastifyRequest, RuntimeClaims>();
  const bodies = new WeakMap<FastifyRequest, Buffer>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    const path = canonicalRequestPath(request.url);
    if (!path) return reply.code(400).send({ error: 'This request is not permitted.' });
    const verified = verifier.verify(request.headers[runtimeHeader], request.method, request.url);
    if (!verified) return reply.code(401).send({ error: 'Runtime authentication failed.' });
    const webhook = path.startsWith('/api/webhooks/');
    if ((webhook && verified.kind !== 'webhook') || (!webhook && verified.kind === 'webhook'))
      return reply.code(403).send({ error: 'This request is not permitted.' });
    if (
      (path.startsWith('/api/runtime/') && !['wake', 'deployment'].includes(verified.kind)) ||
      (verified.kind === 'wake' &&
        (request.method !== 'POST' ||
          !['/api/runtime/wake', '/api/runtime/lease'].includes(path))) ||
      (verified.kind === 'deployment' &&
        (request.method !== 'POST' ||
          !['/api/runtime/drain', '/api/runtime/resume'].includes(path)))
    )
      return reply.code(403).send({ error: 'This request is not permitted.' });
    if (
      !verified.developer &&
      (path === '/api/browser' || path.startsWith('/api/browser/') || path === '/browser')
    )
      return reply.code(404).send({ error: 'Route not found.' });
    if (
      ['GET', 'HEAD'].includes(request.method) &&
      verified.bodyHash !== runtimeBodyHash(new Uint8Array())
    )
      return reply.code(401).send({ error: 'Runtime authentication failed.' });
    claims.set(request, verified);
  });
  app.addHook('preParsing', async (request, reply, payload) => {
    const verified = claims.get(request);
    if (!verified) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > fileBytes + 1024 * 1024) {
        reply.code(413).send({ error: 'This request is too large.' });
        return Readable.from([]);
      }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks);
    if (runtimeBodyHash(body) !== verified.bodyHash) {
      reply.code(401).send({ error: 'Runtime authentication failed.' });
      return Readable.from([]);
    }
    bodies.set(request, body);
    return Readable.from([body]);
  });
  return {
    takeBody(request: FastifyRequest) {
      const body = bodies.get(request);
      bodies.delete(request);
      return body;
    },
  };
}
