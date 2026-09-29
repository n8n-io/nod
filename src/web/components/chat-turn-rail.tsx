import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Message } from '../../shared/contracts';
import { formatDateTime, formatFullDateTime, useDateFormat } from '../lib/date-format';

export function ChatTurnRail({
  messages,
  activeId,
  visibleIds = [],
  onJump,
}: {
  messages: Message[];
  activeId: string | null;
  visibleIds?: string[];
  onJump(id: string): void;
}) {
  const [preview, setPreview] = useState<{ message: Message; left: number; top: number } | null>(
    null,
  );
  const dateFormat = useDateFormat();
  const track = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const turns = messages.filter((message) => message.role === 'user');
  const currentId = turns.some((message) => message.id === focusedId)
    ? focusedId
    : turns.some((message) => message.id === activeId)
      ? activeId
      : turns.at(-1)?.id;
  useEffect(() => {
    const container = track.current;
    const button = container?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!container || !button || container.contains(document.activeElement)) return;
    if (button.offsetTop < container.scrollTop) container.scrollTop = button.offsetTop;
    else if (button.offsetTop + button.offsetHeight > container.scrollTop + container.clientHeight)
      container.scrollTop = button.offsetTop + button.offsetHeight - container.clientHeight;
  }, [activeId, turns.length]);
  if (turns.length < 2) return null;
  function show(message: Message, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    setPreview({
      message,
      left: Math.max(8, Math.min(rect.right + 12, window.innerWidth - 280)),
      top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 108)),
    });
  }
  function excerpt(message: Message) {
    return (message.text || message.attachments.map((item) => item.name).join(', ') || 'Attachment')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }
  return (
    <>
      <nav
        className="chat-turn-rail"
        aria-label="Jump to your messages"
        style={
          {
            '--chat-turn-spacing': `${Math.max(6, Math.min(14, 200 / turns.length))}px`,
          } as CSSProperties
        }
      >
        <div
          className="chat-turn-track"
          ref={track}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setPreview(null);
              return;
            }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)),
                    );
            buttons[next]?.focus();
          }}
        >
          {turns.map((message) => (
            <button
              key={message.id}
              type="button"
              className={`chat-turn-marker${activeId === message.id ? ' is-active' : ''}${visibleIds.includes(message.id) ? ' is-visible' : ''}`}
              aria-current={activeId === message.id ? 'location' : undefined}
              tabIndex={currentId === message.id ? 0 : -1}
              aria-label={`Your message, ${formatFullDateTime(message.createdAt, dateFormat)}: ${excerpt(message)}`}
              aria-describedby={
                preview?.message.id === message.id ? 'chat-turn-preview' : undefined
              }
              onMouseEnter={(event) => show(message, event.currentTarget)}
              onMouseLeave={() => setPreview(null)}
              onFocus={(event) => {
                setFocusedId(message.id);
                show(message, event.currentTarget);
              }}
              onBlur={() => setPreview(null)}
              onClick={() => {
                setPreview(null);
                onJump(message.id);
              }}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      </nav>
      {preview &&
        createPortal(
          <div
            className="chat-turn-preview"
            id="chat-turn-preview"
            role="tooltip"
            style={{ left: preview.left, top: preview.top }}
          >
            <time dateTime={preview.message.createdAt}>
              {formatDateTime(preview.message.createdAt, dateFormat)}
            </time>
            <span>{excerpt(preview.message)}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
