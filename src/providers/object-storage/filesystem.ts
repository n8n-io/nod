import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ObjectStoreConflict, type PrivateObjectStore } from '../../ports/object-storage.ts';
import { objectFailure, objectKey, objectLimit } from '../../ports/object-storage-validation.ts';
import { fileBytes } from '../../shared/files.ts';

export function createFilesystemObjectStore(root: string): PrivateObjectStore {
  const directory = resolve(root);
  const path = (key: string) => join(directory, objectKey(key));
  async function verifyDirectory(key: string) {
    const root = await realpath(directory);
    if ((await realpath(dirname(path(key)))) !== join(root, dirname(key))) throw objectFailure();
  }
  const version = (bytes: Uint8Array) =>
    '"' + createHash('sha256').update(bytes).digest('hex') + '"';
  async function read(key: string, maximum: number) {
    objectLimit(maximum);
    const target = path(key);
    let file;
    try {
      await verifyDirectory(key);
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw objectFailure();
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw objectFailure();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!chunk.bytesRead) throw objectFailure();
        offset += chunk.bytesRead;
      }
      if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw objectFailure();
      return { bytes, version: version(bytes) };
    } catch {
      throw objectFailure();
    } finally {
      await file.close().catch(() => {
        throw objectFailure();
      });
    }
  }
  async function exclusive<T>(key: string, action: () => Promise<T>) {
    const target = path(key);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await verifyDirectory(key);
      const lock = await open(target + '.lock', 'wx', 0o600);
      try {
        return await action();
      } finally {
        try {
          await lock.close();
        } finally {
          await rm(target + '.lock', { force: true });
        }
      }
    } catch (error) {
      if (error instanceof ObjectStoreConflict) throw error;
      throw objectFailure();
    }
  }
  return {
    read,
    write: (key, bytes, { expectedVersion }) =>
      exclusive(key, async () => {
        if (bytes.byteLength > fileBytes) throw objectFailure();
        const current = await read(key, fileBytes);
        if ((current?.version ?? null) !== expectedVersion) throw new ObjectStoreConflict();
        const temporary = path(key) + '.' + randomUUID();
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path(key));
          const parent = await open(
            dirname(path(key)),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          return version(bytes);
        } finally {
          await rm(temporary, { force: true });
        }
      }),
    remove: (key, options) =>
      exclusive(key, async () => {
        const current = await read(key, fileBytes);
        if (options?.expectedVersion !== undefined && current?.version !== options.expectedVersion)
          throw new ObjectStoreConflict();
        await rm(path(key), { force: true });
      }),
  };
}
