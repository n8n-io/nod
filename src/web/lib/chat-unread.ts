import type { Message, MessageHistoryPage } from '../../shared/contracts';
import { desktopChatReadCursor, saveDesktopChatReadCursor } from './desktop';

export type ChatReadCursor = { createdAt: string; messageIds: string[] };
type MessageMarker = Pick<Message, 'id' | 'role' | 'createdAt'>;
const epoch = '1970-01-01T00:00:00.000Z';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseChatReadCursor(input: unknown): ChatReadCursor | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== 'createdAt' && key !== 'messageIds') ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !Array.isArray(value.messageIds) ||
    value.messageIds.length > 2048 ||
    value.messageIds.some((id) => typeof id !== 'string' || !uuid.test(id))
  )
    return null;
  return { createdAt: value.createdAt, messageIds: [...new Set(value.messageIds)] };
}

export function mergeChatReadCursor(current: ChatReadCursor, next: ChatReadCursor) {
  if (next.createdAt < current.createdAt) return current;
  if (next.createdAt > current.createdAt) return next;
  return {
    createdAt: current.createdAt,
    messageIds: [...new Set([...current.messageIds, ...next.messageIds])],
  };
}

export function latestChatReadCursor(messages: MessageMarker[]): ChatReadCursor {
  return messages.reduce<ChatReadCursor>(
    (cursor, message) =>
      mergeChatReadCursor(cursor, { createdAt: message.createdAt, messageIds: [message.id] }),
    { createdAt: epoch, messageIds: [] },
  );
}

export function unreadChatMessageIds(messages: MessageMarker[], cursor: ChatReadCursor) {
  const read = new Set(cursor.messageIds);
  return new Set(
    messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          (message.createdAt > cursor.createdAt ||
            (message.createdAt === cursor.createdAt && !read.has(message.id))),
      )
      .map((message) => message.id),
  );
}

export function hasUnreadHistory(
  messages: MessageMarker[],
  hasEarlier: boolean,
  cursor: ChatReadCursor,
) {
  return hasEarlier && !!messages.length && messages[0].createdAt >= cursor.createdAt;
}

export async function reconcileUnreadChat(
  messages: MessageMarker[],
  hasEarlier: boolean,
  cursor: ChatReadCursor,
  load: (before: MessageMarker, signal: AbortSignal) => Promise<MessageHistoryPage>,
  signal: AbortSignal,
  progress: (count: number) => void,
) {
  const unread = unreadChatMessageIds(messages, cursor);
  let page = { messages, hasMore: hasEarlier };
  while (unread.size < 100 && hasUnreadHistory(page.messages, page.hasMore, cursor)) {
    signal.throwIfAborted();
    const before = page.messages[0];
    const next = await load(before, signal);
    signal.throwIfAborted();
    const first = next.messages[0];
    if (
      next.hasMore &&
      (!first ||
        first.createdAt > before.createdAt ||
        (first.createdAt === before.createdAt && first.id >= before.id))
    )
      throw new Error('Message history did not advance.');
    for (const id of unreadChatMessageIds(next.messages, cursor)) unread.add(id);
    page = next;
    progress(Math.min(unread.size, 100));
  }
  return Math.min(unread.size, 100);
}

export async function loadUnreadChatBoundary(
  messages: Message[],
  hasEarlier: boolean,
  cursor: ChatReadCursor,
  load: (before: MessageMarker, signal: AbortSignal) => Promise<MessageHistoryPage>,
  signal: AbortSignal,
) {
  let page = { messages, hasMore: hasEarlier };
  const collected = new Map(messages.map((message) => [message.id, message]));
  while (hasUnreadHistory(page.messages, page.hasMore, cursor)) {
    signal.throwIfAborted();
    const before = page.messages[0];
    const next = await load(before, signal);
    signal.throwIfAborted();
    const first = next.messages[0];
    if (
      next.hasMore &&
      (!first ||
        first.createdAt > before.createdAt ||
        (first.createdAt === before.createdAt && first.id >= before.id))
    )
      throw new Error('Message history did not advance.');
    for (const message of next.messages) collected.set(message.id, message);
    page = next;
  }
  const ordered = [...collected.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return {
    messages: ordered,
    hasMore: page.hasMore,
    messageId: unreadChatMessageIds(ordered, cursor).values().next().value ?? null,
  };
}

function chatReadStorageKey(ownerId: string, threadId: string) {
  return `nod.chat-read.${JSON.stringify([ownerId, threadId])}`;
}

export async function readChatReadCursor(ownerId: string, threadId: string) {
  const native = desktopChatReadCursor(ownerId, threadId);
  const value = native
    ? await native
    : JSON.parse(window.localStorage.getItem(chatReadStorageKey(ownerId, threadId)) ?? 'null');
  if (value === null) return null;
  const cursor = parseChatReadCursor(value);
  if (!cursor) throw new Error('The saved read state could not be read.');
  return cursor;
}

export async function writeChatReadCursor(
  ownerId: string,
  threadId: string,
  cursor: ChatReadCursor,
) {
  const value = parseChatReadCursor(cursor);
  if (!value) throw new Error('The read position is invalid.');
  const native = saveDesktopChatReadCursor(ownerId, threadId, value);
  if (native) await native;
  else window.localStorage.setItem(chatReadStorageKey(ownerId, threadId), JSON.stringify(value));
}
