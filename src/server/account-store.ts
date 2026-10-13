import type { Pool } from 'pg';
import { transaction } from './transaction.ts';
import type { AccountSettings, AccountUpdate } from '../shared/account.ts';

export interface StoredAccount extends AccountSettings {
  displayName: string | null;
}

export interface AccountStore {
  read(ownerId: string): Promise<StoredAccount>;
  update(
    ownerId: string,
    input: AccountUpdate,
  ): Promise<StoredAccount & { onboardingCompletedNow?: boolean }>;
}

export function createAccountStore(database: Pool): AccountStore & { initialize(): Promise<void> } {
  async function save(connection: Pick<Pool, 'query'>, ownerId: string, input: AccountUpdate) {
    const result = await connection.query<StoredAccount>(
      `INSERT INTO account_settings (owner_id,theme,onboarding_completed,display_name,usage_data)
       VALUES ($1,COALESCE($2,'system'),COALESCE($3,false),$4,COALESCE($5,false))
       ON CONFLICT (owner_id) DO UPDATE SET
         theme=COALESCE($2,account_settings.theme),
         onboarding_completed=COALESCE($3,account_settings.onboarding_completed),
         display_name=COALESCE($4,account_settings.display_name),
         usage_data=COALESCE($5,account_settings.usage_data),
         updated_at=now()
       RETURNING theme,onboarding_completed AS "onboardingCompleted",display_name AS "displayName",usage_data AS "usageData"`,
      [
        ownerId,
        input.theme ?? null,
        input.onboardingCompleted ?? null,
        input.name ?? null,
        input.usageData ?? null,
      ],
    );
    return result.rows[0];
  }
  return {
    async initialize() {
      await database.query(`CREATE TABLE IF NOT EXISTS account_settings (
        owner_id text PRIMARY KEY,
        theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
        display_name text,
        onboarding_completed boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS usage_data boolean NOT NULL DEFAULT false`);
    },
    async read(ownerId) {
      const result = await database.query<StoredAccount>(
        `SELECT theme, onboarding_completed AS "onboardingCompleted", display_name AS "displayName",
           usage_data AS "usageData"
         FROM account_settings WHERE owner_id=$1`,
        [ownerId],
      );
      return (
        result.rows[0] ?? {
          theme: 'system',
          onboardingCompleted: false,
          displayName: null,
          usageData: false,
        }
      );
    },
    async update(ownerId, input) {
      if (!input.onboardingCompleted) return save(database, ownerId, input);
      return transaction(async (connection) => {
        await connection.query(
          'INSERT INTO account_settings (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING',
          [ownerId],
        );
        const previous = await connection.query<{ onboardingCompleted: boolean }>(
          'SELECT onboarding_completed AS "onboardingCompleted" FROM account_settings WHERE owner_id=$1 FOR UPDATE',
          [ownerId],
        );
        const account = await save(connection, ownerId, input);
        return {
          ...account,
          onboardingCompletedNow: !previous.rows[0].onboardingCompleted,
        };
      }, database);
    },
  };
}
