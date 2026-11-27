import { transaction } from './transaction.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { parse as parseDomain } from 'tldts';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import { authenticatorCode } from './authenticator.ts';
import { authenticatorKey } from '../shared/authenticator-key.ts';
import { createVaultUses, VaultUseError } from './vault-use.ts';
import type {
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultLoginEntry,
  VaultListEntry,
  VaultCardEntry,
  VaultCardNumber,
  VaultImportResult,
  VaultPaymentCard,
} from '../shared/contracts.ts';
import type {
  BrowserAction,
  BrowserPage,
  CredentialInput,
  CredentialSubmission,
} from '../ports/computer.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SiteIcon } from '../ports/link-preview.ts';
import { ownerId as owner } from './config.ts';
import { logFailure } from './failure-log.ts';
import type { TurnRef } from './thread.ts';
import { browserOf, turnChainSql } from './turn-chain.ts';
import { loopbackHost } from '../shared/loopback.ts';
import type { CaptureAnalytics } from './analytics.ts';
import { lockKey, lockSetup, locksTable } from './locks.ts';
const passwordInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    origin: z.string().max(2048),
    username: z.string(),
    password: z.string().min(1),
    authenticatorKey: z.string().max(2048).optional(),
  })
  .strict();
const loginInput = passwordInput
  .extend({
    username: z.string().default(''),
    password: z.string().default(''),
  })
  .refine((input) => Boolean(input.username.trim() || input.password));
const updateInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    username: z.string(),
    password: z.string().optional(),
    authenticatorKey: z.string().max(2048).optional(),
  })
  .strict();
const cardFields = {
  label: z.string().trim().min(1).max(100),
  cardholder: z.string().trim().min(1).max(200),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(9999),
};
const cardInput = z
  .object({
    kind: z.literal('card'),
    ...cardFields,
    cardNumber: z.string().max(40),
  })
  .strict();
const cardUpdateInput = cardInput.extend({
  cardNumber: z.string().max(40).optional(),
});
const cardSecret = z.object({
  cardholder: cardFields.cardholder,
  cardNumber: z.string().regex(/^\d{12,19}$/),
  expiryMonth: cardFields.expiryMonth,
  expiryYear: cardFields.expiryYear,
});
type CardSecret = z.infer<typeof cardSecret>;
const requestInput = z
  .object({
    origin: z.string().max(2048),
    kind: z.literal('otp').optional(),
    usernameSelector: z.string().min(1).optional(),
    passwordSelector: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    submitSelector: z.string().min(1).optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    kind:
      input.kind === 'otp'
        ? ('otp' as const)
        : input.passwordSelector
          ? ('password' as const)
          : ('identifier' as const),
  }));
type SignInInput = z.input<typeof requestInput>;
type VaultOptions = {
  signal?: AbortSignal;
  analytics?: CaptureAnalytics;
  onOwnerUse?(
    entry: {
      action: 'reveal';
      origin: string;
      itemId: string;
      itemKind: 'login' | 'card';
    },
    client?: PoolClient,
  ): Promise<void>;
  inject(input: CredentialInput, signal?: AbortSignal): Promise<CredentialSubmission | void>;
  keyStore: CredentialKeyStore;
  page?(threadId: string, step?: BrowserAction): Promise<BrowserPage>;
  icon?(origin: string): Promise<SiteIcon | null>;
};
type EntryRow = {
  id: string;
  owner_id: string;
  label: string;
  origin: string;
  username_hint: string;
  ciphertext: string;
  updated_at: Date;
};
type CardRow = {
  id: string;
  owner_id: string;
  label: string;
  brand: string;
  last4: string;
  expiry_month: number;
  expiry_year: number;
  ciphertext: string;
  updated_at: Date;
};

export async function sealedDataExists(pool: Pick<Pool, 'query'>) {
  const tables = (
    await pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c WHERE c.relkind='r' AND pg_table_is_visible(c.oid)
       AND c.relname = ANY($1::text[])`,
      [
        [
          'vault_entries',
          'vault_cards',
          'vault_app_grants',
          'channel_settings',
          'channel_session_keys',
        ],
      ],
    )
  ).rows.map((row) => row.name);
  for (const table of tables)
    if (
      (
        await pool.query(
          `SELECT 1 FROM ${table} WHERE ciphertext IS NOT NULL AND ciphertext<>'' LIMIT 1`,
        )
      ).rowCount
    )
      return true;
  return false;
}

const keyCheck = { id: 'key-check', owner_id: owner, origin: 'nod:vault' };

async function verifyKey(pool: Pool, key: Buffer) {
  await transaction(async (client) => {
    await lockSetup(client, `nod-vault-key:${owner}`);
    await client.query(
      'CREATE TABLE IF NOT EXISTS vault_key_check (owner_id text PRIMARY KEY, ciphertext text NOT NULL)',
    );
    const row = (
      await client.query<{ ciphertext: string }>(
        'SELECT ciphertext FROM vault_key_check WHERE owner_id=$1',
        [owner],
      )
    ).rows[0];
    if (row) {
      try {
        openCredential(key, { ...keyCheck, ciphertext: row.ciphertext });
        return;
      } catch {
        if (await sealedDataExists(client)) throw new Error('The Vault key does not match.');
      }
    } else if (await sealedDataExists(client)) {
      const tables = (
        await client.query<{ name: string }>(
          `SELECT c.relname AS name FROM pg_class c WHERE c.relkind='r' AND pg_table_is_visible(c.oid) AND c.relname=ANY($1::text[])`,
          [
            [
              'vault_entries',
              'vault_cards',
              'vault_app_grants',
              'channel_settings',
              'channel_session_keys',
            ],
          ],
        )
      ).rows;
      let verified = false;
      for (const { name } of tables) {
        const entries = (
          await client.query<Record<string, string>>(
            `SELECT * FROM ${name} WHERE ciphertext IS NOT NULL AND ciphertext<>''`,
          )
        ).rows;
        for (const entry of entries) {
          const associated =
            name === 'vault_cards'
              ? ['nod-vault-card-v1', entry.owner_id!, entry.id!]
              : name === 'vault_app_grants'
                ? ['nod-app-grant-v1', entry.owner_id!, entry.id!]
                : name === 'channel_settings'
                  ? ['nod-channel-settings-v1', entry.owner_id!, entry.provider!]
                  : name === 'channel_session_keys'
                    ? ['nod', 'channel-session', entry.owner_id!, 'whatsapp', entry.slot!]
                    : ['nod-vault-v1', entry.owner_id!, entry.origin!, entry.id!];
          try {
            openVaultValue(key, associated, entry.ciphertext!);
            verified = true;
          } catch {}
        }
      }
      if (!verified) throw new Error('The Vault key does not match existing data.');
    }
    await client.query(
      `INSERT INTO vault_key_check(owner_id,ciphertext) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET ciphertext=excluded.ciphertext`,
      [owner, sealCredential(key, keyCheck, { username: '', password: '' })],
    );
  }, pool);
}

export function checkedKeyStore(pool: Pool, keyStore: CredentialKeyStore): CredentialKeyStore {
  let checked: Promise<Buffer> | undefined;
  return {
    ...keyStore,
    getKey: () =>
      (checked ??= keyStore
        .getKey()
        .then(async (key) => {
          await verifyKey(pool, key);
          return key;
        })
        .catch((error: unknown) => {
          checked = undefined;
          throw error;
        })),
  };
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

function credentialUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError(
      'The website address is not valid. Enter a URL such as https://example.com.',
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost(url.hostname))) {
    throw new VaultError(
      'This website address needs HTTPS. Use an address that starts with https://, such as https://example.com.',
    );
  }
  if (url.username || url.password)
    throw new VaultError(
      'Remove the username and password from the website address. Enter them in the login fields.',
    );
  return url;
}

export function credentialOrigin(value: string) {
  const url = credentialUrl(value);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new VaultError(
      'Use only the website origin, such as https://example.com. Remove the path, query, and fragment.',
    );
  return url.origin;
}

export function credentialOrigins(value: string) {
  const origin = credentialOrigin(value);
  const url = new URL(origin);
  const host = url.hostname.replace(/^www\./, '');
  const domain = parseDomain(host, { allowPrivateDomains: true });
  if (host.startsWith('www.') || domain.domain !== host || !(domain.isIcann || domain.isPrivate))
    return [origin];
  url.hostname = url.hostname === host ? `www.${host}` : host;
  return [origin, url.origin];
}

function savedCredentialOrigin(value: string) {
  const trimmed = value.trim();
  return credentialUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    .origin;
}

function requireFullHost(raw: unknown) {
  const { origin } = z.object({ origin: z.string().max(2048) }).parse(raw);
  const { hostname } = new URL(savedCredentialOrigin(origin));
  if (!loopbackHost(hostname) && !/[^.]\.[^.]/.test(hostname))
    throw new VaultError(
      'The website domain is incomplete. Enter the full domain, such as example.com.',
    );
}

function binding(entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>) {
  return ['nod-vault-v1', entry.owner_id, entry.origin, entry.id];
}

export function sealCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>,
  secret: { username: string; password: string; authenticator?: string },
) {
  return sealVaultValue(
    key,
    binding(entry),
    JSON.stringify({
      username: secret.username,
      password: secret.password,
      ...(secret.authenticator ? { authenticator: secret.authenticator } : {}),
    }),
  );
}

export function openCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin' | 'ciphertext'>,
) {
  return z
    .object({ username: z.string(), password: z.string(), authenticator: z.string().optional() })
    .strict()
    .parse(JSON.parse(openVaultValue(key, binding(entry), entry.ciphertext)));
}

function savedAuthenticator(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const key = authenticatorKey(value);
  if (!key)
    throw new VaultError(
      'The authenticator key is not valid. Paste the setup key or otpauth:// link from the website.',
    );
  return key;
}

function inferredIdentifierLabel(username: string) {
  return z.email().safeParse(username).success ? 'Email' : 'Username';
}

function metadata(entry: EntryRow, username?: string): VaultLoginEntry {
  return {
    kind: 'login',
    id: entry.id,
    label: entry.label,
    origin: entry.origin,
    usernameHint: entry.username_hint,
    ...(username === undefined ? {} : { identifierLabel: inferredIdentifierLabel(username) }),
    updatedAt: new Date(entry.updated_at).toISOString(),
  };
}

function normalizedCardNumber(value: string) {
  if (!/^[0-9 -]+$/.test(value))
    throw new VaultError('The card number is not valid. Check that all digits match your card.');
  const number = value.replace(/[ -]/g, '');
  if (!/^\d{12,19}$/.test(number) || /^(\d)\1+$/.test(number))
    throw new VaultError('The card number is not valid. Check that all digits match your card.');
  let sum = 0;
  let double = false;
  for (let index = number.length - 1; index >= 0; index--) {
    let digit = Number(number[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  if (sum % 10 !== 0)
    throw new VaultError('The card number is not valid. Check that all digits match your card.');
  return number;
}

function validateCardExpiry(month: number, year: number) {
  const now = new Date();
  if (year > now.getUTCFullYear() + 30)
    throw new VaultError(
      'The expiry year is too far in the future. Enter the year shown on your card.',
    );
  if (
    year < now.getUTCFullYear() ||
    (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)
  )
    throw new VaultError('This card has expired. Use a card that has not expired.');
}

function cardBrand(number: string) {
  if (number.startsWith('4')) return 'Visa';
  if (/^3[47]/.test(number)) return 'American Express';
  const prefix = Number(number.slice(0, 4));
  if (/^5[1-5]/.test(number) || (prefix >= 2221 && prefix <= 2720)) return 'Mastercard';
  if (/^(6011|65|64[4-9])/.test(number)) return 'Discover';
  return 'Card';
}

function cardBinding(entry: Pick<CardRow, 'id' | 'owner_id'>) {
  return ['nod-vault-card-v1', entry.owner_id, entry.id];
}

function sealCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id'>, secret: CardSecret) {
  return sealVaultValue(key, cardBinding(entry), JSON.stringify(secret));
}

function openCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id' | 'ciphertext'>) {
  try {
    return cardSecret.parse(JSON.parse(openVaultValue(key, cardBinding(entry), entry.ciphertext)));
  } catch {
    throw new VaultError('This saved card could not be opened.', 500);
  }
}

function cardMetadata(entry: CardRow): VaultCardEntry {
  return {
    kind: 'card',
    id: entry.id,
    label: entry.label,
    brand: entry.brand,
    last4: entry.last4,
    expiryMonth: entry.expiry_month,
    expiryYear: entry.expiry_year,
    updatedAt: new Date(entry.updated_at).toISOString(),
  };
}

function cardVersion(entry: CardRow) {
  return createHash('sha256').update(entry.ciphertext).digest('hex');
}

export async function createVault(pool: Pool, options: VaultOptions) {
  await pool.query(`
    ${locksTable};
    CREATE TABLE IF NOT EXISTS vault_entries (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, origin text NOT NULL,
      username_hint text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS vault_cards (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
      brand text NOT NULL, last4 text NOT NULL, expiry_month integer NOT NULL, expiry_year integer NOT NULL,
      ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS vault_cards_owner ON vault_cards(owner_id);
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
  `);
  const uses = await createVaultUses(pool, owner, options.analytics, options.signal);
  let keyPromise: Promise<Buffer> | undefined;
  const key = () => {
    keyPromise ??= options.keyStore
      .getKey()
      .then(async (value) => {
        if (!Buffer.isBuffer(value) || value.length !== 32)
          throw new Error('Invalid credential key.');
        return value;
      })
      .catch(() => {
        keyPromise = undefined;
        throw new VaultError(
          'Nod can’t open your Vault. Restore the Vault key and restart Nod.',
          503,
        );
      });
    return keyPromise;
  };
  async function list(ownerId = owner, client?: PoolClient) {
    const { rows } = await (client ?? pool).query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id = $1 ORDER BY updated_at DESC',
      [ownerId],
    );
    return rows.map((entry) => metadata(entry));
  }

  async function listEntries(): Promise<VaultListEntry[]> {
    let logins = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id=$1 ORDER BY updated_at DESC',
      [owner],
    );
    const entries: VaultListEntry[] = [];
    if (logins.rows.length) {
      const credentialKey = await key();
      logins = await pool.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE owner_id=$1 ORDER BY updated_at DESC',
        [owner],
      );
      for (const entry of logins.rows) {
        try {
          const { username } = openCredential(credentialKey, entry);
          entries.push({ ...metadata(entry, username), username });
        } catch {
          entries.push({ ...metadata(entry), username: '', unreadable: true });
        }
      }
    }
    const cards = await pool.query<CardRow>(
      'SELECT * FROM vault_cards WHERE owner_id=$1 ORDER BY updated_at DESC',
      [owner],
    );
    entries.push(...cards.rows.map(cardMetadata));
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function ownedEntry(id: string) {
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2',
      [id, owner],
    );
    if (!rows[0]) throw new VaultError('This saved login could not be found.', 404);
    return rows[0];
  }

  async function readCredential(rawId: string) {
    const id = z.uuid().parse(rawId);
    await ownedEntry(id);
    const credentialKey = await key();
    const entry = await ownedEntry(id);
    try {
      return { entry, secret: openCredential(credentialKey, entry) };
    } catch {
      throw new VaultError('This saved login could not be opened.', 500);
    }
  }

  function track(
    item_type: 'login' | 'card',
    operation: 'create' | 'update' | 'delete',
    source?: 'user' | 'agent',
  ) {
    options.analytics?.({
      event: 'vault_changed',
      properties: {
        item_type,
        operation,
        ...(source ? { source } : {}),
      },
    });
  }

  async function save(ownerId: string, raw: unknown, source?: 'user') {
    const saved = await transaction((client) => saveEntry(ownerId, raw, client), pool);
    if (saved.operation) track('login', saved.operation, source);
    return saved.entry;
  }

  async function saveEntry(
    ownerId: string,
    raw: unknown,
    database: PoolClient,
  ): Promise<{ entry: VaultLoginEntry; operation?: 'create' | 'update' }> {
    await lockKey(database, `nod-vault-items:${ownerId}`);
    const input = passwordInput.extend({ password: z.string() }).parse(raw);
    const origin = savedCredentialOrigin(input.origin);
    const authenticator = savedAuthenticator(input.authenticatorKey);
    const credentialKey = await key();
    const existing = await database.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id=$1 AND origin=ANY($2::text[]) FOR UPDATE',
      [ownerId, credentialOrigins(origin)],
    );
    const matching = existing.rows.flatMap((candidate) => {
      try {
        const secret = openCredential(credentialKey, candidate);
        return secret.username === input.username ? [{ entry: candidate, secret }] : [];
      } catch {
        return [];
      }
    });
    const current =
      matching.find(({ secret }) => secret.password) ?? (matching.length ? matching[0] : undefined);
    if (current) {
      const { entry, secret } = current;
      const password = input.password || secret.password;
      const key = authenticator ?? secret.authenticator;
      if (password === secret.password && key === secret.authenticator)
        return { entry: metadata(entry, input.username) };
      const { rows } = await database.query<EntryRow>(
        'UPDATE vault_entries SET ciphertext=$3,updated_at=now() WHERE id=$1 AND owner_id=$2 AND ciphertext=$4 RETURNING *',
        [
          entry.id,
          ownerId,
          sealCredential(credentialKey, entry, {
            username: input.username,
            password,
            authenticator: key,
          }),
          entry.ciphertext,
        ],
      );
      if (rows[0]) return { entry: metadata(rows[0], input.username), operation: 'update' };
    }
    const entry = {
      id: randomUUID(),
      owner_id: ownerId,
      origin,
    };
    const ciphertext = sealCredential(credentialKey, entry, {
      username: input.username,
      password: input.password,
      authenticator,
    });
    const hint = input.username ? `${input.username.slice(0, 2)}…` : '';
    const { rows } = await database.query<EntryRow>(
      'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [entry.id, ownerId, input.label, entry.origin, hint, ciphertext],
    );
    return { entry: metadata(rows[0], input.username), operation: 'create' };
  }

  async function importLogins(raw: unknown): Promise<VaultImportResult> {
    const { logins } = z
      .object({ logins: z.array(z.unknown()).min(1) })
      .strict()
      .parse(raw);
    const row = z
      .object({
        label: z.string(),
        origin: z.string().max(2048),
        username: z.string(),
        password: z.string().min(1),
        authenticatorKey: z.string().max(2048).optional(),
      })
      .strict();
    const credentialKey = await key();
    const result = { imported: 0, existing: 0, skipped: 0, authenticatorKeys: 0 };
    await transaction(async (client) => {
      await lockKey(client, `nod-vault-items:${owner}`);
      const { rows } = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE owner_id=$1 FOR UPDATE',
        [owner],
      );
      const known = new Map<
        string,
        {
          entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>;
          secret: ReturnType<typeof openCredential>;
        }
      >();
      for (const row of rows) {
        try {
          const secret = openCredential(credentialKey, row);
          known.set(JSON.stringify([row.origin, secret.username]), { entry: row, secret });
        } catch {}
      }
      for (const item of logins) {
        const parsed = row.safeParse(item);
        let origin: string;
        let authenticator: string | undefined;
        try {
          if (!parsed.success) throw new Error();
          origin = credentialOrigin(parsed.data.origin);
          requireFullHost({ origin });
          authenticator = savedAuthenticator(parsed.data.authenticatorKey);
        } catch {
          result.skipped++;
          continue;
        }
        const login = parsed.data;
        const account = JSON.stringify([origin, login.username]);
        const existing = known.get(account);
        if (existing) {
          result.existing++;
          if (authenticator && !existing.secret.authenticator) {
            existing.secret.authenticator = authenticator;
            await client.query(
              'UPDATE vault_entries SET ciphertext=$3,updated_at=now() WHERE id=$1 AND owner_id=$2',
              [
                existing.entry.id,
                owner,
                sealCredential(credentialKey, existing.entry, existing.secret),
              ],
            );
            result.authenticatorKeys++;
          }
          continue;
        }
        const entry = { id: randomUUID(), owner_id: owner, origin };
        const secret = { username: login.username, password: login.password, authenticator };
        known.set(account, { entry, secret });
        await client.query(
          'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            entry.id,
            owner,
            (login.label.trim() || new URL(origin).hostname.replace(/^www\./, '')).slice(0, 100),
            origin,
            login.username ? `${login.username.slice(0, 2)}…` : '',
            sealCredential(credentialKey, entry, secret),
          ],
        );
        result.imported++;
        if (authenticator) result.authenticatorKeys++;
      }
    }, pool);
    if (result.imported)
      options.analytics?.({ event: 'vault_imported', properties: { count: result.imported } });
    return result;
  }

  async function update(rawId: string, raw: unknown) {
    const id = z.uuid().parse(rawId);
    const input = updateInput.parse(raw);
    const authenticator =
      input.authenticatorKey === undefined
        ? undefined
        : (savedAuthenticator(input.authenticatorKey) ?? null);
    await ownedEntry(id);
    const credentialKey = await key();
    let changed = false;
    const entry = await transaction(async (client) => {
      const { rows } = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      );
      const entry = rows[0];
      if (!entry) throw new VaultError('This saved login could not be found.', 404);
      let secret: ReturnType<typeof openCredential>;
      try {
        secret = openCredential(credentialKey, entry);
      } catch {
        throw new VaultError('This saved login could not be opened.', 500);
      }
      if (!input.username.trim() && !input.password && !secret.password)
        throw new VaultError('Add a username, email or password for this login.', 400);
      const key = authenticator === undefined ? secret.authenticator : (authenticator ?? undefined);
      changed =
        input.label !== entry.label ||
        input.username !== secret.username ||
        Boolean(input.password && input.password !== secret.password) ||
        key !== secret.authenticator;
      const ciphertext = sealCredential(credentialKey, entry, {
        username: input.username,
        password: input.password || secret.password,
        authenticator: key,
      });
      const result = await client.query<EntryRow>(
        'UPDATE vault_entries SET label=$3,username_hint=$4,ciphertext=$5,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',
        [
          id,
          owner,
          input.label,
          input.username ? `${input.username.slice(0, 2)}…` : '',
          ciphertext,
        ],
      );
      return metadata(result.rows[0], input.username);
    }, pool);
    if (changed) track('login', 'update', 'user');
    return entry;
  }

  async function ownedCard(id: string, client?: PoolClient) {
    const { rows } = await (client ?? pool).query<CardRow>(
      `SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2${client ? ' FOR SHARE' : ''}`,
      [id, owner],
    );
    if (!rows[0]) throw new VaultError('This saved card could not be found.', 404);
    return rows[0];
  }

  async function readCard(rawId: string, client?: PoolClient) {
    const id = z.uuid().parse(rawId);
    await ownedCard(id, client);
    const credentialKey = await key();
    const entry = await ownedCard(id, client);
    return { entry, secret: openCard(credentialKey, entry) };
  }

  async function paymentCards(): Promise<VaultPaymentCard[]> {
    const { rows } = await pool.query<CardRow>(
      'SELECT * FROM vault_cards WHERE owner_id=$1 ORDER BY updated_at DESC',
      [owner],
    );
    if (!rows.length) return [];
    const credentialKey = await key();
    return rows.flatMap((row) => {
      try {
        openCard(credentialKey, row);
        return [
          {
            id: row.id,
            version: cardVersion(row),
            label: row.label,
            brand: row.brand,
            last4: row.last4,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  async function paymentCard(id: string, version?: string, client?: PoolClient) {
    const { entry, secret } = await readCard(id, client);
    if (version !== undefined && cardVersion(entry) !== version)
      throw new VaultError('This card changed. Request a fresh payment approval.', 409);
    return secret;
  }

  async function saveCard(raw: unknown) {
    const input = cardInput.parse(raw);
    validateCardExpiry(input.expiryMonth, input.expiryYear);
    const number = normalizedCardNumber(input.cardNumber);
    const entry = { id: randomUUID(), owner_id: owner };
    const ciphertext = sealCard(await key(), entry, {
      cardholder: input.cardholder,
      cardNumber: number,
      expiryMonth: input.expiryMonth,
      expiryYear: input.expiryYear,
    });
    const { rows } = await pool.query<CardRow>(
      'INSERT INTO vault_cards(id,owner_id,label,brand,last4,expiry_month,expiry_year,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        entry.id,
        owner,
        input.label,
        cardBrand(number),
        number.slice(-4),
        input.expiryMonth,
        input.expiryYear,
        ciphertext,
      ],
    );
    track('card', 'create', 'user');
    return cardMetadata(rows[0]);
  }

  async function updateCard(rawId: string, raw: unknown) {
    const id = z.uuid().parse(rawId);
    const input = cardUpdateInput.parse(raw);
    validateCardExpiry(input.expiryMonth, input.expiryYear);
    const replacement =
      input.cardNumber === undefined ? undefined : normalizedCardNumber(input.cardNumber);
    await ownedCard(id);
    const credentialKey = await key();
    let changed = false;
    const entry = await transaction(async (client) => {
      const { rows } = await client.query<CardRow>(
        'SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      );
      const entry = rows[0];
      if (!entry) throw new VaultError('This saved card could not be found.', 404);
      const secret = openCard(credentialKey, entry);
      const number = replacement ?? secret.cardNumber;
      changed =
        input.label !== entry.label ||
        input.cardholder !== secret.cardholder ||
        number !== secret.cardNumber ||
        input.expiryMonth !== secret.expiryMonth ||
        input.expiryYear !== secret.expiryYear;
      const ciphertext = sealCard(credentialKey, entry, {
        cardholder: input.cardholder,
        cardNumber: number,
        expiryMonth: input.expiryMonth,
        expiryYear: input.expiryYear,
      });
      const result = await client.query<CardRow>(
        `UPDATE vault_cards SET label=$3,brand=$4,last4=$5,expiry_month=$6,expiry_year=$7,ciphertext=$8,
         updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *`,
        [
          id,
          owner,
          input.label,
          cardBrand(number),
          number.slice(-4),
          input.expiryMonth,
          input.expiryYear,
          ciphertext,
        ],
      );
      return cardMetadata(result.rows[0]);
    }, pool);
    if (changed) track('card', 'update', 'user');
    return entry;
  }

  async function currentTurn(
    database: Pick<PoolClient, 'query'>,
    turn: TurnRef,
    ownerId: string,
    lock = '',
  ) {
    const { rows } = await database.query<{ id: string; started_at: Date | null }>(
      `SELECT u.id,u.started_at FROM turns u JOIN threads th ON th.id=u.thread_id
       WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3 AND u.status='running' AND th.archived_at IS NULL${lock}`,
      [turn.turnId, ownerId, turn.threadId],
    );
    return rows.length === 1 ? rows[0] : undefined;
  }

  async function rootTurn(database: Pick<PoolClient, 'query'>, turn: TurnRef, ownerId: string) {
    const { rows } = await database.query<{ id: string }>(
      `${turnChainSql()} SELECT c.id FROM chain c WHERE NOT EXISTS (SELECT 1 FROM chain p WHERE p.id=c.next) LIMIT 1`,
      [turn.turnId, ownerId, turn.threadId],
    );
    return rows[0]?.id;
  }

  async function lastEntry(
    database: Pick<PoolClient, 'query'>,
    rootTurnId: string,
    origin: string,
  ) {
    const { rows } = await database.query<{ item_id: string | null; created_at: Date }>(
      `SELECT item_id,created_at FROM vault_uses WHERE owner_id=$1 AND root_turn_id=$2 AND origin=ANY($3::text[])
       AND kind IN ('identifier','password') AND status<>'not_entered' ORDER BY created_at DESC LIMIT 1`,
      [owner, rootTurnId, credentialOrigins(origin)],
    );
    return rows[0];
  }

  async function automaticUse(
    database: Pick<PoolClient, 'query'>,
    rootTurnId: string,
    origin: string,
    kind: string,
    itemId: string | null,
    since?: number,
    sessionId?: string,
  ) {
    const lock = `nod-vault-automatic:${owner}:${rootTurnId}:${sessionId ?? ''}:${origin}:${kind}`;
    await lockKey(database, lock);
    await database.query('DELETE FROM nod_locks WHERE key=$1', [lock]);
    const { rowCount } = await database.query(
      `SELECT 1 FROM vault_uses v
       LEFT JOIN turns u ON u.id=v.turn_id AND u.owner_id=v.owner_id
       WHERE v.owner_id=$1 AND v.root_turn_id=$2 AND v.origin=$3 AND v.kind=$4
       AND (v.item_id IS NULL OR v.item_id=$5) AND ($6::timestamptz IS NULL OR v.created_at>=$6)
       AND ($7::uuid IS NULL OR v.turn_id IS NULL OR u.session_id=$7::uuid) LIMIT 1`,
      [
        owner,
        rootTurnId,
        origin,
        kind,
        itemId,
        since === undefined ? null : new Date(since),
        sessionId ?? null,
      ],
    );
    return Boolean(rowCount);
  }

  async function inspectRequest(threadId: string, raw: SignInInput) {
    const input = requestInput.parse(raw);
    const origin = credentialOrigin(input.origin);
    const page = await options.page?.(threadId);
    if (page && page.origin !== origin)
      throw new VaultError('The login page origin changed. Read the page again.', 409);
    const kind = input.kind;
    const target = kind === 'identifier' ? input.usernameSelector : input.passwordSelector;
    const usernameSelector = kind === 'otp' ? undefined : input.usernameSelector;
    if (!target)
      throw new VaultError('Choose a visible sign-in field from the current browser page.', 409);
    if (Array.isArray(target) && (kind !== 'otp' || new Set(target).size !== target.length))
      throw new VaultError('Choose each code field once, in code order.', 409);
    if (kind === 'password' && usernameSelector === target)
      throw new VaultError('Choose different fields for the username and password.', 409);
    for (const selector of [input.submitSelector, usernameSelector, ...[target].flat()])
      if (
        selector &&
        (await options.page?.(threadId, { action: 'fill', selector }))?.controls?.length === 0
      )
        throw new VaultError(
          'This sign-in step names a field or button that is not on the current page, so nothing was entered. Read the page again and call sign_in with its current controls.',
          409,
        );
    return { ...input, origin, usernameSelector };
  }

  async function fill(turn: TurnRef, ownerId: string, entryId: string, raw: SignInInput) {
    if (ownerId !== owner) throw new VaultError('This task belongs to another owner.', 409);
    const input = await inspectRequest(browserOf(turn), raw);
    const root = await rootTurn(pool, turn, ownerId);
    if (!root) throw new VaultError('This task can no longer use credentials.', 409);
    const credentialKey = await key();
    let secret: ReturnType<typeof openCredential> | undefined;
    const result = await uses.run(
      {
        ownerId,
        rootTurnId: root,
        turnId: turn.turnId,
        origin: input.origin,
        kind: input.kind,
        itemId: entryId,
      },
      {
        prepare: async (client) => {
          if (!(await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT')))
            throw new VaultError('This task step is no longer active.', 409);
          const row = (
            await client.query<EntryRow>(
              'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=ANY($3::text[]) FOR SHARE',
              [entryId, ownerId, credentialOrigins(input.origin)],
            )
          ).rows[0];
          if (!row) throw new VaultError('This saved login is no longer available.', 404);
          secret = openCredential(credentialKey, row);
          const value =
            input.kind === 'otp'
              ? secret.authenticator
              : input.kind === 'identifier'
                ? secret.username
                : secret.password;
          if (!value) return false;
          const entered = await lastEntry(client, root, input.origin);
          const bound =
            input.kind === 'otp' || (input.kind === 'password' && !input.usernameSelector);
          if (bound && entered?.item_id && entered.item_id !== row.id) return false;
          const since = input.kind === 'otp' ? entered?.created_at.getTime() : undefined;
          if (
            await automaticUse(
              client,
              root,
              input.origin,
              input.kind,
              row.id,
              since,
              input.kind === 'otp' ? undefined : browserOf(turn),
            )
          )
            return false;
        },
        perform: async (signal) => {
          await options.inject(
            {
              threadId: browserOf(turn),
              origin: input.origin,
              kind: input.kind,
              ...(input.usernameSelector ? { usernameSelector: input.usernameSelector } : {}),
              ...(input.passwordSelector ? { passwordSelector: input.passwordSelector } : {}),
              ...(input.submitSelector ? { submitSelector: input.submitSelector } : {}),
              ...(input.kind === 'otp'
                ? { code: authenticatorCode(secret!.authenticator!) }
                : input.kind === 'identifier'
                  ? { username: secret!.username }
                  : {
                      ...(input.usernameSelector ? { username: secret!.username } : {}),
                      password: secret!.password,
                    }),
            },
            signal,
          );
          return true;
        },
      },
    );
    return result === true;
  }

  async function authenticatorLogin(
    turn: TurnRef,
    ownerId: string,
    rawOrigin: string,
    savedLoginId?: string,
  ) {
    if (ownerId !== owner) return undefined;
    const origin = credentialOrigin(rawOrigin);
    const root = await rootTurn(pool, turn, ownerId);
    if (!root) return undefined;
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id=$1 AND origin=ANY($2::text[])',
      [ownerId, credentialOrigins(origin)],
    );
    if (!rows.length) return undefined;
    const credentialKey = await key();
    const entered = (await lastEntry(pool, root, origin))?.item_id;
    const candidates = rows.filter((entry) => {
      if ((entered && entry.id !== entered) || (savedLoginId && entry.id !== savedLoginId))
        return false;
      try {
        return Boolean(openCredential(credentialKey, entry).authenticator);
      } catch {
        return false;
      }
    });
    return candidates.length === 1 ? metadata(candidates[0]!) : undefined;
  }

  function siteIcon(origin: string) {
    if (!options.icon || loopbackHost(new URL(origin).hostname)) return null;
    return options.icon(origin);
  }

  function registerRoutes(app: FastifyInstance) {
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof VaultError || error instanceof VaultUseError
            ? error.statusCode
            : error instanceof z.ZodError
              ? 400
              : (error as { statusCode?: number }).statusCode === 413
                ? 413
                : 500;
        if (status >= 500) logFailure('vault_request_failed', error);
        reply.code(status).send({
          error:
            error instanceof VaultError || error instanceof VaultUseError
              ? error.message
              : status === 400
                ? 'Check the credential fields.'
                : status === 413
                  ? 'This is too large. Import fewer logins at a time.'
                  : 'The vault request could not be completed.',
        });
      });
      scope.get('/api/vault', listEntries);
      scope.post('/api/vault/import', { bodyLimit: 5_000_000 }, async (request) =>
        importLogins(request.body),
      );
      scope.post('/api/vault', { bodyLimit: 16_384 }, async (request) => {
        const { kind } = z
          .object({ kind: z.enum(['login', 'card']).optional() })
          .parse(request.body);
        if (kind === 'card') return saveCard(request.body);
        requireFullHost(request.body);
        return save(owner, loginInput.parse(request.body), 'user');
      });
      scope.patch<{ Params: { id: string } }>(
        '/api/vault/:id',
        { bodyLimit: 16_384 },
        async (request): Promise<VaultEntry> => {
          const { kind } = z
            .object({ kind: z.enum(['login', 'card']).optional() })
            .parse(request.body);
          return kind === 'card'
            ? updateCard(request.params.id, request.body)
            : update(request.params.id, request.body);
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/details',
        async (request): Promise<VaultEntryDetails> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const id = z.uuid().parse(request.params.id);
          const card = await pool.query('SELECT id FROM vault_cards WHERE id=$1 AND owner_id=$2', [
            id,
            owner,
          ]);
          if (card.rowCount) {
            const { entry, secret } = await readCard(id);
            return { ...cardMetadata(entry), cardholder: secret.cardholder };
          }
          const { entry, secret } = await readCredential(request.params.id);
          return {
            ...metadata(entry, secret.username),
            username: secret.username,
            hasPassword: Boolean(secret.password),
            hasAuthenticator: Boolean(secret.authenticator),
          };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/password',
        async (request): Promise<VaultEntryPassword> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { entry, secret } = await readCredential(request.params.id);
          await options.onOwnerUse?.({
            action: 'reveal',
            origin: entry.origin,
            itemId: entry.id,
            itemKind: 'login',
          });
          return { password: secret.password };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/card-number',
        async (request): Promise<VaultCardNumber> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCard(request.params.id);
          await options.onOwnerUse?.({
            action: 'reveal',
            origin: 'nod:vault',
            itemId: request.params.id,
            itemKind: 'card',
          });
          return { cardNumber: secret.cardNumber };
        },
      );
      scope.get<{ Params: { id: string } }>('/api/vault/:id/icon', async (request, reply) => {
        const id = z.uuid().safeParse(request.params.id);
        const { rows } = id.success
          ? await pool.query<{ origin: string }>(
              'SELECT origin FROM vault_entries WHERE id=$1 AND owner_id=$2',
              [id.data, owner],
            )
          : { rows: [] };
        const icon = rows[0] ? await siteIcon(rows[0].origin) : null;
        if (!icon) return reply.code(404).send({ error: 'The website icon is unavailable.' });
        return reply
          .header('Content-Type', icon.mimeType)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .send(Buffer.from(icon.bytes));
      });
      scope.delete<{ Params: { id: string } }>('/api/vault/:id', async (request) => {
        const removed = await pool.query<{ kind: 'login' | 'card'; origin: string | null }>(
          `WITH login AS (DELETE FROM vault_entries WHERE id=$1 AND owner_id=$2 RETURNING origin),
           card AS (DELETE FROM vault_cards WHERE id=$1 AND owner_id=$2 RETURNING id)
           SELECT 'login' AS kind, origin FROM login UNION ALL SELECT 'card' AS kind, NULL AS origin FROM card`,
          [z.uuid().parse(request.params.id), owner],
        );
        for (const row of removed.rows) track(row.kind, 'delete', 'user');
        return { ok: true };
      });
    });
  }

  return {
    uses,
    registerRoutes,
    saveLogin: async (input: {
      origin: string;
      label: string;
      username: string;
      password: string;
      authenticatorKey?: string;
    }) => {
      if (!input.username) {
        const { rows } = await pool.query<EntryRow>(
          'SELECT * FROM vault_entries WHERE owner_id=$1 AND origin=ANY($2::text[])',
          [owner, credentialOrigins(input.origin)],
        );
        if (rows.length === 1)
          input = { ...input, username: openCredential(await key(), rows[0]!).username };
      }
      return save(owner, passwordInput.parse(input), 'user');
    },
    list,
    fill,
    authenticatorLogin,
    paymentCards,
    paymentCard,
  };
}
