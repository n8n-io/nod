import { constants } from 'node:fs';
import { cp, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { copySpeechSources } from './speech-sources.mjs';

export function copyBundleSource(source, target, filter = () => true) {
  const root = resolve(source);
  return cp(root, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: async (path) =>
      !/(?:^|\/)\.env(?:[./]|$)|(?:^|\/)(?:\.git|\.local|\.cache|\.DS_Store)(?:\/|$)/.test(
        (relative(root, path) || basename(path)).replaceAll('\\', '/'),
      ) && (await filter(path)),
  });
}

async function packageJson(directory) {
  const metadata = await readFile(join(directory, 'package.json'), 'utf8').catch((error) => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  });
  return metadata && JSON.parse(metadata);
}

async function productionPackages(root) {
  const packages = new Map();
  const visit = async (from, name) => {
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', name);
      const item = await packageJson(candidate);
      if (item) {
        if (packages.has(candidate)) return;
        packages.set(candidate, item);
        for (const dependency of Object.keys({
          ...item.dependencies,
          ...item.optionalDependencies,
          ...item.peerDependencies,
        }))
          await visit(candidate, dependency);
        return;
      }
      if (directory === root) return;
    }
  };
  for (const name of Object.keys((await packageJson(root))?.dependencies ?? {}))
    await visit(root, name);
  return packages;
}

function runtimeEntries(value) {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  if (Array.isArray(value)) return value.flatMap(runtimeEntries);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value)
    .filter(
      ([key]) =>
        /^[.#]/.test(key) ||
        ['default', 'node', 'import', 'require', 'node-addons', 'module-sync'].includes(key),
    )
    .flatMap(([, entry]) => runtimeEntries(entry));
}

export async function copyEngineDependencies({
  root,
  target,
  platform = 'darwin',
  arch = 'arm64',
}) {
  const supports = (values, actual) =>
    !values ||
    (!values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
  const packages = await productionPackages(resolve(root));
  const entries = new Map(
    [...packages].map(([path, item]) => [
      path,
      runtimeEntries([
        item.main,
        item.module,
        item.exports,
        item.imports,
        typeof item.bin === 'string' ? item.bin : Object.values(item.bin ?? {}),
      ]),
    ]),
  );
  if ([...packages.keys()].some((path) => basename(path) === 'phonemizer'))
    throw new Error('The opaque phonemizer package cannot be included in the desktop runtime.');
  await copyBundleSource(join(root, 'node_modules'), join(target, 'node_modules'), async (path) => {
    const normalized = path.replaceAll('\\', '/');
    const name = basename(path);
    const parent = basename(dirname(path));
    if (parent === 'node_modules' && name.startsWith('.') && name !== '.bin') return false;
    if (/\.(?:map|tsbuildinfo)$|\.d\.(?:ts|mts|cts)$/.test(name)) return false;
    if (
      ['.github', '.gitlab', '.husky', '@types'].includes(name) ||
      /^(?:tsconfig(?:\.[^.]+)*\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.npmignore)$/.test(
        name,
      )
    )
      return false;
    let owner = path;
    while (owner !== resolve(root) && !packages.has(owner)) owner = dirname(owner);
    if (packages.has(owner)) {
      const parts = relative(owner, path).split(sep);
      const surplus = [
        'test',
        'tests',
        '__tests__',
        'example',
        'examples',
        'docs',
        'doc',
        'scripts',
        'benchmark',
        'benchmarks',
        'coverage',
      ].includes(parts[0]);
      const advertised = entries.get(owner);
      if (surplus && !advertised.some((entry) => entry.startsWith(`${parts[0]}/`))) return false;
      if (
        /\.(?:ts|tsx|mts|cts)$/.test(name) &&
        !advertised.some((entry) => /\.(?:ts|tsx|mts|cts)$/.test(entry))
      )
        return false;
    }
    if (parent === '.bin') {
      const link = await readlink(path).catch(() => undefined);
      const destination = link && resolve(dirname(path), link);
      return (
        !destination || [...packages.keys()].some((item) => destination.startsWith(`${item}${sep}`))
      );
    }
    if (
      parent === 'node_modules'
        ? !name.startsWith('.') && !name.startsWith('@')
        : parent.startsWith('@') && basename(dirname(dirname(path))) === 'node_modules'
    ) {
      if (!packages.has(path)) return false;
      const item = packages.get(path);
      if (item && (!supports(item.os, platform) || !supports(item.cpu, arch))) return false;
    }
    const browserBinary = normalized.match(/\/agent-browser\/bin\/agent-browser-([^/]+)$/);
    if (browserBinary)
      return browserBinary[1] === `${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
    const inferenceBinary = normalized.match(
      /\/onnxruntime-node\/bin\/napi-v\d+\/([^/]+)(?:\/([^/]+))?/,
    );
    if (inferenceBinary)
      return (
        inferenceBinary[1] === platform && (!inferenceBinary[2] || inferenceBinary[2] === arch)
      );
    const tuiBinary = normalized.match(
      /\/@earendil-works\/pi-tui\/native\/(?:darwin|linux|win32)\/prebuilds\/([^/]+)(?:\/|$)/,
    );
    return !tuiBinary || tuiBinary[1] === `${platform}-${arch}`;
  });
  if (
    [...packages.keys()].some((path) => path.endsWith(`${sep}@spelling-creator${sep}spellophone`))
  )
    await copySpeechSources({ root, target });
}
