import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, Trash2 } from 'lucide-react';
import type {
  AppState,
  Artifact,
  Connection,
  Message,
  MessageHistoryPage,
  SubmitMessageResponse,
} from '../../shared/contracts';
import { integrationServices } from '../../shared/integrations';
import { classifyVerificationReply } from '../../shared/verification-code';
import { Composer, type ComposerHandle, type ComposerSendResult } from '../components/composer';
import { MessageBubble } from '../components/message';
import { ChatTurnRail } from '../components/chat-turn-rail';
import { BrandMark } from '../components/brand';
import { FeedbackLauncher } from '../components/feedback-intro';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Notice,
  Skeleton,
} from '../components/ui';
import { ModelPicker, ModelSetup } from '../components/models';
import { desktopSettingsAvailable } from '../lib/desktop';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, errorMessage, post } from '../lib/api';
import { analyticsForCurrentSession } from '../lib/analytics';
import {
  collapseScreenshotMessages,
  hasVisibleChatActivity,
  mergeMessages,
  messagesAreGrouped,
  visibleConversationTurns,
} from '../lib/chat-messages';
import { formatDayLabel, isSameDay, useDateFormat } from '../lib/date-format';
import { SidebarToggle } from '../components/sidebar-toggle';

function verificationFailure(
  status: SubmitMessageResponse['verificationStatus'],
  ambiguous: boolean,
) {
  if (ambiguous)
    return 'More than one sign-in needs a code. Reply to the verification request you want to complete.';
  if (status === 'unavailable')
    return 'That verification request is no longer available. Wait for a new code request.';
  return 'The verification code could not be confirmed. Check the sign-in request and try again.';
}
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
function Welcome() {
  return (
    <div className="welcome" data-analytics-public>
      <BrandMark />
      <h2>What’s on your mind?</h2>
    </div>
  );
}
export function Chat({
  ownerId,
  state,
  streams,
  refresh,
  resetConversation,
  initialFocusMessageId,
  toolbarActions,
  visible = true,
  onReadLatest,
  requestedMessage,
  onRequestHandled,
  onFeedback,
}: {
  ownerId: string;
  state: AppState;
  streams: Record<string, string>;
  refresh(): Promise<void>;
  resetConversation(threadId: string): Promise<string>;
  initialFocusMessageId?: string;
  toolbarActions?: HTMLElement | null;
  visible?: boolean;
  onReadLatest?(threadId: string): void;
  requestedMessage?: { id: string; text: string };
  onRequestHandled?(id: string): void;
  onFeedback?(): void;
}) {
  const dateFormat = useDateFormat();
  const { data: connections } = usePageData<Connection[]>('/api/apps');
  const connectedAppIds = useMemo(
    () =>
      new Set(
        connections
          ?.filter((connection) => connection.status === 'connected')
          .flatMap(
            (connection) => connection.accessPaths?.map((path) => path.id) ?? [connection.slug],
          ) ?? [],
      ),
    [connections],
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [returningHandoff, setReturningHandoff] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState<{
    text: string;
    kind: 'success' | 'error';
  } | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ id: string; pages: number } | null>(() =>
    initialFocusMessageId ? { id: initialFocusMessageId, pages: 0 } : null,
  );
  const [optimistic, setOptimistic] = useState<Array<{ threadId: string; message: Message }>>([]);
  const [stopping, setStopping] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const sendQueue = useRef(Promise.resolve(true));
  const sendCount = useRef(0);
  const pendingSends = useRef(0);
  const outstandingSends = useRef(0);
  const retry = useRef<{ id: string; threadId: string; signature: string } | null>(null);
  const handledRequest = useRef<string | null>(null);
  const requestedSends = useRef<Array<{ text: string; result?: ComposerSendResult }>>([]);
  const historyVersion = useRef(0);
  const threadId = state.threadId;
  const initializedThread = useRef(threadId);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const [historyPage, setHistoryPage] = useState<{
    threadId: string;
    messages: Message[];
    hasMore?: boolean;
  }>({
    threadId,
    messages: [],
  });
  const hasEarlier =
    (historyPage.threadId === threadId ? historyPage.hasMore : undefined) ??
    state.hasEarlierMessages === true;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [visibleTurns, setVisibleTurns] = useState<string[]>([]);
  const [away, setAway] = useState<{ since: number; shown: boolean } | null>(null);
  const returning = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const resetLock = useRef(false);
  const streamTimes = useRef(new Map<string, string>());
  const known = useRef<{ threadId: string; messages: Message[] }>({ threadId, messages: [] });
  const persistedMessages = useMemo(() => {
    const merged = mergeMessages(
      known.current.threadId === threadId ? known.current.messages : [],
      [...(historyPage.threadId === threadId ? historyPage.messages : []), ...state.messages],
    );
    known.current = { threadId, messages: merged };
    return merged;
  }, [threadId, historyPage, state.messages]);
  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const acknowledgedIds = useRef(persistedIds);
  acknowledgedIds.current = persistedIds;
  const allMessages = [
    ...persistedMessages,
    ...optimistic
      .filter((item) => item.threadId === threadId && !persistedIds.has(item.message.id))
      .map((item) => item.message),
  ];
  const working = hasVisibleChatActivity(state.turns);
  const [welcoming, setWelcoming] = useState(
    () => allMessages.length === 0 && !working && state.configuration.llmReady,
  );
  useEffect(() => {
    if (!welcoming) return;
    void post('/api/account/welcome', {})
      .then(() => refresh())
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setWelcoming(false));
  }, []);
  const persistedStreams = new Set(allMessages.map((message) => message.streamId).filter(Boolean));
  const streamEntries = Object.entries(streams).filter(
    ([id, value]) => value && !persistedStreams.has(id),
  );
  const streamIds = new Set(streamEntries.map(([id]) => id));
  for (const id of streamTimes.current.keys())
    if (!streamIds.has(id)) streamTimes.current.delete(id);
  const visibleMessages: Message[] = collapseScreenshotMessages([
    ...allMessages,
    ...streamEntries.map(([id, value]): Message => {
      if (!streamTimes.current.has(id)) streamTimes.current.set(id, new Date().toISOString());
      return {
        id,
        streamId: id,
        role: 'assistant',
        text: value,
        turnId: null,
        attachments: [],
        createdAt: streamTimes.current.get(id)!,
      };
    }),
  ]);
  const foregroundTurn = state.turns
    .filter((turn) => turn.showTyping !== false)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const handoffMessage = foregroundTurn
    ? foregroundTurn.status === 'waiting'
      ? visibleMessages.findLast(
          (message) => message.role === 'assistant' && message.turnId === foregroundTurn.id,
        )
      : undefined
    : visibleMessages.at(-1);
  const unseen = away
    ? persistedMessages.filter(
        (message) => message.role === 'assistant' && Date.parse(message.createdAt) > away.since,
      ).length
    : 0;
  useLayoutEffect(() => {
    if (stickToBottom.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    else updateAway();
    reportRead();
  }, [state.messages, streams, sending, resetting, optimistic, visible, focusTarget]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reportRead);
    };
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [visible, threadId, onReadLatest, focusTarget]);
  useEffect(() => {
    const ids = new Set(state.messages.map((message) => message.id));
    setOptimistic((current) => {
      const next = current.filter(
        (item) => item.threadId === threadId && !ids.has(item.message.id),
      );
      return next.length === current.length ? current : next;
    });
  }, [state.messages, threadId]);
  useEffect(() => {
    if (initializedThread.current === threadId) return;
    initializedThread.current = threadId;
    historyVersion.current++;
    setHistoryPage({ threadId, messages: [] });
    setLoadingHistory(false);
    setActiveTurn(null);
    setVisibleTurns([]);
    setAway(null);
    setReplyTo(null);
    setOptimistic([]);
    sendQueue.current = Promise.resolve(true);
    pendingSends.current = 0;
    retry.current = null;
    requestedSends.current = [];
    setText('');
    setSending(false);
    setReturningHandoff(null);
    setError('');
    setStopping(false);
    stickToBottom.current = true;
  }, [threadId]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.pathname !== '/') return;
    const outcome = url.searchParams.get('connection');
    if (!outcome) return;
    const slug = url.searchParams.get('service');
    const name =
      slug && Object.hasOwn(integrationServices, slug)
        ? integrationServices[slug as keyof typeof integrationServices].name
        : 'App';
    setConnectionNotice(
      outcome === 'continued'
        ? null
        : {
            text:
              outcome === 'connected'
                ? `${name} connected.`
                : outcome === 'cancelled'
                  ? `${name} connection cancelled. Try again in chat.`
                  : `${name} could not connect. Try again in chat.`,
            kind: outcome === 'connected' ? 'success' : 'error',
          },
    );
    url.searchParams.delete('connection');
    url.searchParams.delete('service');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    if (connectionNotice?.kind !== 'success') return;
    const timer = setTimeout(() => setConnectionNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [connectionNotice]);
  useEffect(() => {
    const focusMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: unknown }>).detail;
      if (typeof detail?.messageId === 'string') setFocusTarget({ id: detail.messageId, pages: 0 });
    };
    window.addEventListener('otto:focus-message', focusMessage);
    return () => window.removeEventListener('otto:focus-message', focusMessage);
  }, []);
  useEffect(() => {
    if (!focusTarget || loadingHistory) return;
    if (focusTarget.pages && error) {
      setFocusTarget(null);
      return;
    }
    const target = Array.from(
      scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
    ).find((element) => element.dataset.messageId === focusTarget.id);
    if (target) {
      stickToBottom.current = false;
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.focus({ preventScroll: true });
        target.classList.add('message-focused');
        setTimeout(() => target.classList.remove('message-focused'), 1600);
        setFocusTarget(null);
      });
      return;
    }
    if (hasEarlier && persistedMessages.length && focusTarget.pages < 5) {
      setFocusTarget({ ...focusTarget, pages: focusTarget.pages + 1 });
      void history();
      return;
    }
    setFocusTarget(null);
    setError('Could not find that message in this chat.');
  }, [focusTarget, loadingHistory, historyPage, hasEarlier, error]);
  async function send(
    value: string,
    attachments: Artifact[],
    reply: Message | null = replyTo,
  ): Promise<ComposerSendResult> {
    if (resetLock.current || welcoming) return { sent: false, restoreText: true };
    const captureAnalytics = analyticsForCurrentSession();
    const sentThread = threadId;
    const verificationRequests = (state.verificationRequests ?? []).filter(
      (request) => !reply || request.turnId === reply.turnId,
    );
    let privateVerification =
      classifyVerificationReply(value).kind !== 'ordinary' && verificationRequests.length > 0;
    const verificationRequestId =
      privateVerification && verificationRequests.length === 1
        ? verificationRequests[0].id
        : undefined;
    let verificationStatus: SubmitMessageResponse['verificationStatus'];
    const signature = privateVerification
      ? null
      : JSON.stringify([value, attachments.map((item) => item.id), reply?.id ?? null]);
    if (privateVerification) retry.current = null;
    const id =
      signature !== null &&
      retry.current?.threadId === sentThread &&
      retry.current.signature === signature
        ? retry.current.id
        : crypto.randomUUID();
    const previous = sendQueue.current;
    let finished!: (sent: boolean) => void;
    sendQueue.current = new Promise<boolean>((resolve) => {
      finished = resolve;
    });
    const sequence = ++sendCount.current;
    pendingSends.current++;
    outstandingSends.current++;
    let failed = false;
    if (reply) setReplyTo(null);
    const message: Message = {
      id,
      role: 'user',
      text: privateVerification ? 'Verification code sent securely.' : value,
      attachments,
      turnId: null,
      createdAt: new Date().toISOString(),
      ...(reply
        ? {
            replyToMessageId: reply.id,
            replyTo: { id: reply.id, role: reply.role, text: reply.text },
          }
        : {}),
    };
    setOptimistic((current) => [
      ...current.filter((item) => item.message.id !== id),
      { threadId: sentThread, message },
    ]);
    historyVersion.current++;
    setLoadingHistory(false);
    setSending(true);
    setError('');
    stickToBottom.current = true;
    const replyId = reply?.id;
    try {
      if (!(await previous)) {
        failed = true;
        setOptimistic((current) => current.filter((item) => item.message.id !== id));
        return { sent: false, restoreText: !privateVerification };
      }
      const response = await apiResponse('/api/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: sentThread,
          clientMessageId: id,
          text: value,
          attachmentIds: attachments.map((item) => item.id),
          ...(replyId ? { replyToMessageId: replyId } : {}),
          ...(verificationRequestId ? { verificationRequestId } : {}),
        }),
      });
      const result = (await response.json()) as Partial<SubmitMessageResponse> & {
        error?: string;
      };
      verificationStatus = result.verificationStatus;
      privateVerification ||= verificationStatus !== undefined;
      if (!response.ok) {
        if (response.status === 409 && verificationStatus === undefined) void refresh();
        throw new Error(result.error || 'The message could not be sent.');
      }
      if (threadRef.current !== sentThread) return { sent: true };
      if (result.messageId !== id || typeof result.turnId !== 'string')
        throw new Error('The message could not be confirmed. Try sending it again.');
      const turnId = result.turnId;
      if (!privateVerification)
        captureAnalytics('otto_chat_message_sent', {
          has_attachments: attachments.length > 0,
          is_reply: Boolean(replyId),
        });
      const messageText =
        typeof result.messageText === 'string'
          ? result.messageText
          : privateVerification
            ? 'Verification code sent securely.'
            : message.text;
      retry.current = null;
      setOptimistic((current) =>
        current.map((item) =>
          item.message.id === id
            ? {
                ...item,
                message: {
                  ...item.message,
                  turnId,
                  text: messageText,
                },
              }
            : item,
        ),
      );
      void refresh().catch(() => {});
      return { sent: true };
    } catch (cause) {
      if (threadRef.current !== sentThread) return { sent: true };
      if (acknowledgedIds.current.has(id)) {
        retry.current = null;
        return { sent: true };
      }
      failed = true;
      retry.current =
        !privateVerification && signature !== null ? { id, threadId: sentThread, signature } : null;
      setOptimistic((current) => current.filter((item) => item.message.id !== id));
      setError(
        privateVerification
          ? attachments.length
            ? 'Send the verification code by itself, without attachments.'
            : verificationFailure(verificationStatus, verificationRequests.length > 1)
          : errorMessage(cause),
      );
      captureAnalytics('otto_ui_error', { area: 'chat', action: 'send' });
      return { sent: false, restoreText: !privateVerification };
    } finally {
      outstandingSends.current--;
      finished(!failed);
      if (failed && reply && sequence === sendCount.current)
        setReplyTo((current) => current ?? reply);
      if (threadRef.current === sentThread && --pendingSends.current === 0) {
        sendQueue.current = Promise.resolve(true);
        setSending(false);
      }
    }
  }
  useEffect(() => {
    if (
      !requestedMessage ||
      !state.configuration.llmReady ||
      resetting ||
      welcoming ||
      resetLock.current
    )
      return;
    if (handledRequest.current === requestedMessage.id) return;
    handledRequest.current = requestedMessage.id;
    onRequestHandled?.(requestedMessage.id);
    setReplyTo(null);
    const requestedThread = threadId;
    const request: { text: string; result?: ComposerSendResult } = {
      text: requestedMessage.text,
    };
    requestedSends.current.push(request);
    void send(requestedMessage.text, [], null).then((result) => {
      if (threadRef.current !== requestedThread) return;
      request.result = result;
      if (requestedSends.current.some((item) => !item.result)) return;
      const unsent = requestedSends.current
        .filter((item) => item.result && !item.result.sent && item.result.restoreText)
        .map((item) => item.text);
      requestedSends.current = [];
      if (unsent.length) setText((current) => [...unsent, current].filter(Boolean).join('\n\n'));
      composer.current?.focus();
    });
  }, [requestedMessage, state.configuration.llmReady, resetting, welcoming]);
  async function finishHandoff(messageId: string) {
    const sentThread = threadId;
    setReturningHandoff(messageId);
    try {
      const result = await send('Done, I finished in the browser.', []);
      if (!result.sent) throw new Error('Could not hand control back. Try Done again.');
    } finally {
      if (threadRef.current === sentThread) setReturningHandoff(null);
    }
  }
  async function history() {
    const version = ++historyVersion.current;
    setLoadingHistory(true);
    setError('');
    const first = persistedMessages[0];
    const height = scroll.current?.scrollHeight ?? 0;
    try {
      const before = first?.createdAt;
      const query = new URLSearchParams({
        threadId,
        ...(before ? { before } : {}),
        ...(first ? { beforeId: first.id } : {}),
      });
      const result = await api<MessageHistoryPage>(`/api/messages?${query}`);
      if (version !== historyVersion.current || threadRef.current !== threadId) return;
      setHistoryPage((current) => ({
        threadId,
        messages: [...result.messages, ...(current.threadId === threadId ? current.messages : [])],
        hasMore: result.hasMore,
      }));
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height;
      });
    } catch (cause) {
      if (version === historyVersion.current && threadRef.current === threadId)
        setError(errorMessage(cause));
    } finally {
      if (version === historyVersion.current) setLoadingHistory(false);
    }
  }
  function cancelReturn() {
    returning.current = 0;
  }
  function reportRead() {
    const element = scroll.current;
    if (
      !visible ||
      focusTarget ||
      !element ||
      !element.clientHeight ||
      !element.getClientRects().length ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus()
    )
      return;
    if (
      Array.from(
        document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
      ).some((dialog) => dialog.getClientRects().length)
    )
      return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2)
      onReadLatest?.(threadId);
  }
  function updateAway() {
    const element = scroll.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance >= 160 && Date.now() < returning.current) return;
    returning.current = 0;
    stickToBottom.current = distance < 160;
    const since = Date.parse(allMessages.at(-1)?.createdAt ?? '') || Date.now();
    setAway((current) => {
      if (distance < 160) return null;
      const shown = Boolean(current?.shown) || distance > element.clientHeight;
      return current?.shown === shown ? current : { since: current?.since ?? since, shown };
    });
    reportRead();
  }
  function updateActiveTurn() {
    const element = scroll.current;
    if (!element) return;
    const viewport = element.getBoundingClientRect();
    const anchor = viewport.top + Math.min(120, element.clientHeight * 0.25);
    const turns = Array.from(element.querySelectorAll<HTMLElement>('.message-user'));
    const positions = turns.map((turn) => ({
      id: turn.dataset.messageId!,
      top: turn.getBoundingClientRect().top,
    }));
    const visible = visibleConversationTurns(positions, viewport);
    setVisibleTurns((current) =>
      current.length === visible.length && current.every((id, index) => id === visible[index])
        ? current
        : visible,
    );
    const current =
      turns.filter((turn) => turn.getBoundingClientRect().top <= anchor).at(-1) ?? turns[0];
    setActiveTurn(current?.dataset.messageId ?? null);
    reportRead();
  }
  useEffect(() => {
    const frame = requestAnimationFrame(updateActiveTurn);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateActiveTurn);
    if (scroll.current) observer?.observe(scroll.current);
    if (scroll.current?.firstElementChild) observer?.observe(scroll.current.firstElementChild);
    window.addEventListener('resize', updateActiveTurn);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateActiveTurn);
    };
  }, [state.messages, historyPage, streams, optimistic, visible, onReadLatest, focusTarget]);
  async function clearMessages() {
    if (resetLock.current || !resetTarget || !state.configuration.conversationResetEnabled) return;
    resetLock.current = true;
    setResetting(true);
    setError('');
    try {
      const nextThread = await resetConversation(resetTarget);
      threadRef.current = nextThread;
      historyVersion.current++;
      setHistoryPage({ threadId: nextThread, messages: [] });
      setLoadingHistory(false);
      setReplyTo(null);
      setText('');
      setResetTarget(null);
      await refresh();
    } catch (cause) {
      setResetTarget(null);
      setError(errorMessage(cause));
    } finally {
      resetLock.current = false;
      setResetting(false);
    }
  }
  async function stop() {
    if (stopping) return;
    const captureAnalytics = analyticsForCurrentSession();
    const stoppedThread = threadId;
    setStopping(true);
    setError('');
    try {
      await post('/api/thread/stop');
      captureAnalytics('otto_chat_stop_requested');
      await refresh();
    } catch (cause) {
      if (threadRef.current === stoppedThread) setError(errorMessage(cause));
      captureAnalytics('otto_ui_error', { area: 'chat', action: 'stop' });
    } finally {
      if (threadRef.current === stoppedThread) setStopping(false);
    }
  }
  const chatActions = (
    <>
      {import.meta.env?.DEV === true && state.configuration.conversationResetEnabled && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={resetting || sending || welcoming}
          onClick={() => setResetTarget(threadId)}
        >
          <Trash2 size={16} aria-hidden="true" />
          Clear messages
        </Button>
      )}
      {onFeedback && (
        <FeedbackLauncher
          key={ownerId}
          ownerId={ownerId}
          visible={visible}
          onFeedback={onFeedback}
        />
      )}
    </>
  );
  return (
    <div className="chat-page">
      {desktopSettingsAvailable() ? (
        <>
          <h1 className="sr-only">Chat</h1>
          {toolbarActions && createPortal(chatActions, toolbarActions)}
        </>
      ) : (
        <header className="chat-report-action">
          <SidebarToggle />
          <h1 className="chat-title">Chat</h1>
          {chatActions}
        </header>
      )}
      <ChatTurnRail
        messages={allMessages}
        activeId={activeTurn}
        visibleIds={visibleTurns}
        onJump={(id) => {
          const target = Array.from(
            scroll.current?.querySelectorAll<HTMLElement>('.message-user') ?? [],
          ).find((element) => element.dataset.messageId === id);
          if (!target) return;
          stickToBottom.current = false;
          returning.current = 0;
          setActiveTurn(id);
          target.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
        }}
      />
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          updateActiveTurn();
          updateAway();
        }}
        onWheel={cancelReturn}
        onTouchStart={cancelReturn}
        onPointerDown={cancelReturn}
        onKeyDown={cancelReturn}
      >
        <div className="conversation-column">
          {loadingHistory ? (
            <div className="history-skeleton" role="status" aria-label="Loading earlier messages">
              <Skeleton className="ghost-bubble" style={{ width: 'min(240px, 50%)' }} />
              <div className="history-skeleton-reply">
                <div className="assistant-mark">
                  <BrandMark small />
                </div>
                <div className="skeleton-lines">
                  <Skeleton style={{ width: 'min(420px, 70%)' }} />
                  <Skeleton style={{ width: 'min(360px, 60%)' }} />
                  <Skeleton style={{ width: 'min(260px, 45%)' }} />
                </div>
              </div>
              <Skeleton className="ghost-bubble" style={{ width: 'min(180px, 36%)' }} />
            </div>
          ) : (
            persistedMessages.length > 0 &&
            hasEarlier && (
              <div className="history-control">
                <Button variant="ghost" size="sm" onClick={() => void history()}>
                  Load earlier messages
                </Button>
              </div>
            )
          )}
          {visibleMessages.length === 0 &&
            !welcoming &&
            !resetting &&
            !working &&
            !sending &&
            (state.configuration.llmReady ? <Welcome /> : <ModelSetup />)}
          <div
            className="messages"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions"
          >
            {visibleMessages.map((message, index) => (
              <Fragment key={message.streamId ?? message.id}>
                {(!index ||
                  !isSameDay(
                    visibleMessages[index - 1].createdAt,
                    message.createdAt,
                    dateFormat,
                  )) && (
                  <div className="day-divider">
                    <span>{formatDayLabel(message.createdAt, dateFormat)}</span>
                  </div>
                )}
                <MessageBubble
                  message={message}
                  connectedAppIds={connectedAppIds}
                  streaming={streamIds.has(message.streamId ?? '')}
                  inspectorEnabled={state.configuration.inspectorEnabled}
                  grouped={messagesAreGrouped(visibleMessages[index - 1], message, dateFormat)}
                  onHandoffDone={
                    message.id === returningHandoff ||
                    (message.id === handoffMessage?.id &&
                      message.role === 'assistant' &&
                      !working &&
                      !sending)
                      ? () => finishHandoff(message.id)
                      : undefined
                  }
                  onReply={
                    message.turnId || persistedIds.has(message.id)
                      ? () => {
                          setReplyTo(message);
                          composer.current?.focus();
                        }
                      : undefined
                  }
                />
              </Fragment>
            ))}
            {(sending || resetting || working || welcoming) && streamEntries.length === 0 && (
              <div
                className="thinking"
                role="status"
                aria-label={
                  resetting ? 'Starting setup' : sending ? 'Sending message' : 'Otto is typing'
                }
              >
                <div className="assistant-mark">
                  <BrandMark small />
                </div>
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
          <div ref={bottom} />
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        {away?.shown && (
          <Button
            className={`jump-latest${unseen ? ' has-unseen' : ''}`}
            variant="outline"
            size="sm"
            aria-label={
              unseen
                ? `Back to latest, ${unseen} new ${unseen === 1 ? 'reply' : 'replies'}`
                : 'Back to latest'
            }
            onClick={() => {
              stickToBottom.current = true;
              returning.current = Date.now() + 1000;
              setAway(null);
              bottom.current?.scrollIntoView({ block: 'end', behavior: scrollBehavior() });
            }}
          >
            <ArrowDown size={16} />
            {unseen
              ? `${unseen > 99 ? '99+' : unseen} new ${unseen === 1 ? 'reply' : 'replies'}`
              : 'Back to latest'}
          </Button>
        )}
        {away?.shown && <div className="jump-latest-fade" aria-hidden="true" />}
        {error && <Notice>{error}</Notice>}
        {connectionNotice && (
          <Notice kind={connectionNotice.kind} onDismiss={() => setConnectionNotice(null)}>
            {connectionNotice.text}
          </Notice>
        )}
        <div hidden={!state.configuration.llmReady && !working && !sending}>
          <ModelPicker />
          <Composer
            key={threadId}
            ref={composer}
            ready={state.configuration.llmReady && !resetting && !welcoming}
            text={text}
            setText={setText}
            replyTo={replyTo}
            clearReply={() => setReplyTo(null)}
            onSend={send}
            onStop={working ? () => void stop() : undefined}
            stopping={stopping}
          />
        </div>
        {!state.configuration.llmReady && !working && !sending && visibleMessages.length > 0 && (
          <ModelSetup />
        )}
      </div>
      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <DialogTitle>Clear messages?</DialogTitle>
          <DialogDescription>
            This starts an empty chat and stops its running tasks.
          </DialogDescription>
          <div className="dialog-actions">
            <Button variant="outline" disabled={resetting} onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={resetting} onClick={() => void clearMessages()}>
              {resetting ? 'Clearing…' : 'Clear messages'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
