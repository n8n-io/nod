import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { workspaceCommandProgram } from '../../src/providers/docker/command.ts';

const sourcePaths =
  /^(src\/(providers\/(agent-browser\/|container-browser\/|process\.ts$)|ports\/|shared\/)|deployment\/e2b\/browser-ready\.ts$)/;
const entries = [
  'src/providers/container-browser/worker.ts',
  'src/providers/container-browser/bridge.ts',
  'deployment/e2b/browser-ready.ts',
];

export type E2BTemplateRole = 'browser' | 'workspace' | 'computer';

export async function prepareE2BContext(options: { role: E2BTemplateRole; root?: string }) {
  const root = await realpath(
    options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const path = await mkdtemp(join(tmpdir(), 'otto-e2b-template-'));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const close = () => rm(path, { recursive: true, force: true });
  async function read(name: string) {
    const source = resolve(root, name);
    if (relative(root, source) !== name || (await realpath(source)) !== source)
      throw new Error('The template source is outside the approved context.');
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024)
        throw new Error('The template source is not a bounded regular file.');
      const bytes = await file.readFile();
      if (bytes.length !== info.size)
        throw new Error('The template source changed during preparation.');
      return bytes;
    } finally {
      await file.close();
    }
  }
  async function add(name: string, bytes: Uint8Array) {
    if (
      files.length >= 128 ||
      files.reduce((sum, file) => sum + file.bytes, 0) + bytes.length > 8 * 1024 * 1024
    )
      throw new Error('The template context exceeds its size limit.');
    await mkdir(dirname(join(path, name)), { recursive: true, mode: 0o755 });
    await writeFile(join(path, name), bytes, { mode: 0o644 });
    files.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  try {
    const dockerfile = await read(
      options.role === 'browser'
        ? 'Dockerfile.browser'
        : `deployment/e2b/Dockerfile.${options.role}`,
    );
    if (options.role !== 'workspace') {
      for (const name of ['package.json', 'package-lock.json']) await add(name, await read(name));
      const queued = [...entries];
      const visited = new Set<string>();
      for (const name of queued) {
        if (visited.has(name)) continue;
        if (!sourcePaths.test(name) || !name.endsWith('.ts'))
          throw new Error('The browser template imports an unapproved source.');
        visited.add(name);
        const bytes = await read(name);
        await add(name, bytes);
        const imports = ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles;
        for (const imported of imports) {
          if (imported.fileName.startsWith('.')) {
            queued.push(relative(root, resolve(root, dirname(name), imported.fileName)));
          } else if (
            !imported.fileName.startsWith('node:') &&
            !['zod', 'tldts'].includes(imported.fileName)
          ) {
            throw new Error('The browser template imports an unapproved package.');
          }
        }
      }
    }
    if (options.role !== 'browser') {
      await add('workspace-command.py', Buffer.from(workspaceCommandProgram));
    }
    if (options.role === 'computer')
      await add('deployment/e2b/computer-guard.py', await read('deployment/e2b/computer-guard.py'));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      path,
      dockerfile: dockerfile.toString('utf8'),
      files,
      sha256: createHash('sha256').update(dockerfile).update(JSON.stringify(files)).digest('hex'),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
