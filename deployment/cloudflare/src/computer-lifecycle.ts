import { CheckpointTooLarge, type ComputerCheckpoint } from './computer-checkpoints.ts';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import { cleanStoppedComputer, drainComputerForDeployment } from './computer-deployment.ts';
import { withNotice } from './computer-exec.ts';
import { environmentName, generation, ownerIdentity, RuntimeControlError } from './protocol.ts';

export type ComputerIdentity = {
  ownerId: string;
  environment: string;
  generation: string;
  role: 'browser' | 'workspace';
};

export type ComputerState = ComputerIdentity & {
  phase: 'restoring' | 'ready' | 'dirty' | 'unsaved' | 'uncertain';
  stopped: boolean;
  commands?: string[];
  checkpoint?: ComputerCheckpoint;
  previousCheckpoint?: ComputerCheckpoint;
  oversize?: { message: string; shown: boolean };
  notice?: string;
};

export type ComputerCommand = {
  id: string;
  generation: string;
  threadId?: string;
  connected?: number;
  session?: boolean;
};

export function createComputerLifecycle(options: {
  role: ComputerIdentity['role'];
  environment: string;
  read(): Promise<ComputerState | undefined>;
  write(state: ComputerState): Promise<void>;
  claimCommand(identity: ComputerIdentity, id: string): Promise<boolean>;
  authorize(identity: ComputerIdentity, stopping: boolean): Promise<void>;
  running(): boolean;
  start(): Promise<void>;
  destroy(): Promise<void>;
  restore(state: ComputerState, assertCurrent: () => Promise<void>): Promise<void>;
  checkpoint(state: ComputerState, assertCurrent: () => Promise<void>): Promise<ComputerCheckpoint>;
  removeCheckpoint(
    checkpoint: ComputerCheckpoint,
    assertCurrent: () => Promise<void>,
  ): Promise<void>;
  quiesce(state: ComputerState, stopping: boolean): Promise<boolean>;
  launch(state: ComputerState, command: ComputerCommand): Promise<ExecProcess>;
  settleMs?: number;
}) {
  const environment = environmentName(options.environment);
  const settleMs = options.settleMs ?? 20_000;
  const active = new Set<string>();
  let pending: Promise<unknown> = Promise.resolve();
  let loaded: ComputerState | undefined;
  let booted = false;
  let closing = false;
  let fenced = false;
  let draining = false;
  let settling: ReturnType<typeof setTimeout> | undefined;

  const unavailable = () => new RuntimeControlError(503);
  function exclusive<T>(operation: () => Promise<T>) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }
  function identity(owner: string, version: string): ComputerIdentity {
    return {
      ownerId: ownerIdentity(owner),
      environment,
      generation: generation(version),
      role: options.role,
    };
  }
  function matches(state: ComputerState, expected: ComputerIdentity) {
    return (
      state.ownerId === expected.ownerId &&
      state.environment === expected.environment &&
      state.role === expected.role &&
      state.generation === expected.generation
    );
  }
  async function write(state: ComputerState) {
    await options.write(state);
    loaded = state;
  }
  async function destroy() {
    clearTimeout(settling);
    await options.destroy();
    if (options.running()) throw unavailable();
    booted = false;
    active.clear();
  }
  function discarded(state: ComputerState): ComputerState {
    const { oversize, ...rest } = state;
    if (options.role !== 'workspace') return { ...rest, phase: 'ready' };
    const reason = oversize
      ? 'The workspace was too large to save, so changes made after its last save were discarded'
      : 'The workspace stopped before its latest changes were saved, so changes made after its last save were lost';
    return {
      ...rest,
      phase: 'ready',
      notice: [state.notice, `${reason} and its files are back to that save.`]
        .filter(Boolean)
        .join(' '),
    };
  }
  function destroyed(state: ComputerState): ComputerState {
    return {
      ...(state.phase === 'ready' || state.phase === 'restoring' ? state : discarded(state)),
      phase: 'ready',
      stopped: true,
    };
  }
  function recoverable(state: ComputerState | undefined, expected: ComputerIdentity) {
    return (
      !!state &&
      (state.phase === 'uncertain' || state.phase === 'restoring') &&
      state.ownerId === expected.ownerId &&
      state.environment === expected.environment &&
      state.role === expected.role &&
      BigInt(state.generation) <= BigInt(expected.generation) &&
      !active.size
    );
  }
  async function recover(state: ComputerState) {
    await destroy();
    await write(destroyed(state));
    return loaded!;
  }
  function settle() {
    clearTimeout(settling);
    settling = setTimeout(() => {
      void exclusive(async () => {
        if (
          !loaded ||
          loaded.phase !== 'unsaved' ||
          active.size ||
          fenced ||
          closing ||
          draining ||
          !booted ||
          !options.running()
        )
          return;
        try {
          await checkpoint(loaded);
        } catch {
          await uncertain();
        }
      }).catch(() => {});
    }, settleMs);
  }
  async function assertCurrent(state: ComputerState, stopping = false) {
    if (fenced || (!stopping && closing)) throw unavailable();
    await options.authorize(state, stopping);
    if (fenced || (!stopping && closing)) throw unavailable();
  }
  async function uncertain() {
    fenced = true;
    const state = await options.read();
    if (loaded && (!state || !matches(state, loaded))) throw unavailable();
    try {
      if (state) await write({ ...state, phase: 'uncertain' });
    } finally {
      await destroy();
    }
    if (state) await write(destroyed(state));
  }
  async function checkpoint(
    state: ComputerState,
    stopping = false,
    authorize?: () => Promise<void>,
  ) {
    const assert = async () => {
      if (fenced) throw unavailable();
      if (authorize) await authorize();
      else await assertCurrent(state, stopping);
      if (fenced) throw unavailable();
    };
    await assert();
    let next: ComputerCheckpoint;
    try {
      next = await options.checkpoint(state, assert);
    } catch (error) {
      if (!(error instanceof CheckpointTooLarge)) throw error;
      await assert();
      if (!loaded || !matches(loaded, state) || loaded.phase === 'uncertain') throw unavailable();
      await write({
        ...loaded,
        oversize: { message: error.message, shown: loaded.oversize?.shown ?? false },
      });
      await assert();
      return undefined;
    }
    await assert();
    if (!loaded || !matches(loaded, state) || loaded.phase === 'uncertain') throw unavailable();
    const previous = state.previousCheckpoint;
    const { oversize: _oversize, ...current } = loaded;
    await write({
      ...current,
      phase: 'ready',
      checkpoint: next,
      previousCheckpoint: state.checkpoint,
    });
    await assert();
    if (previous) await options.removeCheckpoint(previous, assert).catch(() => {});
    await assert();
    return loaded!;
  }
  async function saveOrDiscard(
    state: ComputerState,
    stopping = false,
    authorize?: () => Promise<void>,
  ) {
    if (state.phase === 'unsaved' && !options.running()) {
      await write(discarded(state));
      return loaded!;
    }
    if (await checkpoint(state, stopping, authorize)) return loaded!;
    await write(discarded(loaded!));
    return loaded!;
  }
  async function prepare(expected: ComputerIdentity) {
    await options.authorize(expected, false);
    if (fenced) throw unavailable();
    let previous = await options.read();
    if (previous?.generation !== expected.generation && recoverable(previous, expected))
      previous = await recover(previous!);
    if (
      previous &&
      (previous.ownerId !== expected.ownerId ||
        previous.environment !== expected.environment ||
        previous.role !== expected.role ||
        previous.phase === 'uncertain' ||
        (previous.generation !== expected.generation &&
          (!previous.stopped || BigInt(previous.generation) >= BigInt(expected.generation))) ||
        (previous.generation === expected.generation && previous.stopped))
    )
      throw unavailable();
    if (closing && (!previous?.stopped || previous.generation === expected.generation))
      throw unavailable();
    closing = false;
    if (previous?.phase === 'dirty' && (!booted || !options.running())) {
      loaded = previous;
      await uncertain();
      throw unavailable();
    }
    if (previous && matches(previous, expected) && booted && options.running()) return previous;
    loaded = previous?.generation === expected.generation ? previous : undefined;
    await destroy();
    const notice = previous?.phase === 'unsaved' ? discarded(previous).notice : previous?.notice;
    const next: ComputerState = {
      ...expected,
      phase: 'restoring',
      stopped: false,
      ...(previous?.generation === expected.generation &&
        previous.commands && {
          commands: previous.commands,
        }),
      checkpoint: previous?.checkpoint,
      previousCheckpoint: previous?.previousCheckpoint,
      ...(notice && { notice }),
    };
    await write(next);
    try {
      await assertCurrent(next);
      await options.start();
      await assertCurrent(next);
      await options.restore(next, () => assertCurrent(next));
      await assertCurrent(next);
      await write({ ...next, phase: 'ready' });
      await assertCurrent(next);
      booted = true;
      return loaded!;
    } catch {
      await destroy().catch(() => {});
      throw unavailable();
    }
  }

  return {
    async authorize(owner: string, version: string) {
      const expected = identity(owner, version);
      if (fenced || closing || draining) throw unavailable();
      await options.authorize(expected, false);
      if (loaded && (!matches(loaded, expected) || loaded.stopped || loaded.phase === 'uncertain'))
        throw unavailable();
      if (fenced || closing || draining) throw unavailable();
    },
    launch(owner: string, input: ComputerCommand) {
      clearTimeout(settling);
      return exclusive(async () => {
        if (draining) throw unavailable();
        const expected = identity(owner, input.generation);
        const id = ownerIdentity(input.id);
        const state = await prepare(expected);
        if (state.commands?.includes(id)) throw new RuntimeControlError(409);
        for (const previous of state.commands ?? [])
          await options.claimCommand(expected, ownerIdentity(previous));
        if (!(await options.claimCommand(expected, id))) throw new RuntimeControlError(409);
        await assertCurrent(state);
        const { commands: _commands, notice, oversize, ...next } = state;
        const message = input.session
          ? [notice, oversize?.shown === false && oversize.message].filter(Boolean).join(' ')
          : '';
        await write({
          ...next,
          ...(oversize && { oversize: { ...oversize, shown: oversize.shown || !!message } }),
          ...(!message && notice && { notice }),
          phase: 'dirty',
        });
        active.add(id);
        try {
          await assertCurrent(loaded!);
          const process = await options.launch(loaded!, input);
          await assertCurrent(loaded!);
          return message ? withNotice(process, message) : process;
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    completed(owner: string, input: { id: string; generation: string; code: number }) {
      return exclusive(async () => {
        const expected = identity(owner, input.generation);
        if (!loaded || !matches(loaded, expected) || !active.has(input.id)) throw unavailable();
        try {
          if (input.code !== 0) throw unavailable();
          await assertCurrent(loaded);
          if (!options.running()) throw unavailable();
          active.delete(input.id);
          if (options.role === 'workspace' && loaded.phase === 'dirty' && !active.size)
            await write({ ...loaded, phase: 'unsaved' });
          if (loaded.phase === 'unsaved') settle();
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    uncertain(owner: string, version: string) {
      const expected = identity(owner, version);
      if (loaded && (!matches(loaded, expected) || loaded.stopped))
        return Promise.reject(unavailable());
      if (loaded) fenced = true;
      return exclusive(async () => {
        const state = await options.read();
        if (state && (!matches(state, expected) || state.stopped)) throw unavailable();
        loaded = state;
        await uncertain();
      });
    },
    idle() {
      return exclusive(async () => {
        if (!loaded) {
          const state = await options.read();
          if (state && !matches(state, identity(state.ownerId, state.generation)))
            throw unavailable();
          loaded = state;
        }
        if (!loaded || closing || fenced || active.size) return false;
        try {
          if (!booted && (loaded.phase === 'dirty' || loaded.phase === 'uncertain')) {
            await uncertain();
            return true;
          }
          if (loaded.stopped) {
            await destroy();
            return true;
          }
          await assertCurrent(loaded);
          if (
            loaded.phase === 'dirty' &&
            (options.role !== 'browser' || !(await options.quiesce(loaded, false)))
          )
            return false;
          if (
            (loaded.phase === 'dirty' || loaded.phase === 'unsaved') &&
            !(await checkpoint(loaded))
          )
            await write(discarded(loaded));
          await destroy();
          return true;
        } catch {
          await uncertain();
          throw unavailable();
        }
      });
    },
    drain(
      owner: string,
      version: string,
      input: DeploymentInput,
      controls: {
        authorize(): Promise<void>;
        active(): number;
      },
    ) {
      return exclusive(async () => {
        const expected = identity(owner, version);
        const state = await options.read();
        return drainComputerForDeployment({
          identity: expected,
          ...input,
          state,
          active: active.size + controls.active(),
          observed: booted,
          fenced,
          running: options.running,
          authorize: controls.authorize,
          admission(closed) {
            draining = closed;
            if (closed) loaded = state;
          },
          quiesce: (current) => options.quiesce(current, false),
          checkpoint: (current) => saveOrDiscard(current, false, controls.authorize),
          recover: (current) =>
            recoverable(current, expected) ? recover(current) : Promise.resolve(current),
          stop: destroy,
          write,
          quarantine: async (current) => {
            fenced = true;
            await write({ ...current, phase: 'uncertain' });
          },
        });
      });
    },
    inspectStopped(
      owner: string,
      version: string | null,
      controls: {
        authorize(): Promise<void>;
        active(): number;
        physicallyStopped(): Promise<boolean>;
      },
    ) {
      return exclusive(async () => {
        const ownerId = ownerIdentity(owner);
        const expected = version === null ? null : generation(version);
        await controls.authorize();
        if (!(await controls.physicallyStopped())) return false;
        const state = await options.read();
        await controls.authorize();
        if (!(await controls.physicallyStopped())) return false;
        return cleanStoppedComputer({
          state,
          ownerId,
          generation: expected,
          environment,
          role: options.role,
          active: active.size + controls.active(),
          running: options.running(),
        });
      });
    },
    stop(owner: string, version: string) {
      return exclusive(async () => {
        const expected = identity(owner, version);
        await options.authorize(expected, true);
        let state = await options.read();
        if (state && !matches(state, expected)) {
          if (recoverable(state, expected)) state = await recover(state);
          if (
            state.ownerId === expected.ownerId &&
            state.environment === expected.environment &&
            state.role === expected.role &&
            BigInt(generation(state.generation)) < BigInt(expected.generation) &&
            state.phase === 'ready' &&
            state.stopped &&
            !fenced &&
            !active.size &&
            !options.running()
          )
            return;
          throw new RuntimeControlError(409);
        }
        closing = true;
        loaded = state;
        if (!state) {
          await destroy();
          await options.authorize(expected, true);
          await write({ ...expected, phase: 'ready', stopped: true });
          return;
        }
        if (active.size || state.phase === 'uncertain' || (state.phase === 'dirty' && !booted)) {
          await uncertain();
        } else {
          try {
            if (state.phase === 'dirty') {
              if (options.role !== 'browser' || !(await options.quiesce(state, true)))
                throw unavailable();
            }
            if (state.phase === 'dirty' || state.phase === 'unsaved')
              await saveOrDiscard(state, true);
            await destroy();
          } catch {
            await uncertain();
          }
        }
        await write(destroyed(loaded!));
      });
    },
    get active() {
      return active.size;
    },
    get live() {
      return booted && !fenced && !closing && !draining && !loaded?.stopped && options.running();
    },
  };
}
