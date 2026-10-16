import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import { deploymentInputSchema } from '../../../src/server/deployment-auth.ts';
import type { ComputerIdentity, ComputerState } from './computer-lifecycle.ts';
import { environmentName, generation, ownerIdentity, RuntimeControlError } from './protocol.ts';

type Storage = Pick<DurableObjectTransaction, 'get' | 'list' | 'put'>;

type Retirement = {
  format: 'otto-unused-computer-retirement-v1';
  deployment: DeploymentInput;
  original: ComputerState;
  replacement: ComputerState;
};

const unavailable = () => new RuntimeControlError(503);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function retireUnusedComputer(options: {
  identity: ComputerIdentity;
  deployment: DeploymentInput;
  read<T>(key: string): Promise<T | undefined>;
  transaction<T>(operation: (storage: Storage) => Promise<T>): Promise<T>;
  authorize(): Promise<void>;
  inactive(): boolean;
  physicallyStopped(): Promise<boolean>;
  now?: () => number;
}) {
  try {
    const identity: ComputerIdentity = {
      ownerId: ownerIdentity(options.identity.ownerId),
      environment: environmentName(options.identity.environment),
      generation: generation(options.identity.generation),
      role: options.identity.role,
    };
    if (!['browser', 'workspace'].includes(identity.role)) throw unavailable();
    const deployment = deploymentInputSchema.parse(options.deployment);
    const now = options.now ?? Date.now;
    const key = `computer-retirement:${identity.generation}`;
    const initial = await options.read<ComputerState>('computer');
    if (initial?.phase !== 'uncertain') return false;
    const archived = await options.read<Retirement>(key);
    if (archived !== undefined) throw unavailable();
    const replacement: ComputerState = { ...identity, phase: 'ready', stopped: true };
    const eligible = (state: ComputerState) => {
      if (
        !state ||
        typeof state !== 'object' ||
        Array.isArray(state) ||
        Object.keys(state).some(
          (field) =>
            ![
              'ownerId',
              'environment',
              'generation',
              'role',
              'phase',
              'stopped',
              'commands',
              'checkpoint',
              'previousCheckpoint',
            ].includes(field),
        ) ||
        state.ownerId !== identity.ownerId ||
        state.environment !== identity.environment ||
        state.role !== identity.role ||
        BigInt(generation(state.generation)) > BigInt(identity.generation) ||
        state.phase !== 'uncertain' ||
        typeof state.stopped !== 'boolean' ||
        (state.generation !== identity.generation && !state.stopped) ||
        (state.commands !== undefined &&
          (!Array.isArray(state.commands) || state.commands.length !== 0)) ||
        state.checkpoint !== undefined ||
        state.previousCheckpoint !== undefined
      )
        throw unavailable();
    };
    eligible(initial);
    const assert = async () => {
      if (!options.inactive() || deployment.deadline <= now()) throw unavailable();
      await options.authorize();
      if (!options.inactive() || deployment.deadline <= now()) throw unavailable();
      if (!(await options.physicallyStopped())) throw unavailable();
      if (!options.inactive() || deployment.deadline <= now()) throw unavailable();
      await options.authorize();
      if (!options.inactive() || deployment.deadline <= now()) throw unavailable();
    };
    await assert();
    await options.transaction(async (storage) => {
      const state = await storage.get<ComputerState>('computer');
      const retained = await storage.get<Retirement>(key);
      const claims = await storage.list({ prefix: 'command:', limit: 1 });
      if (
        !same(state, initial) ||
        retained !== undefined ||
        claims.size !== 0 ||
        !options.inactive() ||
        deployment.deadline <= now()
      )
        throw unavailable();
      const record: Retirement = {
        format: 'otto-unused-computer-retirement-v1',
        deployment,
        original: state!,
        replacement,
      };
      await storage.put({ [key]: record, computer: replacement });
    });
    await assert();
    return true;
  } catch {
    throw unavailable();
  }
}
