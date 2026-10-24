import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { constants as zlib, createZstdCompress } from 'node:zlib';
import { buildLima } from './build-lima.mjs';
import { runtimeInputs, runtimePlatform } from './runtime-inputs.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(repository, '.local/desktop-runtime-assets'),
);
const imagesOnly = process.argv.includes('--images-only');
const hostOnly = process.argv.includes('--host-only');
const prebuiltImages = process.argv.includes('--prebuilt-images');
const imageCompressionLevel = 15;
const parallelCompression = await new Promise((resolveCheck) => {
  const check = spawn('zstd', ['--version'], { stdio: 'ignore' });
  check.on('error', () => resolveCheck(false));
  check.on('close', (code) => resolveCheck(code === 0));
});
const platform = runtimePlatform();
const nodeArchitecture = platform.endsWith('-x64') ? 'x64' : 'arm64';
const architecture = nodeArchitecture === 'x64' ? 'amd64' : 'arm64';
if (imagesOnly && hostOnly) throw new Error('Choose either image preparation or host preparation.');
if (
  !imagesOnly &&
  (process.platform !== 'darwin' ||
    platform !== `darwin-${nodeArchitecture}` ||
    process.arch !== nodeArchitecture)
)
  throw new Error('Host runtime preparation requires a Mac with the selected architecture.');
if (hostOnly && prebuiltImages)
  throw new Error('Prebuilt image export cannot be combined with host-only preparation.');
const input = await runtimeInputs();
const cache = resolve(
  process.env.NOD_RUNTIME_DOWNLOADS || join(repository, '.local/desktop-runtime-downloads'),
);
const buildLock = JSON.parse(
  await readFile(join(repository, 'desktop/scripts/runtime-build-lock.json'), 'utf8'),
);
const pinnedDownloads = JSON.parse(
  await readFile(join(repository, 'desktop/runtime/downloads.json'), 'utf8'),
);
const downloads = nodeArchitecture === 'x64' ? pinnedDownloads.x64 : pinnedDownloads;
await mkdir(assets, { recursive: true });
await mkdir(cache, { recursive: true });
await mkdir(join(assets, 'images'), { recursive: true });

async function hash(path) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      stdio: ['ignore', 'pipe', 'inherit'],
      ...options,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`${command} exited with ${code}.`)),
    );
  });
}

async function download(name, item, file) {
  if (!/^[a-f0-9]{64}$/.test(item.sha256 || ''))
    throw new Error(`${name} requires a pinned SHA256 checksum.`);
  const path = join(cache, file);
  try {
    await access(path);
    if ((await hash(path)) === item.sha256) return path;
  } catch {}
  console.log(`Preparing ${name}.`);
  await run(
    '/usr/bin/curl',
    [
      '--fail',
      '--location',
      '--retry',
      '3',
      '--connect-timeout',
      '30',
      '--max-time',
      '1200',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--output',
      `${path}.download`,
      item.url,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if ((await hash(`${path}.download`)) !== item.sha256)
    throw new Error(`${name} checksum does not match.`);
  await rename(`${path}.download`, path);
  return path;
}

async function extract(archive, folder) {
  const output = join(assets, folder);
  await mkdir(output, { recursive: true });
  await run('/usr/bin/tar', ['-xzf', archive, '-C', output]);
  return output;
}

const imageDefinitions = [
  {
    name: 'workspace',
    tag: 'nod-desktop-workspace:experiment',
    dockerfile: 'Dockerfile.workspace',
  },
  {
    name: 'browser',
    tag: 'nod-desktop-browser:experiment',
    dockerfile: 'Dockerfile.browser',
  },
  { name: 'postgres', tag: 'postgres:17-alpine' },
];
const images = [];
if (hostOnly) {
  const saved = JSON.parse(await readFile(join(assets, 'images-manifest.json'), 'utf8'));
  if (
    saved.platform !== `linux-${nodeArchitecture}` ||
    saved.fingerprint !== input.fingerprint ||
    !Array.isArray(saved.images) ||
    saved.images.length !== imageDefinitions.length
  )
    throw new Error('The image artifact does not match these runtime inputs.');
  const names = new Set();
  for (const item of saved.images) {
    if (
      names.has(item.name) ||
      !imageDefinitions.some(
        (expected) => expected.name === item.name && expected.tag === item.reference,
      ) ||
      item.file !== `images/${item.name}.tar.zst` ||
      !/^sha256:[a-f0-9]{64}$/.test(item.id) ||
      (await hash(join(assets, item.file))) !== item.sha256
    )
      throw new Error('The image artifact failed validation.');
    names.add(item.name);
    images.push(item);
  }
} else
  for (const item of imageDefinitions) {
    console.log(`Preparing ${item.name} image.`);
    if (item.dockerfile && !prebuiltImages)
      await run(
        'docker',
        [
          'build',
          '--platform',
          `linux/${architecture}`,
          '-f',
          item.dockerfile,
          '-t',
          item.tag,
          '.',
        ],
        { stdio: 'inherit' },
      );
    else if (!item.dockerfile) {
      const current = await run('docker', ['image', 'inspect', item.tag])
        .then((output) => JSON.parse(output)[0])
        .catch(() => undefined);
      if (current?.Architecture !== architecture || current?.Os !== 'linux')
        await run('docker', ['pull', '--platform', `linux/${architecture}`, item.tag], {
          stdio: 'inherit',
        });
    }
    const inspection = JSON.parse(await run('docker', ['image', 'inspect', item.tag]))[0];
    if (inspection.Architecture !== architecture || inspection.Os !== 'linux')
      throw new Error(`${item.name} image has an incompatible platform.`);
    if (item.name === 'browser')
      await run(
        process.execPath,
        ['--import', 'tsx', 'desktop/scripts/check-browser-image.mjs', item.tag],
        { stdio: 'inherit' },
      );
    const file = `images/${item.name}.tar.zst`;
    const target = join(assets, file);
    const stamp = `${target}.id`;
    const stampValue = `${inspection.Id}:zstd${imageCompressionLevel}`;
    let existing = '';
    try {
      existing = (await readFile(stamp, 'utf8')).trim();
    } catch {}
    if (existing !== stampValue) {
      const child = spawn('docker', ['save', item.tag], {
        cwd: repository,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exited = (program, message) =>
        new Promise((resolveExit, reject) => {
          program.on('error', reject);
          program.on('close', (code) =>
            code === 0 ? resolveExit() : reject(new Error(`${message} (${code}).`)),
          );
        });
      const compressor = parallelCompression
        ? spawn('zstd', [`-${imageCompressionLevel}`, '-T0', '-q', '-c'], {
            stdio: ['pipe', 'pipe', 'inherit'],
          })
        : undefined;
      await Promise.all([
        compressor
          ? Promise.all([
              pipeline(child.stdout, compressor.stdin),
              pipeline(compressor.stdout, createWriteStream(`${target}.tmp`)),
              exited(compressor, 'Image compression failed'),
            ])
          : pipeline(
              child.stdout,
              createZstdCompress({
                params: { [zlib.ZSTD_c_compressionLevel]: imageCompressionLevel },
              }),
              createWriteStream(`${target}.tmp`),
            ),
        exited(child, 'Image export failed'),
      ]);
      await rename(`${target}.tmp`, target);
      await writeFile(stamp, stampValue);
    }
    const archiveManifest = JSON.parse(await run('tar', ['-xOf', target, 'manifest.json']));
    const archiveImage = archiveManifest.find((entry) => entry.RepoTags?.includes(item.tag));
    const configurationHash = basename(archiveImage?.Config || '').replace(/\.json$/, '');
    if (!/^[a-f0-9]{64}$/.test(configurationHash))
      throw new Error(`${item.name} export has no image configuration digest.`);
    images.push({
      name: item.name,
      reference: item.tag,
      id: `sha256:${configurationHash}`,
      file,
      sha256: await hash(target),
    });
  }

if (!hostOnly)
  await writeFile(
    join(assets, 'images-manifest.json'),
    JSON.stringify(
      { platform: `linux-${nodeArchitecture}`, fingerprint: input.fingerprint, images },
      null,
      2,
    ) + '\n',
  );
if (imagesOnly) {
  console.log(`Image assets ready: ${assets}`);
  process.exit(0);
}

let dockerGuest;
let guest;
if (!imagesOnly) {
  const limaArchive = await download('Lima 2.2.0', downloads.lima, 'lima.tar.gz');
  await extract(limaArchive, 'lima');
  const guestArchive = await download(
    'Lima guest agents',
    downloads.guestagents,
    'guestagents.tar.gz',
  );
  await extract(guestArchive, 'lima');
  const dockerHost = await download(
    'Docker client 28.5.1',
    downloads.dockerHost,
    'docker-host.tar.gz',
  );
  await extract(dockerHost, 'docker-host');
  await chmod(join(assets, 'docker-host/docker/docker'), 0o755);
  dockerGuest = await download('Docker guest 28.5.1', downloads.dockerGuest, 'docker-guest.tar.gz');
  guest = await download(`Ubuntu 26.04 ${nodeArchitecture}`, downloads.guest, 'guest.img');
  await rm(join(assets, 'guest-packages'), { recursive: true, force: true });
  await mkdir(join(assets, 'guest-packages'));
  for (const item of downloads.guestPackages) {
    const file = basename(new URL(item.url).pathname);
    await cp(await download(file, item, file), join(assets, 'guest-packages', file));
  }

  const sourceArchive = await download(
    'Lima source',
    buildLock.limaSource,
    `lima-source-${buildLock.limaVersion}.tar.gz`,
  );
  const goArchive = await download(
    'Pinned Go compiler',
    nodeArchitecture === 'x64' ? buildLock.goX64 : buildLock.go,
    basename(new URL((nodeArchitecture === 'x64' ? buildLock.goX64 : buildLock.go).url).pathname),
  );
  await buildLima(sourceArchive, goArchive, join(cache, 'build'), join(assets, 'lima'));
  await cp(dockerGuest, join(assets, 'docker-guest.tar.gz'), { mode: constants.COPYFILE_FICLONE });
  await cp(guest, join(assets, 'guest.img'), { mode: constants.COPYFILE_FICLONE });
  for (const notice of buildLock.notices) {
    if (!/^licenses\/docker-(?:cli|engine)\/(?:LICENSE|NOTICE)$/.test(notice.file))
      throw new Error('The runtime notice path is invalid.');
    const file = await download(notice.file, notice, notice.file.replaceAll('/', '-'));
    await mkdir(dirname(join(assets, notice.file)), { recursive: true });
    await cp(file, join(assets, notice.file));
  }
  await writeFile(
    join(assets, 'licenses/COMPONENTS.md'),
    [
      '# nod runtime components',
      '',
      `- Docker CLI ${buildLock.dockerVersion}: https://github.com/docker/cli/tree/v${buildLock.dockerVersion}. License and notices: docker-cli/LICENSE, docker-cli/NOTICE.`,
      `- Docker Engine ${buildLock.dockerVersion}: https://github.com/moby/moby/tree/v${buildLock.dockerVersion}. License and notices: docker-engine/LICENSE, docker-engine/NOTICE.`,
      `- Lima ${buildLock.limaVersion}: ${buildLock.limaSource.url}. License: ../lima/share/doc/lima/LICENSE.`,
      `- Ubuntu guest image: ${downloads.guest.url}. Package copyright and license files remain inside the guest at /usr/share/doc.`,
      `- Ubuntu iptables packages: ${downloads.guestPackages.map((item) => item.url).join(', ')}. Copyright and license files are inside each package at /usr/share/doc.`,
      ...images.map(
        (image) =>
          `- ${image.name} container: ${image.reference}, ${image.id}. Package notices remain inside the image.`,
      ),
      '',
      'The application separately includes Electron and Chromium licenses under Contents/Resources/licenses and dependency licenses alongside its engine/node_modules packages.',
      'Docker notice files are fetched from commit-pinned URLs and checked against the SHA-256 values in desktop/scripts/runtime-build-lock.json during the build. This inventory is not a complete transitive dependency audit.',
      '',
    ].join('\n'),
  );
}

await writeFile(
  join(assets, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      platform,
      limaVersion: buildLock.limaVersion,
      minimumSystemVersion: buildLock.minimumSystemVersion,
      fingerprint: input.fingerprint,
      dockerVersion: buildLock.dockerVersion,
      guest: { file: 'guest.img', sha256: await hash(guest) },
      dockerGuest: { file: 'docker-guest.tar.gz', sha256: await hash(dockerGuest) },
      images,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Runtime assets ready: ${assets}`);
