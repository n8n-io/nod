import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import { parseCredentialKey } from '../environment/key-store.ts';

const run = promisify(execFile);

export function createKeychainKeyStore(
  options: {
    platform?: NodeJS.Platform;
    run?: (
      command: string,
      args: string[],
      options: { timeout: number; maxBuffer: number },
    ) => Promise<{ stdout: string }>;
    canCreate?(): Promise<boolean>;
  } = {},
): CredentialKeyStore {
  const platform = options.platform ?? process.platform;
  const execute = options.run ?? run;
  const service = 'dev.nod.vault';
  const account = 'master-key-v1';
  let pending: Promise<Buffer> | undefined;
  const read = async () => {
    const { stdout } = await execute(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 15_000, maxBuffer: 4096 },
    );
    return parseCredentialKey(stdout.trim());
  };
  async function load() {
    if (platform !== 'darwin') throw new Error('macOS Keychain is unavailable.');
    try {
      return await read();
    } catch (error) {
      if ((error as { code?: number }).code !== 44)
        throw new Error('The macOS Keychain could not be opened.');
    }
    if (options.canCreate && !(await options.canCreate()))
      throw new Error('The Vault key is missing from the macOS Keychain.');
    const key = randomBytes(32);
    try {
      await execute(
        '/usr/bin/security',
        ['add-generic-password', '-s', service, '-a', account, '-w', key.toString('base64')],
        { timeout: 15_000, maxBuffer: 4096 },
      );
      return key;
    } catch (error) {
      key.fill(0);
      if ((error as { code?: number }).code === 45) {
        try {
          return await read();
        } catch {}
      }
      throw new Error('The macOS Keychain could not save the credential key.');
    }
  }
  return {
    id: 'keychain',
    configured: platform === 'darwin',
    getKey() {
      pending ??= load().finally(() => {
        pending = undefined;
      });
      return pending.then((key) => Buffer.from(key));
    },
  };
}
