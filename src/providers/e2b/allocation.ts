import { createHash, randomUUID } from 'node:crypto';
import type {
  ComputerAllocation,
  ComputerAllocationRole,
  ComputerAllocationStore,
} from '../../ports/computer-allocation.ts';
import type { E2BClient, E2BSandbox } from './client.ts';

const unavailable = () => new Error('The remote computer needs recovery before continuing.');

export function createE2BAllocation(options: {
  ownerId: string;
  role: ComputerAllocationRole;
  templateId: string;
  store: ComputerAllocationStore;
  client: E2BClient;
  leaseMs?: number;
  idlePauseMs?: number;
  maxActiveMs?: number;
}) {
  const leaseMs = options.leaseMs ?? 90_000;
  const idlePauseMs = options.idlePauseMs ?? 120_000;
  const maxActiveMs = options.maxActiveMs ?? 45 * 60_000;
  if (
    !options.ownerId ||
    options.ownerId.length > 200 ||
    !options.templateId.trim() ||
    leaseMs < 300 ||
    idlePauseMs < 50 ||
    maxActiveMs < 300
  )
    throw new Error('The remote computer configuration is invalid.');
  const listeners = new Set<() => void>();
  const leaseId = randomUUID();
  let record: ComputerAllocation | undefined;
  let sandbox: E2BSandbox | undefined;
  let opening: Promise<E2BSandbox> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fenced = false;
  let disposed = false;
  let serial: Promise<unknown> = Promise.resolve();
  let disposing: Promise<void> | undefined;
  let pauseFailed = false;
  let paused = false;
  let users = 0;
  let lastUsed = Date.now();
  let activeSince = Date.now();
  let transitioning: Promise<unknown> = Promise.resolve();
  const idleWaiters = new Set<() => void>();
  function transition<T>(action: () => Promise<T>) {
    const next = transitioning.then(action);
    transitioning = next.catch(() => {});
    return next;
  }

  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = serial.then(action);
    serial = result.catch(() => {});
    return result;
  }
  async function update(changes: Partial<ComputerAllocation>) {
    if (!record) throw unavailable();
    const next = { ...record, ...changes, version: record.version + 1 };
    if (!(await options.store.compareAndSwap(record.version, next))) throw unavailable();
    record = next;
  }
  function fence() {
    if (fenced) return;
    fenced = true;
    clearInterval(timer);
    for (const listener of listeners) listener();
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
    void exclusive(async () => {
      if (record?.leaseId === leaseId) await update({ state: 'uncertain' });
    }).catch(() => {});
  }
  async function renew() {
    if (fenced || disposed) throw unavailable();
    try {
      await exclusive(async () => {
        if (!record || record.leaseId !== leaseId || (record.leaseExpiresAt ?? 0) <= Date.now())
          throw unavailable();
        await update({ leaseExpiresAt: Date.now() + leaseMs });
      });
    } catch {
      fence();
      throw unavailable();
    }
  }
  async function previousAllocation() {
    if (
      options.role === 'computer' &&
      (
        await Promise.all([
          options.store.read(options.ownerId, 'browser'),
          options.store.read(options.ownerId, 'workspace'),
        ])
      ).some(Boolean)
    )
      throw unavailable();
    const previous = await options.store.read(options.ownerId, options.role);
    if (
      previous &&
      (previous.ownerId !== options.ownerId ||
        previous.role !== options.role ||
        previous.provider !== 'e2b' ||
        previous.templateId !== options.templateId ||
        previous.state !== 'ready' ||
        previous.leaseId !== null ||
        !previous.resourceId)
    )
      throw unavailable();
    return previous;
  }
  async function open() {
    const previous = await previousAllocation();
    const next: ComputerAllocation = {
      ownerId: options.ownerId,
      role: options.role,
      provider: 'e2b',
      templateId: options.templateId,
      resourceId: previous?.resourceId ?? null,
      generation: previous?.generation ?? randomUUID(),
      version: (previous?.version ?? 0) + 1,
      state: previous ? 'ready' : 'allocating',
      leaseId,
      leaseExpiresAt: Date.now() + leaseMs,
    };
    if (!(await options.store.compareAndSwap(previous?.version ?? null, next))) throw unavailable();
    record = next;
    try {
      const value = previous?.resourceId
        ? await options.client.connect(previous.resourceId)
        : await options.client.create(options.templateId, {
            otto_owner: createHash('sha256').update(options.ownerId).digest('hex'),
            otto_role: options.role,
            otto_generation: next.generation,
          });
      sandbox = value;
      if (!value.id || (previous?.resourceId && value.id !== previous.resourceId))
        throw unavailable();
      if (fenced || disposed) throw unavailable();
      await exclusive(() => update({ resourceId: value.id, state: 'allocating' }));
      await value.ready();
      if (fenced || disposed) throw unavailable();
      await exclusive(() => update({ resourceId: value.id, state: 'ready' }));
      activeSince = Date.now();
      lastUsed = Date.now();
      timer = setInterval(
        () => {
          void maintain().catch(fence);
        },
        Math.floor(leaseMs / 3),
      );
      timer.unref();
      return value;
    } catch {
      fence();
      throw unavailable();
    }
  }
  async function pause() {
    if (!sandbox || paused || users) return;
    pauseFailed = true;
    await sandbox.pause();
    paused = true;
    pauseFailed = false;
  }
  async function maintain() {
    await transition(async () => {
      if (disposed || fenced) return;
      await renew();
      if (!sandbox || paused) return;
      if (
        !users &&
        (Date.now() - lastUsed >= idlePauseMs || Date.now() - activeSince >= maxActiveMs)
      )
        await pause();
      else await sandbox.keepAlive();
    });
  }
  async function acquire() {
    if (fenced || disposed) throw unavailable();
    opening ??= open().catch(() => {
      fence();
      throw unavailable();
    });
    await opening;
    while (true) {
      const result = await transition(async () => {
        if (fenced || disposed || !sandbox) throw unavailable();
        await renew();
        if (!paused && Date.now() - activeSince >= maxActiveMs) {
          if (users)
            return {
              waiting: new Promise<void>((resolve) => {
                idleWaiters.add(resolve);
              }),
            };
          await pause();
        }
        if (paused) {
          const resumed = await options.client.connect(sandbox.id);
          if (resumed.id !== sandbox.id) throw unavailable();
          await resumed.ready();
          sandbox = resumed;
          activeSince = Date.now();
          paused = false;
        }
        await renew();
        await sandbox.keepAlive();
        if (fenced || disposed) throw unavailable();
        users++;
        let released = false;
        return {
          sandbox,
          release() {
            if (released) return;
            released = true;
            users--;
            lastUsed = Date.now();
            if (!users) {
              for (const resolve of idleWaiters) resolve();
              idleWaiters.clear();
            }
          },
        };
      }).catch(() => {
        fence();
        throw unavailable();
      });
      if ('waiting' in result) {
        await result.waiting;
        continue;
      }
      return result;
    }
  }
  return {
    acquire,
    async pause() {
      if (fenced || disposed) throw unavailable();
      if (!opening) {
        await previousAllocation();
        return;
      }
      await opening;
      await transition(async () => {
        if (fenced || disposed || users) throw unavailable();
        await renew();
        try {
          await pause();
        } catch {
          fence();
          await serial;
          throw unavailable();
        }
      });
    },
    async resume() {
      await transitioning;
      await serial;
      if (fenced || disposed) throw unavailable();
      if (opening) {
        await opening;
        await renew();
      } else await previousAllocation();
    },
    async get() {
      const acquired = await acquire();
      acquired.release();
      return acquired.sandbox;
    },
    fence,
    onFence(listener: () => void) {
      listeners.add(listener);
      if (fenced) listener();
      return () => listeners.delete(listener);
    },
    dispose() {
      disposing ??= (async () => {
        disposed = true;
        clearInterval(timer);
        if (!opening) {
          await previousAllocation();
          return;
        }
        await opening.catch(() => {});
        await transitioning;
        await serial;
        if ((fenced && !pauseFailed) || !sandbox || !record || users) throw unavailable();
        try {
          pauseFailed = true;
          if (!paused) await sandbox.pause();
          paused = true;
          await exclusive(() => update({ state: 'ready', leaseId: null, leaseExpiresAt: null }));
          pauseFailed = false;
        } catch {
          fence();
          await serial;
          throw unavailable();
        }
      })().catch((error) => {
        disposing = undefined;
        throw error;
      });
      return disposing;
    },
  };
}

export type E2BAllocation = ReturnType<typeof createE2BAllocation>;
