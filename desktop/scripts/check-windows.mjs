import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { run } from './release-tools.mjs';
import { assetHash } from '../runtime/assets.mjs';
import { windowsEnvironment } from '../runtime/windows.mjs';

assert.equal(process.platform, 'win32');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'dist/windows');
const installation = await mkdtemp(join(tmpdir(), 'otto-installed-preview-'));
const foreign = await mkdtemp(join(tmpdir(), 'otto-foreign-folder-'));
const alone = await mkdtemp(join(tmpdir(), 'otto-installer-alone-'));
const receipt = { installed: false, engine: false, wsl: false };
const environment = { ...windowsEnvironment(), ELECTRON_RUN_AS_NODE: '1' };
try {
  console.log('Checking that installation preserves other files.');
  await writeFile(join(foreign, 'keep.txt'), 'synthetic user file');
  await assert.rejects(
    run(join(output, 'Otto-Setup-x64.exe'), ['/S', `/D=${foreign}`], { timeout: 60_000 }),
    { message: /^Otto-Setup-x64\.exe failed \([12]\)\.$/ },
  );
  assert.deepEqual(await readdir(foreign), ['keep.txt']);
  assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'synthetic user file');
  console.log('Installing the Windows preview without its runtime file.');
  await copyFile(join(output, 'Otto-Setup-x64.exe'), join(alone, 'Otto-Setup-x64.exe'));
  await run(join(alone, 'Otto-Setup-x64.exe'), ['/S', `/D=${installation}`], { timeout: 600_000 });
  const application = join(installation, 'Otto.exe');
  const engine = join(installation, 'resources/engine');
  const archive = join(engine, 'windows-runtime/guest.tar.gz');
  await assert.rejects(stat(archive), { code: 'ENOENT' });
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
if (process.env.WORKSPACE_CONTAINER) {
  const { register } = await import('tsx/esm/api');
  register();
  const { createDockerWorkspace } = await import('./src/providers/docker/index.ts');
  const { workspaceOutputs } = await import('./src/providers/pi/sandbox.ts');
  const { access, writeFile } = await import('node:fs/promises');
  const { randomBytes } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const provider = createDockerWorkspace({ container: process.env.WORKSPACE_CONTAINER, workspaceRoot: resolve('synthetic-workspaces') });
  const id = 'synthetic-Windows_check';
  const workspace = provider.open({ threadId: id, workspacePath: resolve('synthetic-workspaces', id), signal: AbortSignal.timeout(120_000) });
  try {
    for (const forward of [false, true]) {
      const file = join(tmpdir(), 'pi-codemode-' + randomBytes(8).toString('hex') + '.txt');
      const bytes = 'synthetic full output: π';
      await writeFile(file, bytes);
      const reported = forward ? file.replaceAll('\\\\', '/') : file;
      const moved = await workspaceOutputs(async () => ({ content: [{ type: 'text', text: reported }], details: { fullOutputPath: reported }, structuredContent: { full_output_path: reported } }), workspace);
      assert.equal(moved.content[0].text, moved.details.fullOutputPath);
      assert.equal(moved.structuredContent.full_output_path, moved.details.fullOutputPath);
      assert.match(moved.details.fullOutputPath, /^\\/workspace\\/synthetic-Windows_check\\/\\.otto\\/outputs\\//);
      assert.equal((await provider.readArtifact(id, moved.details.fullOutputPath, 1024)).toString('utf8'), bytes);
      await assert.rejects(access(file), { code: 'ENOENT' });
    }
  } finally {
    await provider.dispose();
  }
  const { createContainerBrowserComputer } = await import('./src/providers/container-browser/index.ts');
  const browser = createContainerBrowserComputer({ dataRoot: process.env.OTTO_DATA_ROOT, container: process.env.BROWSER_CONTAINER });
  try {
    const page = await browser.act(id, { action: 'open', url: 'https://example.com' }, AbortSignal.timeout(60_000));
    assert.equal(new URL(page.url).hostname, 'example.com');
    const screenshot = await browser.screenshot(id, AbortSignal.timeout(30_000));
    assert(screenshot && screenshot.length > 1000);
  } finally {
    await browser.dispose();
  }
  const { createServer } = await import('node:net');
  const listener = createServer();
  await new Promise((accept) => listener.listen(0, '127.0.0.1', accept));
  const port = listener.address().port;
  await new Promise((accept) => listener.close(accept));
  const token = randomBytes(32).toString('base64url');
  Object.assign(process.env, { NODE_ENV: 'production', PORT: String(port), OTTO_DESKTOP: 'true', OTTO_DESKTOP_OWNER_ID: '60000000-0000-4000-8000-000000000001', OTTO_DESKTOP_AUTH_TOKEN: token, OTTO_VAULT_KEY: randomBytes(32).toString('base64'), OTTO_WEB_ROOT: resolve('dist/web'), OTTO_ANALYTICS_ENABLED: 'false' });
  const { default: pg } = await import('pg');
  const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  try {
    if (!process.env.OTTO_WINDOWS_REOPEN) {
      await database.query('CREATE TABLE windows_check (value integer NOT NULL)');
      await database.query('INSERT INTO windows_check VALUES (42)');
    }
    assert.equal((await database.query('SELECT value FROM windows_check')).rows[0].value, 42);
  } finally {
    await database.end();
  }
  await import('./desktop/main/engine.mjs');
  const origin = 'http://127.0.0.1:' + port;
  const denied = await fetch(origin + '/api/configuration');
  assert.equal(denied.status, 401);
  const headers = { 'x-otto-desktop-token': token };
  const response = await fetch(origin + '/api/configuration', { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).llmReady, false);
  assert.equal((await fetch(origin + '/onboarding', { headers })).status, 200);
  console.log('Windows application and browser verified.');
  process.emit('SIGTERM');
} else {
  console.log('Windows engine verified.');
}
`;
  const smoke = join(engine, 'windows-smoke.mjs');
  await writeFile(smoke, script, { flag: 'wx' });
  console.log('Checking the installed Windows engine.');
  const result = await run(application, [smoke], {
    cwd: engine,
    env: environment,
    timeout: 120_000,
  });
  assert.equal(result, 'Windows engine verified.');
  receipt.installed = true;
  receipt.engine = true;
  console.log('Windows installation and native engine verified.');
  const wsl = join(process.env.SYSTEMROOT, 'System32/wsl.exe');
  console.log('Checking WSL 2.');
  await run(wsl, ['--status']);
  {
    const profile = join(installation, 'synthetic-profile');
    const runtime = await import('../runtime/windows.mjs');
    let prepared;
    try {
      prepared = await runtime.prepareWindowsRuntime(
        {
          dataRoot: profile,
          resourcesPath: engine,
          onStatus: (value) => value.phase === 'downloading' || console.log(value.message),
          resolveDownloadUrl: async () =>
            'https://runtime.example.invalid/Otto-Runtime-win32-x64.tar.gz',
          fetch: async () =>
            new Response(
              Readable.toWeb(createReadStream(join(output, 'Otto-Runtime-win32-x64.tar.gz'))),
            ),
        },
        () => {},
      );
      await assert.rejects(stat(archive), { code: 'ENOENT' });
      await assert.rejects(stat(join(profile, 'desktop-runtime/guest.tar.gz')), { code: 'ENOENT' });
      await run(
        join(engine, 'windows-runtime/bin/docker.exe'),
        [
          'exec',
          '--user',
          'node',
          '--workdir',
          '/workspace/synthetic-windows-check',
          prepared.env.WORKSPACE_CONTAINER,
          'bash',
          '-c',
          'test ! -e /var/run/docker.sock && test ! -e /mnt/c && test ! -e /app/.env',
        ],
        { env: { ...environment, ...prepared.env }, timeout: 120_000 },
      );
      assert.match(
        await run(application, [smoke], {
          cwd: engine,
          env: { ...environment, ...prepared.env },
          timeout: 300_000,
        }),
        /Windows application and browser verified\./,
      );
      receipt.wsl = true;
      receipt.application = true;
      receipt.browser = true;
      receipt.workspaceFiles = true;
      console.log('Windows application, browser and workspace verified.');
      await runtime.stopWindowsRuntime({ dataRoot: profile });
      console.log('Checking restart and saved data.');
      prepared = await runtime.prepareWindowsRuntime(
        {
          dataRoot: profile,
          resourcesPath: engine,
          onStatus: (value) => console.log(value.message),
        },
        () => {},
      );
      assert.match(
        await run(application, [smoke], {
          cwd: engine,
          env: { ...environment, ...prepared.env, OTTO_WINDOWS_REOPEN: '1' },
          timeout: 300_000,
        }),
        /Windows application and browser verified\./,
      );
      receipt.reopened = true;
    } finally {
      console.log('Stopping the test computer.');
      await runtime.stopWindowsRuntime({ dataRoot: profile });
      const saved = await readFile(join(profile, 'desktop-runtime/state.json'), 'utf8')
        .then((value) => JSON.parse(value))
        .catch(() => null);
      if (saved?.distribution && /^Otto-[a-f0-9]{12}$/.test(saved.distribution))
        await run(wsl, ['--unregister', saved.distribution]);
    }
  }
  console.log('Checking that an update installs its runtime file.');
  await run(join(output, 'Otto-Setup-x64.exe'), ['/S', `/D=${installation}`], { timeout: 600_000 });
  const { guest } = JSON.parse(
    await readFile(join(engine, 'windows-runtime/manifest.json'), 'utf8'),
  );
  assert.equal(await assetHash(archive), guest.sha256);
  await writeFile(join(output, 'windows-check.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  console.log('Removing the test installation.');
  await rm(installation, { recursive: true, force: true });
  await rm(foreign, { recursive: true, force: true });
  await rm(alone, { recursive: true, force: true });
}
