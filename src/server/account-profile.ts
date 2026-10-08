import type { Pool } from 'pg';
import { z } from 'zod';
import type { RuntimeAccount } from '../ports/agent.ts';

const accountProfileSchema = z
  .object({
    name: z.string().trim().max(200).nullable(),
    givenName: z.string().trim().max(100).nullable(),
    email: z.string().trim().max(320).nullable(),
    preferredName: z.string().trim().max(100).nullable(),
    usageData: z.boolean().default(false),
  })
  .strict();
export type AccountProfile = z.infer<typeof accountProfileSchema>;

export function runtimeAccount(
  profile: Omit<AccountProfile, 'usageData'> | null,
): RuntimeAccount | undefined {
  if (!profile) return undefined;
  const fullName = profile.name || null;
  const preferredName =
    profile.preferredName || profile.givenName || fullName?.split(/\s+/)[0] || null;
  if (!preferredName && !fullName && !profile.email) return undefined;
  return { preferredName, fullName, email: profile.email || null };
}

export function createAccountProfileStore(pool: Pool, ownerId: string) {
  return {
    async initialize() {
      await pool.query(`CREATE TABLE IF NOT EXISTS account_profile (
        owner_id text PRIMARY KEY, name text, given_name text, email text, preferred_name text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE account_profile ADD COLUMN IF NOT EXISTS usage_data boolean NOT NULL DEFAULT false`);
    },
    async read(): Promise<AccountProfile | null> {
      const result = await pool.query<AccountProfile>(
        'SELECT name,given_name AS "givenName",email,preferred_name AS "preferredName",usage_data AS "usageData" FROM account_profile WHERE owner_id=$1',
        [ownerId],
      );
      return result.rows[0] ?? null;
    },
    async save(raw: unknown) {
      const profile = accountProfileSchema.parse(raw);
      await pool.query(
        `INSERT INTO account_profile(owner_id,name,given_name,email,preferred_name,usage_data) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(owner_id) DO UPDATE SET name=$2,given_name=$3,email=$4,preferred_name=$5,usage_data=$6,updated_at=now()`,
        [
          ownerId,
          profile.name,
          profile.givenName,
          profile.email,
          profile.preferredName,
          profile.usageData,
        ],
      );
      return profile;
    },
  };
}
