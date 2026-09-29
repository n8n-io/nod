import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  ChannelSetupFailure,
  type ChannelProvider,
  type ChannelSetupConfiguration,
  type ChannelSetupSummary,
  type ChannelSetupVerifier,
  type ChannelAccountRegistry,
} from '../ports/channel-settings.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { ChannelPairingRequest } from '../ports/messaging.ts';

const providerSchema = z.enum(['telegram', 'whatsapp']);
const summarySchema = z.object({
  provider: providerSchema,
  enabled: z.boolean(),
  accountName: z.string().max(200).optional(),
  accountHandle: z.string().max(200).optional(),
  mode: z.enum(['polling', 'webhook']).optional(),
  webhookStatus: z.enum(['registered', 'manual_setup', 'registration_pending']).optional(),
  webhookUrl: z.url().max(2048).optional(),
  pairedUser: z.string().min(1).max(200).optional(),
  allowedUserId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .optional(),
  pairingCandidate: z
    .object({
      id: z.string().regex(/^[1-9]\d{0,15}$/),
      name: z.string().min(1).max(200),
    })
    .optional(),
  pairingExpiresAt: z.iso.datetime().optional(),
});
const candidateSchema = z.object({
  senderId: z.string().regex(/^[1-9]\d{0,15}$/),
  senderName: z.string().min(1).max(200),
  accountId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(1024),
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
    'WHATSAPP_POLICY_CONFIRMED',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ALLOWED_NUMBER',
    'WHATSAPP_VERIFY_TOKEN',
  ]),
};
type SettingsRow = {
  provider: ChannelProvider;
  enabled: boolean;
  ciphertext: string | null;
  summary: ChannelSetupSummary;
};

function binding(owner: string, provider: ChannelProvider) {
  return Buffer.from(JSON.stringify(['otto-channel-settings-v1', owner, provider]));
}
function seal(
  key: Buffer,
  owner: string,
  provider: ChannelProvider,
  environment: Record<string, string>,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(binding(owner, provider));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(environment)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
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
function open(key: Buffer, owner: string, row: SettingsRow) {
  const encoded = Buffer.from(row.ciphertext!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12));
  decipher.setAAD(binding(owner, row.provider));
  decipher.setAuthTag(encoded.subarray(12, 28));
  const result = z
    .record(z.string(), z.string().max(8192))
    .parse(
      JSON.parse(
        Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
  if (Object.keys(result).some((key) => !fields[row.provider].has(key)))
    throw new Error('Invalid channel configuration.');
  return result;
}

export async function createChannelSettings(
  pool: Pool,
  options: {
    ownerId: string;
    accounts?: ChannelAccountRegistry;
    keyStore: CredentialKeyStore;
    verifier: ChannelSetupVerifier;
    apply(environment: Record<string, string>): Promise<void>;
    paired?(candidate: TelegramPairingCandidate, client: PoolClient): Promise<() => void>;
  },
) {
  const owner = z.string().min(1).max(200).parse(options.ownerId);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS channel_settings(owner_id text NOT NULL,provider text NOT NULL,enabled boolean NOT NULL,ciphertext text,summary jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,provider))`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS channel_account_claims(owner_id text NOT NULL,provider text NOT NULL,account_id text NOT NULL,PRIMARY KEY(owner_id,provider,account_id))`,
  );
  await pool.query(
    'ALTER TABLE channel_account_claims ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS pending boolean NOT NULL DEFAULT true',
  );
  let pending = Promise.resolve();
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
  async function claim(provider: ChannelProvider, id: string) {
    if (!options.accounts) return;
    const result = await pool.query<{ revision: string }>(
      `INSERT INTO channel_account_claims(owner_id,provider,account_id,revision,pending) VALUES($1,$2,$3,1,true)
       ON CONFLICT(owner_id,provider,account_id) DO UPDATE SET revision=channel_account_claims.revision+1,pending=true
       WHERE channel_account_claims.revision<9223372036854775807 RETURNING revision::text`,
      [owner, provider, id],
    );
    const revision = result.rows[0]?.revision;
    if (!revision) throw new Error('Channel ownership could not be checked.');
    if (!(await options.accounts.claim({ ownerId: owner, provider, accountId: id, revision })))
      throw new ChannelSetupFailure('account_in_use');
  }
  async function reconcileClaims() {
    if (!options.accounts) return true;
    const current = await pool.query<SettingsRow>(
      'SELECT * FROM channel_settings WHERE owner_id=$1 AND enabled=true',
      [owner],
    );
    const active = new Set<string>();
    for (const row of current.rows) {
      if (!row.ciphertext) continue;
      const provider = providerSchema.parse(row.provider);
      const id = accountId(provider, open(await encryptionKey(), owner, row));
      if (id) active.add(`${provider}:${id}`);
    }
    const claims = await pool.query<{
      provider: ChannelProvider;
      account_id: string;
      revision: string;
    }>(
      'SELECT provider,account_id,revision::text FROM channel_account_claims WHERE owner_id=$1 AND pending=true',
      [owner],
    );
    let recovered = true;
    for (const row of claims.rows) {
      if (active.has(`${row.provider}:${row.account_id}`)) continue;
      try {
        await options.accounts.release({
          ownerId: owner,
          provider: providerSchema.parse(row.provider),
          accountId: row.account_id,
          revision: row.revision,
        });
        await pool.query(
          'UPDATE channel_account_claims SET pending=false WHERE owner_id=$1 AND provider=$2 AND account_id=$3 AND revision=$4',
          [owner, row.provider, row.account_id, row.revision],
        );
      } catch {
        recovered = false;
      }
    }
    return recovered;
  }
  async function environment() {
    const { rows } = await pool.query<SettingsRow>(
      'SELECT * FROM channel_settings WHERE owner_id=$1',
      [owner],
    );
    const result: Record<string, string> = {};
    for (const row of rows) {
      providerSchema.parse(row.provider);
      if (row.enabled && row.ciphertext) {
        const configured = open(await encryptionKey(), owner, row);
        if (options.accounts) {
          const id = accountId(row.provider, configured);
          if (!id) throw new ChannelSetupFailure('account_in_use');
          await claim(row.provider, id);
        }
        Object.assign(result, configured);
      } else result[`${row.provider.toUpperCase()}_ENABLED`] = 'false';
    }
    return result;
  }
  async function status() {
    const { rows } = await pool.query<SettingsRow>(
      'SELECT provider,enabled,summary FROM channel_settings WHERE owner_id=$1',
      [owner],
    );
    return {
      ready: options.keyStore.configured,
      channels: rows.map((row) =>
        summarySchema.parse({ ...row.summary, provider: row.provider, enabled: row.enabled }),
      ),
    };
  }
  async function exclusive<T>(action: () => Promise<T>) {
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
  }
  async function activate(provider: ChannelProvider, configuration: ChannelSetupConfiguration) {
    if (!options.verifier.register) throw new ChannelSetupFailure('activation_pending');
    await options.apply(await environment());
    await options.verifier.register(provider, configuration);
    const summary = { ...configuration.summary, webhookStatus: 'registered' as const };
    await pool.query(
      'UPDATE channel_settings SET summary=$3,updated_at=now() WHERE owner_id=$1 AND provider=$2',
      [owner, provider, JSON.stringify(summary)],
    );
    return summary;
  }
  async function recover() {
    return exclusive(async () => {
      const recovered = await reconcileClaims();
      const { rows } = await pool.query<SettingsRow>(
        `SELECT * FROM channel_settings WHERE owner_id=$1 AND enabled=true AND summary->>'webhookStatus'='registration_pending'`,
        [owner],
      );
      for (const row of rows) {
        try {
          await activate(providerSchema.parse(row.provider), {
            environment: open(await encryptionKey(), owner, row),
            summary: summarySchema.parse(row.summary),
          });
        } catch {
          return false;
        }
      }
      return recovered;
    });
  }
  async function change(provider: ChannelProvider, input?: unknown) {
    return exclusive(async () => {
      const oldEnvironment = await environment();
      try {
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
          const nextAccount = accountId(provider, configured);
          if (options.accounts) {
            if (!nextAccount || !/^\d{1,30}$/.test(nextAccount))
              throw new ChannelSetupFailure('verification_failed');
            await claim(provider, nextAccount);
          }
          ciphertext = seal(encryption, owner, provider, configured);
        }
        const nextEnvironment = Object.fromEntries(
          Object.entries(oldEnvironment).filter(([key]) => !fields[provider].has(key)),
        );
        Object.assign(nextEnvironment, configured);
        if (summary.webhookStatus === 'registration_pending') {
          if (!options.verifier.register || provider !== 'telegram' || summary.mode !== 'webhook')
            throw new Error('Channel registration is unavailable.');
          await pool.query(
            `INSERT INTO channel_settings(owner_id,provider,enabled,ciphertext,summary) VALUES($1,$2,true,$3,$4)
          ON CONFLICT(owner_id,provider) DO UPDATE SET enabled=true,ciphertext=EXCLUDED.ciphertext,summary=EXCLUDED.summary,updated_at=now()`,
            [owner, provider, ciphertext, JSON.stringify(summary)],
          );
          try {
            summary = await activate(provider, { environment: configured, summary });
          } catch {
            throw new ChannelSetupFailure('activation_pending');
          }
          return { ok: true, channel: summary, ...(pairingUrl ? { pairingUrl } : {}) };
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO channel_settings(owner_id,provider,enabled,ciphertext,summary) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(owner_id,provider) DO UPDATE SET enabled=EXCLUDED.enabled,ciphertext=EXCLUDED.ciphertext,summary=EXCLUDED.summary,updated_at=now()`,
            [owner, provider, input !== undefined, ciphertext, JSON.stringify(summary)],
          );
          await options.apply(nextEnvironment);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          try {
            await options.apply(oldEnvironment);
          } catch {}
          throw error;
        } finally {
          client.release();
        }
        return { ok: true, channel: summary, ...(pairingUrl ? { pairingUrl } : {}) };
      } finally {
        await reconcileClaims().catch(() => false);
      }
    });
  }
  async function telegramRow() {
    const { rows } = await pool.query<SettingsRow>(
      "SELECT * FROM channel_settings WHERE owner_id=$1 AND provider='telegram' AND enabled=true",
      [owner],
    );
    const row = rows[0];
    return row?.ciphertext
      ? { row, configured: open(await encryptionKey(), owner, row) }
      : undefined;
  }
  function withoutPairing(configured: Record<string, string>) {
    return Object.fromEntries(
      Object.entries(configured).filter(([key]) => !key.startsWith('TELEGRAM_PAIRING_')),
    );
  }
  async function replaceTelegram(
    row: SettingsRow,
    next: Record<string, string>,
    summary: ChannelSetupSummary,
    apply: boolean,
    candidate?: TelegramPairingCandidate,
  ) {
    const oldEnvironment = apply ? await environment() : {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        "UPDATE channel_settings SET ciphertext=$2,summary=$3,updated_at=now() WHERE owner_id=$1 AND provider='telegram' AND enabled=true AND ciphertext=$4",
        [
          owner,
          seal(await encryptionKey(), owner, 'telegram', next),
          JSON.stringify(summarySchema.parse(summary)),
          row.ciphertext,
        ],
      );
      if (updated.rowCount !== 1) throw new ChannelSetupFailure('pairing_unavailable');
      if (apply)
        await options.apply({
          ...Object.fromEntries(
            Object.entries(oldEnvironment).filter(([key]) => !fields.telegram.has(key)),
          ),
          ...next,
        });
      const notify = candidate ? await options.paired?.(candidate, client) : undefined;
      await client.query('COMMIT');
      return notify;
    } catch (error) {
      await client.query('ROLLBACK');
      if (apply)
        try {
          await options.apply(oldEnvironment);
        } catch {}
      throw error;
    } finally {
      client.release();
    }
  }
  async function pair(request: ChannelPairingRequest) {
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
          pairingCandidate: { id: sender.data.senderId, name: sender.data.senderName },
          pairingExpiresAt: expiresAt.toISOString(),
        },
        false,
      );
    } catch (error) {
      if (error instanceof ChannelSetupFailure) return false;
      throw error;
    }
    return true;
  }
  async function bind(allowedUserId?: string) {
    const bound = await exclusive(async () => {
      const current = await telegramRow();
      if (!current || current.configured.TELEGRAM_ALLOWED_USER_ID)
        throw new ChannelSetupFailure('pairing_unavailable');
      const { row, configured } = current;
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
        ...rest
      } = summarySchema.parse(row.summary);
      const summary = summarySchema.parse({
        ...rest,
        allowedUserId: id,
        ...(candidate ? { pairedUser: candidate.senderName } : {}),
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
      if (!current || current.configured.TELEGRAM_ALLOWED_USER_ID)
        throw new ChannelSetupFailure('pairing_unavailable');
      const pairing = issuePairing(summarySchema.parse(current.row.summary));
      await replaceTelegram(
        current.row,
        { ...withoutPairing(current.configured), ...pairing.environment },
        pairing.summary,
        false,
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
          account_in_use: 'This messaging account is already connected to another Otto account.',
          invalid_input:
            'Check the account details and use a public HTTPS URL ending in the channel webhook path.',
          verification_failed:
            'The account could not be verified. Check the token, account and permissions.',
          existing_webhook:
            'This Telegram bot already uses a webhook. Remove that webhook or enter its public URL before switching to local polling.',
          webhook_failed:
            'Telegram did not confirm the webhook registration. Check the public URL and try again.',
          activation_pending:
            'The setup was saved, but activation did not finish. Restart Otto to retry the saved setup, or replace it.',
          pairing_unavailable:
            'This Telegram setup step is no longer available. Refresh Channels and try again.',
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
              allowedUserId: z
                .string()
                .trim()
                .regex(/^[1-9]\d{0,15}$/),
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
  return { registerRoutes, environment, status, recover, pair };
}
