import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { assetHash } from './assets.mjs';
import { execute, finishRuntime } from './index.mjs';

const holders = new Map();
const distributionName = (root) =>
  `nod-${createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 12)}`;

export function windowsEnvironment() {
  const environment = Object.fromEntries(
    ['SYSTEMROOT', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  if (!environment.SYSTEMROOT) throw new Error('nod could not find the Windows system folder.');
  environment.PATH = join(environment.SYSTEMROOT, 'System32');
  return environment;
}

export async function protectWindowsProfile(root, resourcesPath) {
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('The nod profile cannot be a link.');
  const env = { ...windowsEnvironment(), NOD_PROFILE_PATH: root };
  await execute(
    join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(resourcesPath, 'desktop/runtime/protect-profile.ps1'),
    ],
    { env },
  );
}

async function distributions(wsl, env) {
  return (await execute(wsl, ['--list', '--quiet'], { env, encoding: 'utf16le' }))
    .replaceAll('\uFEFF', '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function installWsl({ signal } = {}) {
  const env = windowsEnvironment();
  await execute(
    join(env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $env:SYSTEMROOT 'System32/wsl.exe') -ArgumentList '--install','--no-distribution','--web-download' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
    ],
    { env, signal, timeout: 1_200_000 },
  );
}

async function download(
  { url, bytes, sha256 },
  path,
  { signal, fetch: request = fetch, onProgress = () => {} },
) {
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password)
      throw new Error('nod received an unsafe download address.');
    response = await request(url, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/octet-stream' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    url = new URL(response.headers.get('location') || '', url).href;
    await response.body?.cancel();
  }
  if (!response?.ok || !response.body)
    throw new Error('The nod download is unavailable. Try again.');
  const hash = createHash('sha256');
  let received = 0;
  let reported = 0;
  const check = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      if (Date.now() - reported > 250) {
        reported = Date.now();
        onProgress(received / bytes);
      }
      callback(
        received > bytes ? new Error('The nod download is larger than expected.') : null,
        chunk,
      );
    },
  });
  await pipeline(Readable.fromWeb(response.body), check, createWriteStream(path, { flags: 'wx' }), {
    signal,
  });
  if (received !== bytes || hash.digest('hex') !== sha256)
    throw new Error('The nod download failed its integrity check. Try again.');
}

export async function stageWindowsUpdate(candidate, { directory, resourcesPath, signal, fetch }) {
  if (
    !/^\d+\.\d+\.\d+$/.test(candidate?.version) ||
    candidate.installer?.file !== 'nod-Setup-x64.exe' ||
    candidate.runtime?.file !== 'nod-Runtime-win32-x64.tar.gz'
  )
    throw new Error('The nod update is invalid.');
  const target = join(directory, candidate.version);
  await rm(directory, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  try {
    const installed = JSON.parse(
      await readFile(join(resourcesPath, 'windows-runtime/manifest.json'), 'utf8').catch(
        () => '{}',
      ),
    );
    if (installed.guest?.sha256 !== candidate.runtime.sha256)
      await download(candidate.runtime, join(target, candidate.runtime.file), { signal, fetch });
    await download(candidate.installer, join(target, candidate.installer.file), {
      signal,
      fetch,
    });
    return target;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareWindowsRuntime(options, onComputerStart) {
  const dataRoot = resolve(options.dataRoot || options.root);
  const resourcesPath = resolve(options.resourcesPath || options.resources);
  const signal = options.signal;
  const status = options.onStatus || options.onProgress || (() => {});
  const hostEnvironment = windowsEnvironment();
  const wsl = join(hostEnvironment.SYSTEMROOT, 'System32/wsl.exe');
  try {
    await execute(wsl, ['--status'], { env: hostEnvironment, signal, timeout: 15_000 });
  } catch {
    signal?.throwIfAborted();
    throw Object.assign(
      new Error(
        'nod needs WSL 2. Select Install WSL, approve the Windows request, then restart your PC and open nod.',
      ),
      { code: 'NOD_WSL_REQUIRED' },
    );
  }
  await protectWindowsProfile(dataRoot, resourcesPath);
  const controlRoot = join(dataRoot, 'desktop-runtime');
  await mkdir(controlRoot, { recursive: true });
  const assets = join(resourcesPath, 'windows-runtime');
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    manifest.platform !== 'win32-x64' ||
    !/^[a-f0-9]{64}$/.test(manifest.guest?.sha256) ||
    manifest.guest.file !== 'guest.tar.gz' ||
    !Number.isSafeInteger(manifest.guest.bytes) ||
    manifest.guest.bytes < 1 ||
    manifest.guest.bytes > 8 * 1024 ** 3 ||
    !Number.isSafeInteger(manifest.guest.expandedBytes) ||
    manifest.guest.expandedBytes < manifest.guest.bytes ||
    manifest.guest.expandedBytes > 12 * 1024 ** 3 ||
    !Array.isArray(manifest.images) ||
    manifest.images.length !== 3 ||
    new Set(manifest.images.map((image) => image.name)).size !== 3 ||
    manifest.images.some(
      (image) =>
        !['workspace', 'browser', 'postgres'].includes(image.name) ||
        !/^sha256:[a-f0-9]{64}$/.test(image.id) ||
        !Number.isSafeInteger(image.size) ||
        image.size < 1 ||
        image.size > 24 * 1024 ** 3,
    )
  )
    throw new Error('The Windows runtime is incompatible. Reinstall this preview.');
  if (
    manifest.transport?.file !== 'bin/docker.exe' ||
    !/^[a-f0-9]{64}$/.test(manifest.transport.sha256)
  )
    throw new Error('The Windows transport manifest is invalid.');
  const transportHash = createHash('sha256');
  for await (const bytes of createReadStream(join(assets, manifest.transport.file), { signal }))
    transportHash.update(bytes);
  if (transportHash.digest('hex') !== manifest.transport.sha256)
    throw new Error('The Windows transport failed its integrity check.');
  const distribution = distributionName(dataRoot);
  const configPath = join(controlRoot, 'state.json');
  let saved;
  try {
    saved = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The nod computer configuration needs recovery.');
  }
  let existing = (await distributions(wsl, hostEnvironment)).includes(distribution);
  if (existing && !saved) {
    await execute(wsl, ['--unregister', distribution], {
      env: hostEnvironment,
      signal,
      timeout: 300_000,
    });
    existing = false;
  }
  if (
    saved &&
    (saved.version !== 1 ||
      saved.distribution !== distribution ||
      !/^[a-f0-9]{64}$/.test(saved.password))
  )
    throw new Error('The nod computer configuration needs recovery.');
  saved ??= {
    version: 1,
    distribution,
    password: randomBytes(32).toString('hex'),
    guest: manifest.guest.sha256,
  };
  const guestArgs = ['--distribution', distribution, '--user', 'root', '--exec'];
  const temporaryState = `${configPath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryState, JSON.stringify(saved), { flag: 'wx' });
  await rename(temporaryState, configPath);
  onComputerStart();
  if (!existing || saved.guest !== manifest.guest.sha256) {
    status({ phase: 'installing', message: 'Installing your private computer…' });
    const placed = join(assets, manifest.guest.file);
    const present = await stat(placed).then(
      async (file) =>
        file.size === manifest.guest.bytes &&
        (await assetHash(placed, signal)) === manifest.guest.sha256,
      () => false,
    );
    if (!present) await rm(placed, { force: true });
    const space = await statfs(controlRoot);
    const required =
      manifest.guest.expandedBytes * 2 +
      manifest.images.reduce((bytes, image) => bytes + image.size, 0) +
      (present ? 0 : manifest.guest.bytes) +
      2 * 1024 ** 3;
    if (space.bavail * space.bsize < required)
      throw new Error(
        'nod needs more free disk space to prepare its private computer. Free space, then select Try again.',
      );
    const archive = present ? placed : join(controlRoot, 'guest.tar.gz');
    const guest = join(controlRoot, 'guest.tar');
    try {
      if (!present) {
        if (!options.resolveDownloadUrl)
          throw new Error(
            'Put nod-Runtime-win32-x64.tar.gz next to nod-Setup-x64.exe, then run the installer again.',
          );
        const message = 'Downloading your private computer…';
        status({ phase: 'downloading', message, progress: 0 });
        await rm(archive, { force: true });
        await download(
          { ...manifest.guest, url: await options.resolveDownloadUrl(manifest, signal) },
          archive,
          {
            signal,
            fetch: options.fetch,
            onProgress: (progress) => status({ phase: 'downloading', message, progress }),
          },
        );
        status({ phase: 'installing', message: 'Installing your private computer…' });
      }
      let expanded = 0;
      const gunzip = createGunzip();
      gunzip.on('data', (bytes) => {
        expanded += bytes.length;
        if (expanded > manifest.guest.expandedBytes)
          gunzip.destroy(new Error('The Windows computer image is too large.'));
      });
      await pipeline(createReadStream(archive), gunzip, createWriteStream(guest), { signal });
      if (expanded !== manifest.guest.expandedBytes)
        throw new Error('The Windows computer image has an unexpected size.');
      if (!existing) {
        await mkdir(join(controlRoot, 'wsl'), { recursive: true });
        await execute(
          wsl,
          ['--import', distribution, join(controlRoot, 'wsl'), guest, '--version', '2'],
          { env: hostEnvironment, signal, timeout: 1_200_000 },
        );
      } else {
        const identity = await execute(wsl, [...guestArgs, '/bin/cat', '/var/lib/nod/identity'], {
          env: hostEnvironment,
          signal,
        });
        if (identity !== distribution.slice(4))
          throw new Error('The nod computer identity changed.');
        await execute(
          wsl,
          [
            ...guestArgs,
            '/bin/tar',
            '-xf',
            '-',
            '-C',
            '/',
            'opt/nod-assets',
            'usr/local/lib/nod/windows-guest.py',
          ],
          { env: hostEnvironment, signal, timeout: 900_000, input: createReadStream(guest) },
        );
      }
      saved.guest = manifest.guest.sha256;
      await writeFile(temporaryState, JSON.stringify(saved), { flag: 'wx' });
      await rename(temporaryState, configPath);
    } finally {
      await rm(guest, { force: true });
      if (!present) await rm(archive, { force: true });
    }
    await rm(placed, { force: true });
  }
  status({ phase: 'starting', message: 'Starting your private computer…' });
  const runGuest = (input) =>
    execute(wsl, [...guestArgs, '/bin/bash', '-s'], { env: hostEnvironment, signal, input });
  await execute(
    wsl,
    [...guestArgs, '/usr/bin/python3', '/usr/local/lib/nod/windows-guest.py', 'start'],
    {
      env: hostEnvironment,
      signal,
      input: JSON.stringify({ identity: distribution.slice(4) }),
      timeout: 900_000,
    },
  );
  if (!holders.has(distribution)) {
    const holder = spawn(wsl, [...guestArgs, '/usr/bin/sleep', 'infinity'], {
      env: hostEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    });
    holder.on('error', () => {});
    holder.on('exit', () => {
      if (holders.get(distribution) === holder) holders.delete(distribution);
    });
    holders.set(distribution, holder);
  }
  const docker = join(assets, 'bin/docker.exe');
  await access(docker);
  const dockerEnvironment = {
    ...hostEnvironment,
    TEMP: join(controlRoot, 'temp'),
    TMP: join(controlRoot, 'temp'),
    NOD_WSL_DISTRIBUTION: distribution,
    DOCKER_CONFIG: join(controlRoot, 'docker-config'),
    DOCKER_HOST: '',
    DOCKER_CONTEXT: '',
  };
  await mkdir(dockerEnvironment.TEMP, { recursive: true });
  await mkdir(dockerEnvironment.DOCKER_CONFIG, { recursive: true });
  return finishRuntime({
    dataRoot,
    resourcesPath,
    assets,
    manifest,
    identity: distribution.slice(4),
    saved,
    controlRoot,
    docker,
    path: `${join(assets, 'bin')};${hostEnvironment.PATH}`,
    dockerEnvironment,
    runDocker: (args, extra = {}) =>
      execute(docker, args, { env: dockerEnvironment, signal, ...extra }),
    runGuest,
    signal,
    status: (phase, message, progress) => status({ phase, message, progress }),
    prepareImage: async (name) => {
      await execute(
        wsl,
        [...guestArgs, '/usr/bin/python3', '/usr/local/lib/nod/windows-guest.py', 'image'],
        {
          env: hostEnvironment,
          signal,
          input: JSON.stringify({ identity: distribution.slice(4), name }),
          timeout: 600_000,
        },
      );
    },
    onStorageReady: options.onStorageReady,
  });
}

export async function stopWindowsRuntime(options) {
  const dataRoot = resolve(options.dataRoot || options.root);
  const distribution = distributionName(dataRoot);
  const env = windowsEnvironment();
  const wsl = join(env.SYSTEMROOT, 'System32/wsl.exe');
  try {
    const saved = JSON.parse(await readFile(join(dataRoot, 'desktop-runtime/state.json'), 'utf8'));
    if (saved.version !== 1 || saved.distribution !== distribution) throw new Error();
    if ((await distributions(wsl, env)).includes(distribution)) {
      await execute(
        wsl,
        [
          '--distribution',
          distribution,
          '--user',
          'root',
          '--exec',
          '/usr/local/bin/docker',
          'stop',
          '--time',
          '20',
          ...['workspace', 'browser', 'postgres'].map(
            (role) => `nod-${role}-${distribution.slice(4)}`,
          ),
        ],
        { env, timeout: 90_000 },
      ).catch(() => {});
      await execute(wsl, ['--terminate', distribution], { env, timeout: 90_000 });
    }
    holders.get(distribution)?.kill();
    holders.delete(distribution);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw Object.assign(
      new Error(
        'nod could not confirm that its private computer stopped. Try again before quitting.',
      ),
      { code: 'NOD_RUNTIME_STOP_FAILED' },
    );
  }
}

export async function removeWindowsComputer(dataRoot) {
  const distribution = distributionName(dataRoot);
  const env = windowsEnvironment();
  const wsl = join(env.SYSTEMROOT, 'System32/wsl.exe');
  if ((await distributions(wsl, env).catch(() => [])).includes(distribution))
    await execute(wsl, ['--unregister', distribution], { env, timeout: 300_000 });
}
