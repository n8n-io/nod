import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageName = 'nod-linux-x64.rpm';
const manifestName = 'release-linux-x64-rpm.json';

async function digest(path) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}

export async function writeRpmManifest({ directory, version, source }) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '') ||
    !/^[a-f0-9]{40}$/.test(source || '')
  )
    throw new Error('The RPM release needs a plain version and a 40-character source commit.');
  const path = join(directory, packageName);
  const { size } = await stat(path);
  if (size <= 0) throw new Error('The RPM is empty.');
  const sha256 = await digest(path);
  const manifest = {
    platform: 'linux-x64-rpm',
    version,
    source,
    rpm: { file: packageName, bytes: size, sha256 },
  };
  await writeFile(join(directory, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeRpmManifest({
    directory: resolve(process.argv[2] ?? 'dist/desktop/rpm'),
    version: process.env.NOD_DESKTOP_VERSION,
    source: process.env.NOD_RELEASE_SOURCE,
  });
}
