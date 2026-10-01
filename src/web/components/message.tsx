import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, CornerUpLeft, SmilePlus, ScanSearch, MoreHorizontal, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Message } from '../../shared/contracts';
import { reactionEmoji } from '../../shared/emoji';
import { Button, Checkbox, Loading, Notice } from './ui';
import { BrandMark } from './brand';
import { errorMessage, post } from '../lib/api';
import {
  messageLinkText,
  messageSetupLinks,
  safeMessageLink,
  setupLink,
} from '../lib/message-links';
import { rehypeLocalLinks } from '../lib/markdown';
import { nextReaction, reactionName } from '../lib/reactions';
import { MessageLinkPreviews } from './link-previews';
import { SetupActions } from './setup-link';
import { BrowserHandoff } from './browser-handoff';
import { MessageAttachments } from './attachment-card';
import { formatFullDateTime, formatTime, useDateFormat } from '../lib/date-format';
import { integrationServiceIds, integrationServices } from '../../shared/integrations';

const ReactionPicker = lazy(() => import('./emoji-picker'));

export const MessageText = memo(function MessageText({
  text,
  previews = false,
  connectedAppIds,
  onHandoffDone,
}: {
  text: string;
  previews?: boolean;
  connectedAppIds?: ReadonlySet<string>;
  onHandoffDone?: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const origin = typeof window === 'undefined' ? 'http://localhost:4310' : window.location.origin;
  const actions = messageSetupLinks(text, origin);
  const connected = (href: string, label: string) =>
    Boolean(
      connectedAppIds?.has(
        href.startsWith('/apps?connect=')
          ? href.slice('/apps?connect='.length)
          : (integrationServiceIds.find(
              (slug) => label === `Connect ${integrationServices[slug].name}`,
            ) ?? ''),
      ),
    );
  return (
    <>
      <div className="message-text" ref={content}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeLocalLinks, rehypeSanitize]}
          components={{
            a: ({ href, children, node }) => {
              const link = safeMessageLink(href ?? '', origin);
              if (!link) return <span>{children}</span>;
              const setup = setupLink(link, messageLinkText(node?.children ?? []));
              if (setup && actions.some((action) => action.href === setup.href))
                return <strong className="setup-phrase">{setup.label}</strong>;
              return (
                <a
                  href={link.href}
                  target={
                    setup?.href.startsWith('/apps?connect=') ||
                    link.href.startsWith('/e2e/connect/')
                      ? undefined
                      : '_blank'
                  }
                  rel={
                    setup?.setup === 'vault' &&
                    /^\/(?:vault|credentials)\/[A-Za-z0-9_-]+\/?$/.test(link.href)
                      ? 'opener'
                      : 'noopener noreferrer'
                  }
                  referrerPolicy="no-referrer"
                >
                  {setup ? setup.label : children}
                </a>
              );
            },
            img: ({ src, alt }) =>
              typeof src === 'string' && /^\/api\/artifacts\/[a-f0-9-]+$/.test(src) ? (
                <img src={src} alt={alt ?? ''} loading="lazy" />
              ) : (
                <span>{alt || 'Image'}</span>
              ),
            input: ({ checked }) => <Checkbox checked={checked ?? false} readOnly disabled />,
          }}
        >
          {text}
        </Markdown>
        <SetupActions
          actions={actions.filter(
            (action) => action.setup !== 'browser' && !connected(action.href, action.label),
          )}
        />
        {onHandoffDone && actions.some((action) => action.setup === 'browser') && (
          <BrowserHandoff onDone={onHandoffDone} />
        )}
      </div>
      {previews && <MessageLinkPreviews content={content} text={text} />}
    </>
  );
});

function ReactionGlyph({ value }: { value: string }) {
  return (
    <span className="reaction-emoji" aria-hidden="true">
      {reactionEmoji(value)}
    </span>
  );
}

export function MessageBubble({
  message,
  connectedAppIds,
  inspectorEnabled = false,
  grouped = false,
  streaming = false,
  onReply,
  onHandoffDone,
}: {
  message: Message;
  connectedAppIds?: ReadonlySet<string>;
  inspectorEnabled?: boolean;
  grouped?: boolean;
  streaming?: boolean;
  onReply?(): void;
  onHandoffDone?(): void;
}) {
  const dateFormat = useDateFormat();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [reaction, setReaction] = useState(message.reaction ?? null);
  const [reacting, setReacting] = useState(false);
  const [pickingReaction, setPickingReaction] = useState(false);
  const [pickerExpanded, setPickerExpanded] = useState(false);
  const [pickerPosition, setPickerPosition] = useState({ left: 8, top: 8, width: 340 });
  const [selectedName, setSelectedName] = useState('');
  const [selected, setSelected] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const articleElement = useRef<HTMLElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const pickerTrigger = useRef<HTMLElement | null>(null);
  const pickerElement = useRef<HTMLDivElement>(null);
  const canInspect = message.role === 'assistant' && inspectorEnabled && Boolean(message.turnId);
  const agentReaction =
    message.role === 'user'
      ? reactionEmoji(message.reactions?.find((item) => item.actor === 'assistant')?.reaction ?? '')
      : '';
  useEffect(() => {
    setSelectedName('');
    setReaction(
      message.reaction ??
        message.reactions?.find((item) => item.actor === 'user')?.reaction ??
        null,
    );
  }, [message.reaction, message.reactions]);
  useEffect(
    () => () => {
      clearTimeout(copyTimeout.current);
    },
    [],
  );
  useEffect(() => {
    if (!selected) return;
    const outside = (event: PointerEvent) => {
      if (!articleElement.current?.contains(event.target as Node)) setSelected(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [selected]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(null);
    };
    const focusChanged = (event: FocusEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        setMenu(null);
        return;
      }
      if (event.key === 'Escape') {
        setMenu(null);
        menuTrigger.current?.focus();
      }
      if (!menuElement.current?.contains(event.target as Node)) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(
        menuElement.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
      );
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    menuElement.current?.querySelector<HTMLButtonElement>('button')?.focus();
    document.addEventListener('pointerdown', close);
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('keydown', keydown);
    };
  }, [menu]);
  useEffect(() => {
    if (!pickingReaction) return;
    if (!pickerElement.current?.contains(document.activeElement)) pickerElement.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !pickerElement.current?.contains(event.target as Node) &&
        !pickerTrigger.current?.contains(event.target as Node)
      )
        setPickingReaction(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPickingReaction(false);
      pickerTrigger.current?.focus();
    };
    const moved = (event: Event) => {
      if (!(event.target instanceof Node) || !pickerElement.current?.contains(event.target))
        setPickingReaction(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [pickingReaction]);
  function closePicker() {
    setPickingReaction(false);
    pickerTrigger.current?.focus();
  }
  async function react(value: string, name = reactionName(value)) {
    if (reacting) return;
    const next = nextReaction(reaction, value);
    setReacting(true);
    setMenu(null);
    if (pickingReaction) closePicker();
    setError('');
    try {
      await post(`/api/messages/${message.id}/reaction`, { reaction: next });
      setReaction(next);
      setSelectedName(next ? name : '');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setReacting(false);
    }
  }
  function openPicker(trigger: HTMLElement, expanded = false) {
    pickerTrigger.current = trigger;
    const rect = trigger.getBoundingClientRect();
    const bounds = trigger.closest('.messages')?.getBoundingClientRect();
    const content = trigger
      .closest('.message')
      ?.querySelector('.message-content')
      ?.getBoundingClientRect();
    const minLeft = Math.max(8, (bounds?.left ?? 0) + 8);
    const maxRight = Math.min(window.innerWidth - 8, bounds?.right || window.innerWidth - 8);
    const width = Math.min(expanded ? 340 : 286, maxRight - minLeft);
    const height = Math.min(expanded ? 412 : 48, window.innerHeight - 16);
    setPickerPosition({
      width,
      left: Math.max(minLeft, Math.min(content?.left || rect.left, maxRight - width)),
      top:
        window.innerHeight - rect.bottom >= height + 14
          ? rect.bottom + 6
          : Math.max(8, rect.top - height - 6),
    });
    setMenu(null);
    setPickerExpanded(expanded);
    setPickingReaction(true);
  }
  async function copy() {
    setMenu(null);
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The message could not be copied.');
    }
  }
  function inspect() {
    setMenu(null);
    window.dispatchEvent(
      new CustomEvent('otto:inspect-message', {
        detail: { messageId: message.id, turnId: message.turnId },
      }),
    );
  }
  function reply() {
    setMenu(null);
    onReply?.();
  }
  function openMenu(x: number, y: number, trigger: HTMLElement) {
    menuTrigger.current = trigger;
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 212)),
      y: Math.max(8, Math.min(y, window.innerHeight - 230)),
    });
  }
  return (
    <article
      ref={articleElement}
      className={`message message-${message.role}${streaming ? ' streaming-message' : ''}${grouped ? ' message-grouped' : ''}${selected ? ' message-selected' : ''}`}
      aria-label={streaming ? 'Otto is responding' : message.role === 'user' ? 'You' : 'Otto'}
      data-message-id={streaming ? undefined : message.id}
      onPointerUp={(event) => {
        if (!['touch', 'pen'].includes(event.pointerType)) return;
        if ((event.target as HTMLElement).closest('a,button,audio,video,input')) return;
        setSelected(true);
        event.currentTarget.focus();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelected(false);
      }}
      onContextMenu={(event) => {
        if (streaming) return;
        if ((event.target as HTMLElement).closest('a,audio,video')) return;
        event.preventDefault();
        openMenu(event.clientX, event.clientY, event.currentTarget);
      }}
      tabIndex={-1}
    >
      {message.role === 'assistant' && (
        <div className={`assistant-mark${grouped ? ' grouped-mark' : ''}`} aria-hidden="true">
          <BrandMark small />
        </div>
      )}
      <div className="message-content">
        <div className="message-body">
          {message.replyTo && (
            <blockquote className="message-reply-quote">
              <strong>{message.replyTo.role === 'assistant' ? 'Otto' : 'You'}</strong>
              <span>{message.replyTo.text || 'Attachment'}</span>
            </blockquote>
          )}
          {message.attachments.length > 0 && (
            <MessageAttachments attachments={message.attachments} />
          )}
          {message.text && (
            <MessageText
              text={message.text}
              previews={!streaming}
              connectedAppIds={connectedAppIds}
              onHandoffDone={streaming ? undefined : onHandoffDone}
            />
          )}
          {streaming && <span className="stream-cursor" />}
        </div>
        {(reaction || agentReaction) && (
          <div className="message-footer">
            <div className="message-meta">
              {reaction && (
                <button
                  className="selected-reaction"
                  disabled={reacting}
                  onClick={() => void react(reaction)}
                  aria-label={`Remove your ${selectedName || reactionName(reaction)} reaction`}
                  title={selectedName || reactionName(reaction)}
                >
                  <ReactionGlyph value={reaction} />
                </button>
              )}
              {agentReaction && (
                <span
                  className="selected-reaction agent-reaction"
                  role="img"
                  aria-label={`Otto reacted: ${reactionName(agentReaction)}`}
                  title={`Otto reacted: ${reactionName(agentReaction)}`}
                >
                  <ReactionGlyph value={agentReaction} />
                </span>
              )}
            </div>
          </div>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
      {!streaming && (
        <div className="message-tools">
          <time
            className="message-time"
            dateTime={message.createdAt}
            title={formatFullDateTime(message.createdAt, dateFormat)}
          >
            {formatTime(message.createdAt, dateFormat)}
          </time>
          <div className="message-actions" aria-label="Message actions">
            {onReply && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Reply to message"
                title="Reply"
                onClick={reply}
              >
                <CornerUpLeft size={14} />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label={copied ? 'Message copied' : 'Copy message'}
              title="Copy"
              onClick={() => void copy()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </Button>
            {message.role === 'assistant' && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="React to message"
                title="React"
                aria-haspopup="dialog"
                aria-expanded={pickingReaction}
                onClick={(event) =>
                  pickingReaction ? closePicker() : openPicker(event.currentTarget)
                }
              >
                <SmilePlus size={14} />
              </Button>
            )}
            {canInspect && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Inspect message"
                title="Inspect"
                onClick={inspect}
              >
                <ScanSearch size={14} />
              </Button>
            )}
          </div>
          <Button
            className="message-more-action"
            size="icon"
            variant="ghost"
            aria-label="Message options"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.right - 192, rect.bottom + 6, event.currentTarget);
            }}
          >
            <MoreHorizontal size={17} />
          </Button>
        </div>
      )}
      {menu &&
        createPortal(
          <div
            className="chat-message-menu menu"
            ref={menuElement}
            role="menu"
            aria-label="Message actions"
            style={{ left: menu.x, top: menu.y }}
          >
            {message.role === 'assistant' && (
              <div className="message-reaction-options" role="group" aria-label="Reactions">
                {['👍', '❤️', '😂', '🎉', '😮', '🙏'].map((value) => (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={Boolean(reaction && reactionEmoji(reaction) === value)}
                    aria-label={reactionName(value)}
                    disabled={reacting}
                    onClick={() => void react(value)}
                  >
                    <ReactionGlyph value={value} />
                  </button>
                ))}
              </div>
            )}
            {message.role === 'assistant' && (
              <button
                role="menuitem"
                onClick={() => openPicker(menuTrigger.current ?? document.body, true)}
              >
                <SmilePlus size={14} />
                More emoji
              </button>
            )}
            {onReply && (
              <button role="menuitem" onClick={reply}>
                <CornerUpLeft size={14} />
                Reply
              </button>
            )}
            <button role="menuitem" onClick={() => void copy()}>
              <Copy size={14} />
              Copy
            </button>
            {canInspect && (
              <button role="menuitem" onClick={inspect}>
                <ScanSearch size={14} />
                Inspect
              </button>
            )}
          </div>,
          document.body,
        )}
      {pickingReaction &&
        createPortal(
          <div
            className={`chat-emoji-popover${pickerExpanded ? '' : ' is-compact'}`}
            role="dialog"
            aria-label="Choose a reaction"
            aria-modal="false"
            tabIndex={-1}
            ref={pickerElement}
            style={pickerPosition}
            onBlur={(event) => {
              if (
                event.relatedTarget &&
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== pickerTrigger.current
              )
                setPickingReaction(false);
            }}
          >
            {pickerExpanded && (
              <div className="chat-emoji-heading">
                <strong>Add a reaction</strong>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close emoji picker"
                  onClick={closePicker}
                >
                  <X size={15} />
                </Button>
              </div>
            )}
            <Suspense fallback={<Loading label="Loading emoji…" />}>
              <ReactionPicker
                expanded={pickerExpanded}
                selected={reaction}
                onExpand={() => openPicker(pickerTrigger.current ?? document.body, true)}
                onSelect={(emoji, name) => void react(emoji, name)}
              />
            </Suspense>
          </div>,
          document.body,
        )}
    </article>
  );
}
