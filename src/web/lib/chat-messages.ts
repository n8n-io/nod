import type { Message, Task, Turn } from '../../shared/contracts';
import { isSameDay, type DateFormat } from './date-format';

export function visibleConversationTurns(
  turns: Array<{ id: string; top: number }>,
  viewport: { top: number; bottom: number },
) {
  return turns
    .filter(
      (turn, index) =>
        turn.top < viewport.bottom && (turns[index + 1]?.top ?? Infinity) > viewport.top,
    )
    .map((turn) => turn.id);
}

export function messagesAreGrouped(
  previous: Message | undefined,
  next: Message | undefined,
  format?: DateFormat,
) {
  if (!previous || !next || previous.role !== next.role || next.replyToMessageId) return false;
  const elapsed = Date.parse(next.createdAt) - Date.parse(previous.createdAt);
  return (
    isSameDay(previous.createdAt, next.createdAt, format) && elapsed >= 0 && elapsed < 5 * 60_000
  );
}

export function mergeMessages(
  known: Message[],
  incoming: Message[],
  hiddenIds?: ReadonlySet<string>,
) {
  const byId = new Map(known.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()]
    .filter((message) => !hiddenIds?.has(message.id))
    .map((message) =>
      message.replyTo && hiddenIds?.has(message.replyTo.id)
        ? { ...message, replyTo: undefined }
        : message,
    )
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export function collapseScreenshotMessages(messages: Message[]) {
  const result: Message[] = [];
  let previousWasScreenshot = false;
  for (const message of messages) {
    const artifact = message.attachments[0];
    const isScreenshot =
      message.role === 'assistant' &&
      !message.presentation &&
      Boolean(message.turnId) &&
      message.attachments.length === 1 &&
      artifact.mimeType === 'image/png' &&
      ((!message.text && artifact.source === 'browser_screenshot') ||
        message.text === 'Browser screenshot.' ||
        message.text === `Browser screenshot: ${artifact.name}`) &&
      !message.reaction &&
      !message.reactions?.length &&
      !message.replyToMessageId &&
      !message.replyTo;
    const previous = result.at(-1);
    if (isScreenshot && previousWasScreenshot && previous?.turnId === message.turnId) {
      const attachments = [...previous.attachments, artifact];
      result[result.length - 1] = {
        ...previous,
        text: '',
        attachments,
        createdAt: message.createdAt,
      };
    } else result.push(isScreenshot ? { ...message, text: '' } : message);
    previousWasScreenshot = isScreenshot;
  }
  return result;
}

export function suggestedTaskStatus(
  state: {
    messages: Pick<Message, 'id' | 'role' | 'text' | 'turnId'>[];
    tasks?: Pick<Task, 'messageId' | 'status'>[];
    turns: Pick<Turn, 'id' | 'status'>[];
  },
  title: string,
  after: number,
  persistedIds: ReadonlySet<string>,
) {
  const sent = state.messages
    .slice(after + 1)
    .find((message) => message.role === 'user' && message.text === title);
  if (!sent) return 'idle';
  const tasks = (state.tasks ?? []).filter((item) =>
    state.messages.some(
      (message) => message.id === item.messageId && message.turnId === sent.turnId,
    ),
  );
  if (tasks.length) {
    if (tasks.every((item) => item.status === 'done')) return 'done';
    if (tasks.some((item) => item.status === 'failed' || item.status === 'cancelled'))
      return 'idle';
    if (tasks.some((item) => item.status === 'needs_you')) return 'needs_you';
    return tasks.some((item) => item.status === 'queued' || item.status === 'working')
      ? 'working'
      : 'waiting';
  }
  const turn = sent.turnId ? state.turns.find((item) => item.id === sent.turnId) : undefined;
  if (!turn) return persistedIds.has(sent.id) ? 'sent' : 'working';
  if (turn.status === 'succeeded') return 'sent';
  if (turn.status === 'waiting') return 'needs_you';
  return turn.status === 'failed' || turn.status === 'cancelled' ? 'idle' : 'working';
}
