import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { audioEntries } from './audio.ts';

const maximum = 64 * 1024 * 1024;
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

export async function readPiSessionEntries(options: { threadId: string; sessionRoot: string }) {
  const directory = join(options.sessionRoot, threadIdentity(options.threadId));
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
  const audio = audioEntries(source);
  const recordings = new Map(audio.map((entry) => [entry.id, entry]));
  const projected = new Map(
    source.buildSessionProjection().entries.map((entry) => [entry.sourceEntry.id, entry.messages]),
  );
  const current = new Set(context.map((entry) => entry.id));
  const copyRecording = (entry: (typeof audio)[number]) =>
    next.appendCustomMessageEntry(
      entry.customType,
      scrub(entry.content, secrets),
      entry.display,
      scrub(entry.details, secrets),
    );
  for (const entry of audio.slice(-2)) if (!current.has(entry.id)) copyRecording(entry);
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
    else if (entry.type === 'custom_message' && recordings.has(entry.id))
      copyRecording(recordings.get(entry.id)!);
    else if (entry.type === 'custom_message' && entry.customType === 'nod-audio-input') {
      for (const message of projected.get(entry.id) ?? [])
        if (message.role === 'custom')
          next.appendMessage({
            role: 'user',
            content: scrub(message.content, secrets),
            timestamp: message.timestamp,
          });
    } else if (entry.type === 'message') {
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
