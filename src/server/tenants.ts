import { transaction as inTransaction } from './transaction.ts';
import { createHash, hkdfSync } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export type TenantRecord = {
  ownerId: string;
  environment: string;
  role: string;
  appSchema: string;
  jobsSchema: string;
  credentialVersion: number;
};

export type TenantRuntimeConfiguration = TenantRecord & {
  databaseUrl: string;
  poolMax: number;
};

export type TenantLease = {
  ownerId: string;
  environment: string;
  holderId: string;
  generation: string;
  expiresAt: string;
};

export class TenantError extends Error {
  constructor(
    readonly code:
      | 'invalid_configuration'
      | 'invalid_identity'
      | 'capacity_reached'
      | 'not_found'
      | 'isolation_failed'
      | 'removing'
      | 'unavailable',
    message: string,
    readonly statusCode = 503,
  ) {
    super(message);
    this.name = 'TenantError';
  }
}

type TenantStoreOptions = {
  admin: Pool;
  databaseUrl: string;
  environment: string;
  getSecret: (version: number) => Uint8Array | Promise<Uint8Array>;
  controlSchema?: string;
  maxTenants?: number;
  credentialVersion?: number;
};

type TenantRow = {
  owner_id: string;
  environment: string;
  role_name: string;
  app_schema: string;
  jobs_schema: string;
  credential_version: number;
};

const fields = 'owner_id,environment,role_name,app_schema,jobs_schema,credential_version';

function identity(value: string) {
  const result = z.uuid().safeParse(value);
  if (!result.success)
    throw new TenantError('invalid_identity', 'A valid user identity is required.', 400);
  return result.data.toLowerCase();
}

function environmentName(value: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value))
    throw new TenantError('invalid_configuration', 'The tenant environment is invalid.');
  return value;
}

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith('pg_') || value === 'public')
    throw new TenantError('invalid_configuration', 'The tenant database namespace is invalid.');
  return `"${value}"`;
}

function quoted(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function tenantIdentifiers(ownerId: string, environment: string) {
  const suffix = createHash('sha256')
    .update(JSON.stringify(['otto-tenant-v1', environmentName(environment), identity(ownerId)]))
    .digest('hex')
    .slice(0, 32);
  return {
    role: `sk_user_${suffix}`,
    appSchema: `sk_app_${suffix}`,
    jobsSchema: `sk_jobs_${suffix}`,
  };
}

function record(row: TenantRow): TenantRecord {
  return {
    ownerId: row.owner_id,
    environment: row.environment,
    role: row.role_name,
    appSchema: row.app_schema,
    jobsSchema: row.jobs_schema,
    credentialVersion: row.credential_version,
  };
}

function leaseDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TenantError('invalid_configuration', 'The runtime lease duration is invalid.');
  return value;
}

function leaseRecord(row: {
  owner_id: string;
  environment: string;
  lease_holder: string;
  lease_generation: string;
  lease_expires: Date;
}): TenantLease {
  return {
    ownerId: row.owner_id,
    environment: row.environment,
    holderId: row.lease_holder,
    generation: row.lease_generation,
    expiresAt: row.lease_expires.toISOString(),
  };
}

export function createTenantStore(options: TenantStoreOptions) {
  const environment = environmentName(options.environment);
  const controlSchema = options.controlSchema ?? 'otto_control';
  const control = identifier(controlSchema);
  const table = `${control}.tenants`;
  const maxTenants = options.maxTenants ?? 8;
  const credentialVersion = options.credentialVersion ?? 1;
  if (
    !Number.isSafeInteger(maxTenants) ||
    maxTenants < 1 ||
    !Number.isSafeInteger(credentialVersion) ||
    credentialVersion < 1 ||
    credentialVersion > 65535
  )
    throw new TenantError(
      'invalid_configuration',
      'The tenant capacity or credential version is invalid.',
    );
  let template: URL;
  try {
    template = new URL(options.databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(template.protocol) ||
      !template.hostname ||
      !template.pathname.slice(1) ||
      template.hash
    )
      throw new Error();
  } catch {
    throw new TenantError('invalid_configuration', 'The tenant database connection is invalid.');
  }

  async function protect<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof TenantError) throw error;
      throw new TenantError('unavailable', 'The account database is temporarily unavailable.');
    }
  }

  const transaction = <T>(action: (client: PoolClient) => Promise<T>) =>
    protect(() => inTransaction(action, options.admin));

  async function password(tenant: TenantRecord) {
    const secret = await options.getSecret(tenant.credentialVersion);
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32)
      throw new TenantError('invalid_configuration', 'The tenant credential key is unavailable.');
    return Buffer.from(
      hkdfSync(
        'sha256',
        secret,
        Buffer.from('otto-tenant-database-v1'),
        Buffer.from(JSON.stringify([environment, tenant.ownerId, tenant.credentialVersion])),
        32,
      ),
    ).toString('base64url');
  }

  function validateRecord(tenant: TenantRecord) {
    const expected = tenantIdentifiers(tenant.ownerId, environment);
    if (
      tenant.environment !== environment ||
      tenant.role !== expected.role ||
      tenant.appSchema !== expected.appSchema ||
      tenant.jobsSchema !== expected.jobsSchema ||
      !Number.isSafeInteger(tenant.credentialVersion) ||
      tenant.credentialVersion < 1 ||
      tenant.credentialVersion > 65535
    )
      throw new TenantError(
        'isolation_failed',
        'The account database isolation could not be verified.',
      );
  }

  async function assertIsolation(client: Pick<PoolClient, 'query'>, tenant: TenantRecord) {
    validateRecord(tenant);
    const result = await client.query<{ isolated: boolean }>(
      `SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole
       AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
       AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
       AND NOT has_database_privilege(r.oid,current_database(),'TEMPORARY')
       AND has_database_privilege(r.oid,current_database(),'CONNECT')
       AND (SELECT count(*)=2 FROM pg_namespace n WHERE n.nspname=ANY($2::text[]) AND n.nspowner=r.oid)
       AND NOT EXISTS (SELECT 1 FROM pg_namespace n
         WHERE n.nspname<>ALL($2::text[]) AND n.nspname<>'information_schema'
           AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
           AND has_schema_privilege(r.oid,n.oid,'USAGE')) AS isolated
       FROM pg_roles r WHERE r.rolname=$1`,
      [tenant.role, [tenant.appSchema, tenant.jobsSchema]],
    );
    if (result.rows[0]?.isolated !== true)
      throw new TenantError(
        'isolation_failed',
        'The account database isolation could not be verified.',
      );
  }

  async function initialize() {
    await transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='5s'");
      if ((await client.query('SELECT to_regclass($1) AS found', [table])).rows[0].found)
        await client.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
      else
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `otto-tenant-registry:${controlSchema}`,
        ]);
      const database = (await client.query<{ name: string }>('SELECT current_database() AS name'))
        .rows[0].name;
      if (decodeURIComponent(template.pathname.slice(1)) !== database)
        throw new TenantError(
          'invalid_configuration',
          'The tenant connection must use the provisioning database.',
        );
      await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${quoted(database)} FROM PUBLIC`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${control}`);
      const ownership = await client.query<{ owned: boolean }>(
        'SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname=$1',
        [controlSchema],
      );
      if (ownership.rows[0]?.owned !== true)
        throw new TenantError(
          'isolation_failed',
          'The account registry must belong to its provisioner.',
        );
      await client.query(`REVOKE ALL ON SCHEMA ${control} FROM PUBLIC`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
        owner_id uuid NOT NULL, environment text NOT NULL,
        role_name text UNIQUE NOT NULL, app_schema text UNIQUE NOT NULL, jobs_schema text UNIQUE NOT NULL,
        credential_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        lease_holder uuid, lease_generation bigint NOT NULL DEFAULT 0, lease_expires timestamptz,
        PRIMARY KEY(environment,owner_id)
      )`);
      await client.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS removing boolean NOT NULL DEFAULT false`,
      );
      await client.query(`REVOKE ALL ON ${table} FROM PUBLIC`);
    });
  }

  async function get(owner: string): Promise<TenantRecord | undefined> {
    const ownerId = identity(owner);
    return protect(async () => {
      const result = await options.admin.query<TenantRow>(
        `SELECT ${fields} FROM ${table} WHERE environment=$1 AND owner_id=$2`,
        [environment, ownerId],
      );
      if (!result.rows[0]) return undefined;
      const tenant = record(result.rows[0]);
      validateRecord(tenant);
      return tenant;
    });
  }

  async function provision(owner: string): Promise<TenantRecord> {
    const ownerId = identity(owner);
    return transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
      const existing = await client.query<TenantRow & { removing: boolean }>(
        `SELECT ${fields},removing FROM ${table} WHERE environment=$1 AND owner_id=$2`,
        [environment, ownerId],
      );
      if (existing.rows[0]?.removing)
        throw new TenantError('removing', 'This account is being removed.', 409);
      if (existing.rows[0]) {
        const tenant = record(existing.rows[0]);
        await assertIsolation(client, tenant);
        return tenant;
      }
      const count = (
        await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)
      ).rows[0].count;
      if (count >= maxTenants)
        throw new TenantError(
          'capacity_reached',
          'This deployment has reached its account capacity.',
        );
      const tenant: TenantRecord = {
        ownerId,
        environment,
        ...tenantIdentifiers(ownerId, environment),
        credentialVersion,
      };
      const conflict = await client.query<{ found: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)
         OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=ANY($2::text[])) AS found`,
        [tenant.role, [tenant.appSchema, tenant.jobsSchema]],
      );
      if (conflict.rows[0].found)
        throw new TenantError(
          'isolation_failed',
          'The account database namespace is already reserved.',
        );
      const role = identifier(tenant.role);
      const appSchema = identifier(tenant.appSchema);
      const jobsSchema = identifier(tenant.jobsSchema);
      await client.query("SELECT set_config('otto.provisioning_password',$1,true)", [
        await password(tenant),
      ]);
      await client.query(`DO $tenant$ BEGIN
        EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD %L',
          '${tenant.role}',current_setting('otto.provisioning_password'));
      END $tenant$`);
      await client.query("SELECT set_config('otto.provisioning_password','',true)");
      await client.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`);
      const database = (await client.query<{ name: string }>('SELECT current_database() AS name'))
        .rows[0].name;
      await client.query(`CREATE SCHEMA ${appSchema} AUTHORIZATION ${role}`);
      await client.query(`CREATE SCHEMA ${jobsSchema} AUTHORIZATION ${role}`);
      const provisioner = (await client.query<{ role: string }>('SELECT current_user AS role'))
        .rows[0].role;
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`REVOKE ALL ON SCHEMA ${appSchema},${jobsSchema} FROM PUBLIC`);
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${appSchema},${jobsSchema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
      );
      await client.query(`SET LOCAL ROLE ${quoted(provisioner)}`);
      await client.query(`GRANT CONNECT ON DATABASE ${quoted(database)} TO ${role}`);
      await client.query(
        `ALTER ROLE ${role} IN DATABASE ${quoted(database)} SET search_path TO ${appSchema}`,
      );
      await client.query(`ALTER ROLE ${role} SET statement_timeout TO '30s'`);
      await client.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout TO '30s'`);
      await client.query(
        `INSERT INTO ${table}(owner_id,environment,role_name,app_schema,jobs_schema,credential_version)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [ownerId, environment, tenant.role, tenant.appSchema, tenant.jobsSchema, credentialVersion],
      );
      await assertIsolation(client, tenant);
      return tenant;
    });
  }

  async function runtimeConfiguration(owner: string): Promise<TenantRuntimeConfiguration> {
    return protect(async () => {
      const tenant = await get(owner);
      if (!tenant) throw new TenantError('not_found', 'The account database is not ready.', 404);
      await assertIsolation(options.admin, tenant);
      const url = new URL(template.href);
      for (const key of [...url.searchParams.keys()])
        if (!['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'].includes(key))
          url.searchParams.delete(key);
      url.username = tenant.role;
      url.password = await password(tenant);
      return { ...tenant, databaseUrl: url.href, poolMax: 4 };
    });
  }

  async function acquireLease(owner: string, holder: string, durationMs = 60_000) {
    const ownerId = identity(owner);
    const holderId = identity(holder);
    const duration = leaseDuration(durationMs);
    return protect(async () => {
      const result = await options.admin.query(
        `UPDATE ${table} SET lease_holder=$3,lease_generation=lease_generation+1,
         lease_expires=clock_timestamp()+$4::integer*interval '1 millisecond'
         WHERE environment=$1 AND owner_id=$2 AND NOT removing
           AND (lease_expires IS NULL OR lease_expires<=clock_timestamp())
         RETURNING owner_id,environment,lease_holder,lease_generation,lease_expires`,
        [environment, ownerId, holderId, duration],
      );
      return result.rows[0] ? leaseRecord(result.rows[0]) : undefined;
    });
  }

  function validateLease(lease: TenantLease) {
    const ownerId = identity(lease.ownerId);
    const holderId = identity(lease.holderId);
    if (
      lease.environment !== environment ||
      !/^[1-9]\d{0,18}$/.test(lease.generation) ||
      BigInt(lease.generation) > 9223372036854775807n
    )
      throw new TenantError('invalid_identity', 'The runtime lease is invalid.', 400);
    return [environment, ownerId, holderId, lease.generation];
  }

  async function renewLease(lease: TenantLease, durationMs = 60_000) {
    const values = validateLease(lease);
    const duration = leaseDuration(durationMs);
    return protect(async () => {
      const result = await options.admin.query(
        `UPDATE ${table} SET lease_expires=clock_timestamp()+$5::integer*interval '1 millisecond'
         WHERE environment=$1 AND owner_id=$2 AND lease_holder=$3 AND lease_generation=$4
           AND lease_expires>clock_timestamp()
         RETURNING owner_id,environment,lease_holder,lease_generation,lease_expires`,
        [...values, duration],
      );
      return result.rows[0] ? leaseRecord(result.rows[0]) : undefined;
    });
  }

  async function releaseLease(lease: TenantLease) {
    const values = validateLease(lease);
    return protect(async () => {
      const result = await options.admin.query(
        `UPDATE ${table} SET lease_holder=NULL,lease_expires=NULL
         WHERE environment=$1 AND owner_id=$2 AND lease_holder=$3 AND lease_generation=$4`,
        values,
      );
      return result.rowCount === 1;
    });
  }

  async function markRemoving(owner: string) {
    const ownerId = identity(owner);
    return protect(async () => {
      const result = await options.admin.query(
        `UPDATE ${table} SET removing=true WHERE environment=$1 AND owner_id=$2`,
        [environment, ownerId],
      );
      return result.rowCount === 1;
    });
  }

  async function remove(owner: string, dryRun = false) {
    const ownerId = identity(owner);
    const expected = tenantIdentifiers(ownerId, environment);
    const channels = `${control}.channel_accounts`;
    const revisions = `${control}.channel_account_revisions`;
    return transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
      const row = (
        await client.query<TenantRow>(
          `SELECT ${fields} FROM ${table} WHERE environment=$1 AND owner_id=$2`,
          [environment, ownerId],
        )
      ).rows[0];
      if (row) validateRecord(record(row));
      const present = (
        await client.query<{ role: boolean; schemas: number; channels: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS role,
           (SELECT count(*)::integer FROM pg_namespace WHERE nspname=ANY($2::text[])) AS schemas,
           to_regclass($3) IS NOT NULL AND to_regclass($4) IS NOT NULL AS channels`,
          [expected.role, [expected.appSchema, expected.jobsSchema], channels, revisions],
        )
      ).rows[0];
      const claims = present.channels
        ? (
            await client.query<{ count: number }>(
              `SELECT count(*)::integer AS count FROM ${channels} WHERE environment=$1 AND owner_id=$2`,
              [environment, ownerId],
            )
          ).rows[0].count
        : 0;
      const report = {
        registered: Boolean(row),
        role: present.role,
        schemas: present.schemas,
        channelAccounts: claims,
      };
      if (dryRun) return report;
      if (present.schemas && !present.role)
        throw new TenantError(
          'isolation_failed',
          'The account database isolation could not be verified.',
        );
      if (present.role) {
        const role = identifier(expected.role);
        const provisioner = (await client.query<{ role: string }>('SELECT current_user AS role'))
          .rows[0].role;
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(
          `DROP SCHEMA IF EXISTS ${identifier(expected.appSchema)},${identifier(expected.jobsSchema)} CASCADE`,
        );
        await client.query(`DROP OWNED BY ${role}`);
        await client.query(`SET LOCAL ROLE ${quoted(provisioner)}`);
        const database = (await client.query<{ name: string }>('SELECT current_database() AS name'))
          .rows[0].name;
        await client.query(`REVOKE ALL ON DATABASE ${quoted(database)} FROM ${role}`);
        await client.query(`DROP ROLE ${role}`);
      }
      if (present.channels) {
        await client.query(`DELETE FROM ${channels} WHERE environment=$1 AND owner_id=$2`, [
          environment,
          ownerId,
        ]);
        await client.query(`DELETE FROM ${revisions} WHERE environment=$1 AND owner_id=$2`, [
          environment,
          ownerId,
        ]);
      }
      await client.query(`DELETE FROM ${table} WHERE environment=$1 AND owner_id=$2`, [
        environment,
        ownerId,
      ]);
      return report;
    });
  }

  async function removing(owner: string) {
    const ownerId = identity(owner);
    return protect(async () => {
      const result = await options.admin.query<{ removing: boolean }>(
        `SELECT removing FROM ${table} WHERE environment=$1 AND owner_id=$2`,
        [environment, ownerId],
      );
      return result.rows[0]?.removing === true;
    });
  }

  return {
    markRemoving,
    removing,
    remove,
    currentLease: (owner: string) =>
      protect(async () => {
        const result = await options.admin.query(
          `SELECT owner_id,environment,lease_holder,lease_generation,lease_expires FROM ${table}
           WHERE environment=$1 AND owner_id=$2 AND lease_holder IS NOT NULL
             AND lease_expires>clock_timestamp()`,
          [environment, identity(owner)],
        );
        return result.rows[0] ? leaseRecord(result.rows[0]) : undefined;
      }),
    listOwners: () =>
      protect(async () => {
        const result = await options.admin.query<{ owner_id: string }>(
          `SELECT owner_id FROM ${table} WHERE environment=$1 ORDER BY created_at,owner_id`,
          [environment],
        );
        return result.rows.map((row) => identity(row.owner_id));
      }),
    initialize,
    provision,
    get,
    runtimeConfiguration,
    acquireLease,
    renewLease,
    releaseLease,
  };
}
