import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialKeyStore } from '../ports/key-store.ts';
import type { SetupJournal } from '../ports/setup.ts';
import { openVaultValue, sealVaultValue } from './vault-crypto.ts';

const snapshotSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    ownerId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    frozen: z.boolean(),
    sections: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SetupSnapshot = z.infer<typeof snapshotSchema>;
const limit = 4 * 1024 * 1024;

export async function createSetupJournal(options: {
  root: string;
  ownerId: string;
  keyStore: CredentialKeyStore;
  create?: boolean;
}) {
  if (!options.keyStore.configured) throw new Error('Secure storage is unavailable.');
  const key = Buffer.from(await options.keyStore.getKey());
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await realpath(options.root);
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    (process.getuid && rootInfo.uid !== process.getuid()) ||
    (process.platform !== 'win32' && rootInfo.mode & 0o022)
  )
    throw new Error('The setup profile is not private.');
  const directory = join(root, 'onboarding');
  const path = join(directory, 'pending');
  const binding = ['otto-desktop-setup-v1', options.ownerId];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    (process.getuid && directoryInfo.uid !== process.getuid()) ||
    (process.platform !== 'win32' && directoryInfo.mode & 0o077)
  )
    throw new Error('The setup directory is not private.');
  async function syncDirectory(path: string) {
    if (process.platform === 'win32') return;
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  await syncDirectory(root);
  let state: SetupSnapshot;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > limit ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== 'win32' && info.mode & 0o077)
      )
        throw new Error('The setup journal is not private.');
      state = snapshotSchema.parse(
        JSON.parse(openVaultValue(key, binding, await file.readFile('utf8'))),
      );
      if (state.ownerId !== options.ownerId)
        throw new Error('The setup journal belongs to another profile.');
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.create === false) throw error;
    state = {
      version: 1,
      id: randomUUID(),
      ownerId: options.ownerId,
      revision: 0,
      frozen: false,
      sections: {},
    };
  }
  for (const entry of await readdir(directory))
    if (/^\.pending-[a-f0-9-]{36}$/.test(entry)) await rm(join(directory, entry), { force: true });
  let pending = Promise.resolve();
  let closed = false;
  let failed = false;
  function exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = pending.then(action);
    pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async function persist(next: SetupSnapshot) {
    const value = sealVaultValue(key, binding, JSON.stringify(next));
    if (Buffer.byteLength(value) > limit) throw new Error('The setup journal is too large.');
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(value);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, path);
        state = next;
        await syncDirectory(directory);
      } catch (error) {
        failed = true;
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const journal: SetupJournal = {
    read<T>(section: string) {
      return exclusive(async () => structuredClone(state.sections[section]) as T | undefined);
    },
    update<T>(section: string, change: (current: T | undefined) => T) {
      return exclusive(async () => {
        if (closed || failed || state.frozen)
          throw new Error('Setup is being transferred to Otto.');
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(section)) throw new Error('Invalid setup section.');
        const value = change(structuredClone(state.sections[section]) as T | undefined);
        await persist({
          ...state,
          revision: state.revision + 1,
          sections: { ...state.sections, [section]: value },
        });
        return structuredClone(value);
      });
    },
  };
  return {
    ...journal,
    snapshot: () => exclusive(async () => structuredClone(state)),
    freeze: () =>
      exclusive(async () => {
        if (failed || closed) throw new Error('Reopen Otto to continue setup.');
        if (!state.frozen) await persist({ ...state, frozen: true, revision: state.revision + 1 });
        return structuredClone(state);
      }),
    discard: (id: string) =>
      exclusive(async () => {
        if (id !== state.id || !state.frozen) throw new Error('Setup has not been acknowledged.');
        closed = true;
        await rm(path, { force: true });
        await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
        });
        await syncDirectory(root);
      }),
    close: () =>
      exclusive(async () => {
        closed = true;
        key.fill(0);
      }),
  };
}
