import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath, rm, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MINIMUM_COMPUTER_STORAGE_BYTES = 50 * 1024 ** 3;

export function computerIdentity(dataRoot) {
  return createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 12);
}

export function computerStoragePath(
  dataRoot,
  computerDirectory,
  { platform = process.platform, home = homedir() } = {},
) {
  const profile = resolve(dataRoot);
  const identity = computerIdentity(profile);
  if (platform === 'win32') {
    return computerDirectory
      ? join(resolve(computerDirectory), '.nod-desktop', identity, 'wsl')
      : join(profile, 'desktop-runtime', 'wsl');
  }
  return computerDirectory
    ? join(resolve(computerDirectory), '.nod-desktop', identity)
    : join(home, '.nod-desktop', identity);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function flatpakAllows(directory, { home }) {
  return [home, '/media', '/run/media'].some((root) => isWithin(resolve(root), directory));
}

export async function validateComputerDirectory(
  value,
  {
    dataRoot,
    home = homedir(),
    platform = process.platform,
    flatpak = Boolean(process.env.FLATPAK_ID),
    minimumFreeBytes = MINIMUM_COMPUTER_STORAGE_BYTES,
    statfsImpl = statfs,
    openImpl = open,
  } = {},
) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || !isAbsolute(value)) {
    throw new Error('Choose an absolute folder path for the private computer.');
  }

  const requested = resolve(value);
  let metadata;
  try {
    metadata = await stat(requested);
  } catch (error) {
    throw new Error(`Nod cannot use "${requested}": ${error.message}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Nod cannot use "${requested}": choose a folder, not a file.`);
  }

  let directory;
  try {
    directory = await realpath(requested);
  } catch (error) {
    throw new Error(`Nod cannot resolve "${requested}": ${error.message}`);
  }

  if (dataRoot) {
    const profile = await realpath(resolve(dataRoot));
    if (isWithin(profile, directory)) {
      throw new Error(
        `Nod cannot use "${directory}": choose a folder separate from Nod's application data.`,
      );
    }
  }

  if (platform === 'linux' && flatpak && !flatpakAllows(directory, { home })) {
    throw new Error(
      `Nod cannot access "${directory}" inside Flatpak. Choose a folder under your home directory, /media, or /run/media.`,
    );
  }

  try {
    await access(directory, constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`Nod cannot write to "${directory}": ${error.message}`);
  }

  const probe = join(directory, `.nod-storage-check-${randomUUID()}.tmp`);
  try {
    const file = await openImpl(probe, 'wx', 0o600);
    try {
      await file.writeFile('Nod storage check');
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    await rm(probe, { force: true }).catch(() => {});
    throw new Error(`Nod cannot create files in "${directory}": ${error.message}`);
  }
  await rm(probe, { force: true });

  let available;
  try {
    const space = await statfsImpl(directory);
    available = Number(space.bavail) * Number(space.bsize);
  } catch (error) {
    throw new Error(`Nod cannot check free space in "${directory}": ${error.message}`);
  }
  if (!Number.isFinite(available) || available < minimumFreeBytes) {
    const free = Number.isFinite(available) ? (available / 1024 ** 3).toFixed(1) : 'unknown';
    const required = (minimumFreeBytes / 1024 ** 3).toFixed(0);
    throw new Error(
      `Nod needs at least ${required} GB free in "${directory}". This folder has ${free} GB available.`,
    );
  }

  return directory;
}

export async function assertComputerDirectoryReady(directory, options = {}) {
  return validateComputerDirectory(directory, options);
}

export async function assertComputerStoragePathSafe(
  dataRoot,
  computerDirectory,
  { platform = process.platform, home = homedir() } = {},
) {
  const namespace = computerDirectory
    ? join(resolve(computerDirectory), '.nod-desktop')
    : platform === 'win32'
      ? join(resolve(dataRoot), 'desktop-runtime')
      : join(home, '.nod-desktop');
  const profileDirectory =
    platform === 'win32' && !computerDirectory
      ? computerStoragePath(dataRoot, undefined, { platform, home })
      : join(namespace, computerIdentity(dataRoot));
  const runtimeDirectory =
    platform === 'win32'
      ? computerDirectory
        ? join(profileDirectory, 'wsl')
        : profileDirectory
      : join(profileDirectory, 'nod');
  const components = [namespace, profileDirectory];
  if (runtimeDirectory !== profileDirectory) components.push(runtimeDirectory);

  for (const path of components) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw new Error(`Nod cannot inspect its private-computer folder "${path}": ${error.message}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Nod cannot use "${path}" because a private-computer storage folder is not a normal directory. Rename or remove that entry, then try again.`,
      );
    }
  }
}
