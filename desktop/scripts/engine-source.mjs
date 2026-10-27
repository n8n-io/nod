import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { copyBundleSource } from './engine-dependencies.mjs';
import { run } from './release-tools.mjs';

export async function copyEngineSource({ root, target, platform = 'darwin' }) {
  for (const path of [
    'src',
    'dist/web',
    'LICENSE',
    'NOTICE',
    'desktop/main/engine.mjs',
    'desktop/main/onepassword.mjs',
    'desktop/runtime/index.mjs',
    'desktop/runtime/assets.mjs',
    'desktop/runtime/guest-config.mjs',
    ...(platform === 'win32'
      ? ['desktop/runtime/windows.mjs', 'desktop/runtime/protect-profile.ps1']
      : []),
  ]) {
    await mkdir(dirname(join(target, path)), { recursive: true });
    await copyBundleSource(join(root, path), join(target, path), (file) => {
      const path = relative(root, file).replaceAll('\\', '/');
      return !/^src\/web(?:\/|$)|\.(?:map|tsbuildinfo)$|\.d\.(?:ts|mts|cts)$/.test(path);
    });
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest.packageManager;
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function verifyApplicationRuntime(application, electronVersion) {
  const engine = join(application, 'Contents/Resources/engine');
  const environment = Object.fromEntries(
    ['HOME', 'TMPDIR', 'PATH', 'LANG']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  const script = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
assert.equal(process.versions.electron, ${JSON.stringify(electronVersion)});
assert.equal(process.arch, ${JSON.stringify(process.arch)});
await import('@earendil-works/pi-coding-agent');
await import('pi-web-access/dist/index.js');
const { register } = await import('tsx/esm/api');
register();
await import(pathToFileURL(resolve('src/server/composition.ts')).href);
const { pool } = await import(pathToFileURL(resolve('src/server/db.ts')).href);
await pool.end();
const sharp = (await import('sharp')).default;
const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
assert.equal((await sharp(image).metadata()).width, 2);
const native = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-tui/dist/native-platform.js')).href);
assert(native.getNativePlatformHelper());
console.log('Nod engine imports verified.');`;
  const result = await run(
    join(application, 'Contents/MacOS/nod'),
    ['--input-type=module', '-e', script],
    { cwd: engine, env: { ...environment, ELECTRON_RUN_AS_NODE: '1' } },
  );
  if (result !== 'Nod engine imports verified.')
    throw new Error('The signed Electron engine import check failed.');
}
