import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import { pool } from './db.ts';
import { dataRoot, ownerId } from './config.ts';
import type { Artifact } from '../shared/contracts.ts';
import type { MessagingAttachment } from '../ports/messaging.ts';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { PrivateObjectStore } from '../ports/object-storage.ts';

const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.ogv': 'video/ogg',
  '.html': 'text/html',
};
export const maxFileSize = 15 * 1024 * 1024;
export function artifactView(row: Record<string, any>): Artifact {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    url: `/api/artifacts/${row.id}`,
  };
}
async function readLocal(path: string, size: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== size) throw new Error('An attachment is unavailable.');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await file.read(bytes, offset, size - offset, offset);
      if (!result.bytesRead) throw new Error('An attachment is unavailable.');
      offset += result.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, size)).bytesRead)
      throw new Error('An attachment is unavailable.');
    return bytes;
  } finally {
    await file.close();
  }
}

export function createArtifactService(options: {
  database: Pool;
  ownerId: string;
  store?: PrivateObjectStore;
  localRoot?: string;
}) {
  if (!options.ownerId || (!options.store && !options.localRoot))
    throw new Error('Private file storage is unavailable.');
  const location = (id: string) =>
    options.localRoot ? join(options.localRoot, 'artifacts', id) : `object:artifacts/${id}`;
  async function readRow(row: Record<string, any>) {
    z.uuid().parse(row.id);
    if (
      row.storage_path !== location(row.id) ||
      !Number.isInteger(row.size) ||
      row.size < 1 ||
      row.size > maxFileSize
    )
      throw new Error('An attachment is unavailable.');
    const object = options.store
      ? await options.store.read(`artifacts/${row.id}`, row.size)
      : { bytes: await readLocal(location(row.id), row.size) };
    if (!object || object.bytes.byteLength !== row.size)
      throw new Error('An attachment is unavailable.');
    return Buffer.from(object.bytes);
  }
  async function readArtifact(id: string) {
    z.uuid().parse(id);
    const row = (
      await options.database.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2', [
        id,
        options.ownerId,
      ])
    ).rows[0];
    if (!row) throw new Error('An attachment is unavailable.');
    return readRow(row);
  }
  async function storeArtifact(
    bytes: Buffer,
    name: string,
    mimeType: string,
    taskId?: string,
    database: Pick<PoolClient, 'query'> = options.database,
  ): Promise<Artifact> {
    if (!bytes.length || bytes.length > maxFileSize)
      throw Object.assign(new Error('Files must be between 1 byte and 15 MB.'), {
        statusCode: 400,
      });
    if (
      taskId &&
      !(
        await database.query('SELECT id FROM tasks WHERE id=$1 AND owner_id=$2', [
          z.uuid().parse(taskId),
          options.ownerId,
        ])
      ).rowCount
    )
      throw new Error('The task is unavailable.');
    const id = randomUUID();
    const key = `artifacts/${id}`;
    const version = options.store
      ? await options.store.write(key, bytes, { expectedVersion: null })
      : undefined;
    if (!options.store) {
      if (!options.localRoot) throw new Error('Private file storage is unavailable.');
      await mkdir(join(options.localRoot, 'artifacts'), { recursive: true, mode: 0o700 });
      await writeFile(location(id), bytes, { mode: 0o600, flag: 'wx' });
    }
    const safeName =
      basename(name)
        .replace(/[\r\n\x00-\x1f]/g, '')
        .slice(0, 160) || 'file';
    try {
      const result = await database.query(
        'INSERT INTO artifacts(id,owner_id,task_id,name,mime_type,size,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [id, options.ownerId, taskId || null, safeName, mimeType, bytes.length, location(id)],
      );
      return artifactView(result.rows[0]);
    } catch (error) {
      if (options.store)
        await options.store.remove(key, { expectedVersion: version }).catch(() => {});
      else await rm(location(id), { force: true }).catch(() => {});
      throw error;
    }
  }
  async function publishArtifact(
    taskId: string,
    path: string,
    name: string | undefined,
    read: (
      taskId: string,
      path: string,
      maxBytes: number,
      purpose?: 'attachment' | 'publication',
    ) => Promise<Uint8Array>,
  ) {
    z.uuid().parse(taskId);
    if (!path || path.length > 4096 || path.includes('\0') || path.includes('\\'))
      throw new Error('A workspace file path is required.');
    const base = `/workspace/${taskId}`;
    const actual = posix.resolve(base, path);
    if (!actual.startsWith(base + '/'))
      throw new Error('Only files inside this task workspace can be published.');
    return storeArtifact(
      Buffer.from(await read(taskId, posix.relative(base, actual), maxFileSize, 'publication')),
      name || posix.basename(actual),
      mimeTypes[extname(actual).toLowerCase()] || 'application/octet-stream',
      taskId,
    );
  }
  async function readTaskArtifacts(taskId: string, ids: string[]): Promise<MessagingAttachment[]> {
    z.uuid().parse(taskId);
    z.array(z.uuid()).min(1).max(10).parse(ids);
    const unique = [...new Set(ids)];
    const rows = (
      await options.database.query(
        'SELECT a.id,a.name,a.mime_type,a.size,a.storage_path FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.id=ANY($1::uuid[]) AND a.owner_id=$2 AND t.owner_id=$2 AND a.task_id=$3',
        [unique, options.ownerId, taskId],
      )
    ).rows;
    if (rows.length !== unique.length) throw new Error('An attachment is unavailable.');
    const total = rows.reduce((sum, row) => sum + Number(row.size), 0);
    if (!Number.isSafeInteger(total) || total < 1 || total > maxFileSize)
      throw new Error('Attachments exceed the delivery limit.');
    const result: MessagingAttachment[] = [];
    for (const id of unique) {
      const row = rows.find((item) => item.id === id)!;
      result.push({ name: row.name, mimeType: row.mime_type, bytes: await readRow(row) });
    }
    return result;
  }
  return { storeArtifact, publishArtifact, readArtifact, readTaskArtifacts };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
export const localArtifacts = createArtifactService({
  database: pool,
  ownerId,
  localRoot: dataRoot,
});
export const { storeArtifact, publishArtifact, readTaskArtifacts } = localArtifacts;
