import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const inputs = [
  '.dockerignore',
  '.github/workflows/desktop-release.yml',
  'Dockerfile.workspace',
  'Dockerfile.browser',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches',
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
  'desktop/scripts/runtime-inputs.mjs',
  'desktop/scripts/runtime-pack.mjs',
  'desktop/runtime/assets.mjs',
  'src/providers/container-browser/chromium.sh',
  'src/providers/container-browser/xvfb.sh',
  'src/providers/docker/install-rtk.sh',
  'src/providers/docker/save-video.py',
];
const windowsInputs = [
  'desktop/runtime/Dockerfile.windows',
  'desktop/runtime/windows-guest.py',
  'desktop/scripts/engine-dependencies.mjs',
  'desktop/scripts/prepare-windows-runtime.mjs',
];
export const browserEntries = [
  'src/providers/container-browser/worker.ts',
  'src/providers/container-browser/bridge.ts',
];

export async function browserSources(root = repository) {
  const seen = new Set();
  const visit = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(join(root, path), 'utf8');
    for (const [, target] of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g))
      await visit(posix.join(posix.dirname(path), target));
  };
  for (const entry of browserEntries) await visit(entry);
  return [...seen].sort();
}

export function runtimePlatform(env = process.env) {
  const target =
    env.NOD_DESKTOP_TARGET || `darwin-${process.platform === 'darwin' ? process.arch : 'arm64'}`;
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target))
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
  for (const input of [...inputs, ...(windows ? windowsInputs : []), ...(await browserSources())])
    await collect(input);
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
