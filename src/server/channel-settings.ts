import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import { transaction } from './transaction.ts';
import {
  ChannelSetupFailure,
  telegramSecret,
  telegramUserId,
  type ChannelSetupConfiguration,
  type ChannelSetupVerifier,
} from '../ports/channel-settings.ts';
import type {
  ChannelProvider,
  ChannelSetupSummary,
  ChannelLinkStatus,
} from '../shared/contracts.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { ChannelPairingRequest } from '../ports/messaging.ts';

const providerSchema = z.enum(['telegram', 'whatsapp']);
const linkedModes = new Set(['linked', 'bot', 'self-chat']);
export type ChannelConnectionObservation = {
  channel: ChannelProvider;
  state: 'disabled' | 'setup_pending' | 'connected' | 'configured_unverified';
};

function managedConfigurationReady(provider: ChannelProvider, values: Record<string, string>) {
  if (provider === 'telegram')
    return (
      /^\d+:[A-Za-z0-9_-]+$/.test(values.TELEGRAM_BOT_TOKEN ?? '') &&
      telegramSecret.test(values.TELEGRAM_WEBHOOK_SECRET_TOKEN ?? '')
    );
  if (values.WHATSAPP_POLICY_CONFIRMED !== 'true') return false;
  if (linkedModes.has(values.WHATSAPP_MODE ?? '')) return true;
  return (
    values.WHATSAPP_MODE === 'cloud' &&
    [
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_ALLOWED_NUMBER',
      'WHATSAPP_VERIFY_TOKEN',
    ].every((name) => Boolean(values[name])) &&
    /^\d+$/.test(values.WHATSAPP_PHONE_NUMBER_ID ?? '') &&
    /^\d{7,15}$/.test(values.WHATSAPP_ALLOWED_NUMBER ?? '')
  );
}

export function channelConnectionObservations(
  channels: ChannelSetupSummary[],
  managed: Partial<Record<ChannelProvider, Record<string, string>>> = {},
): ChannelConnectionObservation[] {
  const telegram = channels.find((channel) => channel.provider === 'telegram');
  const whatsapp = channels.find((channel) => channel.provider === 'whatsapp');
  const telegramState: ChannelConnectionObservation['state'] = !telegram?.enabled
    ? 'disabled'
    : (managed.telegram && !managedConfigurationReady('telegram', managed.telegram)) ||
        !telegram.allowedUserId ||
        telegram.webhookStatus === 'registration_pending'
      ? 'setup_pending'
      : telegram.mode === 'polling' ||
          (telegram.mode === 'webhook' && telegram.webhookStatus === 'registered')
        ? 'connected'
        : 'configured_unverified';
  const whatsappState: ChannelConnectionObservation['state'] = !whatsapp?.enabled
    ? 'disabled'
    : managed.whatsapp && !managedConfigurationReady('whatsapp', managed.whatsapp)
      ? 'setup_pending'
      : whatsapp.mode === 'linked'
        ? whatsapp.connectionState === 'connected'
          ? 'connected'
          : 'setup_pending'
        : whatsapp.mode === 'webhook'
          ? 'configured_unverified'
          : 'setup_pending';
  return [
    { channel: 'telegram', state: telegramState },
    { channel: 'whatsapp', state: whatsappState },
  ];
}

const summarySchema = z.object({
  provider: providerSchema,
  enabled: z.boolean(),
  managed: z.boolean().optional(),
  accountName: z.string().max(200).optional(),
  accountHandle: z.string().max(200).optional(),
  mode: z.enum(['polling', 'webhook', 'linked']).optional(),
  connectionState: z
    .enum([
      'connecting',
      'awaiting_scan',
      'connected',
      'disconnected',
      'logged_out',
      'expired',
      'failed',
    ])
    .optional(),
  webhookStatus: z.enum(['registered', 'manual_setup', 'registration_pending']).optional(),
  webhookUrl: z.url().max(2048).optional(),
  pairedUser: z.string().min(1).max(200).optional(),
  pairedUsername: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .optional(),
  allowedUserId: z.string().regex(telegramUserId).optional(),
  pairingExpiresAt: z.iso.datetime().optional(),
});
const pairingSender = {
  telegram: z.object({ senderId: z.string().regex(telegramUserId) }),
  whatsapp: z.object({
    senderId: z.string().regex(/^(?:\d{7,15}|\d{1,32}@lid)$/),
    threadId: z.string().regex(/^\d{1,32}@(?:s\.whatsapp\.net|lid)$/),
  }),
};
const pairingRequestSchema = z.object({
  senderName: z.string().min(1).max(200),
  senderUsername: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .optional(),
  accountId: z.string().min(1),
  messageId: z.string().min(1),
  code: z.string().min(1).max(256),
});
const pairingLifetimeMs = 15 * 60 * 1000;
const fields: Record<ChannelProvider, Set<string>> = {
  telegram: new Set([
    'TELEGRAM_ENABLED',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_ID',
    'TELEGRAM_WEBHOOK_SECRET_TOKEN',
    'TELEGRAM_MODE',
    'TELEGRAM_PAIRING_CODE_HASH',
    'TELEGRAM_PAIRING_EXPIRES_AT',
    'TELEGRAM_PAIRING_CANDIDATE',
  ]),
  whatsapp: new Set([
    'WHATSAPP_ENABLED',
    'WHATSAPP_MODE',
    'WHATSAPP_POLICY_CONFIRMED',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ALLOWED_NUMBER',
    'WHATSAPP_ALLOWED_LID',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_PAIRING_CODE_HASH',
    'WHATSAPP_PAIRING_EXPIRES_AT',
  ]),
};
export function managedChannelEnvironment(environment: Record<string, string | undefined>) {
  const managed: Partial<Record<ChannelProvider, Record<string, string>>> = {};
  for (const provider of ['telegram', 'whatsapp'] as const) {
    const values = Object.fromEntries(
      [...fields[provider]]
        .filter((name) => !name.includes('_PAIRING_') && name !== 'WHATSAPP_ALLOWED_LID')
        .map((name) => [name, environment[name]] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    if (!Object.keys(values).length) continue;
    const enabled = `${provider.toUpperCase()}_ENABLED`;
    for (const name of [enabled, ...(provider === 'whatsapp' ? ['WHATSAPP_POLICY_CONFIRMED'] : [])])
      if (values[name] !== undefined && !['true', 'false'].includes(values[name]))
        throw new Error(`${name} must be true, false or empty.`);
    values[enabled] ??= 'true';
    const mode = `${provider.toUpperCase()}_MODE`;
    values[mode] ??= provider === 'telegram' ? 'polling' : 'cloud';
    if (
      !(provider === 'telegram' ? ['polling', 'webhook'] : [...linkedModes, 'cloud']).includes(
        values[mode],
      )
    )
      throw new Error(`Invalid ${mode}.`);
    if (provider === 'whatsapp' && values[enabled] === 'true' && values[mode] !== 'cloud') {
      if (values.WHATSAPP_POLICY_CONFIRMED !== 'true')
        throw new Error('Set WHATSAPP_POLICY_CONFIRMED=true before enabling linked WhatsApp.');
      if (values.WHATSAPP_ALLOWED_NUMBER && !/^\d{7,15}$/.test(values.WHATSAPP_ALLOWED_NUMBER))
        throw new Error('WHATSAPP_ALLOWED_NUMBER must contain 7 to 15 digits.');
      if (values.WHATSAPP_ALLOWED_LID && !/^\d{1,32}@lid$/.test(values.WHATSAPP_ALLOWED_LID))
        throw new Error('WHATSAPP_ALLOWED_LID must be a WhatsApp private ID.');
    }
    if (provider === 'telegram' && values[mode] === 'polling')
      values.TELEGRAM_WEBHOOK_SECRET_TOKEN ||= randomBytes(32).toString('base64url');
    managed[provider] = values;
  }
  return managed;
}

type ChannelSettingsRow = {
  provider: ChannelProvider;
  enabled: boolean;
  ciphertext: string | null;
  summary: ChannelSetupSummary;
};

async function initializeChannelSettings(pool: Pick<Pool, 'query'>) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS channel_settings(owner_id text NOT NULL,provider text NOT NULL,enabled boolean NOT NULL,ciphertext text,summary jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,provider))`,
  );
}

async function databaseStore(pool: Pool, owner: string) {
  await initializeChannelSettings(pool);
  return {
    async read() {
      return (
        await pool.query<ChannelSettingsRow>('SELECT * FROM channel_settings WHERE owner_id=$1', [
          owner,
        ])
      ).rows;
    },
    async save(row: ChannelSettingsRow, beforeCommit?: () => Promise<void>) {
      return transaction(async (client) => {
        await client.query(
          `INSERT INTO channel_settings(owner_id,provider,enabled,ciphertext,summary) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(owner_id,provider) DO UPDATE SET enabled=EXCLUDED.enabled,ciphertext=EXCLUDED.ciphertext,summary=EXCLUDED.summary,updated_at=now()`,
          [owner, row.provider, row.enabled, row.ciphertext, JSON.stringify(row.summary)],
        );
        await beforeCommit?.();
      }, pool);
    },
    async activate(provider: ChannelProvider) {
      return (
        await pool.query<Pick<ChannelSettingsRow, 'summary'>>(
          `UPDATE channel_settings SET summary=jsonb_set(summary,'{webhookStatus}','"registered"'),updated_at=now() WHERE owner_id=$1 AND provider=$2 AND enabled=true RETURNING summary`,
          [owner, provider],
        )
      ).rows[0]?.summary;
    },
    async replace(previous: ChannelSettingsRow, next: ChannelSettingsRow) {
      const updated = await pool.query(
        `UPDATE channel_settings SET ciphertext=$2,summary=$3::jsonb || CASE WHEN summary ? 'webhookStatus' THEN jsonb_build_object('webhookStatus',summary->'webhookStatus') ELSE '{}'::jsonb END,updated_at=now()
         WHERE owner_id=$1 AND provider=$5 AND enabled=true AND ciphertext=$4`,
        [
          owner,
          next.ciphertext,
          JSON.stringify(next.summary),
          previous.ciphertext,
          previous.provider,
        ],
      );
      if (updated.rowCount !== 1) throw new ChannelSetupFailure('pairing_unavailable');
    },
  };
}

function createLock() {
  let pending = Promise.resolve();
  return async <T>(action: () => Promise<T>, signal?: AbortSignal) => {
    let resolve: () => void = () => {};
    const previous = pending;
    pending = new Promise<void>((done) => {
      resolve = done;
    });
    let stop: (() => void) | undefined;
    try {
      await (signal
        ? Promise.race([
            previous,
            new Promise<never>((_, reject) => {
              stop = () => reject(signal.reason);
              if (signal.aborted) stop();
              else signal.addEventListener('abort', stop, { once: true });
            }),
          ])
        : previous);
    } catch (error) {
      void previous.then(resolve);
      throw error;
    } finally {
      if (stop) signal?.removeEventListener('abort', stop);
    }
    try {
      return await action();
    } finally {
      resolve();
    }
  };
}

function binding(owner: string, provider: ChannelProvider) {
  return ['nod-channel-settings-v1', owner, provider];
}
function seal(
  key: Buffer,
  owner: string,
  provider: ChannelProvider,
  environment: Record<string, string>,
) {
  return sealVaultValue(key, binding(owner, provider), JSON.stringify(environment));
}
function pairingHash(code: string) {
  return createHash('sha256').update(code).digest('hex');
}
function issuePairing(summary: ChannelSetupSummary, address: string | undefined) {
  const telegram = summary.provider === 'telegram';
  if (!address || !(telegram ? /^@[A-Za-z0-9_]{1,64}$/ : /^\+\d{7,15}$/).test(address))
    throw new ChannelSetupFailure(telegram ? 'verification_failed' : 'pairing_unavailable');
  const code = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + pairingLifetimeMs);
  const prefix = summary.provider.toUpperCase();
  return {
    environment: {
      [`${prefix}_PAIRING_CODE_HASH`]: pairingHash(code),
      [`${prefix}_PAIRING_EXPIRES_AT`]: String(expiresAt.getTime()),
    },
    summary: { ...summary, pairingExpiresAt: expiresAt.toISOString() },
    pairingUrl: telegram
      ? `https://t.me/${address.slice(1)}?start=${code}`
      : `https://wa.me/${address.slice(1)}?text=${code}`,
  };
}
function openChannelSettings(key: Buffer, owner: string, row: ChannelSettingsRow) {
  const result = z
    .record(z.string(), z.string().max(8192))
    .parse(JSON.parse(openVaultValue(key, binding(owner, row.provider), row.ciphertext!)));
  if (Object.keys(result).some((key) => !fields[row.provider].has(key)))
    throw new Error('Invalid channel configuration.');
  return result;
}

export async function createChannelSettings(
  pool: Pool,
  options: {
    ownerId: string;
    keyStore: CredentialKeyStore;
    verifier: ChannelSetupVerifier;
    managed?: ReturnType<typeof managedChannelEnvironment>;
    apply(environment: Record<string, string>): Promise<void>;
    linkStatus?(): Promise<ChannelLinkStatus>;
    cancelPairing?(pairingId: string, restart?: boolean): Promise<boolean>;
    unlink?(): Promise<void>;
    observed?(): (channels: ChannelConnectionObservation[]) => void;
  },
) {
  const owner = z.string().min(1).max(200).parse(options.ownerId);
  const managed = options.managed ?? {};
  const store = await databaseStore(pool, owner);
  const exclusive = createLock();
  let key: Promise<Buffer> | undefined;
  let statusObservationSequence = 0;
  function encryptionKey() {
    if (!options.keyStore.configured) throw new Error('The secure key store is not configured.');
    key ??= options.keyStore.getKey().catch((error) => {
      key = undefined;
      throw error;
    });
    return key;
  }
  function accountId(provider: ChannelProvider, configured: Record<string, string>) {
    return provider === 'telegram'
      ? configured.TELEGRAM_BOT_TOKEN?.split(':')[0]
      : configured.WHATSAPP_PHONE_NUMBER_ID;
  }
  async function environment() {
    const rows = await store.read();
    const result: Record<string, string> = Object.assign({}, ...Object.values(managed));
    for (const row of rows) {
      providerSchema.parse(row.provider);
      if (managed[row.provider]) continue;
      if (row.enabled && row.ciphertext) {
        Object.assign(result, openChannelSettings(await encryptionKey(), owner, row));
      } else result[`${row.provider.toUpperCase()}_ENABLED`] = 'false';
    }
    return result;
  }
  async function status() {
    const sequence = ++statusObservationSequence;
    let observed: ((channels: ChannelConnectionObservation[]) => void) | undefined;
    try {
      observed = options.observed?.();
    } catch {}
    const rows = (await store.read()).filter((row) => !managed[row.provider]);
    for (const provider of ['telegram', 'whatsapp'] as const) {
      const values = managed[provider];
      if (!values) continue;
      const mode = values[`${provider.toUpperCase()}_MODE`];
      const linked = provider === 'whatsapp' && linkedModes.has(mode ?? '');
      const summary = summarySchema.parse({
        provider,
        enabled: values[`${provider.toUpperCase()}_ENABLED`] === 'true',
        managed: true,
        mode: linked ? 'linked' : mode === 'polling' ? 'polling' : 'webhook',
        ...(provider === 'telegram' && telegramUserId.test(values.TELEGRAM_ALLOWED_USER_ID ?? '')
          ? { allowedUserId: values.TELEGRAM_ALLOWED_USER_ID }
          : {}),
      });
      rows.push({ provider, enabled: summary.enabled, ciphertext: null, summary });
    }
    const linked = rows.some(
      (row) => row.provider === 'whatsapp' && row.enabled && row.summary.mode === 'linked',
    )
      ? await options.linkStatus?.().catch(() => undefined)
      : undefined;
    const savedNumber = async (row: ChannelSettingsRow) => {
      if (row.provider !== 'whatsapp' || !linked || !row.ciphertext) return undefined;
      const number = openChannelSettings(await encryptionKey(), owner, row).WHATSAPP_ALLOWED_NUMBER;
      return number ? `+${number}` : undefined;
    };
    const result = {
      ready: options.keyStore.configured,
      channels: await Promise.all(
        rows.map(async (row) => {
          const pairedUser = await savedNumber(row).catch(() => undefined);
          return summarySchema.parse({
            ...row.summary,
            provider: row.provider,
            enabled: row.enabled,
            ...(pairedUser ? { pairedUser } : {}),
            ...(row.provider === 'whatsapp' && linked
              ? {
                  connectionState: linked.state,
                  accountHandle: linked.accountHandle,
                  accountName: linked.accountName,
                }
              : {}),
          });
        }),
      ),
    };
    if (sequence === statusObservationSequence) {
      try {
        observed?.(channelConnectionObservations(result.channels, managed));
      } catch {}
    }
    return result;
  }
  async function activate(provider: ChannelProvider, configuration: ChannelSetupConfiguration) {
    if (!options.verifier.register) throw new ChannelSetupFailure('activation_pending');
    await options.apply(await environment());
    await options.verifier.register(provider, configuration);
    return summarySchema.parse(await store.activate(provider));
  }
  async function recover() {
    return exclusive(async () => {
      const rows = (await store.read()).filter(
        (row) =>
          !managed[row.provider] &&
          row.enabled &&
          row.summary.webhookStatus === 'registration_pending',
      );
      for (const row of rows) {
        try {
          await activate(providerSchema.parse(row.provider), {
            environment: openChannelSettings(await encryptionKey(), owner, row),
            summary: summarySchema.parse(row.summary),
          });
        } catch {
          return false;
        }
      }
      return true;
    });
  }
  async function change(provider: ChannelProvider, input?: unknown, cancelPairingId?: string) {
    return exclusive(async () => {
      if (managed[provider]) throw new ChannelSetupFailure('server_managed');
      if (cancelPairingId && !(await options.cancelPairing?.(cancelPairingId))) {
        const row = (await store.read()).find((item) => item.provider === provider);
        return {
          ok: true,
          channel: summarySchema.parse(row?.summary ?? { provider, enabled: false }),
        };
      }
      const oldEnvironment = await environment();
      let ciphertext: string | null = null;
      let summary: ChannelSetupSummary = { provider, enabled: false };
      let configured: Record<string, string> = { [`${provider.toUpperCase()}_ENABLED`]: 'false' };
      let pairingUrl: string | undefined;
      if (input !== undefined) {
        const encryption = await encryptionKey();
        const verified = await options.verifier.verify(provider, input);
        configured = z.record(z.string(), z.string().max(8192)).parse(verified.environment);
        if (Object.keys(configured).some((key) => !fields[provider].has(key)))
          throw new Error('Invalid channel configuration.');
        summary = summarySchema.parse({ ...verified.summary, provider, enabled: true });
        if (provider === 'telegram' && !configured.TELEGRAM_ALLOWED_USER_ID) {
          const pairing = issuePairing(summary, summary.accountHandle);
          Object.assign(configured, pairing.environment);
          summary = pairing.summary;
          pairingUrl = pairing.pairingUrl;
        }
        ciphertext = seal(encryption, owner, provider, configured);
      }
      const nextEnvironment = Object.fromEntries(
        Object.entries(oldEnvironment).filter(([key]) => !fields[provider].has(key)),
      );
      Object.assign(nextEnvironment, configured);
      const unlink =
        provider === 'whatsapp' &&
        linkedModes.has(oldEnvironment.WHATSAPP_MODE ?? '') &&
        (input === undefined || !linkedModes.has(configured.WHATSAPP_MODE ?? ''));
      if (summary.webhookStatus === 'registration_pending') {
        if (!options.verifier.register || provider !== 'telegram' || summary.mode !== 'webhook')
          throw new Error('Channel registration is unavailable.');
        await store.save({ provider, enabled: true, ciphertext, summary });
        try {
          summary = await activate(provider, { environment: configured, summary });
        } catch (error) {
          throw new ChannelSetupFailure(
            'activation_pending',
            error instanceof ChannelSetupFailure ? error.details : undefined,
          );
        }
        return { ok: true, channel: summary, ...(pairingUrl ? { pairingUrl } : {}) };
      }
      try {
        await store.save(
          { provider, enabled: input !== undefined, ciphertext, summary },
          async () => {
            if (unlink) await options.unlink?.();
            await options.apply(nextEnvironment);
          },
        );
      } catch (error) {
        try {
          await options.apply(oldEnvironment);
        } catch {}
        throw error;
      }
      if (input === undefined)
        await options.verifier.unregister?.(provider, oldEnvironment).catch(() => {});
      return { ok: true, channel: summary, ...(pairingUrl ? { pairingUrl } : {}) };
    });
  }
  async function reconnect(provider: ChannelProvider) {
    return exclusive(async () => {
      const channel = (await status()).channels.find((item) => item.provider === provider);
      if (!channel?.enabled) throw new ChannelSetupFailure('pairing_unavailable');
      const configured = await environment();
      if (provider === 'telegram' && !managed.telegram && channel.mode === 'webhook')
        await activate(provider, { environment: configured, summary: channel });
      else await options.apply(configured);
      return {
        ok: true,
        channel: (await status()).channels.find((item) => item.provider === provider)!,
      };
    });
  }
  async function savedRow(provider: ChannelProvider) {
    if (managed[provider]) return;
    const row = (await store.read()).find((item) => item.provider === provider && item.enabled);
    return row?.ciphertext
      ? { row, configured: openChannelSettings(await encryptionKey(), owner, row) }
      : undefined;
  }
  function withoutPairing(configured: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(configured).filter(([key]) => !key.includes('_PAIRING_')),
    );
  }
  async function replaceRow(
    row: ChannelSettingsRow,
    next: Record<string, string>,
    summary: ChannelSetupSummary,
  ) {
    await store.replace(row, {
      ...row,
      ciphertext: seal(await encryptionKey(), owner, row.provider, next),
      summary: summarySchema.parse(summary),
    });
  }
  function ownerSettings(
    provider: ChannelProvider,
    request: ChannelPairingRequest,
  ): Record<string, string> {
    if (provider === 'telegram') return { TELEGRAM_ALLOWED_USER_ID: request.senderId };
    return {
      ...(request.senderId.endsWith('@lid') ? {} : { WHATSAPP_ALLOWED_NUMBER: request.senderId }),
      ...(request.threadId.endsWith('@lid') ? { WHATSAPP_ALLOWED_LID: request.threadId } : {}),
    };
  }
  async function pair(request: ChannelPairingRequest, signal?: AbortSignal) {
    const provider = providerSchema.safeParse(request.channelId);
    if (
      !provider.success ||
      !pairingRequestSchema.safeParse(request).success ||
      !pairingSender[provider.data].safeParse(request).success
    )
      return false;
    const paired = await exclusive(async () => {
      const current = await savedRow(provider.data);
      if (!current) return false;
      const { row, configured } = current;
      const prefix = provider.data.toUpperCase();
      const expected = Buffer.from(configured[`${prefix}_PAIRING_CODE_HASH`] ?? '', 'hex');
      const actual = Buffer.from(pairingHash(request.code), 'hex');
      if (
        !(Number(configured[`${prefix}_PAIRING_EXPIRES_AT`]) > Date.now()) ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        (provider.data === 'telegram' && accountId('telegram', configured) !== request.accountId)
      )
        return false;
      const {
        pairingExpiresAt: _expiry,
        pairedUser: _user,
        pairedUsername: _username,
        ...summary
      } = summarySchema.parse(row.summary);
      const {
        WHATSAPP_ALLOWED_NUMBER: _number,
        WHATSAPP_ALLOWED_LID: _lid,
        ...settings
      } = withoutPairing(configured);
      await replaceRow(
        row,
        { ...settings, ...ownerSettings(provider.data, request) },
        {
          ...summary,
          pairedUser: request.senderName,
          ...(request.senderUsername ? { pairedUsername: request.senderUsername } : {}),
          ...(provider.data === 'telegram' ? { allowedUserId: request.senderId } : {}),
        },
      );
      return true;
    }, signal);
    return paired;
  }
  async function restartPairing(provider: ChannelProvider) {
    return exclusive(async () => {
      if (managed[provider]) throw new ChannelSetupFailure('server_managed');
      const current = await savedRow(provider);
      if (!current) throw new ChannelSetupFailure('pairing_unavailable');
      const summary = summarySchema.parse(current.row.summary);
      let address = summary.accountHandle;
      if (provider === 'whatsapp') {
        const link =
          summary.mode === 'linked'
            ? await options.linkStatus?.().catch(() => undefined)
            : undefined;
        if (link?.state !== 'connected') throw new ChannelSetupFailure('pairing_unavailable');
        address = link.accountHandle;
      }
      const recovering = summary.webhookStatus === 'registration_pending';
      if (recovering) {
        try {
          await activate(provider, { environment: current.configured, summary });
        } catch {
          throw new ChannelSetupFailure('activation_pending');
        }
      }
      const latest = await savedRow(provider);
      if (!latest) throw new ChannelSetupFailure('pairing_unavailable');
      const channel = summarySchema.parse(latest.row.summary);
      if (recovering && latest.configured.TELEGRAM_ALLOWED_USER_ID) return { ok: true, channel };
      const pairing = issuePairing(channel, address);
      await replaceRow(
        latest.row,
        { ...withoutPairing(latest.configured), ...pairing.environment },
        pairing.summary,
      );
      return {
        ok: true,
        channel: summarySchema.parse(pairing.summary),
        pairingUrl: pairing.pairingUrl,
      };
    });
  }
  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.setErrorHandler((error, _request, reply) => {
        const messages = {
          invalid_input:
            'Check the account details and use a public HTTPS URL ending in the channel webhook path.',
          verification_failed:
            'The account could not be verified. Check the token, account and permissions.',
          existing_webhook:
            'This bot already uses a webhook. Remove it before connecting here, or configure webhook delivery on your server.',
          webhook_failed:
            'Telegram did not confirm the webhook registration. Check the public URL and try again.',
          activation_pending:
            'The setup was saved, but message delivery could not be confirmed. Retry the connection to continue.',
          server_managed:
            'This channel is managed by the server environment. Update it there and restart Nod.',
          pairing_unavailable:
            'This channel setup step is no longer available. Refresh Channels and try again.',
        };
        reply
          .code(
            error instanceof ChannelSetupFailure && error.reason === 'server_managed'
              ? 409
              : error instanceof ChannelSetupFailure && error.reason === 'activation_pending'
                ? 503
                : error instanceof ChannelSetupFailure || error instanceof z.ZodError
                  ? 400
                  : 503,
          )
          .send({
            error:
              error instanceof ChannelSetupFailure
                ? error.details
                  ? error.reason === 'activation_pending'
                    ? `${messages.activation_pending} ${error.details}`
                    : error.details
                  : messages[error.reason]
                : 'Channel settings could not be saved securely. Check the setup before retrying.',
          });
      });
      scope.get('/api/channel-settings', status);
      scope.post<{ Params: { provider: string } }>(
        '/api/channel-settings/:provider/reconnect',
        { bodyLimit: 1024 },
        (request) => reconnect(providerSchema.parse(request.params.provider)),
      );
      scope.get('/api/channel-settings/whatsapp/pairing', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const row = (await status()).channels.find(
          (item) => item.provider === 'whatsapp' && item.enabled && item.mode === 'linked',
        );
        if (!row || !options.linkStatus) throw new ChannelSetupFailure('pairing_unavailable');
        return options.linkStatus();
      });
      scope.post('/api/channel-settings/whatsapp/pairing', { bodyLimit: 1024 }, (request, reply) =>
        exclusive(async () => {
          reply.header('Cache-Control', 'no-store');
          const { pairingId } = z.object({ pairingId: z.uuid() }).strict().parse(request.body);
          const row = (await status()).channels.find(
            (item) => item.provider === 'whatsapp' && item.enabled && item.mode === 'linked',
          );
          if (!row || !options.linkStatus || !options.cancelPairing)
            throw new ChannelSetupFailure('pairing_unavailable');
          if (!(await options.cancelPairing(pairingId, true)))
            throw new ChannelSetupFailure('pairing_unavailable');
          await options.apply(await environment());
          return options.linkStatus();
        }),
      );
      scope.delete('/api/channel-settings/whatsapp/pairing', { bodyLimit: 1024 }, (request) => {
        const { pairingId } = z.object({ pairingId: z.uuid() }).strict().parse(request.body);
        if (managed.whatsapp) throw new ChannelSetupFailure('server_managed');
        return change('whatsapp', undefined, pairingId);
      });
      scope.put<{ Params: { provider: string } }>(
        '/api/channel-settings/:provider',
        { bodyLimit: 16_384 },
        async (request) => change(providerSchema.parse(request.params.provider), request.body),
      );
      scope.post('/api/channel-settings/telegram/pairing', { bodyLimit: 1024 }, () =>
        restartPairing('telegram'),
      );
      scope.post('/api/channel-settings/whatsapp/phone', { bodyLimit: 1024 }, () =>
        restartPairing('whatsapp'),
      );
      scope.delete<{ Params: { provider: string } }>(
        '/api/channel-settings/:provider',
        async (request) => change(providerSchema.parse(request.params.provider)),
      );
    });
  }
  return {
    registerRoutes,
    environment,
    status,
    recover,
    pair,
    disable: (provider: ChannelProvider) => change(provider),
  };
}
