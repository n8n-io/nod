import { constants, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export function createArtifactFiles({ temporary, downloads, fetchArtifact }) {
  let root;
  const shutdown = new AbortController();
  const prepared = new Map();
  const saved = new Map();
  async function prepare(id, hold = false) {
    shutdown.signal.throwIfAborted();
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    )
      throw new Error('This file is unavailable.');
    let entry = prepared.get(id);
    if (entry) {
      if (hold) entry.heldUntil = Date.now() + 5 * 60 * 1000;
      prepared.delete(id);
      prepared.set(id, entry);
    } else {
      let evicted;
      if (prepared.size >= 8) {
        evicted = [...prepared].find(([, value]) => value.file && value.heldUntil <= Date.now());
        if (!evicted) throw new Error('Some files are still in use. Try again in a few minutes.');
        prepared.delete(evicted[0]);
      }
      entry = { heldUntil: hold ? Date.now() + 5 * 60 * 1000 : 0 };
      const current = entry;
      const pending = (async () => {
        if (evicted) {
          try {
            await rm(evicted[1].file.directory, { recursive: true, force: true });
          } catch (cause) {
            prepared.delete(id);
            prepared.set(...evicted);
            throw cause;
          }
        }
        const response = await fetchArtifact(id, shutdown.signal);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('This file is no longer available.');
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
        name = name.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
        if (!name || name === '.' || name === '..') name = 'download';
        let directory;
        try {
          root ??= mkdtemp(join(temporary, 'nod-files-')).catch((cause) => {
            root = undefined;
            throw cause;
          });
          directory = join(await root, id);
          shutdown.signal.throwIfAborted();
          await mkdir(directory, { mode: 0o700, recursive: true });
          const path = join(directory, name);
          await pipeline(
            response.body,
            async function* (source) {
              let size = 0;
              for await (const chunk of source) {
                size += chunk.byteLength;
                if (size > 90 * 1024 * 1024) throw new Error('This file is too large.');
                yield chunk;
              }
            },
            createWriteStream(path, { mode: 0o600, flags: 'wx' }),
            { signal: shutdown.signal },
          );
          current.file = {
            path,
            directory,
            name,
            type: response.headers.get('content-type')?.split(';')[0] ?? '',
          };
          return current.file;
        } catch (cause) {
          await response.body.cancel().catch(() => {});
          if (directory) await rm(directory, { recursive: true, force: true });
          throw cause;
        }
      })();
      entry.pending = pending;
      prepared.set(id, entry);
      void pending.catch(() => {
        if (prepared.get(id) === current) prepared.delete(id);
      });
    }
    return entry.pending;
  }
  return {
    prepare,
    async save(id) {
      const previousHold = prepared.get(id)?.heldUntil ?? 0;
      const pending = prepare(id, true);
      const entry = prepared.get(id);
      try {
        const file = await pending;
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
            if (cause.code !== 'EEXIST')
              throw new Error('The file could not be saved to Downloads.');
          }
        }
      } finally {
        if (entry && prepared.get(id) === entry) entry.heldUntil = previousHold;
      }
    },
    async path(id) {
      const file = await prepare(id, true);
      return { ...file, path: saved.get(id) ?? file.path };
    },
    async dispose() {
      shutdown.abort();
      await Promise.allSettled([...prepared.values()].map((entry) => entry.pending));
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
