import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const bundleName = 'nod-linux-x64.flatpak';
const manifestName = 'release-linux-x64.json';
const checksumsName = 'SHA256SUMS-linux-x64';
const partLimit = 1900 * 1024 ** 2;
const digestPattern = /^[a-f0-9]{64}$/;

async function digest(path) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}

export async function packageLinuxBundle({
  root,
  bundle,
  version,
  source,
  commit,
  partBytes = partLimit,
}) {
  if (!Number.isSafeInteger(partBytes) || partBytes <= 0 || partBytes > partLimit)
    throw new Error('The Linux bundle part size is invalid.');
  const bytes = (await stat(bundle)).size;
  if (bytes <= 0 || Math.ceil(bytes / partBytes) > 2)
    throw new Error('The Linux bundle must fit in two release parts.');
  const directory = join(root, 'dist/desktop/linux-x64');
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const parts = [];
  for (let start = 0; start < bytes; start += partBytes) {
    const file = `${bundleName}.part${String(parts.length).padStart(2, '0')}`;
    const path = join(directory, file);
    const end = Math.min(bytes, start + partBytes) - 1;
    await pipeline(createReadStream(bundle, { start, end }), createWriteStream(path));
    parts.push({ file, bytes: end - start + 1, sha256: await digest(path) });
  }
  const manifest = {
    platform: 'linux-x64',
    version,
    source,
    commit,
    bundle: { file: bundleName, bytes, sha256: await digest(bundle) },
    parts,
  };
  await writeFile(join(directory, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(
    join(directory, checksumsName),
    [...parts, manifest.bundle].map((entry) => `${entry.sha256}  ${entry.file}\n`).join(''),
  );
  await linuxReleaseFiles(root, { version, source });
}

export async function linuxReleaseFiles(root, { version, source }) {
  const directory = join(root, 'dist/desktop/linux-x64');
  const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
  if (
    !/^\d+\.\d+\.\d+$/.test(version || '') ||
    !/^[a-f0-9]{40}$/.test(source || '') ||
    manifest.platform !== 'linux-x64' ||
    manifest.version !== version ||
    manifest.source !== source ||
    !digestPattern.test(manifest.commit || '') ||
    manifest.bundle?.file !== bundleName ||
    !digestPattern.test(manifest.bundle.sha256 || '') ||
    !Number.isSafeInteger(manifest.bundle.bytes) ||
    manifest.bundle.bytes <= 0 ||
    !Array.isArray(manifest.parts) ||
    !manifest.parts.length ||
    manifest.parts.length > 2
  )
    throw new Error('The Linux release does not match its source or Flatpak commit.');
  const whole = createHash('sha256');
  let bytes = 0;
  for (const [index, part] of manifest.parts.entries()) {
    if (
      part.file !== `${bundleName}.part${String(index).padStart(2, '0')}` ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes <= 0 ||
      part.bytes > partLimit ||
      !digestPattern.test(part.sha256 || '')
    )
      throw new Error('The Linux bundle part is invalid.');
    const path = join(directory, part.file);
    if ((await stat(path)).size !== part.bytes)
      throw new Error('The Linux bundle part size does not match.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      whole.update(chunk);
    }
    if (hash.digest('hex') !== part.sha256)
      throw new Error('The Linux bundle part failed its checksum.');
    bytes += part.bytes;
  }
  if (bytes !== manifest.bundle.bytes || whole.digest('hex') !== manifest.bundle.sha256)
    throw new Error('The Linux bundle failed its checksum.');
  const checksums = [...manifest.parts, manifest.bundle]
    .map((entry) => `${entry.sha256}  ${entry.file}\n`)
    .join('');
  if ((await readFile(join(directory, checksumsName), 'utf8')) !== checksums)
    throw new Error('The Linux checksums do not match.');
  return [manifestName, checksumsName, ...manifest.parts.map((part) => part.file)].map((file) =>
    join(directory, file),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageLinuxBundle({
    root: process.cwd(),
    bundle: resolve('.local', bundleName),
    version: process.env.NOD_DESKTOP_VERSION,
    source: process.env.NOD_RELEASE_SOURCE,
    commit: process.env.NOD_FLATPAK_COMMIT,
  });
}
