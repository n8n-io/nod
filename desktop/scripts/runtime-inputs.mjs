import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inputs = [
  '.dockerignore',
  'Dockerfile.workspace',
  'Dockerfile.browser',
  'pnpm-workspace.yaml',
  'desktop/pnpm-lock.yaml',
  'desktop/pnpm-workspace.yaml',
  'desktop/runtime/downloads.json',
  'desktop/scripts/build-lima.mjs',
  'desktop/scripts/check-browser-image.mjs',
  'desktop/scripts/empty-entitlements.plist',
  'desktop/scripts/lima-entitlements.plist',
  'desktop/scripts/patch-osx-sign.mjs',
  'desktop/scripts/prepare-runtime.mjs',
  'desktop/scripts/release-tools.mjs',
  'desktop/scripts/runtime-build-lock.json',
  'desktop/scripts/runtime-pack.mjs',
  'desktop/runtime/assets.mjs',
  'src/providers/container-browser/chromium.sh',
  'src/providers/container-browser/xvfb.sh',
  'src/providers/docker/install-rtk.sh',
  'src/providers/docker/save-video.py',
  'src/providers/docker/workspace-artifacts.txt',
  'src/providers/docker/workspace-network.sh',
  'src/providers/docker/workspace-video.txt',
];
const windowsInputs = [
  'desktop/licenses/speech.md',
  'desktop/runtime/Dockerfile.windows',
  'desktop/runtime/windows-guest.py',
  'desktop/scripts/engine-dependencies.mjs',
  'desktop/scripts/prepare-windows-runtime.mjs',
  'desktop/scripts/speech-sources.mjs',
];
export const browserEntries = [
  'src/providers/container-browser/worker.ts',
  'src/providers/container-browser/bridge.ts',
];

export const browserTools = ['agent-browser', 'esbuild'];

export async function browserInputs(root = repository) {
  const sources = new Set();
  const packages = new Set(browserTools);
  const visit = async (path) => {
    if (sources.has(path)) return;
    sources.add(path);
    const source = await readFile(join(root, path), 'utf8');
    for (const [, target] of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g))
      if (target.startsWith('.')) await visit(posix.join(posix.dirname(path), target));
      else if (!target.startsWith('node:')) packages.add(target.match(/^(?:@[^/]+\/)?[^/]+/)[0]);
  };
  for (const entry of browserEntries) await visit(entry);
  return { sources: [...sources].sort(), packages: [...packages].sort() };
}

async function lockedPackages(names) {
  const lock = await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8');
  if (!lock.startsWith("lockfileVersion: '9.0'\n"))
    throw new Error('The runtime fingerprint needs a version 9 pnpm lockfile.');
  const section = (name) =>
    new Map(
      (lock.split(`\n${name}:\n`)[1] ?? '')
        .split(/\n(?=\S)/)[0]
        .split(/^(?= {2}\S)/m)
        .map((entry) => [entry.match(/^ {2}'?([^'\s]+?)'?:(?: \{\})?\n/)?.[1], entry.trim()]),
    );
  const versions = new Map(
    [
      ...(section('importers').get('.') ?? '').matchAll(
        /^ {6}'?([^'\s]+?)'?:\n {8}specifier: .*\n {8}version: (\S+)$/gm,
      ),
    ].map(([, name, version]) => [name, version]),
  );
  const packages = section('packages');
  const snapshots = section('snapshots');
  const queue = names.map((name) => `${name}@${versions.get(name)}`);
  const entries = new Map();
  for (const key of queue) {
    if (entries.has(key)) continue;
    const snapshot = snapshots.get(key);
    const resolution = packages.get(key.replace(/\(.*$/, ''));
    if (!snapshot || !resolution)
      throw new Error(`The pnpm lockfile has no runtime entry for ${key}.`);
    entries.set(key, createHash('sha256').update(`${resolution}\n${snapshot}`).digest('hex'));
    for (const [, name, version] of snapshot.matchAll(/^ {6}'?([^'\s]+?)'?: (\S+)$/gm))
      queue.push(`${name}@${version}`);
  }
  return [...entries].map(([key, hash]) => [`lock:${key}`, hash]);
}

export function runtimePlatform(env = process.env) {
  const target =
    env.NOD_DESKTOP_TARGET ||
    (process.platform === 'linux'
      ? `linux-${process.arch}`
      : `darwin-${process.platform === 'darwin' ? process.arch : 'arm64'}`);
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(target))
    throw new Error('Unsupported desktop target.');
  return target;
}

export async function runtimeInputs(platform = runtimePlatform()) {
  const entries = [];
  async function collect(path) {
    const full = join(repository, path);
    const metadata = await lstat(full);
    if ((!metadata.isFile() && !metadata.isDirectory()) || (await realpath(full)) !== full)
      throw new Error('Runtime inputs cannot contain symbolic links.');
    if (metadata.isFile()) {
      entries.push([
        path,
        createHash('sha256')
          .update(await readFile(full))
          .digest('hex'),
      ]);
      return;
    }
    const children = await readdir(full, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name)))
      await collect(`${path}/${child.name}`);
  }
  const windows = platform === 'win32-x64';
  const browser = await browserInputs();
  for (const input of [...inputs, ...(windows ? windowsInputs : []), ...browser.sources])
    await collect(input);
  entries.push(...(await lockedPackages(browser.packages)));
  const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  entries.push(['pnpm:packageManager', manifest.packageManager]);
  if (!windows) {
    const configuration = JSON.parse(
      await readFile(join(repository, 'desktop/package.json'), 'utf8'),
    );
    entries.push(['@electron/osx-sign', configuration.devDependencies['@electron/osx-sign']]);
    const signingMode =
      process.env.NOD_SIGNING_MODE || (process.env.NOD_SIGNING_IDENTITY ? 'self-signed' : 'ad-hoc');
    if (!['ad-hoc', 'self-signed', 'developer-id'].includes(signingMode))
      throw new Error('Unknown runtime signing mode.');
    if (signingMode !== 'ad-hoc') {
      const identity = process.env.NOD_SIGNING_IDENTITY?.trim();
      const certificate = process.env.NOD_SIGNING_CERTIFICATE_SHA256?.toLowerCase();
      if (!identity || /[\r\n\0]/.test(identity) || !/^[a-f0-9]{64}$/.test(certificate || ''))
        throw new Error(
          'Signed runtime inputs require the permanent identity and certificate SHA256.',
        );
      entries.push(['signing.identity', identity], ['signing.certificateSha256', certificate]);
    }
    entries.push(['signing.mode', signingMode]);
  }
  const refresh = process.env.NOD_RUNTIME_REFRESH || 'local';
  if (!/^(?:local|\d{4}-\d{2}-\d{2})$/.test(refresh))
    throw new Error('The runtime refresh must be local or a date.');
  entries.push(['runtime:refresh', refresh]);
  entries.push(['target:platform', platform]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const lock = JSON.parse(
    await readFile(join(repository, 'desktop/scripts/runtime-build-lock.json'), 'utf8'),
  );
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return {
    fingerprint,
    platform,
    minimumSystemVersion: lock.minimumSystemVersion,
    inputs: entries.map(([path]) => path),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await runtimeInputs()));
