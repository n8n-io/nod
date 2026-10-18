import type { Pool } from 'pg';
import { transaction } from './transaction.ts';
import type {
  ComputerAllocation,
  ComputerAllocationRole,
  ComputerAllocationStore,
} from '../ports/computer-allocation.ts';
import { lockSetup } from './locks.ts';

export class ComputerAllocationError extends Error {
  constructor(readonly code: 'invalid_allocation' | 'unavailable') {
    super(
      code === 'unavailable'
        ? 'The computer allocation is temporarily unavailable.'
        : 'The computer allocation is invalid.',
    );
    this.name = 'ComputerAllocationError';
  }
}

type AllocationRow = {
  owner_id: string;
  role: ComputerAllocationRole;
  provider: string;
  template_id: string;
  resource_id: string | null;
  generation: string;
  version: number;
  state: ComputerAllocation['state'];
  lease_id: string | null;
  lease_expires_at: string | null;
};

const fields =
  'owner_id,role,provider,template_id,resource_id,generation,version,state,lease_id,lease_expires_at';

function bounded(value: unknown, limit = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function allocation(row: AllocationRow): ComputerAllocation {
  return {
    ownerId: row.owner_id,
    role: row.role,
    provider: row.provider,
    templateId: row.template_id,
    resourceId: row.resource_id,
    generation: row.generation,
    version: row.version,
    state: row.state,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
  };
}

export function createComputerAllocationStore(options: {
  database: Pool;
  ownerId: string;
}): ComputerAllocationStore & { initialize(): Promise<void> } {
  if (!bounded(options.ownerId)) throw new ComputerAllocationError('invalid_allocation');
  const ownerId = options.ownerId;

  function identity(owner: string, role: ComputerAllocationRole) {
    if (owner !== ownerId || !['browser', 'workspace', 'computer'].includes(role))
      throw new ComputerAllocationError('invalid_allocation');
  }

  function validate(expectedVersion: number | null, next: ComputerAllocation) {
    identity(next.ownerId, next.role);
    if (
      (expectedVersion !== null &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) ||
      !Number.isSafeInteger(next.version) ||
      next.version !== (expectedVersion ?? 0) + 1 ||
      next.version > 2_147_483_647 ||
      !bounded(next.provider) ||
      !bounded(next.templateId) ||
      !bounded(next.generation) ||
      (next.resourceId !== null && !bounded(next.resourceId)) ||
      !['allocating', 'ready', 'uncertain'].includes(next.state) ||
      (next.state === 'ready' && next.resourceId === null) ||
      (next.leaseId !== null && !bounded(next.leaseId)) ||
      (next.leaseId === null) !== (next.leaseExpiresAt === null) ||
      (next.leaseExpiresAt !== null &&
        (!Number.isSafeInteger(next.leaseExpiresAt) || next.leaseExpiresAt < 0))
    )
      throw new ComputerAllocationError('invalid_allocation');
  }

  async function protect<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ComputerAllocationError) throw error;
      throw new ComputerAllocationError('unavailable');
    }
  }

  return {
    initialize: () =>
      protect(() =>
        transaction(async (client) => {
          await lockSetup(client, 'otto:computer-allocations');
          await client.query(`CREATE TABLE IF NOT EXISTS computer_allocations (
          owner_id text NOT NULL,
          role text NOT NULL CHECK (role IN ('browser','workspace','computer')),
          provider text NOT NULL,
          template_id text NOT NULL,
          resource_id text,
          generation text NOT NULL,
          version integer NOT NULL CHECK (version>0),
          state text NOT NULL CHECK (state IN ('allocating','ready','uncertain')),
          lease_id text,
          lease_expires_at bigint,
          PRIMARY KEY (owner_id,role),
          CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
          CHECK (lease_expires_at IS NULL OR lease_expires_at>=0),
          CHECK (state<>'ready' OR resource_id IS NOT NULL)
        )`);
          await client.query('REVOKE ALL ON TABLE computer_allocations FROM PUBLIC');
        }, options.database),
      ),
    read: (owner, role) =>
      protect(async () => {
        identity(owner, role);
        const result = await options.database.query<AllocationRow>(
          `SELECT ${fields} FROM computer_allocations WHERE owner_id=$1 AND role=$2`,
          [ownerId, role],
        );
        return result.rows[0] ? allocation(result.rows[0]) : undefined;
      }),
    compareAndSwap: (expectedVersion, next) =>
      protect(async () => {
        validate(expectedVersion, next);
        const values = [
          ownerId,
          next.role,
          next.provider,
          next.templateId,
          next.resourceId,
          next.generation,
          next.version,
          next.state,
          next.leaseId,
          next.leaseExpiresAt,
        ];
        const result =
          expectedVersion === null
            ? await options.database.query(
                `INSERT INTO computer_allocations (${fields})
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (owner_id,role) DO NOTHING RETURNING version`,
                values,
              )
            : await options.database.query(
                `UPDATE computer_allocations
                 SET resource_id=$5,version=$7,state=$8,lease_id=$9,lease_expires_at=$10
                 WHERE owner_id=$1 AND role=$2 AND provider=$3 AND template_id=$4
                 AND generation=$6 AND version=$11
                 AND (resource_id IS NULL OR resource_id=$5)
                 RETURNING version`,
                [...values, expectedVersion],
              );
        return result.rowCount === 1;
      }),
  };
}
