import type { ComputerIdentity, ComputerState } from './computer-lifecycle.ts';
import { generation, ownerIdentity, RuntimeControlError } from './protocol.ts';

export type ComputerDeploymentResult =
  | { status: 'drained'; generation: string; clean: true; stopped: true }
  | { status: 'busy' | 'unsafe'; generation: string };

export async function drainComputerForDeployment(options: {
  identity: ComputerIdentity;
  nonce: string;
  deadline: number;
  state: ComputerState | undefined;
  active: number;
  observed: boolean;
  fenced: boolean;
  running(): boolean;
  authorize(): Promise<void>;
  admission(closed: boolean): void;
  quiesce(state: ComputerState): Promise<boolean>;
  checkpoint(state: ComputerState): Promise<ComputerState>;
  stop(): Promise<void>;
  write(state: ComputerState): Promise<void>;
  quarantine(state: ComputerState): Promise<void>;
  now?: () => number;
}): Promise<ComputerDeploymentResult> {
  const version = generation(options.identity.generation);
  ownerIdentity(options.identity.ownerId);
  ownerIdentity(options.nonce);
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(options.deadline) || options.deadline <= now())
    throw new RuntimeControlError(409);
  const result = (status: 'busy' | 'unsafe'): ComputerDeploymentResult => ({
    status,
    generation: version,
  });
  const drained = (): ComputerDeploymentResult => ({
    status: 'drained',
    generation: version,
    clean: true,
    stopped: true,
  });
  const assert = async () => {
    if (options.deadline <= now()) throw new RuntimeControlError(409);
    await options.authorize();
    if (options.deadline <= now()) throw new RuntimeControlError(409);
  };
  await assert();
  let state = options.state;
  if (
    state &&
    !options.fenced &&
    !options.active &&
    !options.running() &&
    state.stopped &&
    state.phase === 'ready' &&
    state.ownerId === options.identity.ownerId &&
    state.environment === options.identity.environment &&
    state.role === options.identity.role &&
    BigInt(generation(state.generation)) < BigInt(version)
  )
    return drained();
  if (
    options.fenced ||
    (state &&
      (state.ownerId !== options.identity.ownerId ||
        state.environment !== options.identity.environment ||
        state.role !== options.identity.role ||
        state.generation !== version ||
        state.phase === 'uncertain' ||
        state.phase === 'restoring'))
  )
    return result('unsafe');
  if (options.active) return result('busy');
  if (!state) return options.running() ? result('unsafe') : drained();
  if (state.stopped)
    return state.phase === 'ready' && !options.running() ? drained() : result('unsafe');
  if (
    (state.phase === 'dirty' &&
      (!options.observed || !options.running() || state.role !== 'browser')) ||
    (!options.running() && !state.checkpoint && state.phase !== 'unsaved')
  )
    return result('unsafe');
  let changed = false;
  options.admission(true);
  try {
    await assert();
    if (options.running()) {
      if (state.role === 'browser') {
        changed = true;
        const quiescent = await options.quiesce(state);
        if (!quiescent) {
          changed = false;
          return result('busy');
        }
      }
      await assert();
      changed = true;
      state = await options.checkpoint(state);
      if (
        state.phase !== 'ready' ||
        state.stopped ||
        state.ownerId !== options.identity.ownerId ||
        state.environment !== options.identity.environment ||
        state.role !== options.identity.role ||
        state.generation !== version
      )
        throw new RuntimeControlError(503);
      await assert();
      await options.stop();
      if (options.running()) throw new RuntimeControlError(503);
    } else if (state.phase === 'unsaved') {
      changed = true;
      state = await options.checkpoint(state);
    }
    await assert();
    changed = true;
    await options.write({ ...state, stopped: true });
    await assert();
    return drained();
  } catch {
    if (changed) await options.quarantine(state).catch(() => {});
    return result('unsafe');
  } finally {
    options.admission(false);
  }
}

export function cleanStoppedComputer(options: {
  state: ComputerState | undefined;
  ownerId: string;
  environment: string;
  role: ComputerIdentity['role'];
  generation: string | null;
  active: number;
  fenced: boolean;
  running: boolean;
}) {
  ownerIdentity(options.ownerId);
  const version = options.generation === null ? null : generation(options.generation);
  if (options.active || options.fenced || options.running) return false;
  const state = options.state;
  if (!state) return true;
  return (
    version !== null &&
    state.ownerId === options.ownerId &&
    state.environment === options.environment &&
    state.role === options.role &&
    BigInt(generation(state.generation)) <= BigInt(version) &&
    state.phase === 'ready' &&
    state.stopped === true
  );
}
