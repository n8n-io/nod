import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ObjectStoreConflict, type PrivateObjectStore } from '../../ports/object-storage.ts';
import {
  maxObjectBytes,
  objectFailure,
  objectKey,
  objectLimit,
} from '../../ports/object-storage-validation.ts';

const writers = new Map<string, Promise<void>>();
const staleLockMs = 30_000;

async function serial<T>(target: string, action: () => Promise<T>) {
  const previous = writers.get(target) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const current = previous.then(() => gate);
  writers.set(target, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writers.get(target) === current) writers.delete(target);
  }
}

async function abandoned(lock: string) {
  try {
    const file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, { buffer, bytesRead }] = await Promise.all([
      file.stat(),
      file.read(Buffer.alloc(16), 0, 16, 0),
    ]).finally(() => file.close());
    if (Date.now() - info.mtimeMs > staleLockMs) return true;
    const pid = Number(buffer.subarray(0, bytesRead).toString());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function claim(lock: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(lock, 'wx', 0o600);
      try {
        await file.writeFile(String(process.pid));
        return file;
      } catch (error) {
        await file.close().finally(() => rm(lock, { force: true }));
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 40) throw error;
    }
    if (await abandoned(lock)) await rm(lock, { force: true });
    else await delay(50);
  }
}

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
    return serial(target, async () => {
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await verifyDirectory(key);
        const lock = await claim(target + '.lock');
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
    });
  }
  return {
    read,
    write: (key, bytes, { expectedVersion }) =>
      exclusive(key, async () => {
        if (bytes.byteLength > maxObjectBytes) throw objectFailure();
        const current = await read(key, maxObjectBytes);
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
        const current = await read(key, maxObjectBytes);
        if (options?.expectedVersion !== undefined && current?.version !== options.expectedVersion)
          throw new ObjectStoreConflict();
        await rm(path(key), { force: true });
      }),
  };
}
