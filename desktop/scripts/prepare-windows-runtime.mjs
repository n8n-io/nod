import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { assetHash } from '../runtime/assets.mjs';
import { copyBundleSource } from './engine-dependencies.mjs';
import { run } from './release-tools.mjs';
import { runtimeInputs } from './runtime-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(root, '.local/windows-runtime-assets'),
);
const context = join(root, '.local/windows-rootfs-context');
await mkdir(context, { recursive: true });
await mkdir(assets, { recursive: true });
if (!process.argv.includes('--prebuilt-images'))
  await run(process.execPath, ['desktop/scripts/prepare-runtime.mjs', '--images-only'], {
    cwd: root,
    env: { ...process.env, NOD_RUNTIME_ASSETS: assets, NOD_DESKTOP_TARGET: 'win32-x64' },
    stdio: 'inherit',
    timeout: 3_600_000,
  });
const images = JSON.parse(await readFile(join(assets, 'images-manifest.json'), 'utf8'));
if (images.platform !== 'linux-x64' || images.images.length !== 3)
  throw new Error('Build the Windows x64 workload images first.');
for (const image of images.images)
  if (
    image.file !== `images/${image.name}.tar.zst` ||
    (await assetHash(join(assets, image.file))) !== image.sha256
  )
    throw new Error('A Windows workload image failed its integrity check.');
for (const image of images.images) {
  image.size = Number(
    await run('docker', ['image', 'inspect', '--format', '{{.Size}}', image.id], {
      output: 'stdout',
    }),
  );
  if (!Number.isSafeInteger(image.size) || image.size < 1 || image.size > 24 * 1024 ** 3)
    throw new Error('A Windows workload image size is invalid.');
}
const manifest = { version: 1, platform: 'win32-x64', images: images.images };
await writeFile(join(context, 'manifest.json'), JSON.stringify(manifest));
await copyBundleSource(join(assets, 'images'), join(context, 'images'));
await copyFile(join(root, 'desktop/runtime/Dockerfile.windows'), join(context, 'Dockerfile'));
await copyFile(join(root, 'desktop/runtime/windows-guest.py'), join(context, 'windows-guest.py'));
async function download(url, checksum, target) {
  const response = await fetch(url);
  if (!response.ok || response.url.startsWith('https:') === false)
    throw new Error('A Windows runtime download failed.');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.tmp`));
  if ((await assetHash(`${target}.tmp`)) !== checksum)
    throw new Error('A Windows runtime download failed its integrity check.');
  await rename(`${target}.tmp`, target);
}
await download(
  'https://download.docker.com/linux/static/stable/x86_64/docker-28.5.1.tgz',
  '5c0d19f31fece1accd0358bb8cff591fe25d7b6cba19f0fd412cbfdc07f75ff6',
  join(context, 'docker.tgz'),
);
const lock = JSON.parse(
  await readFile(join(root, 'desktop/scripts/runtime-build-lock.json'), 'utf8'),
);
for (const notice of lock.notices) {
  const file = join(context, notice.file);
  await mkdir(dirname(file), { recursive: true });
  await download(notice.url, notice.sha256, file);
}
const image = 'nod-windows-rootfs:preview';
await run(
  'docker',
  [
    'build',
    '--platform',
    'linux/amd64',
    '--build-arg',
    'NOD_RUNTIME_REFRESH',
    '--tag',
    image,
    context,
  ],
  {
    stdio: 'inherit',
    timeout: 1_200_000,
  },
);
const container = await run('docker', ['create', '--platform', 'linux/amd64', image, '/bin/true'], {
  output: 'stdout',
});
const file = join(assets, 'guest.tar.gz');
let expandedBytes = 0;
try {
  const child = spawn('docker', ['export', container], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', (bytes) => {
    expandedBytes += bytes.length;
  });
  const exited = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? accept() : reject(new Error('Windows root filesystem export failed.')),
    );
  });
  await Promise.all([
    pipeline(child.stdout, createGzip({ level: 6 }), createWriteStream(`${file}.tmp`)),
    exited,
  ]);
  await rename(`${file}.tmp`, file);
} finally {
  await run('docker', ['rm', '-f', container]);
}
manifest.guest = {
  file: 'guest.tar.gz',
  bytes: (await stat(file)).size,
  expandedBytes,
  sha256: await assetHash(file),
};
await writeFile(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const { fingerprint } = await runtimeInputs('win32-x64');
await writeFile(
  join(assets, `runtime-win32-x64-${fingerprint}.json`),
  JSON.stringify({ ...manifest, fingerprint }, null, 2) + '\n',
);
await rm(context, { recursive: true, force: true });
console.log(`Windows runtime ready: ${assets}`);
