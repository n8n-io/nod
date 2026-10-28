import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, Check, CornerUpLeft, SmilePlus } from './icons';
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
import { rehypeLocalLinks, rehypeMessageBreaks, remarkLinkDestinations } from '../lib/markdown';
import { nextReaction, reactionName } from '../lib/reactions';
import { MessageLinkPreviews } from './link-previews';
import { SetupActions } from './setup-link';
import { TelegramChatLink, useTelegramChatUrl } from './telegram-chat-link';
import { BrowserHandoff } from './browser-handoff';
import { MessageAttachments } from './attachment-card';
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
      <button
        type="button"
        className="copy-block"
        onClick={() => {
          const element = content.current?.querySelector<HTMLElement>(table ? 'table' : 'pre');
          void copyContent(element?.textContent ?? '', table ? element : undefined)
            .then(() => setStatus('Copied'))
            .catch(() => setStatus('Could not copy. Select the text and copy it.'));
        }}
        aria-label={table ? 'Copy table' : 'Copy code'}
        title={table ? 'Copy table' : 'Copy code'}
      >
        <Copy size={14} />
        {status && <span role="status">{status}</span>}
      </button>
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
type ReactionAnalytics = AnalyticsProperties<'nod_message_reaction_changed'>;
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
    <button
      type="button"
      className="message-reply-quote"
      title="Go to original message"
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
  );
}

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
  onReply?(quote?: string): void;
  handoff?: boolean;
  handoffPaused?: boolean;
}) {
  const dateFormat = useDateFormat();
  const visibleText = message.audioCaption ?? message.text;
  const visibleReply =
    message.replyTo && !(message.role === 'assistant' && message.replyTo.role === 'assistant')
      ? message.replyTo
      : null;
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [quote, setQuote] = useState('');
  const [quotePoint, setQuotePoint] = useState({ left: 0, top: 0 });
  function selectQuote() {
    const value = selectedText(articleElement.current).trim().slice(0, 4000);
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    if (value && range && typeof range.getBoundingClientRect === 'function') {
      const box = range.getBoundingClientRect();
      setQuotePoint({
        left: Math.max(8, Math.min(box.left, window.innerWidth - 190)),
        top: Math.max(8, box.top - 36),
      });
    }
    setQuote(value);
  }
  useEffect(() => {
    if (!quote) return;
    const clear = () => setQuote('');
    const selectionChanged = () => {
      if (selectedText(articleElement.current).trim().slice(0, 4000) !== quote) clear();
    };
    window.addEventListener('scroll', clear, true);
    document.addEventListener('selectionchange', selectionChanged);
    return () => {
      window.removeEventListener('scroll', clear, true);
      document.removeEventListener('selectionchange', selectionChanged);
    };
  }, [quote]);
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
  async function copy(method: 'button' | 'context_menu', markdown = false) {
    captureAnalytics('nod_message_action', { action: 'copy', role: message.role, method });
    setPanel(null);
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
    onReply?.(quote || undefined);
    setQuote('');
  }
  return (
    <article
      ref={articleElement}
      className={`message message-${message.role}${grouped ? ' message-grouped' : ''}${selected ? ' message-selected' : ''}${panel ? ' message-panel-open' : ''}`}
      aria-label={streaming ? 'Nod is responding' : message.role === 'user' ? 'You' : 'Nod'}
      data-message-id={streaming ? undefined : message.id}
      onMouseUp={selectQuote}
      onKeyUp={selectQuote}
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
                  selectedText(articleElement.current) ||
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
              {visibleReply && <MessageQuote message={visibleReply} />}
              {message.role === 'user' && message.attachments.length > 0 && (
                <MessageAttachments attachments={message.attachments} />
              )}
              {visibleText && (
                <MessageText
                  text={visibleText}
                  previews={!streaming}
                  connectedAppIds={connectedAppIds}
                  handoff={!streaming && handoff}
                  handoffPaused={handoffPaused}
                  handoffTurnId={message.turnId ?? undefined}
                />
              )}
              {message.role === 'assistant' && !streaming && message.presentation && (
                <MessagePresentation value={message.presentation} />
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
                <time
                  className="message-time"
                  dateTime={message.createdAt}
                  title={formatFullDateTime(message.createdAt, dateFormat)}
                >
                  {formatTime(message.createdAt, dateFormat)}
                </time>
                {onReply && (
                  <button
                    type="button"
                    className="message-trigger message-reply-trigger"
                    aria-label="Reply to message"
                    title="Reply"
                    onClick={() => reply('button')}
                  >
                    <CornerUpLeft size={17} aria-hidden="true" />
                  </button>
                )}
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
                      aria-label={`Nod reacted: ${reactionName(agentReaction)}`}
                      title={`Nod reacted: ${reactionName(agentReaction)}`}
                    >
                      {agentReaction}
                    </span>
                  )
                )}
              </>
            )}
          </div>
        </div>
        {quote &&
          onReply &&
          createPortal(
            <button
              type="button"
              className="selection-reply"
              style={{ position: 'fixed', ...quotePoint, zIndex: 60 }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => reply('button')}
            >
              Reply to selection
            </button>,
            document.body,
          )}
        {error && <Notice>{error}</Notice>}
        {copied && (
          <span className="message-copy-status" role="status">
            Copied
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
              <button type="button" role="menuitem" onClick={() => void copy(panel.method, true)}>
                <Copy size={16} aria-hidden="true" />
                Copy Markdown
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
