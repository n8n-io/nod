import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';
import { assetHash, seedRuntimeCache } from '../runtime/assets.mjs';
import { runtimeInputs } from './runtime-inputs.mjs';
import {
  exportCertificate,
  minimumSystemVersion,
  notarize,
  run,
  runtimeUrl,
  signRuntimeTools,
  signingConfiguration,
  signingMetadata,
  sourceRevision,
} from './release-tools.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(repository, '.local/desktop-runtime-assets'),
);
const output = resolve(
  process.env.NOD_RUNTIME_RELEASE_DIR || join(repository, '.local/desktop-runtime-release'),
);
const signed = process.argv.includes('--release');
const buildLock = JSON.parse(
  await readFile(join(repository, 'desktop/scripts/runtime-build-lock.json'), 'utf8'),
);
const notices = new Set(['licenses/COMPONENTS.md', ...buildLock.notices.map((item) => item.file)]);
const configuration = signed ? signingConfiguration() : undefined;
const inputs = await runtimeInputs();
if (
  process.env.NOD_EXPECTED_RUNTIME_FINGERPRINT &&
  process.env.NOD_EXPECTED_RUNTIME_FINGERPRINT !== inputs.fingerprint
)
  throw new Error('The requested runtime fingerprint does not match these inputs.');
const baseUrl = process.env.NOD_RUNTIME_RELEASE_BASE_URL;
const exactUrl = process.env.NOD_RUNTIME_RELEASE_URL;
if (baseUrl && exactUrl) throw new Error('Choose one runtime release URL setting.');
if (baseUrl) runtimeUrl(baseUrl);
if (exactUrl) runtimeUrl(exactUrl);
function included(path) {
  if (notices.has(path)) return true;
  if (
    [
      'manifest.json',
      'guest.img',
      'docker-guest.tar.gz',
      'docker-host/docker/docker',
      'lima/bin/limactl',
    ].includes(path)
  )
    return true;
  if (/^images\/(workspace|browser|postgres)\.tar\.zst$/.test(path)) return true;
  if (/^guest-packages\/[a-z0-9._-]+\.deb$/.test(path)) return true;
  if (!path.startsWith('lima/share/')) return false;
  if (/lima-guestagent\./.test(path))
    return path.endsWith(
      `lima-guestagent.Linux-${inputs.platform.endsWith('-x64') ? 'x86_64' : 'aarch64'}.gz`,
    );
  return true;
}

async function entries(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await entries(path)));
    else if (entry.isFile() && included(relative(assets, path))) files.push(path);
  }
  return files;
}

await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
for (const notice of buildLock.notices) {
  if (
    !/^licenses\/docker-(?:cli|engine)\/(?:LICENSE|NOTICE)$/.test(notice.file) ||
    (await assetHash(join(assets, notice.file))) !== notice.sha256
  )
    throw new Error('A runtime license or notice failed its checksum. Prepare the runtime again.');
}
if (!(await lstat(join(assets, 'licenses/COMPONENTS.md'))).isFile())
  throw new Error('The runtime component inventory is missing. Prepare the runtime again.');
if (
  signed &&
  (manifest.fingerprint !== inputs.fingerprint ||
    manifest.minimumSystemVersion !== minimumSystemVersion)
)
  throw new Error('Rebuild the runtime assets from these pinned release inputs.');
for (const item of [manifest.guest, manifest.dockerGuest, ...manifest.images])
  if (
    !/^(?:guest\.img|docker-guest\.tar\.gz|images\/(?:workspace|browser|postgres)\.tar\.zst)$/.test(
      item.file,
    ) ||
    (await assetHash(join(assets, item.file))) !== item.sha256
  )
    throw new Error(`Runtime asset failed its checksum: ${item.file}`);
let notarization;
if (configuration) {
  console.log(`Signing runtime host tools (${configuration.mode}).`);
  await signRuntimeTools(assets, configuration);
  await exportCertificate(configuration, join(output, 'signing.cer'));
  if (configuration.mode === 'developer-id') {
    const archive = join(output, 'runtime-host-tools.zip');
    try {
      await rm(archive, { force: true });
      await run('/usr/bin/zip', ['-q', archive, 'lima/bin/limactl', 'docker-host/docker/docker'], {
        cwd: assets,
      });
      notarization = await notarize(
        archive,
        configuration,
        join(output, 'runtime-notarization.json'),
      );
      for (const file of ['lima/bin/limactl', 'docker-host/docker/docker'])
        await run('/usr/bin/codesign', [
          '--verify',
          '--strict',
          '--check-notarization',
          join(assets, file),
        ]);
    } finally {
      await rm(archive, { force: true });
    }
  }
}
const files = [];
for (const path of (await entries(assets)).sort()) {
  const metadata = await lstat(path);
  files.push({
    path: relative(assets, path),
    bytes: metadata.size,
    mode: metadata.mode & 0o111 ? 0o755 : 0o644,
    sha256: await assetHash(path),
  });
}
const id = createHash('sha256').update(JSON.stringify(files)).digest('hex');
const file = `nod-Runtime-${inputs.platform}-${id.slice(0, 12)}.tar.gz`;
const path = join(output, file);
let archive;
try {
  const saved = JSON.parse(await readFile(join(output, 'runtime-release.json'), 'utf8'));
  if (
    saved.id === id &&
    (await lstat(path)).size === saved.archive.bytes &&
    (await assetHash(path)) === saved.archive.sha256
  )
    archive = saved.archive;
} catch {}
if (!archive) {
  console.log('Creating the verified Nod Runtime pack.');
  await rm(`${path}.tmp`, { force: true });
  const images = ['images/postgres.tar.zst', 'images/workspace.tar.zst', 'images/browser.tar.zst'];
  await create(
    { cwd: assets, file: `${path}.tmp`, gzip: { level: 6 }, portable: true, noMtime: true },
    files.map((entry) => entry.path).sort((a, b) => images.indexOf(a) - images.indexOf(b)),
  );
  await rename(`${path}.tmp`, path);
  archive = { file, bytes: (await lstat(path)).size, sha256: await assetHash(path) };
}
if (archive.bytes >= 2 * 1024 ** 3)
  throw new Error('The runtime pack exceeds GitHub’s per-asset release limit.');
const configured = baseUrl ? `${baseUrl.replace(/\/$/, '')}/${file}` : exactUrl;
if (configured) runtimeUrl(configured, file);
const release = {
  version: 1,
  platform: inputs.platform,
  ...(process.env.NOD_RUNTIME_RELEASE_TAG
    ? { releaseTag: process.env.NOD_RUNTIME_RELEASE_TAG }
    : {}),
  id,
  archive,
  files,
  fingerprint: inputs.fingerprint,
  ...(manifest.minimumSystemVersion ? { minimumSystemVersion: manifest.minimumSystemVersion } : {}),
  ...(configuration
    ? { signing: signingMetadata(configuration), source: await sourceRevision() }
    : {}),
  ...(notarization ? { notarization } : {}),
  ...(configured ? { url: configured } : {}),
};
await writeFile(join(output, 'runtime-release.json'), JSON.stringify(release, null, 2) + '\n');
await writeFile(join(output, `${file}.sha256`), `${archive.sha256}  ${file}\n`);
await writeFile(join(output, 'SHA256SUMS'), `${archive.sha256}  ${file}\n`);
if (process.argv.includes('--seed-cache')) {
  const cache = await seedRuntimeCache({ source: assets, resourcesPath: output });
  console.log(`Verified runtime cache: ${cache}`);
}
console.log(`Runtime pack: ${path}`);
console.log(`Runtime pack size: ${(archive.bytes / 1024 ** 2).toFixed(1)} MiB`);
