import type { Pool } from 'pg';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { IntegrationProvider } from '../ports/integrations.ts';
import { createSetupJournal } from './setup-journal.ts';
import { setupAccountSchema, setupProgressSchema } from './setup-state.ts';
import { importSetupModels, validateSetupModels } from './setup-models.ts';
import { importSetupIntegrations, validateSetupIntegrations } from './setup-integrations.ts';
import { createAppGrantVault } from './vault-app-grants.ts';
import { createPostgresObjectStore } from './object-storage.ts';
import { createMemoryService } from './memory.ts';
import { preferencesSchema, defaultPreferences } from './preferences.ts';
import { transaction } from './transaction.ts';
import { lockKey } from './locks.ts';
import { onboardingSteps } from '../shared/onboarding.ts';
import { initializeChannelSettings } from './channel-settings.ts';
import { importSetupChannels, validateSetupChannels } from './setup-channels.ts';

export async function importDesktopSetup(options: {
  root: string;
  ownerId: string;
  database: Pool;
  keyStore: CredentialKeyStore;
  managedProvider: IntegrationProvider;
  ownProvider: IntegrationProvider;
}) {
  const journal = await createSetupJournal({ ...options, create: false });
  try {
    const snapshot = await journal.snapshot();
    if (!snapshot.frozen) throw new Error('Desktop setup has not finished.');
    const database = options.database;
    await database.query(
      'CREATE TABLE IF NOT EXISTS desktop_setup_receipts(owner_id text PRIMARY KEY,id uuid NOT NULL,revision integer NOT NULL,completed_at timestamptz NOT NULL DEFAULT now())',
    );
    const receipt = async () =>
      (
        await database.query<{ id: string; revision: number }>(
          'SELECT id,revision FROM desktop_setup_receipts WHERE owner_id=$1',
          [options.ownerId],
        )
      ).rows[0];
    const previous = await receipt();
    if (previous) {
      if (previous.id !== snapshot.id || previous.revision !== snapshot.revision)
        throw new Error('This profile already completed a different setup.');
      return snapshot.id;
    }
    const progress = setupProgressSchema.parse(snapshot.sections.progress);
    const account = setupAccountSchema.parse(snapshot.sections.account);
    if (
      !progress.completing ||
      progress.step !== 'open' ||
      onboardingSteps.some((step) => !progress.visited.includes(step)) ||
      !account.consentAnswered ||
      snapshot.sections['interview-saved'] !== true
    )
      throw new Error('Desktop setup is incomplete.');
    const models = validateSetupModels(snapshot.sections['model-transfer'], options.ownerId);
    if (
      !models.selection ||
      !models.connections.some(
        (row) => row.id === models.selection!.connectionId && row.status === 'connected',
      )
    )
      throw new Error('Desktop setup needs a connected model.');
    const integrations = await validateSetupIntegrations(
      snapshot.sections['integration-transfer'],
      options,
    );
    const channels = validateSetupChannels(snapshot.sections['channel-transfer'], options.ownerId);
    await initializeChannelSettings(database);
    const preferences = preferencesSchema.parse(
      snapshot.sections.preferences ?? defaultPreferences,
    );
    const vault = await createAppGrantVault(database, options);
    await transaction(async (client) => {
      await lockKey(client, `desktop-setup:${options.ownerId}`);
      const found = (
        await client.query<{ id: string; revision: number }>(
          'SELECT id,revision FROM desktop_setup_receipts WHERE owner_id=$1',
          [options.ownerId],
        )
      ).rows[0];
      if (found) {
        if (found.id !== snapshot.id || found.revision !== snapshot.revision)
          throw new Error('This profile already completed a different setup.');
        return;
      }
      const existing = (
        await client.query<{ onboarding_completed: boolean }>(
          'SELECT onboarding_completed FROM account_settings WHERE owner_id=$1 FOR UPDATE',
          [options.ownerId],
        )
      ).rows[0];
      if (existing?.onboarding_completed)
        throw new Error('This profile already completed onboarding.');
      await importSetupModels(client, {
        ownerId: options.ownerId,
        keyStore: options.keyStore,
        transfer: models,
      });
      await importSetupIntegrations(client, integrations, { ...options, putKey: vault.put });
      await importSetupChannels(client, {
        ownerId: options.ownerId,
        keyStore: options.keyStore,
        transfer: channels,
      });
      const store = createPostgresObjectStore({ database: client, ownerId: options.ownerId });
      const memory = createMemoryService({ pool: client, ownerId: options.ownerId, store });
      await memory.restate(snapshot.sections['interview-notes']);
      await client.query(
        `INSERT INTO account_settings(owner_id,theme,onboarding_completed,usage_data,usage_data_revision,traces)
        VALUES($1,$2,true,$3,$4,$5) ON CONFLICT(owner_id) DO UPDATE SET theme=$2,onboarding_completed=true,usage_data=$3,usage_data_revision=$4,traces=$5,updated_at=now()`,
        [
          options.ownerId,
          account.theme,
          account.usageData,
          account.consentRevision,
          account.traces,
        ],
      );
      await client.query(
        `INSERT INTO preferences(owner_id,notification_rule,time_zone,quiet_start,quiet_end,quiet_hours_enabled,locale,hour_cycle)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner_id) DO NOTHING`,
        [
          options.ownerId,
          preferences.notificationRule,
          preferences.timeZone,
          preferences.quietStart,
          preferences.quietEnd,
          preferences.quietHoursEnabled,
          preferences.locale,
          preferences.hourCycle,
        ],
      );
      await client.query(
        'INSERT INTO desktop_setup_receipts(owner_id,id,revision) VALUES($1,$2,$3)',
        [options.ownerId, z.uuid().parse(snapshot.id), snapshot.revision],
      );
    }, database);
    return snapshot.id;
  } finally {
    await journal.close();
  }
}
