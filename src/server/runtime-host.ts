import { hkdfSync, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { RuntimeTransport } from '../ports/runtime-transport.ts';
import type { TenantRuntimeHost } from '../ports/tenant-runtime.ts';
import type { DeploymentInput, DeploymentReceipt } from '../ports/deployment.ts';
import type { createTenantStore, TenantLease } from './tenants.ts';
import { deriveRuntimeSecret, runtimeHeader, signRuntimeRequest } from './runtime-auth.ts';
import { channelWebhookToken } from './hosted-webhooks.ts';
import {
  DeploymentControlError,
  deploymentInputSchema,
  deploymentMaximumDuration,
} from './deployment-auth.ts';

const forwardedEnvironment = [
  'OTTO_PUBLIC_URL',
  'OTTO_RELEASE',
  'COMPUTER_PROVIDER',
  'OTTO_COMPUTER_CONTROL_URL',
  'E2B_API_KEY',
  'E2B_COMPUTER_TEMPLATE',
  'E2B_SANDBOX_TIMEOUT_MS',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'TRIAGE_MODEL',
  'MEMORY_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'TTS_MODEL',
  'TTS_VOICE',
  'COMPOSIO_API_KEY',
  'COMPOSIO_WEBHOOK_SECRET',
  'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
  'COMPOSIO_DRIVE_AUTH_CONFIG_ID',
  'COMPOSIO_SHEETS_AUTH_CONFIG_ID',
  'COMPOSIO_DOCS_AUTH_CONFIG_ID',
  'COMPOSIO_SLACK_AUTH_CONFIG_ID',
  'COMPOSIO_NOTION_AUTH_CONFIG_ID',
  'OBJECT_STORAGE_PROVIDER',
  'OBJECT_STORAGE_ENDPOINT',
] as const;

type Entry = { lease: TenantLease; secret: string; healthy: boolean; stopping?: Promise<void> };

function composioWebhookUrl(environment: Record<string, string | undefined>) {
  const explicit = environment.OTTO_WEBHOOK_ORIGIN;
  const configured = explicit || environment.OTTO_PUBLIC_URL;
  if (!configured) return;
  try {
    const origin = new URL(configured);
    if (
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password ||
      (origin.protocol !== 'https:' &&
        (explicit ||
          origin.protocol !== 'http:' ||
          !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
    )
      throw new Error();
    if (origin.protocol === 'https:') return new URL('/api/webhooks/composio', origin).href;
  } catch {
    throw new Error('The webhook origin is invalid.');
  }
}

export function createTenantRuntimeHost(options: {
  tenants: Pick<
    ReturnType<typeof createTenantStore>,
    'provision' | 'runtimeConfiguration' | 'acquireLease' | 'renewLease' | 'releaseLease'
  > &
    Partial<Pick<ReturnType<typeof createTenantStore>, 'listOwners'>>;
  transport: RuntimeTransport;
  masterKey: Uint8Array;
  environment: string;
  operatorEnvironment: Record<string, string | undefined>;
  developerIds?: ReadonlySet<string>;
  leaseDurationMs?: number;
  heartbeatMs?: number;
}): TenantRuntimeHost {
  const webhookUrl = composioWebhookUrl(options.operatorEnvironment);
  const duration = options.leaseDurationMs ?? 60_000;
  const heartbeat = options.heartbeatMs ?? 15_000;
  if (
    duration < 10_000 ||
    duration > 60_000 ||
    heartbeat < 100 ||
    heartbeat > duration / 3 ||
    options.masterKey.length !== 32
  )
    throw new Error('Runtime lease configuration is invalid.');
  const holderId = randomUUID();
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();
  let closed = false;
  let renewal: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let resumedDeployment: DeploymentInput | undefined;
  let deployment:
    | {
        input: DeploymentInput;
        paused: Set<string>;
        unknown: Set<string>;
        receipts: Map<string, string>;
        operation?: Promise<DeploymentReceipt[]>;
        resuming?: Promise<void>;
        lostJournal?: boolean;
      }
    | undefined;

  async function signedFetch(
    entry: Entry,
    request: Request,
    access: { developer: boolean; kind?: 'user' | 'webhook' | 'wake' | 'deployment' },
  ) {
    if (deployment && access.kind !== 'deployment' && access.kind !== 'wake')
      throw new DeploymentControlError();
    if (!entry.healthy || Date.parse(entry.lease.expiresAt) <= Date.now())
      throw new Error('The account runtime is unavailable.');
    const url = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method)
      ? new Uint8Array()
      : new Uint8Array(await request.arrayBuffer());
    if (
      closed ||
      !entry.healthy ||
      Date.parse(entry.lease.expiresAt) <= Date.now() ||
      (deployment && access.kind !== 'deployment' && access.kind !== 'wake')
    )
      throw new Error('The account runtime is unavailable.');
    const headers = new Headers(request.headers);
    for (const name of ['cookie', 'authorization', 'host', 'x-otto-account', runtimeHeader])
      headers.delete(name);
    headers.set(
      runtimeHeader,
      signRuntimeRequest({
        secret: entry.secret,
        ownerId: entry.lease.ownerId,
        environment: options.environment,
        generation: entry.lease.generation,
        method: request.method,
        target: url.pathname + url.search,
        body,
        ...access,
      }),
    );
    return options.transport.fetch(
      entry.lease.ownerId,
      new Request(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
        ...(!['GET', 'HEAD'].includes(request.method) ? { body } : {}),
      }),
    );
  }

  async function stop(entry: Entry) {
    entry.healthy = false;
    entry.stopping ??= (async () => {
      await options.transport.stop(entry.lease.ownerId, entry.lease.generation);
      await options.tenants.releaseLease(entry.lease);
      if (entries.get(entry.lease.ownerId) === entry) entries.delete(entry.lease.ownerId);
    })().finally(() => {
      entry.stopping = undefined;
    });
    return entry.stopping;
  }

  async function start(ownerId: string): Promise<Entry> {
    await options.tenants.provision(ownerId);
    const lease = await options.tenants.acquireLease(ownerId, holderId, duration);
    if (!lease) throw new Error('The account runtime is restarting. Try again shortly.');
    const secret = deriveRuntimeSecret(options.masterKey, options.environment, ownerId);
    const entry: Entry = { lease, secret, healthy: true };
    try {
      const previous = await options.transport.status(ownerId);
      if (previous.generation) await options.transport.stop(ownerId, previous.generation);
      const configuration = await options.tenants.runtimeConfiguration(ownerId);
      const environment: Record<string, string> = {};
      for (const key of forwardedEnvironment) {
        const value = options.operatorEnvironment[key];
        if (value) environment[key] = value;
      }
      if (webhookUrl) environment.OTTO_COMPOSIO_WEBHOOK_URL = webhookUrl;
      if (options.operatorEnvironment.OBJECT_STORAGE_ROOT)
        environment.OBJECT_STORAGE_ROOT = join(
          options.operatorEnvironment.OBJECT_STORAGE_ROOT,
          ownerId,
        );
      Object.assign(environment, {
        OTTO_MODE: 'tenant',
        OTTO_OWNER_ID: ownerId,
        OTTO_ENVIRONMENT: options.environment,
        OTTO_RUNTIME_GENERATION: lease.generation,
        OTTO_RUNTIME_SECRET: secret,
        OTTO_RUNTIME_LEASE_EXPIRES: lease.expiresAt,
        OTTO_DATA_ROOT: '/data',
        DATABASE_URL: configuration.databaseUrl,
        DATABASE_POOL_MAX: String(configuration.poolMax),
        INSPECTOR_DATABASE_POOL_MAX: '1',
        PGBOSS_SCHEMA: configuration.jobsSchema,
        PORT: '4310',
        NODE_ENV: 'production',
        DEV_INSPECTOR: String(
          options.operatorEnvironment.DEV_INSPECTOR === 'true' &&
            (options.developerIds?.has(ownerId) ?? false),
        ),
        OTTO_VAULT_KEY: Buffer.from(
          hkdfSync(
            'sha256',
            options.masterKey,
            Buffer.from('otto-vault-v1'),
            Buffer.from(JSON.stringify([options.environment, ownerId])),
            32,
          ),
        ).toString('base64'),
      });
      if (environment.OTTO_PUBLIC_URL)
        for (const provider of ['telegram', 'whatsapp'] as const) {
          environment[`OTTO_${provider.toUpperCase()}_WEBHOOK_URL`] = new URL(
            `/api/webhooks/${provider}/${channelWebhookToken(options.masterKey, options.environment, ownerId, provider)}`,
            options.operatorEnvironment.OTTO_WEBHOOK_ORIGIN || environment.OTTO_PUBLIC_URL,
          ).href;
        }
      environment.OTTO_CONTROL_URL =
        options.operatorEnvironment.OTTO_RUNTIME_URL === 'http://otto.runtime'
          ? 'http://otto.control'
          : options.operatorEnvironment.OTTO_PUBLIC_URL || '';
      await options.transport.start({ ownerId, generation: lease.generation, environment });
      if (closed || Date.parse(lease.expiresAt) <= Date.now())
        throw new Error('The account runtime did not become ready.');
      entries.set(ownerId, entry);
      return entry;
    } catch {
      entry.healthy = false;
      try {
        const current = await options.transport.status(ownerId);
        if (current.generation === lease.generation && !current.stopped)
          await options.transport.stop(ownerId, lease.generation);
        if (!current.generation || current.stopped || current.generation === lease.generation)
          await options.tenants.releaseLease(lease);
      } catch {}
      throw new Error('The account runtime could not start. Try again shortly.');
    }
  }

  function healthy(entry: Entry | undefined): entry is Entry {
    return Boolean(entry?.healthy && Date.parse(entry.lease.expiresAt) > Date.now());
  }

  async function ensure(owner: string, kind?: 'user' | 'webhook' | 'wake') {
    if (closed || deployment) throw new Error('The account runtime is unavailable.');
    const ownerId = z.uuid().parse(owner).toLowerCase();
    const admitted = entries.get(ownerId);
    if (kind !== 'wake' && healthy(admitted)) return admitted;
    if (await options.transport.deploymentClosed?.()) throw new DeploymentControlError();
    if (closed || deployment) throw new Error('The account runtime is unavailable.');
    const entry = entries.get(ownerId);
    if (healthy(entry)) return entry;
    if (entry) await stop(entry);
    if (closed || deployment) throw new Error('The account runtime is unavailable.');
    let operation = pending.get(ownerId);
    if (!operation) {
      operation = start(ownerId);
      pending.set(ownerId, operation);
      void operation
        .finally(() => {
          if (pending.get(ownerId) === operation) pending.delete(ownerId);
        })
        .catch(() => {});
    }
    return operation;
  }

  function sameDeployment(input: DeploymentInput) {
    return (
      deployment?.input.nonce === input.nonce &&
      deployment.input.targetRelease === input.targetRelease &&
      deployment.input.deadline === input.deadline
    );
  }

  async function tenantDeployment(
    entry: Entry,
    input: DeploymentInput,
    action: 'drain' | 'resume',
  ) {
    const remaining = action === 'drain' ? input.deadline - Date.now() : 30_000;
    if (remaining <= 0) throw new DeploymentControlError();
    const response = await signedFetch(
      entry,
      new Request(`http://otto.runtime/api/runtime/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(remaining),
      }),
      { developer: false, kind: 'deployment' },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DeploymentControlError();
    }
    const result = await response.json();
    if (action === 'drain')
      z.object({
        ok: z.literal(true),
        nonce: z.literal(input.nonce),
        targetRelease: z.literal(input.targetRelease),
        generation: z.literal(entry.lease.generation),
        drained: z.literal(true),
        computerPaused: z.literal(true).optional(),
      })
        .strict()
        .parse(result);
    else
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(result);
  }

  function prepareDeployment(raw: DeploymentInput): Promise<DeploymentReceipt[]> {
    const input = deploymentInputSchema.parse(raw);
    if (
      closed ||
      !options.tenants.listOwners ||
      !options.transport.prepareDeployment ||
      input.deadline <= Date.now() ||
      input.deadline > Date.now() + deploymentMaximumDuration ||
      (deployment && !sameDeployment(input))
    )
      return Promise.reject(new DeploymentControlError());
    if (
      deployment?.resuming ||
      deployment?.lostJournal ||
      (!deployment && resumedDeployment?.nonce === input.nonce)
    )
      return Promise.reject(new DeploymentControlError(409));
    deployment ??= { input, paused: new Set(), unknown: new Set(), receipts: new Map() };
    if (deployment.operation) return deployment.operation;
    const current = deployment;
    const assertCurrent = () => {
      if (closed || deployment !== current || Date.now() >= input.deadline)
        throw new DeploymentControlError();
    };
    const operation = (async () => {
      await Promise.allSettled([...pending.values()]);
      assertCurrent();
      const owners = await options.tenants.listOwners!();
      if (owners.length > 1024 || new Set(owners).size !== owners.length)
        throw new DeploymentControlError();
      for (const ownerId of owners) {
        z.uuid().parse(ownerId);
        assertCurrent();
        const status = await options.transport.status(ownerId);
        assertCurrent();
        if (!status.generation) {
          if (!status.stopped || entries.has(ownerId)) throw new DeploymentControlError();
          continue;
        }
        const generation = z
          .string()
          .regex(/^[1-9]\d{0,19}$/)
          .parse(status.generation);
        const entry = entries.get(ownerId);
        if (entry && entry.lease.generation !== generation) throw new DeploymentControlError();
        if (!status.stopped) {
          if (!entry?.healthy) throw new DeploymentControlError();
          current.paused.add(ownerId);
          await tenantDeployment(entry, input, 'drain');
          assertCurrent();
        }
        current.unknown.add(ownerId);
        const prepared = await options.transport.prepareDeployment!(ownerId, generation, input);
        if (prepared === 'busy') {
          current.unknown.delete(ownerId);
          throw new DeploymentControlError(409);
        }
        if (prepared !== 'stopped') throw new DeploymentControlError();
        assertCurrent();
        if (entry) await stop(entry);
        else await options.transport.stop(ownerId, generation);
        current.unknown.delete(ownerId);
        current.paused.delete(ownerId);
        current.receipts.set(ownerId, generation);
      }
      assertCurrent();
      return [...current.receipts].map(([ownerId, generation]) => ({ ownerId, generation }));
    })().catch((error) => {
      throw error instanceof DeploymentControlError ? error : new DeploymentControlError();
    });
    current.operation = operation;
    void operation
      .finally(() => {
        if (current.operation === operation) current.operation = undefined;
      })
      .catch(() => {});
    return operation;
  }

  const timer = setInterval(() => {
    if (closed || renewal) return;
    renewal = (async () => {
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          if (!entry.healthy) return;
          try {
            const lease = await options.tenants.renewLease(entry.lease, duration);
            if (!lease) throw new Error('Runtime ownership expired.');
            entry.lease = lease;
            const response = await signedFetch(
              entry,
              new Request('http://otto.runtime/api/runtime/lease', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ expiresAt: lease.expiresAt }),
                signal: AbortSignal.timeout(Math.min(heartbeat, 10_000)),
              }),
              { developer: false, kind: 'wake' },
            );
            if (!response.ok) throw new Error('Runtime ownership could not be renewed.');
            await response.body?.cancel();
          } catch {
            await stop(entry).catch(() => {});
          }
        }),
      );
    })().finally(() => {
      renewal = undefined;
    });
    void renewal.catch(() => {});
  }, heartbeat);
  timer.unref();

  return {
    async fetch(ownerId, request, access) {
      const entry = await ensure(ownerId, access.kind);
      return signedFetch(entry, request, access);
    },
    async warm(ownerId) {
      await ensure(ownerId);
    },
    prepareDeployment,
    async resumeDeployment(raw) {
      const input = deploymentInputSchema.parse(raw);
      if (
        !deployment &&
        resumedDeployment?.nonce === input.nonce &&
        resumedDeployment.targetRelease === input.targetRelease &&
        resumedDeployment.deadline === input.deadline
      )
        return;
      if (closed) throw new DeploymentControlError(409);
      if (!deployment) {
        if (
          entries.size ||
          pending.size ||
          !options.tenants.listOwners ||
          !options.transport.deploymentClosed ||
          !options.transport.deploymentStopped
        )
          throw new DeploymentControlError();
        deployment = {
          input,
          paused: new Set(),
          unknown: new Set(),
          receipts: new Map(),
          lostJournal: true,
        };
      }
      if (!sameDeployment(input)) throw new DeploymentControlError(409);
      const current = deployment!;
      current.resuming ??= (async () => {
        await current.operation?.catch(() => {});
        if (current.lostJournal) {
          const deadline = Date.now() + 30_000;
          const assertRecovery = () => {
            if (
              closed ||
              deployment !== current ||
              entries.size ||
              pending.size ||
              Date.now() >= deadline
            )
              throw new DeploymentControlError();
          };
          assertRecovery();
          if (!(await options.transport.deploymentClosed!())) throw new DeploymentControlError();
          const owners = await options.tenants.listOwners!();
          if (owners.length > 1024 || new Set(owners).size !== owners.length)
            throw new DeploymentControlError();
          for (const ownerId of owners) {
            z.uuid().parse(ownerId);
            assertRecovery();
            const status = await options.transport.status(ownerId);
            if (
              !status.stopped ||
              !(await options.transport.deploymentStopped!(ownerId, status.generation))
            )
              throw new DeploymentControlError();
            assertRecovery();
          }
          if (!(await options.transport.deploymentClosed!())) throw new DeploymentControlError();
          assertRecovery();
        }
        if (current.unknown.size) throw new DeploymentControlError();
        for (const owner of current.paused) {
          const entry = entries.get(owner);
          if (!entry?.healthy) throw new DeploymentControlError();
          await tenantDeployment(entry, input, 'resume');
          current.paused.delete(owner);
        }
        if (deployment !== current) throw new DeploymentControlError();
        resumedDeployment = input;
        deployment = undefined;
      })().finally(() => {
        current.resuming = undefined;
      });
      return current.resuming;
    },
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(timer);
        for (const entry of entries.values()) entry.healthy = false;
        await renewal?.catch(() => {});
        await Promise.allSettled([...pending.values()]);
        const outcomes = await Promise.allSettled([...entries.values()].map(stop));
        await options.transport.close();
        if (outcomes.some((result) => result.status === 'rejected'))
          throw new Error('Some account runtimes could not stop.');
      })();
      return closing;
    },
  };
}
