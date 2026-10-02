import 'dotenv/config';
import { resolve } from 'node:path';
import type { Configuration } from '../shared/contracts.ts';
import { z } from 'zod';

export const runtimeMode = z
  .enum(['local', 'gateway', 'tenant'])
  .parse(process.env.OTTO_MODE || 'local');
export const ownerId =
  runtimeMode === 'tenant'
    ? z.uuid().parse(process.env.OTTO_OWNER_ID).toLowerCase()
    : 'local-development';
export const port = Number(process.env.PORT || 4310);
export const dataRoot = resolve(process.env.OTTO_DATA_ROOT || '.local');
export const databaseUrl = process.env.DATABASE_URL || undefined;
export const publicOrigin = new URL(process.env.OTTO_PUBLIC_URL || `http://localhost:${port}`)
  .origin;
export const runtimeEnvironment = process.env.OTTO_ENVIRONMENT || 'development';
export const runtimeSecret = process.env.OTTO_RUNTIME_SECRET || '';
export const runtimeGeneration = process.env.OTTO_RUNTIME_GENERATION || '';
if (
  runtimeMode === 'tenant' &&
  (!databaseUrl ||
    Buffer.from(runtimeSecret, 'base64url').length < 32 ||
    !/^[1-9]\d*$/.test(runtimeGeneration) ||
    !/^sk_jobs_[a-f0-9]{32}$/.test(process.env.PGBOSS_SCHEMA || ''))
)
  throw new Error('Tenant runtime configuration is incomplete.');
export function configuration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    provider: 'unconfigured',
    model: 'Unconfigured',
    llmReady: false,
    integrationsReady: false,
    inspectorEnabled:
      runtimeMode === 'local'
        ? process.env.DEV_INSPECTOR !== 'false'
        : process.env.DEV_INSPECTOR === 'true',
    localOnly: runtimeMode === 'local',
    ...overrides,
  };
}
