import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { transformWithEsbuild } from 'vite';
import { windowsInstallCommand } from '../main/windows-update.mjs';
import { protectWindowsProfile } from '../runtime/windows.mjs';
import { run } from './release-tools.mjs';

assert.equal(process.platform, 'win32', 'Use a disposable Windows runner.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable GitHub runner.');
assert.equal(process.env.RUNNER_OS, 'Windows', 'Use a disposable Windows runner.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = await realpath(process.env.RUNNER_TEMP);
const root = await mkdtemp(join(runner, 'otto-update-'));
const profile = join(root, 'profile');
const installation = join(root, 'installed Otto');
const events = join(root, 'events.jsonl');
const stop = join(root, 'stop');
const output = join(repository, '.local/windows-update-acceptance');
const executable = join(installation, 'Otto.exe');
const powershell = join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsis = process.env.OTTO_NSIS || join(process.env['ProgramFiles(x86)'], 'NSIS/makensis.exe');
const configuration = JSON.parse(await readFile(join(repository, 'desktop/package.json')));
const environment = { ...process.env, OTTO_UPDATE_FIXTURE_ROOT: root };
delete environment.ELECTRON_RUN_AS_NODE;
const receipt = { source: await run('git', ['rev-parse', 'HEAD'], { cwd: repository }) };
let child;
let installed = false;
let failure;

async function recorded() {
  const content = await readFile(events, 'utf8').catch(() => '');
  return content
    .slice(0, content.lastIndexOf('\n') + 1)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const entries = await recorded();
    assert.ok(!entries.some((entry) => entry.event === 'error'), JSON.stringify(entries));
    const result = predicate(entries);
    if (result) return result;
    await delay(100);
  }
  assert.fail('The isolated updater did not reach its expected state.');
}

async function start() {
  await rm(stop, { force: true });
  child = spawn(executable, [], { env: environment, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return waitFor((entries) => {
    const ready = entries.find((entry) => entry.event === 'ready' && entry.pid === child.pid);
    assert.ok(
      ready || child.exitCode === null,
      `Otto exited before readiness (${child.exitCode}).`,
    );
    return ready;
  });
}

async function replace(directory) {
  const { command, args, env } = windowsInstallCommand({
    directory,
    appPath: executable,
    pid: child.pid,
    systemRoot: process.env.SYSTEMROOT,
  });
  const operation = run(command, args, { env: { ...environment, ...env }, timeout: 180_000 });
  const result = operation.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await delay(250);
  assert.equal(child.exitCode, null);
  await writeFile(stop, 'stop');
  await waitFor((entries) =>
    entries.find((entry) => entry.event === 'stopped' && entry.pid === child.pid),
  );
  return result;
}

try {
  await run(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "if (Test-Path 'HKCU:\\Software\\Otto') { exit 1 }",
  ]);
  await mkdir(output, { recursive: true });
  await protectWindowsProfile(profile, repository);
  await mkdir(join(root, 'electron'));
  const owner = randomUUID();
  await writeFile(join(profile, 'profile.json'), JSON.stringify({ ownerId: owner }));
  const identity = generateKeyPairSync('ed25519').privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  await writeFile(join(profile, 'integration.pem'), identity);
  const source = join(root, 'source');
  await mkdir(source);
  await copyFile(join(repository, 'desktop/main/settings.mjs'), join(source, 'settings.mjs'));
  const vaultPath = join(repository, 'src/server/vault-crypto.ts');
  await writeFile(
    join(source, 'vault-crypto.mjs'),
    (await transformWithEsbuild(await readFile(vaultPath, 'utf8'), vaultPath)).code,
  );
  await writeFile(
    join(source, 'main.mjs'),
    `import assert from 'node:assert/strict';
import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSettingsStore } from './settings.mjs';
import { sealVaultValue, openVaultValue } from './vault-crypto.mjs';
const root = process.env.OTTO_UPDATE_FIXTURE_ROOT;
const profile = join(root, 'profile');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (event, fields = {}) => appendFile(join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid, version: app.getVersion(), ...fields }) + '\\n');
app.setPath('userData', join(root, 'electron'));
app.whenReady().then(async () => {
  const store = createSettingsStore(join(profile, 'settings.json'), safeStorage);
  const fresh = await stat(join(profile, 'settings.json')).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error; });
  if (fresh) await store.save({ onboardingCompleted: true, notifications: false, launchAtLogin: true });
  const key = Buffer.from((await store.environment()).OTTO_VAULT_KEY, 'base64');
  const binding = ['synthetic-owner', 'synthetic-model'];
  const secret = 'synthetic-saved-provider-credential';
  if (fresh) await writeFile(join(profile, 'vault'), sealVaultValue(key, binding, secret));
  assert.equal(openVaultValue(key, binding, await readFile(join(profile, 'vault'), 'utf8')), secret);
  const saved = await store.get();
  assert.equal(saved.onboardingCompleted, true);
  assert.equal(saved.onboardingPreferenceStep, 'complete');
  const files = {};
  for (const name of ['settings.json', 'profile.json', 'integration.pem', 'vault']) files[name] = hash(await readFile(join(profile, name)));
  await record('ready', { files, keyHash: hash(key), preferences: saved });
  if (app.getVersion() === '1.0.1') { await record('stopped'); app.exit(0); }
  else {
    let stopping = false;
    setInterval(async () => {
      if (stopping || !await stat(join(root, 'stop')).then(() => true, () => false)) return;
      stopping = true;
      await rm(join(root, 'stop'));
      await record('stopped');
      app.exit(0);
    }, 100);
  }
}).catch(async (error) => {
  await record('error', { message: error.message });
  app.exit(1);
});
`,
  );
  const installers = {};
  for (const version of ['1.0.0', '1.0.1']) {
    receipt.stage = `packaging ${version}`;
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'otto-update-fixture',
        productName: 'Otto',
        version,
        main: 'main.mjs',
        type: 'module',
      }),
    );
    const [application] = await packager({
      dir: source,
      out: join(root, `package-${version}`),
      name: 'Otto',
      platform: 'win32',
      arch: 'x64',
      electronVersion: configuration.devDependencies.electron,
      appVersion: version,
      win32metadata: { CompanyName: 'n8n GmbH', ProductName: 'Otto', FileDescription: 'Otto' },
      overwrite: true,
    });
    const stage = join(root, `stage-${version}`);
    await mkdir(stage);
    installers[version] = join(stage, 'Otto-Setup-x64.exe');
    await run(
      nsis,
      [
        `/DAPP_DIR=${application}`,
        `/DOUTPUT=${installers[version]}`,
        `/DVERSION=${version}`,
        join(repository, 'desktop/scripts/windows-installer.nsi'),
      ],
      { timeout: 600_000 },
    );
  }
  receipt.stage = 'installing 1.0.0';
  await run(installers['1.0.0'], ['/S', `/D=${installation}`], {
    timeout: 180_000,
    windowsVerbatimArguments: true,
    argv0: `"${installers['1.0.0']}"`,
  });
  installed = true;
  await stat(executable);
  await stat(join(installation, 'Uninstall.exe'));
  receipt.stage = 'starting 1.0.0';
  const first = await start();
  const rejected = join(root, 'rejected');
  await mkdir(rejected);
  const rejectedSource = join(rejected, 'failed.nsi');
  await writeFile(
    rejectedSource,
    `Unicode true\nName "Otto rejected update fixture"\nOutFile "${join(rejected, 'Otto-Setup-x64.exe')}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSetErrorLevel 5\nSectionEnd\n`,
  );
  await run(nsis, [rejectedSource]);
  receipt.stage = 'rejecting failed update';
  const rejectedUpdate = await replace(rejected);
  assert.equal(rejectedUpdate.ok, false, 'A rejected installer must fail without opening Otto.');
  await delay(500);
  assert.equal((await recorded()).filter((entry) => entry.event === 'ready').length, 1);
  receipt.stage = 'restarting 1.0.0';
  const recovered = await start();
  assert.equal(recovered.version, '1.0.0');
  assert.deepEqual(recovered.files, first.files);
  assert.equal(recovered.keyHash, first.keyHash);
  receipt.stage = 'updating to 1.0.1';
  const success = await replace(dirname(installers['1.0.1']));
  assert.equal(success.ok, true, success.error?.diagnostic);
  const updated = await waitFor((entries) =>
    entries.find((entry) => entry.event === 'ready' && entry.version === '1.0.1'),
  );
  await waitFor((entries) =>
    entries.find((entry) => entry.event === 'stopped' && entry.pid === updated.pid),
  );
  assert.deepEqual(updated.files, first.files);
  assert.equal(updated.keyHash, first.keyHash);
  assert.deepEqual(updated.preferences, first.preferences);
  Object.assign(receipt, {
    passed: true,
    stage: 'completed',
    versions: ['1.0.0', '1.0.1'],
    realPowerShell: true,
    realNsis: true,
    realElectron: true,
    failedInstallPreserved: true,
    encryptedProfilePreserved: true,
    completedOnboardingPreserved: true,
    files: updated.files,
    keyHash: updated.keyHash,
  });
  console.log(
    'Windows update replacement, failed-install recovery and encrypted completed-profile preservation passed.',
  );
} catch (error) {
  failure = error;
  Object.assign(receipt, { passed: false, error: error.message, diagnostic: error.diagnostic });
  throw error;
} finally {
  receipt.events = await recorded().catch((error) => [
    { event: 'read-error', message: error.message },
  ]);
  let cleanupError;
  try {
    if (child?.exitCode === null) child.kill();
    if (installed)
      await run(join(installation, 'Uninstall.exe'), ['/S', `_?=${installation}`], {
        windowsVerbatimArguments: true,
        argv0: `"${join(installation, 'Uninstall.exe')}"`,
      });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    receipt.cleanup = true;
  } catch (error) {
    cleanupError = error;
    Object.assign(receipt, { passed: false, cleanup: false, cleanupError: error.message });
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  if (cleanupError && !failure) throw cleanupError;
}
