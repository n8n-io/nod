import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar';

const pending = new Map();
const hashPattern = /^[a-f0-9]{64}$/;
const maximumBytes = 8 * 1024 ** 3;
const criticalFiles = [
  'manifest.json',
  'lima/bin/limactl',
  'docker-host/docker/docker',
  'docker-guest.tar.gz',
];

export async function assetHash(path, signal) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
  return hash.digest('hex');
}

function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    /^[a-zA-Z0-9_./-]+$/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

export async function runtimeRelease(resourcesPath) {
  let release;
  try {
    release = JSON.parse(await readFile(join(resourcesPath, 'runtime-release.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error('The Otto runtime release information is damaged. Reinstall this app.');
  }
  return validateRuntimeRelease(release);
}

export function validateRuntimeRelease(release) {
  if (
    !release ||
    release.version !== 1 ||
    !['darwin-arm64', 'darwin-x64'].includes(release.platform) ||
    !hashPattern.test(release.id) ||
    !hashPattern.test(release.archive?.sha256) ||
    !Number.isSafeInteger(release.archive.bytes) ||
    release.archive.bytes < 1 ||
    release.archive.bytes > maximumBytes ||
    !Array.isArray(release.files) ||
    release.files.length > 5000 ||
    !release.files.length
  )
    throw new Error('This Otto runtime release is incompatible.');
  const paths = new Set();
  let total = 0;
  for (const file of release.files) {
    if (
      !validPath(file.path) ||
      paths.has(file.path) ||
      !hashPattern.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      ![0o644, 0o755].includes(file.mode)
    )
      throw new Error('The Otto runtime file manifest is invalid.');
    paths.add(file.path);
    total += file.bytes;
  }
  if (
    total > maximumBytes ||
    [
      ...criticalFiles,
      `lima/share/lima/lima-guestagent.Linux-${release.platform === 'darwin-x64' ? 'x86_64' : 'aarch64'}.gz`,
    ].some((path) => !paths.has(path))
  )
    throw new Error('The Otto runtime file manifest is incomplete.');
  if (createHash('sha256').update(JSON.stringify(release.files)).digest('hex') !== release.id)
    throw new Error('The Otto runtime content identifier does not match its files.');
  if (release.url) {
    const url = new URL(release.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('The Otto runtime download address is invalid.');
  }
  return release;
}

export const defaultRuntimeCache = join(homedir(), 'Library/Application Support/Otto/runtime');

export function runtimeCacheRoot(release, cacheRoot) {
  return join(cacheRoot || defaultRuntimeCache, release.id);
}

export async function removeUnusedRuntimes({
  current,
  keep = [],
  cacheRoot = defaultRuntimeCache,
  olderThan = Date.now() - 24 * 60 * 60 * 1000,
}) {
  if (dirname(current) !== cacheRoot) return [];
  const kept = new Set([current, ...keep]);
  const removed = [];
  for (const name of await readdir(cacheRoot).catch(() => [])) {
    const path = join(cacheRoot, name);
    if (
      kept.has(path) ||
      !/^[a-f0-9]{64}(\.install-[a-f0-9]{12}|\.[a-f0-9]{12}\.download)?$/.test(name)
    )
      continue;
    const metadata = await lstat(path).catch(() => undefined);
    if (!metadata || metadata.mtimeMs > olderThan) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function verifiedCache(release, signal, cacheRoot) {
  const root = runtimeCacheRoot(release, cacheRoot);
  try {
    const marker = JSON.parse(await readFile(join(root, '.ready.json'), 'utf8'));
    if (marker.id !== release.id) return undefined;
    for (const file of release.files) {
      const metadata = await lstat(join(root, file.path));
      if (
        !metadata.isFile() ||
        metadata.size !== file.bytes ||
        (metadata.mode & 0o7777) !== file.mode ||
        (await assetHash(join(root, file.path), signal)) !== file.sha256
      )
        return undefined;
    }
    return root;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'EACCES')
      throw new Error('Otto cannot read its saved runtime. Check this Mac’s storage permissions.');
    return undefined;
  }
}

export async function findRuntimeAssets({ resourcesPath, signal, cacheRoot, release: supplied }) {
  const release = supplied ? validateRuntimeRelease(supplied) : await runtimeRelease(resourcesPath);
  if (release) return verifiedCache(release, signal, cacheRoot);
  for (const root of [
    process.env.OTTO_RUNTIME_ASSETS,
    join(resourcesPath, 'runtime-assets'),
    join(resourcesPath, 'desktop/runtime/assets'),
    join(resourcesPath, '.local/desktop-runtime-assets'),
  ].filter(Boolean)) {
    try {
      await stat(join(root, 'manifest.json'));
      return resolve(root);
    } catch {}
  }
  return undefined;
}

async function verifyFiles(root, release, signal) {
  for (const file of release.files) {
    signal?.throwIfAborted();
    const path = join(root, file.path);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.size !== file.bytes ||
      (await assetHash(path, signal)) !== file.sha256
    )
      throw new Error('The Otto runtime pack failed its integrity check. Choose a fresh copy.');
    await chmod(path, file.mode);
  }
}

async function requireDiskSpace(release, directory, inspectDisk, downloading = false) {
  const { bavail, bsize } = await inspectDisk(directory, { bigint: true });
  const available = bavail > 0n ? bavail * bsize : 0n;
  const required = BigInt(
    release.files.reduce((total, file) => total + file.bytes, 0) +
      (downloading ? release.archive.bytes : 0) +
      512 * 1024 ** 2,
  );
  if (available < required)
    throw Object.assign(
      new Error(
        `Otto needs ${(Math.ceil((Number(required) / 1024 ** 3) * 10) / 10).toFixed(1)} GiB of free space to install its runtime. Free at least ${(Math.ceil((Number(required - available) / 1024 ** 3) * 100) / 100).toFixed(2)} GiB on this Mac, then retry. Your saved conversations and settings are kept.`,
      ),
      { code: 'RUNTIME_DISK_SPACE' },
    );
}

function installationError(error) {
  if (!['ENOSPC', 'EDQUOT'].includes(error.code)) return error;
  return Object.assign(
    new Error(
      'Otto ran out of disk space while installing its runtime. Free space on this Mac, then retry. Your saved conversations and settings are kept.',
    ),
    { code: 'RUNTIME_DISK_SPACE' },
  );
}

async function install(
  release,
  populate,
  { onStatus = () => {}, signal, cacheRoot, inspectDisk = statfs } = {},
) {
  const existing = await verifiedCache(release, signal, cacheRoot);
  if (existing) return existing;
  const root = runtimeCacheRoot(release, cacheRoot);
  const temporary = `${root}.install-${randomBytes(6).toString('hex')}`;
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    await requireDiskSpace(release, dirname(root), inspectDisk);
    await mkdir(temporary, { mode: 0o700 });
    await populate(temporary);
    onStatus({ phase: 'verifying', message: 'Checking your local computer…' });
    await verifyFiles(temporary, release, signal);
    await writeFile(join(temporary, '.ready.json'), JSON.stringify({ id: release.id }), {
      mode: 0o600,
    });
    signal?.throwIfAborted();
    await rm(root, { recursive: true, force: true });
    await rename(temporary, root);
    return root;
  } catch (error) {
    throw installationError(error);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function seedRuntimeCache({
  source,
  resourcesPath,
  onStatus,
  signal,
  cacheRoot,
  inspectDisk,
}) {
  const release = await runtimeRelease(resourcesPath);
  if (!release) throw new Error('This build has no managed runtime release.');
  return install(
    release,
    async (target) => {
      for (const file of release.files) {
        signal?.throwIfAborted();
        const origin = join(source, file.path);
        if (!(await lstat(origin)).isFile())
          throw new Error('The runtime source contains an unsupported file.');
        await mkdir(dirname(join(target, file.path)), { recursive: true, mode: 0o700 });
        await copyFile(origin, join(target, file.path), constants.COPYFILE_FICLONE);
      }
    },
    { onStatus, signal, cacheRoot, inspectDisk },
  );
}

export async function installRuntimeArchive({
  archivePath,
  resourcesPath,
  onStatus = () => {},
  signal,
  cacheRoot,
  inspectDisk,
  release: supplied,
}) {
  const release = supplied ? validateRuntimeRelease(supplied) : await runtimeRelease(resourcesPath);
  if (!release) throw new Error('This build has no managed runtime release.');
  const key = runtimeCacheRoot(release, cacheRoot);
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    onStatus({ phase: 'verifying', message: 'Checking your runtime pack…' });
    const metadata = await lstat(archivePath);
    if (
      !metadata.isFile() ||
      metadata.size !== release.archive.bytes ||
      (await assetHash(archivePath, signal)) !== release.archive.sha256
    )
      throw new Error('This runtime pack does not match your Otto app. Choose the matching pack.');
    return install(
      release,
      async (target) => {
        onStatus({ phase: 'installing', message: 'Installing your local computer…' });
        const expected = new Map(release.files.map((file) => [file.path, file]));
        const seen = new Set();
        let invalid = false;
        let expanded = 0;
        const limit = release.files.reduce(
          (size, file) => size + Math.ceil(file.bytes / 512) * 512 + 4096,
          1024 * 1024,
        );
        const bounded = new Transform({
          transform(chunk, encoding, callback) {
            expanded += chunk.length;
            callback(
              expanded > limit
                ? new Error('The runtime pack exceeds its expected expanded size.')
                : null,
              chunk,
            );
          },
        });
        const unpack = extract({
          cwd: target,
          strict: true,
          preservePaths: false,
          noMtime: true,
          gzip: false,
          filter(path, entry) {
            const file = expected.get(path);
            if (!file || seen.has(path) || entry.type !== 'File' || entry.size !== file.bytes) {
              invalid = true;
              return false;
            }
            seen.add(path);
            return true;
          },
        });
        await pipeline(createReadStream(archivePath), createGunzip(), bounded, unpack, { signal });
        if (invalid || seen.size !== expected.size)
          throw new Error('The runtime pack contains unexpected files.');
      },
      { onStatus, signal, cacheRoot, inspectDisk },
    );
  })().finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function downloadRuntime(release, options) {
  const { resourcesPath, onStatus = () => {}, signal, cacheRoot, inspectDisk = statfs } = options;
  const directory = dirname(runtimeCacheRoot(release, cacheRoot));
  const path = join(directory, `${release.id}.${randomBytes(6).toString('hex')}.download`);
  const downloadSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30 * 60_000),
  ]);
  let url = options.downloadUrl || release.url;
  const address = new URL(url);
  if (address.protocol !== 'https:' || address.username || address.password)
    throw new Error('The Otto runtime download address is invalid.');
  try {
    downloadSignal.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await requireDiskSpace(release, directory, inspectDisk, true);
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await (options.fetch || fetch)(url, {
        signal: downloadSignal,
        redirect: 'manual',
        headers: { accept: 'application/octet-stream' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = new URL(response.headers.get('location') || '', url);
      await response.body?.cancel();
      if (next.protocol !== 'https:' || next.username || next.password)
        throw new Error('Otto received an unsafe runtime download address.');
      url = next.href;
    }
    if (!response?.ok || !response.body)
      throw new Error('The Otto runtime download is unavailable. Try again.');
    let bytes = 0;
    let reported = 0;
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > release.archive.bytes)
          return callback(new Error('The runtime download exceeds its expected size.'));
        if (Date.now() - reported > 250) {
          reported = Date.now();
          onStatus({
            phase: 'downloading',
            message: 'Downloading your local computer…',
            progress: bytes / release.archive.bytes,
          });
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      createWriteStream(path, { mode: 0o600, flags: 'wx' }),
      { signal: downloadSignal },
    );
    return await installRuntimeArchive({
      archivePath: path,
      resourcesPath,
      onStatus,
      signal: downloadSignal,
      cacheRoot,
      inspectDisk,
      release,
    });
  } catch (error) {
    throw installationError(error);
  } finally {
    await rm(path, { force: true });
  }
}

export async function ensureRuntimeAssets(options) {
  const found = await findRuntimeAssets(options);
  if (found) return found;
  const release = options.release
    ? validateRuntimeRelease(options.release)
    : await runtimeRelease(options.resourcesPath);
  let downloadUrl = options.downloadUrl || release?.url;
  if (release && !downloadUrl && options.resolveDownloadUrl) {
    options.signal?.throwIfAborted();
    options.onStatus?.({ phase: 'downloading', message: 'Finding your local computer…' });
    downloadUrl = await options.resolveDownloadUrl(release, options.signal);
    options.signal?.throwIfAborted();
  }
  if (release && downloadUrl) return downloadRuntime(release, { ...options, downloadUrl });
  throw Object.assign(new Error('Choose the Otto Runtime pack to finish setting up this Mac.'), {
    code: 'RUNTIME_ARCHIVE_REQUIRED',
  });
}

export async function prepareRuntimeUpdate(release, options) {
  validateRuntimeRelease(release);
  const current = await runtimeRelease(options.resourcesPath);
  if (current?.id === release.id) {
    if (!isDeepStrictEqual({ ...current, url: undefined }, { ...release, url: undefined }))
      throw new Error(
        'The update changed the installed runtime descriptor without changing its ID.',
      );
    const found = await verifiedCache(current, options.signal, options.cacheRoot);
    if (!found) throw new Error('The installed runtime could not be verified.');
    return found;
  }
  return ensureRuntimeAssets({ ...options, release });
}
