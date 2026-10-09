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
        relative(root, path) || basename(path),
      ) && (await filter(path)),
  });
}

export async function copyEngineDependencies({ root, target }) {
  const supports = (values, actual) =>
    !values ||
    (!values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
  await copyBundleSource(join(root, 'node_modules'), join(target, 'node_modules'), async (path) => {
    if (/\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(path)) {
      const metadata = await readFile(join(path, 'package.json'), 'utf8').catch((error) => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
        throw error;
      });
      if (metadata) {
        const item = JSON.parse(metadata);
        if (!supports(item.os, 'darwin') || !supports(item.cpu, 'arm64')) return false;
      }
    }
    return !/\/node_modules\/(?:agent-browser\/bin\/agent-browser-darwin-x64$|@earendil-works\/pi-tui\/native\/darwin\/prebuilds\/darwin-x64(?:\/|$))/.test(
      path,
    );
  });
}
