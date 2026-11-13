import { transaction as inTransaction } from './transaction.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { logFailure } from './failure-log.ts';
import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';
import { BrowserActionError } from '../ports/computer.ts';
import { browserErrorMessage } from '../shared/browser-errors.ts';

type SecureEntry = Extract<AnalyticsEvent, { event: 'secure_entry_changed' }>['properties'];

interface SecureEntryUse {
  kind: string;
  origin?: string;
  payment?: { amount: number; currency: string };
}

export function captureSecureEntry(
  analytics: CaptureAnalytics | undefined,
  use: SecureEntryUse,
  status: SecureEntry['status'],
) {
  const kind =
    use.kind === 'card' || use.kind === 'payment'
      ? 'payment'
      : use.kind === 'otp'
        ? 'code'
        : 'sign_in';
  analytics?.({ event: 'secure_entry_changed', properties: { kind, status } });
}

export class VaultUseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function failureCause(error: unknown) {
  if (error instanceof BrowserActionError) return 'browser';
  if (error instanceof DatabaseError) return 'database';
  if (!(error instanceof Error)) return 'unknown';
  try {
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'EPIPE',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes((error as Error & { code?: string }).code ?? '')
    )
      return 'transport';
  } catch {}
  return 'operation';
}

export async function createVaultUses(pool: Pool, ownerId: string, analytics?: CaptureAnalytics) {
  await pool.query(`CREATE TABLE IF NOT EXISTS vault_uses (
    id text PRIMARY KEY, owner_id text NOT NULL, root_turn_id uuid,
    origin text NOT NULL, kind text NOT NULL, item_id text, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE vault_uses ADD COLUMN IF NOT EXISTS root_turn_id uuid;
  CREATE INDEX IF NOT EXISTS vault_uses_owner ON vault_uses(owner_id,created_at DESC);`);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS vault_uses_root ON vault_uses(owner_id,root_turn_id,origin,kind,item_id)',
  );
  await pool.query(
    "UPDATE vault_uses SET status='uncertain' WHERE owner_id=$1 AND status='running'",
    [ownerId],
  );

  const transaction = <T>(work: (client: PoolClient) => Promise<T>) => inTransaction(work, pool);

  async function run<T>(
    use: {
      id?: string;
      ownerId: string;
      rootTurnId?: string;
      origin: string;
      kind: string;
      itemId?: string;
      payment?: SecureEntryUse['payment'];
    },
    operation: {
      prepare?(client: PoolClient): Promise<void | false>;
      perform(): Promise<T>;
      complete?(client: PoolClient, result: T): Promise<void>;
    },
  ): Promise<T | undefined> {
    if (use.ownerId !== ownerId)
      throw new VaultUseError('This private operation belongs to another owner.', 409);
    const id = use.id ?? randomUUID();
    const uncertain = () =>
      new VaultUseError(
        'The private operation did not finish. It may have reached the website. Check its result before another attempt.',
        502,
      );
    const report = (stage: 'claim' | 'entry' | 'completion', error: unknown) =>
      logFailure('vault_private_operation_interrupted', uncertain(), {
        stage,
        kind: ['identifier', 'password', 'otp', 'method', 'card', 'payment'].includes(use.kind)
          ? use.kind
          : 'other',
        cause: failureCause(error),
        ...(error instanceof BrowserActionError && browserErrorMessage(error.code)
          ? { browserCode: error.code }
          : {}),
      });
    let claimStarted = false;
    const ready = await transaction(async (client) => {
      if ((await operation.prepare?.(client)) === false) return false;
      claimStarted = true;
      const claimed = await client.query(
        `INSERT INTO vault_uses(id,owner_id,root_turn_id,origin,kind,item_id,status)
         VALUES($1,$2,$3,$4,$5,$6,'running') ON CONFLICT DO NOTHING RETURNING id`,
        [id, use.ownerId, use.rootTurnId ?? null, use.origin, use.kind, use.itemId ?? null],
      );
      if (!claimed.rowCount)
        throw new VaultUseError(
          'This private operation was already used. Check its result before entering fresh credentials.',
          409,
        );
      return true;
    }).catch(async (error: unknown) => {
      if (error instanceof VaultUseError || !claimStarted) throw error;
      report('claim', error);
      try {
        const recovered = await pool.query(
          "UPDATE vault_uses SET status='uncertain' WHERE id=$1 AND owner_id=$2 AND status='running' RETURNING id",
          [id, use.ownerId],
        );
        if (recovered.rowCount) {
          captureSecureEntry(analytics, use, 'uncertain');
          throw uncertain();
        }
      } catch (recoveryError) {
        if (!(recoveryError instanceof VaultUseError))
          logFailure('vault_claim_recovery', recoveryError);
        throw uncertain();
      }
      throw error;
    });
    if (!ready) return;
    let stage: 'entry' | 'completion' = 'entry';
    try {
      const result = await operation.perform();
      stage = 'completion';
      await transaction(async (client) => {
        await operation.complete?.(client, result);
        await client.query("UPDATE vault_uses SET status='submitted' WHERE id=$1 AND owner_id=$2", [
          id,
          use.ownerId,
        ]);
      });
      captureSecureEntry(analytics, use, 'submitted');
      return result;
    } catch (error) {
      report(stage, error);
      captureSecureEntry(analytics, use, 'uncertain');
      await pool
        .query("UPDATE vault_uses SET status='uncertain' WHERE id=$1 AND owner_id=$2", [
          id,
          use.ownerId,
        ])
        .catch((error: unknown) => logFailure('vault_use_uncertain', error));
      throw uncertain();
    }
  }

  return { run, transaction };
}
