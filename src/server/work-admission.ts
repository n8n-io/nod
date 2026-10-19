import type { FastifyInstance, FastifyRequest } from 'fastify';

const unavailable = () =>
  Object.assign(new Error('Work admission is paused.'), { statusCode: 503 });

export function createWorkAdmission() {
  let paused = false;
  let closed = false;
  let pending = 0;
  const listeners = new Set<() => void>();

  function enter() {
    if (paused || closed) return undefined;
    pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending--;
      if (!pending) for (const listener of listeners) listener();
    };
  }
  function pause() {
    paused = true;
  }
  function run<T>(operation: () => Promise<T>): Promise<T> | undefined {
    const release = enter();
    if (!release) return undefined;
    return Promise.resolve().then(operation).finally(release);
  }
  function drain(deadline: number) {
    if ((!paused && !closed) || !Number.isSafeInteger(deadline) || deadline <= Date.now())
      return Promise.reject(unavailable());
    if (!pending) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if ((!paused && !closed) || Date.now() >= deadline) reject(unavailable());
        else resolve();
      };
      const timer = setTimeout(
        () => {
          listeners.delete(finish);
          reject(unavailable());
        },
        Math.min(deadline - Date.now(), 2_147_483_647),
      );
      listeners.add(finish);
    });
  }
  return {
    enter,
    run,
    pause,
    drain,
    resume() {
      if (closed) throw unavailable();
      paused = false;
      for (const listener of listeners) listener();
    },
    close() {
      closed = true;
      pause();
    },
    get paused() {
      return paused;
    },
    get closed() {
      return closed;
    },
    get pending() {
      return pending;
    },
  };
}

export type WorkAdmission = ReturnType<typeof createWorkAdmission>;

export function createWorkConsumers() {
  type Instance = { ready: Promise<string>; stopping?: Promise<void>; failed?: boolean };
  type Consumer = {
    start(): Promise<string>;
    stop(id: string): Promise<void>;
    instances: Set<Instance>;
  };
  const consumers = new Set<Consumer>();
  let paused = false;
  let closed = false;

  function start(consumer: Consumer) {
    if (paused || closed) return Promise.resolve();
    if ([...consumer.instances].some((instance) => instance.failed))
      return Promise.reject(unavailable());
    const existing = [...consumer.instances].find((instance) => !instance.stopping);
    if (existing) return existing.ready.then(() => {});
    const instance: Instance = { ready: Promise.resolve().then(() => consumer.start()) };
    consumer.instances.add(instance);
    return instance.ready.then(() => {});
  }
  function stop(consumer: Consumer, instance: Instance) {
    instance.stopping ??= instance.ready
      .then((id) => consumer.stop(id))
      .then(() => {
        consumer.instances.delete(instance);
      })
      .catch((error) => {
        instance.failed = true;
        throw error;
      });
    return instance.stopping;
  }
  function pause() {
    paused = true;
    return Promise.all(
      [...consumers].flatMap((consumer) =>
        [...consumer.instances].map((instance) => stop(consumer, instance)),
      ),
    ).then(() => {});
  }
  return {
    async register(input: { start(): Promise<string>; stop(id: string): Promise<void> }) {
      if (closed) throw unavailable();
      const consumer: Consumer = { ...input, instances: new Set() };
      consumers.add(consumer);
      await start(consumer);
    },
    pause,
    async resume() {
      if (closed) throw unavailable();
      paused = false;
      await Promise.all([...consumers].map(start));
    },
    close() {
      closed = true;
      return pause();
    },
  };
}

export type WorkConsumers = ReturnType<typeof createWorkConsumers>;

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
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
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
