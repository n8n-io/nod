import type { Pool } from 'pg';
import { transaction } from './transaction.ts';
import type { AccountSettings, AccountUpdate } from '../shared/account.ts';

export interface AccountStore {
  readConsent(ownerId: string): Promise<{ enabled: boolean; revision: string }>;
  read(ownerId: string): Promise<AccountSettings>;
  update(
    ownerId: string,
    input: AccountUpdate,
  ): Promise<AccountSettings & { onboardingCompletedNow?: boolean }>;
}

export function createAccountStore(database: Pool): AccountStore & {
  initialize(): Promise<void>;
} {
  async function save(connection: Pick<Pool, 'query'>, ownerId: string, input: AccountUpdate) {
    const result = await connection.query<AccountSettings>(
      `INSERT INTO account_settings (owner_id,theme,onboarding_completed,usage_data,usage_data_revision,traces)
       VALUES ($1,COALESCE($2,'system'),COALESCE($3,false),COALESCE($4,false),CASE WHEN $4 THEN 1 ELSE 0 END,COALESCE($5,false))
       ON CONFLICT (owner_id) DO UPDATE SET
         theme=COALESCE($2,account_settings.theme),
         onboarding_completed=COALESCE($3,account_settings.onboarding_completed),
         usage_data=COALESCE($4,account_settings.usage_data),
         usage_data_revision=account_settings.usage_data_revision +
           CASE WHEN $4 IS NOT NULL AND $4 IS DISTINCT FROM account_settings.usage_data THEN 1 ELSE 0 END,
         traces=COALESCE($5,account_settings.traces),
         updated_at=now()
       RETURNING theme,onboarding_completed AS "onboardingCompleted",usage_data AS "usageData",traces`,
      [
        ownerId,
        input.theme ?? null,
        input.onboardingCompleted ?? null,
        input.usageData ?? null,
        input.traces ?? null,
      ],
    );
    return result.rows[0];
  }
  return {
    async initialize() {
      await database.query(`CREATE TABLE IF NOT EXISTS account_settings (
        owner_id text PRIMARY KEY,
        theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
        onboarding_completed boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS usage_data boolean NOT NULL DEFAULT false;
      ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS usage_data_revision bigint NOT NULL DEFAULT 0;
      ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS traces boolean NOT NULL DEFAULT false;
      ALTER TABLE account_settings DROP COLUMN IF EXISTS display_name`);
    },
    async readConsent(ownerId) {
      const result = await database.query<{ enabled: boolean; revision: string }>(
        `SELECT usage_data AS enabled,usage_data_revision::text AS revision
         FROM account_settings WHERE owner_id=$1`,
        [ownerId],
      );
      return result.rows[0] ?? { enabled: false, revision: '0' };
    },
    async read(ownerId) {
      const result = await database.query<AccountSettings>(
        `SELECT theme, onboarding_completed AS "onboardingCompleted", usage_data AS "usageData",traces
         FROM account_settings WHERE owner_id=$1`,
        [ownerId],
      );
      return (
        result.rows[0] ?? {
          theme: 'system',
          onboardingCompleted: false,
          usageData: false,
          traces: false,
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
