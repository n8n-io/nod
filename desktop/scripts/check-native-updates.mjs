import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
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
import { withAppleSigning } from '../../.github/scripts/with-apple-signing.mjs';
import { run, signApplication, signingConfiguration } from './release-tools.mjs';

const source = fileURLToPath(import.meta.url);
const repository = resolve(dirname(source), '../..');
const configuration = JSON.parse(await readFile(join(repository, 'desktop/package.json')));
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
    await copyFile(join(repository, 'desktop/main/settings.mjs'), join(directory, 'settings.mjs'));
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: fixture.name,
        version: fixture.version,
        main: 'main.cjs',
      }),
    );
    await writeFile(
      join(directory, 'main.cjs'),
      `
const { app, autoUpdater, safeStorage } = require('electron');
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');
const fixture = ${JSON.stringify(fixture)};
app.setPath('userData', fixture.profile);
const receipt = (event, fields = {}) => appendFileSync(fixture.events,
  JSON.stringify({ event, version: app.getVersion(), at: Date.now(), executable: process.execPath,
    dataHash: createHash('sha256').update(readFileSync(fixture.data)).digest('hex'), ...fields }) + '\\n');
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Fixture encryption is unavailable.');
  if (app.getVersion() === fixture.installed)
    writeFileSync(fixture.encrypted, safeStorage.encryptString(fixture.sentinel), { mode: 0o600, flag: 'wx' });
  const encrypted = readFileSync(fixture.encrypted);
  if (app.getVersion() === fixture.installed)
    writeFileSync(fixture.settings, JSON.stringify({
      version: 1, theme: 'dark', launchAtLogin: true, notifications: false, onboardingCompleted: true,
      secrets: { vaultKey: encrypted.toString('base64') }, keyMetadata: {},
    }), { mode: 0o600, flag: 'wx' });
  const settingsBefore = readFileSync(fixture.settings);
  const { createSettingsStore } = await import('./settings.mjs');
  const environment = await createSettingsStore(fixture.settings, safeStorage).environment();
  const owner = JSON.parse(readFileSync(fixture.ownerFile)).ownerId;
  const identityBytes = readFileSync(fixture.identityFile);
  const identity = createPrivateKey(identityBytes);
  const publicKey = createPublicKey(identity).export({ format: 'jwk' }).x;
  receipt('ready', {
    encryptedHash: createHash('sha256').update(encrypted).digest('hex'),
    decryptedHash: createHash('sha256').update(safeStorage.decryptString(encrypted)).digest('hex'),
    asyncDecryptedHash: createHash('sha256').update(environment.NOD_VAULT_KEY).digest('hex'),
    settingsBeforeHash: createHash('sha256').update(settingsBefore).digest('hex'),
    settingsHash: createHash('sha256').update(readFileSync(fixture.settings)).digest('hex'),
    owner,
    identityHash: createHash('sha256').update(identityBytes).digest('hex'),
    managedOwner: 'otto_' + createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
    identityProof: sign(null, Buffer.from(fixture.challenge + ':' + app.getVersion()), identity).toString('base64url'),
  });
  if (app.getVersion() !== fixture.installed) return setTimeout(() => app.quit(), 500);
  autoUpdater.on('error', (error) => {
    receipt('error', { message: String(error.message).slice(0, 2000) });
    app.quit();
  });
  autoUpdater.on('update-downloaded', () => {
    receipt('downloaded');
    autoUpdater.quitAndInstall();
  });
  autoUpdater.on('update-not-available', () => { receipt('unavailable'); app.quit(); });
  autoUpdater.setFeedURL({ url: fixture.feed });
  autoUpdater.checkForUpdates();
}).catch((error) => {
  receipt('error', { message: String(error.message).slice(0, 2000) });
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
      platform: 'darwin',
      arch: process.arch,
      asar: false,
      extendInfo: {
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
  const identity = `nod Update Fixture ${randomUUID()}`;
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
    for (const kind of ['install', 'reject', 'downgrade']) {
      const owner = randomUUID();
      const integrationRoot = join(root, `${kind}-profile`, 'profiles', 'local');
      const identityDirectory = join(integrationRoot, 'integration-identity');
      const fixture = {
        name: `NodFixture-${kind}`,
        identifier: `dev.nod.updatefixture.${randomUUID()}.${kind}`,
        profile: join(root, `${kind}-profile`),
        events: join(root, `${kind}.jsonl`),
        data: join(root, `${kind}-profile`, 'saved.json'),
        encrypted: join(root, `${kind}-profile`, 'encrypted.bin'),
        settings: join(integrationRoot, 'settings.json'),
        sentinel: randomBytes(32).toString('base64'),
        ownerFile: join(integrationRoot, 'profile.json'),
        identityFile: join(identityDirectory, `${sha256(owner)}.pem`),
        challenge: randomBytes(32).toString('base64url'),
        application: join(root, `NodFixture-${kind}.app`),
        archive: join(root, `${kind}.zip`),
        feed: `${origin}/${kind}/feed`,
        installed: kind === 'downgrade' ? '1.0.2' : '1.0.0',
        kind,
      };
      fixture.caches = [fixture.identifier, `${fixture.identifier}.ShipIt`].map((id) =>
        join(homedir(), 'Library/Caches', id),
      );
      for (const cache of fixture.caches)
        assert.equal(existsSync(cache), false, `Fixture cache already exists: ${cache}`);
      await mkdir(fixture.profile);
      await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
      await writeFile(fixture.ownerFile, JSON.stringify({ ownerId: owner }), { mode: 0o600 });
      const identity = generateKeyPairSync('ed25519');
      await writeFile(
        fixture.identityFile,
        identity.privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { mode: 0o600 },
      );
      fixture.identityPublicKey = identity.publicKey.export({ format: 'pem', type: 'spki' });
      fixture.managedOwner = `otto_${sha256(Buffer.from(identity.publicKey.export({ format: 'jwk' }).x, 'base64url'))}`;
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
        { ...fixtures[2], version: '1.0.1' },
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
      const before = sha256(await readFile(fixture.data));
      const ownerBefore = await readFile(fixture.ownerFile);
      const identityBefore = sha256(await readFile(fixture.identityFile));
      const installedSignature = sha256(
        await readFile(join(fixture.application, 'Contents/_CodeSignature/CodeResources')),
      );
      const archive = await readFile(fixture.archive);
      const entry = {
        id: { install: 'UPD-NATIVE.v3', reject: 'UPD-SIGNATURE.v3', downgrade: 'UPD-DOWNGRADE.v1' }[
          fixture.kind
        ],
        startedAt: new Date().toISOString(),
        archive: { bytes: archive.length, sha256: sha256(archive) },
        checks: [],
      };
      report.cases.push(entry);
      routes.set(`/${fixture.kind}/archive.zip`, { file: fixture.archive, bytes: archive.length });
      routes.set(`/${fixture.kind}/feed`, {
        url: `${origin}/${fixture.kind}/archive.zip`,
        name: '1.0.1',
        pub_date: '2026-10-04T00:00:00Z',
      });
      const executable = join(fixture.application, 'Contents/MacOS', fixture.name);
      const child = spawn(executable, [], { stdio: 'ignore' });
      child.on('error', (error) => {
        entry.launchError = error.message;
      });
      const deadline = Date.now() + (fixture.kind === 'install' ? 300_000 : 120_000);
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
              event.event === 'error' || event.event === 'unavailable' || event.version === '1.0.1',
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
        'UPD-DOWNLOAD',
        ['feed', 'archive.zip'].every((path) =>
          report.requests.some(
            (request) => request.path === `/${fixture.kind}/${path}` && request.completed,
          ),
        ),
      );
      const version = await run('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        join(fixture.application, 'Contents/Info.plist'),
      ]);
      if (fixture.kind === 'install') {
        check(
          'UPD-INSTALL',
          version === '1.0.1' &&
            events.some((event) => event.event === 'downloaded') &&
            events.some(
              (event) =>
                event.version === '1.0.1' &&
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
                (fixture.kind === 'reject'
                  ? /sign|signature|requirement|validation/i
                  : /downgrade|lower version/i
                ).test(event.message),
            ) &&
            !events.some((event) => event.event === 'downloaded') &&
            installedSignature ===
              sha256(
                await readFile(join(fixture.application, 'Contents/_CodeSignature/CodeResources')),
              ),
        );
      }
      check(
        'UPD-DATA',
        sha256(await readFile(fixture.data)) === before &&
          events.every((event) => event.dataHash === before),
      );
      const readyEvents = events.filter((event) => event.event === 'ready');
      check(
        'UPD-KEYS',
        readyEvents.length === (fixture.kind === 'install' ? 2 : 1) &&
          readyEvents.every(
            (event) =>
              event.decryptedHash === sha256(fixture.sentinel) &&
              event.encryptedHash === readyEvents[0].encryptedHash,
          ) &&
          sha256(await readFile(fixture.encrypted)) === readyEvents[0].encryptedHash,
      );
      check(
        'UPD-ASYNC-KEYS',
        readyEvents.length === (fixture.kind === 'install' ? 2 : 1) &&
          readyEvents.every(
            (event) =>
              event.asyncDecryptedHash === sha256(fixture.sentinel) &&
              event.settingsBeforeHash === event.settingsHash &&
              event.settingsHash === readyEvents[0].settingsHash,
          ) &&
          sha256(await readFile(fixture.settings)) === readyEvents[0].settingsHash,
      );
      check(
        'UPD-INTEGRATION-IDENTITY',
        readyEvents.length === (fixture.kind === 'install' ? 2 : 1) &&
          readyEvents.every(
            (event) =>
              event.owner === JSON.parse(ownerBefore).ownerId &&
              event.identityHash === identityBefore &&
              event.managedOwner === fixture.managedOwner &&
              typeof event.identityProof === 'string' &&
              verify(
                null,
                Buffer.from(`${fixture.challenge}:${event.version}`),
                fixture.identityPublicKey,
                Buffer.from(event.identityProof, 'base64url'),
              ),
          ) &&
          (await readFile(fixture.ownerFile)).equals(ownerBefore) &&
          sha256(await readFile(fixture.identityFile)) === identityBefore &&
          ((await stat(fixture.identityFile)).mode & 0o777) === 0o600 &&
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
    report.pass = !failure && report.cases.length === 3;
    await writeFile(join(output, `${Date.now()}.json`), JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  process.stdout.write(
    'Native update installation, signature and downgrade rejection, encrypted profile and integration identity preservation passed.\n',
  );
}

if (process.argv[2] === '--package') await packageFixtures(resolve(process.argv[3]));
else await main();
