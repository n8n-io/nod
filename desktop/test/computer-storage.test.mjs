import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSettingsStore } from '../main/settings.mjs';

import {
  preloadRuntimeImages,
  removeComputer,
  removeUnmountedRuntimes,
} from '../runtime/index.mjs';
import { removeWindowsComputer } from '../runtime/windows.mjs';
import {
  computerIdentity,
  assertComputerStoragePathSafe,
  computerStoragePath,
  validateComputerDirectory,
} from '../runtime/computer-storage.mjs';

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nod-computer-storage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('legacy private-computer locations remain unchanged when no custom folder is set', async (t) => {
  const root = await temporary(t);
  const home = join(root, 'home');
  const profile = join(root, 'profile');
  const identity = computerIdentity(profile);

  assert.equal(
    computerStoragePath(profile, undefined, { platform: 'darwin', home }),
    join(home, '.nod-desktop', identity),
  );
  assert.equal(
    computerStoragePath(profile, null, { platform: 'win32', home }),
    join(profile, 'desktop-runtime', 'wsl'),
  );
});

test('custom folders keep each profile in its own private computer directory', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  const profileA = join(root, 'profile-a');
  const profileB = join(root, 'profile-b');
  await mkdir(directory);

  assert.equal(
    computerStoragePath(profileA, directory, { platform: 'darwin' }),
    join(directory, '.nod-desktop', computerIdentity(profileA)),
  );
  assert.equal(
    computerStoragePath(profileB, directory, { platform: 'linux' }),
    join(directory, '.nod-desktop', computerIdentity(profileB)),
  );
  assert.notEqual(
    computerStoragePath(profileA, directory, { platform: 'linux' }),
    computerStoragePath(profileB, directory, { platform: 'linux' }),
  );
  assert.equal(
    computerStoragePath(profileA, directory, { platform: 'win32' }),
    join(directory, '.nod-desktop', computerIdentity(profileA), 'wsl'),
  );
});

test('a selected folder must exist, be a directory, and be separate from app data', async (t) => {
  const root = await temporary(t);
  const profile = join(root, 'profile');
  const directory = join(root, 'external');
  const file = join(root, 'not-a-folder');
  await mkdir(profile);
  await mkdir(directory);
  await writeFile(file, 'not a directory');

  const options = { dataRoot: profile, minimumFreeBytes: 0 };
  assert.equal(await validateComputerDirectory(directory, options), directory);
  await assert.rejects(validateComputerDirectory(file, options), /choose a folder/);
  await assert.rejects(validateComputerDirectory(join(root, 'missing'), options), /cannot use/);
  await assert.rejects(validateComputerDirectory(profile, options), /separate from Nod's application data/);
  assert.equal(await validateComputerDirectory(root, options), root);
});

test('a selected folder must be writable and have the required free space', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  await mkdir(directory);

  await assert.rejects(
    validateComputerDirectory(directory, {
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /needs at least .* GB free/,
  );

  await assert.rejects(
    validateComputerDirectory(directory, {
      statfsImpl: async () => ({ bavail: 49 * 1024 ** 3, bsize: 1 }),
    }),
    /needs at least 50 GB free/,
  );

  const valid = await validateComputerDirectory(directory, {
    minimumFreeBytes: 0,
    statfsImpl: async () => ({ bavail: 0, bsize: 1 }),
  });
  assert.equal(valid, directory);
  await assert.rejects(
    validateComputerDirectory(directory, {
      minimumFreeBytes: 0,
      openImpl: async () => {
        throw new Error('permission denied');
      },
    }),
    /cannot create files/,
  );
});

test('Flatpak accepts only its already granted storage roots', async (t) => {
  const root = await temporary(t);
  const home = join(root, 'home');
  const allowed = join(home, 'Computer');
  const elsewhere = join(root, 'mnt', 'computer');
  await mkdir(allowed, { recursive: true });
  await mkdir(elsewhere, { recursive: true });

  const base = {
    platform: 'linux',
    flatpak: true,
    home,
    minimumFreeBytes: 0,
  };
  assert.equal(await validateComputerDirectory(allowed, base), allowed);
  await assert.rejects(
    validateComputerDirectory(elsewhere, base),
    /inside Flatpak/,
  );
});

test('a symbolic-link selection is resolved to its real folder before use', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'real');
  const link = join(root, 'linked');
  await mkdir(directory);
  await symlink(directory, link);

  assert.equal(
    await validateComputerDirectory(link, { minimumFreeBytes: 0 }),
    directory,
  );
});

test('default computer storage rejects a symlinked namespace before startup and removal', async (t) => {
  const root = await temporary(t);
  const dataRoot = join(root, 'profile');
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  await mkdir(dataRoot);
  await mkdir(home);
  await mkdir(outside);
  await symlink(outside, join(home, '.nod-desktop'));

  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, undefined, { platform: 'linux', home }),
    /not a normal directory/,
  );

  await rm(join(home, '.nod-desktop'), { recursive: true, force: true });
  await symlink(outside, join(dataRoot, 'desktop-runtime'));
  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, undefined, { platform: 'win32', home }),
    /not a normal directory/,
  );
});

test('custom computer namespaces reject symbolic links before Lima or WSL can follow them', async (t) => {
  const root = await temporary(t);
  const dataRoot = join(root, 'profile');
  const directory = join(root, 'external');
  const outside = join(root, 'outside');
  await mkdir(dataRoot);
  await mkdir(directory);
  await mkdir(outside);

  await symlink(outside, join(directory, '.nod-desktop'));
  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, directory),
    /not a normal directory/,
  );

  await rm(join(directory, '.nod-desktop'), { force: true });
  await mkdir(join(directory, '.nod-desktop'));
  await symlink(outside, join(directory, '.nod-desktop', computerIdentity(dataRoot)));
  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, directory),
    /not a normal directory/,
  );

  await rm(join(directory, '.nod-desktop', computerIdentity(dataRoot)), { force: true });
  await mkdir(join(directory, '.nod-desktop', computerIdentity(dataRoot)));
  await symlink(outside, join(directory, '.nod-desktop', computerIdentity(dataRoot), 'nod'));
  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, directory, { platform: 'linux' }),
    /not a normal directory/,
  );

  await rm(join(directory, '.nod-desktop', computerIdentity(dataRoot), 'nod'), { force: true });
  await symlink(outside, join(directory, '.nod-desktop', computerIdentity(dataRoot), 'wsl'));
  await assert.rejects(
    assertComputerStoragePathSafe(dataRoot, directory, { platform: 'win32' }),
    /not a normal directory/,
  );
});

test('runtime image preloading uses the selected private-computer Docker socket', async (t) => {
  const root = await temporary(t);
  const dataRoot = join(root, 'profile');
  const home = join(root, 'home');
  const directory = join(root, 'selected');
  const assets = join(root, 'assets');
  const imagePath = join(assets, 'images/workspace.tar.zst');
  const image = Buffer.from('Nod runtime image fixture');
  const digest = createHash('sha256').update(image).digest('hex');
  await mkdir(join(assets, 'images'), { recursive: true });
  await writeFile(imagePath, image);
  await writeFile(
    join(assets, 'manifest.json'),
    JSON.stringify({
      images: [
        {
          name: 'workspace',
          id: `sha256:${'a'.repeat(64)}`,
          file: 'images/workspace.tar.zst',
          sha256: digest,
          reference: 'nod/workspace:test',
        },
      ],
    }),
  );

  const calls = [];
  await preloadRuntimeImages({
    dataRoot,
    assets,
    computerDirectory: directory,
    platform: 'linux',
    home,
    executeImpl: async (_command, args, { env }) => {
      calls.push({ args, env });
      return '';
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].env.DOCKER_HOST,
    `unix://${join(
      computerStoragePath(dataRoot, directory, { platform: 'linux', home }),
      'nod/sock/docker.sock',
    )}`,
  );
});

test('desktop settings persist and validate the selected private-computer folder', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'external');
  await mkdir(directory);
  const store = createSettingsStore(join(root, 'settings.json'), {});

  assert.equal((await store.get()).computerDirectory, undefined);
  await store.save({ computerDirectory: directory });
  assert.equal((await store.get()).computerDirectory, directory);

  await assert.rejects(store.save({ computerDirectory: 'relative/folder' }), /valid private-computer storage folder/);
  await assert.rejects(
    store.save({ computerDirectory: `${directory}/../external` }),
    /valid private-computer storage folder/,
  );

  await store.save({ computerDirectory: null });
  assert.equal((await store.get()).computerDirectory, undefined);
});

test(
  'removing a custom private computer clears its runtime identity but keeps app data and other profiles',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temporary(t);
    const profile = join(root, 'profile');
    const directory = join(root, 'external');
    const otherProfile = join(root, 'other-profile');
    const runtime = join(profile, 'desktop-runtime');
    const ownComputer = computerStoragePath(profile, directory);
    const otherComputer = computerStoragePath(otherProfile, directory);
    const runtimeAssets = join(root, 'runtime-assets');
    const lima = join(runtimeAssets, 'lima/bin/limactl');
    const commandLog = join(root, 'limactl.log');
    await mkdir(runtime, { recursive: true });
    await mkdir(ownComputer, { recursive: true });
    await mkdir(otherComputer, { recursive: true });
    await mkdir(join(ownComputer, 'nod'), { recursive: true });
    await mkdir(directory, { recursive: true });
    await mkdir(join(runtimeAssets, 'lima/bin'), { recursive: true });
    await writeFile(join(runtimeAssets, 'manifest.json'), '{}');
    await writeFile(join(ownComputer, 'nod/lima.yaml'), 'synthetic Lima config');
    const quote = (value) => `'${value.replaceAll("'", "'\\\\''")}'`;
    await writeFile(
      lima,
      `#!/bin/sh\ntest -d "$LIMA_HOME" || exit 23\nprintf '%s\n' "$*" >> ${quote(commandLog)}\n`,
    );
    await chmod(lima, 0o700);
    await writeFile(join(runtime, 'state.json'), JSON.stringify({ limaHome: ownComputer }));
    await writeFile(
      join(profile, 'settings.json'),
      JSON.stringify({ computerDirectory: directory }),
    );
    await writeFile(join(ownComputer, 'synthetic-disk'), 'old computer');
    await writeFile(join(otherComputer, 'synthetic-disk'), 'other profile');

    await removeComputer({
      dataRoot: profile,
      resourcesPath: root,
      computerDirectory: directory,
    });

    assert.equal(await readFile(commandLog, 'utf8'), 'delete --force nod\\n');
    await assert.rejects(readFile(join(runtime, 'state.json')));
    assert.equal(
      await readFile(join(profile, 'settings.json'), 'utf8'),
      JSON.stringify({ computerDirectory: directory }),
    );
    assert.equal(await readFile(join(otherComputer, 'synthetic-disk'), 'utf8'), 'other profile');
    await assert.rejects(readFile(join(ownComputer, 'synthetic-disk')));
  },
);

test('Windows cleanup removes the selected folder when WSL listing fails', async (t) => {
  const root = await temporary(t);
  const dataRoot = join(root, 'profile');
  const computerDirectory = join(root, 'external');
  const computerPath = computerStoragePath(dataRoot, computerDirectory, { platform: 'win32' });
  const profileStorage = join(
    computerDirectory,
    '.nod-desktop',
    createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 12),
  );
  const distribution = `nod-${createHash('sha256').update(dataRoot.toLowerCase()).digest('hex').slice(0, 12)}`;
  await mkdir(join(dataRoot, 'desktop-runtime'), { recursive: true });
  await mkdir(computerPath, { recursive: true });
  await writeFile(join(computerPath, 'disk.vhdx'), 'synthetic WSL disk');
  await writeFile(
    join(dataRoot, 'desktop-runtime/state.json'),
    JSON.stringify({ version: 1, distribution, computerPath }),
  );

  let unregisterCalls = 0;
  await removeWindowsComputer(dataRoot, computerDirectory, {
    getEnvironment: () => ({ SYSTEMROOT: 'C:\\Windows' }),
    listDistributions: async () => {
      throw new Error('wsl --list failed');
    },
    executeCommand: async () => {
      unregisterCalls++;
      return '';
    },
  });

  assert.equal(unregisterCalls, 0);
  await assert.rejects(access(computerPath), { code: 'ENOENT' });
  await assert.rejects(access(profileStorage), { code: 'ENOENT' });
});

test('runtime image preloading rejects a symlinked custom namespace before contacting Docker', async (t) => {
  const root = await temporary(t);
  const dataRoot = join(root, 'profile');
  const directory = join(root, 'selected');
  const outside = join(root, 'outside');
  await mkdir(dataRoot);
  await mkdir(directory);
  await mkdir(outside);
  await symlink(outside, join(directory, '.nod-desktop'));

  let dockerCalls = 0;
  await assert.rejects(
    preloadRuntimeImages({
      dataRoot,
      assets: join(root, 'assets'),
      computerDirectory: directory,
      platform: 'linux',
      home: join(root, 'home'),
      executeImpl: async () => {
        dockerCalls++;
        return '';
      },
    }),
    /not a normal directory/,
  );
  assert.equal(dockerCalls, 0);
});

test('runtime cleanup keeps packs mounted by sibling custom profiles', async (t) => {
  const root = await temporary(t);
  const directory = join(root, 'selected');
  const cacheRoot = join(root, 'runtime-cache');
  const current = join(cacheRoot, 'a'.repeat(64));
  const retained = join(cacheRoot, 'b'.repeat(64));
  const stale = join(cacheRoot, 'c'.repeat(64));
  const siblingLima = join(directory, '.nod-desktop', 'another-profile', 'nod');
  await mkdir(current, { recursive: true });
  await mkdir(retained, { recursive: true });
  await mkdir(stale, { recursive: true });
  await mkdir(siblingLima, { recursive: true });
  await writeFile(join(retained, 'marker'), 'keep');
  await writeFile(join(stale, 'marker'), 'remove');
  await writeFile(
    join(siblingLima, 'lima.yaml'),
    JSON.stringify({ mounts: [{ location: retained }] }),
  );

  await removeUnmountedRuntimes(current, {
    computerDirectory: directory,
    home: join(root, 'home'),
    cacheRoot,
    olderThan: Date.now() + 60_000,
  });

  assert.equal(await readFile(join(retained, 'marker'), 'utf8'), 'keep');
  await assert.rejects(readFile(join(stale, 'marker')));
});
