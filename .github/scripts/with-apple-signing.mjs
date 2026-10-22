import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { constants, renameSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

class SigningError extends Error {}

function fail(message) {
  throw new SigningError(message);
}

export function signingEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !/^(APPLE_|NOD_SIGNING_|NOD_NOTARY_|NOD_APPLE_)/.test(key),
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

function processGroup(pid) {
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,uid=,stat=,lstart='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 ** 2,
  })
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match && Number(match[2]) === pid && !match[4].includes('Z')
        ? [{ pid: Number(match[1]), uid: Number(match[3]), started: match[5].trim() }]
        : [];
    });
}

async function stopProcessGroup(group) {
  let verified = false;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const members = processGroup(group.pid);
      if (!members.length) return;
      const leader = members.find((member) => member.pid === group.pid);
      if (
        (!leader && !verified) ||
        (leader && leader.started !== group.started) ||
        members.some((member) => member.uid !== process.getuid())
      )
        fail('The saved signing process group no longer has its recorded identity.');
      verified = true;
      if (attempt === 0)
        try {
          process.kill(-group.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      await delay(50);
    }
  }
  fail('The signing process group did not stop; cleanup was refused.');
}

function execute(command, args, { env, signal, register, inherit = false, timeout = 120_000 }) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new SigningError('Apple signing was interrupted.'));
    const launcher = `import { spawn } from 'node:child_process';
let input = '';
for await (const bytes of process.stdin) input += bytes;
if (!input) process.exit(1);
const [command, args] = JSON.parse(input);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', () => process.exit(1));
child.once('close', (code) => process.exit(code ?? 1));`;
    const child = spawn(
      register ? process.execPath : command,
      register ? ['--input-type=module', '-e', launcher] : args,
      {
        env,
        detached: true,
        stdio: [
          register ? 'pipe' : 'ignore',
          inherit ? 'inherit' : 'pipe',
          inherit ? 'inherit' : 'ignore',
        ],
      },
    );
    let output = '';
    let stopped = false;
    let unregister;
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
      try {
        if (unregister && !processGroup(child.pid).length) unregister();
      } catch {
        stopped = true;
      }
      if (stopped || code !== 0)
        reject(new SigningError('An Apple signing command failed or was interrupted.'));
      else accept(output);
    });
    if (register && child.pid)
      try {
        unregister = register(child.pid);
        child.stdin.on('error', stop);
        child.stdin.end(JSON.stringify([command, args]));
      } catch {
        stopped = true;
        kill('SIGKILL');
      }
  });
}

async function readState(root) {
  const path = join(root, 'nod-apple-signing-state.json');
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
      state.version !== 2 ||
      !Number.isSafeInteger(state.pid) ||
      state.pid <= 1 ||
      !Array.isArray(state.groups) ||
      state.groups.length > 64 ||
      state.groups.some(
        (group) =>
          !Number.isSafeInteger(group.pid) ||
          group.pid <= 1 ||
          typeof group.started !== 'string' ||
          !group.started ||
          group.started.length > 64 ||
          /[\r\n\0]/.test(group.started),
      ) ||
      typeof state.directory !== 'string' ||
      dirname(state.directory) !== root ||
      !/^nod-apple-signing-[A-Za-z0-9]{6}$/.test(basename(state.directory)) ||
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
  for (const group of state.groups) await stopProcessGroup(group);
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
  const mode = env.NOD_SIGNING_MODE || 'self-signed';
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
  const notaryKey = env.APPLE_API_KEY?.trim();
  const notaryKeyId = env.APPLE_API_KEY_ID?.trim();
  const notaryIssuer = env.APPLE_API_ISSUER?.trim();
  if (
    mode === 'developer-id' &&
    (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(notaryKey || '') ||
      !/^[A-Z0-9]{10,}$/.test(notaryKeyId || '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notaryIssuer || ''))
  )
    fail('Configure the App Store Connect team API key for Developer ID notarization.');
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
  const directory = await mkdtemp(join(root, 'nod-apple-signing-'));
  await chmod(directory, 0o700);
  const keychain = join(directory, 'signing.keychain-db');
  const state = { version: 2, pid: process.pid, directory, keychain, searchList, groups: [] };
  try {
    await writeFile(join(root, 'nod-apple-signing-state.json'), JSON.stringify(state), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    fail('An unfinished signing operation exists; complete its cleanup before retrying.');
  }
  Object.assign(childEnv, {
    NOD_SIGNING_MODE: mode,
    NOD_SIGNING_IDENTITY: identity,
    NOD_SIGNING_KEYCHAIN: keychain,
    NOD_SIGNING_CERTIFICATE_SHA256: fingerprint,
    ...(mode === 'developer-id'
      ? { NOD_APPLE_TEAM_ID: team, NOD_NOTARY_PROFILE: 'nod-release' }
      : {}),
  });
  const password = randomBytes(32).toString('base64');
  const certificatePath = join(directory, 'certificate.p12');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const security = (args) =>
    run('/usr/bin/security', args, { env: childEnv, signal: controller.signal, register });
  const register = (pid) => {
    const leader = processGroup(pid).find((member) => member.pid === pid);
    if (!leader || leader.uid !== process.getuid())
      fail('The signing child process group could not be identified.');
    const save = () => {
      const pending = join(directory, 'cleanup-state.json');
      writeFileSync(pending, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      renameSync(pending, join(root, 'nod-apple-signing-state.json'));
    };
    state.groups.push({ pid, started: leader.started });
    save();
    return () => {
      state.groups = state.groups.filter((group) => group.pid !== pid);
      save();
    };
  };
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
      const keyPath = join(directory, `AuthKey_${notaryKeyId}.p8`);
      await writeFile(keyPath, `${notaryKey}\n`, { mode: 0o600, flag: 'wx' });
      await run(
        '/usr/bin/xcrun',
        [
          'notarytool',
          'store-credentials',
          childEnv.NOD_NOTARY_PROFILE,
          '--validate',
          '--key',
          keyPath,
          '--key-id',
          notaryKeyId,
          '--issuer',
          notaryIssuer,
          '--keychain',
          keychain,
        ],
        { env: childEnv, signal: controller.signal, register },
      );
      await rm(keyPath);
    }
    await run(command, args, {
      env: childEnv,
      signal: controller.signal,
      register,
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
