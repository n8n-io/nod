import type { Message } from '../../shared/contracts';
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

export function mergeMessages(known: Message[], incoming: Message[]) {
  const byId = new Map(known.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function collapseScreenshotMessages(messages: Message[]) {
  const result: Message[] = [];
  let previousWasScreenshot = false;
  for (const message of messages) {
    const artifact = message.attachments[0];
    const isScreenshot =
      message.role === 'assistant' &&
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
