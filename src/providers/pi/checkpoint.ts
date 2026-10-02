import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrivateObjectStore } from '../../ports/object-storage.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';

const maximum = 15 * 1024 * 1024;
export const rebaseAt = 8 * 1024 * 1024;
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

export async function readPiSessionEntries(options: {
  threadId: string;
  sessionRoot: string;
  objectStore?: PrivateObjectStore;
}) {
  const threadId = threadIdentity(options.threadId);
  if (options.objectStore) {
    const saved = await options.objectStore.read(`sessions/${threadId}.jsonl`, maximum);
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
  for (const entry of source.buildContextEntries()) {
    if (entry.type === 'compaction')
      next.appendCompaction(entry.summary, null, entry.tokensBefore, entry.details);
    else if (entry.type === 'message')
      next.appendMessage(entry.message as Parameters<typeof next.appendMessage>[0]);
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
  const key = `sessions/${options.threadId}.jsonl`;
  const saved = await options.store.read(key, maximum);
  let manager = SessionManager.inMemory(
    options.directory,
    undefined,
    saved ? entries(saved.bytes) : undefined,
  );
  if ((saved?.bytes.byteLength ?? 0) > rebaseAt)
    manager = rebaseSession(manager, SessionManager.inMemory(options.directory));
  closeInterruptedCalls(manager);
  let version = saved?.version ?? null;
  let failed = false;
  let tail = Promise.resolve();
  function checkpoint() {
    const next = tail.then(async () => {
      if (failed) throw failure();
      try {
        const bytes = Buffer.from(
          [{ ...manager.getHeader(), ottoRevision: randomUUID() }, ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join('\n') + '\n',
        );
        if (bytes.byteLength > maximum) throw failure();
        version = await options.store.write(key, bytes, { expectedVersion: version });
      } catch {
        failed = true;
        throw failure();
      }
    });
    tail = next.catch(() => {});
    return next;
  }
  await checkpoint();
  return { manager, checkpoint };
}
