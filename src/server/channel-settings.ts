import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import {
  ChannelSetupFailure,
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
const summarySchema = z.object({
  provider: providerSchema,
  enabled: z.boolean(),
  accountName: z.string().max(200).optional(),
  accountHandle: z.string().max(200).optional(),
  mode: z.enum(['polling', 'webhook', 'linked']).optional(),
  linkMode: z.enum(['bot', 'self-chat']).optional(),
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
  pairingCandidate: z
    .object({
      id: z.string().regex(telegramUserId),
      name: z.string().min(1).max(200),
      username: z
        .string()
        .regex(/^[A-Za-z0-9_]{1,64}$/)
        .optional(),
    })
    .optional(),
  pairingExpiresAt: z.iso.datetime().optional(),
});
const candidateSchema = z.object({
  senderId: z.string().regex(telegramUserId),
  senderName: z.string().min(1).max(200),
  senderUsername: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .optional(),
  accountId: z.string().min(1),
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  sentAt: z.iso.datetime(),
});
type TelegramPairingCandidate = z.infer<typeof candidateSchema>;
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
    'WHATSAPP_VERIFY_TOKEN',
  ]),
};
type ChannelSettingsRow = {
  provider: ChannelProvider;
  enabled: boolean;
  ciphertext: string | null;
  summary: ChannelSetupSummary;
};

export async function initializeChannelSettings(pool: Pick<Pool, 'query'>) {
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO channel_settings(owner_id,provider,enabled,ciphertext,summary) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(owner_id,provider) DO UPDATE SET enabled=EXCLUDED.enabled,ciphertext=EXCLUDED.ciphertext,summary=EXCLUDED.summary,updated_at=now()`,
          [owner, row.provider, row.enabled, row.ciphertext, JSON.stringify(row.summary)],
        );
        await beforeCommit?.();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async activate(provider: ChannelProvider) {
      return (
        await pool.query<Pick<ChannelSettingsRow, 'summary'>>(
          `UPDATE channel_settings SET summary=jsonb_set(summary,'{webhookStatus}','"registered"'),updated_at=now() WHERE owner_id=$1 AND provider=$2 AND enabled=true RETURNING summary`,
          [owner, provider],
        )
      ).rows[0]?.summary;
    },
    async replace(
      previous: ChannelSettingsRow,
      next: ChannelSettingsRow,
      beforeCommit: (client: PoolClient) => Promise<(() => void) | undefined>,
    ) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE channel_settings SET ciphertext=$2,summary=$3::jsonb || CASE WHEN summary ? 'webhookStatus' THEN jsonb_build_object('webhookStatus',summary->'webhookStatus') ELSE '{}'::jsonb END,updated_at=now()
           WHERE owner_id=$1 AND provider='telegram' AND enabled=true AND ciphertext=$4`,
          [owner, next.ciphertext, JSON.stringify(next.summary), previous.ciphertext],
        );
        if (updated.rowCount !== 1) throw new ChannelSetupFailure('pairing_unavailable');
        const notify = await beforeCommit(client);
        await client.query('COMMIT');
        return notify;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function createLock() {
  let pending = Promise.resolve();
  return async <T>(action: () => Promise<T>) => {
    let resolve: () => void = () => {};
    const previous = pending;
    pending = new Promise<void>((done) => {
      resolve = done;
    });
    await previous;
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
function issuePairing(summary: ChannelSetupSummary) {
  const handle = summary.accountHandle;
  if (!handle || !/^@[A-Za-z0-9_]{1,64}$/.test(handle))
    throw new ChannelSetupFailure('verification_failed');
  const code = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + pairingLifetimeMs);
  return {
    environment: {
      TELEGRAM_PAIRING_CODE_HASH: pairingHash(code),
      TELEGRAM_PAIRING_EXPIRES_AT: String(expiresAt.getTime()),
    },
    summary: {
      ...summary,
      pairingCandidate: undefined,
      pairingExpiresAt: expiresAt.toISOString(),
    },
    pairingUrl: `https://t.me/${handle.slice(1)}?start=${code}`,
  };
}
export function openChannelSettings(key: Buffer, owner: string, row: ChannelSettingsRow) {
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
    apply(environment: Record<string, string>): Promise<void>;
    linkStatus?(): Promise<ChannelLinkStatus>;
    cancelPairing?(pairingId: string, restart?: boolean): Promise<boolean>;
    unlink?(): Promise<void>;
    paired?(candidate: TelegramPairingCandidate, client: PoolClient): Promise<() => void>;
  },
) {
  const owner = z.string().min(1).max(200).parse(options.ownerId);
  const store = await databaseStore(pool, owner);
  const exclusive = createLock();
  const pairingExclusive = createLock();
  let key: Promise<Buffer> | undefined;
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
    const result: Record<string, string> = {};
    for (const row of rows) {
      providerSchema.parse(row.provider);
      if (row.enabled && row.ciphertext) {
        Object.assign(result, openChannelSettings(await encryptionKey(), owner, row));
      } else result[`${row.provider.toUpperCase()}_ENABLED`] = 'false';
    }
    return result;
  }
  async function status() {
    const rows = await store.read();
    const linked = rows.some(
      (row) => row.provider === 'whatsapp' && row.enabled && row.summary.mode === 'linked',
    )
      ? await options.linkStatus?.()
      : undefined;
    return {
      ready: options.keyStore.configured,
      channels: rows.map((row) =>
        summarySchema.parse({
          ...row.summary,
          provider: row.provider,
          enabled: row.enabled,
          ...(row.provider === 'whatsapp' && linked
            ? {
                connectionState: linked.state,
                accountHandle: linked.accountHandle,
                accountName: linked.accountName,
              }
            : {}),
        }),
      ),
    };
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
        (row) => row.enabled && row.summary.webhookStatus === 'registration_pending',
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
          const pairing = issuePairing(summary);
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
        (oldEnvironment.WHATSAPP_MODE === 'bot' || oldEnvironment.WHATSAPP_MODE === 'self-chat') &&
        (input === undefined || configured.WHATSAPP_MODE !== oldEnvironment.WHATSAPP_MODE);
      if (summary.webhookStatus === 'registration_pending') {
        if (!options.verifier.register || provider !== 'telegram' || summary.mode !== 'webhook')
          throw new Error('Channel registration is unavailable.');
        await store.save({ provider, enabled: true, ciphertext, summary });
        try {
          summary = await activate(provider, { environment: configured, summary });
        } catch {
          throw new ChannelSetupFailure('activation_pending');
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
  async function telegramRow() {
    const row = (await store.read()).find((item) => item.provider === 'telegram' && item.enabled);
    return row?.ciphertext
      ? { row, configured: openChannelSettings(await encryptionKey(), owner, row) }
      : undefined;
  }
  function withoutPairing(configured: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(configured).filter(([key]) => !key.startsWith('TELEGRAM_PAIRING_')),
    );
  }
  async function replaceTelegram(
    row: ChannelSettingsRow,
    next: Record<string, string>,
    summary: ChannelSetupSummary,
    apply: boolean,
    candidate?: TelegramPairingCandidate,
  ) {
    const oldEnvironment = apply ? await environment() : {};
    try {
      return await store.replace(
        row,
        {
          ...row,
          ciphertext: seal(await encryptionKey(), owner, 'telegram', next),
          summary: summarySchema.parse(summary),
        },
        async (client) => {
          if (apply)
            await options.apply({
              ...Object.fromEntries(
                Object.entries(oldEnvironment).filter(([key]) => !fields.telegram.has(key)),
              ),
              ...next,
            });
          return candidate && client ? options.paired?.(candidate, client) : undefined;
        },
      );
    } catch (error) {
      if (apply)
        try {
          await options.apply(oldEnvironment);
        } catch {}
      throw error;
    }
  }
  async function pair(request: ChannelPairingRequest) {
    return pairingExclusive(async () => {
      const current = await telegramRow();
      const sender = candidateSchema.safeParse({
        ...request,
        sentAt: request.sentAt.toISOString(),
      });
      if (!current || request.channelId !== 'telegram' || !sender.success) return false;
      const { row, configured } = current;
      const expected = Buffer.from(configured.TELEGRAM_PAIRING_CODE_HASH ?? '', 'hex');
      const actual = Buffer.from(pairingHash(request.code), 'hex');
      if (
        configured.TELEGRAM_ALLOWED_USER_ID ||
        accountId('telegram', configured) !== request.accountId ||
        !(Number(configured.TELEGRAM_PAIRING_EXPIRES_AT) > Date.now()) ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        return false;
      const expiresAt = new Date(Date.now() + pairingLifetimeMs);
      try {
        await replaceTelegram(
          row,
          {
            ...withoutPairing(configured),
            TELEGRAM_PAIRING_EXPIRES_AT: String(expiresAt.getTime()),
            TELEGRAM_PAIRING_CANDIDATE: JSON.stringify(sender.data),
          },
          {
            ...summarySchema.parse(row.summary),
            pairingCandidate: {
              id: sender.data.senderId,
              name: sender.data.senderName,
              ...(sender.data.senderUsername ? { username: sender.data.senderUsername } : {}),
            },
            pairingExpiresAt: expiresAt.toISOString(),
          },
          false,
        );
      } catch (error) {
        if (error instanceof ChannelSetupFailure) return false;
        throw error;
      }
      return true;
    });
  }
  async function bind(allowedUserId?: string) {
    const bound = await exclusive(async () => {
      const current = await telegramRow();
      if (!current || current.configured.TELEGRAM_ALLOWED_USER_ID)
        throw new ChannelSetupFailure('pairing_unavailable');
      const { row, configured } = current;
      if (row.summary.webhookStatus === 'registration_pending')
        throw new ChannelSetupFailure('activation_pending');
      let candidate: TelegramPairingCandidate | undefined;
      if (allowedUserId === undefined) {
        if (!(Number(configured.TELEGRAM_PAIRING_EXPIRES_AT) > Date.now()))
          throw new ChannelSetupFailure('pairing_unavailable');
        try {
          candidate = candidateSchema.parse(
            JSON.parse(configured.TELEGRAM_PAIRING_CANDIDATE ?? ''),
          );
        } catch {
          throw new ChannelSetupFailure('pairing_unavailable');
        }
      }
      const id = candidate?.senderId ?? allowedUserId!;
      const {
        pairingCandidate: _candidate,
        pairingExpiresAt: _expiry,
        pairedUser: _user,
        pairedUsername: _username,
        ...rest
      } = summarySchema.parse(row.summary);
      const summary = summarySchema.parse({
        ...rest,
        allowedUserId: id,
        ...(candidate
          ? { pairedUser: candidate.senderName, pairedUsername: candidate.senderUsername }
          : {}),
      });
      const notify = await replaceTelegram(
        row,
        { ...withoutPairing(configured), TELEGRAM_ALLOWED_USER_ID: id },
        summary,
        true,
        candidate,
      );
      return { summary, notify };
    });
    bound.notify?.();
    return { ok: true, channel: bound.summary };
  }
  async function restartPairing() {
    return exclusive(async () => {
      const current = await telegramRow();
      if (!current) throw new ChannelSetupFailure('pairing_unavailable');
      const summary = summarySchema.parse(current.row.summary);
      const recovering = summary.webhookStatus === 'registration_pending';
      if (recovering) {
        try {
          await activate('telegram', { environment: current.configured, summary });
        } catch {
          throw new ChannelSetupFailure('activation_pending');
        }
      }
      const result = await pairingExclusive(async () => {
        const latest = await telegramRow();
        if (!latest) throw new ChannelSetupFailure('pairing_unavailable');
        const channel = summarySchema.parse(latest.row.summary);
        if (
          recovering &&
          (latest.configured.TELEGRAM_ALLOWED_USER_ID ||
            (channel.pairingCandidate &&
              Number(latest.configured.TELEGRAM_PAIRING_EXPIRES_AT) > Date.now()))
        )
          return { ok: true, channel };
        if (latest.configured.TELEGRAM_ALLOWED_USER_ID)
          throw new ChannelSetupFailure('pairing_unavailable');
        const pairing = issuePairing(channel);
        await replaceTelegram(
          latest.row,
          { ...withoutPairing(latest.configured), ...pairing.environment },
          pairing.summary,
          false,
        );
        return {
          ok: true,
          channel: summarySchema.parse(pairing.summary),
          pairingUrl: pairing.pairingUrl,
        };
      });
      return result;
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
            'This Telegram bot already uses a webhook. Remove that webhook or enter its public URL before switching to local polling.',
          webhook_failed:
            'Telegram did not confirm the webhook registration. Check the public URL and try again.',
          activation_pending:
            'The setup was saved and the bot token is valid, but nod could not start receiving messages. Retry the connection to continue.',
          pairing_unavailable:
            'This channel setup step is no longer available. Refresh Channels and try again.',
        };
        reply
          .code(
            error instanceof ChannelSetupFailure && error.reason === 'activation_pending'
              ? 503
              : error instanceof ChannelSetupFailure || error instanceof z.ZodError
                ? 400
                : 503,
          )
          .send({
            error:
              error instanceof ChannelSetupFailure
                ? messages[error.reason]
                : 'Channel settings could not be saved securely. Check the setup before retrying.',
          });
      });
      scope.get('/api/channel-settings', status);
      scope.get('/api/channel-settings/whatsapp/pairing', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const row = (await store.read()).find(
          (item) => item.provider === 'whatsapp' && item.enabled && item.summary.mode === 'linked',
        );
        if (!row || !options.linkStatus) throw new ChannelSetupFailure('pairing_unavailable');
        return options.linkStatus();
      });
      scope.post('/api/channel-settings/whatsapp/pairing', { bodyLimit: 1024 }, (request, reply) =>
        exclusive(async () => {
          reply.header('Cache-Control', 'no-store');
          const { pairingId } = z.object({ pairingId: z.uuid() }).strict().parse(request.body);
          const row = (await store.read()).find(
            (item) =>
              item.provider === 'whatsapp' && item.enabled && item.summary.mode === 'linked',
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
        return change('whatsapp', undefined, pairingId);
      });
      scope.put<{ Params: { provider: string } }>(
        '/api/channel-settings/:provider',
        { bodyLimit: 16_384 },
        async (request) => change(providerSchema.parse(request.params.provider), request.body),
      );
      scope.post('/api/channel-settings/telegram/pairing', { bodyLimit: 1024 }, restartPairing);
      scope.post('/api/channel-settings/telegram/confirm', { bodyLimit: 1024 }, () => bind());
      scope.post('/api/channel-settings/telegram/user', { bodyLimit: 1024 }, (request) =>
        bind(
          z
            .object({
              allowedUserId: z.string().trim().regex(telegramUserId),
            })
            .strict()
            .parse(request.body).allowedUserId,
        ),
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
