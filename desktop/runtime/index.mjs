import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus as hostCpus, homedir, totalmem } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { guestConfiguration, protectNetworks } from './guest-config.mjs';
import {
  assetHash,
  findRuntimeAssets,
  openRuntimeAssets,
  removeUnusedRuntimes,
} from './assets.mjs';

export { installRuntimeArchive } from './assets.mjs';

const preparing = new Map();
const storageReady = new Map();
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function execute(
  command,
  args,
  { env, signal, timeout = 120_000, input, encoding = 'utf8' } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    let spawnError;
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    const collect = (chunk) => {
      output = (output + chunk).slice(-128 * 1024);
    };
    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      spawnError = error;
    });
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    if (input?.pipe)
      pipeline(input, child.stdin).catch((error) => {
        spawnError = error;
        stop();
      });
    else child.stdin.end(input);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(new Error('nod setup was cancelled.'));
      if (spawnError)
        return reject(
          new Error(`nod could not launch its bundled runtime (${spawnError.code || 'unknown'}).`),
        );
      if (timedOut) return reject(new Error('nod runtime setup took too long. Please retry.'));
      if (code !== 0) {
        const detail = output.replaceAll('\0', '').replace(/\s+/g, ' ').trim();
        return reject(
          new Error(
            `nod runtime command failed (${code})${
              detail ? `: ${detail.length > 300 ? '…' : ''}${detail.slice(-300)}` : '.'
            }`,
          ),
        );
      }
      resolveRun(output.trim());
    });
  });
}

export async function availablePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePort);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

export async function waitFor(operation, { signal, attempts = 240, interval = 250 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'NOD_CONTAINER_STOPPED') throw error;
      failure = error;
    }
    await delay(interval, undefined, { signal });
  }
  throw failure;
}

async function prepare(options, onComputerStart) {
  if (process.platform === 'win32' && process.arch === 'x64') {
    const { prepareWindowsRuntime } = await import('./windows.mjs');
    return prepareWindowsRuntime(options, onComputerStart);
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('This experimental nod build requires an Intel or Apple Silicon Mac.');
  const dataRoot = resolve(options.dataRoot || options.root);
  const resourcesPath = resolve(options.resourcesPath || options.resources);
  const onStatus = options.onStatus || options.onProgress || (() => {});
  const signal = options.signal;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const controlRoot = join(dataRoot, 'desktop-runtime');
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const runtimeAssets = await openRuntimeAssets({
    resourcesPath,
    onStatus,
    signal,
    resolveDownloadUrl: options.resolveDownloadUrl,
  });
  let downloading = runtimeAssets.paths.length > 0;
  let waiting;
  const status = (phase, message, stage = 'computer') => {
    const value = { phase, message, stage };
    if (downloading) waiting = value;
    else onStatus(value);
  };
  runtimeAssets.done.then(
    () => {
      downloading = false;
      if (waiting) onStatus(waiting);
    },
    () => {},
  );
  const assets = runtimeAssets.root;
  await Promise.all(
    runtimeAssets.paths.filter((path) => !path.startsWith('images/')).map(runtimeAssets.ready),
  );
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    manifest.platform !== `darwin-${process.arch}` ||
    manifest.guest.file !== 'guest.img' ||
    manifest.dockerGuest.file !== 'docker-guest.tar.gz'
  )
    throw new Error('This nod computer bundle is incompatible.');
  for (const entry of [manifest.guest, manifest.dockerGuest, ...manifest.images]) {
    if (
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !/^(guest\.img|docker-guest\.tar\.gz|images\/(workspace|browser|postgres)\.tar\.zst)$/.test(
        entry.file,
      )
    )
      throw new Error('The nod computer manifest is invalid.');
  }
  const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
  const limaHome = join(homedir(), '.nod-desktop', identity);
  await mkdir(limaHome, { recursive: true, mode: 0o700 });
  await chmod(limaHome, 0o700);
  const lima = join(assets, 'lima/bin/limactl');
  const docker = join(assets, 'docker-host/docker/docker');
  const path = [join(assets, 'lima/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  const hostEnvironment = {
    PATH: path,
    HOME: homedir(),
    LIMA_HOME: limaHome,
    LIMA_SSH_PORT_FORWARDER: 'true',
    LANG: 'en_US.UTF-8',
  };
  const configPath = join(controlRoot, 'state.json');
  let saved;
  try {
    saved = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('The nod local computer configuration needs recovery.');
    const orphaned = await access(join(limaHome, 'nod/lima.yaml')).then(
      () => true,
      () => false,
    );
    if (orphaned)
      await execute(lima, ['delete', '--force', 'nod'], {
        env: hostEnvironment,
        signal,
        timeout: 120_000,
      });
  }
  if (
    saved &&
    (saved.version !== 1 ||
      saved.limaHome !== limaHome ||
      !Number.isInteger(saved.port) ||
      saved.port < 1 ||
      saved.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(saved.password))
  )
    throw new Error('The nod local computer configuration needs recovery.');
  saved ??= {
    version: 1,
    limaHome,
    port: await availablePort(),
    password: randomBytes(32).toString('hex'),
  };
  const temporaryState = `${configPath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryState, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
  await rename(temporaryState, configPath);
  const vm = 'nod';
  const dockerSocket = join(limaHome, vm, 'sock/docker.sock');
  const dockerConfig = join(controlRoot, 'docker-config');
  await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  const dockerEnvironment = {
    ...hostEnvironment,
    DOCKER_HOST: `unix://${dockerSocket}`,
    DOCKER_CONFIG: dockerConfig,
  };
  const runDocker = (args, extra = {}) =>
    execute(docker, args, { env: dockerEnvironment, signal, ...extra });
  const runLima = (args, extra = {}) =>
    execute(lima, args, { env: hostEnvironment, signal, ...extra });
  let exists = false;
  try {
    await access(join(limaHome, vm, 'lima.yaml'));
    exists = true;
  } catch {}
  if (!exists) {
    status('preparing', 'Preparing your private computer…');
    const config = guestConfiguration({
      assets,
      imageDigest: manifest.guest.sha256,
      port: saved.port,
      memory: Math.max(3, Math.min(6, Math.floor(totalmem() / 1024 ** 3 / 2))),
      cpus: Math.max(2, Math.min(4, hostCpus().length)),
    });
    const configFile = join(controlRoot, 'computer.yaml');
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    await runLima(['create', '--name', vm, '--tty=false', configFile], { timeout: 300_000 });
  } else {
    const vmConfigPath = join(limaHome, vm, 'lima.yaml');
    let config;
    try {
      config = JSON.parse(await readFile(vmConfigPath, 'utf8'));
    } catch {
      throw new Error('The nod computer configuration needs recovery.');
    }
    if (
      config.mounts?.length !== 1 ||
      config.mounts[0].mountPoint !== '/opt/nod-assets' ||
      config.mounts[0].writable !== false
    )
      throw new Error('The nod computer has unexpected folder access.');
    if (config.mounts[0].location !== assets) {
      const currentStatus = await runLima(['list', '--format', '{{.Status}}', vm]);
      if (currentStatus.trim() !== 'Stopped')
        throw new Error('Quit and reopen nod to update its local computer.');
      config.mounts[0].location = assets;
      config.images = [
        {
          location: join(assets, 'guest.img'),
          arch: process.arch === 'x64' ? 'x86_64' : 'aarch64',
          digest: `sha256:${manifest.guest.sha256}`,
        },
      ];
      const temporary = `${vmConfigPath}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, vmConfigPath);
    }
  }
  status('starting', 'Starting your private computer…');
  onComputerStart();
  await runLima(['start', '--tty=false', vm], { timeout: 600_000 });
  if (!options.preserveRuntimeCache) await removeUnmountedRuntimes(assets).catch(() => {});
  await waitFor(() => runDocker(['info', '--format', '{{.ServerVersion}}']), { signal });
  const prepareImage = async (name) => {
    const item = validImage(manifest.images.find((image) => image.name === name));
    let installed = '';
    try {
      installed = await runDocker(['image', 'inspect', '--format', '{{.Id}}', item.reference]);
    } catch {}
    if (installed === item.id) return;
    await runtimeAssets.ready(item.file);
    if ((await fileHash(join(assets, item.file))) !== item.sha256)
      throw new Error('A nod computer image is damaged. Reinstall this build.');
    await runLima(
      [
        'shell',
        vm,
        'sudo',
        '/usr/local/bin/docker',
        'load',
        '--input',
        `/opt/nod-assets/${item.file}`,
      ],
      { timeout: 600_000 },
    );
    if ((await runDocker(['image', 'inspect', '--format', '{{.Id}}', item.reference])) !== item.id)
      throw new Error('The loaded nod image does not match its manifest.');
  };
  return finishRuntime({
    dataRoot,
    resourcesPath,
    assets,
    manifest,
    identity,
    saved,
    controlRoot,
    docker,
    path,
    dockerEnvironment,
    runDocker,
    runGuest: (input) => runLima(['shell', vm, 'sudo', 'bash', '-s'], { input }),
    signal,
    status,
    prepareImage,
    onStorageReady: options.onStorageReady,
    runtimeReady: runtimeAssets.done,
  });
}

function validImage(item) {
  if (
    !['workspace', 'browser', 'postgres'].includes(item.name) ||
    !/^sha256:[a-f0-9]{64}$/.test(item.id) ||
    !/^images\/(workspace|browser|postgres)\.tar\.zst$/.test(item.file)
  )
    throw new Error('The nod computer image is invalid.');
  return item;
}

export async function preloadRuntimeImages({ dataRoot, assets, signal }) {
  const root = resolve(dataRoot);
  const identity = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const env = {
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    HOME: homedir(),
    DOCKER_HOST: `unix://${join(homedir(), '.nod-desktop', identity, 'nod/sock/docker.sock')}`,
    DOCKER_CONFIG: join(root, 'desktop-runtime/docker-config'),
  };
  const runDocker = (args, extra = {}) =>
    execute(join(assets, 'docker-host/docker/docker'), args, { env, signal, ...extra });
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
  const loaded = [];
  for (const item of manifest.images.map(validImage)) {
    const installed = await runDocker([
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      item.reference,
    ]).catch(() => '');
    if (installed === item.id) continue;
    if ((await assetHash(join(assets, item.file), signal)) !== item.sha256)
      throw new Error('A nod computer image is damaged. Reinstall this build.');
    await runDocker(['load', '--input', join(assets, item.file)], { timeout: 600_000 });
    loaded.push(item.name);
  }
  return loaded;
}

async function removeUnmountedRuntimes(assets) {
  const homes = join(homedir(), '.nod-desktop');
  const keep = [];
  for (const name of await readdir(homes)) {
    const config = await readFile(join(homes, name, 'nod/lima.yaml'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (config) keep.push(...JSON.parse(config).mounts.map((mount) => mount.location));
  }
  await removeUnusedRuntimes({ current: assets, keep });
}

export async function removeStaleImages(runDocker, runGuest, manifest) {
  const keep = new Set(manifest.images.map((item) => item.id));
  const images = new Set(
    (await runDocker(['image', 'ls', '--quiet', '--no-trunc'])).split('\n').filter(Boolean),
  );
  const stale = [...images].filter((id) => !keep.has(id));
  for (const id of stale) await runDocker(['image', 'rm', id]).catch(() => {});
  if (stale.length) await runGuest('fstrim / || true\n').catch(() => {});
  return stale;
}

export async function ensureNetwork(runDocker, { name, subnet, bridge }) {
  let inspected = await runDocker(['network', 'inspect', name]).catch(() => undefined);
  if (!inspected) {
    await runDocker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--subnet',
      subnet,
      '--opt',
      `com.docker.network.bridge.name=${bridge}`,
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      name,
    ]);
    inspected = await runDocker(['network', 'inspect', name]);
  }
  const [network] = JSON.parse(inspected);
  if (
    network?.Driver !== 'bridge' ||
    network.Scope !== 'local' ||
    network.EnableIPv6 !== false ||
    network.Internal !== false ||
    network.IPAM?.Config?.length !== 1 ||
    network.IPAM.Config[0].Subnet !== subnet ||
    network.Options?.['com.docker.network.bridge.name'] !== bridge ||
    network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false'
  )
    throw new Error('The nod computer network has unexpected isolation settings.');
}

export async function replaceContainer(
  runDocker,
  name,
  imageId,
  args,
  { command = [], reuse, remember = false, ...extra } = {},
) {
  const configuration = createHash('sha256')
    .update(JSON.stringify([imageId, args, command, extra.env]))
    .digest('hex');
  const identity = (value) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          value.Id,
          value.Image,
          value.Config,
          value.HostConfig,
          value.Mounts,
          value.NetworkSettings,
        ]),
      )
      .digest('hex');
  const inspected = await runDocker(['container', 'inspect', name]).catch(() => undefined);
  if (inspected) {
    const [current] = JSON.parse(inspected);
    if (current?.Config?.Labels?.['dev.nod.desktop.experiment'] !== 'true')
      throw new Error('The nod container identity changed.');
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '--volume') continue;
      const [volume, destination] = args[++index].split(':');
      if (
        !current.Mounts?.some(
          (mount) =>
            mount.Type === 'volume' && mount.Name === volume && mount.Destination === destination,
        )
      )
        throw new Error('The nod container storage needs recovery.');
    }
    if (
      reuse?.configuration === configuration &&
      current.State?.Running === true &&
      current.Image === imageId &&
      identity(current) === reuse.identity
    )
      return reuse;
    await runDocker(['stop', '--time', '20', name]);
    await runDocker(['rm', name]);
  }
  await runDocker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'dev.nod.desktop.experiment=true',
      ...args,
      imageId,
      ...command,
    ],
    extra,
  );
  if (remember) {
    const [current] = JSON.parse(await runDocker(['container', 'inspect', name]));
    return { configuration, identity: identity(current) };
  }
}

export async function finishRuntime({
  dataRoot,
  resourcesPath,
  assets,
  manifest,
  identity,
  saved,
  controlRoot,
  docker,
  path,
  dockerEnvironment,
  runDocker,
  runGuest,
  signal,
  status,
  prepareImage,
  onStorageReady,
  runtimeReady,
}) {
  status('starting', 'Preparing secure storage and tools…', 'storage');
  const images = {};
  const loadImage = (name) => {
    images[name] = Promise.resolve().then(() => prepareImage?.(name));
    images[name].catch(() => {});
  };
  loadImage('postgres');
  const names = {
    workspace: `nod-workspace-${identity}`,
    browser: `nod-browser-${identity}`,
    postgres: `nod-postgres-${identity}`,
  };
  for (const [role, subnet, bridge] of [
    ['control', '172.31.80.0/24', 'nod-control'],
    ['workspace', '172.31.81.0/24', 'nod-workspace'],
    ['browser', '172.31.82.0/24', 'nod-browser'],
  ]) {
    const name = `nod-${role}-${identity}`;
    await ensureNetwork(runDocker, { name, subnet, bridge });
  }
  await runGuest(protectNetworks);
  const volumes = {
    postgres: `nod-postgres-${identity}`,
    browser: `nod-browser-${identity}`,
    workspace: `nod-workspace-${identity}`,
    tools: `nod-tools-${identity}`,
  };
  for (const volume of Object.values(volumes)) await runDocker(['volume', 'create', volume]);
  const image = (name) => manifest.images.find((item) => item.name === name).id;
  await images.postgres;
  loadImage('workspace');
  loadImage('browser');
  const storage = storageReady.get(resolve(dataRoot));
  const port =
    process.platform === 'win32' ? (storage?.port ?? (await availablePort())) : saved.port;
  status('starting', 'Starting your database…', 'storage');
  const postgres = await replaceContainer(
    runDocker,
    names.postgres,
    image('postgres'),
    [
      '--network',
      `nod-control-${identity}`,
      '--publish',
      `127.0.0.1:${process.platform === 'win32' ? port : 54329}:5432`,
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--env',
      'POSTGRES_USER=nod',
      '--env',
      'POSTGRES_DB=nod',
      '--env',
      'POSTGRES_PASSWORD',
      '--volume',
      `${volumes.postgres}:/var/lib/postgresql/data`,
    ],
    {
      env: { ...dockerEnvironment, POSTGRES_PASSWORD: saved.password },
      remember: true,
      reuse: storage?.postgres,
    },
  );
  const databaseUrl = `postgresql://nod:${saved.password}@127.0.0.1:${port}/nod`;
  status('starting', 'Waiting for your database to be ready…', 'storage');
  try {
    await waitFor(
      () => runDocker(['exec', names.postgres, 'pg_isready', '-U', 'nod', '-d', 'nod']),
      { signal },
    );
    const { default: pg } = await import('pg');
    await waitFor(
      async () => {
        const client = new pg.Client({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 5000,
          query_timeout: 5000,
        });
        try {
          await client.connect();
          await client.query('SELECT 1');
        } catch (error) {
          throw new Error(
            `nod could not unlock local storage (${error.message || error.code}). Retry without resetting your data.`,
          );
        } finally {
          await client.end().catch(() => {});
        }
      },
      { signal, attempts: 12, interval: 1000 },
    );
  } catch (error) {
    if (storage) storage.postgres = undefined;
    throw error;
  }
  const wrapperRoot = join(controlRoot, 'bin');
  if (process.platform !== 'win32') {
    await mkdir(wrapperRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(wrapperRoot, 'docker'),
      `#!/bin/sh
set -eu
docker=${shellQuote(docker)}
if [ "\${1-}" = exec ]; then
  previous=''
  directory=''
  target=''
  for argument in "$@"; do
    if [ "$previous" = --workdir ]; then directory="$argument"; elif [ -n "$directory" ] && [ -z "$target" ]; then target="$argument"; fi
    previous="$argument"
  done
  if [ "$target" = ${shellQuote(names.workspace)} ]; then
    case "$directory" in
      /workspace/*)
        identity="\${directory#/workspace/}"
        case "$identity" in *[!0-9a-zA-Z_-]*|'') exit 64 ;; esac
        [ "\${#identity}" -le 100 ] || exit 64
        "$docker" exec --user node --workdir /workspace "$target" mkdir -p -- "$directory" >/dev/null
        ;;
    esac
  fi
fi
exec "$docker" "$@"
`,
      { mode: 0o700 },
    );
  }
  const env = {
    PATH:
      process.platform === 'win32'
        ? path
        : [wrapperRoot, join(assets, 'docker-host/docker'), path].join(delimiter),
    ...(process.platform === 'win32'
      ? {
          NOD_WSL_DISTRIBUTION: dockerEnvironment.NOD_WSL_DISTRIBUTION,
          TEMP: dockerEnvironment.TEMP,
          TMP: dockerEnvironment.TMP,
        }
      : {}),
    DOCKER_HOST: dockerEnvironment.DOCKER_HOST,
    DOCKER_CONFIG: dockerEnvironment.DOCKER_CONFIG,
    DOCKER_CONTEXT: '',
    NOD_DATA_ROOT: dataRoot,
    BROWSER_CONTAINER: names.browser,
    WORKSPACE_CONTAINER: names.workspace,
    DATABASE_URL: databaseUrl,
  };
  const runtime = {
    env,
    environment: env,
    postgres,
    port,
    close: () => stopRuntime({ dataRoot, resourcesPath }),
  };
  signal?.throwIfAborted();
  await onStorageReady?.(runtime);
  signal?.throwIfAborted();
  status('starting', 'Preparing your workspace…', 'workspace');
  await images.workspace;
  await replaceContainer(
    runDocker,
    names.workspace,
    image('workspace'),
    [
      '--network',
      `nod-workspace-${identity}`,
      '--init',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '1024',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--volume',
      `${volumes.workspace}:/workspace`,
      '--volume',
      `${volumes.tools}:/home/node`,
      '--entrypoint',
      '/usr/bin/sleep',
    ],
    { command: ['infinity'] },
  );
  status('starting', 'Preparing your browser…', 'browser');
  await images.browser;
  await replaceContainer(runDocker, names.browser, image('browser'), [
    '--network',
    `nod-browser-${identity}`,
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--pids-limit',
    '768',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--shm-size',
    '256m',
    '--tmpfs',
    '/tmp:size=1g',
    '--tmpfs',
    '/home/node:uid=1000,gid=1000,mode=700,size=256m',
    '--volume',
    `${volumes.browser}:/data`,
  ]);
  await waitFor(
    async () => {
      if (
        (await runDocker(['inspect', '--format', '{{.State.Running}}', names.browser])) !== 'true'
      )
        throw Object.assign(new Error('nod’s local browser stopped during setup. Try again.'), {
          code: 'NOD_CONTAINER_STOPPED',
        });
      return runDocker([
        'exec',
        names.browser,
        'node',
        '-e',
        'const s=require("node:net").connect("/data/control.sock");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",(e)=>{console.error("The browser did not answer: "+e.message);process.exit(1)})',
      ]);
    },
    { signal },
  );
  await runtimeReady;
  await removeStaleImages(runDocker, runGuest, manifest).catch(() => {});
  status('ready', 'Your private computer is ready.', 'ready');
  return runtime;
}

export function prepareRuntime(options) {
  const key = resolve(options.dataRoot || options.root);
  if (!preparing.has(key)) {
    let computerMayBeRunning = false;
    preparing.set(
      key,
      prepare(
        {
          ...options,
          ...(options.onStorageReady
            ? {
                onStorageReady: async (runtime) => {
                  await options.onStorageReady(runtime);
                  storageReady.set(key, runtime);
                },
              }
            : {}),
        },
        () => {
          computerMayBeRunning = true;
        },
      )
        .catch(async (error) => {
          if (computerMayBeRunning && !storageReady.has(key)) await stopRuntime(options);
          throw error;
        })
        .finally(() => preparing.delete(key)),
    );
  }
  return preparing.get(key);
}

export async function stopRuntime(options) {
  await stopComputer(options);
  storageReady.delete(resolve(options.dataRoot || options.root));
}

export async function removeProfile(options) {
  const dataRoot = resolve(options.dataRoot || options.root);
  if (process.platform === 'win32') {
    const { removeWindowsComputer } = await import('./windows.mjs');
    await removeWindowsComputer(dataRoot);
    return rm(dataRoot, { recursive: true, force: true });
  }
  await rm(dataRoot, { recursive: true, force: true });
  const homes = join(homedir(), '.nod-desktop');
  const limaHome = join(homes, createHash('sha256').update(dataRoot).digest('hex').slice(0, 12));
  const assets = await findRuntimeAssets({
    resourcesPath: resolve(options.resourcesPath || options.resources),
  });
  const exists = await access(join(limaHome, 'nod/lima.yaml')).then(
    () => true,
    () => false,
  );
  if (assets && exists)
    await execute(join(assets, 'lima/bin/limactl'), ['delete', '--force', 'nod'], {
      env: {
        PATH: [join(assets, 'lima/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
        HOME: homedir(),
        LIMA_HOME: limaHome,
      },
      timeout: 120_000,
    });
  await rm(limaHome, { recursive: true, force: true });
  await rmdir(homes).catch(() => {});
}

async function stopComputer(options) {
  if (process.platform === 'win32') {
    const { stopWindowsRuntime } = await import('./windows.mjs');
    return stopWindowsRuntime(options);
  }
  const dataRoot = resolve(options.dataRoot || options.root);
  const resourcesPath = resolve(options.resourcesPath || options.resources);
  const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
  const expected = join(homedir(), '.nod-desktop', identity);
  try {
    const exists = await access(join(expected, 'nod/lima.yaml')).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    let state;
    try {
      state = JSON.parse(await readFile(join(dataRoot, 'desktop-runtime/state.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' && !exists) return;
      throw error;
    }
    if (state.version !== 1 || state.limaHome !== expected)
      throw new Error('The nod computer identity changed.');
    if (!exists) return;
    const assets = await findRuntimeAssets({ resourcesPath });
    if (!assets) throw new Error('nod could not find its local computer runtime.');
    const env = {
      PATH: [join(assets, 'lima/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      HOME: homedir(),
      LIMA_HOME: expected,
      LIMA_SSH_PORT_FORWARDER: 'true',
    };
    const lima = join(assets, 'lima/bin/limactl');
    await execute(lima, ['stop', '--tty=false', 'nod'], { env, timeout: 90_000 }).catch(() => {});
    await waitFor(
      async () => {
        const status = await execute(lima, ['list', '--format', '{{.Status}}', 'nod'], {
          env,
          timeout: 5000,
        });
        if (status !== 'Stopped') throw new Error('The nod computer is still running.');
      },
      { attempts: 3, interval: 250 },
    );
  } catch {
    throw Object.assign(
      new Error(
        'nod could not confirm that its private computer stopped. Try again before quitting.',
      ),
      { code: 'NOD_RUNTIME_STOP_FAILED' },
    );
  }
}
