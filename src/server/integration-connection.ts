import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationProvider } from '../ports/integrations.ts';
import { normalizedEmail } from './email-code.ts';

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export async function verifyIntegrationCompletion(options: {
  parsed: unknown;
  provider: IntegrationProvider;
  ownerId: string;
  pending: {
    service: string;
    callbackHash: string | null;
    accountId: string | null;
    claimed: boolean;
    configurationId: string | null;
    verifyOwner?: boolean;
    originalEmail?: string | null;
    originalAuthConfigId?: string | null;
  };
  verifiedAccount?: (accountId: string) => void;
}) {
  const { provider, pending } = options;
  const query = z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      accountId: z.string().min(1).max(200),
      pendingAccountId: z.string().min(1).max(200).optional(),
      success: z.literal(true),
    })
    .parse(options.parsed);
  const hash = createHash('sha256').update(query.state).digest('hex');
  if (
    hash !== pending.callbackHash ||
    (query.pendingAccountId ?? query.accountId) !== pending.accountId ||
    !pending.claimed
  )
    throw new IntegrationError('This connection link is expired or already used.', 409);
  if (
    !provider.configured ||
    (provider.configurationId && provider.configurationId !== pending.configurationId)
  )
    throw new IntegrationError('This connection provider changed. Start sign-in again.', 409);
  const remote = await provider.inspectAccount(
    query.accountId,
    options.ownerId,
    pending.verifyOwner || query.pendingAccountId ? { verifyOwner: true } : undefined,
  );
  if (!remote.active || remote.service !== pending.service)
    throw new IntegrationError('App sign-in is incomplete. Connect again.', 409);
  if (query.pendingAccountId && query.pendingAccountId !== query.accountId)
    options.verifiedAccount?.(query.accountId);
  if (
    (pending.originalEmail !== undefined &&
      (!pending.originalEmail ||
        normalizedEmail(remote.accountEmail ?? '') !== pending.originalEmail)) ||
    (pending.originalAuthConfigId !== undefined &&
      (!pending.originalAuthConfigId || remote.authConfigId !== pending.originalAuthConfigId))
  )
    throw new IntegrationError('Sign in with the original account to reconnect it.', 409);
  return { query, hash, remote };
}
