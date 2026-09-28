import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
import type { AppState, Artifact, Message, SubmitMessageResponse } from '../../shared/contracts';
import { integrationServices } from '../../shared/integrations';
import { Composer, type ComposerHandle, type ComposerSendResult } from '../components/composer';
import { MessageBubble } from '../components/message';
import { ChatTurnRail } from '../components/chat-turn-rail';
import { BrandMark } from '../components/brand';
import { Button, Notice } from '../components/ui';
import { api, apiResponse, errorMessage, post } from '../lib/api';
import {
  hasVisibleChatActivity,
  messagesAreGrouped,
  visibleConversationTurns,
} from '../lib/chat-messages';

function dayLabel(date: string) {
  const value = new Date(date);
  const today = new Date();
  if (value.toDateString() === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  if (value.toDateString() === today.toDateString()) return 'Yesterday';
  return value.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    year: value.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}
function verificationFailure(
  status: SubmitMessageResponse['verificationStatus'],
  ambiguous: boolean,
) {
  if (ambiguous)
    return 'More than one sign-in needs a code. Reply to the verification request you want to complete.';
  if (status === 'rejected')
    return 'That verification code was not accepted. Check the code and try again.';
  if (status === 'unavailable')
    return 'That verification request is no longer available. Wait for a new code request.';
  return 'The verification code could not be confirmed. Check the sign-in request and try again.';
}
export function Chat({
  state,
  streams,
  refresh,
  resetConversation,
  composerDraft,
}: {
  state: AppState;
  streams: Record<string, string>;
  refresh(): Promise<void>;
  resetConversation(): Promise<number>;
  composerDraft?: { text: string; nonce: number };
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [optimistic, setOptimistic] = useState<Array<{ revision: number; message: Message }>>([]);
  const composer = useRef<ComposerHandle>(null);
  const sendLock = useRef<{ id: string; revision: number } | null>(null);
  const retry = useRef<{ id: string; revision: number; signature: string } | null>(null);
  const historyVersion = useRef(0);
  const revision = state.conversationRevision ?? 0;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const [historyPage, setHistoryPage] = useState<{ revision: number; messages: Message[] }>({
    revision,
    messages: [],
  });
  const older = historyPage.revision === revision ? historyPage.messages : [];
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [visibleTurns, setVisibleTurns] = useState<string[]>([]);
  const [scrolledUp, setScrolledUp] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const resetLock = useRef(false);
  const setupAction = useRef(() => {});
  const streamTimes = useRef(new Map<string, string>());
  const persistedMessages = [
    ...older.filter((item) => !state.messages.some((message) => message.id === item.id)),
    ...state.messages,
  ];
  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const acknowledgedIds = useRef(persistedIds);
  acknowledgedIds.current = persistedIds;
  const allMessages = [
    ...persistedMessages,
    ...optimistic
      .filter((item) => item.revision === revision && !persistedIds.has(item.message.id))
      .map((item) => item.message),
  ];
  const working = hasVisibleChatActivity(state.tasks);
  const persistedStreams = new Set(allMessages.map((message) => message.streamId).filter(Boolean));
  const streamEntries = Object.entries(streams).filter(
    ([id, value]) => value && !persistedStreams.has(id),
  );
  const streamIds = new Set(streamEntries.map(([id]) => id));
  for (const id of streamTimes.current.keys())
    if (!streamIds.has(id)) streamTimes.current.delete(id);
  const visibleMessages: Message[] = [
    ...allMessages,
    ...streamEntries.map(([id, value]): Message => {
      if (!streamTimes.current.has(id)) streamTimes.current.set(id, new Date().toISOString());
      return {
        id,
        streamId: id,
        role: 'assistant',
        text: value,
        taskId: null,
        attachments: [],
        createdAt: streamTimes.current.get(id)!,
      };
    }),
  ];
  const onboardingVisible = allMessages.length === 0 && !working && !resetting;
  useLayoutEffect(() => {
    if (stickToBottom.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [state.messages, streams, sending, resetting, optimistic]);
  useEffect(() => {
    const ids = new Set(state.messages.map((message) => message.id));
    setOptimistic((current) => {
      const next = current.filter(
        (item) => item.revision === revision && !ids.has(item.message.id),
      );
      return next.length === current.length ? current : next;
    });
  }, [state.messages, revision]);
  useEffect(() => {
    historyVersion.current++;
    setHistoryPage({ revision, messages: [] });
    setLoadingHistory(false);
    setHasEarlier(true);
    setActiveTurn(null);
    setVisibleTurns([]);
    setScrolledUp(false);
    setReplyTo(null);
    setOptimistic([]);
    sendLock.current = null;
    retry.current = null;
    setText('');
    setSending(false);
    setError('');
    stickToBottom.current = true;
  }, [revision]);
  useEffect(() => {
    const restart = () => setupAction.current();
    window.addEventListener('otto:restart-setup', restart);
    return () => window.removeEventListener('otto:restart-setup', restart);
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('connection');
    if (!outcome) return;
    const slug = url.searchParams.get('service');
    const name =
      slug && Object.hasOwn(integrationServices, slug)
        ? integrationServices[slug as keyof typeof integrationServices].name
        : 'App';
    setConnectionNotice(
      outcome === 'continued' || outcome === 'connected'
        ? ''
        : outcome === 'cancelled'
          ? `${name} connection cancelled. You can try again in chat or Apps.`
          : `${name} could not connect. Try again in chat or Apps.`,
    );
    url.searchParams.delete('connection');
    url.searchParams.delete('service');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    if (!composerDraft) return;
    setText(composerDraft.text);
    requestAnimationFrame(() => composer.current?.focus());
  }, [composerDraft]);
  useEffect(() => {
    const compose = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      if (typeof detail?.text !== 'string') return;
      setText(detail.text);
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener('otto:compose', compose);
    return () => window.removeEventListener('otto:compose', compose);
  }, []);
  async function send(value: string, attachments: Artifact[]): Promise<ComposerSendResult> {
    if (sendLock.current || resetLock.current) return { sent: false, restoreText: true };
    const sentRevision = revision;
    const reply = replyTo;
    const verificationRequests = (state.verificationRequests ?? []).filter(
      (request) =>
        Date.parse(request.expiresAt) > Date.now() && (!reply || request.taskId === reply.taskId),
    );
    let privateVerification = /^\d{4,8}$/.test(value.trim()) && verificationRequests.length > 0;
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
      retry.current?.revision === sentRevision &&
      retry.current.signature === signature
        ? retry.current.id
        : crypto.randomUUID();
    sendLock.current = { id, revision: sentRevision };
    const message: Message = {
      id,
      role: 'user',
      text: privateVerification ? 'Verification code sent securely.' : value,
      attachments,
      taskId: null,
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
      { revision: sentRevision, message },
    ]);
    historyVersion.current++;
    setLoadingHistory(false);
    setSending(true);
    setError('');
    stickToBottom.current = true;
    const replyId = reply?.id;
    try {
      const response = await apiResponse('/api/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationRevision: sentRevision,
          clientMessageId: id,
          text: value,
          attachmentIds: attachments.map((item) => item.id),
          ...(replyId ? { replyToMessageId: replyId } : {}),
          ...(verificationRequestId ? { verificationRequestId } : {}),
        }),
      });
      const result = (await response.json()) as Partial<SubmitMessageResponse> & { error?: string };
      verificationStatus = result.verificationStatus;
      privateVerification ||= verificationStatus !== undefined;
      if (!response.ok) {
        throw new Error(result.error || 'The message could not be sent.');
      }
      if (revisionRef.current !== sentRevision) return { sent: true };
      if (result.messageId !== id || typeof result.taskId !== 'string')
        throw new Error('The message could not be confirmed. Try sending it again.');
      const taskId = result.taskId;
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
                  taskId,
                  text: messageText,
                },
              }
            : item,
        ),
      );
      setReplyTo((current) => (current?.id === replyId ? null : current));
      void refresh().catch(() => {});
      return { sent: true };
    } catch (cause) {
      if (revisionRef.current !== sentRevision) return { sent: true };
      if (acknowledgedIds.current.has(id)) {
        retry.current = null;
        setReplyTo((current) => (current?.id === replyId ? null : current));
        return { sent: true };
      }
      retry.current =
        !privateVerification && signature !== null
          ? { id, revision: sentRevision, signature }
          : null;
      setOptimistic((current) => current.filter((item) => item.message.id !== id));
      setError(
        privateVerification
          ? attachments.length
            ? 'Send the verification code by itself, without attachments.'
            : verificationFailure(verificationStatus, verificationRequests.length > 1)
          : errorMessage(cause),
      );
      return { sent: false, restoreText: !privateVerification };
    } finally {
      if (sendLock.current?.id === id && sendLock.current.revision === sentRevision) {
        sendLock.current = null;
        if (revisionRef.current === sentRevision) setSending(false);
      }
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
        conversationRevision: String(revision),
        ...(before ? { before } : {}),
        ...(first ? { beforeId: first.id } : {}),
      });
      const result = await api<Message[]>(`/api/messages?${query}`);
      if (version !== historyVersion.current || revisionRef.current !== revision) return;
      setHistoryPage((current) => ({
        revision,
        messages: [...result, ...(current.revision === revision ? current.messages : [])],
      }));
      setHasEarlier(result.length === 60);
      requestAnimationFrame(() => {
        if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height;
      });
    } catch (cause) {
      if (version === historyVersion.current && revisionRef.current === revision)
        setError(errorMessage(cause));
    } finally {
      if (version === historyVersion.current) setLoadingHistory(false);
    }
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
  }, [state.messages, historyPage, streams, optimistic]);
  async function startOnboarding() {
    if (resetLock.current || !state.configuration.llmReady) return;
    resetLock.current = true;
    setResetting(true);
    setError('');
    try {
      const conversationRevision = await resetConversation();
      revisionRef.current = conversationRevision;
      historyVersion.current++;
      setHistoryPage({ revision: conversationRevision, messages: [] });
      setLoadingHistory(false);
      setReplyTo(null);
      setText('');
      await post('/api/onboarding', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        conversationRevision,
      });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      resetLock.current = false;
      setResetting(false);
    }
  }
  setupAction.current = () => void startOnboarding();
  return (
    <div className="chat-page">
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
          setScrolledUp(true);
          setActiveTurn(id);
          target.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'instant'
              : 'smooth',
          });
        }}
      />
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element) {
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 160;
            setScrolledUp(!stickToBottom.current);
            updateActiveTurn();
          }
        }}
      >
        <div className="conversation-column">
          {persistedMessages.length > 0 && hasEarlier && (
            <div className="history-control">
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingHistory}
                onClick={() => void history()}
              >
                {loadingHistory ? 'Loading…' : 'Load earlier messages'}
              </Button>
            </div>
          )}
          {visibleMessages.length === 0 && (
            <div className="welcome">
              <BrandMark />
              <h1>What’s on your mind?</h1>
              <div className="starter-actions">
                {['Plan my day', 'Help me research something', 'Start a goal'].map((label) => (
                  <button
                    key={label}
                    onClick={() => {
                      setText(label);
                      composer.current?.focus();
                    }}
                  >
                    {label}
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          )}
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
                  new Date(visibleMessages[index - 1].createdAt).toDateString() !==
                    new Date(message.createdAt).toDateString()) && (
                  <div className="day-divider">
                    <span>{dayLabel(message.createdAt)}</span>
                  </div>
                )}
                <MessageBubble
                  message={message}
                  streaming={streamIds.has(message.streamId ?? '')}
                  inspectorEnabled={state.configuration.inspectorEnabled}
                  grouped={messagesAreGrouped(visibleMessages[index - 1], message)}
                  showTimestamp={
                    !streamIds.has(message.streamId ?? '') &&
                    !messagesAreGrouped(message, visibleMessages[index + 1])
                  }
                  onReply={
                    message.taskId || persistedIds.has(message.id)
                      ? () => {
                          setReplyTo(message);
                          composer.current?.focus();
                        }
                      : undefined
                  }
                />
              </Fragment>
            ))}
            {(sending || resetting || working) && streamEntries.length === 0 && (
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
          {onboardingVisible && (
            <section className="onboarding-card">
              <div>
                <h2>Make Otto yours.</h2>
                <p>Connect your tools and pick something to work on.</p>
              </div>
              <Button
                variant="outline"
                disabled={sending || resetting || !state.configuration.llmReady}
                onClick={() => window.dispatchEvent(new CustomEvent('otto:restart-setup'))}
              >
                Get started
                <ArrowUpRight size={15} />
              </Button>
            </section>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        {scrolledUp && (
          <Button
            className="jump-latest"
            variant="outline"
            size="sm"
            onClick={() => {
              historyVersion.current++;
              setLoadingHistory(false);
              setHasEarlier(true);
              stickToBottom.current = true;
              requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
            }}
          >
            <ArrowDown size={14} />
            Back to latest
          </Button>
        )}
        {error && <Notice>{error}</Notice>}
        {connectionNotice && <Notice kind="info">{connectionNotice}</Notice>}
        {!state.configuration.llmReady && (
          <Notice kind="info">
            The assistant isn’t connected yet. Check the development setup.
          </Notice>
        )}
        <Composer
          key={revision}
          ref={composer}
          ready={state.configuration.llmReady && !resetting}
          sending={sending || resetting}
          text={text}
          setText={setText}
          replyTo={replyTo}
          clearReply={() => setReplyTo(null)}
          onSend={send}
        />
      </div>
    </div>
  );
}
