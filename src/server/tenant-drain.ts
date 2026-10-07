import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeploymentInput, TenantDrain } from '../ports/deployment.ts';
import { deploymentInputSchema, deploymentMaximumDuration } from './deployment-auth.ts';
import type { WorkAdmission, WorkConsumers } from './work-admission.ts';

const unavailable = (statusCode = 503) =>
  Object.assign(new Error('The runtime deployment drain could not be completed.'), { statusCode });

export function createTenantDrain(options: {
  admission: WorkAdmission;
  consumers: WorkConsumers;
  computer?: { pause(): Promise<void>; resume(): Promise<void> };
}): TenantDrain {
  let selected: DeploymentInput | undefined;
  let resumed: DeploymentInput | undefined;
  let token = 0;
  let stopping: Promise<void> | undefined;
  let resuming: Promise<void> | undefined;
  let pausingComputer: Promise<void> | undefined;
  let computerPaused = false;
  const matches = (first: DeploymentInput | undefined, second: DeploymentInput) =>
    first &&
    first.nonce === second.nonce &&
    first.targetRelease === second.targetRelease &&
    first.deadline === second.deadline;

  async function beforeDeadline(operation: Promise<void>, deadline: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (Date.now() >= deadline) throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async prepare(raw) {
      const input = deploymentInputSchema.parse(raw);
      if (
        options.admission.closed ||
        (selected && !matches(selected, input)) ||
        matches(resumed, input) ||
        resuming
      )
        throw unavailable(409);
      if (input.deadline <= Date.now() || input.deadline > Date.now() + deploymentMaximumDuration)
        throw unavailable();
      if (!selected) {
        selected = input;
        token++;
        options.admission.pause();
        stopping = options.consumers.pause();
      }
      const current = token;
      try {
        await beforeDeadline(stopping!, input.deadline);
        if (current !== token) throw unavailable();
        await options.admission.drain(input.deadline);
        if (current !== token || resuming || options.admission.closed) throw unavailable(409);
        if (options.computer) {
          pausingComputer ??= options.computer.pause().then(() => {
            computerPaused = true;
          });
          await beforeDeadline(pausingComputer, input.deadline);
          if (!computerPaused) throw unavailable();
        }
      } catch {
        throw unavailable(current !== token ? 409 : 503);
      }
      if (current !== token || !matches(selected, input) || resuming || options.admission.closed)
        throw unavailable(409);
      if (Date.now() >= input.deadline) throw unavailable();
    },
    async resume(raw) {
      const input = deploymentInputSchema.parse(raw);
      if (options.admission.closed) throw unavailable(409);
      if (!selected && matches(resumed, input)) return;
      if (!matches(selected, input)) throw unavailable(409);
      if (resuming) return resuming;
      token++;
      const operation = (async () => {
        if (pausingComputer)
          await beforeDeadline(
            pausingComputer.catch(() => {}),
            Date.now() + 30_000,
          );
        computerPaused = false;
        if (options.computer) await beforeDeadline(options.computer.resume(), Date.now() + 30_000);
        pausingComputer = undefined;
        await options.consumers.resume();
      })()
        .then(() => {
          if (options.admission.closed) throw unavailable();
          options.admission.resume();
          resumed = selected;
          selected = undefined;
          stopping = undefined;
          pausingComputer = undefined;
        })
        .catch(() => {
          stopping = options.consumers.pause();
          void stopping.catch(() => {});
          throw unavailable();
        })
        .finally(() => {
          resuming = undefined;
        });
      resuming = operation;
      return operation;
    },
    active: () => Boolean(selected) || options.admission.closed,
    ...(options.computer ? { computerPaused: () => computerPaused } : {}),
  };
}

export function registerWorkAdmission(app: FastifyInstance, admission: WorkAdmission) {
  type Admitted = {
    release(): void;
    started: boolean;
    finished: boolean;
    responded: boolean;
    disconnected: boolean;
    cleanup(): void;
  };
  const accepted = new WeakMap<FastifyRequest, Admitted>();
  function release(request: FastifyRequest) {
    const state = accepted.get(request);
    if (!state || (state.started && !state.finished) || (!state.responded && !state.disconnected))
      return;
    state.release();
    state.cleanup();
    accepted.delete(request);
  }
  const controls = new Set(['/api/runtime/lease', '/api/runtime/drain', '/api/runtime/resume']);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (controls.has(path)) return;
    if (path === '/api/events' && !admission.paused && !admission.closed) return;
    const releaseAdmission = admission.enter();
    if (!releaseAdmission)
      return reply.code(503).send({ error: 'The account runtime is preparing an update.' });
    const disconnected = () => {
      const state = accepted.get(request);
      if (state) state.disconnected = true;
      releaseRequest();
    };
    const releaseRequest = () => release(request);
    accepted.set(request, {
      release: releaseAdmission,
      started: false,
      finished: false,
      responded: false,
      disconnected: false,
      cleanup: () => {
        reply.raw.off('close', disconnected);
      },
    });
    reply.raw.once('close', disconnected);
    if (reply.raw.destroyed) disconnected();
  });
  app.addHook('onResponse', async (request) => {
    const state = accepted.get(request);
    if (state) state.responded = true;
    release(request);
  });
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      if (reply.raw.destroyed) return;
      const state = accepted.get(request);
      if (state) state.started = true;
      try {
        return await handler.call(this, request, reply);
      } finally {
        if (state) state.finished = true;
        release(request);
      }
    };
  });
}

export function registerTenantDrain(
  app: FastifyInstance,
  options: {
    admission: WorkAdmission;
    drain: TenantDrain;
    generation: string;
  },
) {
  registerWorkAdmission(app, options.admission);
  app.post('/api/runtime/drain', async (request) => {
    const input = deploymentInputSchema.parse(request.body);
    await options.drain.prepare(input);
    return {
      ok: true,
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      generation: options.generation,
      drained: true,
      ...(options.drain.computerPaused?.() === true ? { computerPaused: true } : {}),
    };
  });
  app.post('/api/runtime/resume', async (request) => {
    const input = deploymentInputSchema.parse(request.body);
    await options.drain.resume(input);
    return { ok: true };
  });
}
