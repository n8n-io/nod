import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
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
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { Parser } from 'tar';

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
    throw new Error('The Nod runtime release information is damaged. Reinstall this app.');
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
    throw new Error('This Nod runtime release is incompatible.');
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
      throw new Error('The Nod runtime file manifest is invalid.');
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
    throw new Error('The Nod runtime file manifest is incomplete.');
  for (const path of paths)
    if (
      path
        .split('/')
        .slice(0, -1)
        .some((_, index, parts) => paths.has(parts.slice(0, index + 1).join('/')))
    )
      throw new Error('The Nod runtime file manifest has conflicting paths.');
  if (createHash('sha256').update(JSON.stringify(release.files)).digest('hex') !== release.id)
    throw new Error('The Nod runtime content identifier does not match its files.');
  if (release.url) {
    const url = new URL(release.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('The Nod runtime download address is invalid.');
  }
  return release;
}

export const defaultRuntimeCache = join(homedir(), 'Library/Application Support/nod/runtime');

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

function runtimeDirectories(root, release) {
  const directories = new Set([root]);
  for (const file of release.files) {
    let directory = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      directories.add(directory);
    }
  }
  return directories;
}

async function verifiedCache(release, signal, cacheRoot) {
  const root = runtimeCacheRoot(release, cacheRoot);
  try {
    for (const directory of runtimeDirectories(root, release))
      if (!(await lstat(directory)).isDirectory()) return undefined;
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
      throw new Error('Nod cannot read its saved runtime. Check this Mac’s storage permissions.');
    return undefined;
  }
}

export async function findRuntimeAssets({ resourcesPath, signal, cacheRoot, release: supplied }) {
  const release = supplied ? validateRuntimeRelease(supplied) : await runtimeRelease(resourcesPath);
  if (release) return verifiedCache(release, signal, cacheRoot);
  for (const root of [
    process.env.NOD_RUNTIME_ASSETS,
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
      throw new Error('The Nod runtime pack failed its integrity check. Choose a fresh copy.');
    await chmod(path, file.mode);
  }
}

async function reusableFiles(root, release, signal) {
  const paths = new Set(release.files.map((file) => join(root, file.path)));
  const directories = runtimeDirectories(root, release);
  if (!(await lstat(root).catch(() => undefined))?.isDirectory())
    await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  async function clean(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (directories.has(path) && entry.isDirectory()) await clean(path);
      else if (!paths.has(path) || !entry.isFile())
        await rm(path, { recursive: true, force: true });
    }
  }
  await clean(root);
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  const reused = new Set();
  for (const file of release.files) {
    signal?.throwIfAborted();
    const path = join(root, file.path);
    const metadata = await lstat(path).catch(() => undefined);
    if (
      metadata?.isFile() &&
      metadata.size === file.bytes &&
      (metadata.mode & 0o7777) === file.mode &&
      (await assetHash(path, signal)) === file.sha256
    )
      reused.add(file.path);
    else await rm(path, { force: true });
  }
  return reused;
}

async function freeSpace(directory, inspectDisk) {
  const { bavail, bsize } = await inspectDisk(directory, { bigint: true });
  return bavail > 0n ? bavail * bsize : 0n;
}

function installSpace(release, reused = new Set()) {
  return BigInt(
    release.files.reduce((total, file) => total + (reused.has(file.path) ? 0 : file.bytes), 0) +
      512 * 1024 ** 2,
  );
}

async function requireDiskSpace(release, directory, inspectDisk, reused) {
  const available = await freeSpace(directory, inspectDisk);
  const required = installSpace(release, reused);
  if (available < required)
    throw Object.assign(
      new Error(
        `Nod needs ${(Math.ceil((Number(required) / 1024 ** 3) * 10) / 10).toFixed(1)} GiB of free space to install its runtime. Free at least ${(Math.ceil((Number(required - available) / 1024 ** 3) * 100) / 100).toFixed(2)} GiB on this Mac, then retry. Your saved conversations and settings are kept.`,
      ),
      { code: 'RUNTIME_DISK_SPACE' },
    );
}

function installationError(error) {
  if (!['ENOSPC', 'EDQUOT'].includes(error.code)) return error;
  return Object.assign(
    new Error(
      'Nod ran out of disk space while installing its runtime. Free space on this Mac, then retry. Your saved conversations and settings are kept.',
    ),
    { code: 'RUNTIME_DISK_SPACE' },
  );
}

function install(release, populate, options) {
  const root = runtimeCacheRoot(release, options.cacheRoot);
  if (pending.has(root)) return pending.get(root).done;
  const done = installFiles(release, populate, options);
  pending.set(root, {
    root,
    paths: release.files.map((file) => file.path),
    ready: () => done,
    done,
  });
  done.catch(() => {}).finally(() => pending.delete(root));
  return done;
}

async function installFiles(
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
    const published = await reusableFiles(root, release, signal);
    await requireDiskSpace(release, dirname(root), inspectDisk, published);
    await mkdir(temporary, { mode: 0o700 });
    const missing = {
      ...release,
      files: release.files.filter((file) => !published.has(file.path)),
    };
    await populate(temporary, published);
    onStatus({ phase: 'verifying', message: 'Checking your local computer…' });
    await verifyFiles(temporary, missing, signal);
    for (const file of missing.files) {
      signal?.throwIfAborted();
      await rename(join(temporary, file.path), join(root, file.path));
      published.add(file.path);
    }
    await writeFile(join(root, '.ready.json'), JSON.stringify({ id: release.id }), {
      mode: 0o600,
    });
    signal?.throwIfAborted();
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
    async (target, reused) => {
      for (const file of release.files) {
        if (reused.has(file.path)) continue;
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

function unpackRuntime(
  release,
  source,
  {
    message,
    failure,
    onStatus,
    onBytes = () => {},
    verifySource,
    finish = async () => {},
    signal,
    cacheRoot,
    inspectDisk = statfs,
  },
) {
  const root = runtimeCacheRoot(release, cacheRoot);
  if (pending.has(root)) return pending.get(root);
  const files = new Map(release.files.map((file) => [file.path, Promise.withResolvers()]));
  const temporary = `${root}.install-${randomBytes(6).toString('hex')}`;
  for (const file of files.values()) file.promise.catch(() => {});
  const done = (async () => {
    const existing = await verifiedCache(release, signal, cacheRoot);
    if (existing) return existing;
    const writes = [];
    const writing = new AbortController();
    const writeSignal = signal ? AbortSignal.any([signal, writing.signal]) : writing.signal;
    try {
      signal?.throwIfAborted();
      await verifySource?.();
      await mkdir(dirname(root), { recursive: true, mode: 0o700 });
      const published = await reusableFiles(root, release, signal);
      for (const path of published) files.get(path).resolve();
      await requireDiskSpace(release, dirname(root), inspectDisk, published);
      await mkdir(temporary, { mode: 0o700 });
      onStatus({ phase: 'installing', message, progress: 0 });
      const expected = new Map(release.files.map((file) => [file.path, file]));
      let invalid = false;
      let expanded = 0;
      let received = 0;
      let reported = 0;
      const archive = createHash('sha256');
      const limit = release.files.reduce(
        (size, file) => size + Math.ceil(file.bytes / 512) * 512 + 4096,
        1024 * 1024,
      );
      const counted = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          onBytes();
          if (received > release.archive.bytes)
            return callback(new Error('The runtime archive exceeds its expected size.'));
          archive.update(chunk);
          if (Date.now() - reported > 250) {
            reported = Date.now();
            onStatus({ phase: 'installing', message, progress: received / release.archive.bytes });
          }
          callback(null, chunk);
        },
        flush(callback) {
          onStatus({ phase: 'installing', message, progress: received / release.archive.bytes });
          callback();
        },
      });
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
      const parser = new Parser({
        strict: true,
        onReadEntry(entry) {
          const file = expected.get(entry.path);
          expected.delete(entry.path);
          if (!file || entry.type !== 'File' || entry.size !== file.bytes) {
            invalid = true;
            entry.resume();
            return;
          }
          const target = join(root, file.path);
          const reused = published.has(file.path);
          const path = reused ? target : join(temporary, String(writes.length));
          const hash = createHash('sha256');
          const write = pipeline(
            entry,
            new Transform({
              transform(chunk, encoding, callback) {
                hash.update(chunk);
                callback(null, chunk);
              },
            }),
            reused
              ? new Writable({ write: (chunk, encoding, callback) => callback() })
              : createWriteStream(path, { flags: 'wx', mode: 0o600 }),
            { signal: writeSignal },
          ).then(async () => {
            if (hash.digest('hex') !== file.sha256)
              throw new Error(`The runtime file failed its SHA-256 check: ${file.path}.`);
            await chmod(path, file.mode);
            if (!reused) {
              await rename(path, target);
              published.add(file.path);
            }
            files.get(file.path).resolve();
          });
          write.catch(() => {});
          writes.push(write);
        },
      });
      const input = await source(published);
      try {
        await pipeline(input, counted, createGunzip(), bounded, parser, { signal });
        await Promise.all(writes);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (['ENOSPC', 'EDQUOT'].includes(error.code)) throw error;
        throw new Error(failure, { cause: error });
      }
      if (received !== release.archive.bytes || archive.digest('hex') !== release.archive.sha256)
        throw new Error(failure, {
          cause: new Error(
            received !== release.archive.bytes
              ? 'The runtime archive size does not match its release.'
              : 'The runtime archive failed its SHA-256 check.',
          ),
        });
      if (invalid || expected.size) throw new Error('The runtime pack contains unexpected files.');
      await writeFile(join(root, '.ready.json'), JSON.stringify({ id: release.id }), {
        mode: 0o600,
      });
      await finish();
      return root;
    } catch (error) {
      writing.abort(error);
      await Promise.allSettled(writes);
      await finish(error);
      throw installationError(error);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  done.then(
    () => {
      for (const file of files.values()) file.resolve();
    },
    (error) => {
      for (const file of files.values()) file.reject(error);
    },
  );
  const assets = {
    root,
    paths: [...files.keys()],
    ready: (path) => files.get(path).promise,
    done,
  };
  pending.set(root, assets);
  done.catch(() => {}).finally(() => pending.delete(root));
  return assets;
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
  const failure = 'This runtime pack does not match your Nod app. Choose the matching pack.';
  const metadata = await lstat(archivePath);
  if (!metadata.isFile() || metadata.size !== release.archive.bytes) throw new Error(failure);
  return unpackRuntime(release, () => createReadStream(archivePath), {
    message: 'Installing your local computer…',
    failure,
    onStatus,
    signal,
    cacheRoot,
    inspectDisk,
  }).done;
}

export function timeLeft(span = 45_000) {
  const samples = [];
  return (fetched, remaining) => {
    const now = Date.now();
    samples.push([now, fetched]);
    while (samples.length > 1 && now - samples[1][0] >= span) samples.shift();
    const [since, first] = samples[0];
    if (now - since < 5000 || fetched <= first) return undefined;
    return Math.round((remaining * (now - since)) / (fetched - first) / 1000);
  };
}

export async function resumableDownload(
  url,
  path,
  { bytes, fetch: request = fetch, signal, save = true, onData = () => {} },
) {
  const metadata = save ? await lstat(path).catch(() => undefined) : undefined;
  const start = metadata?.isFile() && metadata.size < bytes ? metadata.size : 0;
  if (!start) await rm(path, { force: true });
  let interrupted = false;
  async function respond(ranged) {
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const address = new URL(url);
      if (address.protocol !== 'https:' || address.username || address.password)
        throw new Error('Nod received an unsafe download address.');
      response = await request(url, {
        signal,
        redirect: 'manual',
        headers: {
          accept: 'application/octet-stream',
          ...(ranged ? { range: `bytes=${start}-` } : {}),
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      url = new URL(response.headers.get('location') || '', url).href;
    }
    return response;
  }
  async function* network() {
    try {
      let response = await respond(start > 0);
      const resumed =
        response?.status === 206 &&
        response.headers.get('content-range') === `bytes ${start}-${bytes - 1}/${bytes}`;
      if (start && !resumed && [206, 416].includes(response?.status)) {
        await response.body?.cancel();
        response = await respond(false);
      }
      if (!response?.ok || !response.body || (response.status === 206 && !resumed)) {
        await response?.body?.cancel();
        throw new Error('The Nod download is unavailable. Try again.');
      }
      let skip = resumed ? 0 : start;
      for await (const chunk of response.body) {
        onData();
        const data = chunk.subarray(Math.min(skip, chunk.length));
        skip -= chunk.length - data.length;
        if (data.length) yield data;
      }
    } catch (error) {
      interrupted = true;
      throw error;
    }
  }
  async function* whole() {
    let file;
    try {
      if (start) yield* createReadStream(path, { end: start - 1, signal });
      for await (const chunk of network()) {
        if (save) file ??= await open(path, 'a', 0o600);
        await file?.appendFile(chunk);
        yield chunk;
      }
    } finally {
      await file?.close();
    }
  }
  return {
    start,
    stream: Readable.from(whole(), { objectMode: false }),
    interrupted: () => interrupted || Boolean(signal?.aborted),
  };
}

function downloadRuntime(release, options) {
  const {
    onStatus = () => {},
    signal,
    cacheRoot,
    inspectDisk = statfs,
    stallTimeout = 5 * 60_000,
  } = options;
  const root = runtimeCacheRoot(release, cacheRoot);
  if (pending.has(root)) return pending.get(root);
  const stalled = new AbortController();
  let timer;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        stalled.abort(
          new Error(
            'The Nod runtime download stopped receiving data. Check your connection, then try again.',
          ),
        ),
      stallTimeout,
    );
  };
  const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), stalled.signal]);
  const url = options.downloadUrl || release.url;
  const address = new URL(url);
  if (address.protocol !== 'https:' || address.username || address.password)
    throw new Error('The Nod runtime download address is invalid.');
  const partial = `${root}.${release.archive.sha256.slice(0, 12)}.download`;
  const total = release.archive.bytes;
  const estimate = timeLeft();
  let download;
  const assets = unpackRuntime(
    release,
    async (reused) => {
      alive();
      const saved = (await lstat(partial).catch(() => undefined))?.size ?? 0;
      const save =
        (await freeSpace(dirname(root), inspectDisk)) >=
        installSpace(release, reused) + BigInt(Math.max(0, total - saved));
      download = await resumableDownload(url, partial, {
        bytes: total,
        fetch: options.fetch,
        signal: downloadSignal,
        save,
        onData: alive,
      });
      download.stream.once('end', () => clearTimeout(timer));
      return download.stream;
    },
    {
      message: 'Downloading your local computer…',
      failure: 'The Nod runtime download did not complete. Try again.',
      onStatus: (value) => {
        if (!download || !Number.isFinite(value.progress)) return onStatus(value);
        const received = value.progress * total;
        onStatus({
          ...value,
          secondsLeft: estimate(Math.max(0, received - download.start), total - received),
        });
      },
      onBytes: alive,
      finish: async (error) => {
        if (!error || (download && !download.interrupted())) await rm(partial, { force: true });
      },
      signal: downloadSignal,
      cacheRoot,
      inspectDisk,
    },
  );
  assets.done.finally(() => clearTimeout(timer)).catch(() => {});
  return assets;
}

export async function openRuntimeAssets(options) {
  const found = await findRuntimeAssets(options);
  if (found) return { root: found, paths: [], ready: async () => {}, done: Promise.resolve(found) };
  const release = options.release
    ? validateRuntimeRelease(options.release)
    : await runtimeRelease(options.resourcesPath);
  if (release) {
    const root = runtimeCacheRoot(release, options.cacheRoot);
    if (pending.has(root)) return pending.get(root);
    const archivePath = `${root}.${release.archive.sha256.slice(0, 12)}.download`;
    const metadata = await lstat(archivePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (pending.has(root)) return pending.get(root);
    const cached = await verifiedCache(release, options.signal, options.cacheRoot);
    if (cached)
      return { root: cached, paths: [], ready: async () => {}, done: Promise.resolve(cached) };
    if (pending.has(root)) return pending.get(root);
    if (metadata?.isFile() && metadata.size >= release.archive.bytes) {
      return unpackRuntime(release, () => createReadStream(archivePath), {
        message: 'Installing your local computer…',
        failure: 'The Nod runtime download did not complete. Try again.',
        onStatus: options.onStatus || (() => {}),
        signal: options.signal,
        cacheRoot: options.cacheRoot,
        inspectDisk: options.inspectDisk,
        verifySource: async () => {
          options.signal?.throwIfAborted();
          options.onStatus?.({ phase: 'verifying', message: 'Checking your local computer…' });
          if (
            metadata.size !== release.archive.bytes ||
            (await assetHash(archivePath, options.signal)) !== release.archive.sha256
          ) {
            await rm(archivePath, { force: true });
            throw new Error(
              'The saved Nod runtime download failed its integrity check. Try again.',
            );
          }
        },
        finish: async (error) => {
          if (!error) await rm(archivePath, { force: true });
        },
      });
    }
  }
  let downloadUrl = options.downloadUrl || release?.url;
  if (release && !downloadUrl && options.resolveDownloadUrl) {
    options.signal?.throwIfAborted();
    options.onStatus?.({ phase: 'downloading', message: 'Finding your local computer…' });
    downloadUrl = await options.resolveDownloadUrl(release, options.signal);
    options.signal?.throwIfAborted();
  }
  if (release && downloadUrl) return downloadRuntime(release, { ...options, downloadUrl });
  throw Object.assign(new Error('Choose the Nod Runtime pack to finish setting up this Mac.'), {
    code: 'RUNTIME_ARCHIVE_REQUIRED',
  });
}

export async function ensureRuntimeAssets(options) {
  return (await openRuntimeAssets(options)).done;
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
