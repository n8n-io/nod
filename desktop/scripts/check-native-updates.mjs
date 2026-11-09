import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  X509Certificate,
} from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
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
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { transformWithEsbuild } from 'vite';
import { withAppleSigning } from '../../.github/scripts/with-apple-signing.mjs';
import { run, signApplication, signingConfiguration } from './release-tools.mjs';

const source = fileURLToPath(import.meta.url);
const repository = resolve(dirname(source), '../..');
const configuration = JSON.parse(await readFile(join(repository, 'desktop/package.json')));
const electronChecksums = JSON.parse(
  await readFile(join(repository, 'desktop/node_modules/electron/checksums.json')),
);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

assert.equal(process.platform, 'darwin', 'This acceptance case requires macOS.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable GitHub runner.');
assert.equal(process.env.RUNNER_OS, 'macOS', 'Use a disposable macOS runner.');
const runner = await realpath(process.env.RUNNER_TEMP);

async function packageFixtures(planPath) {
  assert.equal(dirname(dirname(planPath)), runner, 'The plan must belong to this runner.');
  const plan = JSON.parse(await readFile(planPath));
  for (const fixture of plan) {
    const directory = join(dirname(planPath), `source-${fixture.name}-${fixture.version}`);
    await mkdir(directory);
    for (const name of [
      'settings.mjs',
      'mac-encryption.mjs',
      'artifact-files.mjs',
      'artifact-file-handlers.mjs',
      'updates.mjs',
    ])
      await copyFile(join(repository, 'desktop/main', name), join(directory, name));
    const identityPath = join(repository, 'src/providers/composio/identity.ts');
    await writeFile(
      join(directory, 'identity.mjs'),
      (await transformWithEsbuild(await readFile(identityPath, 'utf8'), identityPath)).code,
    );
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: fixture.name,
        productName:
          fixture.version === fixture.installed ? fixture.initialName : fixture.displayName,
        version: fixture.version,
        type: 'module',
        main: 'main.mjs',
      }),
    );
    await writeFile(
      join(directory, 'main.mjs'),
      "import { readFile } from 'node:fs/promises';\nawait readFile(new URL('./package.json', import.meta.url));\nawait import('./main.cjs');\n",
    );
    await writeFile(
      join(directory, 'preload.cjs'),
      `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeFixture', {
  prepare: () => ipcRenderer.invoke('nod:file:action', ${JSON.stringify(fixture.artifactId)}, 'prepare'),
});`,
    );
    await writeFile(
      join(directory, 'main.cjs'),
      `
const { app, autoUpdater, BrowserWindow, safeStorage } = require('electron');
const { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { createHash, sign } = require('node:crypto');
const { join } = require('node:path');
const fixture = ${JSON.stringify(fixture)};
app.setName(fixture.version === fixture.installed ? fixture.initialName : fixture.storageName);
app.setPath('userData', fixture.profile);
app.setPath('temp', fixture.temporary);
const receipt = (event, fields = {}) => appendFileSync(fixture.events,
  JSON.stringify({ event, version: app.getVersion(), at: Date.now(), pid: process.pid, executable: process.execPath,
    dataHash: createHash('sha256').update(readFileSync(fixture.data)).digest('hex'), ...fields }) + '\\n');
app.whenReady().then(async () => {
  app.setName(fixture.displayName);
  const { createSettingsStore } = await import('./settings.mjs');
  const { createMacEncryption } = await import('./mac-encryption.mjs');
  const encryption = app.getVersion() === fixture.installed ? safeStorage : createMacEncryption(safeStorage, { previousName: fixture.initialName });
  const { registerArtifactFileHandlers } = await import('./artifact-file-handlers.mjs');
  const page = 'data:text/html;base64,' + Buffer.from('<title>Native update fixture</title>').toString('base64');
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let artifactRoot;
  const disposeArtifactFiles = registerArtifactFileHandlers({
    isEngine: ({ sender, senderFrame }) => sender === window.webContents && senderFrame === window.webContents.mainFrame && senderFrame.url === page,
    origin: () => fixture.artifactOrigin, headers: () => ({}), window: () => window,
  });
  app.on('will-quit', (event) => receipt('quit-accepted', {
    cancelled: Boolean(event.defaultPrevented), artifactRemoved: !artifactRoot || !existsSync(artifactRoot),
  }));
  const initialLaunch = !existsSync(fixture.remoteSettings);
  const remoteSettings = createSettingsStore(fixture.remoteSettings, encryption);
  if (initialLaunch) await remoteSettings.saveConnection({ url: fixture.serverUrl, token: fixture.serverToken });
  const remoteSettingsBefore = readFileSync(fixture.remoteSettings);
  const connection = await remoteSettings.connection();
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Fixture encryption is unavailable.');
  if (initialLaunch)
    writeFileSync(fixture.encrypted, safeStorage.encryptString(fixture.sentinel), { mode: 0o600, flag: 'wx' });
  const encrypted = readFileSync(fixture.encrypted);
  if (initialLaunch)
    writeFileSync(fixture.settings, JSON.stringify({
      version: 1, theme: 'dark', launchAtLogin: true, notifications: false, onboardingCompleted: true,
      secrets: { vaultKey: encrypted.toString('base64') },
    }), { mode: 0o600, flag: 'wx' });
  const settingsBefore = readFileSync(fixture.settings);
  const environment = await createSettingsStore(fixture.settings, encryption).environment();
  let decrypted;
  if (fixture.kind === 'migrate' && app.getVersion() !== fixture.installed)
    decrypted = await encryption.decryptLegacyStringAsync(encrypted);
  else {
    try { decrypted = safeStorage.decryptString(encrypted); }
    catch (error) {
      if (!encryption.decryptLegacyStringAsync) throw error;
      decrypted = await encryption.decryptLegacyStringAsync(encrypted);
    }
  }
  const settingsAfter = readFileSync(fixture.settings);
  const remoteAfter = readFileSync(fixture.remoteSettings);
  const reopened = await createSettingsStore(fixture.settings, encryption).environment();
  const reopenedConnection = await createSettingsStore(fixture.remoteSettings, encryption).connection();
  if (reopened.NOD_VAULT_KEY !== environment.NOD_VAULT_KEY || reopenedConnection.token !== connection.token ||
      !settingsAfter.equals(readFileSync(fixture.settings)) || !remoteAfter.equals(readFileSync(fixture.remoteSettings)))
    throw new Error('Saved keys changed after migration.');
  const owner = JSON.parse(readFileSync(fixture.ownerFile)).ownerId;
  const { loadIntegrationIdentity } = await import('./identity.mjs');
  const identity = await loadIntegrationIdentity({
    dataRoot: fixture.integrationRoot, ownerId: owner,
    keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.from(environment.NOD_VAULT_KEY, 'base64') },
    checkpoint: {
      read: async () => {
        try { return readFileSync(fixture.checkpointFile, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      },
      commit: async (publicKey) => {
        try { writeFileSync(fixture.checkpointFile, publicKey, { mode: 0o600, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (readFileSync(fixture.checkpointFile, 'utf8') !== publicKey) throw new Error('Fixture identity checkpoint changed.');
      },
    },
  });
  const identityBytes = readFileSync(fixture.identityFile);
  const markerBytes = readFileSync(fixture.markerFile);
  receipt('ready', {
    encryptedHash: createHash('sha256').update(encrypted).digest('hex'),
    decryptedHash: createHash('sha256').update(decrypted).digest('hex'),
    appName: app.getName(),
    asyncDecryptedHash: createHash('sha256').update(environment.NOD_VAULT_KEY).digest('hex'),
    settingsBeforeHash: createHash('sha256').update(settingsBefore).digest('hex'),
    settingsHash: createHash('sha256').update(readFileSync(fixture.settings)).digest('hex'),
    remoteSettingsBeforeHash: createHash('sha256').update(remoteSettingsBefore).digest('hex'),
    remoteSettingsHash: createHash('sha256').update(readFileSync(fixture.remoteSettings)).digest('hex'),
    serverUrl: connection?.url,
    serverTokenHash: connection && createHash('sha256').update(connection.token).digest('hex'),
    owner,
    identityHash: createHash('sha256').update(identityBytes).digest('hex'),
    markerHash: createHash('sha256').update(markerBytes).digest('hex'),
    checkpointHash: createHash('sha256').update(readFileSync(fixture.checkpointFile)).digest('hex'),
    publicKey: identity.publicKey,
    managedOwner: identity.userId,
    identityProof: sign(null, Buffer.from(fixture.challenge + ':' + app.getVersion()), identity.key).toString('base64url'),
  });
  if (initialLaunch) {
    app.relaunch();
    return app.exit(0);
  }
  if (app.getVersion() !== fixture.installed) return setTimeout(() => app.quit(), 500);
  if (['install', 'migrate'].includes(fixture.kind)) {
    await window.loadURL(page);
    await window.webContents.executeJavaScript('nativeFixture.prepare()');
    const directories = readdirSync(fixture.temporary).filter((name) => name.startsWith('nod-files-'));
    if (directories.length !== 1) throw new Error('The temporary artifact root is missing.');
    artifactRoot = join(fixture.temporary, directories[0]);
    const bytes = readFileSync(join(artifactRoot, fixture.artifactId, 'download'));
    if (bytes.toString() !== fixture.artifactContent) throw new Error('The prepared artifact bytes do not match.');
    receipt('artifact-prepared', { hash: createHash('sha256').update(bytes).digest('hex') });
  }
  autoUpdater.on('error', (error) => {
    receipt('error', { source: 'native', message: String(error.message).slice(0, 2000) });
    app.quit();
  });
  if (fixture.kind === 'install') {
    const { createDesktopUpdater } = await import('./updates.mjs');
    const feeds = new Map([
      ['https://updates.example.invalid/1.0.1', fixture.feed],
      ['https://updates.example.invalid/1.0.2', fixture.nextFeed],
    ]);
    let available = '1.0.1';
    const updater = createDesktopUpdater({
      currentVersion: app.getVersion(),
      source: { latest: async () => ({ version: available, feedUrl: 'https://updates.example.invalid/' + available }) },
      native: {
        on: (...args) => autoUpdater.on(...args),
        once: (...args) => autoUpdater.once(...args),
        removeListener: (...args) => autoUpdater.removeListener(...args),
        setFeedURL: ({ url }) => {
          const feed = feeds.get(url);
          if (!feed) throw new Error('Unexpected fixture feed.');
          autoUpdater.setFeedURL({ url: feed });
        },
        checkForUpdates: () => autoUpdater.checkForUpdates(),
      },
      prepareRuntime: async () => {},
      restart: async () => {
        await disposeArtifactFiles();
        receipt('files-closed', { artifactRemoved: !artifactRoot || !existsSync(artifactRoot) });
        autoUpdater.quitAndInstall();
      },
    });
    for (const version of ['1.0.1', '1.0.2']) {
      available = version;
      const ready = await updater.check();
      if (ready?.version !== version) throw new Error('The staged update did not refresh.');
      receipt('downloaded', { targetVersion: ready.version });
    }
    await updater.restart();
    return;
  }
  autoUpdater.on('update-downloaded', async () => {
    receipt('downloaded');
    await disposeArtifactFiles();
    receipt('files-closed', { artifactRemoved: !artifactRoot || !existsSync(artifactRoot) });
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on('update-not-available', () => { receipt('unavailable'); app.quit(); });
  autoUpdater.setFeedURL({ url: fixture.feed });
  autoUpdater.checkForUpdates();
}).catch((error) => {
  receipt('error', { source: 'fixture', message: String(error.message).slice(0, 2000) });
  app.quit();
});
`,
    );
    const [application] = await packager({
      dir: directory,
      out: join(dirname(planPath), `build-${fixture.name}-${fixture.version}`),
      name: fixture.name,
      executableName: fixture.name,
      appBundleId: fixture.identifier,
      appVersion: fixture.version,
      buildVersion: fixture.version,
      electronVersion: configuration.devDependencies.electron,
      download: { checksums: electronChecksums },
      platform: 'darwin',
      arch: process.arch,
      asar: false,
      extendInfo: {
        CFBundleName:
          fixture.version === fixture.installed ? fixture.initialName : fixture.displayName,
        CFBundleDisplayName:
          fixture.version === fixture.installed ? fixture.initialName : fixture.displayName,
        ElectronSquirrelPreventDowngrades: true,
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      },
    });
    const bundle = join(application, `${fixture.name}.app`);
    await signApplication(bundle, configuration.devDependencies.electron, signingConfiguration());
    if (fixture.version === fixture.installed) await run('/bin/mv', [bundle, fixture.application]);
    else await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, fixture.archive]);
  }
}

async function certificate(root, name) {
  const identity = `Nod Update Fixture ${randomUUID()}`;
  const base = join(root, name);
  const password = randomBytes(32).toString('hex');
  await writeFile(`${base}.password`, password, { mode: 0o600 });
  await writeFile(
    `${base}.conf`,
    `[req]\ndistinguished_name=dn\nx509_extensions=signing\nprompt=no\n[dn]\nCN=${identity}\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`,
  );
  await run('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    `${base}.conf`,
    '-keyout',
    `${base}.key`,
    '-out',
    `${base}.pem`,
  ]);
  await run('/usr/bin/openssl', [
    'pkcs12',
    '-export',
    '-inkey',
    `${base}.key`,
    '-in',
    `${base}.pem`,
    '-out',
    `${base}.p12`,
    '-passout',
    `file:${base}.password`,
  ]);
  return {
    ...process.env,
    APPLE_CERTIFICATE: (await readFile(`${base}.p12`)).toString('base64'),
    APPLE_CERTIFICATE_PASSWORD: password,
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_CERTIFICATE_SHA256: new X509Certificate(await readFile(`${base}.pem`)).fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
    NOD_SIGNING_MODE: 'self-signed',
  };
}

async function ownedProcesses(root, identifiers) {
  return (await run('/bin/ps', ['-axo', 'pid=,uid=,command='], { output: 'stdout' }))
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match &&
        Number(match[2]) === process.getuid() &&
        (match[3].includes(root) || identifiers.some((id) => match[3].includes(id)))
        ? [Number(match[1])]
        : [];
    });
}

async function main() {
  process.umask(0o077);
  const root = await mkdtemp(join(runner, 'nod-native-updates-'));
  const output = join(repository, '.local/native-update-acceptance');
  await mkdir(output, { recursive: true });
  const report = {
    source: (await run('git', ['rev-parse', 'HEAD'], { cwd: repository })).trim(),
    fixtureHash: sha256(await readFile(source)),
    settingsModuleHash: sha256(await readFile(join(repository, 'desktop/main/settings.mjs'))),
    updaterModuleHash: sha256(await readFile(join(repository, 'desktop/main/updates.mjs'))),
    identityModuleHash: sha256(
      await readFile(join(repository, 'src/providers/composio/identity.ts')),
    ),
    electron: configuration.devDependencies.electron,
    startedAt: new Date().toISOString(),
    root,
    cases: [],
    requests: [],
    checks: [],
  };
  const routes = new Map();
  const server = createServer((request, response) => {
    const route = routes.get(request.url);
    if (request.method !== 'GET' || !route) return response.writeHead(404).end();
    const receipt = { path: request.url, at: Date.now(), completed: false };
    report.requests.push(receipt);
    response.on('finish', () => {
      receipt.completed = true;
    });
    if (route.file) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': route.bytes });
      createReadStream(route.file).pipe(response);
    } else if (typeof route.text === 'string') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(route.text);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(route));
    }
  });
  const fixtures = [];
  const storageKeychain = join(root, 'storage.keychain-db');
  let previousKeychains;
  let failure;
  try {
    await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const kind of ['install', 'reject', 'downgrade', 'migrate']) {
      const owner = randomUUID();
      const integrationRoot = join(root, `${kind}-profile`, 'profiles', 'local');
      const identityDirectory = join(integrationRoot, 'integration-identity');
      const fixture = {
        name: `NodFixture-${kind}`,
        identifier: `dev.nod.updatefixture.${randomUUID()}.${kind}`,
        profile: join(root, `${kind}-profile`),
        temporary: join(root, `${kind}-temporary`),
        artifactId: randomUUID(),
        artifactOrigin: `${origin}/${kind}`,
        artifactContent: 'Synthetic native update artifact',
        events: join(root, `${kind}.jsonl`),
        data: join(root, `${kind}-profile`, 'saved.json'),
        encrypted: join(root, `${kind}-profile`, 'encrypted.bin'),
        settings: join(integrationRoot, 'settings.json'),
        remoteSettings: join(root, `${kind}-profile`, 'server-connection.json'),
        sentinel: randomBytes(32).toString('base64'),
        serverUrl: 'https://nod-server.example',
        serverToken: randomBytes(32).toString('base64url'),
        integrationRoot,
        ownerFile: join(integrationRoot, 'profile.json'),
        identityFile: join(identityDirectory, `${sha256(owner)}.encrypted`),
        markerFile: join(identityDirectory, `${sha256(owner)}.public`),
        checkpointFile: join(integrationRoot, 'identity-checkpoint'),
        challenge: randomBytes(32).toString('base64url'),
        application: join(root, `NodFixture-${kind}.app`),
        archive: join(root, `${kind}.zip`),
        feed: `${origin}/${kind}/feed`,
        ...(kind === 'install'
          ? {
              nextArchive: join(root, `${kind}-latest.zip`),
              nextFeed: `${origin}/${kind}/latest-feed`,
            }
          : {}),
        installed: kind === 'downgrade' ? '1.0.2' : '1.0.0',
        kind,
      };
      fixture.storageName = `nod-${randomUUID()}`;
      fixture.displayName = fixture.storageName.replace('nod-', 'Nod-');
      fixture.initialName = kind === 'migrate' ? fixture.displayName : fixture.storageName;
      fixture.caches = [fixture.identifier, `${fixture.identifier}.ShipIt`].map((id) =>
        join(homedir(), 'Library/Caches', id),
      );
      for (const cache of fixture.caches)
        assert.equal(existsSync(cache), false, `Fixture cache already exists: ${cache}`);
      await mkdir(fixture.profile);
      await mkdir(fixture.temporary);
      await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
      await writeFile(fixture.ownerFile, JSON.stringify({ ownerId: owner }), { mode: 0o600 });
      await writeFile(
        fixture.data,
        JSON.stringify({ saved: 'Synthetic update fixture', id: fixture.identifier }),
      );
      fixtures.push(fixture);
    }
    const plan = join(root, 'different-signer.json');
    await writeFile(plan, JSON.stringify([{ ...fixtures[1], version: '1.0.1' }]));
    await withAppleSigning(process.execPath, [source, '--package', plan], {
      env: await certificate(root, 'different'),
    });
    assert.equal(existsSync(join(runner, 'nod-apple-signing-state.json')), false);
    await writeFile(
      plan,
      JSON.stringify([
        ...fixtures.map((fixture) => ({ ...fixture, version: fixture.installed })),
        { ...fixtures[0], version: '1.0.1' },
        { ...fixtures[0], version: '1.0.2', archive: fixtures[0].nextArchive },
        { ...fixtures[2], version: '1.0.1' },
        { ...fixtures[3], version: '1.0.1' },
      ]),
    );
    await withAppleSigning(process.execPath, [source, '--package', plan], {
      env: await certificate(root, 'current'),
    });
    assert.equal(existsSync(join(runner, 'nod-apple-signing-state.json')), false);
    const keychains = {
      default: JSON.parse(await run('/usr/bin/security', ['default-keychain', '-d', 'user'])),
      search: (await run('/usr/bin/security', ['list-keychains', '-d', 'user']))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line.trim())),
    };
    assert(
      [keychains.default, ...keychains.search].every(
        (path) => typeof path === 'string' && isAbsolute(path) && !/[\r\n\0]/.test(path),
      ),
      'The original keychains must be recorded before creating the fixture keychain.',
    );
    previousKeychains = keychains;
    const storagePassword = randomBytes(32).toString('hex');
    await run('/usr/bin/security', ['create-keychain', '-p', storagePassword, storageKeychain]);
    await run('/usr/bin/security', ['set-keychain-settings', '-lut', '3600', storageKeychain]);
    await run('/usr/bin/security', ['unlock-keychain', '-p', storagePassword, storageKeychain]);
    await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', storageKeychain]);
    await run('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', storageKeychain]);
    assert.equal(
      JSON.parse(await run('/usr/bin/security', ['default-keychain', '-d', 'user'])),
      storageKeychain,
    );
    assert.deepEqual(
      (await run('/usr/bin/security', ['list-keychains', '-d', 'user']))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line.trim())),
      [storageKeychain],
    );
    report.checks.push({
      id: 'UPD-SCOPE',
      pass: true,
      identifiers: fixtures.map((fixture) => fixture.identifier),
      encryptionKeychain: storageKeychain,
    });
    for (const fixture of fixtures) {
      if (fixture.kind === 'migrate')
        await run('/usr/bin/security', [
          'add-generic-password',
          '-s',
          `${fixture.initialName} Safe Storage`,
          '-a',
          `${fixture.initialName} Key`,
          '-w',
          randomBytes(16).toString('base64'),
          '-A',
          storageKeychain,
        ]);
      const before = sha256(await readFile(fixture.data));
      const ownerBefore = await readFile(fixture.ownerFile);
      const installedSignature = sha256(
        await readFile(join(fixture.application, 'Contents/_CodeSignature/CodeResources')),
      );
      const archive = await readFile(fixture.archive);
      const entry = {
        id: {
          install: 'UPD-NATIVE.v6',
          reject: 'UPD-SIGNATURE.v5',
          downgrade: 'UPD-DOWNGRADE.v3',
          migrate: 'UPD-KEYCHAIN-MIGRATION.v2',
        }[fixture.kind],
        startedAt: new Date().toISOString(),
        archive: { bytes: archive.length, sha256: sha256(archive) },
        checks: [],
      };
      report.cases.push(entry);
      routes.set(`/${fixture.kind}/archive.zip`, { file: fixture.archive, bytes: archive.length });
      routes.set(`/${fixture.kind}/feed`, {
        url: `${origin}/${fixture.kind}/archive.zip`,
        name: 'nod 1.0.1',
        pub_date: '2026-10-04T00:00:00Z',
      });
      if (fixture.nextArchive) {
        const latest = await readFile(fixture.nextArchive);
        entry.latestArchive = { bytes: latest.length, sha256: sha256(latest) };
        routes.set(`/${fixture.kind}/latest.zip`, {
          file: fixture.nextArchive,
          bytes: latest.length,
        });
        routes.set(`/${fixture.kind}/latest-feed`, {
          url: `${origin}/${fixture.kind}/latest.zip`,
          name: 'nod 1.0.2',
          pub_date: '2026-10-05T00:00:00Z',
        });
      }
      routes.set(`/${fixture.kind}/api/artifacts/${fixture.artifactId}/metadata`, {});
      routes.set(`/${fixture.kind}/api/artifacts/${fixture.artifactId}`, {
        text: fixture.artifactContent,
      });
      const executable = join(fixture.application, 'Contents/MacOS', fixture.name);
      const child = spawn(executable, [], { stdio: 'ignore' });
      child.on('error', (error) => {
        entry.launchError = error.message;
      });
      const installs = ['install', 'migrate'].includes(fixture.kind);
      const latestVersion = fixture.kind === 'install' ? '1.0.2' : '1.0.1';
      const deadline = Date.now() + (installs ? 300_000 : 120_000);
      let events = [];
      while (Date.now() < deadline) {
        events = (await readFile(fixture.events, 'utf8').catch(() => ''))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse);
        if (
          events.some(
            (event) =>
              event.event === 'error' ||
              event.event === 'unavailable' ||
              event.version === latestVersion,
          )
        )
          break;
        if (entry.launchError) break;
        await delay(500);
      }
      entry.events = events;
      const check = (id, pass) => entry.checks.push({ id, pass });
      check(
        'UPD-BASE',
        events.some(
          (event) =>
            event.event === 'ready' &&
            event.version === fixture.installed &&
            event.dataHash === before,
        ),
      );
      check(
        installs ? 'UPD-DOWNLOAD' : 'UPD-REQUEST',
        ['feed', 'archive.zip'].every((path) =>
          report.requests.some(
            (request) =>
              request.path === `/${fixture.kind}/${path}` &&
              (request.completed || (!installs && path === 'archive.zip')),
          ),
        ),
      );
      const version = await run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        join(fixture.application, 'Contents/Info.plist'),
      ]);
      if (installs) {
        const artifactPrepared = events.findIndex((event) => event.event === 'artifact-prepared');
        const filesClosed = events.findIndex((event) => event.event === 'files-closed');
        const quitAccepted = events.findIndex((event) => event.event === 'quit-accepted');
        check(
          'UPD-QUIT',
          artifactPrepared >= 0 &&
            events[artifactPrepared].hash === sha256(fixture.artifactContent) &&
            filesClosed > artifactPrepared &&
            events[filesClosed].artifactRemoved === true &&
            quitAccepted > filesClosed &&
            events
              .filter((event) => event.event === 'quit-accepted')
              .every((event) => !event.cancelled && event.artifactRemoved),
        );
        check(
          'UPD-INSTALL',
          version === latestVersion &&
            events.some((event) => event.event === 'downloaded') &&
            events.some(
              (event) =>
                event.version === latestVersion &&
                event.event === 'ready' &&
                event.executable === executable,
            ),
        );
      } else {
        check(
          fixture.kind === 'reject' ? 'UPD-REJECT' : 'UPD-NO-DOWNGRADE',
          version === fixture.installed &&
            events.some(
              (event) =>
                event.event === 'error' &&
                event.source === 'native' &&
                event.version === fixture.installed &&
                (fixture.kind === 'reject'
                  ? /^Code signature at URL .+ did not pass validation:/.test(event.message) &&
                    event.message.includes('code failed to satisfy specified code requirement(s)')
                  : event.message.includes(
                      'Cannot update to a bundle with a lower version number.',
                    ) &&
                    event.message.includes('ElectronSquirrelPreventDowngrades') &&
                    event.message.includes(`from '${fixture.installed}' to '${latestVersion}'`)),
            ) &&
            !events.some((event) => event.event === 'downloaded') &&
            installedSignature ===
              sha256(
                await readFile(join(fixture.application, 'Contents/_CodeSignature/CodeResources')),
              ),
        );
      }
      if (fixture.kind === 'install')
        check(
          'UPD-SUPERSEDE',
          JSON.stringify(
            events
              .filter((event) => event.event === 'downloaded')
              .map((event) => event.targetVersion),
          ) === JSON.stringify(['1.0.1', '1.0.2']) &&
            events
              .filter((event) => event.event === 'downloaded')
              .every((event) => event.version === fixture.installed) &&
            !events.some((event) => event.version === '1.0.1') &&
            ['latest-feed', 'latest.zip'].every((path) =>
              report.requests.some(
                (request) => request.path === `/${fixture.kind}/${path}` && request.completed,
              ),
            ),
        );
      check(
        'UPD-DATA',
        sha256(await readFile(fixture.data)) === before &&
          events.every((event) => event.dataHash === before),
      );
      const readyEvents = events.filter((event) => event.event === 'ready');
      const expectedOpens = installs ? 3 : 2;
      const initialIdentity = readyEvents[0];
      const publicKey = initialIdentity?.publicKey
        ? createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: initialIdentity.publicKey },
            format: 'jwk',
          })
        : undefined;
      check(
        'UPD-REOPEN',
        readyEvents.length === expectedOpens &&
          new Set(readyEvents.map((event) => event.pid)).size === expectedOpens &&
          readyEvents
            .slice(0, 2)
            .every(
              (event) => event.version === fixture.installed && event.executable === executable,
            ),
      );
      check(
        'UPD-KEYS',
        readyEvents.length === expectedOpens &&
          readyEvents.every(
            (event) =>
              event.decryptedHash === sha256(fixture.sentinel) &&
              event.encryptedHash === readyEvents[0].encryptedHash,
          ) &&
          sha256(await readFile(fixture.encrypted)) === readyEvents[0].encryptedHash,
      );
      check(
        'UPD-ASYNC-KEYS',
        readyEvents.length === expectedOpens &&
          readyEvents.every(
            (event) =>
              event.asyncDecryptedHash === sha256(fixture.sentinel) &&
              event.appName === fixture.displayName &&
              (fixture.kind === 'migrate' && event.version === '1.0.1'
                ? event.settingsBeforeHash === readyEvents[0].settingsHash &&
                  event.settingsHash !== event.settingsBeforeHash
                : event.settingsBeforeHash === event.settingsHash &&
                  event.settingsHash === readyEvents[0].settingsHash),
          ) &&
          sha256(await readFile(fixture.settings)) === readyEvents.at(-1).settingsHash,
      );
      const savedRemoteSettings = await readFile(fixture.remoteSettings, 'utf8');
      const remoteSecrets = JSON.parse(savedRemoteSettings).secrets;
      check(
        'UPD-REMOTE-CONNECTION',
        readyEvents.length === expectedOpens &&
          readyEvents.every(
            (event) =>
              event.serverUrl === fixture.serverUrl &&
              event.serverTokenHash === sha256(fixture.serverToken) &&
              (fixture.kind === 'migrate' && event.version === '1.0.1'
                ? event.remoteSettingsBeforeHash === readyEvents[0].remoteSettingsHash &&
                  event.remoteSettingsHash !== event.remoteSettingsBeforeHash
                : event.remoteSettingsBeforeHash === event.remoteSettingsHash &&
                  event.remoteSettingsHash === readyEvents[0].remoteSettingsHash),
          ) &&
          sha256(savedRemoteSettings) === readyEvents.at(-1).remoteSettingsHash &&
          typeof remoteSecrets.serverToken === 'string' &&
          remoteSecrets.vaultKey === undefined &&
          !savedRemoteSettings.includes(fixture.serverToken) &&
          !Buffer.from(remoteSecrets.serverToken, 'base64').includes(
            Buffer.from(fixture.serverToken),
          ) &&
          ((await stat(fixture.remoteSettings)).mode & 0o777) === 0o600,
      );
      check(
        'UPD-INTEGRATION-IDENTITY',
        !!publicKey &&
          readyEvents.length === expectedOpens &&
          readyEvents.every(
            (event) =>
              event.owner === JSON.parse(ownerBefore).ownerId &&
              event.identityHash === initialIdentity.identityHash &&
              event.markerHash === initialIdentity.markerHash &&
              event.checkpointHash === initialIdentity.checkpointHash &&
              event.publicKey === initialIdentity.publicKey &&
              event.managedOwner ===
                `nod_${sha256(Buffer.from(initialIdentity.publicKey, 'base64url'))}` &&
              typeof event.identityProof === 'string' &&
              verify(
                null,
                Buffer.from(`${fixture.challenge}:${event.version}`),
                publicKey,
                Buffer.from(event.identityProof, 'base64url'),
              ),
          ) &&
          (await readFile(fixture.ownerFile)).equals(ownerBefore) &&
          sha256(await readFile(fixture.identityFile)) === initialIdentity.identityHash &&
          sha256(await readFile(fixture.markerFile)) === initialIdentity.markerHash &&
          sha256(await readFile(fixture.checkpointFile)) === initialIdentity.checkpointHash &&
          ((await stat(fixture.identityFile)).mode & 0o777) === 0o600 &&
          ((await stat(fixture.markerFile)).mode & 0o777) === 0o600 &&
          ((await stat(dirname(fixture.identityFile))).mode & 0o777) === 0o700,
      );
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.application]);
      entry.finishedAt = new Date().toISOString();
      if (entry.checks.some((check) => !check.pass))
        failure ??= new Error(`${entry.id} failed; inspect its receipt.`);
    }
  } catch (error) {
    failure = error;
    report.error = { message: error.message, diagnostic: error.diagnostic };
  } finally {
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
    const identifiers = fixtures.map((fixture) => fixture.identifier);
    try {
      for (const fixture of fixtures)
        await run('/bin/launchctl', ['remove', `${fixture.identifier}.ShipIt`]).catch(() => {});
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        for (const pid of await ownedProcesses(root, identifiers)) {
          try {
            process.kill(pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        await delay(1000);
        if (!(await ownedProcesses(root, identifiers)).length) break;
      }
      assert.deepEqual(
        await ownedProcesses(root, identifiers),
        [],
        'Owned application processes must stop before cleanup.',
      );
      assert.equal(
        existsSync(join(runner, 'nod-apple-signing-state.json')),
        false,
        'The signing keychain must be removed.',
      );
      for (const fixture of fixtures)
        for (const cache of fixture.caches) await rm(cache, { recursive: true, force: true });
      if (previousKeychains) {
        await run('/usr/bin/security', [
          'default-keychain',
          '-d',
          'user',
          '-s',
          previousKeychains.default,
        ]);
        await run('/usr/bin/security', [
          'list-keychains',
          '-d',
          'user',
          '-s',
          ...previousKeychains.search,
        ]);
        if (existsSync(storageKeychain))
          await run('/usr/bin/security', ['delete-keychain', storageKeychain]);
        assert.equal(existsSync(storageKeychain), false);
        assert.equal(
          JSON.parse(await run('/usr/bin/security', ['default-keychain', '-d', 'user'])),
          previousKeychains.default,
        );
        assert.deepEqual(
          (await run('/usr/bin/security', ['list-keychains', '-d', 'user']))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line.trim())),
          previousKeychains.search,
        );
      }
      await rm(root, { recursive: true });
      report.checks.push({ id: 'UPD-CLEANUP', pass: !existsSync(root) });
    } catch (error) {
      failure ??= error;
      report.checks.push({ id: 'UPD-CLEANUP', pass: false, error: error.message });
    }
    report.finishedAt = new Date().toISOString();
    report.pass = !failure && report.cases.length === 4;
    await writeFile(join(output, `${Date.now()}.json`), JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  process.stdout.write(
    'Native restart, pending update replacement and installation, signature and downgrade rejection, encrypted profile, remote token and integration identity preservation passed.\n',
  );
}

if (process.argv[2] === '--package') await packageFixtures(resolve(process.argv[3]));
else await main();
