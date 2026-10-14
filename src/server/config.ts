import 'dotenv/config';
import { isAbsolute, resolve } from 'node:path';
import type { Configuration } from '../shared/contracts.ts';
import { z } from 'zod';

export const runtimeMode = z
  .enum(['local', 'gateway', 'tenant'])
  .parse(process.env.OTTO_MODE || 'local');
export const desktopMode = process.env.OTTO_DESKTOP === 'true';
export const ownerId =
  runtimeMode === 'tenant'
    ? z.uuid().parse(process.env.OTTO_OWNER_ID).toLowerCase()
    : desktopMode
      ? z.uuid().parse(process.env.OTTO_DESKTOP_OWNER_ID).toLowerCase()
      : 'local-development';
export const port = Number(process.env.PORT || 4310);
export const dataRoot = resolve(process.env.OTTO_DATA_ROOT || '.local');
export const databaseUrl = process.env.DATABASE_URL || undefined;
export const publicOrigin = new URL(
  process.env.OTTO_PUBLIC_URL || `http://${desktopMode ? '127.0.0.1' : 'localhost'}:${port}`,
).origin;
export const webRoot = resolve(process.env.OTTO_WEB_ROOT || 'dist/web');
export const desktopAccess = desktopMode
  ? { token: process.env.OTTO_DESKTOP_AUTH_TOKEN || '' }
  : undefined;
if (
  desktopAccess &&
  (runtimeMode !== 'local' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    publicOrigin !== `http://127.0.0.1:${port}` ||
    !/^[A-Za-z0-9_-]{43,}$/.test(desktopAccess.token) ||
    !isAbsolute(process.env.OTTO_DATA_ROOT || '') ||
    (process.env.OTTO_WEB_ROOT !== undefined && !isAbsolute(process.env.OTTO_WEB_ROOT)))
)
  throw new Error('Desktop runtime configuration is incomplete.');
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
    localOnly: runtimeMode === 'local',
    conversationResetEnabled:
      runtimeMode === 'local' &&
      runtimeEnvironment === 'development' &&
      process.env.NODE_ENV !== 'production',
    ...overrides,
  };
}
