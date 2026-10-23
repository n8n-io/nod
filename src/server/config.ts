import 'dotenv/config';
import { isAbsolute, resolve } from 'node:path';
import type { Configuration } from '../shared/contracts.ts';
import { z } from 'zod';

export const desktopMode = process.env.NOD_DESKTOP === 'true';
export const ownerId = desktopMode
  ? z.uuid().parse(process.env.NOD_DESKTOP_OWNER_ID).toLowerCase()
  : 'local-development';
export const port = Number(process.env.PORT || 4310);
export const dataRoot = resolve(process.env.NOD_DATA_ROOT || '.local');
export const databaseUrl = process.env.DATABASE_URL || undefined;
export const publicOrigin = new URL(
  process.env.NOD_PUBLIC_URL || `http://${desktopMode ? '127.0.0.1' : 'localhost'}:${port}`,
).origin;
export const webRoot = resolve(process.env.NOD_WEB_ROOT || 'dist/web');
export const desktopAccess = desktopMode
  ? { token: process.env.NOD_DESKTOP_AUTH_TOKEN || '' }
  : undefined;
if (
  desktopAccess &&
  (!Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    publicOrigin !== `http://127.0.0.1:${port}` ||
    !/^[A-Za-z0-9_-]{43,}$/.test(desktopAccess.token) ||
    !isAbsolute(process.env.NOD_DATA_ROOT || '') ||
    (process.env.NOD_WEB_ROOT !== undefined && !isAbsolute(process.env.NOD_WEB_ROOT)))
)
  throw new Error('Desktop runtime configuration is incomplete.');
export const runtimeEnvironment = process.env.NOD_ENVIRONMENT || 'development';
export function configuration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    provider: 'unconfigured',
    model: 'Unconfigured',
    llmReady: false,
    modelReconnect: false,
    integrationsReady: false,
    conversationResetEnabled:
      runtimeEnvironment === 'development' && process.env.NODE_ENV !== 'production',
    ...overrides,
  };
}
