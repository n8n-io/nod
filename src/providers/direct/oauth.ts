import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AppGrantVault } from '../../ports/app-grants.ts';
import type { CredentialKeyStore } from '../../ports/key-store.ts';

export const endpoints = {
  notion: 'https://mcp.notion.com/mcp',
  linear: 'https://mcp.linear.app/mcp',
} as const;
export type Service = keyof typeof endpoints;
export class ReconnectRequired extends Error {
  constructor(readonly service: Service) {
    super('Connect this account again.');
  }
}
type Secrets = {
  accessToken?: string;
  refreshToken?: string;
  refreshUncertain?: boolean;
  expiresAt?: number;
  clientId: string;
  verifier?: string;
  redirectUri?: string;
  tokenEndpoint?: string;
  issuer?: string;
  requireIssuer?: boolean;
  resource?: string;
};
type AccountRow = {
  id: string;
  owner_id: string;
  service: Service;
  state_hash: string | null;
  expires_at: Date | null;
  connected: boolean;
};
const oauthQuery = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  iss: z.string().optional(),
  error: z.string().optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

function challenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function json(response: Response) {
  if (!response.ok) throw new Error(`Provider request failed (${response.status}).`);
  return response.json();
}

export function createDirectOAuth(options: {
  pool: Pool;
  keyStore: CredentialKeyStore;
  grantVault: AppGrantVault;
  ownerId: string;
  request: typeof fetch;
}) {
  const refreshes = new Map<
    string,
    { promise: Promise<Secrets>; controller: AbortController; waiters: number; settled: boolean }
  >();
  const ready = (async () => {
    await options.pool.query(`CREATE TABLE IF NOT EXISTS direct_oauth_accounts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, service text NOT NULL,
      state_hash text UNIQUE, expires_at timestamptz, connected boolean NOT NULL DEFAULT false
    )`);
    await options.pool.query(
      'DELETE FROM direct_oauth_accounts WHERE owner_id=$1 AND connected=false AND (expires_at IS NULL OR expires_at<=now())',
      [options.ownerId],
    );
  })();

  async function row(id: string, ownerId: string) {
    await ready;
    if (ownerId !== options.ownerId) throw new Error('This connected account is unavailable.');
    const result = await options.pool.query<AccountRow>(
      `SELECT id,owner_id,service,state_hash,expires_at,connected FROM direct_oauth_accounts
       WHERE id=$1 AND connected=true AND owner_id=$2`,
      [id, ownerId],
    );
    if (!result.rows[0]) throw new Error('This connected account is unavailable.');
    return result.rows[0];
  }

  async function access(account: AccountRow, signal?: AbortSignal): Promise<Secrets> {
    signal?.throwIfAborted();
    const grant = await options.grantVault.read(account.id);
    signal?.throwIfAborted();
    const secrets = JSON.parse(grant.value) as Secrets;
    if (
      !secrets.accessToken ||
      secrets.refreshUncertain ||
      (account.service === 'linear' && secrets.resource !== endpoints.linear)
    )
      throw new ReconnectRequired(account.service);
    if (!secrets.expiresAt || secrets.expiresAt > Date.now() + 60_000) return secrets;
    let current = refreshes.get(account.id);
    if (!current) {
      const controller = new AbortController();
      const pending = (async () => {
        if (!secrets.refreshToken || !secrets.tokenEndpoint)
          throw new ReconnectRequired(account.service);
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: secrets.refreshToken,
          client_id: secrets.clientId,
        });
        if (secrets.resource) body.set('resource', secrets.resource);
        let refreshed;
        try {
          const response = await options.request(secrets.tokenEndpoint, {
            method: 'POST',
            body,
            signal: controller.signal,
          });
          if (response.status === 400 || response.status === 401)
            throw new ReconnectRequired(account.service);
          refreshed = tokenSchema.parse(await json(response));
        } catch (error) {
          if (controller.signal.aborted)
            await options.grantVault.replace(
              account.id,
              grant.version,
              JSON.stringify({ ...secrets, refreshUncertain: true }),
            );
          throw error;
        }
        const next: Secrets = {
          ...secrets,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? secrets.refreshToken,
          expiresAt:
            refreshed.expires_in !== undefined
              ? Date.now() + refreshed.expires_in * 1000
              : undefined,
        };
        return (await options.grantVault.replace(account.id, grant.version, JSON.stringify(next)))
          ? next
          : (JSON.parse((await options.grantVault.read(account.id)).value) as Secrets);
      })();
      const created = { promise: pending, controller, waiters: 0, settled: false };
      refreshes.set(account.id, created);
      void pending
        .finally(() => {
          created.settled = true;
          if (refreshes.get(account.id) === created) refreshes.delete(account.id);
        })
        .catch(() => {});
      current = created;
    }
    const refresh = current;
    refresh.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (operation: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        refresh.waiters--;
        if (!refresh.waiters && !refresh.settled) refresh.controller.abort();
        operation();
      };
      const abort = () => finish(() => reject(signal?.reason));
      signal?.addEventListener('abort', abort, { once: true });
      refresh.promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (signal?.aborted) abort();
    });
  }

  async function authorize(ownerId: string, service: Service, callbackUrl: string) {
    await ready;
    if (ownerId !== options.ownerId) throw new Error('This account is unavailable.');
    const expired = await options.pool.query<{ id: string }>(
      'DELETE FROM direct_oauth_accounts WHERE owner_id=$1 AND connected=false AND expires_at<now() RETURNING id',
      [ownerId],
    );
    for (const row of expired.rows) await options.grantVault.remove(row.id);
    await options.pool.query(
      'UPDATE direct_oauth_accounts SET state_hash=NULL,expires_at=NULL WHERE owner_id=$1 AND connected=true AND expires_at<now()',
      [ownerId],
    );
    const callback = new URL(callbackUrl);
    const nonce = callback.searchParams.get('state');
    if (!nonce) throw new Error('The connection state is missing.');
    callback.search = '';
    callback.hash = '';
    if (callback.hostname === 'localhost') callback.hostname = '127.0.0.1';
    const id = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    const endpoint = new URL(endpoints[service]);
    const server = endpoint.origin;
    const resourceUrl = service === 'linear' ? endpoint.href : undefined;
    const resource = z
      .object({ authorization_servers: z.array(z.string().url()).min(1) })
      .parse(
        await json(
          await options.request(
            `${server}/.well-known/oauth-protected-resource${service === 'linear' ? endpoint.pathname : ''}`,
          ),
        ),
      );
    if (resource.authorization_servers[0] !== server)
      throw new Error('The authorization server changed.');
    const metadata = z
      .object({
        issuer: z.string().url(),
        authorization_response_iss_parameter_supported: z.boolean().optional(),
        authorization_endpoint: z.string().url(),
        token_endpoint: z.string().url(),
        registration_endpoint: z.string().url(),
      })
      .parse(await json(await options.request(`${server}/.well-known/oauth-authorization-server`)));
    if (
      metadata.issuer !== server ||
      ![
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.registration_endpoint,
      ].every((url) => new URL(url).origin === server)
    )
      throw new Error('The OAuth endpoint changed.');
    const registration = z.object({ client_id: z.string().min(1) }).parse(
      await json(
        await options.request(metadata.registration_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Otto',
            redirect_uris: [callback.href],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            ...(service === 'linear' ? { scope: 'read write' } : {}),
          }),
        }),
      ),
    );
    const secrets: Secrets = {
      clientId: registration.client_id,
      verifier,
      redirectUri: callback.href,
      tokenEndpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
      resource: resourceUrl,
    };
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO direct_oauth_accounts(id,owner_id,service,state_hash,expires_at)
         VALUES($1,$2,$3,$4,now() + interval '10 minutes')`,
        [id, ownerId, service, createHash('sha256').update(nonce).digest('hex')],
      );
      await options.grantVault.put(
        id,
        JSON.stringify(secrets),
        client,
        new Date(Date.now() + 600_000),
      );
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', registration.client_id);
    url.searchParams.set('redirect_uri', callback.href);
    url.searchParams.set('state', nonce);
    url.searchParams.set('code_challenge', challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (service === 'notion') {
      url.searchParams.set('scope', 'default');
    } else {
      url.searchParams.set('scope', 'read write');
      url.searchParams.set('resource', resourceUrl!);
    }
    return { accountId: id, url: url.href };
  }

  async function parseCallback(raw: unknown) {
    const input = oauthQuery.parse(raw);
    await ready;
    const hash = createHash('sha256').update(input.state).digest('hex');
    const result = await options.pool.query<AccountRow>(
      `SELECT id,owner_id,service,state_hash,expires_at,connected FROM direct_oauth_accounts
       WHERE state_hash=$1 AND owner_id=$2 AND expires_at>now()`,
      [hash, options.ownerId],
    );
    const pending = result.rows[0];
    if (!pending) throw new Error('This sign-in link is expired or already used.');
    const secrets = JSON.parse((await options.grantVault.read(pending.id)).value) as Secrets;
    if (input.iss !== undefined && input.iss !== secrets.issuer)
      throw new Error('The authorization server changed.');
    if (secrets.requireIssuer && input.iss !== secrets.issuer)
      throw new Error('The authorization server did not identify itself.');
    if (pending.connected) return { state: input.state, accountId: pending.id, success: true };
    if (input.error || !input.code) {
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        const removed = await client.query(
          'DELETE FROM direct_oauth_accounts WHERE id=$1 AND owner_id=$2 AND connected=false',
          [pending.id, options.ownerId],
        );
        if (removed.rowCount) await options.grantVault.remove(pending.id, client);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
      return { state: input.state, accountId: pending.id, success: false };
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: secrets.clientId,
      redirect_uri: secrets.redirectUri!,
      code_verifier: secrets.verifier!,
    });
    if (secrets.resource) body.set('resource', secrets.resource);
    const tokens = tokenSchema.parse(
      await json(await options.request(secrets.tokenEndpoint!, { method: 'POST', body })),
    );
    const connected: Secrets = {
      clientId: secrets.clientId,
      tokenEndpoint: secrets.tokenEndpoint,
      issuer: secrets.issuer,
      requireIssuer: secrets.requireIssuer,
      resource: secrets.resource,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:
        tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
    };
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN');
      const saved = await client.query(
        `UPDATE direct_oauth_accounts SET connected=true
         WHERE id=$1 AND owner_id=$2 AND state_hash=$3 AND connected=false`,
        [pending.id, options.ownerId, hash],
      );
      if (!saved.rowCount) throw new Error('This sign-in link was already used.');
      await options.grantVault.put(pending.id, JSON.stringify(connected), client);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    return { state: input.state, accountId: pending.id, success: true };
  }

  return {
    ready,
    authorize,
    parseCallback,
    async access(ownerId: string, id: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const account = await row(id, ownerId);
      const secrets = await access(account, signal);
      return { service: account.service, accessToken: secrets.accessToken! };
    },
    async deleteAccount(id: string) {
      await ready;
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM direct_oauth_accounts WHERE id=$1 AND owner_id=$2', [
          id,
          options.ownerId,
        ]);
        await options.grantVault.remove(id, client);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK');
        throw cause;
      } finally {
        client.release();
      }
    },
  };
}
