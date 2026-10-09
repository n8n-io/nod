import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './release-tools.mjs';

assert.equal(process.platform, 'win32');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'dist/windows');
const installation = await mkdtemp(join(tmpdir(), 'otto-installed-preview-'));
const receipt = { installed: false, engine: false, wsl: false };
try {
  await run(join(output, 'Otto-Setup-x64.exe'), ['/S', `/D=${installation}`], { timeout: 600_000 });
  const application = join(installation, 'Otto.exe');
  const engine = join(installation, 'resources/engine');
  const { devDependencies } = JSON.parse(
    await readFile(join(root, 'desktop/package.json'), 'utf8'),
  );
  const script = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.versions.electron, ${JSON.stringify(devDependencies.electron)});
await import('@earendil-works/pi-coding-agent');
await import('pi-web-access/dist/index.js');
const native = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-tui/dist/native-platform.js')).href);
assert(native.getNativePlatformHelper());
const { executeCodemode } = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js')).href);
const result = await executeCodemode('synthetic-windows-check', { code: 'text(6 * 7)' });
assert.equal(result.isError, undefined);
assert.match(result.content.map((item) => item.text || '').join('\\n'), /^42$/m);
console.log('Windows engine verified.');`;
  const smoke = join(engine, 'windows-smoke.mjs');
  await writeFile(smoke, script, { flag: 'wx' });
  const result = await run(application, [smoke], {
    cwd: engine,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      ELECTRON_RUN_AS_NODE: '1',
    },
    timeout: 120_000,
  });
  await rm(smoke);
  assert.equal(result, 'Windows engine verified.');
  receipt.installed = true;
  receipt.engine = true;
  const wsl = join(process.env.SYSTEMROOT, 'System32/wsl.exe');
  const available = await run(wsl, ['--status']).then(
    () => true,
    () => false,
  );
  if (available) {
    const profile = join(installation, 'synthetic-profile');
    const runtime = await import('../runtime/windows.mjs');
    let prepared;
    try {
      prepared = await runtime.prepareWindowsRuntime(
        { dataRoot: profile, resourcesPath: engine },
        () => {},
      );
      const child = spawn(
        join(engine, 'windows-runtime/bin/docker.exe'),
        [
          'exec',
          prepared.env.WORKSPACE_CONTAINER,
          'bash',
          '-c',
          'test ! -e /var/run/docker.sock && test ! -e /mnt/c && test ! -e /app/.env',
        ],
        { env: { ...process.env, ...prepared.env } },
      );
      await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? accept() : reject(new Error('Windows workspace isolation check failed.')),
        );
      });
      receipt.wsl = true;
    } finally {
      await runtime.stopWindowsRuntime({ dataRoot: profile });
      const saved = await readFile(join(profile, 'desktop-runtime/state.json'), 'utf8')
        .then((value) => JSON.parse(value))
        .catch(() => null);
      if (saved?.distribution && /^Otto-[a-f0-9]{12}$/.test(saved.distribution))
        await run(wsl, ['--unregister', saved.distribution]);
    }
  } else {
    receipt.wslReason =
      'The CI runner does not have WSL 2 ready. Test the private computer on Windows 11.';
  }
  await writeFile(join(output, 'windows-check.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  await rm(installation, { recursive: true, force: true });
}
