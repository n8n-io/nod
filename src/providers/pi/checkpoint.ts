import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrivateObjectStore } from '../../ports/object-storage.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';

const objectBytes = 15 * 1024 * 1024;
const partBytes = 8 * 1024 * 1024;
const maximum = 64 * 1024 * 1024;
const maxParts = 64;
const partId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const rebaseAt = 8 * 1024 * 1024;
export const keptImages = 4;
export const removedImage =
  'An earlier image was removed from context. Take a new screenshot or read the file again if you need it.';
const failure = () =>
  new Error(
    'The assistant session could not be saved. Stop and restore storage before continuing.',
  );

function entries(bytes: Uint8Array): FileEntry[] {
  try {
    const rows = Buffer.from(bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !rows.length ||
      rows[0]?.type !== 'session' ||
      typeof rows[0].id !== 'string' ||
      typeof rows[0].cwd !== 'string'
    )
      throw failure();
    const ids = new Set<string>();
    for (const row of rows.slice(1)) {
      if (
        !row ||
        typeof row.type !== 'string' ||
        row.type === 'session' ||
        typeof row.id !== 'string' ||
        ids.has(row.id) ||
        (row.parentId !== null && !ids.has(row.parentId))
      )
        throw failure();
      if (row.type === 'message' && (!row.message || typeof row.message.role !== 'string'))
        throw failure();
      ids.add(row.id);
    }
    return rows as FileEntry[];
  } catch {
    throw failure();
  }
}

async function readSession(store: PrivateObjectStore, threadId: string) {
  const saved = await store.read(`sessions/${threadId}.jsonl`, objectBytes);
  if (!saved) return undefined;
  let manifest: { type?: unknown; parts?: unknown } | undefined;
  try {
    manifest = JSON.parse(Buffer.from(saved.bytes).toString('utf8'));
  } catch {
    manifest = undefined;
  }
  if (manifest?.type !== 'otto_session_parts')
    return { bytes: Buffer.from(saved.bytes), version: saved.version, parts: [] as string[] };
  const parts = manifest.parts;
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > maxParts + maximum / partBytes ||
    !parts.every((part) => typeof part === 'string' && partId.test(part))
  )
    throw failure();
  const chunks = await Promise.all(
    parts.map(async (part: string) => {
      const object = await store.read(`sessions/${threadId}/${part}.jsonl`, objectBytes);
      if (!object) throw failure();
      return Buffer.from(object.bytes);
    }),
  );
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > maximum) throw failure();
  return { bytes, version: saved.version, parts: parts as string[] };
}

function chunks(rows: object[]) {
  const bytes = Buffer.from(rows.map((row) => JSON.stringify(row) + '\n').join(''));
  const result: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += partBytes)
    result.push(bytes.subarray(offset, offset + partBytes));
  return result;
}

export async function readPiSessionEntries(options: {
  threadId: string;
  sessionRoot: string;
  objectStore?: PrivateObjectStore;
}) {
  const threadId = threadIdentity(options.threadId);
  if (options.objectStore) {
    const saved = await readSession(options.objectStore, threadId);
    return saved ? entries(saved.bytes).slice(1) : [];
  }
  const directory = join(options.sessionRoot, threadId);
  const files = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const candidates = await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith('.jsonl'))
      .map(async (file) => {
        const path = join(directory, file.name);
        return { path, info: await stat(path) };
      }),
  );
  const latest = candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
  if (!latest) return [];
  if (latest.info.size > maximum) throw failure();
  return entries(await readFile(latest.path)).slice(1);
}

export function rebaseSession(source: SessionManager, next: SessionManager) {
  const context = source.buildContextEntries();
  let images = context.reduce(
    (count, entry) =>
      entry.type === 'message' && entry.message.role === 'toolResult'
        ? count + entry.message.content.filter((part) => part.type === 'image').length
        : count,
    0,
  );
  for (const entry of context) {
    if (entry.type === 'compaction')
      next.appendCompaction(entry.summary, null, entry.tokensBefore, entry.details);
    else if (entry.type === 'message') {
      const message = entry.message;
      next.appendMessage(
        (message.role === 'toolResult'
          ? {
              ...message,
              content: message.content.map((part) =>
                part.type === 'image' && images-- > keptImages
                  ? { type: 'text' as const, text: removedImage }
                  : part,
              ),
            }
          : message) as Parameters<typeof next.appendMessage>[0],
      );
    }
  }
  return next;
}

export function closeInterruptedCalls(manager: SessionManager) {
  const messages = manager.buildSessionContext().messages;
  const last = messages.findLastIndex((message) => message.role === 'assistant');
  const assistant = messages[last];
  if (assistant?.role !== 'assistant' || ['aborted', 'error'].includes(assistant.stopReason))
    return;
  const answered = new Set(
    messages
      .slice(last + 1)
      .flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : [])),
  );
  for (const call of assistant.content) {
    if (call.type !== 'toolCall' || answered.has(call.id)) continue;
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [
        {
          type: 'text',
          text: 'This action was interrupted. Its outcome is unknown; check before doing it again.',
        },
      ],
      details: {},
      isError: true,
      timestamp: Date.now(),
    });
  }
}

export async function createPiCheckpoint(options: {
  store: PrivateObjectStore;
  threadId: string;
  directory: string;
}) {
  const { store, threadId } = options;
  const key = `sessions/${threadId}.jsonl`;
  const saved = await readSession(store, threadId);
  let manager = SessionManager.inMemory(
    options.directory,
    undefined,
    saved ? entries(saved.bytes) : undefined,
  );
  let parts = saved?.parts ?? [];
  let stored = saved?.bytes.byteLength ?? 0;
  if (stored > rebaseAt) {
    manager = rebaseSession(manager, SessionManager.inMemory(options.directory));
    parts = [];
  }
  let persisted = parts.length ? manager.getEntries().length : 0;
  closeInterruptedCalls(manager);
  let version = saved?.version ?? null;
  let failed = false;
  let tail = Promise.resolve();
  function checkpoint() {
    const next = tail.then(async () => {
      if (failed) throw failure();
      const written: string[] = [];
      try {
        const all = manager.getEntries();
        const fresh = !parts.length || parts.length >= maxParts;
        const rows = fresh ? [{ ...manager.getHeader() }, ...all] : all.slice(persisted);
        let size = fresh ? 0 : stored;
        for (const bytes of chunks(rows)) {
          size += bytes.byteLength;
          if (size > maximum) throw failure();
          const id = randomUUID();
          written.push(id);
          await store.write(`sessions/${threadId}/${id}.jsonl`, bytes, { expectedVersion: null });
        }
        const nextParts = fresh ? written : [...parts, ...written];
        version = await store.write(
          key,
          Buffer.from(
            JSON.stringify({
              type: 'otto_session_parts',
              revision: randomUUID(),
              parts: nextParts,
            }),
          ),
          { expectedVersion: version },
        );
        if (fresh)
          for (const old of parts)
            void store.remove(`sessions/${threadId}/${old}.jsonl`).catch(() => {});
        parts = nextParts;
        persisted = all.length;
        stored = size;
      } catch {
        failed = true;
        for (const id of written)
          void store.remove(`sessions/${threadId}/${id}.jsonl`).catch(() => {});
        throw failure();
      }
    });
    tail = next.catch(() => {});
    return next;
  }
  await checkpoint();
  return { manager, checkpoint };
}
