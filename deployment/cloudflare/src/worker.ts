import { Container, ContainerProxy, type OutboundHandler } from '@cloudflare/containers';
import {
  BrowserComputerContainer,
  WorkspaceComputerContainer,
  computerName,
} from './computer-container.ts';
import { createTenantLifecycle } from './lifecycle.ts';
import { createRuntimeLeaseAlarm } from './lease-alarm.ts';
import {
  runtimeLeaseAcknowledgement,
  runtimeLeaseBody,
  runtimeRoutingGeneration,
} from './runtime-forwarding.ts';
import {
  analyticsEnvironment,
  computerProvider,
  controlBody,
  environmentName,
  environmentValues,
  failure,
  generation,
  ownerIdentity,
  RuntimeControlError,
  type TenantIdentity,
} from './protocol.ts';
import { storageRequest } from './storage.ts';
import { assertContainerStartupSettled, startContainer } from './container-startup.ts';
import { stopContainer } from './container-stop.ts';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import {
  DeploymentControlError,
  deploymentInputSchema,
  deploymentMaximumDuration,
  deploymentPath,
} from '../../../src/server/deployment-auth.ts';
import { createGatewayDeployment } from './deployment-gateway.ts';
import type { DeploymentState } from './deployment-barrier.ts';
import {
  deploymentProof,
  runtimeDeploymentAcknowledgement,
  runtimeDeploymentBody,
  type RuntimeDeploymentProof,
} from './runtime-deployment.ts';

export { ContainerProxy, BrowserComputerContainer, WorkspaceComputerContainer };

export interface Bindings {
  GATEWAY: DurableObjectNamespace<GatewayContainer>;
  TENANTS: DurableObjectNamespace<TenantContainer>;
  BROWSER_COMPUTERS: DurableObjectNamespace<BrowserComputerContainer>;
  WORKSPACE_COMPUTERS: DurableObjectNamespace<WorkspaceComputerContainer>;
  TENANT_FILES: R2Bucket;
  ASSETS: Fetcher;
  GATEWAY_ENV: string;
  OTTO_ENVIRONMENT: string;
  OTTO_PUBLIC_URL: string;
  OTTO_DEPLOYMENT_MANAGED?: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}

function gatewayName(env: Bindings) {
  return `gateway:${environmentName(env.OTTO_ENVIRONMENT)}`;
}

function tenantName(env: Bindings, ownerId: string) {
  return `tenant:${environmentName(env.OTTO_ENVIRONMENT)}:${ownerIdentity(ownerId)}`;
}

function publicOrigin(env: Bindings) {
  const url = new URL(env.OTTO_PUBLIC_URL);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new RuntimeControlError(503);
  return url.origin;
}

function fetchContainer(
  container: DurableObjectState['container'],
  port: number,
  request: Request,
) {
  if (!container?.running) throw new RuntimeControlError(503);
  const target = new URL(request.url);
  target.protocol = 'http:';
  return container.getTcpPort(port).fetch(target, request);
}

const runtimeOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    if (
      context.className !== 'GatewayContainer' ||
      context.containerId !== env.GATEWAY.idFromName(gatewayName(env)).toString()
    )
      throw new RuntimeControlError(403);
    const url = new URL(request.url);
    if (url.pathname === '/runtime/deployment-status' && request.method === 'POST' && !url.search) {
      const input = await controlBody(request);
      if (!input || typeof input !== 'object' || Object.keys(input).length)
        throw new RuntimeControlError(400);
      return Response.json(
        { closed: await env.GATEWAY.getByName(gatewayName(env)).deploymentClosed() },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (url.pathname === '/runtime/start' && request.method === 'POST') {
      if (await env.GATEWAY.getByName(gatewayName(env)).deploymentClosed())
        throw new RuntimeControlError(503);
      const input = await controlBody(request);
      const ownerId = ownerIdentity((input as { ownerId?: unknown } | null)?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.startRuntime(input), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (
      url.pathname === '/runtime/prepare-deployment' &&
      request.method === 'POST' &&
      !url.search
    ) {
      const raw = (await controlBody(request)) as Record<string, unknown>;
      const { ownerId: owner, generation: version, ...fields } = raw;
      const ownerId = ownerIdentity(owner);
      const input = deploymentInputSchema.parse(fields);
      const result = await env.TENANTS.getByName(tenantName(env, ownerId)).prepareDeploymentDrain(
        ownerId,
        generation(version),
        input,
      );
      return Response.json(result, {
        status: result.ok ? 200 : result.status === 'busy' ? 409 : 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (
      url.pathname === '/runtime/deployment-stopped' &&
      request.method === 'POST' &&
      !url.search
    ) {
      const input = (await controlBody(request)) as Record<string, unknown>;
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).length !== 2 ||
        !Object.hasOwn(input, 'ownerId') ||
        !Object.hasOwn(input, 'generation')
      )
        throw new RuntimeControlError(400);
      const ownerId = ownerIdentity(input.ownerId);
      const version = input.generation === null ? null : generation(input.generation);
      const stopped = await env.TENANTS.getByName(tenantName(env, ownerId)).deploymentStopped(
        ownerId,
        version,
      );
      return Response.json(
        { stopped, generation: version },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (url.pathname === '/runtime/stop' && request.method === 'POST') {
      const input = (await controlBody(request)) as { ownerId?: unknown; generation?: unknown };
      const ownerId = ownerIdentity(input?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.stopRuntime(ownerId, input.generation), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/runtime/status' && request.method === 'POST') {
      const input = (await controlBody(request)) as { ownerId?: unknown };
      const ownerId = ownerIdentity(input?.ownerId);
      const tenant = env.TENANTS.getByName(tenantName(env, ownerId));
      return Response.json(await tenant.runtimeStatus(), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    const match = /^\/([^/]+)(\/api\/.*)$/.exec(url.pathname);
    if (!match) throw new RuntimeControlError(404);
    const ownerId = ownerIdentity(match[1]);
    if (!request.headers.has('x-otto-runtime')) throw new RuntimeControlError(401);
    const target = new URL(publicOrigin(env));
    target.pathname = match[2];
    target.search = url.search;
    const forwarded = new Request(target, request);
    forwarded.headers.set('host', target.host);
    return await env.TENANTS.getByName(tenantName(env, ownerId)).fetch(forwarded);
  } catch (error) {
    return failure(error);
  }
};

const storageOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    if (context.className !== 'TenantContainer') throw new RuntimeControlError(403);
    const tenant = env.TENANTS.get(env.TENANTS.idFromString(context.containerId));
    const identity = await tenant.storageIdentity(
      generation(request.headers.get('x-otto-generation')),
    );
    if (
      identity.environment !== env.OTTO_ENVIRONMENT ||
      context.containerId !== env.TENANTS.idFromName(tenantName(env, identity.ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    return await storageRequest(request, identity, env.TENANT_FILES);
  } catch (error) {
    return failure(error);
  }
};

const controlOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    const url = new URL(request.url);
    if (
      context.className !== 'TenantContainer' ||
      request.method !== 'POST' ||
      url.search ||
      !['/api/internal/channels/claim', '/api/internal/channels/release'].includes(url.pathname)
    )
      throw new RuntimeControlError(403);
    const tenant = env.TENANTS.get(env.TENANTS.idFromString(context.containerId));
    const identity = await tenant.storageIdentity();
    if (
      identity.environment !== env.OTTO_ENVIRONMENT ||
      context.containerId !==
        env.TENANTS.idFromName(tenantName(env, identity.ownerId)).toString() ||
      request.headers.get('x-otto-owner') !== identity.ownerId ||
      !request.headers.has('x-otto-runtime')
    )
      throw new RuntimeControlError(403);
    const target = new URL(url.pathname, publicOrigin(env));
    const headers = new Headers({ host: target.host, 'x-otto-owner': identity.ownerId });
    for (const name of ['content-type', 'x-otto-runtime']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return await env.GATEWAY.getByName(gatewayName(env)).fetch(
      new Request(target, {
        method: 'POST',
        headers,
        body: request.body,
      }),
    );
  } catch (error) {
    return failure(error);
  }
};

const computerOutbound: OutboundHandler<Bindings> = async (request, env, context) => {
  try {
    if (context.className !== 'TenantContainer') throw new RuntimeControlError(403);
    const version = generation(request.headers.get('x-otto-generation'));
    const tenant = env.TENANTS.get(env.TENANTS.idFromString(context.containerId));
    const url = new URL(request.url);
    if (url.pathname === '/v1/stopped') {
      if (request.method !== 'POST' || url.search || url.hash) throw new RuntimeControlError(400);
      const body = await controlBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new RuntimeControlError(400);
      await tenant.recordExternalComputerStopped(version);
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    }
    const role = request.headers.get('x-otto-computer-role');
    if (role !== 'browser' && role !== 'workspace') throw new RuntimeControlError(400);
    const identity = await tenant.storageIdentity(version);
    if (
      computerProvider(identity) !== 'cloudflare' ||
      identity.environment !== env.OTTO_ENVIRONMENT ||
      context.containerId !== env.TENANTS.idFromName(tenantName(env, identity.ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    const namespace = role === 'browser' ? env.BROWSER_COMPUTERS : env.WORKSPACE_COMPUTERS;
    return await namespace
      .getByName(computerName(identity.environment, identity.ownerId, role))
      .request(identity.ownerId, version, request);
  } catch (error) {
    return failure(error);
  }
};

export class GatewayContainer extends Container<Bindings> {
  defaultPort = 4310;
  sleepAfter = '10m';
  enableInternet = true;
  private ready: Promise<void> | undefined;
  private deployment: ReturnType<typeof createGatewayDeployment> | undefined;

  private deploymentControl() {
    if (this.ctx.id.toString() !== this.env.GATEWAY.idFromName(gatewayName(this.env)).toString())
      throw new RuntimeControlError(403);
    this.deployment ??= createGatewayDeployment({
      storage: this.ctx.storage,
      environment: this.env.OTTO_ENVIRONMENT,
      gatewayEnvironment: this.env.GATEWAY_ENV,
      requireInitialization:
        this.env.OTTO_ENVIRONMENT === 'production' || this.env.OTTO_DEPLOYMENT_MANAGED === 'true',
      forward: (request) => this.forward(request),
    });
    return this.deployment;
  }

  deploymentClosed() {
    return this.deploymentControl().closed();
  }

  async deploymentRetirementIdentity(raw: DeploymentInput) {
    const input = deploymentInputSchema.parse(raw);
    if (!(await this.deploymentClosed())) throw new RuntimeControlError(409);
    const state = await this.ctx.storage.get<DeploymentState>('deployment-barrier');
    const configured = environmentValues(JSON.parse(this.env.GATEWAY_ENV));
    if (
      state?.phase !== 'draining' ||
      state.nonce !== input.nonce ||
      state.targetRelease !== input.targetRelease ||
      state.deadline !== input.deadline ||
      state.previousRelease !== configured.OTTO_RELEASE ||
      input.deadline <= Date.now() ||
      input.deadline > Date.now() + deploymentMaximumDuration
    )
      throw new RuntimeControlError(409);
    return { previousRelease: state.previousRelease };
  }

  override async onActivityExpired() {}

  async wake() {
    if (await this.deploymentClosed()) return;
    const response = await this.fetch(
      new Request(`${publicOrigin(this.env)}/api/health`, {
        headers: { host: new URL(publicOrigin(this.env)).host },
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error('The gateway recovery check failed.');
  }

  override async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (url.origin !== publicOrigin(this.env) || (origin && origin !== publicOrigin(this.env)))
        throw new RuntimeControlError(403);
      if (url.pathname === deploymentPath)
        return Response.json(await this.deploymentControl().handle(request), {
          headers: { 'cache-control': 'no-store' },
        });
      const anonymousSmoke =
        request.method === 'GET' &&
        !url.search &&
        !request.headers.has('cookie') &&
        !request.headers.has('authorization') &&
        ['/api/session', '/api/state'].includes(url.pathname);
      if (url.pathname !== '/api/health' && !anonymousSmoke && (await this.deploymentClosed()))
        throw new RuntimeControlError(503);
      return await this.forward(request);
    } catch (error) {
      return failure(
        error instanceof DeploymentControlError ? new RuntimeControlError(error.status) : error,
      );
    }
  }

  private async forward(request: Request) {
    this.ready ??= this.configure().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
    if (!this.ctx.container?.running || (await this.getState()).status !== 'healthy')
      await startContainer(this, { signal: request.signal });
    this.renewActivityTimeout();
    return fetchContainer(this.ctx.container, this.defaultPort, request);
  }

  private async configure() {
    const configured = environmentValues(JSON.parse(this.env.GATEWAY_ENV));
    this.envVars = {
      ...configured,
      ...analyticsEnvironment(this.env.OTTO_ENVIRONMENT, configured),
      OTTO_MODE: 'gateway',
      OTTO_ENVIRONMENT: environmentName(this.env.OTTO_ENVIRONMENT),
      OTTO_PUBLIC_URL: publicOrigin(this.env),
      OTTO_RUNTIME_URL: 'http://otto.runtime',
      OTTO_DATA_ROOT: '/data',
      OTTO_BIND_HOST: '0.0.0.0',
      NODE_ENV: 'production',
      PORT: '4310',
      HOST: '0.0.0.0',
    };
    await startContainer(this);
  }

  override onError() {
    throw new Error('The gateway is temporarily unavailable.');
  }
}

export class TenantContainer extends Container<Bindings> {
  defaultPort = 4310;
  sleepAfter = '10m';
  enableInternet = true;
  envVars = { OTTO_MODE: 'tenant', NODE_ENV: 'production' };
  private deploymentWitness: { proof: RuntimeDeploymentProof; token: object } | undefined;

  override async onActivityExpired() {}
  private leaseAlarm = createRuntimeLeaseAlarm({
    read: () => this.ctx.storage.get<TenantIdentity>('identity'),
    expire: () => this.lifecycle.expire(),
    clear: () => this.deleteSchedules('expireRuntimeLease'),
    schedule: (when) => this.schedule(when, 'expireRuntimeLease'),
  });
  private lifecycle = createTenantLifecycle({
    environment: environmentName(this.env.OTTO_ENVIRONMENT),
    read: () => this.ctx.storage.get<TenantIdentity>('identity'),
    write: (identity) => this.ctx.storage.put('identity', identity),
    status: async () => {
      assertContainerStartupSettled(this);
      const state = await this.getState();
      assertContainerStartupSettled(this);
      return state.status;
    },
    start: async (envVars) => {
      await this.ctx.storage.delete('external-computer-stopped');
      if (envVars.COMPUTER_PROVIDER === 'e2b') await this.ctx.storage.delete('deployment-proof');
      await startContainer(this, { envVars });
    },
    stop: () => stopContainer(this, { running: () => this.ctx.container?.running === true }),
    leaseUpdated: () => this.leaseAlarm.update(),
    stopComputers: async (identity) => {
      if (computerProvider(identity) === 'e2b') return;
      const results = await Promise.allSettled(
        (['browser', 'workspace'] as const).map(async (role) => {
          const namespace =
            role === 'browser' ? this.env.BROWSER_COMPUTERS : this.env.WORKSPACE_COMPUTERS;
          return namespace
            .getByName(computerName(identity.environment, identity.ownerId, role))
            .stopComputer(identity.ownerId, identity.generation);
        }),
      );
      if (results.some((result) => result.status !== 'fulfilled' || result.value?.stopped !== true))
        throw new RuntimeControlError(503);
    },
    confirmComputersStopped: async (identity) => {
      if (computerProvider(identity) === 'e2b' && !(await this.externalComputerStopped(identity)))
        throw new RuntimeControlError(503);
    },
  });

  async recordExternalComputerStopped(version: string) {
    const expected = generation(version);
    await this.ctx.storage.transaction(async (storage) => {
      const identity = await storage.get<TenantIdentity>('identity');
      if (
        !identity ||
        computerProvider(identity) !== 'e2b' ||
        identity.generation !== expected ||
        identity.environment !== this.env.OTTO_ENVIRONMENT ||
        this.ctx.id.toString() !==
          this.env.TENANTS.idFromName(tenantName(this.env, identity.ownerId)).toString()
      )
        throw new RuntimeControlError(409);
      await storage.put('external-computer-stopped', {
        ownerId: identity.ownerId,
        environment: identity.environment,
        generation: identity.generation,
        configurationHash: identity.configurationHash,
      });
    });
  }

  private async externalComputerStopped(identity: TenantIdentity) {
    const stopped = await this.ctx.storage.get<Partial<TenantIdentity>>(
      'external-computer-stopped',
    );
    if (
      stopped?.ownerId === identity.ownerId &&
      stopped.environment === identity.environment &&
      stopped.generation === identity.generation &&
      stopped.configurationHash === identity.configurationHash
    )
      return true;
    const proof = await this.ctx.storage.get<RuntimeDeploymentProof>('deployment-proof');
    return Boolean(
      proof?.computerPaused === true &&
      deploymentProof(proof, proof, identity.generation) &&
      !deploymentProof(await this.ctx.storage.get('deployment-resume'), proof, identity.generation),
    );
  }

  expireRuntimeLease() {
    return this.leaseAlarm.run();
  }

  async startRuntime(input: unknown) {
    const ownerId = ownerIdentity((input as { ownerId?: unknown } | null)?.ownerId);
    if (
      this.ctx.id.toString() !==
      this.env.TENANTS.idFromName(tenantName(this.env, ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    if (await this.env.GATEWAY.getByName(gatewayName(this.env)).deploymentClosed())
      throw new RuntimeControlError(503);
    return this.lifecycle.start(input);
  }

  private async physicallyStopped() {
    assertContainerStartupSettled(this);
    const stopped =
      !this.ctx.container?.running &&
      ['stopped', 'stopped_with_code'].includes((await this.getState()).status);
    assertContainerStartupSettled(this);
    return stopped && !this.ctx.container?.running;
  }

  private async storeDeploymentProof(
    ownerId: string,
    version: string,
    input: DeploymentInput,
    requireAttempt = false,
    computerPaused = false,
  ) {
    await this.ctx.storage.transaction(async (storage) => {
      const identity = await storage.get<TenantIdentity>('identity');
      if (
        !identity ||
        identity.ownerId !== ownerId ||
        identity.generation !== version ||
        identity.environment !== this.env.OTTO_ENVIRONMENT
      )
        throw new RuntimeControlError(409);
      if (
        requireAttempt &&
        (!deploymentProof(await storage.get('deployment-attempt'), input, version) ||
          deploymentProof(await storage.get('deployment-resume'), input, version))
      )
        throw new RuntimeControlError(409);
      await storage.put('deployment-proof', {
        ...input,
        generation: version,
        ...(computerPaused && { computerPaused: true }),
      });
    });
  }

  private async beginDeployment(
    ownerId: string,
    version: string,
    input: DeploymentInput,
    action: 'drain' | 'resume',
  ) {
    this.deploymentWitness = undefined;
    await this.ctx.storage.transaction(async (storage) => {
      const identity = await storage.get<TenantIdentity>('identity');
      if (
        !identity ||
        identity.ownerId !== ownerId ||
        identity.generation !== version ||
        identity.environment !== this.env.OTTO_ENVIRONMENT
      )
        throw new RuntimeControlError(409);
      const attempt = await storage.get<RuntimeDeploymentProof>('deployment-attempt');
      const resumed = await storage.get<RuntimeDeploymentProof>('deployment-resume');
      if (action === 'drain') {
        if (
          deploymentProof(resumed, input, version) ||
          (attempt?.generation === version &&
            !deploymentProof(attempt, input, version) &&
            !deploymentProof(resumed, attempt, version))
        )
          throw new RuntimeControlError(409);
      } else {
        if (
          !deploymentProof(attempt, input, version) &&
          !deploymentProof(await storage.get('deployment-proof'), input, version)
        )
          throw new RuntimeControlError(409);
        await storage.put('deployment-resume', { ...input, generation: version });
      }
      await storage.put('deployment-attempt', { ...input, generation: version });
      await storage.delete('deployment-proof');
    });
  }

  async deploymentStoppedIdentity(owner: string, version: string | null) {
    const ownerId = ownerIdentity(owner);
    const expected = version === null ? null : generation(version);
    if (
      this.ctx.id.toString() !==
      this.env.TENANTS.idFromName(tenantName(this.env, ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    if (!(await this.env.GATEWAY.getByName(gatewayName(this.env)).deploymentClosed()))
      throw new RuntimeControlError(409);
    const stopped = await this.lifecycle.inspectStopped(ownerId, expected, () =>
      this.physicallyStopped(),
    );
    if (!(await this.env.GATEWAY.getByName(gatewayName(this.env)).deploymentClosed()))
      throw new RuntimeControlError(409);
    return stopped;
  }

  async deploymentStopped(owner: string, version: string | null) {
    const ownerId = ownerIdentity(owner);
    const expected = version === null ? null : generation(version);
    if (!(await this.deploymentStoppedIdentity(ownerId, expected))) return false;
    const identity = await this.ctx.storage.get<TenantIdentity>('identity');
    if (identity && computerProvider(identity) === 'e2b')
      return (
        (await this.externalComputerStopped(identity)) &&
        (await this.deploymentStoppedIdentity(ownerId, expected))
      );
    for (const role of ['browser', 'workspace'] as const) {
      const namespace =
        role === 'browser' ? this.env.BROWSER_COMPUTERS : this.env.WORKSPACE_COMPUTERS;
      if (
        !(await namespace
          .getByName(computerName(this.env.OTTO_ENVIRONMENT, ownerId, role))
          .inspectDeploymentStopped(ownerId, expected))
      )
        return false;
    }
    return this.deploymentStoppedIdentity(ownerId, expected);
  }

  async deploymentComputerIdentity(owner: string, version: string, raw: DeploymentInput) {
    const ownerId = ownerIdentity(owner);
    const expected = generation(version);
    const input = deploymentInputSchema.parse(raw);
    if (input.deadline <= Date.now() || input.deadline > Date.now() + deploymentMaximumDuration)
      throw new RuntimeControlError(409);
    const identity = await this.ctx.storage.get<TenantIdentity>('identity');
    const proof = await this.ctx.storage.get<RuntimeDeploymentProof>('deployment-proof');
    if (
      !identity ||
      identity.ownerId !== ownerId ||
      identity.generation !== expected ||
      identity.environment !== this.env.OTTO_ENVIRONMENT ||
      !deploymentProof(proof, input, expected) ||
      (!deploymentProof(this.deploymentWitness?.proof, input, expected) &&
        !(await this.physicallyStopped()))
    )
      throw new RuntimeControlError(409);
    return identity;
  }

  async deploymentUnusedComputerIdentity(owner: string, version: string, raw: DeploymentInput) {
    const ownerId = ownerIdentity(owner);
    const expected = generation(version);
    const input = deploymentInputSchema.parse(raw);
    const witness = this.deploymentWitness;
    const barrier = () =>
      this.env.GATEWAY.getByName(gatewayName(this.env)).deploymentRetirementIdentity(input);
    if (!witness || !deploymentProof(witness.proof, input, expected))
      throw new RuntimeControlError(409);
    const operation = await barrier();
    const identity = await this.deploymentComputerIdentity(ownerId, expected, input);
    const [attempt, proof, resumed] = await Promise.all([
      this.ctx.storage.get<RuntimeDeploymentProof>('deployment-attempt'),
      this.ctx.storage.get<RuntimeDeploymentProof>('deployment-proof'),
      this.ctx.storage.get<RuntimeDeploymentProof>('deployment-resume'),
    ]);
    if (
      !deploymentProof(attempt, input, expected) ||
      !deploymentProof(proof, input, expected) ||
      deploymentProof(resumed, input, expected)
    )
      throw new RuntimeControlError(409);
    const currentOperation = await barrier();
    const latest = await this.ctx.storage.get<TenantIdentity>('identity');
    if (
      !latest ||
      latest.ownerId !== ownerId ||
      latest.environment !== identity.environment ||
      latest.generation !== expected ||
      latest.configurationHash !== identity.configurationHash ||
      latest.stopped ||
      latest.revoking ||
      latest.leaseExpiresAt <= Date.now() ||
      currentOperation.previousRelease !== operation.previousRelease ||
      this.deploymentWitness !== witness ||
      input.deadline <= Date.now()
    )
      throw new RuntimeControlError(409);
    return latest;
  }

  async prepareDeploymentDrain(owner: string, version: string, raw: DeploymentInput) {
    const ownerId = ownerIdentity(owner);
    const expected = generation(version);
    const input = deploymentInputSchema.parse(raw);
    if (
      this.ctx.id.toString() !==
      this.env.TENANTS.idFromName(tenantName(this.env, ownerId)).toString()
    )
      throw new RuntimeControlError(403);
    const identity = await this.ctx.storage.get<TenantIdentity>('identity');
    const external = identity && computerProvider(identity) === 'e2b';
    if (await this.physicallyStopped()) {
      if (external && !(await this.externalComputerStopped(identity)))
        throw new RuntimeControlError(503);
      await this.storeDeploymentProof(ownerId, expected, input, false, Boolean(external));
    }
    await this.deploymentComputerIdentity(ownerId, expected, input);
    let progressed = false;
    if (external && !(await this.externalComputerStopped(identity)))
      throw new RuntimeControlError(503);
    for (const role of external ? [] : (['browser', 'workspace'] as const)) {
      const namespace =
        role === 'browser' ? this.env.BROWSER_COMPUTERS : this.env.WORKSPACE_COMPUTERS;
      const result = await namespace
        .getByName(computerName(this.env.OTTO_ENVIRONMENT, ownerId, role))
        .prepareDeploymentDrain(ownerId, expected, input);
      if (result.status !== 'drained')
        return {
          ok: false as const,
          status: result.status === 'busy' && !progressed ? ('busy' as const) : ('unsafe' as const),
          generation: expected,
        };
      if (result.generation !== expected || result.clean !== true || result.stopped !== true)
        throw new RuntimeControlError(503);
      progressed = true;
      await this.deploymentComputerIdentity(ownerId, expected, input);
    }
    await this.lifecycle.stop(ownerId, expected);
    if (!(await this.physicallyStopped())) throw new RuntimeControlError(503);
    return {
      ok: true as const,
      generation: expected,
      clean: true as const,
      stopped: true as const,
    };
  }

  override onStop() {
    this.deploymentWitness = undefined;
  }

  stopRuntime(ownerId: unknown, generation: unknown) {
    return this.lifecycle.stop(ownerId, generation);
  }

  storageIdentity(expectedGeneration?: string) {
    return this.lifecycle.identity(expectedGeneration);
  }

  async computerIdentity(owner: string, version: string, stopping: boolean) {
    const ownerId = ownerIdentity(owner);
    const expected = generation(version);
    if (typeof stopping !== 'boolean') throw new RuntimeControlError();
    const identity = stopping
      ? await this.ctx.storage.get<TenantIdentity>('identity')
      : await this.lifecycle.identity(expected);
    if (
      !identity ||
      computerProvider(identity) !== 'cloudflare' ||
      identity.ownerId !== ownerId ||
      identity.environment !== this.env.OTTO_ENVIRONMENT ||
      identity.generation !== expected ||
      (stopping && identity.revoking !== true)
    )
      throw new RuntimeControlError(403);
    return identity;
  }

  async runtimeStatus() {
    assertContainerStartupSettled(this);
    const identity = await this.ctx.storage.get<TenantIdentity>('identity');
    const state = await this.getState();
    assertContainerStartupSettled(this);
    return {
      generation: identity?.generation ?? null,
      stopped:
        !this.ctx.container?.running &&
        ['stopped', 'stopped_with_code'].includes(state.status) &&
        (!identity ||
          computerProvider(identity) !== 'e2b' ||
          (await this.externalComputerStopped(identity))),
      status: state.status,
    };
  }

  override async fetch(request: Request) {
    try {
      const identity = await this.lifecycle.identity();
      const generation = runtimeRoutingGeneration(request, identity);
      const forward = async (input: Request) => {
        await this.lifecycle.identity(generation);
        const state = await this.getState();
        if (!['running', 'healthy'].includes(state.status)) throw new RuntimeControlError(503);
        this.renewActivityTimeout();
        return fetchContainer(this.ctx.container, this.defaultPort, input);
      };
      if (new URL(request.url).pathname === '/api/runtime/lease') {
        const { bytes, expiresAt } = await runtimeLeaseBody(request);
        return await this.lifecycle.renew(identity.ownerId, generation, expiresAt, async () =>
          runtimeLeaseAcknowledgement(await forward(new Request(request, { body: bytes }))),
        );
      }
      const path = new URL(request.url).pathname;
      if (path === '/api/runtime/drain' || path === '/api/runtime/resume') {
        const { bytes, input } = await runtimeDeploymentBody(request);
        const action = path === '/api/runtime/drain' ? 'drain' : 'resume';
        await this.beginDeployment(identity.ownerId, generation, input, action);
        const response = await runtimeDeploymentAcknowledgement(
          await forward(new Request(request, { body: bytes })),
          input,
          generation,
          action,
          computerProvider(identity) === 'e2b',
        );
        if (action === 'drain') {
          await this.storeDeploymentProof(
            identity.ownerId,
            generation,
            input,
            true,
            computerProvider(identity) === 'e2b',
          );
          const token = {};
          this.deploymentWitness = { proof: { ...input, generation }, token };
          void this.ctx
            .container!.monitor()
            .finally(() => {
              if (this.deploymentWitness?.token === token) this.deploymentWitness = undefined;
            })
            .catch(() => {});
        }
        return response;
      }
      return await forward(request);
    } catch (error) {
      return failure(error);
    }
  }

  override onError() {
    throw new Error('The account runtime is temporarily unavailable.');
  }
}

GatewayContainer.outboundByHost = { 'otto.runtime': runtimeOutbound };
TenantContainer.outboundByHost = {
  'otto.storage': storageOutbound,
  'otto.control': controlOutbound,
  'otto.computer': computerOutbound,
};

export default {
  async scheduled(_event: ScheduledController, env: Bindings) {
    await env.GATEWAY.getByName(gatewayName(env)).wake();
  },
  async fetch(request: Request, env: Bindings) {
    try {
      const url = new URL(request.url);
      if (url.origin !== publicOrigin(env)) throw new RuntimeControlError(403);
      if (url.pathname.startsWith('/runtime/') || url.pathname.startsWith('/__otto/'))
        throw new RuntimeControlError(404);
      if (url.pathname.startsWith('/api/')) {
        const forwarded = new Request(request);
        forwarded.headers.set('host', url.host);
        return await env.GATEWAY.getByName(gatewayName(env)).fetch(forwarded);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      return failure(error);
    }
  },
} satisfies ExportedHandler<Bindings>;
