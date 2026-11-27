import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { run } from './release-tools.mjs';

export const postgresVersion = '17.12.0';

const builds = {
  'darwin-arm64': {
    artifact: 'embedded-postgres-binaries-darwin-arm64v8',
    sha256: '31fcf0b329fa909e050c1bc615bdb0fd6180add1043c2612f5acd5a086449c0b',
    architecture: 'arm64',
  },
  'darwin-x64': {
    artifact: 'embedded-postgres-binaries-darwin-amd64',
    sha256: 'aa639f96ffc1358a6191364835d93a8739289cee01d95ff1eab54ffe365625a8',
    architecture: 'x86_64',
  },
  'win32-x64': {
    artifact: 'embedded-postgres-binaries-windows-amd64',
    sha256: 'bebadbe868ed53adb1c12033a381e41005915205ea9fedaa2349f5467fa7016b',
  },
  'linux-x64': {
    artifact: 'embedded-postgres-binaries-linux-amd64',
    sha256: '7a8951dc117490f2d4161600836c8b1055306aff86e0a472aad55457651e5cbd',
  },
  'linux-arm64': {
    artifact: 'embedded-postgres-binaries-linux-arm64v8',
    sha256: 'b1b880df7027b711852b6fb64d8ceb4d149e1d02bc5fc7665b6af881c64d0fdc',
  },
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function archiveEntry(jar, pattern) {
  const end = jar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The PostgreSQL package is not a zip archive.');
  let offset = jar.readUInt32LE(end + 16);
  for (let index = 0; index < jar.readUInt16LE(end + 10); index++) {
    const nameLength = jar.readUInt16LE(offset + 28);
    const name = jar.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (pattern.test(name)) {
      const method = jar.readUInt16LE(offset + 10);
      const size = jar.readUInt32LE(offset + 20);
      const local = jar.readUInt32LE(offset + 42);
      const start = local + 30 + jar.readUInt16LE(local + 26) + jar.readUInt16LE(local + 28);
      const data = jar.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error('The PostgreSQL package uses an unsupported compression method.');
    }
    offset += 46 + nameLength + jar.readUInt16LE(offset + 30) + jar.readUInt16LE(offset + 32);
  }
  throw new Error('The PostgreSQL package has no binaries.');
}

async function download(build, cacheDir) {
  const file = `${build.artifact}-${postgresVersion}.jar`;
  const cached = join(cacheDir, file);
  const saved = await readFile(cached).catch(() => undefined);
  if (saved && sha256(saved) === build.sha256) return saved;
  const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/${build.artifact}/${postgresVersion}/${file}`;
  let bytes;
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok) throw new Error(`PostgreSQL download failed with HTTP ${response.status}.`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  if (sha256(bytes) !== build.sha256)
    throw new Error('The PostgreSQL download does not match its checksum.');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(`${cached}.download`, bytes);
  await rename(`${cached}.download`, cached);
  return bytes;
}

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  return found;
}

async function thinMac(root, architecture) {
  for (const path of await files(root)) {
    const archs = await run('/usr/bin/lipo', ['-archs', path]).catch(() => '');
    if (!archs.trim().includes(' ')) continue;
    await run('/usr/bin/lipo', [path, '-thin', architecture, '-output', `${path}.thin`]);
    await rename(`${path}.thin`, path);
  }
  const seen = new Map();
  const libraries = (await readdir(join(root, 'lib'), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(root, 'lib', entry.name))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  for (const path of libraries) {
    const hash = sha256(await readFile(path));
    const original = seen.get(hash);
    if (!original) {
      seen.set(hash, path);
      continue;
    }
    await rm(path);
    await symlink(relative(dirname(path), original), path);
  }
}

export async function copyPostgres({
  target,
  platform = process.platform,
  arch = process.arch,
  cacheDir = join(homedir(), '.cache', 'nod', 'postgres'),
}) {
  const build = builds[`${platform}-${arch}`];
  if (!build) throw new Error(`Nod has no PostgreSQL build for ${platform}-${arch}.`);
  const archive = archiveEntry(await download(build, cacheDir), /^postgres-.+\.txz$/);
  const work = await mkdtemp(join(tmpdir(), 'nod-postgres-'));
  const output = join(target, 'postgres');
  try {
    await writeFile(join(work, 'postgres.txz'), archive);
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : process.platform === 'darwin'
          ? '/usr/bin/tar'
          : 'tar';
    await run(tar, ['-xJf', join(work, 'postgres.txz'), '-C', output], { timeout: 600_000 });
    if (build.architecture) await thinMac(output, build.architecture);
    await cp(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'licenses', 'postgresql.md'),
      join(output, 'LICENSE.md'),
    );
    await writeFile(join(output, 'VERSION'), `${postgresVersion} ${build.sha256}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const build = builds[`${process.platform}-${process.arch}`];
  const current = await readFile(join(root, 'postgres', 'VERSION'), 'utf8').catch(() => '');
  if (current !== `${postgresVersion} ${build?.sha256}\n`) await copyPostgres({ target: root });
}
