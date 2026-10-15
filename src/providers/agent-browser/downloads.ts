import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserDownload } from '../../ports/computer.ts';
import { fileBytes, fileName } from '../../shared/files.ts';

export function downloadName(value: string | undefined, pdf = false): string {
  const name = value ?? (pdf ? 'download.pdf' : 'download');
  if (!name.trim() || /[/\\\u0000-\u001f\u007f]/.test(name) || name === '.' || name === '..')
    throw new Error('A plain download filename is required.');
  return fileName(name);
}

export function downloadFile(bytes: Buffer, name?: string, mimeType?: string): BrowserDownload {
  if (!bytes.length || bytes.length > fileBytes)
    throw new Error(
      `Browser downloads must be between one byte and ${fileBytes / 1024 / 1024} MiB.`,
    );
  const pdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  const type = pdf
    ? 'application/pdf'
    : (mimeType?.split(';')[0].trim() ?? 'application/octet-stream');
  if (type.length > 100 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type))
    throw new Error('The browser download type is unavailable.');
  return { bytes, name: downloadName(name, pdf), mimeType: type };
}

export function decodeDownloadChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('The browser file is unavailable.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('The browser file is unavailable.');
  return bytes;
}

export async function completedDownloads(directory: string): Promise<string[]> {
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('The browser download directory is unavailable.');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.crdownload'))
      .map(async (entry) => ({
        name: entry.name,
        modified: (await lstat(join(directory, entry.name))).mtimeMs,
      })),
  );
  return files.sort((a, b) => b.modified - a.modified).map((file) => file.name);
}

export async function readDownload(directory: string, file: string, name?: string) {
  if (!file || file.includes('/') || file.includes('\\') || file === '.' || file === '..')
    throw new Error('The browser file is unavailable.');
  const root = await lstat(directory).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink())
    throw new Error('The browser file is unavailable.');
  const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => {
      throw new Error('The browser file is unavailable.');
    },
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > fileBytes)
      throw new Error();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('The browser download changed while reading.');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const path = await lstat(join(directory, file));
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== path.ino ||
      before.dev !== path.dev ||
      path.isSymbolicLink()
    )
      throw new Error('The browser download changed while reading.');
    return downloadFile(bytes, name);
  } catch {
    throw new Error(`The browser file is unavailable or exceeds ${fileBytes / 1024 / 1024} MiB.`);
  } finally {
    await handle.close();
  }
}

export async function createDownloadCapture(directory: string) {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('The browser download directory is unavailable.');
  const previous = new Set(await readdir(directory));
  const file = `capture-${randomUUID()}`;
  return {
    file,
    async cleanup(closed = false) {
      const current = await lstat(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== root.dev ||
        current.ino !== root.ino
      )
        throw new Error('The browser download directory changed.');
      for (const name of closed ? await readdir(directory) : [file]) {
        if (previous.has(name)) continue;
        await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}

export const fetchChunkBytes = 4 * 1024 * 1024;

export function fetchDownloadScript(url: string, key: string) {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > ${fileBytes}) throw new Error();
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > ${fileBytes}) { await reader.cancel(); throw new Error(); }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      window[${JSON.stringify(key)}] = bytes;
      return { size, mimeType: response.headers.get('content-type') || 'application/octet-stream' };
    } catch { return null; }
  })()`;
}

export function fetchChunkScript(key: string, offset: number) {
  return `(() => {
    const bytes = window[${JSON.stringify(key)}].subarray(${offset}, ${offset + fetchChunkBytes});
    let binary = '';
    for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    return btoa(binary);
  })()`;
}
