import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, CornerUpLeft, Ellipsis, SmilePlus } from './icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Message } from '../../shared/contracts';
import { reactionEmoji } from '../../shared/emoji';
import {
  presentationImages,
  presentationSchema,
  presentationText,
} from '../../shared/presentation';
import { Button, Checkbox, Loading, Notice } from './ui';
import { ActionMenuItem, ActionMenuSurface, actionMenuTabTarget } from './action-menu';
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
import { rehypeLocalLinks, rehypeMessageBreaks, remarkLinkDestinations } from '../lib/markdown';
import { nextReaction, reactionName } from '../lib/reactions';
import { SetupActions } from './setup-link';
import { TelegramChatLink, useTelegramChatUrl } from './telegram-chat-link';
import { BrowserHandoff } from './browser-handoff';
import { MessageAttachments } from './attachment-card';
import { AudioPlayer } from './audio-player';
import { AnswerChoices, type AnswerChoicesProps } from './answer-choices';
import { MessageLinkTooltip } from './message-link-tooltip';
import { Tooltip } from './tooltip';
import type { ImagePreview } from './attachment-images';
import { MessagePresentation } from './message-presentation';
import { formatFullDateTime, formatTime, useDateFormat } from '../lib/date-format';
import { copyContent, selectedText } from '../lib/clipboard';

function CopyBlock({ children, table = false }: { children: React.ReactNode; table?: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(''), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <div className="message-copy-block" ref={content}>
      {children}
      <Tooltip content={status === 'Copied' ? 'Copied' : table ? 'Copy table' : 'Copy code'}>
        <button
          type="button"
          className="copy-block"
          onClick={() => {
            const element = content.current?.querySelector<HTMLElement>(table ? 'table' : 'pre');
            void copyContent(element?.textContent ?? '', table ? element : undefined)
              .then(() => setStatus('Copied'))
              .catch(() => setStatus('Could not copy. Select the text and copy it.'));
          }}
          aria-label={status === 'Copied' ? 'Copied' : table ? 'Copy table' : 'Copy code'}
        >
          {status === 'Copied' ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {status && (
            <span className={status === 'Copied' ? 'sr-only' : undefined} role="status">
              {status}
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

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
type ReactionAnalytics = AnalyticsProperties<'message_reaction_changed'>;
const messageSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
};

function QuoteBlock({ children }: { children?: React.ReactNode }) {
  return <span> {children} </span>;
}

export function MessageQuote({
  message,
  composing = false,
}: {
  message: NonNullable<Message['replyTo']>;
  composing?: boolean;
}) {
  return (
    <Tooltip content="Go to original message">
      <button
        type="button"
        className="message-reply-quote"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('nod:focus-message', { detail: { messageId: message.id } }),
          )
        }
      >
        <strong>
          {composing ? 'Replying to ' : ''}
          {message.role === 'assistant' ? 'Nod' : composing ? 'yourself' : 'You'}
        </strong>
        <span
          className="message-excerpt"
          style={{ whiteSpace: message.isQuote ? 'pre-wrap' : 'normal' }}
        >
          {message.isQuote ? (
            message.text
          ) : (
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw, rehypeMessageBreaks, [rehypeSanitize, messageSchema]]}
              allowedElements={[
                'p',
                'div',
                'blockquote',
                'pre',
                'li',
                'td',
                'th',
                'h1',
                'h2',
                'h3',
                'h4',
                'h5',
                'h6',
                'strong',
                'em',
                'del',
                'code',
                'u',
                'br',
                'img',
              ]}
              unwrapDisallowed
              components={{
                p: QuoteBlock,
                div: QuoteBlock,
                blockquote: QuoteBlock,
                pre: QuoteBlock,
                li: QuoteBlock,
                td: QuoteBlock,
                th: QuoteBlock,
                h1: QuoteBlock,
                h2: QuoteBlock,
                h3: QuoteBlock,
                h4: QuoteBlock,
                h5: QuoteBlock,
                h6: QuoteBlock,
                img: ({ alt }) => <span>{alt || 'Image'}</span>,
              }}
            >
              {message.text || 'Attachment'}
            </Markdown>
          )}
        </span>
      </button>
    </Tooltip>
  );
}

export const MessageText = memo(function MessageText({
  text,
  connectedAppIds,
  handoff,
  handoffPaused,
  handoffTurnId,
}: {
  text: string;
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
          remarkPlugins={[remarkGfm, remarkLinkDestinations]}
          rehypePlugins={[
            rehypeRaw,
            rehypeMessageBreaks,
            rehypeLocalLinks,
            [rehypeSanitize, messageSchema],
          ]}
          components={{
            table: ({ node, ...props }) => (
              <CopyBlock table>
                <table {...props} tabIndex={0} />
              </CopyBlock>
            ),
            pre: ({ node, ...props }) => (
              <CopyBlock>
                <pre {...props} />
              </CopyBlock>
            ),
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
        <SetupActions actions={actions.filter((action) => !connected(action.href))} />
        {handoff && handoffTurnId && (
          <BrowserHandoff key={handoffTurnId} turnId={handoffTurnId} paused={handoffPaused} />
        )}
      </div>
      <MessageLinkTooltip content={content} text={text} />
    </>
  );
});

type MessagePanel =
  | { kind: 'menu'; point?: { x: number; y: number }; compact: boolean }
  | { kind: 'reactions'; expanded: boolean; fromMenu?: boolean; point?: { x: number; y: number } };

export function MessageBubble({
  message,
  pendingAudio,
  connectedAppIds,
  grouped = false,
  streaming = false,
  arriving = false,
  onReply,
  onAnswer,
  onWriteAnswer,
  answersDisabled,
  handoff,
  handoffPaused,
}: {
  message: Message;
  pendingAudio?: ImagePreview;
  connectedAppIds?: ReadonlySet<string>;
  grouped?: boolean;
  streaming?: boolean;
  arriving?: boolean;
  onReply?(quote?: string): void;
  onAnswer?: AnswerChoicesProps['onAnswer'];
  onWriteAnswer?(text: string): void;
  answersDisabled?: boolean;
  handoff?: boolean;
  handoffPaused?: boolean;
}) {
  const dateFormat = useDateFormat();
  const visibleText =
    (message.role === 'user' ? message.displayText : undefined) ??
    message.audioCaption ??
    message.text;
  const canCopy = Boolean(
    visibleText.trim() || presentationSchema.safeParse(message.presentation).success,
  );
  const visibleReply =
    message.replyTo && !(message.role === 'assistant' && message.replyTo.role === 'assistant')
      ? message.replyTo
      : null;
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [quote, setQuote] = useState('');
  const [quotePoint, setQuotePoint] = useState({ left: 0, top: 0 });
  const quoteButton = useRef<HTMLButtonElement>(null);
  function selectQuote() {
    const value = selectedText(articleElement.current).trim().slice(0, 4000);
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    if (value && range && typeof range.getBoundingClientRect === 'function') {
      const box = range.getBoundingClientRect();
      setQuotePoint({
        left: Math.max(8, Math.min(box.left, window.innerWidth - 190)),
        top: Math.max(8, box.top - 40),
      });
    }
    setQuote(value);
  }
  useLayoutEffect(() => {
    const selection = window.getSelection();
    if (!quote || !quoteButton.current || !selection?.rangeCount) return;
    const box = selection.getRangeAt(0).getBoundingClientRect();
    const button = quoteButton.current.getBoundingClientRect();
    const top = box.top - button.height - 8;
    setQuotePoint({
      left: Math.max(8, Math.min(box.left, window.innerWidth - button.width - 8)),
      top: Math.max(
        8,
        Math.min(top >= 8 ? top : box.bottom + 8, window.innerHeight - button.height - 8),
      ),
    });
  }, [quote]);
  useEffect(() => {
    if (!quote) return;
    const clear = () => setQuote('');
    const selectionChanged = () => {
      if (selectedText(articleElement.current).trim().slice(0, 4000) !== quote) clear();
    };
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    document.addEventListener('selectionchange', selectionChanged);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, [quote]);
  const [reaction, setReaction] = useState(message.reaction ?? null);
  const [reacting, setReacting] = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [panel, setPanel] = useState<MessagePanel | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 180, maxHeight: 360 });
  const articleElement = useRef<HTMLElement>(null);
  const messageBody = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLDivElement>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useRef<{
    timer: ReturnType<typeof setTimeout>;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const canOpenMenu = !streaming && Boolean(onReply || canCopy || message.role === 'assistant');
  function cancelHold() {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  }
  function openMenu(point?: { x: number; y: number }) {
    cancelHold();
    setPanel({
      kind: 'menu',
      point,
      compact:
        Boolean(messageBody.current) &&
        getComputedStyle(messageBody.current!)
          .getPropertyValue('--compact-message-actions')
          .trim() === '1',
    });
  }
  function panelTrigger() {
    return panel?.kind === 'menu' || (panel?.kind === 'reactions' && panel.fromMenu)
      ? menuTrigger.current
      : pickerTrigger.current;
  }
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
    document.addEventListener('scroll', cancelHold, true);
    document.addEventListener('pointerup', cancelHold);
    document.addEventListener('pointercancel', cancelHold);
    window.addEventListener('blur', cancelHold);
    return () => {
      cancelHold();
      document.removeEventListener('scroll', cancelHold, true);
      document.removeEventListener('pointerup', cancelHold);
      document.removeEventListener('pointercancel', cancelHold);
      window.removeEventListener('blur', cancelHold);
    };
  }, []);
  useLayoutEffect(() => {
    if (!panel || !panelElement.current) return;
    const element = panelElement.current;
    const place = () => {
      const trigger = panelTrigger();
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      let next;
      if (panel.kind === 'menu') {
        const point = panel.point ?? { x: bounds.left, y: bounds.bottom };
        next = {
          left: Math.max(8, Math.min(point.x, window.innerWidth - element.offsetWidth - 8)),
          top: Math.max(8, Math.min(point.y, window.innerHeight - element.offsetHeight - 8)),
          width: Math.min(188, window.innerWidth - 16),
          maxHeight: window.innerHeight - 16,
        };
      } else {
        const width = Math.min(panel.expanded ? 328 : 312, window.innerWidth - 16);
        const bottom = panel.point?.y ?? bounds.bottom;
        const top = panel.point?.y ?? bounds.top;
        const below = window.innerHeight - bottom - 12;
        const above = top - 12;
        const desired = panel.expanded ? 360 : element.offsetHeight;
        const down = below >= desired || below >= above;
        const maxHeight = Math.max(0, Math.min(360, down ? below : above));
        const height = Math.min(desired, maxHeight);
        next = {
          left: Math.max(
            8,
            Math.min(panel.point?.x ?? bounds.right - width, window.innerWidth - width - 8),
          ),
          top: Math.max(
            8,
            Math.min(down ? bottom + 4 : top - height - 4, window.innerHeight - height - 8),
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
    const trigger = panelTrigger();
    const outside = (event: PointerEvent) => {
      if (panelElement.current?.contains(event.target as Node)) return;
      if (
        panel.kind === 'reactions' &&
        !panel.fromMenu &&
        event.button === 0 &&
        trigger?.contains(event.target as Node)
      )
        return;
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
    if (panel?.kind === 'reactions') panelTrigger()?.focus({ preventScroll: true });
    setError('');
    try {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      await post(`/api/messages/${message.id}/reaction`, { reaction: next });
      setReaction(next);
      setSelectedName(next ? name : '');
      capture('message_reaction_changed', {
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
  async function copy(method: 'button' | 'context_menu', markdown = false) {
    if (!canCopy) return;
    const capture = analyticsForCurrentSession();
    setPanel(null);
    if (panel) panelTrigger()?.focus({ preventScroll: true });
    try {
      const visual = presentationSchema.safeParse(message.presentation);
      const content = message.audioCaption ?? message.text;
      const text = visual.success ? `${content}\n\n${presentationText(visual.data)}` : content;
      if (markdown) await navigator.clipboard.writeText(text);
      else
        await copyContent(
          text,
          visual.success
            ? undefined
            : articleElement.current?.querySelector<HTMLElement>('.message-text'),
        );
      capture('message_action', { action: 'copy', role: message.role, method });
      setCopied(true);
      clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('The message could not be copied.');
    }
  }
  function reply(method: 'button' | 'context_menu') {
    captureAnalytics('message_action', { action: 'reply', role: message.role, method });
    setPanel(null);
    onReply?.(quote || undefined);
    setQuote('');
  }
  return (
    <article
      ref={articleElement}
      className={`message message-${message.role}${grouped ? ' message-grouped' : ''}${arriving ? ' message-arriving' : ''}${panel ? ' message-panel-open' : ''}`}
      aria-label={streaming ? 'Nod is responding' : message.role === 'user' ? 'You' : 'Nod'}
      data-message-id={streaming ? undefined : message.id}
      onMouseUp={selectQuote}
      onKeyUp={selectQuote}
      tabIndex={-1}
    >
      <div className="message-content">
        <div className="message-row">
          <div className={`message-bubble${!streaming && shownReaction ? ' has-reaction' : ''}`}>
            <div
              className="message-body"
              ref={messageBody}
              onPointerDown={(event) => {
                cancelHold();
                if (
                  !canOpenMenu ||
                  panel ||
                  !event.isPrimary ||
                  event.button !== 0 ||
                  !['touch', 'pen'].includes(event.pointerType) ||
                  selectedText(articleElement.current) ||
                  (event.target as HTMLElement).closest(
                    'a,button,audio,video,input,textarea,select,[contenteditable="true"],[role="button"],.message-presentation,.message-attachments',
                  )
                )
                  return;
                const point = { x: event.clientX, y: event.clientY };
                hold.current = {
                  ...point,
                  pointerId: event.pointerId,
                  timer: setTimeout(() => {
                    if (!selectedText(articleElement.current)) openMenu(point);
                    cancelHold();
                  }, 450),
                };
              }}
              onPointerMove={(event) => {
                const current = hold.current;
                if (
                  current &&
                  (current.pointerId !== event.pointerId ||
                    Math.hypot(event.clientX - current.x, event.clientY - current.y) > 10)
                )
                  cancelHold();
              }}
              onPointerLeave={cancelHold}
              onContextMenu={(event) => {
                if (
                  !canOpenMenu ||
                  selectedText(articleElement.current) ||
                  (event.target as HTMLElement).closest(
                    'a,button,audio,video,input,textarea,select,[contenteditable="true"],[role="button"],.message-presentation,.message-attachments',
                  )
                )
                  return;
                event.preventDefault();
                openMenu(
                  event.clientX || event.clientY
                    ? { x: event.clientX, y: event.clientY }
                    : undefined,
                );
              }}
            >
              {visibleReply && <MessageQuote message={visibleReply} />}
              {pendingAudio && (
                <div className="message-attachments">
                  <AudioPlayer item={pendingAudio} />
                </div>
              )}
              {message.role === 'user' && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {visibleText && (
                <MessageText
                  text={visibleText}
                  connectedAppIds={connectedAppIds}
                  handoff={!streaming && handoff}
                  handoffPaused={handoffPaused}
                  handoffTurnId={message.turnId ?? undefined}
                />
              )}
              {message.role === 'assistant' &&
                !streaming &&
                message.presentation &&
                message.presentation.type !== 'apps' && (
                  <MessagePresentation value={message.presentation} messageId={message.id} />
                )}
              {message.role === 'assistant' && message.attachments.length > 0 && (
                <MessageAttachments
                  attachments={message.attachments.filter(
                    (attachment) =>
                      !message.presentation ||
                      !presentationImages(message.presentation).some(
                        (image) => image.artifactId === attachment.id,
                      ),
                  )}
                />
              )}
            </div>
            {!streaming && (
              <>
                {canOpenMenu && (
                  <button
                    ref={menuTrigger}
                    type="button"
                    className="message-trigger message-menu-trigger"
                    aria-label="Message actions"
                    aria-haspopup="menu"
                    aria-expanded={
                      panel?.kind === 'menu' ||
                      (panel?.kind === 'reactions' && panel.fromMenu === true)
                    }
                    onClick={() => openMenu()}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        openMenu();
                      }
                    }}
                  >
                    <Ellipsis size={17} aria-hidden="true" />
                  </button>
                )}
                <Tooltip content={formatFullDateTime(message.createdAt, dateFormat)}>
                  <time className="message-time" dateTime={message.createdAt}>
                    {formatTime(message.createdAt, dateFormat)}
                  </time>
                </Tooltip>
                <div className="message-actions" role="group" aria-label="Message actions">
                  {onReply && (
                    <Tooltip content="Reply">
                      <button
                        type="button"
                        className="message-trigger message-reply-trigger"
                        aria-label="Reply to message"
                        onClick={() => reply('button')}
                      >
                        <CornerUpLeft size={17} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  {message.role === 'assistant' && (
                    <Tooltip content="React">
                      <button
                        type="button"
                        className="message-trigger message-react-trigger"
                        ref={pickerTrigger}
                        aria-label="React to message"
                        aria-haspopup="dialog"
                        aria-expanded={panel?.kind === 'reactions'}
                        disabled={reacting}
                        onClick={() =>
                          setPanel(
                            panel?.kind === 'reactions'
                              ? null
                              : { kind: 'reactions', expanded: false },
                          )
                        }
                      >
                        <SmilePlus size={17} aria-hidden="true" />
                      </button>
                    </Tooltip>
                  )}
                  {canCopy && (
                    <Tooltip content={copied ? 'Copied' : 'Copy message'}>
                      <button
                        type="button"
                        className="message-trigger message-copy-trigger"
                        aria-label={copied ? 'Message copied' : 'Copy message'}
                        onClick={() => void copy('button')}
                      >
                        {copied ? (
                          <Check size={17} aria-hidden="true" />
                        ) : (
                          <Copy size={17} aria-hidden="true" />
                        )}
                      </button>
                    </Tooltip>
                  )}
                </div>
                {reaction && message.role === 'assistant' ? (
                  <Tooltip
                    content={`Your reaction: ${selectedName || reactionName(reaction)}. Click to remove`}
                    key={reaction}
                  >
                    <button
                      type="button"
                      className={reactionClass}
                      disabled={reacting}
                      onClick={() => void leave(reaction, 'pin')}
                      aria-label={`Remove your ${selectedName || reactionName(reaction)} reaction`}
                    >
                      <span aria-hidden="true">{reactionEmoji(reaction)}</span>
                    </button>
                  </Tooltip>
                ) : (
                  agentReaction && (
                    <Tooltip
                      content={`Nod reacted: ${reactionName(agentReaction)}`}
                      key={agentReaction}
                    >
                      <span
                        className={reactionClass}
                        role="img"
                        aria-label={`Nod reacted: ${reactionName(agentReaction)}`}
                      >
                        {agentReaction}
                      </span>
                    </Tooltip>
                  )
                )}
              </>
            )}
          </div>
        </div>
        {message.role === 'assistant' && !streaming && message.presentation?.type === 'apps' && (
          <MessagePresentation value={message.presentation} messageId={message.id} />
        )}
        {message.role === 'assistant' &&
          !streaming &&
          message.answerChoices &&
          message.answerChoicesPending &&
          onAnswer &&
          onWriteAnswer && (
            <AnswerChoices
              key={message.id}
              choices={message.answerChoices}
              question={message}
              disabled={answersDisabled}
              onAnswer={onAnswer}
              onWriteAnswer={onWriteAnswer}
            />
          )}
        {quote &&
          onReply &&
          createPortal(
            <Button
              ref={quoteButton}
              type="button"
              variant="outline"
              size="sm"
              className="selection-reply"
              style={{ position: 'fixed', ...quotePoint, zIndex: 60 }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => reply('button')}
            >
              <CornerUpLeft size={14} aria-hidden="true" />
              Reply to selection
            </Button>,
            document.body,
          )}
        {error && <Notice>{error}</Notice>}
        {copied && (
          <span className="sr-only" role="status">
            Copied
          </span>
        )}
      </div>
      {panel &&
        createPortal(
          panel.kind === 'menu' ? (
            <ActionMenuSurface
              className="chat-message-menu"
              ref={panelElement}
              aria-label="Message actions"
              style={position}
              onKeyDownCapture={(event) => {
                if (
                  event.key !== 'Tab' ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.nativeEvent.isComposing
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                const target = actionMenuTabTarget(
                  menuTrigger.current,
                  event.shiftKey,
                  panelElement.current,
                );
                setPanel(null);
                target?.focus({ preventScroll: true });
              }}
            >
              {onReply && (
                <ActionMenuItem onClick={() => reply('context_menu')}>
                  <CornerUpLeft size={16} aria-hidden="true" />
                  Reply
                </ActionMenuItem>
              )}
              {message.role === 'assistant' && (
                <ActionMenuItem
                  disabled={reacting}
                  onClick={() =>
                    setPanel({
                      kind: 'reactions',
                      expanded: false,
                      fromMenu: true,
                      point: { x: position.left, y: position.top },
                    })
                  }
                >
                  <SmilePlus size={16} aria-hidden="true" />
                  React
                </ActionMenuItem>
              )}
              {canCopy && (
                <>
                  <ActionMenuItem onClick={() => void copy('context_menu')}>
                    {copied ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <Copy size={16} aria-hidden="true" />
                    )}
                    Copy
                  </ActionMenuItem>
                  {!panel.compact && (
                    <ActionMenuItem onClick={() => void copy('context_menu', true)}>
                      <Copy size={16} aria-hidden="true" />
                      Copy Markdown
                    </ActionMenuItem>
                  )}
                </>
              )}
            </ActionMenuSurface>
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
                  onExpand={() => setPanel({ ...panel, expanded: true })}
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
