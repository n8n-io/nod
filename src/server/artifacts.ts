import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dir } from 'node:fs';
import { lstat, mkdir, open, opendir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, resolve } from 'node:path';
import { pool } from './db.ts';
import { dataRoot, ownerId } from './config.ts';
import { transaction } from './transaction.ts';
import type { Artifact, Page, PageVersion } from '../shared/contracts.ts';
import { fileBytes, fileMimeType, fileName } from '../shared/files.ts';
import { pageType, pageTypes, type PageSort, type PageType } from '../shared/attachment-kind.ts';
import type { MessagingAttachment } from '../ports/messaging.ts';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const replyParser = unified().use(remarkParse);

export function replyFileReferences(text: string) {
  if (!text.includes('/workspace/')) return [];
  const nodes = [...replyParser.parse(text).children];
  const references: Array<{ path: string; start: number; end: number }> = [];
  for (const node of nodes) {
    const value =
      node.type === 'inlineCode'
        ? node.value
        : node.type === 'link' || node.type === 'image'
          ? node.url
          : undefined;
    if (value !== undefined) {
      let path = value.replace(/^sandbox:/, '');
      if (!path.startsWith('/workspace/') || path.endsWith('/')) continue;
      if (node.type === 'inlineCode' && !/^\/workspace\/[^/]+\/.+/.test(path)) continue;
      if (node.type !== 'inlineCode') {
        try {
          path = decodeURIComponent(path.replace(/%(?![\da-f]{2})/gi, '%25'));
        } catch {}
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        references.push({
          path,
          start,
          end,
        });
    } else if ('children' in node) nodes.push(...node.children);
  }
  return references.sort((a, b) => a.start - b.start);
}

export function artifactView(row: Record<string, any>): Artifact {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    url: `/api/artifacts/${row.id}`,
    ...(row.page_id
      ? {
          page: {
            id: row.page_id,
            version: row.page_version,
            title: row.page_title ?? row.name,
            type: storedType(row.page_type),
          },
        }
      : {}),
  };
}
function pageVersion(row: Record<string, any>): PageVersion {
  return {
    version: row.page_version,
    createdAt: new Date(row.created_at).toISOString(),
    artifact: artifactView(row),
  };
}
function storedName(name: string) {
  return fileName(basename(name).replace(/[\r\n\x00-\x1f]/g, '')) || 'file';
}
function storedType(value: unknown): PageType {
  return pageTypes.find((type) => type === value) ?? 'docs';
}
function pageTitle(bytes: Buffer, fallback: string, html: boolean) {
  const title = html
    ? /<title[^>]*>([^<]{1,300})<\/title>/i
        .exec(bytes.subarray(0, 8192).toString('utf8'))?.[1]
        ?.replace(/\s+/g, ' ')
        .trim()
    : '';
  return (
    title ||
    storedName(fallback).replace(/(?:\.n8n\.json|\.tar\.gz|\.[a-z0-9]{1,10})$/i, '') ||
    storedName(fallback)
  ).slice(0, 200);
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
  const root = resolve(options.localRoot);
  const legacyDirectory = join(root, 'artifacts');
  const directory = join(
    legacyDirectory,
    createHash('sha256').update(options.ownerId).digest('hex'),
  );
  const location = (id: string) => join(directory, id);
  const unavailable = () =>
    Object.assign(new Error('An attachment is unavailable.'), { statusCode: 400 });
  let cursor: Dir | undefined;
  let sweeping: Promise<{ removed: number; orphans: number; failed: number }> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  const transact = <T>(action: (client: Pick<PoolClient, 'query'>) => Promise<T>) =>
    transaction(action, options.database);
  async function checkDirectory(path: string, create = false) {
    for (const parent of [root, legacyDirectory, ...(path === directory ? [directory] : [])]) {
      if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
      if (!(await lstat(parent)).isDirectory()) throw unavailable();
    }
  }
  function storagePath(row: Record<string, any>) {
    if (
      !z.uuid().safeParse(row.id).success ||
      (row.storage_path !== location(row.id) &&
        row.storage_path !== join(legacyDirectory, row.id)) ||
      !Number.isInteger(row.size) ||
      row.size < 1 ||
      row.size > fileBytes
    )
      throw unavailable();
    return row.storage_path as string;
  }
  function checkRow(row: Record<string, any>) {
    if (row.deleting_at) throw unavailable();
    return storagePath(row);
  }
  async function checkFile(row: Record<string, any>) {
    try {
      const path = checkRow(row);
      await checkDirectory(dirname(path));
      const file = await lstat(path);
      if (!file.isFile() || file.size !== row.size) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  function ownedIds(ids: string[], maximum?: number) {
    const parsed = z.array(z.uuid()).safeParse(ids);
    if (!parsed.success || (maximum !== undefined && ids.length > maximum)) throw unavailable();
    return [...new Set(parsed.data.map((id) => id.toLowerCase()))].sort();
  }
  async function readRow(row: Record<string, any>) {
    const path = checkRow(row);
    await checkDirectory(dirname(path));
    return readLocal(path, row.size);
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
    database?: Pick<PoolClient, 'query'>,
    onCreated?: (cleanup: () => Promise<void>) => void,
    temporary = false,
    page?: { id: string; version: number; title: string; sourcePath: string; type: PageType },
  ): Promise<Artifact> {
    if (!bytes.length || bytes.length > fileBytes)
      throw Object.assign(
        new Error(`Files must be between 1 byte and ${fileBytes / 1024 / 1024} MB.`),
        { statusCode: 400 },
      );
    const id = randomUUID();
    const safeName = storedName(name);
    const store = async (client: Pick<PoolClient, 'query'>) => {
      if (
        threadId &&
        !(
          await client.query('SELECT id FROM threads WHERE id=$1 AND owner_id=$2', [
            z.uuid().parse(threadId),
            options.ownerId,
          ])
        ).rowCount
      )
        throw new Error('The conversation is unavailable.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `artifact:${options.ownerId}:${id}`,
      ]);
      await checkDirectory(directory, true);
      try {
        await writeFile(location(id), bytes, { mode: 0o600, flag: 'wx' });
        const result = await client.query(
          `INSERT INTO artifacts(id,owner_id,thread_id,name,mime_type,size,storage_path,expires_at,page_id,page_version,page_title,source_path,page_type)
           VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN clock_timestamp()+interval '24 hours' END,$9,$10,$11,$12,$13) RETURNING *`,
          [
            id,
            options.ownerId,
            threadId || null,
            safeName,
            mimeType,
            bytes.length,
            location(id),
            temporary,
            page?.id ?? null,
            page?.version ?? null,
            page?.title ?? null,
            page?.sourcePath ?? null,
            page?.type ?? null,
          ],
        );
        onCreated?.(async () => {
          const stored = await options.database.query(
            'SELECT 1 FROM artifacts WHERE id=$1 AND owner_id=$2',
            [id, options.ownerId],
          );
          if (!stored.rowCount)
            await unlink(location(id)).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            });
        });
        return artifactView(result.rows[0]);
      } catch (error) {
        await unlink(location(id)).catch(() => {});
        throw error;
      }
    };
    return database ? store(database) : transact(store);
  }
  function storeUpload(bytes: Buffer, name: string, mimeType: string) {
    return storeArtifact(bytes, name, mimeType, undefined, undefined, undefined, true);
  }
  async function renewUploads(ids: string[]) {
    const unique = ownedIds(ids, 100);
    if (!unique.length) return [];
    return transact(async (client) => {
      const rows = (
        await client.query(
          'SELECT * FROM artifacts WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND deleting_at IS NULL ORDER BY id FOR UPDATE',
          [options.ownerId, unique],
        )
      ).rows;
      const available = [];
      for (const row of rows) {
        try {
          await checkFile(row);
          available.push(row);
        } catch {}
      }
      await client.query(
        "UPDATE artifacts SET expires_at=clock_timestamp()+interval '24 hours' WHERE owner_id=$1 AND id=ANY($2::uuid[]) AND expires_at IS NOT NULL AND deleting_at IS NULL",
        [options.ownerId, available.map((row) => row.id)],
      );
      return available.map(artifactView);
    });
  }
  async function retainArtifacts(ids: string[], client: Pick<PoolClient, 'query'>) {
    const unique = ownedIds(ids);
    if (!unique.length) return;
    const rows = (
      await client.query(
        'SELECT * FROM artifacts WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [options.ownerId, unique],
      )
    ).rows;
    if (rows.length !== unique.length) throw unavailable();
    for (const row of rows) await checkFile(row);
    await client.query(
      'UPDATE artifacts SET expires_at=NULL WHERE owner_id=$1 AND id=ANY($2::uuid[])',
      [options.ownerId, unique],
    );
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
    database?: Pick<PoolClient, 'query'>,
    onCreated?: (cleanup: () => Promise<void>) => void,
    page?: string,
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
    const mimeType = fileMimeType(actual);
    const type = pageType(mimeType, file);
    if (page !== undefined && !type) throw new Error('This file cannot update a page.');
    const bytes = Buffer.from(
      await read(threadId, posix.relative(base, actual), fileBytes, 'publication'),
    );
    const label =
      name && !name.toLowerCase().endsWith(suffix.toLowerCase())
        ? `${name}${suffix}`
        : name || file;
    if (!type) return storeArtifact(bytes, label, mimeType, threadId, database, onCreated);
    const publish = async (client: Pick<PoolClient, 'query'>) => {
      let pageId = page === undefined ? undefined : z.uuid().parse(page).toLowerCase();
      if (pageId) {
        const known = await client.query(
          'SELECT 1 FROM artifacts WHERE owner_id=$1 AND page_id=$2 AND deleting_at IS NULL LIMIT 1',
          [options.ownerId, pageId],
        );
        if (!known.rowCount) throw new Error('The page is unavailable.');
      } else
        pageId =
          (
            await client.query(
              `SELECT page_id FROM artifacts WHERE owner_id=$1 AND thread_id=$2 AND source_path=$3
               AND page_id IS NOT NULL AND deleting_at IS NULL ORDER BY created_at DESC,page_version DESC LIMIT 1`,
              [options.ownerId, threadId, actual],
            )
          ).rows[0]?.page_id ?? randomUUID();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `page:${options.ownerId}:${pageId}`,
      ]);
      const latest = (
        await client.query(
          'SELECT * FROM artifacts WHERE owner_id=$1 AND page_id=$2 AND deleting_at IS NULL ORDER BY page_version DESC LIMIT 1',
          [options.ownerId, pageId],
        )
      ).rows[0];
      if (!latest && page !== undefined) throw new Error('The page is unavailable.');
      if (latest && storedType(latest.page_type) !== type)
        throw new Error(
          `This page is kept under ${storedType(latest.page_type)}, so a ${type} file cannot replace it.`,
        );
      if (
        !latest &&
        (
          await client.query('SELECT 1 FROM artifacts WHERE owner_id=$1 AND page_id=$2 LIMIT 1', [
            options.ownerId,
            pageId,
          ])
        ).rowCount
      )
        pageId = randomUUID();
      if (
        latest &&
        latest.thread_id === threadId &&
        latest.size === bytes.length &&
        (await readRow(latest)).equals(bytes)
      )
        return artifactView(latest);
      return storeArtifact(bytes, label, mimeType, threadId, client, onCreated, false, {
        id: pageId!,
        version: (latest?.page_version ?? 0) + 1,
        title: pageTitle(bytes, label, mimeType === 'text/html'),
        sourcePath: actual,
        type,
      });
    };
    return database ? publish(database) : transact(publish);
  }
  async function listPages(
    before?: string,
    query?: string,
    limit = 50,
    type?: PageType,
    sort: PageSort = 'newest',
  ): Promise<{ pages: Page[]; next?: string }> {
    const split = before?.lastIndexOf('_') ?? -1;
    const key =
      sort === 'title'
        ? 'lower(COALESCE(page_title,name))'
        : "date_trunc('milliseconds',created_at)";
    const direction = sort === 'newest' ? 'DESC' : 'ASC';
    const rows = (
      await options.database.query(
        `SELECT *,${key} AS sort_key FROM (SELECT DISTINCT ON (page_id) * FROM artifacts
           WHERE owner_id=$1 AND page_id IS NOT NULL AND deleting_at IS NULL
           ORDER BY page_id,page_version DESC) latest
         WHERE ($2::text IS NULL OR (${key},page_id)${sort === 'newest' ? '<' : '>'}($2::${sort === 'title' ? 'text' : 'timestamptz'},$5::uuid))
           AND ($4::text IS NULL OR strpos(lower(COALESCE(page_title,name)),lower($4))>0)
           AND ($6::text IS NULL OR COALESCE(page_type,'docs')=$6)
         ORDER BY ${key} ${direction},page_id ${direction} LIMIT $3`,
        [
          options.ownerId,
          before ? before.slice(0, split) : null,
          limit + 1,
          query ?? null,
          before ? before.slice(split + 1) : null,
          type ?? null,
        ],
      )
    ).rows;
    const shown = rows.slice(0, limit);
    const last = shown.at(-1);
    return {
      pages: shown.map((row) => ({
        id: row.page_id,
        title: row.page_title ?? row.name,
        type: storedType(row.page_type),
        ...pageVersion(row),
      })),
      ...(rows.length > limit && last
        ? {
            next: `${sort === 'title' ? last.sort_key : pageVersion(last).createdAt}_${last.page_id}`,
          }
        : {}),
    };
  }
  async function readPage(id: string): Promise<PageVersion[]> {
    return (
      await options.database.query(
        `SELECT * FROM artifacts WHERE owner_id=$1 AND page_id=$2 AND deleting_at IS NULL
         ORDER BY page_version DESC`,
        [options.ownerId, z.uuid().parse(id)],
      )
    ).rows.map(pageVersion);
  }
  async function deletePage(id: string) {
    const pageId = z.uuid().parse(id).toLowerCase();
    const removed = await transact(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `page:${options.ownerId}:${pageId}`,
      ]);
      const ids: string[] = (
        await client.query(
          `UPDATE artifacts SET deleting_at=clock_timestamp(),thread_id=NULL
           WHERE owner_id=$1 AND page_id=$2 AND deleting_at IS NULL RETURNING id`,
          [options.ownerId, pageId],
        )
      ).rows.map((row) => row.id);
      if (ids.length)
        await client.query(
          `UPDATE messages SET attachments=COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(attachments) item
             WHERE NOT (item->>'id'=ANY($2::text[]))),'[]'::jsonb)
           WHERE owner_id=$1 AND attachments @> ANY($3::jsonb[])`,
          [options.ownerId, ids, ids.map((item) => JSON.stringify([{ id: item }]))],
        );
      return ids.length;
    });
    if (removed) await sweep();
    return removed;
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
        'SELECT a.id,a.name,a.mime_type,a.size,a.storage_path,a.deleting_at FROM artifacts a JOIN threads th ON th.id=a.thread_id WHERE a.id=ANY($1::uuid[]) AND a.owner_id=$2 AND th.owner_id=$2 AND a.thread_id=$3',
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
  async function closeCursor() {
    const current = cursor;
    cursor = undefined;
    await current?.close();
  }
  async function sweep() {
    if (closed) return { removed: 0, orphans: 0, failed: 0 };
    if (sweeping) return sweeping;
    sweeping = collect().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  }
  async function collect() {
    const counts = { removed: 0, orphans: 0, failed: 0 };
    const eligible = `a.owner_id=$1 AND a.thread_id IS NULL
      AND (a.deleting_at IS NOT NULL OR a.expires_at<=clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.owner_id=$1
        AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text)))`;
    try {
      const candidates = (
        await options.database.query(
          `SELECT a.id FROM artifacts a WHERE ${eligible} ORDER BY COALESCE(a.deleting_at,a.expires_at),a.id LIMIT 100`,
          [options.ownerId],
        )
      ).rows;
      const deadline = Date.now() + 500;
      for (const { id } of candidates) {
        if (closed || Date.now() >= deadline) break;
        try {
          const row = await transact(async (client) => {
            const row = (
              await client.query(
                `SELECT a.* FROM artifacts a WHERE ${eligible} AND a.id=$2 FOR UPDATE SKIP LOCKED`,
                [options.ownerId, id],
              )
            ).rows[0];
            if (!row) return;
            await client.query(
              'UPDATE artifacts SET deleting_at=clock_timestamp() WHERE owner_id=$1 AND id=$2',
              [options.ownerId, id],
            );
            return row;
          });
          if (!row) continue;
          const path = storagePath(row);
          try {
            await checkDirectory(dirname(path));
            if (!(await lstat(path)).isFile()) throw unavailable();
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          const removed = await options.database.query(
            'DELETE FROM artifacts WHERE owner_id=$1 AND id=$2 AND deleting_at IS NOT NULL',
            [options.ownerId, id],
          );
          counts.removed += removed.rowCount ?? 0;
        } catch {
          counts.failed++;
        }
      }
    } catch {
      counts.failed++;
    }
    try {
      await checkDirectory(directory);
      cursor ??= await opendir(directory);
      const deadline = Date.now() + 500;
      for (let inspected = 0; inspected < 100 && Date.now() < deadline && !closed; inspected++) {
        const entry = await cursor.read();
        if (!entry) {
          await closeCursor();
          break;
        }
        if (
          !entry.isFile() ||
          !z.uuid().safeParse(entry.name).success ||
          entry.name !== entry.name.toLowerCase()
        )
          continue;
        try {
          const path = location(entry.name);
          const info = await lstat(path);
          if (!info.isFile() || info.mtimeMs > Date.now() - 24 * 60 * 60 * 1000) continue;
          await transact(async (client) => {
            const locked = await client.query(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
              [`artifact:${options.ownerId}:${entry.name}`],
            );
            if (!locked.rows[0].locked) return;
            if (
              (
                await client.query('SELECT 1 FROM artifacts WHERE owner_id=$1 AND id=$2', [
                  options.ownerId,
                  entry.name,
                ])
              ).rowCount
            )
              return;
            const current = await lstat(path);
            if (!current.isFile() || current.mtimeMs > Date.now() - 24 * 60 * 60 * 1000) return;
            await unlink(path);
            counts.orphans++;
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') counts.failed++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') counts.failed++;
      await closeCursor().catch(() => {});
    }
    return counts;
  }
  function close() {
    closed = true;
    closing ??= (async () => {
      try {
        await sweeping;
      } finally {
        await closeCursor();
      }
    })();
    return closing;
  }
  return {
    storeArtifact,
    storeUpload,
    publishArtifact,
    listPages,
    readPage,
    deletePage,
    readArtifact,
    readThreadArtifacts,
    renewUploads,
    retainArtifacts,
    sweep,
    close,
  };
}

export type ArtifactService = ReturnType<typeof createArtifactService>;
export const localArtifacts = createArtifactService({
  database: pool,
  ownerId,
  localRoot: dataRoot,
});
