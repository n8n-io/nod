import { constants } from 'node:fs';
import { cp, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

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
  const packages = new Set();
  const visit = async (from, name) => {
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', name);
      const item = await packageJson(candidate);
      if (item) {
        if (packages.has(candidate)) return;
        packages.add(candidate);
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
  await copyBundleSource(join(root, 'node_modules'), join(target, 'node_modules'), async (path) => {
    const normalized = path.replaceAll('\\', '/');
    const name = basename(path);
    const parent = basename(dirname(path));
    if (parent === '.bin') {
      const link = await readlink(path).catch(() => undefined);
      const destination = link && resolve(dirname(path), link);
      return !destination || [...packages].some((item) => destination.startsWith(`${item}${sep}`));
    }
    if (
      parent === 'node_modules'
        ? !name.startsWith('.') && !name.startsWith('@')
        : parent.startsWith('@') && basename(dirname(dirname(path))) === 'node_modules'
    ) {
      if (!packages.has(path)) return false;
      const item = await packageJson(path);
      if (item && (!supports(item.os, platform) || !supports(item.cpu, arch))) return false;
    }
    const browserBinary = normalized.match(/\/agent-browser\/bin\/agent-browser-([^/]+)$/);
    if (browserBinary)
      return browserBinary[1] === `${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
    const tuiBinary = normalized.match(
      /\/@earendil-works\/pi-tui\/native\/(?:darwin|linux|win32)\/prebuilds\/([^/]+)(?:\/|$)/,
    );
    return !tuiBinary || tuiBinary[1] === `${platform}-${arch}`;
  });
}
