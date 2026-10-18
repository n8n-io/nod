import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import {
  deploymentHeader,
  deploymentPath,
  deprovisionPath,
  signDeploymentRequest,
  deploymentRequestSchema,
} from '../../../src/server/deployment-auth.ts';
import { parseCredentialKey } from '../../../src/providers/environment/key-store.ts';

const unavailable = () =>
  new Error('Deployment safety checks did not pass; admission remains unchanged or closed.');

const stateSchema = deploymentRequestSchema.omit({ action: true }).extend({
  phase: z.enum([
    'draining',
    'prepared',
    'activating',
    'aborting',
    'failed',
    'complete',
    'aborted',
  ]),
  receipts: z
    .array(
      z.object({ ownerId: z.uuid(), generation: z.string().regex(/^[1-9]\d{0,19}$/) }).strict(),
    )
    .max(1024),
});

const rolloutSchema = z.object({
  configuration: z.object({ image: z.string().min(1) }),
  active_rollout_id: z.null().optional(),
  scheduling_hint: z
    .object({
      target: z.object({ configuration: z.object({ image: z.string().min(1) }) }).nullish(),
    })
    .nullish(),
});

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const applicationIdentitySchema = z.object({
  id: z.uuid(),
  name: z.string().regex(/^[a-z0-9-]{1,128}$/),
  account_id: z.string().regex(/^[a-f0-9]{32}$/),
  durable_objects: z.object({ namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }),
  version: countSchema,
});
const pendingApplicationSchema = applicationIdentitySchema.extend({
  configuration: z.object({ image: z.string().min(1) }),
  active_rollout_id: z.uuid(),
  scheduling_hint: rolloutSchema.shape.scheduling_hint,
});
const completedRolloutSchema = z.object({
  id: z.uuid(),
  status: z.literal('completed'),
  current_version: countSchema,
  current_configuration: z.object({ image: z.string().min(1) }),
  target_version: countSchema,
  target_configuration: z.object({ image: z.string().min(1) }),
  health: z.object({
    errors: z.array(z.unknown()).length(0),
    instances: z.object({ failed: z.literal(0) }),
  }),
  steps: z
    .array(
      z.object({
        status: z.literal('completed'),
        step_size: z.object({ percentage: z.number().int().positive().max(100) }),
      }),
    )
    .min(1)
    .max(100),
  progress: z.object({
    total_steps: countSchema,
    current_step: countSchema,
    updated_instances: countSchema,
    total_instances: countSchema,
    version_distribution: z.object({
      target_version_instances: countSchema,
      current_version_instances: z.literal(0),
      target_version_percentage: z.literal(100),
    }),
  }),
});

async function boundedJson(response, maximum = 1024 * 1024) {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw unavailable();
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function inspectImageDigest(image, environment = process.env) {
  if (
    !/^registry\.cloudflare\.com\/[a-f0-9]{32}\/otto-(development|production)(-browser|-workspace)?:[a-f0-9]{40}$/.test(
      image,
    )
  )
    return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['manifest', 'inspect', '-v', image], {
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let invalid = false;
    const timer = setTimeout(() => {
      invalid = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 1024 * 1024) {
        invalid = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(unavailable());
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        if (invalid || code !== 0) throw unavailable();
        const manifest = JSON.parse(output);
        const entries = Array.isArray(manifest) ? manifest : [manifest];
        if (
          entries.length === 0 ||
          entries.length > 128 ||
          entries.some(
            (entry) =>
              !entry?.Descriptor ||
              typeof entry.Descriptor.platform?.os !== 'string' ||
              typeof entry.Descriptor.platform?.architecture !== 'string' ||
              typeof entry.Descriptor.digest !== 'string' ||
              !/^sha256:[a-f0-9]{64}$/.test(entry.Descriptor.digest ?? ''),
          )
        )
          throw unavailable();
        const candidates = entries.filter(
          (entry) =>
            entry.Descriptor.platform.os === 'linux' &&
            entry.Descriptor.platform.architecture === 'amd64',
        );
        if (candidates.length !== 1) throw unavailable();
        const selected = candidates[0];
        const descriptor = selected.Descriptor;
        if (
          ![
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].includes(descriptor.mediaType) ||
          descriptor.platform.variant !== undefined ||
          descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest' ||
          selected.OCIManifest?.artifactType !== undefined
        )
          throw unavailable();
        const digest = descriptor.digest;
        resolve(`${image.slice(0, image.lastIndexOf(':'))}@${digest}`);
      } catch {
        reject(unavailable());
      }
    });
  });
}

export async function pinDeploymentImages(
  plan,
  environment,
  variables,
  inspect = inspectImageDigest,
) {
  const references = new Map();
  for (const container of plan.config.env[environment].containers) {
    if (!references.has(container.image))
      references.set(container.image, await inspect(container.image, variables));
    const reference = references.get(container.image);
    if (
      typeof reference !== 'string' ||
      !reference.startsWith(
        `${container.image.slice(0, container.image.lastIndexOf(':'))}@sha256:`,
      ) ||
      !/@sha256:[a-f0-9]{64}$/.test(reference)
    )
      throw unavailable();
    container.image = reference;
  }
}

async function emptyTenantRegistry(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl) throw unavailable();
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  try {
    await client.connect();
    const relation = await client.query("SELECT to_regclass('otto_control.tenants') AS relation");
    if (!relation.rows[0]?.relation) return true;
    const result = await client.query(
      'SELECT EXISTS(SELECT 1 FROM otto_control.tenants) AS occupied',
    );
    return result.rows[0]?.occupied === false;
  } catch {
    throw unavailable();
  } finally {
    await client.end().catch(() => {});
  }
}

const deprovisionReportSchema = z
  .object({
    dryRun: z.boolean(),
    running: z.boolean(),
    released: z.boolean(),
    storageObjects: countSchema,
    account: z
      .object({
        user: z.boolean(),
        sessions: countSchema,
        accounts: countSchema,
        settings: countSchema,
      })
      .strict(),
    tenant: z
      .object({
        registered: z.boolean(),
        role: z.boolean(),
        schemas: countSchema,
        channelAccounts: countSchema,
      })
      .strict(),
  })
  .strict();

export function createDeprovisionClient({
  environment,
  plan,
  variables,
  fetcher = fetch,
  now = Date.now,
}) {
  const masterKey = parseCredentialKey(JSON.parse(variables.GATEWAY_ENV).OTTO_MASTER_KEY || '');
  return async (owner, { dryRun, release }) => {
    const ownerId = z.uuid().parse(owner).toLowerCase();
    const body = Buffer.from(JSON.stringify({ ownerId, dryRun, release }));
    const token = signDeploymentRequest({
      masterKey,
      environment,
      body,
      now: now(),
      capability: 'deprovision',
    });
    const response = await fetcher(new URL(deprovisionPath, plan.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [deploymentHeader]: token },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(600_000),
    });
    const result = await boundedJson(response, 128 * 1024);
    if (!response.ok || result.ok !== true) throw unavailable();
    const report = deprovisionReportSchema.safeParse(result.report);
    if (!report.success || report.data.dryRun !== dryRun) throw unavailable();
    return report.data;
  };
}

export function createDeploymentClient({
  environment,
  plan,
  variables,
  fetcher = fetch,
  now = Date.now,
  wait = sleep,
  emptyRegistry = emptyTenantRegistry,
  attempts = 60,
  intervalMs = 5000,
}) {
  const gateway = JSON.parse(variables.GATEWAY_ENV);
  const masterKey = parseCredentialKey(gateway.OTTO_MASTER_KEY || '');
  const selected = plan.config.env[environment];
  const worker = selected.name || `${plan.config.name}-${environment}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) throw unavailable();
  let input;
  let bootstrap = false;
  let prepared = false;
  let activated = false;
  let verified = false;
  let initialized = false;

  async function api(path, allowMissing = false) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${variables.CLOUDFLARE_ACCOUNT_ID}/${path}`,
      {
        headers: { authorization: `Bearer ${variables.CLOUDFLARE_API_TOKEN}` },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = await boundedJson(response);
    if (
      allowMissing &&
      response.status === 404 &&
      result.success === false &&
      result.errors?.some((error) => error.code === 10007)
    )
      return null;
    if (!response.ok || result.success !== true) throw unavailable();
    return result.result;
  }

  async function applications() {
    return Promise.all(
      selected.containers.map(async (container) => {
        const name = container.name;
        if (typeof name !== 'string' || !/^[a-z0-9-]{1,128}$/.test(name)) throw unavailable();
        const values = await api(`containers/applications?name=${encodeURIComponent(name)}`);
        if (!Array.isArray(values) || values.length > 1024) throw unavailable();
        const matches = values.filter((value) => value.name === name);
        if (matches.length > 1) throw unavailable();
        return { expected: container.image, application: matches[0] };
      }),
    );
  }

  async function completedRollout(expected, application) {
    const parsed = pendingApplicationSchema.safeParse(application);
    if (!parsed.success || parsed.data.account_id !== variables.CLOUDFLARE_ACCOUNT_ID) return false;
    const identity = parsed.data;
    if (
      identity.scheduling_hint?.target &&
      identity.scheduling_hint.target.configuration.image !== expected
    )
      return false;
    const path = `containers/applications/${identity.id}`;
    const detail = await api(path);
    const current = applicationIdentitySchema.and(rolloutSchema).safeParse(detail);
    if (
      !current.success ||
      current.data.id !== identity.id ||
      current.data.name !== identity.name ||
      current.data.account_id !== identity.account_id ||
      current.data.durable_objects.namespace_id !== identity.durable_objects.namespace_id ||
      current.data.configuration.image !== expected ||
      (current.data.scheduling_hint?.target &&
        current.data.scheduling_hint.target.configuration.image !== expected)
    )
      return false;
    const result = completedRolloutSchema.safeParse(
      await api(`${path}/rollouts/${identity.active_rollout_id}`),
    );
    if (!result.success) return false;
    const rollout = result.data;
    const progress = rollout.progress;
    if (
      rollout.id !== identity.active_rollout_id ||
      rollout.current_version !== identity.version ||
      rollout.current_configuration.image !== identity.configuration.image ||
      rollout.target_version <= rollout.current_version ||
      rollout.target_version !== current.data.version ||
      rollout.target_configuration.image !== expected ||
      progress.total_steps !== rollout.steps.length ||
      progress.current_step !== progress.total_steps ||
      rollout.steps.at(-1).step_size.percentage !== 100 ||
      progress.total_instances === 0 ||
      progress.updated_instances !== progress.total_instances ||
      progress.version_distribution.target_version_instances !== progress.total_instances
    )
      return false;
    const latest = await api(path);
    const final = applicationIdentitySchema.and(rolloutSchema).safeParse(latest);
    return (
      final.success &&
      isDeepStrictEqual(final.data, current.data) &&
      isDeepStrictEqual(latest.configuration, detail.configuration)
    );
  }

  async function control(action) {
    const body = Buffer.from(JSON.stringify({ ...input, action }));
    const token = signDeploymentRequest({ masterKey, environment, body, now: now() });
    const response = await fetcher(new URL(deploymentPath, plan.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [deploymentHeader]: token },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(
        action === 'prepare' ? Math.max(1, input.deadline - now() + 1000) : 30_000,
      ),
    });
    const result = await boundedJson(response, 128 * 1024);
    if (!response.ok || result.ok !== true) throw unavailable();
    const parsed = stateSchema.safeParse(result.state);
    if (!parsed.success) throw unavailable();
    const state = parsed.data;
    if (
      action !== 'status' &&
      (state.nonce !== input.nonce ||
        state.targetRelease !== input.targetRelease ||
        state.previousRelease !== input.previousRelease ||
        state.deadline !== input.deadline)
    )
      throw unavailable();
    const expected = {
      prepare: 'prepared',
      activate: 'activating',
      complete: 'complete',
      abort: 'aborted',
    }[action];
    if (expected && state.phase !== expected) throw unavailable();
    return state;
  }

  return {
    async recover() {
      if (input || prepared || activated) throw unavailable();
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: plan.release,
        deadline: now() + 300_000,
      };
      const state = await control('status');
      if (state.targetRelease !== plan.release) throw unavailable();
      const { phase, receipts: _receipts, ...identity } = state;
      input = identity;
      prepared = ['prepared', 'activating', 'complete'].includes(phase);
      activated = ['activating', 'complete'].includes(phase);
      initialized = true;
      return { ...identity, phase };
    },
    async prepare() {
      const existing = await api(`workers/scripts/${worker}/settings`, true);
      if (existing === null) {
        if (
          (await applications()).some(({ application }) => application) ||
          !(await emptyRegistry(gateway.DATABASE_URL))
        )
          throw unavailable();
        bootstrap = true;
        prepared = true;
        return;
      }
      const health = await fetcher(new URL('/api/health', plan.origin), {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
      const status = await boundedJson(health, 4096);
      if (
        !health.ok ||
        status.ok !== true ||
        !/^[a-f0-9]{40}$/.test(status.release ?? '') ||
        status.release === plan.release
      )
        throw unavailable();
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: status.release,
        deadline: now() + 300_000,
      };
      await control('prepare');
      prepared = true;
    },
    async activate() {
      if (!prepared) throw unavailable();
      if (!bootstrap) await control('activate');
      activated = true;
    },
    async initialize() {
      if (!activated || !verified) throw unavailable();
      if (!bootstrap) return;
      input = {
        nonce: randomUUID(),
        targetRelease: plan.release,
        previousRelease: plan.release,
        deadline: now() + 300_000,
      };
      await control('prepare');
      await control('activate');
      initialized = true;
    },
    async verifyRollouts() {
      if (!activated) throw unavailable();
      verified = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const entries = await applications();
        const results = await Promise.all(
          entries.map(async ({ expected, application }) => {
            const parsed = rolloutSchema.safeParse(application);
            if (
              parsed.success &&
              parsed.data.configuration.image === expected &&
              (!parsed.data.scheduling_hint?.target ||
                parsed.data.scheduling_hint.target.configuration.image === expected)
            )
              return true;
            return completedRollout(expected, application);
          }),
        );
        if (results.every(Boolean)) {
          verified = true;
          return;
        }
        if (attempt + 1 < attempts) await wait(intervalMs);
      }
      throw unavailable();
    },
    async complete() {
      if (!activated || !verified || (bootstrap && !initialized)) throw unavailable();
      await control('complete');
    },
    async abort() {
      if (activated || !input) throw unavailable();
      await control('abort');
    },
  };
}
