import { spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

class SigningError extends Error {}

function fail(message) {
  throw new SigningError(message);
}

export function signingEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !/^(APPLE_|OTTO_SIGNING_|OTTO_NOTARY_|OTTO_APPLE_)/.test(key),
    ),
  );
}

async function runnerRoot(environment) {
  if (!environment.RUNNER_TEMP || !isAbsolute(environment.RUNNER_TEMP))
    fail('Set RUNNER_TEMP to the release runner’s temporary directory.');
  const root = await realpath(environment.RUNNER_TEMP);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid())
    fail('The release runner does not own its temporary directory.');
  return root;
}

function execute(command, args, { env, signal, inherit = false, timeout = 120_000 }) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new SigningError('Apple signing was interrupted.'));
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    let stopped = false;
    let killTimer;
    const kill = (name) => {
      if (child.pid)
        try {
          process.kill(-child.pid, name);
        } catch {}
    };
    const stop = () => {
      stopped = true;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 5_000);
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (chunk) => {
      if (output.length + chunk.length > 65_536) stop();
      else output += chunk;
    });
    child.once('error', () => {
      stopped = true;
    });
    child.once('close', (code) => {
      if (stopped) kill('SIGKILL');
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      if (stopped || code !== 0)
        reject(new SigningError('An Apple signing command failed or was interrupted.'));
      else accept(output);
    });
  });
}

async function readState(root) {
  const path = join(root, 'otto-apple-signing-state.json');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid() ||
      metadata.nlink !== 1 ||
      metadata.mode & 0o077 ||
      metadata.size > 16_384
    )
      fail('The saved signing cleanup state is unsafe.');
    const state = JSON.parse(await handle.readFile('utf8'));
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 1 ||
      typeof state.directory !== 'string' ||
      dirname(state.directory) !== root ||
      !/^otto-apple-signing-[A-Za-z0-9]{6}$/.test(basename(state.directory)) ||
      state.keychain !== join(state.directory, 'signing.keychain-db') ||
      !Array.isArray(state.searchList) ||
      state.searchList.length > 64 ||
      state.searchList.some(
        (item) => typeof item !== 'string' || !isAbsolute(item) || /[\r\n\0]/.test(item),
      )
    )
      fail('The saved signing cleanup paths are unsafe.');
    for (const [item, directory] of [
      [state.directory, true],
      [state.keychain, false],
    ]) {
      const entry = await lstat(item).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (
        entry &&
        (entry.uid !== process.getuid() ||
          (directory
            ? !entry.isDirectory() || entry.mode & 0o077
            : !entry.isFile() || entry.nlink !== 1))
      )
        fail('The saved signing cleanup material is unsafe.');
    }
    return { ...state, path };
  } finally {
    await handle.close();
  }
}

export async function cleanupAppleSigning({
  env = process.env,
  run = execute,
  active = false,
} = {}) {
  const root = await runnerRoot(env);
  const state = await readState(root);
  if (!state) return;
  if (active && state.pid !== process.pid)
    fail('The signing cleanup state belongs to another process.');
  if (!active) {
    let running = true;
    try {
      process.kill(state.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') running = false;
    }
    if (running) fail('The signing process is still running; cleanup was refused.');
  }
  const options = { env: signingEnvironment(env) };
  let failure;
  try {
    const keychain = await lstat(state.keychain).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (keychain) await run('/usr/bin/security', ['delete-keychain', state.keychain], options);
  } catch (error) {
    failure = error;
  }
  try {
    await run(
      '/usr/bin/security',
      ['list-keychains', '-d', 'user', '-s', ...state.searchList],
      options,
    );
  } catch (error) {
    failure ??= error;
  }
  await rm(state.directory, { recursive: true, force: true });
  if (failure) throw failure;
  await rm(state.path);
}

export async function withAppleSigning(command, args, { env = process.env, run = execute } = {}) {
  const mode = env.OTTO_SIGNING_MODE || 'self-signed';
  if (!['self-signed', 'developer-id'].includes(mode))
    fail('Select a supported Apple signing mode.');
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  const team = env.APPLE_TEAM_ID?.trim();
  const fingerprint = env.APPLE_CERTIFICATE_SHA256?.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint || ''))
    fail('Set APPLE_CERTIFICATE_SHA256 to the SHA-256 fingerprint of the signing certificate DER.');
  if (!identity || identity === '-' || identity.length > 512 || /[\r\n\0]/.test(identity))
    fail('Set the permanent internal certificate or Developer ID signing identity.');
  if (mode === 'self-signed' && identity.startsWith('Developer ID Application:'))
    fail('Use developer-id mode for an Apple Developer ID signing identity.');
  if (
    mode === 'developer-id' &&
    (!/^Developer ID Application: [^\r\n\0]+ \([A-Z0-9]{10}\)$/.test(identity) ||
      !/^[A-Z0-9]{10}$/.test(team || '') ||
      !identity.endsWith(` (${team})`))
  )
    fail('Set a Developer ID Application signing identity and its matching Apple team ID.');
  const certificate = env.APPLE_CERTIFICATE?.replace(/\s/g, '');
  if (
    !certificate ||
    certificate.length > 1_048_576 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(certificate) ||
    !env.APPLE_CERTIFICATE_PASSWORD
  )
    fail('Configure the signing certificate and certificate password.');
  if (
    mode === 'developer-id' &&
    (!env.APPLE_ID?.trim() || !env.APPLE_APP_SPECIFIC_PASSWORD?.trim())
  )
    fail('Configure the Apple notarization credentials for Developer ID distribution.');
  if (!command || command === '--cleanup') fail('Pass the release command to sign.');
  const root = await runnerRoot(env);
  const childEnv = signingEnvironment(env);
  const searchOutput = await run('/usr/bin/security', ['list-keychains', '-d', 'user'], {
    env: childEnv,
  });
  const searchList = searchOutput.trim()
    ? searchOutput
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line.trim()))
    : [];
  if (
    searchList.length > 64 ||
    searchList.some(
      (item) => typeof item !== 'string' || !isAbsolute(item) || /[\r\n\0]/.test(item),
    )
  )
    fail('The current keychain search list could not be preserved.');
  const directory = await mkdtemp(join(root, 'otto-apple-signing-'));
  await chmod(directory, 0o700);
  const keychain = join(directory, 'signing.keychain-db');
  const state = { version: 1, pid: process.pid, directory, keychain, searchList };
  try {
    await writeFile(join(root, 'otto-apple-signing-state.json'), JSON.stringify(state), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    fail('An unfinished signing operation exists; complete its cleanup before retrying.');
  }
  Object.assign(childEnv, {
    OTTO_SIGNING_MODE: mode,
    OTTO_SIGNING_IDENTITY: identity,
    OTTO_SIGNING_KEYCHAIN: keychain,
    OTTO_SIGNING_CERTIFICATE_SHA256: fingerprint,
    ...(mode === 'developer-id'
      ? { OTTO_APPLE_TEAM_ID: team, OTTO_NOTARY_PROFILE: 'otto-release' }
      : {}),
  });
  const password = randomBytes(32).toString('base64');
  const certificatePath = join(directory, 'certificate.p12');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const security = (args) =>
    run('/usr/bin/security', args, { env: childEnv, signal: controller.signal });
  try {
    await writeFile(certificatePath, Buffer.from(certificate, 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
    await security(['create-keychain', '-p', password, keychain]);
    await security(['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
    await security(['set-keychain-settings', '-lut', '21600', keychain]);
    await security(['unlock-keychain', '-p', password, keychain]);
    await security([
      'import',
      certificatePath,
      '-k',
      keychain,
      '-P',
      env.APPLE_CERTIFICATE_PASSWORD,
      '-T',
      '/usr/bin/codesign',
    ]);
    await security([
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    await rm(certificatePath);
    const identities = await security([
      'find-identity',
      ...(mode === 'developer-id' ? ['-v'] : []),
      '-p',
      'codesigning',
      keychain,
    ]);
    const matches = new Map(
      [...identities.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"/gm)].map((match) => [
        match[1].toUpperCase(),
        match[2],
      ]),
    );
    if (matches.size !== 1 || [...matches.values()][0] !== identity)
      fail('The imported certificate does not match the selected signing identity.');
    const pem = await security(['find-certificate', '-a', '-p', keychain]);
    const certificates = [
      ...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g),
    ].map((match) => new X509Certificate(match[0]));
    const selected = certificates.find(
      (certificate) => certificate.fingerprint.replaceAll(':', '') === [...matches.keys()][0],
    );
    if (
      !selected ||
      !(Date.parse(selected.validFrom) <= Date.now()) ||
      !(Date.now() < Date.parse(selected.validTo))
    )
      fail('The signing certificate is missing, expired, or not yet valid.');
    if (selected.fingerprint256.replaceAll(':', '').toLowerCase() !== fingerprint)
      fail('The imported certificate does not match APPLE_CERTIFICATE_SHA256.');
    if (
      mode === 'self-signed' &&
      (selected.subject !== selected.issuer || !selected.verify(selected.publicKey))
    )
      fail('Self-signed mode requires a self-signed code signing certificate.');
    if (mode === 'developer-id') {
      await run(
        '/usr/bin/xcrun',
        [
          'notarytool',
          'store-credentials',
          childEnv.OTTO_NOTARY_PROFILE,
          '--validate',
          '--apple-id',
          env.APPLE_ID.trim(),
          '--team-id',
          team,
          '--password',
          env.APPLE_APP_SPECIFIC_PASSWORD,
          '--keychain',
          keychain,
        ],
        { env: childEnv, signal: controller.signal },
      );
    }
    await run(command, args, {
      env: childEnv,
      signal: controller.signal,
      inherit: true,
      timeout: 3_600_000,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await cleanupAppleSigning({ env, run, active: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') fail('Apple signing requires a macOS release runner.');
    const [command, ...args] = process.argv.slice(2);
    if (command === '--cleanup' && args.length === 0) await cleanupAppleSigning();
    else await withAppleSigning(command, args);
  } catch (error) {
    console.error(
      error instanceof SigningError
        ? error.message
        : 'Apple signing failed; inspect the release configuration and cleanup status.',
    );
    process.exitCode = 1;
  }
}
