import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export function createArtifactFiles({ temporary, downloads, fetchArtifact }) {
  let root;
  const prepared = new Map();
  const saved = new Map();
  async function prepare(id) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    )
      throw new Error('This file is unavailable.');
    if (!prepared.has(id)) {
      const pending = (async () => {
        const response = await fetchArtifact(id);
        if (!response.ok) throw new Error('This file is no longer available.');
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 90 * 1024 * 1024) throw new Error('This file is too large.');
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        let name = 'download';
        try {
          name = decodeURIComponent(
            /filename\*=UTF-8''([^;]+)/i.exec(
              response.headers.get('content-disposition') ?? '',
            )?.[1] ?? name,
          );
        } catch {}
        name = basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '');
        if (!name || name === '.' || name === '..') name = 'download';
        root ??= mkdtemp(join(temporary, 'nod-files-'));
        const directory = join(await root, id);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const path = join(directory, name);
        await writeFile(path, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
        return { path, name, type: response.headers.get('content-type')?.split(';')[0] ?? '' };
      })();
      prepared.set(id, pending);
      void pending.catch(() => prepared.delete(id));
    }
    return prepared.get(id);
  }
  return {
    prepare,
    async save(id) {
      const file = await prepare(id);
      await mkdir(downloads, { recursive: true });
      const extension = extname(file.name);
      const stem = file.name.slice(0, file.name.length - extension.length);
      for (let suffix = 0; ; suffix++) {
        const path = join(downloads, suffix ? `${stem} (${suffix})${extension}` : file.name);
        try {
          await copyFile(file.path, path, constants.COPYFILE_EXCL);
          saved.set(id, path);
          return;
        } catch (cause) {
          if (cause.code !== 'EEXIST') throw new Error('The file could not be saved to Downloads.');
        }
      }
    },
    async path(id) {
      const file = await prepare(id);
      return { ...file, path: saved.get(id) ?? file.path };
    },
    async dispose() {
      prepared.clear();
      saved.clear();
      if (root) await rm(await root, { force: true, recursive: true });
    },
  };
}

export function canOpenArtifact({ name, type }) {
  const extensions = {
    'image/png': ['.png'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/webp': ['.webp'],
    'image/gif': ['.gif'],
    'image/avif': ['.avif'],
    'image/bmp': ['.bmp'],
    'application/pdf': ['.pdf'],
    'text/plain': ['.txt'],
    'text/markdown': ['.md', '.markdown'],
    'text/csv': ['.csv'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  };
  return extensions[type]?.includes(extname(name).toLowerCase()) ?? false;
}
