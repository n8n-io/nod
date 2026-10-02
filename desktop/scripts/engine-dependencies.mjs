import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, realpath, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const packageName = (value) =>
  value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];

export function copyBundleSource(source, target) {
  const root = resolve(source);
  return cp(root, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (path) =>
      !/(?:^|\/)\.env(?:[./]|$)|(?:^|\/)(?:\.git|\.local|\.cache|\.DS_Store)(?:\/|$)/.test(
        relative(root, path) || basename(path),
      ),
  });
}

async function imports(directory) {
  const result = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const name of await imports(path)) result.add(name);
    else if (/\.(?:[mc]?js|tsx?)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      for (const item of ts.preProcessFile(text, true, true).importedFiles) {
        const value = item.fileName;
        if (!value.startsWith('.') && !value.startsWith('/') && !value.includes(':'))
          result.add(packageName(value));
      }
    }
  }
  return result;
}

async function locatePackage(name, parent) {
  for (let current = parent; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    try {
      await access(join(candidate, 'package.json'));
      return realpath(candidate);
    } catch {}
    if (current === dirname(current))
      throw new Error(`Missing desktop runtime dependency: ${name}`);
  }
}

function supports(values, actual) {
  return (
    !values ||
    (!values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(actual)))
  );
}

export async function copyEngineDependencies({ root, target }) {
  const names = new Set(['tsx', 'tar', 'pg', 'pi-web-access']);
  for (const directory of ['src/server', 'src/runtime', 'src/providers', 'src/shared', 'src/ports'])
    for (const name of await imports(join(root, directory))) names.add(name);
  const queue = [...names].map((name) => ({ name, parent: root, optional: false }));
  const seen = new Set();
  while (queue.length) {
    const item = queue.shift();
    let source;
    try {
      source = await locatePackage(item.name, item.parent);
    } catch (error) {
      if (item.optional) continue;
      throw error;
    }
    if (seen.has(source)) continue;
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (!supports(metadata.os, 'darwin') || !supports(metadata.cpu, 'arm64')) {
      if (!item.optional) throw new Error(`Incompatible desktop dependency: ${item.name}`);
      continue;
    }
    seen.add(source);
    const location = relative(root, source);
    if (location.startsWith('..') || !location.includes('node_modules'))
      throw new Error('A desktop dependency resolved outside this checkout.');
    const destination = join(target, location);
    await cp(source, destination, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
      filter: (path) =>
        path === source ||
        (!relative(source, path).split(sep).includes('node_modules') &&
          !path.endsWith('.map') &&
          !(
            metadata.name === '@earendil-works/pi-tui' &&
            /(?:^|\/)prebuilds\/(?!darwin-arm64(?:\/|$))/.test(relative(source, path))
          )),
    });
    const binaries =
      typeof metadata.bin === 'string'
        ? { [metadata.name.split('/').at(-1)]: metadata.bin }
        : metadata.bin || {};
    const modules = metadata.name.startsWith('@')
      ? dirname(dirname(destination))
      : dirname(destination);
    for (const [name, file] of Object.entries(binaries)) {
      const bin = join(modules, '.bin', name);
      await mkdir(dirname(bin), { recursive: true });
      await symlink(relative(dirname(bin), join(destination, file)), bin).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const optional = metadata.optionalDependencies || {};
    for (const [name] of Object.entries({ ...metadata.dependencies, ...optional }))
      queue.push({ name, parent: source, optional: name in optional });
    for (const name of Object.keys(metadata.peerDependencies || {}))
      if (!metadata.peerDependenciesMeta?.[name]?.optional)
        queue.push({ name, parent: source, optional: false });
  }
  return { packages: seen.size, roots: [...names].sort() };
}
