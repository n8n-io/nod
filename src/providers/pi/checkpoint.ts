import {
  SessionManager,
  buildSessionProjection,
  estimateTokens,
  type FileEntry,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { audioEntries } from './audio.ts';

const maximum = 64 * 1024 * 1024;
const rebaseAt = 8 * 1024 * 1024;
export const keptImages = 4;
export const removedImage =
  'An earlier image was removed from context. Take a new screenshot or read the file again if you need it.';
const requestEntry = 'nod-request';

export function voiceHistory(
  messages: ReturnType<SessionManager['buildSessionContext']>['messages'],
  openedAt: number,
) {
  const current = messages.findIndex(
    (message) => message.role === 'user' && message.timestamp >= openedAt,
  );
  if (current < 1) return messages;
  let tokens = 0;
  let from = current;
  for (let index = current - 1; index >= 0; index--) {
    const message = messages[index]!;
    tokens += estimateTokens(message);
    if (tokens <= 4_000 && message.role === 'user') from = index;
    if (tokens > 12_000) return messages.slice(from);
  }
  return messages;
}

export function requestStart(manager: SessionManager) {
  const entry = manager
    .getBranch()
    .findLast((entry) => entry.type === 'custom' && entry.customType === requestEntry);
  return entry?.type === 'custom' ? (entry.data as { at: number }).at : 0;
}

export function startRequest(manager: SessionManager) {
  manager.appendCustomEntry(requestEntry, { at: Date.now() });
}

export const recoveryContext =
  'Earlier context remains in saved history or workspace files. Read the source before using missing facts. Do not repeat completed or uncertain actions.';
const failure = () =>
  new Error(
    'The assistant session could not be saved. Stop and restore storage before continuing.',
  );

export function completeAssistantMessage(message: AssistantMessage): AssistantMessage {
  if (!Array.isArray(message.content)) return { ...message, content: [] };
  let changed = false;
  const content = message.content.flatMap((part) => {
    if (!part || typeof part !== 'object') {
      changed = true;
      return [];
    }
    if (part.type === 'text' && typeof part.text !== 'string') {
      changed = true;
      return [{ ...part, text: '' }];
    }
    if (part.type === 'thinking' && typeof part.thinking !== 'string') {
      changed = true;
      return part.redacted && typeof part.thinkingSignature === 'string' && part.thinkingSignature
        ? [{ ...part, thinking: '[Reasoning redacted]' }]
        : [];
    }
    return [part];
  });
  return changed ? { ...message, content } : message;
}

function repairAssistantMessages(manager: SessionManager) {
  for (const entry of manager.buildSessionProjection().entries) {
    if (entry.sourceEntry.type !== 'message') continue;
    const message = entry.messages.find((item) => item.role === 'assistant');
    if (message?.role !== 'assistant') continue;
    const complete = completeAssistantMessage(message);
    if (complete !== message)
      manager.appendContextEdit(entry.sourceEntry.id, { content: complete.content });
  }
}

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

const restartType = 'nod-context-restart';

export function openLocalSession(directory: string, contextRestart?: string) {
  let manager = SessionManager.continueRecent(directory, directory);
  if (
    contextRestart &&
    !manager
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === restartType &&
          entry.data === contextRestart,
      )
  ) {
    manager = SessionManager.create(directory, directory);
    manager.appendCustomEntry(restartType, contextRestart);
  }
  const file = manager.getSessionFile();
  const session =
    file && existsSync(file) && statSync(file).size > rebaseAt
      ? rebaseSession(manager, SessionManager.create(directory, directory))
      : manager;
  repairAssistantMessages(session);
  return session;
}

function rebaseSession(source: SessionManager, next: SessionManager) {
  const context = source.buildContextEntries();
  const audio = audioEntries(source);
  const recordings = new Map(audio.map((entry) => [entry.id, entry]));
  const projected = new Map(
    source.buildSessionProjection().entries.map((entry) => [entry.sourceEntry.id, entry.messages]),
  );
  const current = new Set(context.map((entry) => entry.id));
  const copyRecording = (entry: (typeof audio)[number]) =>
    next.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
  for (const entry of audio.slice(-2)) if (!current.has(entry.id)) copyRecording(entry);
  const started = requestStart(source);
  if (started) next.appendCustomEntry(requestEntry, { at: started });
  let images = [...projected.values()]
    .flat()
    .reduce(
      (count, message) =>
        message.role === 'toolResult'
          ? count + message.content.filter((part) => part.type === 'image').length
          : count,
      0,
    );
  for (const entry of context) {
    if (entry.type === 'compaction')
      next.appendCompaction(entry.summary, null, entry.tokensBefore, entry.details);
    else if (entry.type === 'custom_message' && recordings.has(entry.id))
      copyRecording(recordings.get(entry.id)!);
    else if (entry.type === 'custom_message' && entry.customType === 'nod-audio-input') {
      for (const message of projected.get(entry.id) ?? [])
        if (message.role === 'custom')
          next.appendMessage({
            role: 'user',
            content: message.content,
            timestamp: message.timestamp,
          });
    } else if (entry.type === 'message') {
      for (const message of projected.get(entry.id) ?? [])
        next.appendMessage(
          ('content' in message && Array.isArray(message.content)
            ? {
                ...message,
                content: message.content.map((part) =>
                  part?.type === 'image' && message.role === 'toolResult' && images-- > keptImages
                    ? { type: 'text' as const, text: removedImage }
                    : part,
                ),
              }
            : message) as Parameters<typeof next.appendMessage>[0],
        );
    }
  }
  const restart = source
    .getEntries()
    .findLast((entry) => entry.type === 'custom' && entry.customType === restartType);
  if (restart?.type === 'custom') next.appendCustomEntry(restartType, restart.data);
  return next;
}

export function dropFailedInput(manager: SessionManager) {
  const projection = new Map(
    manager.buildSessionProjection().entries.map((entry) => [entry.sourceEntry.id, entry.messages]),
  );
  const entries = manager.getBranch();
  const stops = entries.map((entry) => {
    const message =
      projection.get(entry.id)?.find((item) => item.role === 'assistant') ??
      (entry.type === 'message' ? entry.message : undefined);
    return message?.role === 'assistant' ? message.stopReason : undefined;
  });
  const failed = stops.lastIndexOf('error');
  const answered = stops.findLastIndex(
    (stop) => stop === 'stop' || stop === 'toolUse' || stop === 'length',
  );
  if (failed <= answered) return false;
  const compacted = entries
    .slice(answered + 1, failed + 1)
    .some((entry) => entry.type === 'compaction' && projection.get(entry.id)?.length);
  let changed = false;
  for (const entry of entries.slice(answered + 1, failed + 1))
    if (
      (entry.type === 'message' || entry.type === 'custom_message') &&
      projection
        .get(entry.id)
        ?.some((message) => ['user', 'custom', 'toolResult', 'assistant'].includes(message.role))
    ) {
      manager.appendContextEdit(entry.id, null);
      changed = true;
    }
  if (compacted) {
    const before = entries.slice(0, answered + 1);
    const prior = before.findLast((entry) => entry.type === 'compaction');
    manager.appendCompaction(
      prior?.type === 'compaction' ? prior.summary : recoveryContext,
      prior?.type === 'compaction' ? prior.firstKeptEntryId : (entries[0]?.id ?? null),
      prior?.type === 'compaction'
        ? prior.tokensBefore
        : buildSessionProjection(before).messages.reduce(
            (total, message) => total + estimateTokens(message),
            0,
          ),
      prior?.type === 'compaction' ? prior.details : undefined,
      prior?.type === 'compaction' ? prior.fromHook : undefined,
    );
  }
  if (changed || compacted) closeInterruptedCalls(manager);
  return changed || compacted;
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
