import { constants } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

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
  await copyBundleSource(join(root, 'node_modules'), join(target, 'node_modules'), async (path) => {
    const normalized = path.replaceAll('\\', '/');
    if (/\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(normalized)) {
      const metadata = await readFile(join(path, 'package.json'), 'utf8').catch((error) => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
        throw error;
      });
      if (metadata) {
        const item = JSON.parse(metadata);
        if (!supports(item.os, platform) || !supports(item.cpu, arch)) return false;
      }
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
