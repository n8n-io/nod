import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  CredentialRequest,
  VaultEntry,
  VaultEntryDetails,
  VaultEntryPassword,
  VaultLoginEntry,
  VaultListEntry,
  VaultCardEntry,
  VaultCardNumber,
  VaultCardSecurityCode,
} from '../shared/contracts.ts';
import type { BrowserPage, CredentialKind, CredentialSubmission } from '../ports/computer.ts';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SiteIcon } from '../ports/link-preview.ts';
import {
  normalizedEmail,
  verificationRecipient,
  type EmailCodeRequest,
  type PrivateEmailCode,
} from './email-code.ts';
import { ownerId as owner } from './config.ts';
import type { WorkAdmission } from './work-admission.ts';
import type { TurnRef } from './thread.ts';
const passwordInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    origin: z.string().max(2048),
    username: z.string().max(320),
    password: z.string().min(1).max(8192),
  })
  .strict();
const updateInput = z
  .object({
    kind: z.literal('login').optional(),
    label: z.string().trim().min(1).max(100),
    username: z.string().max(320),
    password: z.string().max(8192).optional(),
  })
  .strict();
const cardFields = {
  label: z.string().trim().min(1).max(100),
  cardholder: z.string().trim().min(1).max(200),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2000).max(9999),
};
const securityCodeInput = z
  .string()
  .trim()
  .regex(/^(?:\d{3,4})?$/);
const cardInput = z
  .object({
    kind: z.literal('card'),
    ...cardFields,
    cardNumber: z.string().max(40),
    securityCode: securityCodeInput.optional(),
  })
  .strict();
const cardUpdateInput = cardInput.extend({
  cardNumber: z.string().max(40).optional(),
  securityCode: securityCodeInput.nullable().optional(),
});
const cardSecret = z
  .object({
    cardholder: cardFields.cardholder,
    cardNumber: z.string().regex(/^\d{12,19}$/),
    expiryMonth: cardFields.expiryMonth,
    expiryYear: cardFields.expiryYear,
    securityCode: z
      .string()
      .regex(/^\d{3,4}$/)
      .optional(),
  })
  .strict();
type CardSecret = z.infer<typeof cardSecret>;
const submissionInput = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    username: z.string().max(320).optional(),
    password: z.string().min(1).max(8192).optional(),
    code: z.string().min(1).max(100).optional(),
  })
  .strict();
const requestInput = z
  .object({
    origin: z.string().max(2048),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['identifier', 'password', 'otp']),
    usernameSelector: z.string().min(1).max(2048).optional(),
    passwordSelector: z.string().min(1).max(2048).optional(),
    emailCode: z.boolean().optional(),
    emailRecipient: z.string().trim().min(3).max(320).optional(),
  })
  .strict();
type CredentialInput = z.infer<typeof requestInput>;
type StoredInspection = Required<Pick<CredentialRequest, 'fields' | 'methods'>> & {
  origin: string;
  url: string;
};
export type CredentialInjection = CredentialInput & {
  threadId: string;
  username?: string;
  password?: string;
  code?: string;
};
type VaultOptions = {
  admission?: WorkAdmission;
  resume(turnId: string): Promise<void>;
  retry(turnId: string): Promise<void>;
  inject(input: CredentialInjection): Promise<CredentialSubmission | void>;
  keyStore: CredentialKeyStore;
  page?(threadId: string): Promise<BrowserPage>;
  hold?(threadId: string, until: number | null): Promise<void>;
  emailCode?(input: EmailCodeRequest, signal: AbortSignal): Promise<PrivateEmailCode | undefined>;
  icon?(origin: string): Promise<SiteIcon | null>;
};
type EntryRow = {
  id: string;
  owner_id: string;
  label: string;
  origin: string;
  username_hint: string;
  identifier_label: string;
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
  turn_id: string;
  root_turn_id: string;
  owner_id: string;
  origin: string;
  label: string;
  kind: CredentialKind;
  status: 'pending' | 'filled' | 'superseded' | 'retried';
  selectors: CredentialInput;
  inspection: StoredInspection;
  expires_at: Date;
};
type SelectionRow = {
  id: string;
  root_turn_id: string;
  owner_id: string;
  origin: string;
  entry_id: string | null;
  identifier_label: string;
  login_label: string;
  ciphertext: string;
  blocked: boolean;
  expires_at: Date;
  credential_entered_at: Date | null;
};

export function waitingTurnSql(alias: string, reason?: 'credentials' | 'question') {
  return `${alias}.status='waiting'${reason ? ` AND ${alias}.waiting_reason='${reason}'` : ''}
    AND EXISTS(SELECT 1 FROM threads wt WHERE wt.id=${alias}.thread_id AND wt.owner_id=${alias}.owner_id AND wt.archived_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM turns wn WHERE wn.thread_id=${alias}.thread_id AND wn.id<>${alias}.id AND NOT wn.background AND wn.started_at>=${alias}.started_at)`;
}

class VaultError extends Error {
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
  const local = localHost(url.hostname);
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

function localHost(hostname: string) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

function savedCredentialOrigin(value: string) {
  const trimmed = value.trim();
  return credentialOrigin(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

function requireFullHost(raw: unknown) {
  const { origin } = z.object({ origin: z.string().max(2048) }).parse(raw);
  const { hostname } = new URL(savedCredentialOrigin(origin));
  if (!localHost(hostname) && !/[^.]\.[^.]/.test(hostname))
    throw new VaultError('Enter a full website domain, such as example.com.');
}

function binding(entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>) {
  return Buffer.from(JSON.stringify(['otto-vault-v1', entry.owner_id, entry.origin, entry.id]));
}

export function sealCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin'>,
  secret: { username: string; password: string },
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(binding(entry));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ username: secret.username, password: secret.password }), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openCredential(
  key: Buffer,
  entry: Pick<EntryRow, 'id' | 'owner_id' | 'origin' | 'ciphertext'>,
) {
  const data = Buffer.from(entry.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(binding(entry));
  decipher.setAuthTag(data.subarray(12, 28));
  return z
    .object({ username: z.string().max(320), password: z.string().max(8192) })
    .strict()
    .parse(
      JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
}

function safeIdentifierLabel(value: string | undefined) {
  return value
    ?.replace(/[\p{Cc}\p{Cf}<>]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
    .trim();
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
    identifierLabel:
      safeIdentifierLabel(entry.identifier_label) || inferredIdentifierLabel(username ?? ''),
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
  return Buffer.from(JSON.stringify(['otto-vault-card-v1', entry.owner_id, entry.id]));
}

function sealCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id'>, secret: CardSecret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(cardBinding(entry));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function openCard(key: Buffer, entry: Pick<CardRow, 'id' | 'owner_id' | 'ciphertext'>) {
  try {
    const data = Buffer.from(entry.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(cardBinding(entry));
    decipher.setAuthTag(data.subarray(12, 28));
    return cardSecret.parse(
      JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
      ),
    );
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

export async function createVault(pool: Pool, options: VaultOptions) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_entries (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, origin text NOT NULL,
      username_hint text NOT NULL, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      identifier_label text NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS vault_cards (
      id text PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL,
      brand text NOT NULL, last4 text NOT NULL, expiry_month integer NOT NULL, expiry_year integer NOT NULL,
      ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS vault_cards_owner ON vault_cards(owner_id);
    CREATE TABLE IF NOT EXISTS credential_requests (
      id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, owner_id text NOT NULL,
      thread_id uuid NOT NULL REFERENCES threads(id), turn_id uuid NOT NULL REFERENCES turns(id), root_turn_id uuid NOT NULL REFERENCES turns(id),
      origin text NOT NULL, label text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      selectors jsonb NOT NULL, inspection jsonb NOT NULL, expires_at timestamptz NOT NULL,
      resume_pending boolean NOT NULL DEFAULT false, failed_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS credential_autofill_attempts (
      root_turn_id uuid NOT NULL REFERENCES turns(id), owner_id text NOT NULL, origin text NOT NULL, entry_id text NOT NULL,
      kind text NOT NULL DEFAULT 'password', attempted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(root_turn_id,owner_id,origin,kind)
    );
    CREATE TABLE IF NOT EXISTS credential_account_selections (
      id text NOT NULL, root_turn_id uuid NOT NULL REFERENCES turns(id), owner_id text NOT NULL, origin text NOT NULL,
      entry_id text, ciphertext text NOT NULL, blocked boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL,
      identifier_label text NOT NULL DEFAULT '', login_label text NOT NULL DEFAULT '', credential_entered_at timestamptz,
      PRIMARY KEY(root_turn_id,owner_id,origin)
    );
    CREATE INDEX IF NOT EXISTS credential_requests_turn ON credential_requests(turn_id);
    CREATE INDEX IF NOT EXISTS credential_requests_root_turn ON credential_requests(root_turn_id,owner_id,origin,kind);
    CREATE INDEX IF NOT EXISTS vault_entries_owner ON vault_entries(owner_id);
  `);
  const identifiers = new Map<
    string,
    { value: string; identifierLabel: string; expiresAt: number }
  >();
  const identifierKey = (rootTurnId: string, ownerId: string, origin: string) =>
    JSON.stringify([rootTurnId, ownerId, origin]);
  let keyPromise: Promise<Buffer> | undefined;
  const key = () => {
    keyPromise ??= options.keyStore
      .getKey()
      .then((value) => {
        if (!Buffer.isBuffer(value) || value.length !== 32)
          throw new Error('Invalid credential key.');
        return value;
      })
      .catch(() => {
        keyPromise = undefined;
        throw new VaultError(
          'The credential key is unavailable. Check the configured key store.',
          503,
        );
      });
    return keyPromise;
  };
  let closed = false;
  let resuming: Promise<void> | undefined;
  function resumePending() {
    if (closed) return Promise.resolve();
    resuming ??= Promise.resolve()
      .then(async () => {
        if (closed) return;
        await pool.query(`UPDATE credential_account_selections SET ciphertext='',blocked=true,login_label=''
        WHERE login_label<>'' AND expires_at<=now()`);
        await pool.query(`UPDATE credential_requests r SET resume_pending=false WHERE r.resume_pending=true
        AND NOT EXISTS(SELECT 1 FROM turns u WHERE u.id=r.turn_id AND u.owner_id=r.owner_id AND ${waitingTurnSql('u', 'credentials')})`);
        const { rows } =
          await pool.query<RequestRow>(`SELECT r.* FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
        WHERE r.resume_pending=true AND ${waitingTurnSql('u', 'credentials')}`);
        for (const row of rows) {
          if (closed) break;
          try {
            await options.resume(row.turn_id);
            await pool.query(
              'UPDATE credential_requests SET resume_pending = false WHERE id = $1',
              [row.id],
            );
          } catch {}
        }
      })
      .finally(() => {
        resuming = undefined;
      });
    return resuming;
  }
  const timer = setInterval(() => {
    for (const [id, value] of identifiers)
      if (value.expiresAt <= Date.now()) identifiers.delete(id);
    void (options.admission ? options.admission.run(resumePending) : resumePending())?.catch(
      () => {},
    );
  }, 5000);
  timer.unref();

  async function list(ownerId = owner) {
    const { rows } = await pool.query<EntryRow>(
      'SELECT * FROM vault_entries WHERE owner_id = $1 ORDER BY updated_at DESC',
      [ownerId],
    );
    return rows.map((entry) => metadata(entry));
  }

  async function removeLogin(id: string) {
    const result = await pool.query('DELETE FROM vault_entries WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(id),
      owner,
    ]);
    if (!result.rowCount) throw new VaultError('This saved login could not be found.', 404);
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
          throw new VaultError('A saved login could not be opened.', 500);
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

  async function save(
    ownerId: string,
    raw: unknown,
    database: Pick<PoolClient, 'query'> = pool,
    identifierLabel?: string,
  ) {
    const input = passwordInput.parse(raw);
    const entry = {
      id: randomUUID(),
      owner_id: ownerId,
      origin: savedCredentialOrigin(input.origin),
    };
    const ciphertext = sealCredential(await key(), entry, input);
    const hint = input.username ? `${input.username.slice(0, 2)}…` : '';
    const { rows } = await database.query<EntryRow>(
      'INSERT INTO vault_entries (id, owner_id, label, origin, username_hint, ciphertext, identifier_label) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        entry.id,
        ownerId,
        input.label,
        entry.origin,
        hint,
        ciphertext,
        safeIdentifierLabel(identifierLabel) || inferredIdentifierLabel(input.username),
      ],
    );
    return metadata(rows[0]);
  }

  async function update(rawId: string, raw: unknown) {
    const id = z.uuid().parse(rawId);
    const input = updateInput.parse(raw);
    await ownedEntry(id);
    const credentialKey = await key();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
      const ciphertext = sealCredential(credentialKey, entry, {
        username: input.username,
        password: input.password || secret.password,
      });
      const result = await client.query<EntryRow>(
        'UPDATE vault_entries SET label=$3,username_hint=$4,ciphertext=$5,identifier_label=$6,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',
        [
          id,
          owner,
          input.label,
          input.username ? `${input.username.slice(0, 2)}…` : '',
          ciphertext,
          safeIdentifierLabel(entry.identifier_label) || inferredIdentifierLabel(secret.username),
        ],
      );
      await client.query('COMMIT');
      return metadata(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function ownedCard(id: string) {
    const { rows } = await pool.query<CardRow>(
      'SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2',
      [id, owner],
    );
    if (!rows[0]) throw new VaultError('This saved card could not be found.', 404);
    return rows[0];
  }

  async function readCard(rawId: string) {
    const id = z.uuid().parse(rawId);
    await ownedCard(id);
    const credentialKey = await key();
    const entry = await ownedCard(id);
    return { entry, secret: openCard(credentialKey, entry) };
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
      securityCode: input.securityCode || undefined,
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<CardRow>(
        'SELECT * FROM vault_cards WHERE id=$1 AND owner_id=$2 FOR UPDATE',
        [id, owner],
      );
      const entry = rows[0];
      if (!entry) throw new VaultError('This saved card could not be found.', 404);
      const secret = openCard(credentialKey, entry);
      const number = replacement ?? secret.cardNumber;
      const ciphertext = sealCard(credentialKey, entry, {
        cardholder: input.cardholder,
        cardNumber: number,
        expiryMonth: input.expiryMonth,
        expiryYear: input.expiryYear,
        securityCode:
          input.securityCode === null ? undefined : input.securityCode || secret.securityCode,
      });
      const result = await client.query<CardRow>(
        'UPDATE vault_cards SET label=$3,brand=$4,last4=$5,expiry_month=$6,expiry_year=$7,ciphertext=$8,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING *',
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
      await client.query('COMMIT');
      return cardMetadata(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    const link = `COALESCE(CASE WHEN u.source='resume' THEN substring(u.source_id from '^(?:credentials|credentials-retry|connection|control):([0-9a-f-]{36})(?::|$)')::uuid END,
      (SELECT a.turn_id FROM approvals a WHERE a.execution_turn_id=u.id AND a.owner_id=u.owner_id AND a.turn_id<>u.id LIMIT 1))`;
    const { rows } = await database.query<{ id: string }>(
      `WITH RECURSIVE chain(id,next,thread_id) AS (
         SELECT u.id,${link},u.thread_id FROM turns u WHERE u.id=$1 AND u.owner_id=$2 AND u.thread_id=$3
         UNION
         SELECT u.id,${link},u.thread_id FROM chain c
         JOIN turns u ON u.id=c.next AND u.owner_id=$2 AND u.thread_id=c.thread_id
       ) SELECT c.id FROM chain c WHERE NOT EXISTS (SELECT 1 FROM chain p WHERE p.id=c.next) LIMIT 1`,
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
      identifierLabel?: string;
      expiresAt: Date;
      blocked: boolean;
      enteredAt?: number;
    },
  ) {
    const entry = { id: randomUUID(), owner_id: value.ownerId, origin: value.origin };
    const ciphertext = sealCredential(await key(), entry, {
      username: value.username,
      password: value.password ?? '',
    });
    await database.query(
      `INSERT INTO credential_account_selections(id,root_turn_id,owner_id,origin,entry_id,ciphertext,blocked,expires_at,identifier_label,login_label,credential_entered_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(root_turn_id,owner_id,origin) DO UPDATE
       SET id=excluded.id,entry_id=excluded.entry_id,ciphertext=excluded.ciphertext,blocked=excluded.blocked,expires_at=excluded.expires_at,identifier_label=excluded.identifier_label,login_label=excluded.login_label,credential_entered_at=excluded.credential_entered_at`,
      [
        entry.id,
        value.rootTurnId,
        value.ownerId,
        value.origin,
        value.entryId,
        ciphertext,
        value.blocked,
        value.expiresAt,
        safeIdentifierLabel(value.identifierLabel) || inferredIdentifierLabel(value.username),
        value.loginLabel ?? '',
        value.enteredAt === undefined ? null : new Date(value.enteredAt),
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
    if (usernameSelector === target)
      throw new VaultError('Choose different fields for the username and password.', 409);
    const resolved: CredentialInput = {
      origin,
      label: input.label,
      kind,
      ...(kind === 'identifier'
        ? { usernameSelector: target }
        : { passwordSelector: target, ...(usernameSelector ? { usernameSelector } : {}) }),
      ...(kind === 'otp' && input.emailCode !== undefined ? { emailCode: input.emailCode } : {}),
      ...(kind === 'otp' && input.emailRecipient ? { emailRecipient: input.emailRecipient } : {}),
    };
    const inspection: StoredInspection = {
      origin,
      url: page?.url ?? origin,
      fields: [
        ...(usernameSelector
          ? [
              {
                kind: 'identifier' as const,
                selector: usernameSelector,
                label: 'Email, phone or username',
              },
            ]
          : []),
        {
          kind,
          selector: target,
          label:
            kind === 'identifier'
              ? 'Email, phone or username'
              : kind === 'otp'
                ? 'Verification code'
                : 'Password',
        },
      ],
      methods: [{ id: 'credentials', kind: 'credentials', label: 'Secure entry', supported: true }],
    };
    return { input: resolved, inspection };
  }

  async function request(
    turn: TurnRef,
    ownerId: string,
    raw: CredentialInput,
  ): Promise<{ url: string }> {
    if (!(await currentTurn(pool, turn, ownerId)))
      throw new VaultError('This task can no longer request credentials.', 409);
    const { input, inspection } = await inspectRequest(turn.threadId, raw);
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + 10 * 60_000;
    await options.hold?.(turn.threadId, expiresAt);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `thread:${ownerId}`,
      ]);
      if (!(await currentTurn(client, turn, ownerId, ' FOR NO KEY UPDATE OF u')))
        throw new VaultError('This task can no longer request credentials.', 409);
      const root = await rootTurn(client, turn, ownerId);
      if (!root) throw new VaultError('This task can no longer request credentials.', 409);
      await client.query(
        "UPDATE credential_requests SET status='superseded' WHERE thread_id=$1 AND owner_id=$2 AND status='pending'",
        [turn.threadId, ownerId],
      );
      await client.query(
        `INSERT INTO credential_requests (id,token_hash,thread_id,turn_id,root_turn_id,owner_id,origin,label,kind,selectors,expires_at,inspection)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          hash,
          turn.threadId,
          turn.turnId,
          root,
          ownerId,
          input.origin,
          input.label,
          input.kind,
          storedSelectors(input),
          new Date(expiresAt),
          JSON.stringify(inspection),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { url: `/vault/${token}` };
  }

  function tokenHash(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new VaultError('Credential request not found.', 404);
    return createHash('sha256').update(token).digest('hex');
  }

  async function lockRequest(
    client: PoolClient,
    hash: string,
    condition = "r.status='pending' AND r.expires_at>now()",
  ) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread:${owner}`]);
    const { rows } = await client.query<RequestRow>(
      `SELECT r.* FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
       WHERE r.token_hash=$1 AND r.owner_id=$2 AND ${condition} AND ${waitingTurnSql('u', 'credentials')}
       FOR UPDATE OF r`,
      [hash, owner],
    );
    return rows[0];
  }

  async function describe(token: string): Promise<CredentialRequest> {
    const { rows } = await pool.query<RequestRow & { current_step: boolean; expired: boolean }>(
      `SELECT r.*,r.expires_at<=now() AS expired,EXISTS(SELECT 1 FROM turns u WHERE u.id=r.turn_id AND u.owner_id=r.owner_id
        AND ${waitingTurnSql('u', 'credentials')}) AS current_step FROM credential_requests r WHERE token_hash=$1 AND owner_id=$2`,
      [tokenHash(token), owner],
    );
    const row = rows[0];
    if (!row) throw new VaultError('Credential request not found.', 404);
    const pending = row.status === 'pending' && row.current_step && !row.expired;
    let savedEntries: VaultLoginEntry[] | undefined;
    let selectedEntryId: string | undefined;
    if (pending && row.kind !== 'otp') {
      const selected = await selection(row.root_turn_id, row.owner_id, row.origin);
      const username = await stagedUsername(selected);
      const entries = await pool.query<EntryRow>(
        `SELECT e.* FROM vault_entries e WHERE e.owner_id=$1 AND e.origin=$2
         AND NOT EXISTS(SELECT 1 FROM credential_autofill_attempts a WHERE a.root_turn_id=$3 AND a.owner_id=e.owner_id AND a.origin=e.origin AND a.kind=$4 AND a.entry_id=e.id)
         ORDER BY e.updated_at DESC`,
        [row.owner_id, row.origin, row.root_turn_id, row.kind],
      );
      const matches =
        row.kind === 'password' && selected && username === undefined ? [] : entries.rows;
      savedEntries = [];
      for (const entry of matches) {
        if (
          row.kind === 'password' &&
          username !== undefined &&
          openCredential(await key(), entry).username !== username
        )
          continue;
        savedEntries.push(metadata(entry));
      }
      if (
        selected &&
        !selected.blocked &&
        savedEntries.some((entry) => entry.id === selected.entry_id)
      )
        selectedEntryId = selected.entry_id ?? undefined;
    }
    return {
      id: token,
      turnId: row.turn_id,
      origin: row.origin,
      label: row.label,
      kind: row.kind,
      fields: row.inspection.fields,
      methods: row.inspection.methods,
      status: row.status === 'filled' ? 'filled' : pending ? 'pending' : 'expired',
      expiresAt: new Date(row.expires_at).toISOString(),
      ...(savedEntries ? { savedEntries } : {}),
      ...(selectedEntryId ? { selectedEntryId } : {}),
    };
  }

  async function refreshRequest(token: string): Promise<CredentialRequest> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await lockRequest(client, tokenHash(token));
      if (!row)
        throw new VaultError('This Vault link has expired. Return to chat for a new link.', 409);
      const fresh = await inspectRequest(row.thread_id, row.selectors);
      await client.query(
        'UPDATE credential_requests SET kind=$2,selectors=$3,inspection=$4 WHERE id=$1',
        [row.id, fresh.input.kind, storedSelectors(fresh.input), JSON.stringify(fresh.inspection)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        'The sign-in page could not be checked. Try again or return to chat.',
        409,
      );
    } finally {
      client.release();
    }
    return describe(token);
  }

  async function consume(
    token: string,
    operation: (
      row: RequestRow,
      client: PoolClient,
    ) => Promise<{ retry: Awaited<ReturnType<typeof inspectRequest>>; error?: string } | void>,
    hashed = false,
  ) {
    const client = await pool.connect();
    let submittedId: string | undefined;
    let retryUrl: string | undefined;
    let retryError: string | undefined;
    const hash = hashed ? token : tokenHash(token);
    try {
      await client.query('BEGIN');
      const row = await lockRequest(client, hash);
      if (!row)
        throw new VaultError(
          'This request is expired, already used, or belongs to an earlier task step.',
          409,
        );
      submittedId = row.id;
      const result = await operation(row, client);
      await client.query(
        "UPDATE credential_requests SET status='filled',resume_pending=$2 WHERE id=$1",
        [row.id, !result?.retry],
      );
      if (result?.retry) {
        retryError = result.error;
        const freshToken = randomBytes(32).toString('base64url');
        const { input, inspection } = result.retry;
        await client.query(
          `INSERT INTO credential_requests(id,token_hash,thread_id,turn_id,root_turn_id,owner_id,origin,label,kind,selectors,expires_at,inspection)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            randomUUID(),
            createHash('sha256').update(freshToken).digest('hex'),
            row.thread_id,
            row.turn_id,
            row.root_turn_id,
            row.owner_id,
            row.origin,
            row.label,
            input.kind,
            storedSelectors(input),
            row.expires_at,
            JSON.stringify(inspection),
          ],
        );
        retryUrl = `/vault/${freshToken}`;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (submittedId)
        await client.query(
          "UPDATE credential_requests SET failed_at=now() WHERE id=$1 AND status='pending'",
          [submittedId],
        );
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        'Credential entry failed. Check the website and complete this form again.',
        502,
      );
    } finally {
      client.release();
    }
    if (retryUrl)
      return {
        ok: false,
        retryUrl,
        error: retryError ?? 'Those sign-in details were not accepted. Please try again.',
      };
    await resumePending();
    return { ok: true };
  }

  async function submit(token: string, raw: unknown, hashed = false) {
    const values = submissionInput.parse(raw);
    return consume(
      token,
      async (row, client) => {
        const { input, inspection } = await inspectRequest(row.thread_id, row.selectors);
        if (input.kind !== row.kind)
          throw new VaultError('The login step changed. Request a fresh secure form.', 409);
        const savedIdentifier = identifiers.get(
          identifierKey(row.root_turn_id, row.owner_id, row.origin),
        );
        const selected = await selection(row.root_turn_id, row.owner_id, row.origin, client);
        const staged = await stagedUsername(selected);
        if (
          row.kind === 'password' &&
          !input.usernameSelector &&
          values.username &&
          staged !== undefined &&
          values.username !== staged
        )
          throw new VaultError('This password step belongs to the login you already chose.', 409);
        const username =
          values.username ||
          staged ||
          (savedIdentifier && savedIdentifier.expiresAt > Date.now() ? savedIdentifier.value : '');
        const identifierLabel =
          (staged !== undefined && safeIdentifierLabel(selected?.identifier_label)) ||
          (savedIdentifier &&
            savedIdentifier.expiresAt > Date.now() &&
            savedIdentifier.identifierLabel) ||
          inferredIdentifierLabel(username);
        if (row.kind === 'identifier' && !username)
          throw new VaultError('Enter the email, phone number or username.');
        if (row.kind === 'password' && !values.password)
          throw new VaultError('Enter the password.');
        if (row.kind === 'password' && !values.label)
          throw new VaultError('Give this login a name.');
        if (row.kind === 'identifier' && values.password && !values.label)
          throw new VaultError('Give this login a name.');
        if (row.kind === 'password' && input.usernameSelector && !username)
          throw new VaultError('Enter the email, phone number or username.');
        if (row.kind === 'otp' && !values.code)
          throw new VaultError('Enter the verification code.');
        if (row.kind === 'password' || (row.kind === 'identifier' && values.password)) await key();
        const submission = await options.inject({
          ...input,
          threadId: row.thread_id,
          ...(row.kind === 'otp'
            ? { code: values.code }
            : row.kind === 'identifier'
              ? { username }
              : {
                  username: input.usernameSelector ? username : undefined,
                  password: values.password,
                }),
        });
        if (row.kind !== 'otp')
          await rememberSelection(client, {
            rootTurnId: row.root_turn_id,
            ownerId: row.owner_id,
            origin: row.origin,
            entryId: null,
            username,
            ...(row.kind === 'identifier' && values.password && submission?.status !== 'rejected'
              ? { password: values.password, loginLabel: values.label }
              : {}),
            identifierLabel,
            expiresAt: row.expires_at,
            blocked:
              row.kind !== 'identifier' || !values.password || submission?.status === 'rejected',
            enteredAt: submission?.status === 'rejected' ? undefined : Date.now(),
          });
        if (submission?.status === 'rejected')
          return { retry: await inspectRequest(row.thread_id, row.selectors) };
        if (row.kind === 'identifier' && values.password)
          await client.query(
            "DELETE FROM credential_autofill_attempts WHERE root_turn_id=$1 AND owner_id=$2 AND origin=$3 AND kind='password'",
            [row.root_turn_id, row.owner_id, row.origin],
          );
        if (row.kind === 'identifier')
          identifiers.set(identifierKey(row.root_turn_id, row.owner_id, row.origin), {
            value: username,
            identifierLabel,
            expiresAt: Date.now() + 10 * 60_000,
          });
        if (row.kind === 'password') {
          await save(
            row.owner_id,
            { label: values.label, origin: row.origin, username, password: values.password },
            client,
            identifierLabel,
          );
        }
      },
      hashed,
    );
  }

  async function selectSaved(token: string, raw: unknown) {
    const { entryId } = z
      .object({ entryId: z.string().min(1).max(100) })
      .strict()
      .parse(raw);
    return consume(token, async (row, client) => {
      if (row.kind === 'otp') throw new VaultError('Enter the current verification code.', 409);
      const fresh = await inspectRequest(row.thread_id, row.selectors);
      if (fresh.input.kind !== row.kind)
        throw new VaultError('The login step changed. Request a fresh secure form.', 409);
      const selected = await selection(row.root_turn_id, row.owner_id, row.origin, client);
      const staged = await stagedUsername(selected);
      const entries = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
        [entryId, row.owner_id, row.origin],
      );
      const entry = entries.rows[0];
      if (!entry) {
        await rememberSelection(client, {
          rootTurnId: row.root_turn_id,
          ownerId: row.owner_id,
          origin: row.origin,
          entryId: null,
          username: staged ?? '',
          identifierLabel: staged !== undefined ? selected?.identifier_label : undefined,
          expiresAt: row.expires_at,
          blocked: true,
        });
        return {
          retry: fresh,
          error: 'That saved login is no longer available. Enter a new login.',
        };
      }
      const secret = openCredential(await key(), entry);
      if (
        row.kind === 'password' &&
        selected &&
        (staged === undefined || staged !== secret.username)
      )
        throw new VaultError(
          'Choose the saved login that matches the account already entered.',
          409,
        );
      if (row.kind === 'identifier' && !secret.username)
        throw new VaultError('This login has no username. Enter it in the form.', 409);
      await client.query(
        `INSERT INTO credential_autofill_attempts(root_turn_id,owner_id,origin,entry_id,kind) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(root_turn_id,owner_id,origin,kind) DO UPDATE SET entry_id=excluded.entry_id,attempted_at=now()`,
        [row.root_turn_id, row.owner_id, row.origin, entry.id, row.kind],
      );
      const submission = await options.inject({
        ...fresh.input,
        threadId: row.thread_id,
        username:
          row.kind === 'identifier' || fresh.input.usernameSelector ? secret.username : undefined,
        password: row.kind === 'password' ? secret.password : undefined,
      });
      await rememberSelection(client, {
        rootTurnId: row.root_turn_id,
        ownerId: row.owner_id,
        origin: row.origin,
        entryId: entry.id,
        username: secret.username,
        identifierLabel:
          (staged !== undefined && selected?.identifier_label) ||
          entry.identifier_label ||
          inferredIdentifierLabel(secret.username),
        expiresAt: row.expires_at,
        blocked: submission?.status === 'rejected',
        enteredAt: submission?.status === 'rejected' ? undefined : Date.now(),
      });
      if (submission?.status === 'rejected')
        return { retry: await inspectRequest(row.thread_id, row.selectors) };
    });
  }

  async function retry(token: string) {
    const client = await pool.connect();
    let row: RequestRow;
    try {
      await client.query('BEGIN');
      row = await lockRequest(
        client,
        tokenHash(token),
        "r.status='pending' AND (r.expires_at<=now() OR r.failed_at IS NOT NULL)",
      );
      if (!row)
        throw new VaultError(
          'This request can no longer be retried. Return to the latest task step.',
          409,
        );
      await client.query(
        `INSERT INTO credential_autofill_attempts(root_turn_id,owner_id,origin,entry_id,kind) VALUES($1,$2,$3,'manual-retry',$4) ON CONFLICT DO NOTHING`,
        [row.root_turn_id, row.owner_id, row.origin, row.kind],
      );
      await client.query(
        "UPDATE credential_requests SET status='retried',expires_at=least(expires_at,now()) WHERE turn_id=$1 AND owner_id=$2 AND status='pending'",
        [row.turn_id, owner],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof VaultError) throw error;
      throw new VaultError('The credential step could not restart. Try again.', 503);
    } finally {
      client.release();
    }
    try {
      await options.retry(row.turn_id);
    } catch (error) {
      throw new VaultError(
        'The credential step could not restart. Return to chat and try again.',
        (error as { statusCode?: number }).statusCode === 409 ? 409 : 503,
      );
    }
    return { ok: true };
  }

  async function fillSaved(turn: TurnRef, ownerId: string, id: string, raw: CredentialInput) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const root = (await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT'))
        ? await rootTurn(client, turn, ownerId)
        : undefined;
      if (!root) throw new VaultError('This task can no longer use saved credentials.', 409);
      const { input, inspection } = await inspectRequest(turn.threadId, raw);
      const origin = input.origin;
      const { rows } = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3',
        [id, ownerId, origin],
      );
      if (!rows[0] || !['identifier', 'password'].includes(input.kind))
        throw new VaultError('No saved password is available for this website.', 404);
      const attempt = await client.query(
        `INSERT INTO credential_autofill_attempts(root_turn_id,owner_id,origin,entry_id,kind)
         SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM credential_requests WHERE root_turn_id=$1 AND owner_id=$2 AND origin=$3 AND kind=$5 AND status='filled')
         ON CONFLICT DO NOTHING RETURNING root_turn_id`,
        [root, ownerId, origin, id, input.kind],
      );
      if (!attempt.rowCount)
        throw new VaultError('Enter fresh credentials to retry this website.', 409);
      await client.query('COMMIT');
      const encryptionKey = await key();
      await client.query('BEGIN');
      if (!(await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT')))
        throw new VaultError('This task step is no longer active.', 409);
      const entries = await client.query<EntryRow>(
        'SELECT * FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
        [id, ownerId, origin],
      );
      if (!entries.rows[0]) throw new VaultError('This saved login is no longer available.', 409);
      const secret = openCredential(encryptionKey, entries.rows[0]);
      if (input.kind === 'identifier' && !secret.username)
        throw new VaultError('Enter a username in the secure form.', 409);
      const selected = await selection(root, ownerId, origin, client);
      const staged = await stagedUsername(selected);
      if (selected && (selected.blocked || selected.entry_id !== id || staged === undefined))
        throw new VaultError('Enter fresh credentials to retry this website.', 409);
      if (
        input.kind === 'password' &&
        selected &&
        (staged === undefined || staged !== secret.username)
      )
        throw new VaultError(
          'Choose the saved login that matches the account already entered.',
          409,
        );
      const submission = await options.inject({
        ...input,
        threadId: turn.threadId,
        origin,
        username:
          input.kind === 'identifier' || input.usernameSelector ? secret.username : undefined,
        password: input.kind === 'password' ? secret.password : undefined,
      });
      const identifierLabel =
        (staged !== undefined && selected?.identifier_label) ||
        entries.rows[0].identifier_label ||
        inferredIdentifierLabel(secret.username);
      await rememberSelection(client, {
        rootTurnId: root,
        ownerId,
        origin,
        entryId: id,
        username: secret.username,
        identifierLabel,
        expiresAt:
          selected && staged !== undefined
            ? selected.expires_at
            : new Date(Date.now() + 10 * 60_000),
        blocked: submission?.status === 'rejected',
        enteredAt: submission?.status === 'rejected' ? undefined : Date.now(),
      });
      await client.query('COMMIT');
      if (submission?.status === 'rejected')
        throw new VaultError(
          'The saved details were not accepted. Enter fresh details in Vault.',
          409,
        );
      if (input.kind === 'identifier')
        identifiers.set(identifierKey(root, ownerId, origin), {
          value: secret.username,
          identifierLabel,
          expiresAt: Date.now() + 10 * 60_000,
        });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function fillStagedPassword(turn: TurnRef, ownerId: string, raw: CredentialInput) {
    if (!options.page) return false;
    const origin = credentialOrigin(raw.origin);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const root = (await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT'))
        ? await rootTurn(client, turn, ownerId)
        : undefined;
      const selected = root ? await selection(root, ownerId, origin, client) : undefined;
      if (
        !root ||
        !selected ||
        selected.entry_id ||
        selected.blocked ||
        !selected.login_label ||
        new Date(selected.expires_at).getTime() <= Date.now()
      )
        throw new VaultError('This saved sign-in step is no longer available.', 409);
      const fresh = await inspectRequest(turn.threadId, raw);
      if (fresh.input.kind !== 'password')
        throw new VaultError('The password step is not ready.', 409);
      const encryptionKey = await key();
      const secret = openCredential(encryptionKey, selected);
      if (!secret.password) throw new VaultError('Enter the password in Vault.', 409);
      const attempt = await client.query(
        `INSERT INTO credential_autofill_attempts(root_turn_id,owner_id,origin,entry_id,kind)
         VALUES($1,$2,$3,$4,'password') ON CONFLICT DO NOTHING RETURNING root_turn_id`,
        [root, ownerId, origin, selected.id],
      );
      if (!attempt.rowCount) throw new VaultError('Enter fresh details in Vault.', 409);
      await client.query(
        "UPDATE credential_account_selections SET ciphertext=$4,blocked=true,login_label='' WHERE root_turn_id=$1 AND owner_id=$2 AND origin=$3 AND id=$5",
        [
          root,
          ownerId,
          origin,
          sealCredential(encryptionKey, selected, { username: secret.username, password: '' }),
          selected.id,
        ],
      );
      await client.query('COMMIT');
      await client.query('BEGIN');
      const current = await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT');
      const retained = await selection(root, ownerId, origin, client);
      if (
        !current ||
        !retained ||
        retained.id !== selected.id ||
        !retained.blocked ||
        new Date(retained.expires_at).getTime() <= Date.now()
      )
        throw new VaultError('This task step is no longer active.', 409);
      const verified = await inspectRequest(turn.threadId, fresh.input);
      if (verified.input.kind !== 'password')
        throw new VaultError('The password step changed.', 409);
      const submission = await options.inject({
        ...verified.input,
        threadId: turn.threadId,
        username: verified.input.usernameSelector ? secret.username : undefined,
        password: secret.password,
      });
      if (submission?.status === 'rejected') {
        await client.query('COMMIT');
        return false;
      }
      const entry = await save(
        ownerId,
        {
          label: selected.login_label,
          origin,
          username: secret.username,
          password: secret.password,
        },
        client,
        selected.identifier_label,
      );
      await rememberSelection(client, {
        rootTurnId: root,
        ownerId,
        origin,
        entryId: entry.id,
        username: secret.username,
        identifierLabel: selected.identifier_label,
        expiresAt: selected.expires_at,
        blocked: false,
        enteredAt: Date.now(),
      });
      await client.query('COMMIT');
      return true;
    } catch {
      await client.query('ROLLBACK');
      return false;
    } finally {
      client.release();
    }
  }

  async function fillSelected(turn: TurnRef, ownerId: string, raw: CredentialInput) {
    const origin = credentialOrigin(raw.origin);
    const root = await rootTurn(pool, turn, ownerId);
    const selected = root ? await selection(root, ownerId, origin) : undefined;
    if (!selected) return undefined;
    if (
      !(await currentTurn(pool, turn, ownerId)) ||
      selected.blocked ||
      new Date(selected.expires_at).getTime() <= Date.now()
    )
      return false;
    if (!selected.entry_id) return fillStagedPassword(turn, ownerId, raw);
    try {
      await fillSaved(turn, ownerId, selected.entry_id, raw);
      return true;
    } catch {
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
    let client: PoolClient | undefined;
    try {
      const origin = credentialOrigin(raw.origin);
      const started = await currentTurn(pool, turn, ownerId);
      const root = started ? await rootTurn(pool, turn, ownerId) : undefined;
      if (!root) return false;
      const selected = await selection(root, ownerId, origin);
      const enteredAt = selected
        ? selected.credential_entered_at?.getTime()
        : started?.started_at?.getTime();
      if (
        !enteredAt ||
        enteredAt < Date.now() - 5 * 60_000 ||
        enteredAt > Date.now() ||
        (selected && selected.expires_at.getTime() <= Date.now())
      )
        return false;
      const selectedUsername = selected
        ? normalizedEmail(openCredential(await key(), selected).username)
        : undefined;
      const fresh = await inspectRequest(turn.threadId, raw);
      const shown = fresh.input.emailRecipient?.toLowerCase();
      const delivery = shown
        ? /[*•]/.test(shown)
          ? { recipientHint: shown }
          : { recipient: shown }
        : {};
      const username = verificationRecipient(delivery, selectedUsername);
      if (!username || fresh.input.kind !== 'otp' || fresh.inspection.origin !== origin)
        return false;
      const attempt = await pool.query(
        `INSERT INTO credential_autofill_attempts(root_turn_id,owner_id,origin,entry_id,kind)
         SELECT $1,$2,$3,$4,'otp' WHERE EXISTS(SELECT 1 FROM turns WHERE id=$5 AND owner_id=$2
         AND status='running') ON CONFLICT(root_turn_id,owner_id,origin,kind)
         DO UPDATE SET entry_id=excluded.entry_id,attempted_at=now()
         WHERE credential_autofill_attempts.entry_id<>excluded.entry_id RETURNING root_turn_id`,
        [root, ownerId, origin, selected?.id ?? root, turn.turnId],
      );
      if (!attempt.rowCount) return false;
      const signal = AbortSignal.timeout(8000);
      let abort = () => {};
      const found = await Promise.race([
        options.emailCode(
          {
            recipient: username,
            origin,
            after: enteredAt - 30_000,
            before: Date.now(),
          },
          signal,
        ),
        new Promise<undefined>((resolve) => {
          abort = () => resolve(undefined);
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]).finally(() => signal.removeEventListener('abort', abort));
      const code = found?.code;
      if (signal.aborted || !code || !/^\d{4,8}$/.test(code)) return false;
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await currentTurn(client, turn, ownerId, ' FOR UPDATE OF u NOWAIT');
      const retained = await selection(root, ownerId, origin, client);
      if (
        !current ||
        enteredAt < Date.now() - 5 * 60_000 ||
        (selected
          ? !retained ||
            retained.id !== selected.id ||
            retained.expires_at.getTime() <= Date.now() ||
            retained.credential_entered_at?.getTime() !== enteredAt
          : retained || current.started_at?.getTime() !== enteredAt)
      )
        throw new VaultError('This sign-in step changed.', 409);
      if (
        retained?.entry_id &&
        !(
          await client.query(
            'SELECT id FROM vault_entries WHERE id=$1 AND owner_id=$2 AND origin=$3 FOR SHARE',
            [retained.entry_id, ownerId, origin],
          )
        ).rowCount
      )
        throw new VaultError('This saved login is no longer available.', 409);
      const verified = await inspectRequest(turn.threadId, fresh.input);
      if (verified.input.kind !== 'otp' || verified.inspection.origin !== origin)
        throw new VaultError('This verification step changed.', 409);
      if (!(await found.current(client)))
        throw new VaultError('This connected mailbox is no longer available.', 409);
      const submitted = await options.inject({
        ...verified.input,
        threadId: turn.threadId,
        code,
      });
      await client.query('COMMIT');
      return submitted?.status !== 'rejected';
    } catch {
      await client?.query('ROLLBACK');
      return false;
    } finally {
      client?.release();
    }
  }

  async function submitChatCode(
    ownerId: string,
    turnId: string,
    text: string,
    requestId: string,
  ): Promise<{ status: 'submitted' | 'rejected' | 'invalid' | 'unavailable' }> {
    if (ownerId !== owner) return { status: 'unavailable' };
    const code = text.trim();
    if (!/^\d{4,8}$/.test(code)) return { status: 'invalid' };
    try {
      const { rows } = await pool.query<{ token_hash: string }>(
        `SELECT r.token_hash FROM credential_requests r JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
         WHERE r.id=$1 AND r.turn_id=$2 AND r.owner_id=$3 AND r.kind='otp' AND r.status='pending' AND r.expires_at>now()
         AND ${waitingTurnSql('u', 'credentials')}`,
        [requestId, turnId, ownerId],
      );
      if (rows.length !== 1) return { status: 'unavailable' };
      const result = await submit(rows[0].token_hash, { code }, true);
      return { status: result.ok ? 'submitted' : 'rejected' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  const icons = new Map<string, { expiresAt: number; icon: Promise<SiteIcon | null> }>();
  function siteIcon(origin: string) {
    const fetchIcon = options.icon;
    if (!fetchIcon || localHost(new URL(origin).hostname)) return null;
    const cached = icons.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached.icon;
    icons.delete(origin);
    const entry = {
      expiresAt: Date.now() + 86_400_000,
      icon: fetchIcon(origin)
        .catch(() => null)
        .then((icon) => {
          if (!icon || icon.bytes.byteLength > 128 * 1024) {
            entry.expiresAt = Date.now() + 600_000;
            return null;
          }
          return icon;
        }),
    };
    icons.set(origin, entry);
    while (icons.size > 128) icons.delete(icons.keys().next().value!);
    return entry.icon;
  }

  function registerRoutes(app: FastifyInstance) {
    app.addHook('onClose', async () => {
      closed = true;
      clearInterval(timer);
      try {
        await resuming;
      } finally {
        identifiers.clear();
      }
    });
    app.register(async (scope) => {
      scope.addHook('onSend', async (_request, reply, payload) => {
        reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        return payload;
      });
      scope.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof VaultError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
        reply.code(status).send({
          error:
            error instanceof VaultError
              ? error.message
              : status === 400
                ? 'Check the credential fields.'
                : 'The vault request could not be completed.',
        });
      });
      scope.get('/api/vault', listEntries);
      scope.post('/api/vault', { bodyLimit: 16_384 }, async (request) => {
        const { kind } = z
          .object({ kind: z.enum(['login', 'card']).optional() })
          .parse(request.body);
        if (kind === 'card') return saveCard(request.body);
        requireFullHost(request.body);
        return save(owner, request.body);
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
            return {
              ...cardMetadata(entry),
              cardholder: secret.cardholder,
              hasSecurityCode: Boolean(secret.securityCode),
            };
          }
          const { entry, secret } = await readCredential(request.params.id);
          return { ...metadata(entry, secret.username), username: secret.username };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/password',
        async (request): Promise<VaultEntryPassword> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCredential(request.params.id);
          return { password: secret.password };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/security-code',
        async (request): Promise<VaultCardSecurityCode> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCard(request.params.id);
          if (!secret.securityCode)
            throw new VaultError('This card has no saved security code.', 404);
          return { securityCode: secret.securityCode };
        },
      );
      scope.post<{ Params: { id: string } }>(
        '/api/vault/:id/card-number',
        async (request): Promise<VaultCardNumber> => {
          z.object({})
            .strict()
            .parse(request.body ?? {});
          const { secret } = await readCard(request.params.id);
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
        await pool.query(
          'WITH login AS (DELETE FROM vault_entries WHERE id=$1 AND owner_id=$2 RETURNING id) DELETE FROM vault_cards WHERE id=$1 AND owner_id=$2',
          [z.uuid().parse(request.params.id), owner],
        );
        return { ok: true };
      });
      scope.get<{ Params: { id: string } }>('/api/credential-requests/:id', async (request) =>
        describe(request.params.id),
      );
      scope.post<{ Params: { id: string } }>(
        '/api/credential-requests/:id/refresh',
        async (request) => refreshRequest(request.params.id),
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
        '/api/credential-requests/:id',
        { bodyLimit: 16_384 },
        async (request) => submit(request.params.id, request.body),
      );
    });
  }

  return {
    registerRoutes,
    saveLogin: (input: { origin: string; label: string; username: string; password: string }) =>
      save(owner, input),
    request,
    list,
    readCredential,
    removeLogin,
    fillSaved,
    fillSelected,
    fillEmailCode,
    submitChatCode,
    resumePending,
  };
}
