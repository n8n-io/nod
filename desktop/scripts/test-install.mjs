import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetHash, findRuntimeAssets, runtimeRelease } from '../runtime/assets.mjs';
import { run } from './release-tools.mjs';
import { verifyApplicationRuntime } from './engine-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = 'nod Setup Test';
const bundleId = 'dev.nod.desktop.setup-test';
const application = join(homedir(), 'Applications', `${name}.app`);
const work = join(root, '.local', 'desktop-test-install');
const profiles = join(homedir(), 'Library', 'Application Support', name, 'test-profiles');

export async function validateTestApplication(path) {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== resolve(path))
    throw new Error('The test application must be a real directory.');
  const configuration = JSON.parse(
    await readFile(join(path, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'),
  );
  if (
    configuration.name !== 'nod-setup-test' ||
    configuration.productName !== name ||
    configuration.nodBuild?.testProfile !== true ||
    configuration.nodBuild.release === true
  )
    throw new Error('This is not an isolated Nod test application.');
  return configuration;
}

export async function testProfile(directory, label, fresh = false) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(label || ''))
    throw new Error('Use a profile name containing letters, numbers, hyphens or underscores.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== resolve(directory))
    throw new Error('The test profile directory must not be a link.');
  const path = join(directory, label);
  const marker = join(path, 'test-profile.json');
  if (fresh) {
    await mkdir(path, { mode: 0o700 });
    await writeFile(marker, JSON.stringify({ version: 1, kind: 'nod-setup-test' }), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw new Error('The test profile must not be a link.');
  const saved = JSON.parse(await readFile(marker, 'utf8'));
  if (saved.version !== 1 || saved.kind !== 'nod-setup-test')
    throw new Error('This profile was not created by the test installer.');
  return path;
}

async function running() {
  const executable = join(application, 'Contents', 'MacOS', 'nod');
  const output = await run('/bin/ps', ['-axo', 'pid=,lstart=,comm='], {
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    return match?.[3] === executable
      ? [{ pid: Number(match[1]), started: match[2].replace(/\s+/g, ' ') }]
      : [];
  });
}

async function stop() {
  await validateTestApplication(application);
  const owned = await running();
  if (!owned.length) return;
  for (const expected of owned) {
    const current = (await running()).find((item) => item.pid === expected.pid);
    if (current?.started !== expected.started) continue;
    try {
      process.kill(current.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  for (let attempt = 0; attempt < 480; attempt++) {
    if (!(await running()).length) return;
    await wait(250);
  }
  throw new Error('Quit nod Setup Test before continuing. Its profile has been kept.');
}

async function build(source = '/Applications/Nod.app/Contents/Resources/engine') {
  const release = await runtimeRelease(resolve(source));
  if (!release || release.platform !== `darwin-${process.arch}`)
    throw new Error('Choose an installed engine with a matching runtime-release.json.');
  const assets = await findRuntimeAssets({ resourcesPath: resolve(source), release });
  if (!assets) throw new Error('The verified runtime is not cached. Open the installed Nod first.');
  const installed = await lstat(application).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (installed) await stop();
  const stage = join(work, 'stage');
  const output = join(work, 'build');
  const descriptor = join(resolve(source), 'runtime-release.json');
  await run(
    process.execPath,
    [
      'desktop/scripts/build-app.mjs',
      '--stage-only',
      '--runtime-descriptor',
      descriptor,
      '--no-runtime-archive',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NOD_RUNTIME_ASSETS: assets,
        NOD_DESKTOP_STAGE: stage,
        NOD_DESKTOP_OUTPUT: output,
        NOD_RELEASE_BUILD: 'false',
        NOD_TRACES_TOKEN: '',
        NOD_DESKTOP_UPDATE_SOURCE_URL: '',
      },
      timeout: 10 * 60_000,
    },
  );
  if (
    (await assetHash(join(stage, 'engine', 'runtime-release.json'))) !==
    (await assetHash(descriptor))
  )
    throw new Error('The test runtime descriptor failed its integrity check.');
  const sourceApp = join(stage, 'app');
  const configuration = JSON.parse(await readFile(join(sourceApp, 'package.json'), 'utf8'));
  configuration.name = 'nod-setup-test';
  configuration.productName = name;
  configuration.nodBuild.testProfile = true;
  configuration.nodBuild.runtime = release.id;
  delete configuration.nodBuild.release;
  await writeFile(join(sourceApp, 'package.json'), JSON.stringify(configuration, null, 2));
  const iconset = join(stage, 'nod.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 64, 128, 256, 512, 1024])
    await run('/usr/bin/sips', [
      '-z',
      String(size),
      String(size),
      join(root, 'desktop', 'assets', 'nod-macos.png'),
      '--out',
      join(iconset, size === 1024 ? 'icon_512x512@2x.png' : `icon_${size}x${size}.png`),
    ]);
  const icon = join(stage, 'nod.icns');
  await run('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset]);
  const { packager } = await import('@electron/packager');
  const desktop = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'));
  const paths = await packager({
    dir: sourceApp,
    out: output,
    name,
    executableName: 'nod',
    appBundleId: bundleId,
    appVersion: configuration.version,
    electronVersion: desktop.devDependencies.electron,
    platform: 'darwin',
    arch: process.arch,
    asar: false,
    prune: false,
    overwrite: true,
    icon,
    extendInfo: {
      CFBundleDisplayName: name,
      LSMinimumSystemVersion: release.minimumSystemVersion || '14.0',
      NSMicrophoneUsageDescription: 'Nod uses your microphone when you record a voice message.',
    },
  });
  const built = join(paths[0], `${name}.app`);
  await rename(join(stage, 'engine'), join(built, 'Contents', 'Resources', 'engine'));
  const licenses = join(built, 'Contents', 'Resources', 'licenses');
  await mkdir(licenses);
  for (const file of ['LICENSE', 'LICENSES.chromium.html'])
    await cp(join(paths[0], file), join(licenses, file));
  await run(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', built],
    {
      timeout: 10 * 60_000,
    },
  );
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', built]);
  await verifyApplicationRuntime(built, desktop.devDependencies.electron);
  await validateTestApplication(built);
  await mkdir(dirname(application), { recursive: true });
  const candidate = join(dirname(application), `.${name}-${randomUUID()}.app`);
  const previous = `${candidate}.previous`;
  try {
    await rename(built, candidate);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(built, candidate, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
    });
  }
  await validateTestApplication(candidate);
  if (installed) await rename(application, previous);
  try {
    await rename(candidate, application);
  } catch (error) {
    if (installed) await rename(previous, application);
    throw error;
  }
  if (installed) await rm(previous, { recursive: true });
  await writeFile(
    join(work, 'installed.json'),
    JSON.stringify(
      {
        application,
        source: configuration.nodBuild.source,
        modified: configuration.nodBuild.modified,
        runtime: release.id,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`Installed ${application}`);
}

async function open(fresh, label) {
  await validateTestApplication(application);
  if (!label && fresh)
    label = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  if (!label) label = JSON.parse(await readFile(join(work, 'current-profile.json'), 'utf8')).name;
  const profile = await testProfile(profiles, label, fresh);
  await stop();
  await run('/usr/bin/open', [
    '-n',
    '-a',
    application,
    '--env',
    `NOD_DESKTOP_USER_DATA=${profile}`,
  ]);
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'current-profile.json'), JSON.stringify({ name: label }), {
    mode: 0o600,
  });
  console.log(`Opened ${name} with test profile ${label}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'darwin') throw new Error('This local test installer requires macOS.');
  const [command, argument] = process.argv.slice(2);
  if (command === 'build') await build(argument);
  else if (command === 'fresh' || command === 'open') await open(command === 'fresh', argument);
  else if (command === 'stop') await stop();
  else
    console.log(
      'Usage: node desktop/scripts/test-install.mjs build [installed-engine] | fresh [name] | open [name] | stop',
    );
}
