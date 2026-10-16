import {
  bootstrap,
  computerProvider,
  generation,
  leaseExpiry,
  ownerIdentity,
  RuntimeControlError,
  type TenantIdentity,
} from './protocol.ts';

type ContainerState = 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code';

export function createTenantLifecycle(options: {
  environment: string;
  read(): Promise<TenantIdentity | undefined>;
  write(identity: TenantIdentity): Promise<void>;
  status(): Promise<ContainerState>;
  start(env: Record<string, string>): Promise<void>;
  stop(): Promise<void>;
  stopComputers?(identity: TenantIdentity): Promise<void>;
  confirmComputersStopped?(identity: TenantIdentity): Promise<void>;
  leaseUpdated?(identity: TenantIdentity): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let pending: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  function active(identity: TenantIdentity | undefined): identity is TenantIdentity {
    return !!(
      identity &&
      identity.environment === options.environment &&
      identity.stopped === false &&
      identity.revoking === false &&
      Number.isSafeInteger(identity.leaseExpiresAt) &&
      identity.leaseExpiresAt > now()
    );
  }

  async function write(identity: TenantIdentity) {
    await options.write(identity);
    await options.leaseUpdated?.(identity);
  }

  async function stop(identity: TenantIdentity) {
    const revoking = {
      ...identity,
      leaseExpiresAt: Number.isSafeInteger(identity.leaseExpiresAt) ? identity.leaseExpiresAt : 0,
      revoking: true,
      stopped: false,
    };
    await write(revoking);
    await options.stopComputers?.(revoking);
    await options.stop();
    const state = await options.status();
    if (state !== 'stopped' && state !== 'stopped_with_code') throw new RuntimeControlError(503);
    await options.confirmComputersStopped?.(revoking);
    await write({ ...revoking, stopped: true });
    return { ok: true, generation: identity.generation, stopped: true };
  }

  return {
    start(input: unknown) {
      return exclusive(async () => {
        const next = await bootstrap(input, options.environment, now);
        const previous = await options.read();
        const state = await options.status();
        const stopped = state === 'stopped' || state === 'stopped_with_code';
        if (previous) {
          if (
            previous.ownerId !== next.identity.ownerId ||
            previous.environment !== next.identity.environment
          )
            throw new RuntimeControlError(409);
          if (previous.generation === next.identity.generation) {
            if (
              previous.configurationHash !== next.identity.configurationHash ||
              !active(previous) ||
              (stopped && computerProvider(previous) === 'e2b')
            )
              throw new RuntimeControlError(409);
            next.identity = previous;
          } else if (
            !stopped ||
            !previous.stopped ||
            BigInt(previous.generation) >= BigInt(next.identity.generation)
          ) {
            throw new RuntimeControlError(409);
          }
        } else if (!stopped) throw new RuntimeControlError(409);
        if (state === 'stopping') throw new RuntimeControlError(409);
        await write(next.identity);
        await options.start(next.env);
        return { ok: true, generation: next.identity.generation };
      });
    },
    stop(owner: unknown, version: unknown) {
      return exclusive(async () => {
        const ownerId = ownerIdentity(owner);
        const expected = generation(version);
        const identity = await options.read();
        if (!identity || identity.ownerId !== ownerId || identity.generation !== expected)
          throw new RuntimeControlError(409);
        return stop(identity);
      });
    },
    async renew<T>(
      owner: unknown,
      version: unknown,
      expiresAt: unknown,
      acknowledge: () => Promise<T>,
    ): Promise<T> {
      const ownerId = ownerIdentity(owner);
      const expected = generation(version);
      function matches(identity: TenantIdentity | undefined): identity is TenantIdentity {
        return active(identity) && identity.ownerId === ownerId && identity.generation === expected;
      }
      await exclusive(async () => {
        const identity = await options.read();
        if (!matches(identity)) throw new RuntimeControlError(409);
        if (leaseExpiry(expiresAt, now) <= identity.leaseExpiresAt)
          throw new RuntimeControlError(409);
      });
      const result = await acknowledge();
      await exclusive(async () => {
        const identity = await options.read();
        if (!matches(identity)) throw new RuntimeControlError(409);
        const expiry = leaseExpiry(expiresAt, now);
        if (expiry <= identity.leaseExpiresAt) throw new RuntimeControlError(409);
        await write({ ...identity, leaseExpiresAt: expiry });
      });
      return result;
    },
    expire() {
      return exclusive(async () => {
        const identity = await options.read();
        if (
          !identity ||
          identity.stopped ||
          (identity.revoking !== true &&
            (!Number.isSafeInteger(identity.leaseExpiresAt) || identity.leaseExpiresAt > now()))
        )
          return;
        return stop(identity);
      });
    },
    inspectStopped(
      owner: string,
      version: string | null,
      physicallyStopped: () => Promise<boolean>,
    ) {
      return exclusive(async () => {
        const ownerId = ownerIdentity(owner);
        const expected = version === null ? null : generation(version);
        const identity = await options.read();
        if (
          expected === null
            ? identity !== undefined
            : !identity ||
              identity.ownerId !== ownerId ||
              identity.environment !== options.environment ||
              identity.generation !== expected
        )
          return false;
        const state = await options.status();
        if (state !== 'stopped' && state !== 'stopped_with_code') return false;
        return physicallyStopped();
      });
    },
    async identity(expectedGeneration?: string) {
      const identity = await options.read();
      if (!active(identity)) throw new RuntimeControlError(503);
      if (
        expectedGeneration !== undefined &&
        identity.generation !== generation(expectedGeneration)
      )
        throw new RuntimeControlError(409);
      return identity;
    },
  };
}
