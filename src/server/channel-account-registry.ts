import type { Pool } from 'pg';
import { transaction } from './transaction.ts';
import { z } from 'zod';
import type { ChannelAccountIdentity, ChannelAccountRegistry } from '../ports/channel-settings.ts';
import type { TenantLease } from './tenants.ts';

export class ChannelAccountRegistryError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: 'invalid_configuration' | 'invalid_identity' | 'invalid_lease' | 'unavailable',
  ) {
    super(
      code === 'invalid_lease'
        ? 'Runtime authentication failed.'
        : code === 'unavailable'
          ? 'Channel account ownership is temporarily unavailable.'
          : 'The channel account ownership configuration is invalid.',
    );
    this.name = 'ChannelAccountRegistryError';
    this.statusCode = code === 'invalid_lease' ? 401 : code === 'invalid_identity' ? 400 : 503;
  }
}

export function createChannelAccountRegistry(options: {
  admin: Pool;
  environment: string;
  controlSchema?: string;
}): ChannelAccountRegistry & {
  initialize(): Promise<void>;
  claimWithLease(input: ChannelAccountIdentity, lease: TenantLease): Promise<boolean>;
  releaseWithLease(input: ChannelAccountIdentity, lease: TenantLease): Promise<void>;
} {
  const schema = options.controlSchema ?? 'otto_control';
  if (
    !/^[a-z][a-z0-9-]{0,31}$/.test(options.environment) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(schema) ||
    schema === 'public' ||
    schema.startsWith('pg_')
  )
    throw new ChannelAccountRegistryError('invalid_configuration');
  const table = `"${schema}".channel_accounts`;
  const revisions = `"${schema}".channel_account_revisions`;

  function identity(input: ChannelAccountIdentity) {
    const ownerId = z.uuid().safeParse(input.ownerId);
    if (
      !ownerId.success ||
      !['telegram', 'whatsapp'].includes(input.provider) ||
      !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.accountId) ||
      !/^(0|[1-9][0-9]{0,18})$/.test(input.revision) ||
      BigInt(input.revision) > 9223372036854775807n
    )
      throw new ChannelAccountRegistryError('invalid_identity');
    return [
      options.environment,
      input.provider,
      input.accountId,
      ownerId.data.toLowerCase(),
      input.revision,
    ];
  }

  function leasedIdentity(input: ChannelAccountIdentity, lease: TenantLease) {
    const values = identity(input);
    const holder = z.uuid().safeParse(lease.holderId);
    if (
      lease.environment !== options.environment ||
      lease.ownerId.toLowerCase() !== values[3] ||
      !holder.success ||
      !/^[1-9][0-9]{0,18}$/.test(lease.generation) ||
      BigInt(lease.generation) > 9223372036854775807n
    )
      throw new ChannelAccountRegistryError('invalid_lease');
    return [...values, holder.data.toLowerCase(), lease.generation];
  }

  async function protect<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ChannelAccountRegistryError) throw error;
      throw new ChannelAccountRegistryError('unavailable');
    }
  }

  async function mutate(input: ChannelAccountIdentity, release: boolean, lease?: TenantLease) {
    return protect(async () => {
      const values = lease ? leasedIdentity(input, lease) : identity(input);
      return transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
        if (lease) {
          const checked = await client.query<{ valid: boolean }>(
            `WITH locked_tenant AS MATERIALIZED (
              SELECT lease_holder,lease_generation,lease_expires FROM "${schema}".tenants
              WHERE environment=$1 AND owner_id=$2 FOR UPDATE
            ) SELECT EXISTS(SELECT 1 FROM locked_tenant
              WHERE lease_holder=$3::uuid AND lease_generation=$4::bigint
              AND lease_expires>clock_timestamp()) AS valid`,
            [values[0], values[3], values[5], values[6]],
          );
          if (!checked.rows[0]?.valid) throw new ChannelAccountRegistryError('invalid_lease');
        }
        const advanced = await client.query(
          `INSERT INTO ${revisions} AS revisions(environment,provider,account_id,owner_id,revision,released)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(environment,provider,account_id,owner_id) DO UPDATE SET
             revision=EXCLUDED.revision,released=EXCLUDED.released
           WHERE revisions.revision<EXCLUDED.revision
             OR (revisions.revision=EXCLUDED.revision AND NOT revisions.released)
           RETURNING revision`,
          [...values.slice(0, 5), release],
        );
        let claimed = false;
        if (advanced.rowCount === 1) {
          if (release) {
            await client.query(
              `DELETE FROM ${table} WHERE environment=$1 AND provider=$2 AND account_id=$3
               AND owner_id=$4 AND revision<=$5`,
              values.slice(0, 5),
            );
          } else {
            const result = await client.query(
              `INSERT INTO ${table} AS accounts(environment,provider,account_id,owner_id,revision)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(environment,provider,account_id) DO UPDATE SET revision=EXCLUDED.revision
               WHERE accounts.owner_id=EXCLUDED.owner_id AND accounts.revision<=EXCLUDED.revision
               RETURNING owner_id`,
              values.slice(0, 5),
            );
            claimed = result.rowCount === 1;
            if (!claimed)
              await client.query(
                `UPDATE ${revisions} SET released=true WHERE environment=$1 AND provider=$2
                 AND account_id=$3 AND owner_id=$4 AND revision=$5`,
                values.slice(0, 5),
              );
          }
        }
        return claimed;
      }, options.admin);
    });
  }

  return {
    initialize: () =>
      protect(() =>
        transaction(async (client) => {
          await client.query("SET LOCAL lock_timeout='5s'");
          if ((await client.query('SELECT to_regclass($1) AS found', [table])).rows[0].found)
            await client.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
          else
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              `otto:channel-account-registry:${schema}`,
            ]);
          await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
            environment text NOT NULL,
            provider text NOT NULL CHECK (provider IN ('telegram','whatsapp')),
            account_id text NOT NULL,
            owner_id uuid NOT NULL,
            revision bigint NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (environment,provider,account_id)
          )`);
          await client.query(`CREATE TABLE IF NOT EXISTS ${revisions} (
            environment text NOT NULL,
            provider text NOT NULL CHECK (provider IN ('telegram','whatsapp')),
            account_id text NOT NULL,
            owner_id uuid NOT NULL,
            revision bigint NOT NULL CHECK (revision>=0),
            released boolean NOT NULL,
            PRIMARY KEY(environment,provider,account_id,owner_id)
          )`);
          await client.query(`REVOKE ALL ON TABLE ${table},${revisions} FROM PUBLIC`);
        }, options.admin),
      ),
    claim: (input) => mutate(input, false),
    release: async (input) => {
      await mutate(input, true);
    },
    claimWithLease: (input, lease) => mutate(input, false, lease),
    releaseWithLease: async (input, lease) => {
      await mutate(input, true, lease);
    },
  };
}
