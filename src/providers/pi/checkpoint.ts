import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
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
export const removedCredential =
  'An earlier saved login was removed from context. Use sign_in if you need to sign in again.';
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
  let manifest: { type?: unknown; parts?: unknown; obsolete?: unknown } | undefined;
  try {
    manifest = JSON.parse(Buffer.from(saved.bytes).toString('utf8'));
  } catch {
    manifest = undefined;
  }
  if (manifest?.type !== 'otto_session_parts')
    return {
      bytes: Buffer.from(saved.bytes),
      version: saved.version,
      parts: [] as string[],
      obsolete: [] as string[],
    };
  const parts = manifest.parts;
  const obsolete = manifest.obsolete ?? [];
  if (
    !Array.isArray(parts) ||
    !parts.length ||
    parts.length > maxParts + maximum / partBytes ||
    !parts.every((part) => typeof part === 'string' && partId.test(part)) ||
    !Array.isArray(obsolete) ||
    obsolete.length > maxParts + maximum / partBytes ||
    !obsolete.every(
      (part) => typeof part === 'string' && partId.test(part) && !parts.includes(part),
    )
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
  return {
    bytes,
    version: saved.version,
    parts: parts as string[],
    obsolete: obsolete as string[],
  };
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

function legacyCredential(message: { role: string; toolName?: string; content?: unknown }) {
  return (
    message.role === 'toolResult' &&
    message.toolName === 'get_credential' &&
    JSON.stringify(message.content) !== JSON.stringify([{ type: 'text', text: removedCredential }])
  );
}

function holdsCredentials(manager: SessionManager) {
  return manager
    .getEntries()
    .some((entry) => entry.type === 'message' && legacyCredential(entry.message));
}

function legacySecrets(context: ReturnType<SessionManager['getEntries']>) {
  const values = new Set<string>();
  for (const entry of context)
    if (entry.type === 'message' && legacyCredential(entry.message))
      for (const part of entry.message.role === 'toolResult' ? entry.message.content : [])
        if (part.type === 'text')
          try {
            const credential = JSON.parse(part.text);
            for (const value of [credential?.username, credential?.password])
              if (typeof value === 'string' && value.length) {
                values.add(value);
                values.add(JSON.stringify(value).slice(1, -1));
              }
          } catch {}
  return [...values].sort((a, b) => b.length - a.length);
}

function scrub<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  if (typeof value === 'string')
    return secrets.reduce((text, secret) => text.split(secret).join('[removed]'), value) as T;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]),
    ) as T;
  return value;
}

function withoutOldImages<
  T extends { type: string; message?: { role: string; content?: unknown } },
>(rows: T[]): T[] {
  const parts = (row: T) =>
    row.type === 'message' &&
    row.message?.role === 'toolResult' &&
    Array.isArray(row.message.content)
      ? (row.message.content as Array<{ type: string }>)
      : [];
  let count = rows.reduce(
    (total, row) => total + parts(row).filter((part) => part.type === 'image').length,
    0,
  );
  return rows.map((row) =>
    parts(row).some((part) => part.type === 'image')
      ? {
          ...row,
          message: {
            ...row.message,
            content: parts(row).map((part) =>
              part.type === 'image' && count-- > keptImages
                ? { type: 'text', text: removedImage }
                : part,
            ),
          },
        }
      : row,
  );
}

export function openLocalSession(directory: string) {
  let manager = SessionManager.continueRecent(directory, directory);
  const file = manager.getSessionFile();
  if (!file || !existsSync(file)) return manager;
  const retained = readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(directory, name))
    .filter((path) => path !== file && statSync(path).isFile());
  const secrets = [
    ...new Set(
      [
        legacySecrets(manager.getEntries()),
        ...retained.map((path) => {
          if (statSync(path).size > maximum) throw failure();
          return legacySecrets(SessionManager.open(path).getEntries());
        }),
      ].flat(),
    ),
  ].sort((a, b) => b.length - a.length);
  const legacy = holdsCredentials(manager) || secrets.length > 0;
  if (!legacy && statSync(file).size <= rebaseAt) return manager;
  manager = rebaseSession(manager, SessionManager.create(directory, directory), secrets);
  const current = manager.getSessionFile();
  if (legacy && current && existsSync(current))
    for (const name of readdirSync(directory))
      if (name.endsWith('.jsonl') && join(directory, name) !== current)
        rmSync(join(directory, name), { force: true });
  return manager;
}

export function rebaseSession(
  source: SessionManager,
  next: SessionManager,
  secrets = legacySecrets(source.getEntries()),
) {
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
      next.appendCompaction(
        scrub(entry.summary, secrets),
        null,
        entry.tokensBefore,
        scrub(entry.details, secrets),
      );
    else if (entry.type === 'message') {
      const message = entry.message;
      next.appendMessage(
        (legacyCredential(message)
          ? { ...message, content: [{ type: 'text' as const, text: removedCredential }] }
          : {
              ...message,
              ...('details' in message ? { details: scrub(message.details, secrets) } : {}),
              ...(message.role === 'bashExecution'
                ? {
                    command: scrub(message.command, secrets),
                    output: scrub(message.output, secrets),
                  }
                : {}),
              ...('content' in message
                ? {
                    content:
                      typeof message.content === 'string'
                        ? scrub(message.content, secrets)
                        : message.content.map((part) =>
                            part.type === 'text'
                              ? { ...part, text: scrub(part.text, secrets) }
                              : part.type === 'thinking'
                                ? { ...part, thinking: scrub(part.thinking, secrets) }
                                : part.type === 'toolCall'
                                  ? { ...part, arguments: scrub(part.arguments, secrets) }
                                  : part.type === 'image' &&
                                      message.role === 'toolResult' &&
                                      images-- > keptImages
                                    ? { type: 'text' as const, text: removedImage }
                                    : part,
                          ),
                  }
                : {}),
            }) as Parameters<typeof next.appendMessage>[0],
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
  let obsolete = saved?.obsolete ?? [];
  let stored = saved?.bytes.byteLength ?? 0;
  let rewrite = stored > rebaseAt || holdsCredentials(manager);
  if (rewrite) manager = rebaseSession(manager, SessionManager.inMemory(options.directory));
  let persisted = parts.length && !rewrite ? manager.getEntries().length : 0;
  closeInterruptedCalls(manager);
  let version = saved?.version ?? null;
  let failed = false;
  let tail = Promise.resolve();
  async function cleanup() {
    if (!obsolete.length) return;
    await Promise.all(obsolete.map((old) => store.remove(`sessions/${threadId}/${old}.jsonl`)));
    obsolete = [];
  }
  function checkpoint() {
    const next = tail.then(async () => {
      if (failed) throw failure();
      const written: string[] = [];
      try {
        await cleanup();
        const all = manager.getEntries();
        let fresh = rewrite || !parts.length || parts.length >= maxParts;
        let output = chunks(fresh ? [] : all.slice(persisted));
        if (!fresh && output.reduce((total, part) => total + part.byteLength, stored) > maximum)
          fresh = true;
        if (fresh) output = chunks([{ ...manager.getHeader() }, ...withoutOldImages(all)]);
        let size = fresh ? 0 : stored;
        for (const bytes of output) {
          size += bytes.byteLength;
          if (size > maximum) throw failure();
          const id = randomUUID();
          written.push(id);
          await store.write(`sessions/${threadId}/${id}.jsonl`, bytes, { expectedVersion: null });
        }
        const nextParts = fresh ? written : [...parts, ...written];
        const nextObsolete = fresh ? [...new Set([...obsolete, ...parts])] : obsolete;
        version = await store.write(
          key,
          Buffer.from(
            JSON.stringify({
              type: 'otto_session_parts',
              revision: randomUUID(),
              parts: nextParts,
              obsolete: nextObsolete,
            }),
          ),
          { expectedVersion: version },
        );
        obsolete = nextObsolete;
        parts = nextParts;
        rewrite = false;
        persisted = all.length;
        stored = size;
        await cleanup();
      } catch {
        try {
          const published = await readSession(store, threadId);
          if (published) entries(published.bytes);
          await Promise.all(
            written
              .filter((id) => !published?.parts.includes(id))
              .map((id) => store.remove(`sessions/${threadId}/${id}.jsonl`)),
          );
        } catch {}
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
