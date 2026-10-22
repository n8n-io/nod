import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import { pool } from './db.ts';
import { dataRoot, ownerId } from './config.ts';
import type { Artifact } from '../shared/contracts.ts';
import { fileBytes, fileName } from '../shared/files.ts';
import type { MessagingAttachment } from '../ports/messaging.ts';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';

const mimeTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.vcf': 'text/vcard',
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
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
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
  localRoot: string;
}) {
  if (!options.ownerId) throw new Error('Private file storage is unavailable.');
  const location = (id: string) => join(options.localRoot, 'artifacts', id);
  function checkRow(row: Record<string, any>) {
    z.uuid().parse(row.id);
    if (
      row.storage_path !== location(row.id) ||
      !Number.isInteger(row.size) ||
      row.size < 1 ||
      row.size > fileBytes
    )
      throw new Error('An attachment is unavailable.');
  }
  async function readRow(row: Record<string, any>) {
    checkRow(row);
    return readLocal(location(row.id), row.size);
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
    threadId?: string,
    database: Pick<PoolClient, 'query'> = options.database,
    onCreated?: (cleanup: () => Promise<void>) => void,
  ): Promise<Artifact> {
    if (!bytes.length || bytes.length > fileBytes)
      throw Object.assign(
        new Error(`Files must be between 1 byte and ${fileBytes / 1024 / 1024} MB.`),
        { statusCode: 400 },
      );
    if (
      threadId &&
      !(
        await database.query('SELECT id FROM threads WHERE id=$1 AND owner_id=$2', [
          z.uuid().parse(threadId),
          options.ownerId,
        ])
      ).rowCount
    )
      throw new Error('The conversation is unavailable.');
    const id = randomUUID();
    await mkdir(join(options.localRoot, 'artifacts'), { recursive: true, mode: 0o700 });
    await writeFile(location(id), bytes, { mode: 0o600, flag: 'wx' });
    const safeName = fileName(basename(name).replace(/[\r\n\x00-\x1f]/g, '')) || 'file';
    try {
      const result = await database.query(
        'INSERT INTO artifacts(id,owner_id,thread_id,name,mime_type,size,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [id, options.ownerId, threadId || null, safeName, mimeType, bytes.length, location(id)],
      );
      onCreated?.(async () => {
        const stored = await options.database.query(
          'SELECT 1 FROM artifacts WHERE id=$1 AND owner_id=$2',
          [id, options.ownerId],
        );
        if (!stored.rowCount) await rm(location(id), { force: true });
      });
      return artifactView(result.rows[0]);
    } catch (error) {
      await rm(location(id), { force: true }).catch(() => {});
      throw error;
    }
  }
  async function publishArtifact(
    threadId: string,
    path: string,
    name: string | undefined,
    read: (
      threadId: string,
      path: string,
      maxBytes: number,
      purpose?: 'attachment' | 'publication',
    ) => Promise<Uint8Array>,
    database: Pick<PoolClient, 'query'> = options.database,
  ) {
    z.uuid().parse(threadId);
    if (!path || path.length > 4096 || path.includes('\0') || path.includes('\\'))
      throw new Error('A workspace file path is required.');
    const base = `/workspace/${threadId}`;
    const actual = posix.resolve(base, path);
    if (!actual.startsWith(base + '/'))
      throw new Error('Only files inside this workspace can be published.');
    const file = posix.basename(actual);
    const suffix = /\.(?:n8n\.json|tar\.gz)$/i.exec(file)?.[0] ?? extname(file);
    return storeArtifact(
      Buffer.from(await read(threadId, posix.relative(base, actual), fileBytes, 'publication')),
      name && !name.toLowerCase().endsWith(suffix.toLowerCase())
        ? `${name}${suffix}`
        : name || file,
      mimeTypes[extname(actual).toLowerCase()] || 'application/octet-stream',
      threadId,
      database,
    );
  }
  async function readThreadArtifacts(
    threadId: string,
    ids: string[],
  ): Promise<MessagingAttachment[]> {
    z.uuid().parse(threadId);
    z.array(z.uuid()).min(1).parse(ids);
    const unique = [...new Set(ids)];
    const rows = (
      await options.database.query(
        'SELECT a.id,a.name,a.mime_type,a.size,a.storage_path FROM artifacts a JOIN threads th ON th.id=a.thread_id WHERE a.id=ANY($1::uuid[]) AND a.owner_id=$2 AND th.owner_id=$2 AND a.thread_id=$3',
        [unique, options.ownerId, threadId],
      )
    ).rows;
    if (rows.length !== unique.length) throw new Error('An attachment is unavailable.');
    return unique.map((id) => {
      const row = rows.find((item) => item.id === id)!;
      checkRow(row);
      return {
        name: row.name,
        mimeType: row.mime_type,
        size: row.size,
        read: () => readRow(row),
      };
    });
  }
  return { storeArtifact, publishArtifact, readArtifact, readThreadArtifacts };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
export const localArtifacts = createArtifactService({
  database: pool,
  ownerId,
  localRoot: dataRoot,
});
export const { storeArtifact, publishArtifact, readThreadArtifacts } = localArtifacts;
