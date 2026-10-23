import { transaction } from './transaction.ts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';
import { authenticatorCode } from './authenticator.ts';
import { authenticatorKey } from '../shared/authenticator-key.ts';
import { captureSecureEntry, createVaultUses, VaultUseError } from './vault-use.ts';
import type {
  CredentialRequest,
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
import type { BrowserAction, BrowserPage, CredentialSubmission } from '../ports/computer.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import { PasswordManagerError, type PasswordManager } from '../ports/password-manager.ts';
import type { SiteIcon } from '../ports/link-preview.ts';
import {
  normalizedEmail,
  verificationRecipient,
  type EmailCodeRequest,
  type PrivateEmailCode,
} from './email-code.ts';
import { ownerId as owner } from './config.ts';
import { logFailure } from './failure-log.ts';
import type { TurnRef } from './thread.ts';
import { browserOf, supersededSql, turnChainSql } from './turn-chain.ts';
import { loopbackHost } from '../shared/loopback.ts';
import type { CaptureAnalytics } from './analytics.ts';
import { analyticsDomain } from './analytics-connections.ts';
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
const submissionInput = z
  .object({
    username: z.string().optional(),
    password: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
  })
  .strict();
const requestInput = z
  .object({
    origin: z.string().max(2048),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['identifier', 'password', 'otp']),
    usernameSelector: z.string().min(1).optional(),
    passwordSelector: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    submitSelector: z.string().min(1).optional(),
    emailCode: z.boolean().optional(),
    emailRecipient: z.string().trim().min(3).optional(),
  })
  .strict();
type CredentialInput = z.infer<typeof requestInput>;
const methodInput = z
  .object({
    origin: z.string().max(2048),
    label: z.string().trim().min(1).max(100),
    kind: z.literal('method'),
    methods: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(100),
            selector: z.string().min(1).max(2048),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
type MethodInput = z.infer<typeof methodInput>;
type StoredInspection = Required<Pick<CredentialRequest, 'fields'>> & {
  origin: string;
  methods?: { id: string; label: string }[];
  document?: string;
};
export type CredentialInjection = CredentialInput & {
  threadId: string;
  username?: string;
  password?: string;
  code?: string;
};
export type VaultUse = {
  turnId: string;
  threadId: string;
  origin: string;
  entryId?: string;
  reason: 'entered' | 'picked';
};
type VaultOptions = {
  analytics?: CaptureAnalytics;
  refresh?(): void;
  onUse?(use: VaultUse, client: PoolClient): Promise<void>;
  onOwnerUse?(
    entry: {
      action: 'reveal';
      origin: string;
      itemId: string;
      itemKind: 'login' | 'card';
    },
    client?: PoolClient,
  ): Promise<void>;
  resume(turnId: string, client: PoolClient): Promise<void>;
  retry(turnId: string): Promise<void>;
  inject(input: CredentialInjection): Promise<CredentialSubmission | void>;
  keyStore: CredentialKeyStore;
  requestKey: Buffer;
  page?(threadId: string, step?: BrowserAction): Promise<BrowserPage>;
  signInMethods?(
    threadId: string,
    origin: string,
    methods: MethodInput['methods'],
  ): Promise<{ document: string; methods: { id: string; label: string; page: BrowserPage }[] }>;
  checkMethods?(turn: TurnRef, methods: { selector: string; page: BrowserPage }[]): Promise<void>;
  selectSignInMethod?(
    threadId: string,
    input: { origin: string; document: string; methodId: string },
  ): Promise<void>;
  emailCode?(input: EmailCodeRequest, signal: AbortSignal): Promise<PrivateEmailCode | undefined>;
  icon?(origin: string): Promise<SiteIcon | null>;
  passwordManager?: PasswordManager;
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
type RequestRow = {
  id: string;
  thread_id: string;
  browser_id: string | null;
  turn_id: string;
  root_turn_id: string;
  owner_id: string;
  origin: string;
  label: string;
  kind: CredentialRequest['kind'];
  token_hash: string;
  status: 'pending' | 'consumed' | 'superseded' | 'retried';
  operation_status?: 'running' | 'submitted' | 'uncertain';
  selectors: CredentialInput | MethodInput;
  flow_id: string | null;
  flow_expires_at: Date | null;
  created_at: Date;
  inspection: StoredInspection;
};
type RequestStatusRow = Pick<RequestRow, 'status' | 'operation_status'> & {
  current_step: boolean;
};
type SelectionRow = {
  id: string;
  root_turn_id: string;
  owner_id: string;
  origin: string;
  entry_id: string | null;
  login_label: string;
  ciphertext: string;
  blocked: boolean;
  expires_at: Date;
  credential_entered_at: Date | null;
  kind: 'identifier' | 'password';
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
          'credential_account_selections',
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

export function waitingTurnSql(alias: string, reason?: 'credentials' | 'question') {
  return `${alias}.status='waiting'${reason ? ` AND ${alias}.waiting_reason='${reason}'` : ''}
    AND EXISTS(SELECT 1 FROM threads wt WHERE wt.id=${alias}.thread_id AND wt.owner_id=${alias}.owner_id AND wt.archived_at IS NULL)
    AND NOT ${supersededSql(alias, `newer.started_at>=${alias}.started_at`)}`;
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
              'credential_account_selections',
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

function storedSelectors({ emailRecipient: _emailRecipient, ...input }: CredentialInput) {
  return JSON.stringify(input);
}

export function credentialOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError('Enter a valid website origin.');
  }
  const local = loopbackHost(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new VaultError('Use an HTTPS origin, such as https://example.com, without a path.');
  }
  return url.origin;
}

function savedCredentialOrigin(value: string) {
  const trimmed = value.trim();
  return credentialOrigin(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

function requireFullHost(raw: unknown) {
  const { origin } = z.object({ origin: z.string().max(2048) }).parse(raw);
  const { hostname } = new URL(savedCredentialOrigin(origin));
  if (!loopbackHost(hostname) && !/[^.]\.[^.]/.test(hostname))
    throw new VaultError('Enter a full website domain, such as example.com.');
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
      'Check the authenticator key. Use the setup key or otpauth:// link the website showed.',
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
  if (!/^[0-9 -]+$/.test(value)) throw new VaultError('Check the card number.');
  const number = value.replace(/[ -]/g, '');
  if (!/^\d{12,19}$/.test(number) || /^(\d)\1+$/.test(number))
    throw new VaultError('Check the card number.');
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
  if (sum % 10 !== 0) throw new VaultError('Check the card number.');
  return number;
}

function validateCardExpiry(month: number, year: number) {
  const now = new Date();
  if (
    year < now.getUTCFullYear() ||
    year > now.getUTCFullYear() + 30 ||
    (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1)
  )
    throw new VaultError('Check the card expiry date.');
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
  if (!Buffer.isBuffer(options.requestKey) || options.requestKey.length !== 32)
    throw new Error('Invalid private request key.');
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
    ALTER TABLE vault_cards DROP COLUMN IF EXISTS do_it_for_me;
    CREATE INDEX IF NOT EXISTS vault_cards_owner ON vault_cards(owner_id);
    CREATE TABLE IF NOT EXISTS credential_requests (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, owner_id text NOT NULL,
      thread_id uuid NOT NULL REFERENCES threads(id), turn_id uuid NOT NULL REFERENCES turns(id), root_turn_id uuid NOT NULL REFERENCES turns(id),
      origin text NOT NULL, label text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      selectors jsonb NOT NULL, inspection jsonb NOT NULL, failed_at timestamptz
    );
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS browser_id text;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS flow_id text;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS flow_expires_at timestamptz;
    ALTER TABLE credential_requests ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS credential_requests_flow ON credential_requests(owner_id,flow_id,created_at DESC);
    ALTER TABLE credential_requests DROP COLUMN IF EXISTS expires_at;
    ALTER TABLE credential_requests DROP COLUMN IF EXISTS resume_pending;
    CREATE TABLE IF NOT EXISTS credential_account_selections (
      id text NOT NULL, root_turn_id uuid NOT NULL REFERENCES turns(id), owner_id text NOT NULL, origin text NOT NULL,
      entry_id text, ciphertext text NOT NULL, blocked boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
      login_label text NOT NULL DEFAULT '', credential_entered_at timestamptz,
      PRIMARY KEY(root_turn_id,owner_id,origin)
    );
    CREATE INDEX IF NOT EXISTS credential_requests_turn ON credential_requests(turn_id);
    ALTER TABLE credential_account_selections ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'identifier';
    DROP INDEX IF EXISTS credential_requests_root_turn;
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
    CREATE TABLE IF NOT EXISTS password_manager_accounts (
      owner_id text PRIMARY KEY, account text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const uses = await createVaultUses(pool, owner, options.analytics);
  await pool.query(
    `
    INSERT INTO vault_uses(id,owner_id,root_turn_id,origin,kind,status)
      SELECT id,owner_id,root_turn_id,origin,kind,
        CASE WHEN status='filled' THEN 'submitted' ELSE 'uncertain' END
      FROM credential_requests WHERE owner_id=$1 AND status IN ('filled','entering','uncertain') ON CONFLICT DO NOTHING`,
    [owner],
  );
  await pool.query(
    'UPDATE vault_uses v SET root_turn_id=r.root_turn_id FROM credential_requests r WHERE v.id=r.id AND v.owner_id=r.owner_id AND r.owner_id=$1 AND v.root_turn_id IS NULL',
    [owner],
  );
  await pool.query(
    "UPDATE credential_requests SET status='consumed' WHERE owner_id=$1 AND status IN ('filled','entering','uncertain')",
    [owner],
  );
  async function forgetSecurityCodes(credentialKey: Buffer) {
    const { rows } = await pool.query<CardRow>('SELECT * FROM vault_cards WHERE owner_id=$1', [
      owner,
    ]);
    await Promise.all(
      rows.map(async (card) => {
        let stored: Record<string, unknown>;
        try {
          stored = JSON.parse(openVaultValue(credentialKey, cardBinding(card), card.ciphertext));
        } catch {
          return;
        }
        if (!('securityCode' in stored)) return;
        await pool.query(
          'UPDATE vault_cards SET ciphertext=$3 WHERE id=$1 AND owner_id=$2 AND ciphertext=$4',
          [
            card.id,
            owner,
            sealCard(credentialKey, card, cardSecret.parse(stored)),
            card.ciphertext,
          ],
        );
      }),
    );
  }
  let keyPromise: Promise<Buffer> | undefined;
  const key = () => {
    keyPromise ??= options.keyStore
      .getKey()
      .then(async (value) => {
        if (!Buffer.isBuffer(value) || value.length !== 32)
          throw new Error('Invalid credential key.');
        await forgetSecurityCodes(value);
        return value;
      })
      .catch(() => {
        keyPromise = undefined;
        throw new VaultError(
          'nod can’t open your Vault. Restore the Vault key and restart nod.',
          503,
        );
      });
    return keyPromise;
  };
  const forgetExpiredHolds = () =>
    pool
      .query(
        `UPDATE credential_account_selections SET ciphertext='',blocked=true,login_label=''
       WHERE owner_id=$1 AND login_label<>'' AND expires_at<=now()`,
        [owner],
      )
      .then(
        () => undefined,
        (error: unknown) => logFailure('vault_hold_cleanup', error),
      );
  await forgetExpiredHolds();
  if ((await pool.query('SELECT 1 FROM vault_cards WHERE owner_id=$1 LIMIT 1', [owner])).rowCount)
    await key().catch((error: unknown) => logFailure('vault_security_code_removal', error));

  async function list(ownerId = owner) {
    const { rows } = await pool.query<EntryRow>(
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
    origin?: string,
  ) {
    const domain = item_type === 'login' && origin ? analyticsDomain(origin) : undefined;
    options.analytics?.({
      event: 'nod_vault_changed',
      properties: {
        item_type,
        operation,
        ...(source ? { source } : {}),
        ...(domain ? { domain } : {}),
      },
    });
  }

  async function save(ownerId: string, raw: unknown, source?: 'user') {
    const saved = await transaction((client) => saveEntry(ownerId, raw, client), pool);
    if (saved.operation) track('login', saved.operation, source, saved.entry.origin);
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
      'SELECT * FROM vault_entries WHERE owner_id=$1 AND origin=$2 FOR UPDATE',
      [ownerId, origin],
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
        'UPDATE vault_entries SET label=$3,ciphertext=$4,updated_at=now() WHERE id=$1 AND owner_id=$2 AND ciphertext=$5 RETURNING *',
        [
          entry.id,
          ownerId,
          input.label,
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
    const origins: string[] = [];
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
        origins.push(origin);
      }
    }, pool);
    for (let index = 0; index < origins.length; index += 100) {
      options.analytics?.({
        event: 'nod_vault_imported',
        properties: {
          domains: origins
            .slice(index, index + 100)
            .map((origin) => analyticsDomain(origin) ?? 'unavailable'),
        },
      });
    }
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
    if (changed) track('login', 'update', 'user', entry.origin);
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

  async function selection(
    rootTurnId: string,
    ownerId: string,
    origin: string,
    database: Pick<PoolClient, 'query'> = pool,
  ) {
    const result = await database.query<SelectionRow>(
      'SELECT * FROM credential_account_selections WHERE root_turn_id=$1 AND owner_id=$2 AND origin=$3',
      [rootTurnId, ownerId, origin],
    );
    return result.rows[0];
  }

  async function automaticUse(
    database: Pick<PoolClient, 'query'>,
    rootTurnId: string,
    origin: string,
    kind: string,
    itemId: string | null,
    since?: number,
  ) {
    const lock = `nod-vault-automatic:${owner}:${rootTurnId}:${origin}:${kind}`;
    await lockKey(database, lock);
    await database.query('DELETE FROM nod_locks WHERE key=$1', [lock]);
    const { rowCount } = await database.query(
      `SELECT 1 FROM vault_uses WHERE owner_id=$1 AND root_turn_id=$2 AND origin=$3 AND kind=$4
       AND (item_id IS NULL OR item_id=$5) AND ($6::timestamptz IS NULL OR created_at>=$6) LIMIT 1`,
      [owner, rootTurnId, origin, kind, itemId, since === undefined ? null : new Date(since)],
    );
    return Boolean(rowCount);
  }

  async function rememberSelection(
    database: Pick<PoolClient, 'query'>,
    value: {
      rootTurnId: string;
      ownerId: string;
      origin: string;
      entryId: string | null;
      username: string;
      password?: string;
      loginLabel?: string;
      expiresAt: Date;
      blocked: boolean;
      enteredAt?: number;
      kind?: 'identifier' | 'password';
    },
  ) {
    const entry = { id: randomUUID(), owner_id: value.ownerId, origin: value.origin };
    const ciphertext = sealCredential(await key(), entry, {
      username: value.username,
      password: value.password ?? '',
    });
    await database.query(
      `INSERT INTO credential_account_selections(id,root_turn_id,owner_id,origin,entry_id,ciphertext,blocked,expires_at,login_label,credential_entered_at,kind)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(root_turn_id,owner_id,origin) DO UPDATE
       SET id=excluded.id,entry_id=excluded.entry_id,ciphertext=excluded.ciphertext,blocked=excluded.blocked,expires_at=excluded.expires_at,login_label=excluded.login_label,credential_entered_at=excluded.credential_entered_at,kind=excluded.kind`,
      [
        entry.id,
        value.rootTurnId,
        value.ownerId,
        value.origin,
        value.entryId,
        ciphertext,
        value.blocked,
        value.expiresAt,
        value.loginLabel ?? '',
        value.enteredAt === undefined ? null : new Date(value.enteredAt),
        value.kind ?? 'identifier',
      ],
    );
  }

  async function stagedUsername(selected: SelectionRow | undefined) {
    if (!selected || new Date(selected.expires_at).getTime() <= Date.now()) return undefined;
    return openCredential(await key(), selected).username;
  }

  async function inspectRequest(threadId: string, raw: CredentialInput) {
    const input = requestInput.parse(raw);
    const origin = credentialOrigin(input.origin);
    const page = await options.page?.(threadId);
    if (page && page.origin !== origin)
      throw new VaultError(
        'The login page origin changed. Request a new secure sign-in step.',
        409,
      );
    const kind = input.kind;
    const target = kind === 'identifier' ? input.usernameSelector : input.passwordSelector;
    const usernameSelector = kind === 'password' ? input.usernameSelector : undefined;
    if (!target)
      throw new VaultError('Choose a visible sign-in field from the current browser page.', 409);
    if (Array.isArray(target) && (kind !== 'otp' || new Set(target).size !== target.length))
      throw new VaultError('Choose each code field once, in code order.', 409);
    if (usernameSelector === target)
      throw new VaultError('Choose different fields for the username and password.', 409);
    const resolved: CredentialInput = {
      origin,
      label: input.label,
      kind,
      ...(input.submitSelector ? { submitSelector: input.submitSelector } : {}),
      ...(kind === 'identifier'
        ? { usernameSelector: input.usernameSelector! }
        : { passwordSelector: target, ...(usernameSelector ? { usernameSelector } : {}) }),
      ...(kind === 'otp' && input.emailCode !== undefined ? { emailCode: input.emailCode } : {}),
      ...(kind === 'otp' && input.emailRecipient ? { emailRecipient: input.emailRecipient } : {}),
    };
    const siteLabel = async (selector: string, fallback: string) =>
      (
        await options.page?.(threadId, { action: 'fill', selector }).catch(() => undefined)
      )?.controls?.[0]?.name.trim() || fallback;
    const targetLabel = await siteLabel(
      [target].flat()[0]!,
      kind === 'identifier'
        ? 'Email, phone or username'
        : kind === 'otp'
          ? 'Verification code'
          : 'Password',
    );
    const inspection: StoredInspection = {
      origin,
      fields: [
        ...(usernameSelector
          ? [
              {
                kind: 'identifier' as const,
                selector: usernameSelector,
                label: await siteLabel(usernameSelector, 'Email, phone or username'),
              },
            ]
          : []),
        ...[target].flat().map((selector) => ({ kind, selector, label: targetLabel })),
      ],
    };
    return { input: resolved, inspection };
  }

  async function requestToken(id: string, ownerId = owner) {
    return createHmac('sha256', options.requestKey)
      .update(JSON.stringify(['nod-sign-in', ownerId, id]))
      .digest('base64url');
  }

  async function inspectMethods(turn: TurnRef, raw: MethodInput) {
    const input = methodInput.parse(raw);
    input.origin = credentialOrigin(input.origin);
    if (!options.signInMethods || !options.selectSignInMethod)
      throw new VaultError('Sign-in method selection is unavailable.', 409);
    if (new Set(input.methods.map((method) => method.selector)).size !== input.methods.length)
      throw new VaultError('Choose each sign-in method once.', 409);
    const observed = await options.signInMethods(browserOf(turn), input.origin, input.methods);
    if (
      !observed.document ||
      observed.methods.length !== input.methods.length ||
      new Set(observed.methods.map((method) => method.id)).size !== observed.methods.length ||
      observed.methods.some(
        (method) => !method.id || !method.label.trim() || method.page.origin !== input.origin,
      )
    )
      throw new VaultError('The sign-in methods could not be checked. Read the page again.', 409);
    await options.checkMethods?.(
      turn,
      observed.methods.map((method, index) => ({
        selector: input.methods[index]!.selector,
        page: method.page,
      })),
    );
    return {
      input,
      inspection: {
        origin: input.origin,
        fields: [],
        document: observed.document,
        methods: observed.methods.map(({ id, label }) => ({ id, label })),
      } as StoredInspection,
    };
  }

  async function request(
    turn: TurnRef,
    ownerId: string,
    raw: CredentialInput | MethodInput,
  ): Promise<{ url: string }> {
    if (!(await currentTurn(pool, turn, ownerId)))
      throw new VaultError('This task can no longer request credentials.', 409);
    const { input, inspection } =
      raw.kind === 'method'
        ? await inspectMethods(turn, raw)
        : await inspectRequest(browserOf(turn), raw);
    const id = randomUUID();
    const token = await requestToken(id, ownerId);
    const hash = tokenHash(token);
    await forgetExpiredHolds();
    const closed = await transaction(async (client) => {
      await lockKey(client, `thread:${ownerId}`);
      if (!(await currentTurn(client, turn, ownerId, ' FOR NO KEY UPDATE OF u')))
        throw new VaultError('This task can no longer request credentials.', 409);
      const root = await rootTurn(client, turn, ownerId);
      if (!root) throw new VaultError('This task can no longer request credentials.', 409);
      const previous = (
        await client.query<Pick<RequestRow, 'flow_id' | 'flow_expires_at'>>(
          `${turnChainSql()}
         SELECT r.flow_id,r.flow_expires_at FROM credential_requests r
         LEFT JOIN vault_uses v ON v.id=r.id AND v.owner_id=r.owner_id
         WHERE r.owner_id=$2 AND r.thread_id=$3 AND r.turn_id IN (SELECT id FROM chain)
         AND r.root_turn_id=$4 AND COALESCE(r.browser_id,r.thread_id::text)=$5
         AND r.flow_id IS NOT NULL AND r.flow_expires_at>now()
         AND ((r.status='consumed' AND v.status='submitted') OR r.status='retried')
         ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
          [turn.turnId, ownerId, turn.threadId, root, browserOf(turn)],
        )
      ).rows[0];
      const superseded = await client.query<{ kind: string; origin: string }>(
        "UPDATE credential_requests SET status='superseded' WHERE thread_id=$1 AND owner_id=$2 AND status='pending' AND COALESCE(browser_id,thread_id::text)=$3 RETURNING kind,origin",
        [turn.threadId, ownerId, browserOf(turn)],
      );
      await client.query(
        `INSERT INTO credential_requests (id,token_hash,thread_id,turn_id,root_turn_id,owner_id,origin,label,kind,selectors,inspection,browser_id,flow_id,flow_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          hash,
          turn.threadId,
          turn.turnId,
          root,
          ownerId,
          input.origin,
          input.label,
          input.kind,
          input.kind === 'method' ? JSON.stringify(input) : storedSelectors(input),
          JSON.stringify(inspection),
          browserOf(turn),
          previous?.flow_id ?? id,
          previous?.flow_expires_at ?? new Date(Date.now() + 30 * 60_000),
        ],
      );
      return superseded.rows;
    }, pool);
    for (const row of closed) captureSecureEntry(options.analytics, row, 'superseded');
    captureSecureEntry(options.analytics, input, 'requested');
    return { url: `/vault/${token}` };
  }

  async function flow(token: string) {
    const source = (
      await pool.query<RequestRow & { operation_status: string }>(
        `SELECT r.*,v.status AS operation_status FROM credential_requests r
       LEFT JOIN vault_uses v ON v.id=r.id AND v.owner_id=r.owner_id
       WHERE r.token_hash=$1 AND r.owner_id=$2 AND r.flow_expires_at>now()`,
        [tokenHash(token), owner],
      )
    ).rows[0];
    if (!source) return {};
    if (
      !(source.status === 'consumed' && source.operation_status === 'submitted') &&
      source.status !== 'retried' &&
      source.status !== 'superseded'
    )
      return {};
    const next = (
      await pool.query<{ id: string; token_hash: string }>(
        `SELECT r.id,r.token_hash FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
       WHERE r.owner_id=$1 AND r.flow_id=$2 AND r.root_turn_id=$3 AND r.thread_id=$4
       AND COALESCE(r.browser_id,r.thread_id::text)=$5 AND r.flow_expires_at>now()
       AND r.status='pending' AND ${waitingTurnSql('u', 'credentials')}
       ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
        [
          owner,
          source.flow_id,
          source.root_turn_id,
          source.thread_id,
          source.browser_id ?? source.thread_id,
        ],
      )
    ).rows[0];
    if (!next || next.id === source.id) return {};
    const nextId = await requestToken(next.id);
    return tokenHash(nextId) === next.token_hash ? { nextId } : {};
  }

  function tokenHash(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new VaultError('Credential request not found.', 404);
    return createHash('sha256').update(token).digest('hex');
  }

  async function lockRequest(
    client: PoolClient,
    hash: string,
    condition = "r.status='pending'",
    allowExpired = false,
  ) {
    await lockKey(client, `thread:${owner}`);
    const { rows } = await client.query<RequestRow>(
      `SELECT r.* FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
       WHERE r.token_hash=$1 AND r.owner_id=$2 AND ${condition} ${allowExpired ? '' : "AND (r.kind<>'method' OR r.flow_expires_at>now())"} AND ${waitingTurnSql('u', 'credentials')}
       FOR UPDATE OF r`,
      [hash, owner],
    );
    return rows[0];
  }

  function requestStatus(row: RequestStatusRow): CredentialRequest['status'] {
    if (row.operation_status === 'submitted') return 'filled';
    if (row.operation_status === 'uncertain') return 'uncertain';
    if (row.operation_status === 'running') return 'entering';
    return row.status === 'pending' && row.current_step ? 'pending' : 'expired';
  }

  async function describe(token: string): Promise<CredentialRequest> {
    await forgetExpiredHolds();
    const { rows } = await pool.query<RequestRow & { current_step: boolean }>(
      `SELECT r.*,v.status AS operation_status,r.status='pending' AND (r.kind<>'method' OR r.flow_expires_at>now()) AND EXISTS(SELECT 1 FROM turns u WHERE u.id=r.turn_id AND u.owner_id=r.owner_id
        AND ${waitingTurnSql('u', 'credentials')}) AS current_step
       FROM credential_requests r LEFT JOIN vault_uses v
         ON v.id=r.id AND v.owner_id=r.owner_id AND r.status='consumed'
       WHERE r.token_hash=$1 AND r.owner_id=$2`,
      [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('Credential request not found.', 404);
    const status = requestStatus(row);
    let savedEntries: CredentialRequest['savedEntries'];
    let selectedEntryId: string | undefined;
    let username: string | undefined;
    if (status === 'pending' && (row.kind === 'identifier' || row.kind === 'password')) {
      const chosen = await selection(row.root_turn_id, row.owner_id, row.origin);
      const selected = chosen?.kind === 'identifier' ? chosen : undefined;
      username = await stagedUsername(selected);
      const entries = await pool.query<EntryRow>(
        'SELECT e.* FROM vault_entries e WHERE e.owner_id=$1 AND e.origin=$2 ORDER BY e.updated_at DESC',
        [row.owner_id, row.origin],
      );
      const matches =
        row.kind === 'password' && selected && username === undefined ? [] : entries.rows;
      savedEntries = [];
      const credentialKey = matches.length ? await key() : Buffer.alloc(0);
      for (const entry of matches) {
        let secret: ReturnType<typeof openCredential>;
        try {
          secret = openCredential(credentialKey, entry);
        } catch {
          continue;
        }
        if (
          row.kind === 'password' &&
          (!secret.password || (username !== undefined && secret.username !== username))
        )
          continue;
        savedEntries.push({ ...metadata(entry), username: secret.username });
      }
      if (
        selected &&
        !selected.blocked &&
        savedEntries.some((entry) => entry.id === selected.entry_id)
      )
        selectedEntryId = selected.entry_id ?? undefined;
    }
    const manager =
      options.passwordManager &&
      status === 'pending' &&
      (row.kind === 'identifier' || row.kind === 'password')
        ? {
            name: options.passwordManager.name,
            ...(await managerAccount().then((account) => (account ? { account } : {}))),
          }
        : undefined;
    return {
      id: token,
      turnId: row.turn_id,
      origin: row.origin,
      label: row.label,
      kind: row.kind,
      fields: row.inspection.fields,
      ...(row.kind === 'method' ? { methods: row.inspection.methods ?? [] } : {}),
      status,
      ...(savedEntries ? { savedEntries } : {}),
      ...(selectedEntryId ? { selectedEntryId } : {}),
      ...(row.kind === 'password' && username ? { username } : {}),
      ...(manager ? { passwordManager: manager } : {}),
    };
  }

  async function managerAccount() {
    return (
      await pool.query<{ account: string }>(
        'SELECT account FROM password_manager_accounts WHERE owner_id=$1',
        [owner],
      )
    ).rows[0]?.account;
  }

  async function managedRequest(token: string) {
    const manager = options.passwordManager;
    if (!manager) throw new VaultError('No password manager is available here.', 404);
    const row = (
      await pool.query<RequestRow>(
        `SELECT r.* FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
         WHERE r.token_hash=$1 AND r.owner_id=$2 AND r.status='pending' AND r.kind IN ('identifier','password')
         AND ${waitingTurnSql('u', 'credentials')}`,
        [tokenHash(token), owner],
      )
    ).rows[0];
    if (!row)
      throw new VaultError(
        'This request is expired, already used, or belongs to an earlier task step.',
        409,
      );
    return { manager, row };
  }

  function managerFailure(name: string, error: unknown): never {
    if (!(error instanceof PasswordManagerError)) throw error;
    throw new VaultError(
      error.reason === 'unavailable'
        ? `nod can’t reach ${name} on this computer. Open ${name}, sign in, and turn on Settings → Developer → Integrate with other apps. (${error.message})`
        : error.message,
      error.reason === 'missing' ? 409 : 502,
    );
  }

  async function managedLogins(token: string, raw: unknown) {
    const { account } = z
      .object({ account: z.string().trim().min(1).max(200) })
      .strict()
      .parse(raw);
    const { manager, row } = await managedRequest(token);
    const logins = await manager
      .logins(account, row.origin)
      .catch((error: unknown) => managerFailure(manager.name, error));
    await pool.query(
      `INSERT INTO password_manager_accounts(owner_id,account) VALUES($1,$2)
       ON CONFLICT(owner_id) DO UPDATE SET account=excluded.account,updated_at=now()`,
      [owner, account],
    );
    return { logins };
  }

  async function useManaged(token: string, raw: unknown) {
    const { account, id } = z
      .object({ account: z.string().trim().min(1).max(200), id: z.string().min(1).max(300) })
      .strict()
      .parse(raw);
    const { manager, row } = await managedRequest(token);
    const secret = await manager
      .login(account, row.origin, id)
      .catch((error: unknown) => managerFailure(manager.name, error));
    const saved = await transaction(
      (client) =>
        saveEntry(
          owner,
          {
            label: secret.title.trim().slice(0, 100) || new URL(row.origin).hostname,
            origin: row.origin,
            username: secret.username,
            password: secret.password,
            ...(secret.authenticatorKey && authenticatorKey(secret.authenticatorKey)
              ? { authenticatorKey: secret.authenticatorKey }
              : {}),
          },
          client,
        ),
      pool,
    );
    if (saved.operation) track('login', saved.operation, 'user', row.origin);
    return consume(token, { kind: 'saved', entryId: saved.entry.id });
  }

  type LoginSource =
    | { kind: 'saved'; entryId: string }
    | { kind: 'selection'; selected: SelectionRow }
    | { kind: 'form'; values: z.infer<typeof submissionInput> }
    | { kind: 'email'; code: PrivateEmailCode; selected?: SelectionRow; since: number }
    | { kind: 'authenticator'; entryId: string };

  async function enterLogin(
    turn: TurnRef,
    ownerId: string,
    raw: CredentialInput,
    source: LoginSource,
    request?: RequestRow,
  ) {
    if (ownerId !== owner) throw new VaultError('This task belongs to another owner.', 409);
    await forgetExpiredHolds();
    const { input } = await inspectRequest(browserOf(turn), raw);
    const root = request?.root_turn_id ?? (await rootTurn(pool, turn, ownerId));
    if (!root) throw new VaultError('This task can no longer use credentials.', 409);
    const encryptionKey =
      input.kind === 'otp' && source.kind !== 'authenticator' ? undefined : await key();
    const use = {
      id: request?.id,
      ownerId,
      rootTurnId: root,
      origin: input.origin,
      kind: input.kind,
      itemId: undefined as string | undefined,
    };
    let selected: SelectionRow | undefined;
    let entryId: string | null = null;
    let secret = { username: '', password: '', code: undefined as string | undefined };
    let label: string | undefined;
    let heldPassword = '';
    let heldLabel = '';
    let authenticator = '';
    let savedOperation: 'create' | 'update' | undefined;
    const result = await uses.run(use, {
      prepare: async (client) => {
        if (request) {
          if (!(await lockRequest(client, request.token_hash)))
            throw new VaultError(
              'This request is expired, already used, or belongs to an earlier task step.',
              409,
            );
        }
        const active = request
          ? undefined
          : await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT');
        if (!request && !active) throw new VaultError('This task step is no longer active.', 409);
        selected = await selection(root, ownerId, input.origin, client);
        if (
          source.kind === 'saved' &&
          selected?.kind === 'password' &&
          selected.entry_id !== source.entryId
        )
          selected = undefined;
        if (
          source.kind === 'selection' &&
          (selected?.id !== source.selected.id || selected?.entry_id !== source.selected.entry_id)
        )
          throw new VaultError('This selected account changed.', 409);
        const staged =
          selected && encryptionKey && selected.expires_at.getTime() > Date.now()
            ? openCredential(encryptionKey, selected)
            : undefined;
        if (source.kind === 'email') {
          if (
            (source.selected
              ? selected?.id !== source.selected.id ||
                selected.expires_at.getTime() <= Date.now() ||
                selected.credential_entered_at?.getTime() !==
                  source.selected.credential_entered_at?.getTime()
              : selected !== undefined) ||
            !(await source.code.current(client))
          )
            throw new VaultError('This verification step changed.', 409);
          if (
            selected?.entry_id &&
            !(
              await client.query(
                'SELECT id FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
                [selected.entry_id, ownerId, input.origin],
              )
            ).rowCount
          )
            throw new VaultError('This saved login is no longer available.', 409);
          if (await automaticUse(client, root, input.origin, 'otp', null, source.since))
            return false;
          secret.code = source.code.code;
        } else if (source.kind === 'authenticator') {
          if (input.kind !== 'otp')
            throw new VaultError('An authenticator key can only enter a verification code.', 409);
          const row = (
            await client.query<EntryRow>(
              'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
              [source.entryId, ownerId, input.origin],
            )
          ).rows[0];
          if (!row) throw new VaultError('This saved login is no longer available.', 409);
          if (selected && selected.expires_at.getTime() <= Date.now())
            throw new VaultError('This sign-in took too long. Start it again.', 409);
          if (selected?.entry_id && selected.entry_id !== row.id)
            throw new VaultError(
              'Choose the saved login that matches the account already entered.',
              409,
            );
          authenticator = openCredential(encryptionKey!, row).authenticator ?? '';
          if (!authenticator)
            throw new VaultError('This saved login has no authenticator key.', 409);
          entryId = row.id;
          use.itemId = row.id;
          if (
            await automaticUse(
              client,
              root,
              input.origin,
              'otp',
              row.id,
              selected?.credential_entered_at?.getTime(),
            )
          )
            return false;
        } else if (source.kind === 'form') {
          const values = source.values;
          if (
            input.kind === 'password' &&
            !input.usernameSelector &&
            values.username &&
            staged &&
            values.username !== staged.username
          )
            throw new VaultError('This password step belongs to the login you already chose.', 409);
          secret = {
            username: values.username || staged?.username || '',
            password: values.password ?? '',
            code: values.code,
          };
          label = input.label;
          if ((input.kind === 'identifier' || input.usernameSelector) && !secret.username)
            throw new VaultError('Enter the email, phone number or username.');
          if (input.kind === 'password' && !secret.password)
            throw new VaultError('Enter the password.');
          if (input.kind === 'otp' && !secret.code)
            throw new VaultError('Enter the verification code.');
          if (input.kind === 'identifier') {
            heldPassword = secret.password;
            heldLabel = label;
          }
        } else {
          if (!['identifier', 'password'].includes(input.kind))
            throw new VaultError(
              'Choose a saved login or enter the current verification code.',
              409,
            );
          entryId = source.kind === 'saved' ? source.entryId : (selected?.entry_id ?? null);
          if (
            !request &&
            selected &&
            (selected.blocked || !staged || selected.entry_id !== entryId)
          )
            return false;
          if (entryId) {
            const row = (
              await client.query<EntryRow>(
                'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
                [entryId, ownerId, input.origin],
              )
            ).rows[0];
            if (!row) throw new VaultError('No saved password is available for this website.', 404);
            secret = { ...openCredential(encryptionKey!, row), code: undefined };
          } else {
            if (!staged || (input.kind === 'password' && !selected?.login_label))
              throw new VaultError('This saved sign-in step is no longer available.', 409);
            secret = { ...staged, code: undefined };
            label = selected?.login_label;
          }
          if (
            input.kind === 'password' &&
            selected &&
            (!staged || staged.username !== secret.username)
          )
            throw new VaultError(
              'Choose the saved login that matches the account already entered.',
              409,
            );
          if (input.kind === 'identifier' && !secret.username)
            throw new VaultError('This login has no username. Enter it in the form.', 409);
          if (input.kind === 'password' && !secret.password) {
            if (request) throw new VaultError('Enter the password in the secure form.', 409);
            await rememberSelection(client, {
              rootTurnId: root,
              ownerId,
              origin: input.origin,
              entryId,
              username: secret.username,
              expiresAt: selected?.expires_at ?? new Date(Date.now() + 10 * 60_000),
              blocked: false,
              enteredAt: selected?.credential_entered_at?.getTime(),
            });
            return false;
          }
          if (input.kind === 'identifier' && selected && !entryId) {
            heldPassword = secret.password;
            heldLabel = selected.login_label;
          }
          use.itemId = entryId ?? selected?.id;
          if (
            !request &&
            !(input.kind === 'identifier' && selected?.kind === 'identifier') &&
            (await automaticUse(client, root, input.origin, input.kind, use.itemId ?? null))
          )
            return false;
        }
        if (request)
          await client.query("UPDATE credential_requests SET status='consumed' WHERE id=$1", [
            request.id,
          ]);
        if (selected && input.kind !== 'otp')
          await client.query(
            'UPDATE credential_account_selections SET blocked=true,credential_entered_at=NULL,ciphertext=$2,login_label=$3 WHERE id=$1',
            [
              selected.id,
              input.kind === 'password'
                ? sealCredential(encryptionKey!, selected, {
                    username: staged?.username ?? secret.username,
                    password: '',
                  })
                : selected.ciphertext,
              input.kind === 'password' ? '' : selected.login_label,
            ],
          );
      },
      perform: async () => {
        await options.inject({
          ...input,
          threadId: browserOf(turn),
          ...(input.kind === 'otp'
            ? { code: authenticator ? authenticatorCode(authenticator) : secret.code }
            : input.kind === 'identifier'
              ? { username: secret.username }
              : {
                  username: input.usernameSelector ? secret.username : undefined,
                  password: secret.password,
                }),
        });
        return true;
      },
      complete: async (client) => {
        if (request) await lockKey(client, `thread:${owner}`);
        if (input.kind !== 'otp') {
          if (
            (source.kind === 'form' && (input.kind === 'password' || !heldPassword)) ||
            (source.kind === 'selection' && input.kind === 'password' && !entryId)
          ) {
            const saved = await saveEntry(
              ownerId,
              {
                label: label ?? input.label,
                origin: input.origin,
                username: secret.username,
                password: input.kind === 'password' ? secret.password : '',
              },
              client,
            );
            entryId = saved.entry.id;
            savedOperation = saved.operation;
          }
          await rememberSelection(client, {
            rootTurnId: root,
            ownerId,
            origin: input.origin,
            entryId,
            username: secret.username,
            password: heldPassword,
            loginLabel: heldLabel,
            expiresAt: selected?.expires_at ?? new Date(Date.now() + 10 * 60_000),
            blocked: source.kind === 'form' && input.kind === 'password',
            enteredAt: (
              await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
            ).rows[0]!.at.getTime(),
            kind: input.kind,
          });
          if (request && source.kind === 'form' && entryId)
            await client.query('UPDATE vault_uses SET item_id=$2 WHERE id=$1 AND owner_id=$3', [
              request.id,
              entryId,
              ownerId,
            ]);
        }
        if (request) {
          await options.onUse?.(
            {
              ...turn,
              origin: input.origin,
              ...(entryId ? { entryId } : {}),
              reason: source.kind === 'form' ? 'entered' : 'picked',
            },
            client,
          );
          if (
            (
              await client.query(
                `SELECT 1 FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND ${waitingTurnSql('u', 'credentials')}`,
                [request.turn_id, ownerId],
              )
            ).rowCount
          )
            await options.resume(request.turn_id, client);
        }
      },
    });
    if (savedOperation) track('login', savedOperation, 'user', input.origin);
    return result === true;
  }

  async function consume(token: string, source: LoginSource, hashed = false) {
    const row = (
      await pool.query<RequestRow>(
        'SELECT * FROM credential_requests WHERE token_hash=$1 AND owner_id=$2',
        [hashed ? token : tokenHash(token), owner],
      )
    ).rows[0];
    if (!row || row.status !== 'pending' || row.kind === 'method')
      throw new VaultError(
        'This request is expired, already used, or belongs to an earlier task step.',
        409,
      );
    try {
      await enterLogin(
        { threadId: row.thread_id, turnId: row.turn_id, browserId: row.browser_id ?? undefined },
        row.owner_id,
        requestInput.parse(row.selectors),
        source,
        row,
      );
      return { ok: true };
    } catch (error) {
      if (source.kind === 'saved' && error instanceof VaultError && error.statusCode === 404) {
        const fresh = await inspectRequest(
          row.browser_id ?? row.thread_id,
          requestInput.parse(row.selectors),
        );
        const id = randomUUID();
        const token = await requestToken(id);
        await uses.transaction(async (client) => {
          if (!(await lockRequest(client, row.token_hash)))
            throw new VaultError('This request is no longer open.', 409);
          const selected = await selection(row.root_turn_id, row.owner_id, row.origin, client);
          await rememberSelection(client, {
            rootTurnId: row.root_turn_id,
            ownerId: row.owner_id,
            origin: row.origin,
            entryId: null,
            username: (await stagedUsername(selected)) ?? '',
            expiresAt: new Date(Date.now() + 10 * 60_000),
            blocked: true,
          });
          await client.query("UPDATE credential_requests SET status='superseded' WHERE id=$1", [
            row.id,
          ]);
          await client.query(
            `INSERT INTO credential_requests(id,token_hash,thread_id,turn_id,root_turn_id,owner_id,origin,label,kind,selectors,inspection,browser_id,flow_id,flow_expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              id,
              tokenHash(token),
              row.thread_id,
              row.turn_id,
              row.root_turn_id,
              row.owner_id,
              row.origin,
              row.label,
              fresh.input.kind,
              storedSelectors(fresh.input),
              JSON.stringify(fresh.inspection),
              row.browser_id,
              row.flow_id,
              row.flow_expires_at,
            ],
          );
        });
        captureSecureEntry(options.analytics, row, 'superseded');
        captureSecureEntry(
          options.analytics,
          { kind: fresh.input.kind, origin: row.origin },
          'requested',
        );
        return {
          ok: false,
          retryUrl: `/vault/${token}`,
          error: 'That saved login is no longer available. Enter a new login.',
        };
      }
      await pool
        .query("UPDATE credential_requests SET failed_at=now() WHERE id=$1 AND status='pending'", [
          row.id,
        ])
        .then((failed) => {
          if (failed.rowCount) captureSecureEntry(options.analytics, row, 'failed');
        })
        .catch((failure: unknown) => logFailure('vault_failure_state', failure));
      throw error;
    } finally {
      options.refresh?.();
    }
  }

  async function selectMethod(token: string, raw: unknown) {
    const { methodId } = z
      .object({ methodId: z.string().min(1).max(200) })
      .strict()
      .parse(raw);
    const hash = tokenHash(token);
    const row = (
      await pool.query<RequestRow>(
        'SELECT * FROM credential_requests WHERE token_hash=$1 AND owner_id=$2',
        [hash, owner],
      )
    ).rows[0];
    if (
      !row ||
      row.kind !== 'method' ||
      !row.inspection.methods?.some((method) => method.id === methodId) ||
      !row.inspection.document ||
      !options.selectSignInMethod
    )
      throw new VaultError('This sign-in method is unavailable. Request a fresh step.', 409);
    try {
      await uses.run(
        {
          id: row.id,
          ownerId: owner,
          rootTurnId: row.root_turn_id,
          origin: row.origin,
          kind: 'method',
        },
        {
          prepare: async (client) => {
            const current = await lockRequest(client, hash);
            if (!current || current.id !== row.id)
              throw new VaultError('This sign-in request is expired or already used.', 409);
            await client.query("UPDATE credential_requests SET status='consumed' WHERE id=$1", [
              row.id,
            ]);
          },
          perform: () =>
            options.selectSignInMethod!(row.browser_id ?? row.thread_id, {
              origin: row.origin,
              document: row.inspection.document!,
              methodId,
            }),
          complete: async (client) => {
            await lockKey(client, `thread:${owner}`);
            if (
              (
                await client.query(
                  `SELECT 1 FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND ${waitingTurnSql('u', 'credentials')}`,
                  [row.turn_id, owner],
                )
              ).rowCount
            )
              await options.resume(row.turn_id, client);
          },
        },
      );
      return { ok: true };
    } finally {
      options.refresh?.();
    }
  }

  async function submit(token: string, raw: unknown, hashed = false) {
    return consume(token, { kind: 'form', values: submissionInput.parse(raw) }, hashed);
  }

  async function selectSaved(token: string, raw: unknown) {
    const { entryId } = z
      .object({ entryId: z.string().min(1).max(100) })
      .strict()
      .parse(raw);
    return consume(token, { kind: 'saved', entryId });
  }

  async function retry(token: string) {
    const row = await uses.transaction(async (client) => {
      const request = await lockRequest(
        client,
        tokenHash(token),
        "((r.status='consumed' AND EXISTS(SELECT 1 FROM vault_uses v WHERE v.id=r.id AND v.status='uncertain')) OR (r.status='pending' AND (r.failed_at IS NOT NULL OR (r.kind='method' AND r.flow_expires_at<=now()))))",
        true,
      );
      if (!request)
        throw new VaultError(
          'This request can no longer be retried. Return to the latest task step.',
          409,
        );
      await client.query(
        "UPDATE credential_requests r SET status='retried',flow_expires_at=now()+interval '30 minutes' WHERE turn_id=$1 AND owner_id=$2 AND (status='pending' OR (status='consumed' AND EXISTS(SELECT 1 FROM vault_uses v WHERE v.id=r.id AND v.owner_id=$2 AND v.status='uncertain')))",
        [request.turn_id, owner],
      );
      return request;
    });
    await options.retry(row.turn_id);
    return { ok: true };
  }

  async function fillSaved(turn: TurnRef, ownerId: string, entryId: string, raw: CredentialInput) {
    return enterLogin(turn, ownerId, raw, { kind: 'saved', entryId });
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
      'SELECT * FROM vault_entries WHERE owner_id=$1 AND origin=$2',
      [ownerId, origin],
    );
    if (!rows.length) return undefined;
    const credentialKey = await key();
    let candidates = rows.flatMap((entry) => {
      try {
        const { username, authenticator } = openCredential(credentialKey, entry);
        return authenticator ? [{ entry, username }] : [];
      } catch {
        return [];
      }
    });
    const selected = await selection(root, ownerId, origin);
    if (selected && selected.expires_at.getTime() <= Date.now()) return undefined;
    if (selected?.entry_id)
      candidates = candidates.filter(({ entry }) => entry.id === selected.entry_id);
    else if (selected) {
      const account = await stagedUsername(selected);
      candidates =
        account === undefined ? [] : candidates.filter(({ username }) => username === account);
    }
    if (savedLoginId !== undefined)
      candidates = candidates.filter(({ entry }) => entry.id === savedLoginId);
    return candidates.length === 1 ? metadata(candidates[0]!.entry) : undefined;
  }

  async function fillAuthenticatorCode(
    turn: TurnRef,
    ownerId: string,
    entryId: string,
    raw: CredentialInput,
  ) {
    if (raw.kind !== 'otp' || raw.emailCode) return false;
    return enterLogin(turn, ownerId, raw, { kind: 'authenticator', entryId });
  }

  async function fillSelected(turn: TurnRef, ownerId: string, raw: CredentialInput) {
    await forgetExpiredHolds();
    const root = await rootTurn(pool, turn, ownerId);
    const selected = root
      ? await selection(root, ownerId, credentialOrigin(raw.origin))
      : undefined;
    if (!selected || selected.kind === 'password') return undefined;
    if (!options.page || !['identifier', 'password'].includes(raw.kind)) return false;
    try {
      return await enterLogin(turn, ownerId, raw, { kind: 'selection', selected });
    } catch (error) {
      if (error instanceof VaultUseError && error.statusCode === 502) throw error;
      return false;
    }
  }

  async function fillEmailCode(turn: TurnRef, ownerId: string, raw: CredentialInput) {
    if (
      ownerId !== owner ||
      !options.page ||
      !options.emailCode ||
      raw.kind !== 'otp' ||
      raw.emailCode !== true
    )
      return false;
    try {
      await forgetExpiredHolds();
      const origin = credentialOrigin(raw.origin);
      const started = await currentTurn(pool, turn, ownerId);
      const root = started ? await rootTurn(pool, turn, ownerId) : undefined;
      if (!root) return false;
      const selected = await selection(root, ownerId, origin);
      if (selected && selected.expires_at.getTime() <= Date.now()) return false;
      const anchor = (selected?.credential_entered_at ?? started?.started_at)?.getTime();
      if (!anchor || anchor > Date.now()) return false;
      const since = Math.max(anchor, Date.now() - 5 * 60_000);
      if (await automaticUse(pool, root, origin, 'otp', null, since)) return false;
      const fresh = await inspectRequest(browserOf(turn), raw);
      const shown = fresh.input.emailRecipient?.toLowerCase();
      const username = verificationRecipient(
        shown ? (/[*•]/.test(shown) ? { recipientHint: shown } : { recipient: shown }) : {},
        selected ? normalizedEmail(openCredential(await key(), selected).username) : undefined,
      );
      if (!username) return false;
      const signal = AbortSignal.timeout(60_000);
      const code = await Promise.race([
        options
          .emailCode(
            { recipient: username, origin, after: since - 30_000, before: Date.now() },
            signal,
          )
          .catch(() => undefined),
        new Promise<undefined>((resolve) =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true }),
        ),
      ]);
      if (signal.aborted || !code || !/^\d{4,8}$/.test(code.code)) return false;
      return await enterLogin(turn, ownerId, fresh.input, {
        kind: 'email',
        code,
        selected,
        since,
      });
    } catch (error) {
      if (error instanceof VaultUseError && error.statusCode === 502) throw error;
      return false;
    }
  }

  async function submitChatCode(
    ownerId: string,
    turnId: string,
    text: string,
    requestId: string,
  ): Promise<{ status: 'submitted' | 'invalid' | 'unavailable' }> {
    if (ownerId !== owner) return { status: 'unavailable' };
    const code = text.trim();
    if (!/^\d{4,8}$/.test(code)) return { status: 'invalid' };
    try {
      const { rows } = await pool.query<{ token_hash: string }>(
        `SELECT r.token_hash FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
         WHERE r.id=$1 AND r.turn_id=$2 AND r.owner_id=$3 AND r.kind='otp' AND r.status='pending'
         AND ${waitingTurnSql('u', 'credentials')}`,
        [requestId, turnId, ownerId],
      );
      if (rows.length !== 1) return { status: 'unavailable' };
      await submit(rows[0].token_hash, { code }, true);
      return { status: 'submitted' };
    } catch {
      return { status: 'unavailable' };
    }
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
        for (const row of removed.rows) track(row.kind, 'delete', 'user', row.origin ?? undefined);
        return { ok: true };
      });
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id', async (request) =>
        describe(request.params.id),
      );
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id/flow', async (request) =>
        flow(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/method',
        async (request) => selectMethod(request.params.id, request.body),
      );
      scope.get<{ Params: { id: string } }>(
        '/api/credential-requests/:id/status',
        async (request) => {
          const { rows } = await pool.query<RequestStatusRow>(
            `SELECT r.status,v.status AS operation_status,r.status='pending' AND (r.kind<>'method' OR r.flow_expires_at>now()) AND EXISTS(
               SELECT 1 FROM turns u WHERE u.id=r.turn_id AND u.owner_id=r.owner_id
               AND ${waitingTurnSql('u', 'credentials')}) AS current_step
             FROM credential_requests r LEFT JOIN vault_uses v
               ON v.id=r.id AND v.owner_id=r.owner_id AND r.status='consumed'
             WHERE r.token_hash=$1 AND r.owner_id=$2`,
            [tokenHash(request.params.id), owner],
          );
          if (!rows[0]) throw new VaultError('Credential request not found.', 404);
          return { status: requestStatus(rows[0]) };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/retry',
        async (request) => retry(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/saved',
        async (request) => selectSaved(request.params.id, request.body),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/password-manager',
        async (request) => managedLogins(request.params.id, request.body),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/password-manager/use',
        async (request) => useManaged(request.params.id, request.body),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id',
        { bodyLimit: 16_384 },
        async (request) => submit(request.params.id, request.body),
      );
    });
  }

  return {
    uses,
    registerRoutes,
    saveLogin: (input: {
      origin: string;
      label: string;
      username: string;
      password: string;
      authenticatorKey?: string;
    }) => save(owner, passwordInput.parse(input)),
    request,
    list,
    readCredential,
    fillSaved,
    fillSelected,
    authenticatorLogin,
    fillAuthenticatorCode,
    fillEmailCode,
    submitChatCode,
    forgetExpiredHolds,
    paymentCards,
    paymentCard,
  };
}
