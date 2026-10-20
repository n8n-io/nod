import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { SetupJournal } from '../ports/setup.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import { ChannelSetupFailure, type ChannelSetupVerifier } from '../ports/channel-settings.ts';
import {
  createChannelSettings,
  openChannelSettings,
  validateChannelSettingsRow,
  type ChannelSettingsRow,
  type ChannelSettingsStore,
} from './channel-settings.ts';

const transferSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    ownerId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    rows: z.array(z.unknown()).max(2),
  })
  .strict();

export interface SetupChannelTransfer {
  version: 1;
  id: string;
  ownerId: string;
  revision: number;
  rows: ChannelSettingsRow[];
}

export function validateSetupChannels(value: unknown, ownerId: string): SetupChannelTransfer {
  try {
    const parsed = transferSchema.parse(value);
    const rows = parsed.rows.map(validateChannelSettingsRow);
    if (parsed.ownerId !== ownerId || new Set(rows.map((row) => row.provider)).size !== rows.length)
      throw new Error();
    return { ...parsed, rows };
  } catch {
    throw new Error('The saved channel setup does not belong to this profile or is invalid.');
  }
}

export async function createSetupChannels(options: {
  journal: SetupJournal;
  ownerId: string;
  keyStore: CredentialKeyStore;
  verifier: ChannelSetupVerifier;
  apply(environment: Record<string, string>): Promise<void>;
}) {
  const { journal, ownerId } = options;
  await journal.update<SetupChannelTransfer>('channels', (current) =>
    current
      ? validateSetupChannels(current, ownerId)
      : { version: 1, id: randomUUID(), ownerId, revision: 0, rows: [] },
  );
  let pending: Promise<unknown> = Promise.resolve();
  let writes = 0;
  let frozen = false;
  const load = async () => validateSetupChannels(await journal.read('channels'), ownerId);
  function change<T>(run: (state: SetupChannelTransfer) => Promise<T> | T) {
    writes++;
    const operation = pending.then(async () => {
      if (frozen)
        throw new Error('Channel setup has finished. Open Otto to change its connections.');
      const previous = await load();
      const state = structuredClone(previous);
      const result = await run(state);
      state.revision++;
      const next = validateSetupChannels(state, ownerId);
      await journal.update<SetupChannelTransfer>('channels', (current) => {
        const latest = validateSetupChannels(current, ownerId);
        if (latest.id !== previous.id || latest.revision !== previous.revision)
          throw new Error('Channel setup changed. Try again.');
        return next;
      });
      return result;
    });
    const completed = operation.finally(() => writes--);
    pending = completed.catch(() => {});
    return completed;
  }
  const store: ChannelSettingsStore = {
    async read() {
      await pending;
      return (await load()).rows;
    },
    save(row, beforeCommit) {
      return change(async (state) => {
        await beforeCommit?.();
        const previous = state.rows.findIndex((item) => item.provider === row.provider);
        if (previous < 0) state.rows.push(row);
        else state.rows[previous] = row;
      });
    },
    activate(provider) {
      return change((state) => {
        const row = state.rows.find((item) => item.provider === provider && item.enabled);
        if (!row) return undefined;
        row.summary.webhookStatus = 'registered';
        return row.summary;
      });
    },
    replace(previous, next, beforeCommit) {
      return change(async (state) => {
        const current = state.rows.find((row) => row.provider === 'telegram' && row.enabled);
        if (!current || current.ciphertext !== previous.ciphertext)
          throw new ChannelSetupFailure('pairing_unavailable');
        const notify = await beforeCommit();
        state.rows[state.rows.indexOf(current)] = {
          ...next,
          summary: {
            ...next.summary,
            ...(current.summary.webhookStatus
              ? { webhookStatus: current.summary.webhookStatus }
              : {}),
          },
        };
        return notify;
      });
    },
  };
  const service = await createChannelSettings(store, {
    ...options,
    pairingChanged: async () => options.apply(await service.environment()),
  });
  const busy = service.busy;
  return Object.assign(service, {
    busy() {
      return writes > 0 || busy();
    },
    async transfer() {
      if (writes || busy()) throw new Error('Wait for channel setup to finish.');
      frozen = true;
      await pending;
      return load();
    },
  });
}

export async function importSetupChannels(
  client: PoolClient,
  options: { ownerId: string; keyStore: CredentialKeyStore; transfer: unknown },
) {
  const { ownerId, keyStore } = options;
  const state = validateSetupChannels(options.transfer, ownerId);
  const key = state.rows.some((row) => row.ciphertext) ? await keyStore.getKey() : undefined;
  for (const row of state.rows) {
    if (row.ciphertext) openChannelSettings(key!, ownerId, row);
    const existing = (
      await client.query<ChannelSettingsRow>(
        'SELECT provider,enabled,ciphertext,summary FROM channel_settings WHERE owner_id=$1 AND provider=$2 FOR UPDATE',
        [ownerId, row.provider],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.enabled !== row.enabled ||
        existing.ciphertext !== row.ciphertext ||
        !isDeepStrictEqual(existing.summary, row.summary)
      )
        throw new Error('This channel has changed since setup. Its newer settings were kept.');
      continue;
    }
    await client.query(
      'INSERT INTO channel_settings(owner_id,provider,enabled,ciphertext,summary) VALUES($1,$2,$3,$4,$5)',
      [ownerId, row.provider, row.enabled, row.ciphertext, JSON.stringify(row.summary)],
    );
  }
  return { id: state.id, revision: state.revision, channels: state.rows.length };
}
