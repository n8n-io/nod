export class RuntimeControlError extends Error {
  constructor(readonly status = 400) {
    super('The runtime request could not be completed.');
    this.name = 'RuntimeControlError';
  }
}

export type Bootstrap = { ownerId: string; env: Record<string, string> };
export type TenantIdentity = {
  ownerId: string;
  environment: string;
  generation: string;
  configurationHash: string;
  leaseExpiresAt: number;
  revoking: boolean;
  stopped: boolean;
  computerProvider?: 'cloudflare' | 'e2b';
};

export function computerProvider(identity: Pick<TenantIdentity, 'computerProvider'>) {
  const provider = identity.computerProvider ?? 'cloudflare';
  if (provider !== 'cloudflare' && provider !== 'e2b') throw new RuntimeControlError();
  return provider;
}

export function ownerIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    throw new RuntimeControlError();
  return value;
}

export function environmentName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value))
    throw new RuntimeControlError();
  return value;
}

export function generation(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value)) throw new RuntimeControlError();
  return value;
}

export function leaseExpiry(value: unknown, now: () => number = Date.now) {
  const match =
    typeof value === 'string'
      ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
      : null;
  if (!match) throw new RuntimeControlError();
  const expiry = Date.parse(value as string);
  const time = now();
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= time ||
    expiry > time + 65_000 ||
    new Date(expiry).toISOString() !== `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`
  )
    throw new RuntimeControlError();
  return expiry;
}

export function environmentValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeControlError();
  const entries = Object.entries(value);
  for (const [key, entry] of entries)
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      key === 'OTTO_IMAGE_RELEASE' ||
      typeof entry !== 'string' ||
      entry.includes('\u0000')
    )
      throw new RuntimeControlError();
  return Object.fromEntries(entries) as Record<string, string>;
}

export function analyticsEnvironment(environment: string, env: Record<string, string>) {
  const production = environmentName(environment) === 'production';
  const enabled = env.OTTO_ANALYTICS_ENABLED || String(production);
  const name = env.OTTO_ANALYTICS_ENVIRONMENT || (production ? 'production' : 'development');
  if (!['true', 'false'].includes(enabled) || !['development', 'production'].includes(name))
    throw new RuntimeControlError();
  return { OTTO_ANALYTICS_ENABLED: enabled, OTTO_ANALYTICS_ENVIRONMENT: name };
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function bootstrap(value: unknown, environment: string, now: () => number = Date.now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeControlError();
  const input = value as Partial<Bootstrap>;
  if (Object.keys(input).some((key) => key !== 'ownerId' && key !== 'env'))
    throw new RuntimeControlError();
  const ownerId = ownerIdentity(input.ownerId);
  const env = environmentValues(input.env);
  const provider = computerProvider({
    computerProvider: env.COMPUTER_PROVIDER as TenantIdentity['computerProvider'],
  });
  const runtimeGeneration = generation(env.OTTO_RUNTIME_GENERATION);
  const leaseExpiresAt = leaseExpiry(env.OTTO_RUNTIME_LEASE_EXPIRES, now);
  if (
    env.OTTO_OWNER_ID !== ownerId ||
    env.OTTO_ENVIRONMENT !== environmentName(environment) ||
    env.OTTO_MODE !== 'tenant' ||
    !/^[a-zA-Z0-9_-]{43,128}$/.test(env.OTTO_RUNTIME_SECRET ?? '')
  )
    throw new RuntimeControlError();
  const suffix = (await hash(JSON.stringify(['otto-tenant-v1', environment, ownerId]))).slice(
    0,
    32,
  );
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL);
  } catch {
    throw new RuntimeControlError();
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    decodeURIComponent(database.username) !== `sk_user_${suffix}` ||
    !database.password ||
    env.PGBOSS_SCHEMA !== `sk_jobs_${suffix}`
  )
    throw new RuntimeControlError();
  const configured: Record<string, string> = {
    ...env,
    ...analyticsEnvironment(environment, env),
    OTTO_CONTROL_URL: 'http://otto.control',
    OTTO_DATA_ROOT: '/data',
    OTTO_BIND_HOST: '0.0.0.0',
    NODE_ENV: 'production',
    PORT: '4310',
    HOST: '0.0.0.0',
  };
  delete configured.OTTO_COMPUTER_CONTROL_URL;
  if (provider === 'e2b') configured.OTTO_COMPUTER_CONTROL_URL = 'http://otto.computer/v1/stopped';
  const configurationHash = await hash(JSON.stringify(Object.entries(configured).sort()));
  const identity: TenantIdentity = {
    ownerId,
    environment,
    generation: runtimeGeneration,
    configurationHash,
    leaseExpiresAt,
    revoking: false,
    stopped: false,
    computerProvider: provider,
  };
  return { env: configured, identity };
}

export async function boundedBody(request: Request, limit: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new RuntimeControlError(413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function controlBody(request: Request) {
  try {
    return JSON.parse(new TextDecoder().decode(await boundedBody(request, 64 * 1024))) as unknown;
  } catch (error) {
    if (error instanceof RuntimeControlError) throw error;
    throw new RuntimeControlError();
  }
}

export function failure(error: unknown) {
  return Response.json(
    { error: 'This request could not be completed. Try again.' },
    {
      status: error instanceof RuntimeControlError ? error.status : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
