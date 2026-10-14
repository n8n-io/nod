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
import type { ProductAnalytics } from '../ports/analytics.ts';
import type { AnalyticsDelivery, AnalyticsEvent } from './analytics.ts';
import { analyticsEvent, analyticsVersion } from './analytics-events.ts';

const consentRevision = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const analyticsConsent = z.object({ enabled: z.boolean(), revision: consentRevision }).strict();

const analyticsRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('consent') }).strict(),
  z
    .object({
      kind: z.literal('event'),
      event: analyticsEvent,
      uuid: z.uuid().optional(),
      timestamp: z.iso.datetime().optional(),
      app_version: analyticsVersion.optional(),
      consent_revision: consentRevision,
      run_id: z.uuid().optional(),
    })
    .strict(),
]);

export function createTenantControl(options: {
  masterKey: Uint8Array;
  environment: string;
  accounts: Pick<
    ReturnType<typeof createChannelAccountRegistry>,
    'claimWithLease' | 'releaseWithLease'
  >;
  currentLease(ownerId: string): Promise<TenantLease | undefined>;
  analytics?: {
    consent(ownerId: string): Promise<{ enabled: boolean; revision: string }>;
    capture(ownerId: string, event: AnalyticsEvent, delivery?: AnalyticsDelivery): void;
  };
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
      ![
        '/api/internal/channels/claim',
        '/api/internal/channels/release',
        '/api/internal/analytics',
      ].includes(url.pathname)
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
    const bytes = await readRequestBody(
      request,
      url.pathname === '/api/internal/analytics' ? 16_384 : 4096,
    );
    if (
      !bytes ||
      !timingSafeEqual(Buffer.from(runtimeBodyHash(bytes)), Buffer.from(claims.bodyHash))
    )
      return denied();
    if (url.pathname === '/api/internal/analytics') {
      let input;
      try {
        input = analyticsRequest.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      } catch {
        return Response.json({ error: 'Check the supplied values.' }, { status: 400 });
      }
      const consent = await options.analytics?.consent(owner.data).catch(() => undefined);
      if (input.kind === 'consent')
        return Response.json(consent ?? { enabled: false, revision: '0' });
      if (consent?.enabled && input.consent_revision === consent.revision)
        options.analytics?.capture(owner.data, input.event, {
          ...(input.uuid ? { uuid: input.uuid } : {}),
          ...(input.timestamp ? { timestamp: new Date(input.timestamp) } : {}),
          ...(input.app_version ? { appVersion: input.app_version } : {}),
          ...(input.run_id ? { runId: input.run_id } : {}),
          consentRevision: input.consent_revision,
        });
      return Response.json({ ok: true });
    }
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

interface TenantControlOptions {
  origin: string;
  ownerId: string;
  environment: string;
  generation: string;
  secret: string;
  fetch?: typeof fetch;
}

function createTenantRequest(options: TenantControlOptions) {
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
  return async (target: string, input: unknown, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('Runtime control was cancelled.');
    const body = Buffer.from(JSON.stringify(input));
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
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Runtime control could not be checked.');
    }
    return response.json() as Promise<unknown>;
  };
}

export function createTenantChannelRegistry(options: TenantControlOptions): ChannelAccountRegistry {
  const send = createTenantRequest(options);
  function perform(
    action: 'claim' | 'release',
    input: Parameters<ChannelAccountRegistry['claim']>[0],
  ) {
    if (input.ownerId !== options.ownerId) throw new Error('The channel account owner is invalid.');
    return send(`/api/internal/channels/${action}`, {
      provider: input.provider,
      accountId: input.accountId,
      revision: input.revision,
    });
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

export function createTenantAnalytics(options: TenantControlOptions): ProductAnalytics {
  const send = createTenantRequest(options);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let revision: string | undefined;
  return {
    get consentRevision() {
      return revision;
    },
    async permitted() {
      if (closing) return false;
      try {
        const consent = analyticsConsent.parse(
          await send('/api/internal/analytics', { kind: 'consent' }),
        );
        if (revision !== undefined && BigInt(consent.revision) < BigInt(revision)) return false;
        revision = consent.revision;
        return consent.enabled;
      } catch {
        return false;
      }
    },
    capture(input, signal) {
      const capturedRevision = input.consentRevision ?? revision;
      if (
        closing ||
        signal.aborted ||
        pending.size >= 256 ||
        capturedRevision === undefined ||
        capturedRevision !== revision
      )
        return;
      const {
        analytics_schema: _schema,
        deployment: _deployment,
        environment: _environment,
        capture_source: _source,
        app_version: version,
        run_id: runId,
        ...properties
      } = input.properties;
      const run = z.uuid().safeParse(runId);
      if (runId !== undefined && !run.success) return;
      const event = analyticsEvent.safeParse({
        event: input.event,
        ...(Object.keys(properties).length ? { properties } : {}),
      });
      if (!event.success || input.distinctId !== `hosted:${options.ownerId}`) return;
      const operation = Promise.resolve()
        .then(async () => {
          if (signal.aborted) return;
          await send(
            '/api/internal/analytics',
            {
              kind: 'event',
              consent_revision: capturedRevision,
              event: event.data,
              ...(input.uuid ? { uuid: input.uuid } : {}),
              ...(input.timestamp ? { timestamp: input.timestamp.toISOString() } : {}),
              ...(analyticsVersion.safeParse(version).success ? { app_version: version } : {}),
              ...(run.success ? { run_id: run.data } : {}),
            },
            signal,
          );
        })
        .catch(() => {});
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    },
    shutdown: () => (closing ??= Promise.all([...pending]).then(() => {})),
  };
}
