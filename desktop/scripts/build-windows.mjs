import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { assetHash } from '../runtime/assets.mjs';
import { copyBundleSource, copyEngineDependencies } from './engine-dependencies.mjs';
import { buildDesktopUI } from './build-ui.mjs';
import { run } from './release-tools.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build this preview on Windows x64.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'dist/windows');
const stage = join(root, 'dist/windows-staging');
const source = join(stage, 'app');
const engine = join(stage, 'engine');
const assets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(root, '.local/windows-runtime-assets'),
);
const configuration = JSON.parse(await readFile(join(root, 'desktop/package.json'), 'utf8'));
const tracesToken = process.env.NOD_TRACES_TOKEN;
if (tracesToken && !/^[A-Za-z0-9_-]{32,128}$/.test(tracesToken))
  throw new Error('NOD_TRACES_TOKEN must be 32 to 128 URL-safe characters.');
const updateSourceUrl = process.env.NOD_DESKTOP_UPDATE_SOURCE_URL;
if (
  updateSourceUrl &&
  (!URL.canParse(updateSourceUrl) ||
    new URL(updateSourceUrl).protocol !== 'https:' ||
    new URL(updateSourceUrl).username ||
    new URL(updateSourceUrl).password ||
    /[?#]/.test(updateSourceUrl))
)
  throw new Error('The desktop update source must be a credential-free HTTPS URL.');
const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
if (
  manifest.platform !== 'win32-x64' ||
  (await stat(join(assets, 'guest.tar.gz'))).size !== manifest.guest.bytes ||
  (await assetHash(join(assets, 'guest.tar.gz'))) !== manifest.guest.sha256
)
  throw new Error('The Windows runtime failed its integrity check.');
await rm(stage, { recursive: true, force: true });
await mkdir(source, { recursive: true });
await mkdir(engine, { recursive: true });
await mkdir(output, { recursive: true });
for (const path of [
  'src',
  'public',
  'dist/web',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'LICENSE',
  'NOTICE',
  'desktop/runtime',
  'desktop/main/engine.mjs',
  'desktop/main/onepassword.mjs',
]) {
  await mkdir(dirname(join(engine, path)), { recursive: true });
  await copyBundleSource(join(root, path), join(engine, path));
}
await copyEngineDependencies({ root, target: engine, platform: 'win32', arch: 'x64' });
console.log('Windows engine files prepared.');
for (const path of ['main', 'preload'])
  await copyBundleSource(join(root, 'desktop', path), join(source, path));
await buildDesktopUI(join(source, 'ui'));
const runtime = join(engine, 'windows-runtime');
await mkdir(join(runtime, 'bin'), { recursive: true });
await run(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags=-s -w -H=windowsgui',
    '-o',
    join(runtime, 'bin/docker.exe'),
    join(root, 'desktop/runtime/wsl-docker_windows.go'),
  ],
  { env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' }, timeout: 300_000 },
);
console.log('Windows transport built.');
configuration.version = process.env.NOD_DESKTOP_VERSION || configuration.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(configuration.version))
  throw new Error('The Windows release version is invalid.');
manifest.transport = {
  file: 'bin/docker.exe',
  sha256: await assetHash(join(runtime, 'bin/docker.exe')),
};
manifest.releaseTag = `nod-v${configuration.version}`;
await writeFile(join(runtime, 'manifest.json'), JSON.stringify(manifest, null, 2));
const electronVersion = configuration.devDependencies.electron;
configuration.nodBuild = {
  source: await run('git', ['-C', root, 'rev-parse', 'HEAD'], { output: 'stdout' }),
  builtAt: new Date().toISOString(),
  platform: 'win32-x64',
  ...(updateSourceUrl ? { updateSourceUrl } : {}),
  ...(tracesToken ? { tracesToken } : {}),
  ...(process.env.NOD_RELEASE_BUILD === 'true' ? { release: true } : {}),
};
delete configuration.devDependencies;
delete configuration.scripts;
await writeFile(join(source, 'package.json'), JSON.stringify(configuration, null, 2));
const [application] = await packager({
  dir: source,
  out: output,
  name: 'nod',
  executableName: 'nod',
  appVersion: configuration.version,
  electronVersion,
  platform: 'win32',
  arch: 'x64',
  win32metadata: { CompanyName: 'n8n GmbH', ProductName: 'nod', FileDescription: 'nod' },
  asar: false,
  prune: false,
  overwrite: true,
});
console.log('Windows application packaged.');
await rename(engine, join(application, 'resources/engine'));
await cp(join(assets, 'guest.tar.gz'), join(output, 'nod-Runtime-win32-x64.tar.gz'));
const installer = join(output, 'nod-Setup-x64.exe');
const nsis =
  process.env.NOD_NSIS ||
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NSIS/makensis.exe');
console.log('Building the Windows installer.');
await run(
  nsis,
  [
    `/DAPP_DIR=${application}`,
    `/DOUTPUT=${installer}`,
    `/DVERSION=${configuration.version}`,
    join(root, 'desktop/scripts/windows-installer.nsi'),
  ],
  { timeout: 1_200_000 },
);
await writeFile(
  join(output, 'SHA256SUMS'),
  `${await assetHash(installer)}  nod-Setup-x64.exe\n${await assetHash(join(output, 'nod-Runtime-win32-x64.tar.gz'))}  nod-Runtime-win32-x64.tar.gz\n`,
);
console.log(`Windows installer ready: ${installer}`);

const guest = join(output, 'nod-Runtime-win32-x64.tar.gz');
await writeFile(
  join(output, 'release-win32-x64.json'),
  JSON.stringify(
    {
      version: configuration.version,
      source: configuration.nodBuild.source,
      platform: 'win32-x64',
      ...(updateSourceUrl ? { updateSourceUrl } : {}),
      signing: { mode: 'unsigned' },
      installer: {
        file: 'nod-Setup-x64.exe',
        bytes: (await stat(installer)).size,
        sha256: await assetHash(installer),
      },
      runtime: {
        file: 'nod-Runtime-win32-x64.tar.gz',
        bytes: (await stat(guest)).size,
        sha256: await assetHash(guest),
      },
    },
    null,
    2,
  ) + '\n',
);
