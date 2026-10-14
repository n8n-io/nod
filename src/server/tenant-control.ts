import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ChannelAccountRegistry } from '../ports/channel-settings.ts';
import type { TenantLease } from './tenants.ts';
import type { createChannelAccountRegistry } from './channel-account-registry.ts';
import {
  createRuntimeVerifier,
  deriveRuntimeSecret,
  runtimeBodyHash,
  runtimeHeader,
  signRuntimeRequest,
  verifyRuntimeSignature,
} from './runtime-auth.ts';
import { readRequestBody } from './request-body.ts';
import { loopbackHost } from '../shared/loopback.ts';

export function createTenantControl(options: {
  masterKey: Uint8Array;
  environment: string;
  accounts: Pick<
    ReturnType<typeof createChannelAccountRegistry>,
    'claimWithLease' | 'releaseWithLease'
  >;
  currentLease(ownerId: string): Promise<TenantLease | undefined>;
}) {
  const verifiers = new Map<
    string,
    { generation: string; verify: ReturnType<typeof createRuntimeVerifier>['verify'] }
  >();
  return async (request: Request) => {
    const denied = () =>
      Response.json({ error: 'Runtime authentication failed.' }, { status: 401 });
    const owner = z.uuid().safeParse(request.headers.get('x-otto-owner'));
    const url = new URL(request.url);
    if (
      !owner.success ||
      request.method !== 'POST' ||
      url.search ||
      !['/api/internal/channels/claim', '/api/internal/channels/release'].includes(url.pathname)
    )
      return denied();
    const context = {
      secret: deriveRuntimeSecret(options.masterKey, options.environment, owner.data),
      ownerId: owner.data,
      environment: options.environment,
    };
    const signed = verifyRuntimeSignature(
      context,
      request.headers.get(runtimeHeader),
      request.method,
      url.pathname,
    );
    if (!signed || signed.kind !== 'wake' || signed.developer) return denied();
    const lease = await options.currentLease(owner.data);
    if (!lease || Date.parse(lease.expiresAt) <= Date.now()) return denied();
    let verifier = verifiers.get(owner.data);
    if (verifier?.generation !== lease.generation) {
      verifier = {
        generation: lease.generation,
        verify: createRuntimeVerifier({
          ...context,
          generation: lease.generation,
        }).verify,
      };
      verifiers.set(owner.data, verifier);
    }
    const claims = verifier.verify(
      request.headers.get(runtimeHeader),
      request.method,
      url.pathname,
    );
    if (!claims || claims.kind !== 'wake' || claims.developer) return denied();
    const bytes = await readRequestBody(request, 4096);
    if (
      !bytes ||
      !timingSafeEqual(Buffer.from(runtimeBodyHash(bytes)), Buffer.from(claims.bodyHash))
    )
      return denied();
    let input;
    try {
      input = z
        .object({
          provider: z.enum(['telegram', 'whatsapp']),
          accountId: z.string().regex(/^[a-zA-Z0-9:_-]{1,200}$/),
          revision: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,18})$/)
            .refine((value) => BigInt(value) <= 9223372036854775807n),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch {
      return Response.json({ error: 'Check the supplied values.' }, { status: 400 });
    }
    const identity = { ...input, ownerId: owner.data };
    if (url.pathname.endsWith('/claim'))
      return Response.json({ claimed: await options.accounts.claimWithLease(identity, lease) });
    await options.accounts.releaseWithLease(identity, lease);
    return Response.json({ ok: true });
  };
}

export function createTenantChannelRegistry(options: {
  origin: string;
  ownerId: string;
  environment: string;
  generation: string;
  secret: string;
  fetch?: typeof fetch;
}): ChannelAccountRegistry {
  const origin = new URL(options.origin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (origin.origin !== 'http://otto.control' &&
      origin.protocol !== 'https:' &&
      !(loopbackHost(origin.hostname) && origin.protocol === 'http:'))
  )
    throw new Error('The runtime control endpoint is invalid.');
  const send = options.fetch ?? fetch;
  async function perform(
    action: 'claim' | 'release',
    input: Parameters<ChannelAccountRegistry['claim']>[0],
  ) {
    if (input.ownerId !== options.ownerId) throw new Error('The channel account owner is invalid.');
    const target = `/api/internal/channels/${action}`;
    const body = Buffer.from(
      JSON.stringify({
        provider: input.provider,
        accountId: input.accountId,
        revision: input.revision,
      }),
    );
    const token = signRuntimeRequest({
      ...options,
      method: 'POST',
      target,
      body,
      developer: false,
      kind: 'wake',
    });
    const response = await send(new URL(target, origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [runtimeHeader]: token,
        'x-otto-owner': options.ownerId,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Channel ownership could not be checked.');
    }
    return response.json() as Promise<unknown>;
  }
  return {
    async claim(input) {
      return z.object({ claimed: z.boolean() }).parse(await perform('claim', input)).claimed;
    },
    async release(input) {
      z.object({ ok: z.literal(true) }).parse(await perform('release', input));
    },
  };
}
