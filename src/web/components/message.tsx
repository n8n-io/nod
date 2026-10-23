import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, Check, CornerUpLeft, SmilePlus } from './icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Message } from '../../shared/contracts';
import { reactionEmoji } from '../../shared/emoji';
import { Checkbox, Loading, Notice } from './ui';
import { BrandMark } from './brand';
import { errorMessage, post } from '../lib/api';
import {
  analyticsForCurrentSession,
  captureAnalytics,
  type AnalyticsProperties,
} from '../lib/analytics';
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
import { TelegramChatLink, useTelegramChatUrl } from './telegram-chat-link';
import { BrowserHandoff } from './browser-handoff';
import { MessageAttachments } from './attachment-card';
import { formatFullDateTime, formatTime, useDateFormat } from '../lib/date-format';
import { money } from '../lib/money';
import { navigate } from '../lib/navigation';

const ReactionPicker = lazy(() => import('./emoji-picker'));
const analyticsReactions: Record<string, ReactionAnalytics['reaction']> = {
  '👍': 'thumbs_up',
  '❤️': 'heart',
  '😂': 'joy',
  '🎉': 'party',
  '😮': 'wow',
  '🙏': 'pray',
  '👎': 'thumbs_down',
};
type ReactionAnalytics = AnalyticsProperties<'nod_message_reaction_changed'>;
const messageSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
};

export const MessageText = memo(function MessageText({
  text,
  previews = false,
  connectedAppIds,
  handoff,
  handoffPaused,
  handoffTurnId,
}: {
  text: string;
  previews?: boolean;
  connectedAppIds?: ReadonlySet<string>;
  handoff?: boolean;
  handoffPaused?: boolean;
  handoffTurnId?: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const telegramUrl = useTelegramChatUrl(text);
  const origin = typeof window === 'undefined' ? 'http://localhost:4310' : window.location.origin;
  const actions = messageSetupLinks(text, origin);
  const connected = (href: string) =>
    href.startsWith('/apps?connect=') &&
    Boolean(connectedAppIds?.has(href.slice('/apps?connect='.length)));
  return (
    <>
      <div className="message-text" ref={content}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeLocalLinks, [rehypeSanitize, messageSchema]]}
          components={{
            table: ({ node, ...props }) => <table {...props} tabIndex={0} />,
            a: ({ href, children, node }) => {
              const link = safeMessageLink(href ?? '', origin);
              if (!link) return <span>{children}</span>;
              if (href === telegramUrl) return <TelegramChatLink href={telegramUrl} />;
              const linkText = messageLinkText(node?.children ?? []);
              const setup = setupLink(link, linkText);
              if (setup && actions.some((action) => action.href === setup.href))
                return (
                  <strong className="setup-phrase">
                    {linkText.trim() && !linkText.includes(setup.href) ? children : setup.label}
                  </strong>
                );
              return (
                <a
                  href={link.kind === 'external' ? href : link.href}
                  target={
                    link.kind === 'navigation' ||
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
            (action) => action.setup !== 'browser' && !connected(action.href),
          )}
        />
        {handoff && handoffTurnId && actions.some((action) => action.setup === 'browser') && (
          <BrowserHandoff key={handoffTurnId} turnId={handoffTurnId} paused={handoffPaused} />
        )}
      </div>
      {previews && <MessageLinkPreviews key={telegramUrl} content={content} text={text} />}
    </>
  );
});

type MessagePanel =
  | { kind: 'menu'; point?: { x: number; y: number }; method: 'button' | 'context_menu' }
  | { kind: 'reactions'; expanded: boolean };

export function MessageBubble({
  message,
  connectedAppIds,
  grouped = false,
  streaming = false,
  onReply,
  handoff,
  handoffPaused,
}: {
  message: Message;
  connectedAppIds?: ReadonlySet<string>;
  grouped?: boolean;
  streaming?: boolean;
  onReply?(): void;
  handoff?: boolean;
  handoffPaused?: boolean;
}) {
  const dateFormat = useDateFormat();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [reaction, setReaction] = useState(message.reaction ?? null);
  const [reacting, setReacting] = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [selected, setSelected] = useState(false);
  const [panel, setPanel] = useState<MessagePanel | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 180, maxHeight: 360 });
  const articleElement = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLDivElement>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agentReaction =
    message.role === 'user'
      ? reactionEmoji(message.reactions?.find((item) => item.actor === 'assistant')?.reaction ?? '')
      : '';
  const shownReaction = reaction || agentReaction;
  const mountedReaction = useRef(shownReaction);
  const [leaving, setLeaving] = useState(false);
  const reactionClass = `reaction-pin${shownReaction && shownReaction !== mountedReaction.current ? ' is-new' : ''}${leaving ? ' is-leaving' : ''}`;
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
  useLayoutEffect(() => {
    if (!panel || !panelElement.current) return;
    const element = panelElement.current;
    const place = () => {
      const trigger = panel.kind === 'menu' ? menuTrigger.current : pickerTrigger.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      let next;
      if (panel.kind === 'menu') {
        const point = panel.point ?? { x: bounds.left, y: bounds.bottom };
        next = {
          left: Math.max(0, Math.min(point.x, window.innerWidth - element.offsetWidth)),
          top: Math.max(0, Math.min(point.y, window.innerHeight - element.offsetHeight)),
          width: Math.min(180, window.innerWidth),
          maxHeight: window.innerHeight,
        };
      } else {
        const width = Math.min(panel.expanded ? 328 : 312, window.innerWidth - 16);
        const below = window.innerHeight - bounds.bottom - 12;
        const above = bounds.top - 12;
        const desired = panel.expanded ? 360 : element.offsetHeight;
        const down = below >= desired || below >= above;
        const maxHeight = Math.max(0, Math.min(360, down ? below : above));
        const height = Math.min(desired, maxHeight);
        next = {
          left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
          top: Math.max(
            8,
            Math.min(
              down ? bounds.bottom + 4 : bounds.top - height - 4,
              window.innerHeight - height - 8,
            ),
          ),
          width,
          maxHeight,
        };
      }
      setPosition((current) =>
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel]);
  useEffect(() => {
    if (!panel) return;
    const trigger = panel.kind === 'menu' ? menuTrigger.current : pickerTrigger.current;
    const outside = (event: PointerEvent) => {
      if (panelElement.current?.contains(event.target as Node)) return;
      if (event.button === 0 && trigger?.contains(event.target as Node)) return;
      setPanel(null);
    };
    const focusChanged = (event: FocusEvent) => {
      if (
        !panelElement.current?.contains(event.target as Node) &&
        !trigger?.contains(event.target as Node)
      )
        setPanel(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPanel(null);
        trigger?.focus({ preventScroll: true });
        return;
      }
      if (panel.kind !== 'menu' || !panelElement.current?.contains(event.target as Node)) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(
        panelElement.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
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
      items[next]?.focus({ preventScroll: true });
    };
    const moved = (event: Event) => {
      if (!(event.target instanceof Node) || !panelElement.current?.contains(event.target))
        setPanel(null);
    };
    if (panel.kind === 'menu')
      panelElement.current
        ?.querySelector<HTMLButtonElement>('button')
        ?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', focusChanged);
    document.addEventListener('keydown', keydown);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', focusChanged);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [panel?.kind]);
  async function leave(value: string, method: ReactionAnalytics['method']) {
    if (reacting || leaving) return;
    setLeaving(true);
    await react(
      value,
      method,
      reactionName(value),
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
    );
    setLeaving(false);
  }
  async function react(
    value: string,
    method: ReactionAnalytics['method'],
    name = reactionName(value),
    delay = 0,
  ) {
    if (reacting || message.role !== 'assistant' || streaming) return;
    const capture = analyticsForCurrentSession();
    const next = nextReaction(reaction, value);
    setReacting(true);
    setPanel(null);
    if (panel?.kind === 'reactions') pickerTrigger.current?.focus({ preventScroll: true });
    setError('');
    try {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      await post(`/api/messages/${message.id}/reaction`, { reaction: next });
      setReaction(next);
      setSelectedName(next ? name : '');
      capture('nod_message_reaction_changed', {
        operation: !next ? 'remove' : reaction ? 'change' : 'add',
        reaction: analyticsReactions[reactionEmoji(next ?? value)] ?? 'other',
        method,
        role: message.role,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setReacting(false);
    }
  }
  async function copy(method: 'button' | 'context_menu') {
    captureAnalytics('nod_message_action', { action: 'copy', role: message.role, method });
    setPanel(null);
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The message could not be copied.');
    }
  }
  function reply(method: 'button' | 'context_menu') {
    captureAnalytics('nod_message_action', { action: 'reply', role: message.role, method });
    setPanel(null);
    onReply?.();
  }
  return (
    <article
      ref={articleElement}
      className={`message message-${message.role}${grouped ? ' message-grouped' : ''}${selected ? ' message-selected' : ''}${panel ? ' message-panel-open' : ''}`}
      aria-label={streaming ? 'nod is responding' : message.role === 'user' ? 'You' : 'nod'}
      data-message-id={streaming ? undefined : message.id}
      onPointerUp={(event) => {
        if (!['touch', 'pen'].includes(event.pointerType)) return;
        if ((event.target as HTMLElement).closest('a,button,audio,video,input,textarea,select'))
          return;
        setSelected(true);
        event.currentTarget.focus({ preventScroll: true });
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelected(false);
      }}
      tabIndex={-1}
    >
      {message.role === 'assistant' && (
        <div className={`assistant-mark${grouped ? ' grouped-mark' : ''}`} aria-hidden="true">
          <BrandMark small />
        </div>
      )}
      <div className="message-content">
        <div className="message-row">
          <div className={`message-bubble${!streaming && shownReaction ? ' has-reaction' : ''}`}>
            <div
              className="message-body"
              onContextMenu={(event) => {
                if (
                  streaming ||
                  (event.target as HTMLElement).closest(
                    'a,button,audio,video,input,textarea,select,[contenteditable="true"],[role="button"]',
                  )
                )
                  return;
                event.preventDefault();
                setPanel({
                  kind: 'menu',
                  method: 'context_menu',
                  point:
                    event.clientX || event.clientY
                      ? { x: event.clientX, y: event.clientY }
                      : undefined,
                });
              }}
            >
              {message.replyTo &&
                !(message.role === 'assistant' && message.replyTo.role === 'assistant') && (
                  <blockquote className="message-reply-quote">
                    <span>{message.replyTo.text || 'Attachment'}</span>
                  </blockquote>
                )}
              {message.role === 'user' && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {message.text && (
                <MessageText
                  text={message.text}
                  previews={!streaming}
                  connectedAppIds={connectedAppIds}
                  handoff={!streaming && handoff}
                  handoffPaused={handoffPaused}
                  handoffTurnId={message.turnId ?? undefined}
                />
              )}
              {message.role === 'assistant' && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {!streaming && (
                <time
                  className="message-time"
                  dateTime={message.createdAt}
                  title={formatFullDateTime(message.createdAt, dateFormat)}
                >
                  {formatTime(message.createdAt, dateFormat)}
                </time>
              )}
            </div>
            {!streaming && (
              <>
                {message.role === 'assistant' && (
                  <button
                    type="button"
                    className="message-trigger message-react-trigger"
                    ref={pickerTrigger}
                    aria-label="React to message"
                    title="React"
                    aria-haspopup="dialog"
                    aria-expanded={panel?.kind === 'reactions'}
                    disabled={reacting}
                    onClick={() =>
                      setPanel(
                        panel?.kind === 'reactions' ? null : { kind: 'reactions', expanded: false },
                      )
                    }
                  >
                    <SmilePlus size={17} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="message-trigger message-menu-trigger"
                  ref={menuTrigger}
                  aria-label="Message actions"
                  title="Message actions"
                  aria-haspopup="menu"
                  aria-expanded={panel?.kind === 'menu'}
                  onClick={(event) =>
                    setPanel(
                      panel?.kind === 'menu'
                        ? null
                        : {
                            kind: 'menu',
                            method: 'button',
                            point: event.detail
                              ? { x: event.clientX, y: event.clientY }
                              : undefined,
                          },
                    )
                  }
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
                {reaction && message.role === 'assistant' ? (
                  <button
                    key={reaction}
                    type="button"
                    className={reactionClass}
                    disabled={reacting}
                    onClick={() => void leave(reaction, 'pin')}
                    aria-label={`Remove your ${selectedName || reactionName(reaction)} reaction`}
                    title={`Your reaction: ${selectedName || reactionName(reaction)}. Click to remove`}
                  >
                    <span aria-hidden="true">{reactionEmoji(reaction)}</span>
                  </button>
                ) : (
                  agentReaction && (
                    <span
                      key={agentReaction}
                      className={reactionClass}
                      role="img"
                      aria-label={`nod reacted: ${reactionName(agentReaction)}`}
                      title={`nod reacted: ${reactionName(agentReaction)}`}
                    >
                      {agentReaction}
                    </span>
                  )
                )}
              </>
            )}
          </div>
        </div>
        {message.receipt && !streaming && (
          <a
            className="message-receipt"
            href={`/usage?session=${message.receipt.sessionId}`}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              navigate(`/usage?session=${message.receipt!.sessionId}`);
            }}
          >
            {[
              ...message.receipt.actions.map((action) =>
                action.count > 1 ? `${action.label} ×${action.count}` : action.label,
              ),
              message.receipt.costUsd === null ? '' : money(message.receipt.costUsd),
            ]
              .filter(Boolean)
              .join(' · ')}
          </a>
        )}
        {error && <Notice>{error}</Notice>}
        {copied && (
          <span className="sr-only" role="status">
            Message copied
          </span>
        )}
      </div>
      {panel &&
        createPortal(
          panel.kind === 'menu' ? (
            <div
              className="chat-message-menu menu"
              ref={panelElement}
              role="menu"
              aria-label="Message actions"
              style={position}
            >
              {onReply && (
                <button type="button" role="menuitem" onClick={() => reply(panel.method)}>
                  <CornerUpLeft size={16} aria-hidden="true" />
                  Reply
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => void copy(panel.method)}>
                {copied ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Copy size={16} aria-hidden="true" />
                )}
                Copy
              </button>
            </div>
          ) : (
            <div
              className={`chat-emoji-popover${panel.expanded ? '' : ' is-compact'}`}
              role="dialog"
              aria-label="Choose a reaction"
              aria-modal="false"
              ref={panelElement}
              style={{ ...position, height: panel.expanded ? position.maxHeight : undefined }}
            >
              <Suspense fallback={<Loading label="Loading emoji…" />}>
                <ReactionPicker
                  expanded={panel.expanded}
                  selected={reaction}
                  onExpand={() => setPanel({ kind: 'reactions', expanded: true })}
                  onSelect={(emoji, name) =>
                    void react(emoji, panel.expanded ? 'picker' : 'quick', name)
                  }
                />
              </Suspense>
            </div>
          ),
          document.body,
        )}
    </article>
  );
}
