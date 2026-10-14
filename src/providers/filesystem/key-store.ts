import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import { parseCredentialKey } from '../environment/key-store.ts';

export function createFilesystemKeyStore(options: {
  dataRoot: string;
  canCreate(): Promise<boolean>;
}): CredentialKeyStore {
  let pending: Promise<Buffer> | undefined;
  async function load() {
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(options.dataRoot);
    const directory = join(root, 'vault');
    for (const [path, mask] of [
      [root, 0o022],
      [directory, 0o077],
    ] as const) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const metadata = await lstat(path);
      if (
        !metadata.isDirectory() ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (metadata.mode & mask) !== 0
      )
        throw new Error('The Vault key directory permissions are unsafe.');
    }
    const path = join(directory, 'master-key');
    async function read() {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await file.stat();
        const current = await lstat(path);
        if (
          !metadata.isFile() ||
          !current.isFile() ||
          metadata.dev !== current.dev ||
          metadata.ino !== current.ino ||
          (process.getuid && metadata.uid !== process.getuid()) ||
          (metadata.mode & 0o077) !== 0 ||
          metadata.size > 128
        )
          throw new Error('The Vault key file permissions are unsafe.');
        for (let path = directory; ; path = dirname(path)) {
          if (path !== directory && path !== root) {
            try {
              await access(path, constants.W_OK);
            } catch (error) {
              if (
                ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')
              )
                break;
              throw error;
            }
          }
          const parent = await open(
            path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          if (dirname(path) === path) break;
        }
        return parseCredentialKey(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
    }
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!(await options.canCreate())) throw new Error('The Vault key file is missing.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      const key = randomBytes(32);
      try {
        await file.writeFile(key.toString('base64'));
        await file.sync();
      } finally {
        key.fill(0);
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return read();
  }
  return {
    id: 'filesystem',
    configured: true,
    getKey() {
      pending ??= load().finally(() => {
        pending = undefined;
      });
      return pending.then((key) => Buffer.from(key));
    },
  };
}
