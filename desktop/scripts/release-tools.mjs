import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runtimePlatform } from './runtime-inputs.mjs';

export async function hardenElectron(application) {
  const { flipFuses, FuseState, FuseVersion, FuseV1Options, getCurrentFuseWire } =
    await import('@electron/fuses');
  const productionFuses = {
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  };
  await flipFuses(application, { version: FuseVersion.V1, ...productionFuses });
  const actual = await getCurrentFuseWire(application);
  for (const [fuse, enabled] of Object.entries(productionFuses))
    if (actual[fuse] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE))
      throw new Error('The Electron production settings failed verification.');
}

const directory = dirname(fileURLToPath(import.meta.url));
export const minimumSystemVersion = JSON.parse(
  await readFile(join(directory, 'runtime-build-lock.json'), 'utf8'),
).minimumSystemVersion;

export function run(command, args, { output = 'combined', timeout = 120_000, ...options } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let killTimer;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 5_000);
    }, timeout);
    child.stdout?.on('data', (value) => {
      stdout = (stdout + value).slice(-8 * 1024 * 1024);
    });
    child.stderr?.on('data', (value) => {
      stderr = (stderr + value).slice(-8 * 1024 * 1024);
    });
    child.once('error', () => reject(new Error(`${basename(command)} could not start.`)));
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (expired || code !== 0)
        reject(
          Object.assign(
            new Error(`${basename(command)} failed${expired ? ' (timed out)' : ` (${code})`}.`),
            { diagnostic: (stdout + stderr).slice(-4096) },
          ),
        );
      else accept((output === 'stdout' ? stdout : stdout + stderr).trim());
    });
  });
}

export function signingConfiguration(env = process.env) {
  const mode = env.NOD_SIGNING_MODE || 'self-signed';
  const identity = env.NOD_SIGNING_IDENTITY?.trim();
  const team = env.NOD_APPLE_TEAM_ID;
  const keychain = env.NOD_SIGNING_KEYCHAIN;
  const profile = env.NOD_NOTARY_PROFILE;
  const expectedCertificate = env.NOD_SIGNING_CERTIFICATE_SHA256?.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedCertificate || ''))
    throw new Error('Signed releases require NOD_SIGNING_CERTIFICATE_SHA256.');
  if (
    !['self-signed', 'developer-id'].includes(mode) ||
    !identity ||
    identity === '-' ||
    /[\r\n\0]/.test(identity) ||
    !keychain
  )
    throw new Error(
      'Signed releases require an explicit signing mode, permanent certificate identity, and signing keychain.',
    );
  if (
    mode === 'developer-id' &&
    (!identity.startsWith('Developer ID Application: ') ||
      !/^[A-Z0-9]{10}$/.test(team || '') ||
      !identity.endsWith(`(${team})`) ||
      !profile)
  )
    throw new Error(
      'Developer ID releases require matching NOD_APPLE_TEAM_ID and NOD_NOTARY_PROFILE.',
    );
  if (mode === 'self-signed' && identity.startsWith('Developer ID Application:'))
    throw new Error('Use developer-id mode for an Apple Developer ID identity.');
  return {
    mode,
    identity,
    expectedCertificate,
    keychain: resolve(keychain),
    ...(mode === 'developer-id' ? { team, profile } : {}),
  };
}

export async function verifyIdentity(configuration) {
  const identities = await run('/usr/bin/security', [
    'find-identity',
    '-p',
    'codesigning',
    configuration.keychain,
  ]);
  const matches = identities.split('\n').flatMap((line) => {
    const match = line.match(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"/);
    return match?.[2] === configuration.identity ? [match[1].toLowerCase()] : [];
  });
  const fingerprints = [...new Set(matches)];
  if (fingerprints.length !== 1)
    throw new Error('The configured signing identity is unavailable or ambiguous in its keychain.');
  const pem = await run(
    '/usr/bin/security',
    ['find-certificate', '-a', '-c', configuration.identity, '-p', configuration.keychain],
    { output: 'stdout' },
  );
  const certificate = [
    ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g),
  ]
    .map(([value]) => new X509Certificate(value))
    .find((value) => value.fingerprint.replaceAll(':', '').toLowerCase() === fingerprints[0]);
  if (
    !certificate ||
    Date.now() < Date.parse(certificate.validFrom) ||
    Date.now() >= Date.parse(certificate.validTo)
  )
    throw new Error('The signing certificate is missing or outside its validity period.');
  if (
    configuration.mode === 'self-signed' &&
    (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey))
  )
    throw new Error('Self-signed mode requires a self-signed code signing certificate.');
  configuration.certificateSha256 = createHash('sha256').update(certificate.raw).digest('hex');
  if (configuration.certificateSha256 !== configuration.expectedCertificate)
    throw new Error('The signing certificate does not match its expected public fingerprint.');
  configuration.certificatePem = certificate.toString();
  return signingMetadata(configuration);
}

export function signingMetadata(configuration) {
  return {
    mode: configuration.mode,
    identity: configuration.identity,
    certificateSha256: configuration.certificateSha256,
    ...(configuration.team ? { teamId: configuration.team } : {}),
  };
}

export async function exportCertificate(configuration, output) {
  if (!configuration.certificatePem) await verifyIdentity(configuration);
  await writeFile(
    output,
    output.endsWith('.cer')
      ? new X509Certificate(configuration.certificatePem).raw
      : configuration.certificatePem + '\n',
  );
}

export function signingArguments(configuration) {
  return [
    '--force',
    '--sign',
    configuration.identity,
    '--keychain',
    configuration.keychain,
    configuration.mode === 'developer-id' ? '--timestamp' : '--timestamp=none',
  ];
}

export async function nativeFiles(root) {
  const found = [];
  const magic = new Set([
    'feedface',
    'feedfacf',
    'cefaedfe',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ]);
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) await walk(child);
      else if (item.isFile()) {
        const file = await open(child, 'r');
        try {
          const header = Buffer.alloc(4);
          const { bytesRead } = await file.read(header, 0, 4, 0);
          if (bytesRead === 4 && magic.has(header.toString('hex'))) found.push(child);
        } finally {
          await file.close();
        }
      }
    }
  }
  await walk(root);
  return found;
}

export function compatibleVersion(value, maximum = minimumSystemVersion) {
  const current = value.split('.').map(Number);
  const limit = maximum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (current[index] || 0) - (limit[index] || 0);
    if (difference) return difference < 0;
  }
  return true;
}

export async function verifyCompatibility(files) {
  for (const file of files) {
    const arch = await run('/usr/bin/lipo', ['-archs', file]);
    if (!arch.split(/\s+/).includes(process.arch === 'x64' ? 'x86_64' : 'arm64'))
      throw new Error(`Native code does not support this Mac: ${basename(file)}`);
    const build = await run('/usr/bin/vtool', ['-show-build', file]);
    const pattern = build.includes('LC_BUILD_VERSION')
      ? /\bminos (\d+\.\d+(?:\.\d+)?)\b/g
      : /LC_VERSION_MIN_MACOSX[\s\S]*?\bversion (\d+\.\d+(?:\.\d+)?)\b/g;
    const versions = [...build.matchAll(pattern)].map((match) => match[1]);
    if (!versions.length || versions.some((version) => !compatibleVersion(version)))
      throw new Error(
        `Native code exceeds the macOS ${minimumSystemVersion} minimum: ${basename(file)}`,
      );
  }
}

export async function verifySignature(path, configuration, { executable = false } = {}) {
  await run('/usr/bin/codesign', ['--verify', '--strict', '--deep', path]);
  const detail = await run('/usr/bin/codesign', ['-d', '--verbose=4', path]);
  if (
    configuration.mode === 'developer-id' &&
    (!detail.includes(`TeamIdentifier=${configuration.team}`) ||
      !detail.includes('Authority=Developer ID Application:'))
  )
    throw new Error('A release signature does not match the configured Developer ID team.');
  if (
    executable &&
    (!/flags=.*runtime/.test(detail) ||
      (configuration.mode === 'developer-id' && !/^Timestamp=/m.test(detail)))
  )
    throw new Error(
      'Release native code requires hardened runtime and Developer ID code requires a secure timestamp.',
    );
  const temporary = await mkdtemp(join(tmpdir(), 'nod-signature-'));
  try {
    const prefix = join(temporary, 'certificate');
    await run('/usr/bin/codesign', ['-d', `--extract-certificates=${prefix}`, path]);
    const digest = createHash('sha256')
      .update(await readFile(`${prefix}0`))
      .digest('hex');
    if (digest !== configuration.certificateSha256)
      throw new Error('A release signature uses a different certificate.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function signRuntimeTools(assets, configuration) {
  const files = [join(assets, 'lima/bin/limactl'), join(assets, 'docker-host/docker/docker')];
  await verifyIdentity(configuration);
  await verifyCompatibility(files);
  for (const file of files) {
    await run('/usr/bin/codesign', [
      ...signingArguments(configuration),
      '--options',
      'runtime',
      '--entitlements',
      join(
        directory,
        basename(file) === 'limactl' ? 'lima-entitlements.plist' : 'empty-entitlements.plist',
      ),
      file,
    ]);
    await verifySignature(file, configuration, { executable: true });
  }
  return files;
}

export async function signApplication(application, electronVersion, configuration) {
  console.time('Sign and verify the application');
  await verifyIdentity(configuration);
  const files = await nativeFiles(application);
  await verifyCompatibility(files);
  const { sign } = await import('@electron/osx-sign');
  const temporary = await mkdtemp(join(tmpdir(), 'nod-entitlements-'));
  const entitlements = new Map();
  try {
    if (configuration.mode === 'self-signed') {
      const defaults = join(
        dirname(dirname(fileURLToPath(import.meta.resolve('@electron/osx-sign')))),
        'entitlements',
      );
      for (const role of ['', 'plugin', 'renderer', 'gpu']) {
        const name = `default.darwin${role ? `.${role}` : ''}.plist`;
        const original = await readFile(join(defaults, name), 'utf8');
        if (!original.includes('</dict>'))
          throw new Error('Electron entitlement defaults are incompatible.');
        const value = original.includes(
          '<key>com.apple.security.cs.disable-library-validation</key>',
        )
          ? original
          : original.replace(
              '</dict>',
              '<key>com.apple.security.cs.disable-library-validation</key><true/></dict>',
            );
        const target = join(temporary, name);
        await writeFile(target, value);
        entitlements.set(role, target);
      }
    }
    await sign({
      app: application,
      identity: configuration.identity,
      keychain: configuration.keychain,
      platform: 'darwin',
      type: 'distribution',
      version: electronVersion,
      preAutoEntitlements: false,
      gatekeeperAssess: false,
      identityValidation: false,
      batchCodesignCalls: true,
      binaries: files,
      optionsForFile: (path) => ({
        hardenedRuntime: true,
        timestamp:
          configuration.mode === 'developer-id' ? 'http://timestamp.apple.com/ts01' : 'none',
        ...(path.endsWith('/limactl')
          ? { entitlements: join(directory, 'lima-entitlements.plist') }
          : path.endsWith('/docker')
            ? { entitlements: join(directory, 'empty-entitlements.plist') }
            : configuration.mode === 'self-signed'
              ? {
                  entitlements: entitlements.get(
                    path.includes('(Plugin).app')
                      ? 'plugin'
                      : path.includes('(Renderer).app')
                        ? 'renderer'
                        : path.includes('(GPU).app')
                          ? 'gpu'
                          : '',
                  ),
                }
              : {}),
      }),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await verifySignature(application, configuration, { executable: true });
  for (const file of files) await verifySignature(file, configuration, { executable: true });
  console.timeEnd('Sign and verify the application');
  return files.length;
}

export async function notarize(artifact, configuration, evidencePath) {
  if (configuration.mode !== 'developer-id')
    throw new Error('Notarization requires developer-id signing mode.');
  const timing = `Notarize ${basename(artifact)}`;
  console.time(timing);
  const output = await run(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      artifact,
      '--keychain-profile',
      configuration.profile,
      '--keychain',
      configuration.keychain,
      '--wait',
      '--timeout',
      '30m',
      '--output-format',
      'json',
    ],
    { output: 'stdout', timeout: 31 * 60_000 },
  );
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error('Apple returned an unreadable notarization result.');
  }
  if (result.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(result.id || ''))
    throw new Error('Apple did not accept the notarization submission.');
  const evidence = { status: 'Accepted', id: result.id, teamId: configuration.team };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.timeEnd(timing);
  return evidence;
}

export async function staple(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      await run('/usr/bin/xcrun', ['stapler', 'staple', path]);
      await run('/usr/bin/xcrun', ['stapler', 'validate', path]);
      return;
    } catch (error) {
      if (attempt === 60) throw error;
      await delay(30_000);
    }
  }
}

export async function assess(path, type) {
  const context = type === 'open' ? ['--context', 'context:primary-signature'] : [];
  for (let attempt = 1; ; attempt++) {
    try {
      return await run('/usr/sbin/spctl', ['--assess', '--type', type, ...context, path]);
    } catch (error) {
      console.error(`Gatekeeper rejected ${basename(path)}: ${error.diagnostic ?? error.message}`);
      if (type === 'execute')
        console.error(
          await run('/usr/bin/syspolicy_check', ['distribution', path, '--verbose']).catch(
            (failure) => failure.diagnostic ?? failure.message,
          ),
        );
      if (attempt === 3) throw error;
      await delay(30_000);
    }
  }
}

export async function verifyDiskImage(diskImage, productName) {
  const temporary = await mkdtemp(join(tmpdir(), 'nod-disk-check-'));
  const mount = join(temporary, 'mount');
  let mounted = false;
  try {
    await run(
      '/usr/bin/hdiutil',
      ['attach', diskImage, '-mountpoint', mount, '-readonly', '-nobrowse', '-noautoopen'],
      { timeout: 10 * 60_000 },
    );
    mounted = true;
    const application = join(temporary, `${productName}.app`);
    await run('/usr/bin/ditto', [join(mount, `${productName}.app`), application], {
      timeout: 10 * 60_000,
    });
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
    await run('/usr/bin/xcrun', ['stapler', 'validate', application]);
    await assess(application, 'execute');
  } finally {
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
    await rm(temporary, { recursive: true, force: true });
  }
}

export function runtimeUrl(value, archive) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (archive && !url.pathname.endsWith(`/${archive}`))
  )
    throw new Error(
      'Runtime downloads require an immutable HTTPS URL without credentials, query, or fragment.',
    );
  return url;
}

export async function verifyRuntimeRelease(
  release,
  fingerprint,
  configuration,
  { descriptorPath, env = process.env } = {},
) {
  if (
    release.fingerprint !== fingerprint ||
    release.minimumSystemVersion !== minimumSystemVersion ||
    release.signing?.mode !== configuration.mode ||
    release.signing?.certificateSha256 !== configuration.certificateSha256 ||
    !/^[a-f0-9]{40}$/.test(release.source || '') ||
    (configuration.mode === 'developer-id' &&
      (release.signing.teamId !== configuration.team ||
        release.notarization?.status !== 'Accepted' ||
        !/^[a-f0-9-]{36}$/i.test(release.notarization?.id || '')))
  )
    throw new Error('The runtime release provenance does not match this signed build.');
  const platform = runtimePlatform(env);
  if (
    release.platform !== platform ||
    !new RegExp(`^nod-Runtime-${platform}-[a-f0-9]{12}\\.tar\\.gz$`).test(
      release.archive?.file || '',
    )
  )
    throw new Error('The runtime archive name is invalid.');
  const pendingDescriptor = env.NOD_PENDING_RUNTIME_DESCRIPTOR_SHA256;
  if (
    pendingDescriptor &&
    (env.GITHUB_ACTIONS !== 'true' ||
      !/^[a-f0-9]{64}$/.test(pendingDescriptor) ||
      !descriptorPath ||
      pendingDescriptor !==
        createHash('sha256')
          .update(await readFile(descriptorPath))
          .digest('hex'))
  )
    throw new Error('The pending runtime descriptor does not match the checked CI artifact.');
  if (!release.url) return;
  runtimeUrl(release.url, release.archive.file);
  if (!pendingDescriptor) await verifyRuntimeDownload(release.url, release.archive);
}

export async function verifyRuntimeDownload(url, archive) {
  const original = runtimeUrl(url, archive.file);
  async function request(method) {
    let url = original;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, {
        method,
        ...(method === 'GET' ? { headers: { range: 'bytes=0-0' } } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = new URL(response.headers.get('location') || '', url);
        if (next.protocol !== 'https:' || next.username || next.password)
          throw new Error('The runtime download redirected to an unsafe address.');
        url = next;
      } else return response;
    }
    throw new Error('The runtime download has too many redirects.');
  }
  let response = await request('HEAD');
  if (!response.ok || !/^[1-9]\d*$/.test(response.headers.get('content-length') || '')) {
    await response.body?.cancel();
    response = await request('GET');
  }
  await response.body?.cancel();
  const bytes =
    response.status === 206
      ? Number(response.headers.get('content-range')?.split('/').at(-1))
      : Number(response.headers.get('content-length'));
  if (![200, 206].includes(response.status) || bytes !== archive.bytes)
    throw new Error(
      'The runtime archive is not anonymously reachable with the expected size. Publish the immutable runtime first.',
    );
}

export async function sourceRevision() {
  const value = await run('/usr/bin/git', ['-C', resolve(directory, '../..'), 'rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('A release requires a Git source revision.');
  return value;
}
