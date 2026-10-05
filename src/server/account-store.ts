import type { Pool } from 'pg';
import type { AccountSettings, AccountTheme, AccountUpdate } from '../shared/account.ts';

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
      `INSERT INTO account_settings (owner_id,theme,onboarding_completed,display_name)
       VALUES ($1,COALESCE($2,'system'),COALESCE($3,false),$4)
       ON CONFLICT (owner_id) DO UPDATE SET
         theme=COALESCE($2,account_settings.theme),
         onboarding_completed=COALESCE($3,account_settings.onboarding_completed),
         display_name=COALESCE($4,account_settings.display_name),
         updated_at=now()
       RETURNING theme,onboarding_completed AS "onboardingCompleted",display_name AS "displayName"`,
      [ownerId, input.theme ?? null, input.onboardingCompleted ?? null, input.name ?? null],
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
      )`);
    },
    async read(ownerId) {
      const result = await database.query<{
        theme: AccountTheme;
        onboardingCompleted: boolean;
        displayName: string | null;
      }>(
        `SELECT theme, onboarding_completed AS "onboardingCompleted", display_name AS "displayName"
         FROM account_settings WHERE owner_id=$1`,
        [ownerId],
      );
      return result.rows[0] ?? { theme: 'system', onboardingCompleted: false, displayName: null };
    },
    async update(ownerId, input) {
      if (!input.onboardingCompleted) return save(database, ownerId, input);
      const connection = await database.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'INSERT INTO account_settings (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING',
          [ownerId],
        );
        const previous = await connection.query<{ onboardingCompleted: boolean }>(
          'SELECT onboarding_completed AS "onboardingCompleted" FROM account_settings WHERE owner_id=$1 FOR UPDATE',
          [ownerId],
        );
        const account = await save(connection, ownerId, input);
        await connection.query('COMMIT');
        return {
          ...account,
          onboardingCompletedNow: !previous.rows[0].onboardingCompleted,
        };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
