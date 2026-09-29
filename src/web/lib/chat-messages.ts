import type { Message, Task } from '../../shared/contracts';
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

export function hasVisibleChatActivity(tasks: Pick<Task, 'status' | 'showTyping'>[]) {
  return tasks.some(
    (task) => task.showTyping !== false && ['queued', 'running'].includes(task.status),
  );
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

export function collapseScreenshotMessages(messages: Message[]) {
  const result: Message[] = [];
  let previousWasScreenshot = false;
  for (const message of messages) {
    const artifact = message.attachments[0];
    const isScreenshot =
      message.role === 'assistant' &&
      Boolean(message.taskId) &&
      message.attachments.length === 1 &&
      artifact.mimeType === 'image/png' &&
      (message.text === 'Browser screenshot.' ||
        message.text === `Browser screenshot: ${artifact.name}`) &&
      !message.reaction &&
      !message.reactions?.length &&
      !message.replyToMessageId &&
      !message.replyTo;
    const previous = result.at(-1);
    if (isScreenshot && previousWasScreenshot && previous?.taskId === message.taskId) {
      const attachments = [...previous.attachments, artifact];
      result[result.length - 1] = {
        ...previous,
        text: `${attachments.length} screenshots`,
        attachments,
        createdAt: message.createdAt,
      };
    } else result.push(message);
    previousWasScreenshot = isScreenshot;
  }
  return result;
}
