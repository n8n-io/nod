import { constants } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

export function copyBundleSource(source, target, filter = () => true) {
  const root = resolve(source);
  return cp(root, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (path) =>
      !/(?:^|\/)\.env(?:[./]|$)|(?:^|\/)(?:\.git|\.local|\.cache|\.DS_Store)(?:\/|$)/.test(
        relative(root, path) || basename(path),
      ) && filter(path),
  });
}

export async function copyEngineDependencies({ root, target }) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const supports = (values, actual) =>
    !values ||
    (!values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
  const incompatible = new Set(
    Object.entries(lock.packages)
      .filter(([, item]) => !supports(item.os, 'darwin') || !supports(item.cpu, 'arm64'))
      .map(([path]) => resolve(root, path)),
  );
  await copyBundleSource(
    join(root, 'node_modules'),
    join(target, 'node_modules'),
    (path) =>
      !incompatible.has(path) &&
      !/\/node_modules\/(?:agent-browser\/bin\/agent-browser-darwin-x64$|@earendil-works\/pi-tui\/native\/darwin\/prebuilds\/darwin-x64(?:\/|$))/.test(
        path,
      ),
  );
}
