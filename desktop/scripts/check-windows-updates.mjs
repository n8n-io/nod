import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
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
import {
  protectWindowsProfile,
  stageWindowsUpdate,
  unsignedWindowsFiles,
  windowsEnvironment,
  windowsPublisher,
} from '../runtime/windows.mjs';
import { run } from './release-tools.mjs';

assert.equal(process.platform, 'win32', 'Use a disposable Windows runner.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable GitHub runner.');
assert.equal(process.env.RUNNER_OS, 'Windows', 'Use a disposable Windows runner.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runner = await realpath(process.env.RUNNER_TEMP);
const root = await mkdtemp(join(runner, 'nod-update-'));
const profile = join(root, 'profile');
const installation = join(root, 'installed Nod');
const events = join(root, 'events.jsonl');
const stop = join(root, 'stop');
const output = join(repository, '.local/windows-update-acceptance');
const executable = join(installation, 'nod.exe');
const powershell = join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsis = process.env.NOD_NSIS || join(process.env['ProgramFiles(x86)'], 'NSIS/makensis.exe');
const configuration = JSON.parse(await readFile(join(repository, 'desktop/package.json')));
const electronChecksums = JSON.parse(
  await readFile(join(repository, 'desktop/node_modules/electron/checksums.json')),
);
const environment = { ...process.env, NOD_UPDATE_FIXTURE_ROOT: root };
delete environment.ELECTRON_RUN_AS_NODE;
const receipt = { source: await run('git', ['rev-parse', 'HEAD'], { cwd: repository }) };
const challenge = randomBytes(32).toString('base64url');
let child;
let installed = false;
let certificates = [];
let failure;
const fixtureSigning = [
  "$ErrorActionPreference = 'Stop'",
  "foreach ($name in 'foreign', 'n8n') {",
  "  $usage = if ($name -eq 'n8n') { $env:NOD_PUBLISHER_PROFILE } else { '1.3.6.1.4.1.311.97.1.0' }",
  "  $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=n8n GmbH' -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -TextExtension @(\"2.5.29.37={text}1.3.6.1.5.5.7.3.3,$usage\") -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddHours(2)",
  '  $certificate.Thumbprint',
  '  $public = Join-Path $env:NOD_SIGNATURES "$name.cer"',
  '  Export-Certificate -Cert $certificate -FilePath $public | Out-Null',
  "  Import-Certificate -FilePath $public -CertStoreLocation 'Cert:\\LocalMachine\\Root' | Out-Null",
  '  $signature = Set-AuthenticodeSignature -LiteralPath (Join-Path $env:NOD_SIGNATURES "$name.exe") -Certificate $certificate -HashAlgorithm SHA256 -IncludeChain All',
  '  if ($signature.Status -ne \'Valid\') { throw "The $name fixture signature is $($signature.Status)." }',
  '}',
].join('\n');

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
    assert.ok(ready || child.exitCode === null, `Nod exited before readiness (${child.exitCode}).`);
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
    "if (Test-Path 'HKCU:\\Software\\nod') { exit 1 }",
  ]);
  await mkdir(output, { recursive: true });
  await protectWindowsProfile(profile, repository);
  await mkdir(join(root, 'electron'));
  const owner = randomUUID();
  await writeFile(join(profile, 'profile.json'), JSON.stringify({ ownerId: owner }));
  const source = join(root, 'source');
  await mkdir(source);
  await copyFile(join(repository, 'desktop/main/settings.mjs'), join(source, 'settings.mjs'));
  await copyFile(
    join(repository, 'desktop/main/windows-update.mjs'),
    join(source, 'windows-update.mjs'),
  );
  const vaultPath = join(repository, 'src/server/vault-crypto.ts');
  await writeFile(
    join(source, 'vault-crypto.mjs'),
    (await transformWithEsbuild(await readFile(vaultPath, 'utf8'), vaultPath)).code,
  );
  const identityPath = join(repository, 'src/providers/composio/identity.ts');
  const identitySource = await readFile(identityPath, 'utf8');
  receipt.identityModuleHash = createHash('sha256').update(identitySource).digest('hex');
  await writeFile(
    join(source, 'identity.mjs'),
    (await transformWithEsbuild(identitySource, identityPath)).code,
  );
  await writeFile(
    join(source, 'main.mjs'),
    `import assert from 'node:assert/strict';
import { app, safeStorage } from 'electron';
import { createHash, sign } from 'node:crypto';
import { appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSettingsStore } from './settings.mjs';
import { startWindowsInstall } from './windows-update.mjs';
import { sealVaultValue, openVaultValue } from './vault-crypto.mjs';
import { loadIntegrationIdentity } from './identity.mjs';
const root = process.env.NOD_UPDATE_FIXTURE_ROOT;
const profile = join(root, 'profile');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (event, fields = {}) => appendFile(join(root, 'events.jsonl'), JSON.stringify({ event, pid: process.pid, version: app.getVersion(), ...fields }) + '\\n');
app.setPath('userData', join(root, 'electron'));
if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes('--quit')) app.exit();
else {
app.on('second-instance', async (_event, argv) => {
  if (!argv.includes('--quit')) return;
  await record('stopped');
  app.exit(0);
});
app.whenReady().then(async () => {
  const settingsPath = join(profile, 'settings.json');
  const fresh = await stat(settingsPath).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error; });
  if (fresh) await writeFile(settingsPath, JSON.stringify({ version: 1, theme: 'system', onboardingCompleted: true, notifications: false, launchAtLogin: true, secrets: {} }), { mode: 0o600 });
  const store = createSettingsStore(settingsPath, safeStorage);
  const key = Buffer.from((await store.environment()).NOD_VAULT_KEY, 'base64');
  const owner = JSON.parse(await readFile(join(profile, 'profile.json'), 'utf8')).ownerId;
  const identity = await loadIntegrationIdentity({
    dataRoot: profile, ownerId: owner,
    keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.from(key) },
    checkpoint: {
      read: async () => {
        try { return await readFile(join(profile, 'identity-checkpoint'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      },
      commit: async (publicKey) => {
        try { await writeFile(join(profile, 'identity-checkpoint'), publicKey, { mode: 0o600, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (await readFile(join(profile, 'identity-checkpoint'), 'utf8') !== publicKey) throw new Error('Fixture identity checkpoint changed.');
      },
    },
  });
  const binding = ['synthetic-owner', 'synthetic-model'];
  const secret = 'synthetic-saved-provider-credential';
  if (fresh) await writeFile(join(profile, 'vault'), sealVaultValue(key, binding, secret));
  assert.equal(openVaultValue(key, binding, await readFile(join(profile, 'vault'), 'utf8')), secret);
  const saved = await store.get();
  assert.equal(saved.onboardingCompleted, true);
  assert.equal(saved.onboardingPreferenceStep, 'complete');
  const files = {};
  for (const name of ['settings.json', 'profile.json', 'vault', 'identity-checkpoint', 'integration-identity/' + hash(owner) + '.encrypted', 'integration-identity/' + hash(owner) + '.public']) files[name] = hash(await readFile(join(profile, name)));
  await record('ready', { files, keyHash: hash(key), preferences: saved, publicKey: identity.publicKey, managedOwner: identity.userId,
    identityProof: sign(null, Buffer.from(${JSON.stringify(challenge)} + ':' + app.getVersion()), identity.key).toString('base64url') });
  if (app.getVersion() === '1.0.1') { await record('stopped'); app.exit(0); }
  else {
    let stopping = false;
    setInterval(async () => {
      if (stopping || !await stat(join(root, 'stop')).then(() => true, () => false)) return;
      stopping = true;
      const update = (await readFile(join(root, 'stop'), 'utf8')).replace(/^stop$/, '');
      await rm(join(root, 'stop'));
      if (update)
        try { await startWindowsInstall({ directory: update, appPath: process.execPath, pid: process.pid, systemRoot: process.env.SYSTEMROOT }); }
        catch (error) { await record('error', { message: error.message }); app.exit(1); return; }
      await record('stopped');
      app.exit(0);
    }, 100);
  }
}).catch(async (error) => {
  await record('error', { message: error.message });
  app.exit(1);
});
}
`,
  );
  const installers = {};
  for (const version of ['1.0.0', '1.0.1']) {
    receipt.stage = `packaging ${version}`;
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'nod-update-fixture',
        productName: 'nod',
        version,
        main: 'main.mjs',
        type: 'module',
      }),
    );
    const [application] = await packager({
      dir: source,
      out: join(root, `package-${version}`),
      name: 'nod',
      platform: 'win32',
      arch: 'x64',
      electronVersion: configuration.devDependencies.electron,
      download: { checksums: electronChecksums },
      appVersion: version,
      win32metadata: { CompanyName: 'n8n GmbH', ProductName: 'Nod', FileDescription: 'Nod' },
      overwrite: true,
    });
    const stage = join(root, `stage-${version}`);
    await mkdir(stage);
    installers[version] = join(stage, 'nod-Setup-x64.exe');
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
  receipt.stage = 'checking update signatures';
  const signatures = join(root, 'signatures');
  await mkdir(signatures);
  for (const name of ['unsigned', 'foreign', 'n8n'])
    await copyFile(installers['1.0.1'], join(signatures, `${name}.exe`));
  certificates = (
    await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', fixtureSigning], {
      env: {
        ...windowsEnvironment(),
        NOD_SIGNATURES: signatures,
        NOD_PUBLISHER_PROFILE: windowsPublisher.profile,
      },
      output: 'stdout',
    })
  )
    .split(/\r?\n/)
    .filter(Boolean);
  for (const [name, accepted] of [
    ['unsigned', false],
    ['foreign', false],
    ['n8n', true],
  ]) {
    const bytes = await readFile(join(signatures, `${name}.exe`));
    const staged = stageWindowsUpdate(
      {
        version: '1.0.1',
        installer: {
          file: 'nod-Setup-x64.exe',
          url: 'https://updates.example.invalid/nod-Setup-x64.exe',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        runtime: { file: 'nod-Runtime-win32-x64.tar.gz' },
      },
      {
        directory: join(root, 'staged'),
        resourcesPath: repository,
        includeRuntime: false,
        fetch: async () => new Response(bytes),
      },
    );
    if (accepted) await staged;
    else await assert.rejects(staged, { message: 'The Nod update is not signed by n8n GmbH.' });
  }
  const system = join(process.env.SYSTEMROOT, 'System32/kernel32.dll');
  assert.deepEqual(await unsignedWindowsFiles([system], { release: true }), []);
  assert.equal((await unsignedWindowsFiles([system])).length, 1);
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
  const identityPublicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: first.publicKey },
    format: 'jwk',
  });
  const verifyIdentity = (entry) => {
    assert.equal(entry.publicKey, first.publicKey);
    assert.equal(
      entry.managedOwner,
      `nod_${createHash('sha256').update(Buffer.from(first.publicKey, 'base64url')).digest('hex')}`,
    );
    assert.equal(
      verify(
        null,
        Buffer.from(`${challenge}:${entry.version}`),
        identityPublicKey,
        Buffer.from(entry.identityProof, 'base64url'),
      ),
      true,
    );
  };
  verifyIdentity(first);
  const rejected = join(root, 'rejected');
  await mkdir(rejected);
  const rejectedSource = join(rejected, 'failed.nsi');
  await writeFile(
    rejectedSource,
    `Unicode true\nName "Nod rejected update fixture"\nOutFile "${join(rejected, 'nod-Setup-x64.exe')}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSetErrorLevel 5\nSectionEnd\n`,
  );
  await run(nsis, [rejectedSource]);
  receipt.stage = 'rejecting failed update';
  const rejectedUpdate = await replace(rejected);
  assert.equal(rejectedUpdate.ok, false, 'A rejected installer must fail without opening Nod.');
  await delay(500);
  assert.equal((await recorded()).filter((entry) => entry.event === 'ready').length, 1);
  receipt.stage = 'restarting 1.0.0';
  const recovered = await start();
  assert.equal(recovered.version, '1.0.0');
  assert.deepEqual(recovered.files, first.files);
  assert.equal(recovered.keyHash, first.keyHash);
  verifyIdentity(recovered);
  receipt.stage = 'reinstalling 1.0.0 while it runs';
  await run(installers['1.0.0'], ['/S', `/D=${installation}`], {
    env: environment,
    timeout: 180_000,
    windowsVerbatimArguments: true,
    argv0: `"${installers['1.0.0']}"`,
  });
  await waitFor((entries) =>
    entries.find((entry) => entry.event === 'stopped' && entry.pid === child.pid),
  );
  verifyIdentity(await start());
  receipt.stage = 'updating to 1.0.1 from the running app';
  await writeFile(stop, dirname(installers['1.0.1']));
  await waitFor((entries) =>
    entries.find((entry) => entry.event === 'stopped' && entry.pid === child.pid),
  );
  const updated = await waitFor((entries) =>
    entries.find((entry) => entry.event === 'ready' && entry.version === '1.0.1'),
  );
  await waitFor((entries) =>
    entries.find((entry) => entry.event === 'stopped' && entry.pid === updated.pid),
  );
  assert.deepEqual(updated.files, first.files);
  assert.equal(updated.keyHash, first.keyHash);
  assert.deepEqual(updated.preferences, first.preferences);
  verifyIdentity(updated);
  Object.assign(receipt, {
    passed: true,
    stage: 'completed',
    versions: ['1.0.0', '1.0.1'],
    realPowerShell: true,
    realNsis: true,
    realElectron: true,
    failedInstallPreserved: true,
    runningAppQuitByInstaller: true,
    updateStartedByApp: true,
    foreignInstallerRefused: true,
    windowsCatalogInstallerRefused: true,
    encryptedProfilePreserved: true,
    encryptedIntegrationIdentityPreserved: true,
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
    if (certificates.length)
      await run(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'foreach ($thumbprint in $env:NOD_CERTIFICATES.Split(\',\')) { Remove-Item -LiteralPath "Cert:\\LocalMachine\\Root\\$thumbprint", "Cert:\\CurrentUser\\My\\$thumbprint" }',
        ],
        { env: { ...windowsEnvironment(), NOD_CERTIFICATES: certificates.join(',') } },
      );
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
