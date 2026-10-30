import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './transaction.ts';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';
import {
  objectFailure,
  objectKey,
  objectLimit,
  objectVersion,
} from '../ports/object-storage-validation.ts';
import { fileBytes } from '../shared/files.ts';
import { lockSetup } from './locks.ts';

export function createPostgresObjectStore(options: {
  database: Pool | PoolClient;
  ownerId: string;
}): PrivateObjectStore & { initialize(): Promise<void> } {
  if (!options.ownerId || options.ownerId.length > 200) throw objectFailure();
  const atomic = <T>(run: (client: PoolClient) => Promise<T>) =>
    'totalCount' in options.database ? transaction(run, options.database) : run(options.database);
  async function safe<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ObjectStoreConflict) throw error;
      throw objectFailure();
    }
  }
  return {
    initialize: () =>
      safe(() =>
        atomic(async (client) => {
          if ('totalCount' in options.database) await client.query("SET LOCAL lock_timeout='5s'");
          await lockSetup(client, 'nod:private-objects');
          await client.query(`CREATE TABLE IF NOT EXISTS private_objects (
        owner_id text NOT NULL, object_key text NOT NULL, version text NOT NULL,
        bytes bytea NOT NULL, PRIMARY KEY(owner_id,object_key)
      )`);
          await client.query(
            "DELETE FROM private_objects WHERE owner_id=$1 AND object_key='onboarding/interview'",
            [options.ownerId],
          );
        }),
      ),
    read: (value, maxBytes) =>
      safe(async () => {
        objectLimit(maxBytes);
        const result = await options.database.query(
          'SELECT version,CASE WHEN octet_length(bytes)<=$3 THEN bytes ELSE NULL END AS bytes FROM private_objects WHERE owner_id=$1 AND object_key=$2',
          [options.ownerId, objectKey(value), maxBytes],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        if (
          !Buffer.isBuffer(row.bytes) ||
          row.bytes.length > maxBytes ||
          !/^[a-f0-9-]{36}$/.test(row.version)
        )
          throw objectFailure();
        return { bytes: row.bytes, version: row.version };
      }),
    write: (value, bytes, { expectedVersion }) =>
      safe(async () => {
        if (bytes.byteLength > fileBytes) throw objectFailure();
        if (expectedVersion !== null) objectVersion(expectedVersion);
        const version = randomUUID();
        const result =
          expectedVersion === null
            ? await options.database.query(
                'INSERT INTO private_objects(owner_id,object_key,version,bytes) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,object_key) DO NOTHING RETURNING version',
                [options.ownerId, objectKey(value), version, Buffer.from(bytes)],
              )
            : await options.database.query(
                'UPDATE private_objects SET version=$3,bytes=$4 WHERE owner_id=$1 AND object_key=$2 AND version=$5 RETURNING version',
                [options.ownerId, objectKey(value), version, Buffer.from(bytes), expectedVersion],
              );
        if (result.rowCount !== 1) throw new ObjectStoreConflict();
        return version;
      }),
    remove: (value, condition) =>
      safe(async () => {
        if (condition?.expectedVersion !== undefined) objectVersion(condition.expectedVersion);
        const result =
          condition?.expectedVersion !== undefined
            ? await options.database.query(
                'DELETE FROM private_objects WHERE owner_id=$1 AND object_key=$2 AND version=$3',
                [options.ownerId, objectKey(value), condition.expectedVersion],
              )
            : await options.database.query(
                'DELETE FROM private_objects WHERE owner_id=$1 AND object_key=$2',
                [options.ownerId, objectKey(value)],
              );
        if (condition?.expectedVersion !== undefined && result.rowCount !== 1)
          throw new ObjectStoreConflict();
      }),
  };
}
