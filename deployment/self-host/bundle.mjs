import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { create } from 'tar';
import { parse, stringify } from 'yaml';
import { imageIdentities } from './image-identities.mjs';

const run = promisify(execFile);
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(directory, '../..');
const output = resolve(process.argv[2] || '.local/server-bundles');
const revision = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A full source revision is required.');
const tag = process.env.NOD_IMAGE_TAG || 'local';
const services = ['server', 'browser', 'workspace'];
const images = await Promise.all(
  services.map(async (service) => {
    const image = JSON.parse(
      (await run('docker', ['image', 'inspect', `nod-${service}:${tag}`])).stdout,
    )[0];
    if (image.Config.Labels?.['org.opencontainers.image.revision'] !== revision)
      throw new Error(`${service} was not built from the current source revision.`);
    if (image.Os !== 'linux' || !['amd64', 'arm64'].includes(image.Architecture))
      throw new Error(`Unsupported ${service} image platform.`);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Invalid image identity.');
    return {
      service,
      id: image.Id,
      architecture: image.Architecture,
      reference: `nod-${service}:bundle-${image.Id.slice(7)}`,
    };
  }),
);
const architecture = images[0].architecture;
if (images.some((image) => image.architecture !== architecture))
  throw new Error('All images must have the same native architecture.');
const name = `nod-server-linux-${architecture}`;
const bundle = join(output, name);
await mkdir(output, { recursive: true, mode: 0o700 });
await mkdir(bundle, { mode: 0o700 });
const compose = parse(await readFile(join(directory, 'compose.yaml'), 'utf8'));
compose.services.server.environment.NOD_APP_VERSION = revision;
for (const image of images) {
  delete compose.services[image.service].build;
  compose.services[image.service].image = image.reference;
  compose.services[image.service].pull_policy = 'never';
  await run('docker', ['tag', image.id, image.reference]);
}
await writeFile(join(bundle, 'compose.yaml'), stringify(compose));
const files = [
  '.env.example',
  'Caddyfile',
  'docker-proxy.mjs',
  'setup.sh',
  'backup.sh',
  'restore.sh',
  'install.sh',
];
await Promise.all(files.map((file) => copyFile(join(directory, file), join(bundle, file))));
await writeFile(join(bundle, 'source-revision'), `${revision}\n`);
await writeFile(join(bundle, 'architecture'), `${architecture}\n`);
const save = spawn('docker', ['image', 'save', ...images.map((image) => image.reference)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const saved = new Promise((resolve, reject) => {
  save.on('error', reject);
  save.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Image export failed.'))));
});
await Promise.all([
  saved,
  pipeline(
    save.stdout,
    createGzip({ level: 1 }),
    createWriteStream(join(bundle, 'images.tar.gz'), { flags: 'wx' }),
  ),
]);
const identities = await imageIdentities(
  join(bundle, 'images.tar.gz'),
  images.map((image) => image.reference),
  { architecture, revision },
);
for (const [position, identity] of identities.entries())
  if (![identity.config, identity.target].includes(images[position].id))
    throw new Error('Exported image does not match the built image.');
await writeFile(
  join(bundle, 'images.txt'),
  identities.map(({ reference, config, target }) => `${reference} ${config} ${target}\n`).join(''),
);
const digest = async (file) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
files.push('compose.yaml', 'source-revision', 'architecture', 'images.txt', 'images.tar.gz');
await writeFile(
  join(bundle, 'checksums.sha256'),
  (
    await Promise.all(
      files.sort().map(async (file) => `${await digest(join(bundle, file))}  ${file}\n`),
    )
  ).join(''),
);
const archive = join(output, `${name}-${revision}.tar.gz`);
await create({ cwd: output, file: archive, gzip: { level: 1 }, portable: true }, [name]);
await chmod(archive, 0o600);
await writeFile(`${archive}.sha256`, `${await digest(archive)}  ${basename(archive)}\n`, {
  mode: 0o600,
});
console.log(`Private bundle: ${archive}`);
console.log(`Source revision: ${revision}; architecture: linux/${architecture}`);
