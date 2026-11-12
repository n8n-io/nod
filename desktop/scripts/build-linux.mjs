import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { copyEngineSource, verifyApplicationRuntime } from './engine-source.mjs';
import { copyBundleSource as copy, copyEngineDependencies } from './engine-dependencies.mjs';
import { buildDesktopUI } from './build-ui.mjs';
import { desktopBuildOptions, hardenElectron, run, sourceRevision } from './release-tools.mjs';

if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('This desktop build requires a 64-bit Linux computer.');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(root, 'desktop');
const output = resolve(process.env.NOD_DESKTOP_OUTPUT || join(root, 'dist', 'desktop'));
const stage = resolve(process.env.NOD_DESKTOP_STAGE || join(root, 'dist', 'desktop-staging'));
const engine = join(stage, 'engine');
const appSource = join(stage, 'app');
const runtimeAssets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(root, '.local', 'desktop-runtime-assets'),
);
const platform = `linux-${process.arch}`;
const buildOptions = desktopBuildOptions();

const manifest = JSON.parse(await readFile(join(runtimeAssets, 'manifest.json'), 'utf8'));
if (manifest.platform !== platform)
  throw new Error(`The runtime assets are for ${manifest.platform}, not ${platform}.`);
const configuration = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const version = process.env.NOD_DESKTOP_VERSION || configuration.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error('The desktop version is invalid.');
configuration.version = version;
const electronVersion = configuration.devDependencies.electron;
for (const path of ['node_modules/tsx/dist/esm/api/index.mjs', 'dist/web/index.html'])
  await access(join(root, path));

await rm(stage, { recursive: true, force: true });
await mkdir(engine, { recursive: true });
await mkdir(appSource, { recursive: true });
await mkdir(output, { recursive: true });
await copyEngineSource({ root, target: engine, platform: 'linux' });
await copyEngineDependencies({ root, target: engine, platform: 'linux', arch: process.arch });
for (const path of ['main', 'preload']) await copy(join(desktop, path), join(appSource, path));
await buildDesktopUI(join(appSource, 'ui'));
await cp(runtimeAssets, join(engine, 'runtime-assets'), {
  recursive: true,
  mode: constants.COPYFILE_FICLONE,
  verbatimSymlinks: true,
});
configuration.nodBuild = {
  source: await sourceRevision(),
  builtAt: new Date().toISOString(),
  modified: Boolean(await run('/usr/bin/git', ['-C', root, 'status', '--porcelain'])),
  ...buildOptions,
};
delete configuration.devDependencies;
delete configuration.scripts;
await writeFile(join(appSource, 'package.json'), JSON.stringify(configuration, null, 2));

const [packaged] = await packager({
  dir: appSource,
  out: output,
  name: configuration.productName,
  executableName: 'nod',
  appVersion: version,
  appCopyright: 'Copyright © 2026 n8n GmbH',
  electronVersion,
  platform: 'linux',
  arch: process.arch,
  asar: false,
  prune: false,
  overwrite: true,
});
const resources = join(packaged, 'resources');
await rename(engine, join(resources, 'engine'));
const licenses = join(resources, 'licenses');
await mkdir(licenses, { recursive: true });
for (const name of ['LICENSE', 'LICENSES.chromium.html'])
  await copy(join(packaged, name), join(licenses, name));
await hardenElectron(join(packaged, 'nod'));
await verifyApplicationRuntime(packaged, electronVersion, {
  engine: join(resources, 'engine'),
  executable: join(packaged, 'nod'),
});
console.log(`Application ready: ${packaged}`);
