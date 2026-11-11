import { Tooltip } from '../components/tooltip';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ArrowDown, Check, CornerUpLeft, LoaderCircle, Repeat } from '../components/icons';
import type {
  Activity,
  AppState,
  Artifact,
  Connection,
  Message,
  MessageHistoryPage,
  SubmitMessageResponse,
} from '../../shared/contracts';
import type { SuggestedTask, TaskSuggestions } from '../../shared/onboarding';
import type { TrustView } from '../../shared/trust';
import type { QuestionAnswer } from '../../shared/answer-choices';
import { integrationMetadata, integrationServices } from '../../shared/integrations';
import { moreIdeasLine } from '../../shared/sender-apps';
import { presentationText } from '../../shared/presentation';
import { classifyVerificationReply, securityCodeIn } from '../../shared/verification-code';
import { ChatTools } from '../components/chat-tools';
import { ServiceLogo } from '../components/service-logo';
import { Composer, type ComposerHandle, type ComposerSendResult } from '../components/composer';
import { TaskCard } from './tasks';
import { MessageBubble } from '../components/message';
import { conversationFiles } from '../components/attachment-card';
import { ArtifactWorkspace } from '../components/artifact-drawer';
import { PrivateEntryWorkspace } from '../components/private-entry';
import { ChatNotifications } from '../components/chat-notifications';
import { BrandMark } from '../components/brand';
import { FeedbackLauncher } from '../components/feedback-discovery';
import { Button, Notice } from '../components/ui';
import { desktopSettingsAvailable } from '../lib/desktop';
import { usePageData } from '../hooks/use-page-data';
import { api, apiResponse, ApiError, errorMessage, post } from '../lib/api';
import { analyticsForCurrentSession, captureAnalytics } from '../lib/analytics';
import {
  collapseScreenshotMessages,
  mergeMessages,
  messagesAreGrouped,
  suggestedTaskStatus,
} from '../lib/chat-messages';
import { formatDayLabel, isSameDay, useDateFormat } from '../lib/date-format';
import { NodGlyph, Rise, prefersReducedMotion } from '../components/motion';
import { LiveLine } from '../components/live-line';
import { TaskDots } from '../components/task-dots';
import { recordingSource } from '../lib/recording';
import { money } from '../lib/money';
import type { ImagePreview } from '../components/attachment-images';
import { reuseFile } from '../components/file-actions';
import { ownedArtifactUrl } from '../lib/attachment-url';
import {
  hasUnreadHistory,
  loadUnreadChatBoundary,
  unreadChatMessageIds,
  type ChatReadCursor,
} from '../lib/chat-unread';

type ComposerReply = NonNullable<Message['replyTo']> & { answerQuestion?: true };
type UnreadVisit = {
  ownerId: string;
  threadId: string;
  hiddenCount: number;
  cursor: ChatReadCursor | null;
  messages: Message[];
  hasEarlier: boolean;
  messageId?: string | null;
};

function verificationFailure(
  status: SubmitMessageResponse['verificationStatus'],
  ambiguous: boolean,
) {
  if (ambiguous)
    return 'More than one sign-in needs a code. Reply to the verification request you want to complete.';
  if (status === 'unavailable')
    return 'The result could not be confirmed. Check the sign-in or payment before trying again.';
  return 'The verification code could not be confirmed. Check the sign-in request and try again.';
}
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
function scrollPosition(element: HTMLElement | null) {
  const viewport = element?.getBoundingClientRect();
  const anchor =
    element &&
    Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (message) => message.getBoundingClientRect().bottom > viewport!.top,
    );
  return {
    top: element?.scrollTop ?? 0,
    id: anchor?.dataset.messageId,
    offset: anchor && viewport ? anchor.getBoundingClientRect().top - viewport.top : 0,
  };
}
function restoreScrollPosition(element: HTMLElement, position: ReturnType<typeof scrollPosition>) {
  const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    (message) => message.dataset.messageId === position.id,
  );
  if (anchor)
    element.scrollTop +=
      anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset;
  else element.scrollTop = position.top;
}
function atOrBefore(
  message: Pick<Message, 'id' | 'createdAt'>,
  boundary: Pick<Message, 'id' | 'createdAt'>,
) {
  const difference = Date.parse(message.createdAt) - Date.parse(boundary.createdAt);
  return difference < 0 || (difference === 0 && message.id <= boundary.id);
}
function Welcome() {
  return (
    <div className="welcome">
      <BrandMark />
      <h2>What’s on your mind?</h2>
    </div>
  );
}
function Working({
  items = [],
  label,
  sending = false,
  writing = false,
  quiet = true,
}: {
  items?: Activity[];
  label?: string;
  sending?: boolean;
  writing?: boolean;
  quiet?: boolean;
}) {
  const found = writing ? undefined : items.find((item) => !item.background && !item.taskId);
  const chat = found?.doing === 'queued' ? undefined : found;
  const thinking = Boolean(found) || (sending && !writing);
  const receipt = items.some((item) => !item.background && item.received)
    ? 'Got your message. I’ll read it after this step.'
    : null;
  if (!thinking && !label && !receipt) return null;
  return (
    <div className="thinking" role="status">
      <NodGlyph size={28} mode="thinking" />
      <div className="working-details">
        <span className="working-text">
          {thinking ? <LiveLine item={chat} quiet={quiet} /> : (label ?? receipt)}
        </span>
        {thinking && receipt && <span className="working-receipt">{receipt}</span>}
      </div>
    </div>
  );
}

function TaskCards({
  id,
  grouped,
  suggestions,
  connections,
  status,
  disabled,
  onStart,
}: {
  id: string;
  grouped: boolean;
  suggestions: TaskSuggestions;
  connections: Connection[];
  status(task: SuggestedTask): 'idle' | 'working' | 'needs_you' | 'waiting' | 'sent' | 'done';
  disabled: boolean;
  onStart(task: SuggestedTask, position: number): void;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const learned = suggestions.tasks.filter((task) => task.origin !== 'common');
  const common = suggestions.tasks.filter((task) => task.origin === 'common');
  const seen = (suggestions.apps ?? []).filter(
    (slug) => !connections.some((entry) => entry.slug === slug && entry.status === 'connected'),
  );
  const card = (task: SuggestedTask, index: number) => {
    const state = status(task);
    const connection = connections.find((entry) => entry.slug === task.source);
    const label =
      state === 'working'
        ? 'On it…'
        : state === 'needs_you'
          ? 'Waiting for you'
          : state === 'waiting'
            ? 'Waiting'
            : state === 'sent'
              ? 'Request sent'
              : task.kind === 'ongoing'
                ? 'Set up'
                : 'Done';
    return (
      <Rise key={task.id} show={shown} index={index} className="task-card-rise">
        <button
          type="button"
          className="task-card"
          data-state={state}
          disabled={disabled || state !== 'idle'}
          onClick={() => onStart(task, suggestions.tasks.indexOf(task))}
        >
          <span className="task-title">{task.title}</span>
          {(task.source !== 'web' || task.kind === 'ongoing' || state !== 'idle') && (
            <span className="task-meta">
              {task.source !== 'web' && (
                <Tooltip
                  content={
                    task.source === 'telegram'
                      ? 'Telegram'
                      : integrationMetadata(task.source, connection).name
                  }
                >
                  <span className="task-card-logo">
                    <ServiceLogo
                      slug={task.source}
                      logoUrl={
                        task.source === 'telegram' ? '/logos/telegram.svg' : connection?.logoUrl
                      }
                      connectionId={connection?.connectionId}
                      size={16}
                    />
                    <span className="sr-only">
                      {task.source === 'telegram'
                        ? 'Telegram'
                        : integrationMetadata(task.source, connection).name}
                    </span>
                  </span>
                </Tooltip>
              )}
              {task.source !== 'web' && task.kind === 'ongoing' && (
                <span className="task-dot" aria-hidden="true" />
              )}
              {task.kind === 'ongoing' && (
                <>
                  <Repeat size={12} aria-hidden="true" />
                  Repeats
                </>
              )}
              {state !== 'idle' && (
                <>
                  {(task.source !== 'web' || task.kind === 'ongoing') && (
                    <span className="task-dot" aria-hidden="true" />
                  )}
                  <span className="task-state">
                    {state === 'working' ? (
                      <LoaderCircle size={12} className="spin" aria-hidden="true" />
                    ) : state === 'done' || state === 'sent' ? (
                      <Check size={12} aria-hidden="true" />
                    ) : null}
                    {label}
                  </span>
                </>
              )}
            </span>
          )}
        </button>
        <span className="sr-only" aria-live="polite">
          {state === 'idle' ? '' : `${task.title}: ${label}`}
        </span>
      </Rise>
    );
  };
  return (
    <article
      className={`message message-assistant${grouped ? ' message-grouped' : ''}`}
      aria-label="Nod"
      data-message-id={id}
      tabIndex={-1}
    >
      <div className="task-suggestions">
        <p className="task-bubble">{suggestions.intro}</p>
        <div className="task-cards">{learned.map(card)}</div>
        {common.length > 0 && (
          <div className="task-cards task-cards-common">
            {common.map((task, index) => card(task, learned.length + index))}
          </div>
        )}
        <Rise show={shown} index={suggestions.tasks.length} className="task-follow-up">
          <p className="task-bubble">{moreIdeasLine(seen)}</p>
        </Rise>
      </div>
    </article>
  );
}
export function Chat({
  ownerId,
  state,
  streams,
  connected = true,
  refresh,
  initialFocusMessageId,
  toolbarActions,
  visible = true,
  readCursor,
  readUnavailable = false,
  onReadLatest,
  requestedMessage,
  onRequestHandled,
  onFeedback,
  onDismissFeedbackDiscovery,
  onReturnToMemory,
}: {
  ownerId: string;
  state: AppState;
  streams: Record<string, string>;
  connected?: boolean;
  refresh(): Promise<void>;
  initialFocusMessageId?: string;
  toolbarActions?: HTMLElement | null;
  visible?: boolean;
  readCursor?: ChatReadCursor | null;
  readUnavailable?: boolean;
  onReadLatest?(threadId: string): void;
  requestedMessage?: { id: string; text: string };
  onRequestHandled?(id: string): void;
  onFeedback?(): void;
  onDismissFeedbackDiscovery?(): void;
  onReturnToMemory?(): void;
}) {
  const dateFormat = useDateFormat();
  const { data: connections } = usePageData<Connection[]>('/api/apps');
  const { data: trust, refresh: refreshTrust } = usePageData<TrustView>('/api/trust');
  const trustRefreshKey = state.turns.map((turn) => `${turn.id}:${turn.status}`).join(',');
  const spendingPaused = trust?.limit?.reached === true;
  const modelSetup = (
    <div className="welcome model-setup">
      <BrandMark />
      <h2>
        {state.configuration.modelReconnect
          ? 'Reconnect your model to keep chatting'
          : 'Choose a model to start chatting'}
      </h2>
      <Button variant="outline" asChild>
        <a href="/settings/models">Open Settings &gt; Models</a>
      </Button>
    </div>
  );
  useEffect(() => {
    void refreshTrust();
    if (!spendingPaused) return;
    const timer = window.setInterval(() => void refreshTrust(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshTrust, spendingPaused, trustRefreshKey]);
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
  const [error, setError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState<{
    text: string;
    kind: 'success' | 'error';
  } | null>(null);
  const [replyTo, setReplyTo] = useState<ComposerReply | null | undefined>(null);
  const [replyNotice, setReplyNotice] = useState('');
  const [unavailableQuestions, setUnavailableQuestions] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setReplyNotice(''), [text, replyTo?.id]);
  const taskReply = useRef<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{
    id: string;
    pages: number;
    taskId?: string;
  } | null>(() => (initialFocusMessageId ? { id: initialFocusMessageId, pages: 0 } : null));
  const [optimistic, setOptimistic] = useState<
    Array<{ threadId: string; message: Message; audio?: ImagePreview }>
  >([]);
  const audioPreviews = useRef(new Map<string, string>());
  const [stopping, setStopping] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const sendQueue = useRef(Promise.resolve(true));
  const sendCount = useRef(0);
  const pendingSends = useRef(0);
  const outstandingSends = useRef(0);
  const retry = useRef<{
    id: string;
    threadId: string;
    signature: string;
    plainSignature: string;
    replyId?: string;
    retired?: boolean;
    warned?: boolean;
    recording?: File;
    body?: string;
  } | null>(null);
  const recordingIds = useRef(new WeakMap<File, string>());
  const handledRequest = useRef<string | null>(null);
  const requestedSends = useRef<Array<{ text: string; result?: ComposerSendResult }>>([]);
  const historyVersion = useRef(0);
  const threadId = state.threadId;
  const hiddenCount = state.hiddenMessageCount ?? state.hiddenMessageIds?.length ?? 0;
  const hiddenIds = useMemo(() => new Set(state.hiddenMessageIds ?? []), [state.hiddenMessageIds]);
  const hiddenMessageIds = useRef<ReadonlySet<string>>(hiddenIds);
  hiddenMessageIds.current = hiddenIds;
  const activeReplySends = useRef(new Map<string, Set<{ retired: boolean }>>());
  function retireReplyTarget(id: string) {
    for (const send of activeReplySends.current.get(id) ?? []) send.retired = true;
    if (taskReply.current === id) taskReply.current = null;
    if (retry.current?.replyId === id)
      retry.current = {
        ...retry.current,
        replyId: undefined,
        body: undefined,
        retired: true,
      };
    setReplyTo((current) => (current?.id === id ? null : current));
    setOptimistic((current) => {
      const next = current.map((item) =>
        item.threadId === threadId && item.message.replyTo?.id === id
          ? { ...item, message: { ...item.message, replyTo: undefined } }
          : item,
      );
      return next.some((item, index) => item !== current[index]) ? next : current;
    });
  }
  useLayoutEffect(() => {
    const hidden = hiddenMessageIds.current;
    const targets = new Set([
      replyTo?.id,
      taskReply.current,
      retry.current?.replyId,
      ...optimistic
        .filter((item) => item.threadId === threadId)
        .map((item) => item.message.replyTo?.id),
    ]);
    for (const id of targets) if (id && hidden.has(id)) retireReplyTarget(id);
  }, [replyTo?.id, hiddenIds, optimistic, threadId]);
  const chatVisible = useRef(visible);
  chatVisible.current = visible;
  const preserveUnreadPosition = useRef(false);
  if (!visible) preserveUnreadPosition.current = false;
  const [foreground, setForeground] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus(),
  );
  useEffect(() => {
    const update = () => {
      const active = document.visibilityState === 'visible' && document.hasFocus();
      if (!active)
        preserveUnreadPosition.current =
          chatVisible.current && (!stickToBottom.current || Boolean(composer.current?.hasDraft()));
      setForeground(active);
    };
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const retainedUnreadVisit = useRef<UnreadVisit | null>(null);
  const unreadVisit = useMemo(() => {
    const previous = retainedUnreadVisit.current;
    if (!visible || readCursor === undefined) return null;
    if (
      previous?.ownerId === ownerId &&
      previous.threadId === threadId &&
      previous.hiddenCount === hiddenCount
    ) {
      if (previous.messageId || !foreground) return previous;
    }
    const visit: UnreadVisit | null = foreground
      ? {
          ownerId,
          threadId,
          hiddenCount,
          cursor: readCursor,
          messages: state.messages,
          hasEarlier: state.hasEarlierMessages === true,
        }
      : null;
    return visit;
  }, [ownerId, threadId, visible, foreground, readCursor !== undefined, hiddenCount]);
  retainedUnreadVisit.current = unreadVisit;
  if (unreadVisit && !unreadVisit.cursor && readCursor) unreadVisit.cursor = readCursor;
  const currentUnreadVisit = useRef(unreadVisit);
  currentUnreadVisit.current = unreadVisit;
  const unreadPositioned = useRef<typeof unreadVisit | 'target'>(
    initialFocusMessageId ? 'target' : null,
  );
  const [unreadHistory, setUnreadHistory] = useState<{
    visit: NonNullable<typeof unreadVisit>;
    messageId: string | null;
  } | null>(null);
  const [unreadFailure, setUnreadFailure] = useState<{
    visit: NonNullable<typeof unreadVisit>;
    error: string;
  } | null>(null);
  const [unreadAttempt, setUnreadAttempt] = useState(0);
  const unreadBoundary =
    unreadHistory?.visit === unreadVisit
      ? unreadHistory.messageId
      : unreadVisit?.cursor &&
          !hasUnreadHistory(unreadVisit.messages, unreadVisit.hasEarlier, unreadVisit.cursor)
        ? (unreadChatMessageIds(unreadVisit.messages, unreadVisit.cursor).values().next().value ??
          null)
        : undefined;
  if (unreadVisit && unreadBoundary !== undefined) unreadVisit.messageId = unreadBoundary;
  const unreadPending = !!unreadVisit && unreadBoundary === undefined && !readUnavailable;
  const unreadError = unreadFailure?.visit === unreadVisit ? unreadFailure.error : '';
  const unreadDivider = useRef<HTMLDivElement>(null);
  const initializedThread = useRef(threadId);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const [historyPage, setHistoryPage] = useState<{
    threadId: string;
    epoch: number;
    messages: Message[];
    hasMore?: boolean;
  }>({
    threadId,
    epoch: 0,
    messages: [],
  });
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyRequest = useRef<{
    version: number;
    cursor: string;
    controller: AbortController;
  } | null>(null);
  const historyReload = useRef<{ epoch: number; controller: AbortController } | null>(null);
  const historyCursor = useRef<string | null>(null);
  const historyAnchor = useRef<{
    version: number;
    position: ReturnType<typeof scrollPosition>;
    height: number;
    following: boolean;
  } | null>(null);
  const focusLoading = useRef(false);
  const [away, setAway] = useState<{ since: number } | null>(null);
  const returning = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const returnPosition = useRef<ReturnType<typeof scrollPosition> | null>(null);
  const focusRequest = useRef(0);
  const [canReturn, setCanReturn] = useState(false);
  const stickToBottom = useRef(true);
  const scrollSize = useRef({ content: 0, viewport: 0 });
  const latestScrollUpdate = useRef(updateAway);
  latestScrollUpdate.current = updateAway;
  const streamTimes = useRef(new Map<string, string>());
  const known = useRef<{ threadId: string; messages: Message[] }>({ threadId, messages: [] });
  const hiddenHistory = useRef<{
    threadId: string;
    count: number;
    epoch: number;
    oldest: Pick<Message, 'id' | 'createdAt'> | null;
  }>({ threadId, count: hiddenCount, epoch: 0, oldest: null });
  if (hiddenHistory.current.threadId !== threadId)
    hiddenHistory.current = { threadId, count: hiddenCount, epoch: 0, oldest: null };
  else if (hiddenHistory.current.count !== hiddenCount) {
    const capped = hiddenCount > (state.hiddenMessageIds?.length ?? 0);
    const currentIds = new Set(state.messages.map((message) => message.id));
    hiddenHistory.current = {
      ...hiddenHistory.current,
      count: hiddenCount,
      ...(capped
        ? {
            epoch: hiddenHistory.current.epoch + 1,
            oldest:
              known.current.threadId === threadId
                ? (known.current.messages.find((message) => !currentIds.has(message.id)) ?? null)
                : null,
          }
        : {}),
    };
    if (capped) known.current = { threadId, messages: [] };
  }
  const historyEpoch = hiddenHistory.current.epoch;
  const [failedReplyValidation, setFailedReplyValidation] = useState<{
    threadId: string;
    epoch: number;
    id: string;
  } | null>(null);
  const replyValidationFailed = (id: string) =>
    failedReplyValidation?.threadId === threadId &&
    failedReplyValidation.epoch === historyEpoch &&
    failedReplyValidation.id === id;
  const [confirmedReplyTargets, setConfirmedReplyTargets] = useState<{
    threadId: string;
    epoch: number;
    ids: ReadonlySet<string>;
  }>({ threadId, epoch: historyEpoch, ids: new Set() });
  const confirmedTargetIds =
    confirmedReplyTargets.threadId === threadId && confirmedReplyTargets.epoch === historyEpoch
      ? confirmedReplyTargets.ids
      : new Set<string>();
  const activeHistoryPage =
    historyPage.threadId === threadId && historyPage.epoch === historyEpoch ? historyPage : null;
  const hasEarlier = activeHistoryPage?.hasMore ?? state.hasEarlierMessages === true;
  const persistedMessages = useMemo(() => {
    const merged = mergeMessages(
      known.current.threadId === threadId ? known.current.messages : [],
      [...(activeHistoryPage?.messages ?? []), ...state.messages],
      hiddenIds,
    );
    const pending = state.pendingAnswerChoiceMessageIds
      ? new Set(state.pendingAnswerChoiceMessageIds)
      : null;
    const messages = merged.map((message) =>
      message.answerChoices
        ? {
            ...message,
            answerChoicesPending:
              !unavailableQuestions.has(message.id) &&
              (pending ? pending.has(message.id) : message.answerChoicesPending),
          }
        : message,
    );
    known.current = { threadId, messages };
    return messages;
  }, [
    threadId,
    historyPage,
    historyEpoch,
    state.messages,
    hiddenIds,
    state.pendingAnswerChoiceMessageIds,
    unavailableQuestions,
  ]);
  const persistedIds = new Set(persistedMessages.map((message) => message.id));
  const targetValidation = useRef({
    capped: hiddenCount > (state.hiddenMessageIds?.length ?? 0),
    persistedIds,
    confirmedTargetIds,
  });
  targetValidation.current = {
    capped: hiddenCount > (state.hiddenMessageIds?.length ?? 0),
    persistedIds,
    confirmedTargetIds,
  };
  const replyNeedsValidation = (id: string) =>
    targetValidation.current.capped &&
    !targetValidation.current.persistedIds.has(id) &&
    !targetValidation.current.confirmedTargetIds.has(id) &&
    !hiddenMessageIds.current.has(id);
  function confirmReplyTarget(id: string, epoch: number) {
    if (threadRef.current !== threadId || hiddenHistory.current.epoch !== epoch) return;
    if (targetValidation.current.confirmedTargetIds.has(id)) return;
    const confirmedTargetIds = new Set(targetValidation.current.confirmedTargetIds);
    confirmedTargetIds.add(id);
    const active = new Set([
      replyTo?.id,
      taskReply.current,
      retry.current?.replyId,
      focusTarget?.id,
      ...optimistic
        .filter((item) => item.threadId === threadId)
        .map((item) => item.message.replyToMessageId),
      ...activeReplySends.current.keys(),
    ]);
    for (const candidate of confirmedTargetIds) {
      if (confirmedTargetIds.size <= 150) break;
      if (!active.has(candidate)) confirmedTargetIds.delete(candidate);
    }
    targetValidation.current = { ...targetValidation.current, confirmedTargetIds };
    setConfirmedReplyTargets({ threadId, epoch, ids: confirmedTargetIds });
  }
  const acknowledgedIds = useRef(persistedIds);
  acknowledgedIds.current = persistedIds;
  const retiredHistoryEpoch = useRef({ threadId, epoch: historyEpoch });
  useLayoutEffect(() => {
    if (
      retiredHistoryEpoch.current.threadId === threadId &&
      retiredHistoryEpoch.current.epoch === historyEpoch
    )
      return;
    retiredHistoryEpoch.current = { threadId, epoch: historyEpoch };
    if (historyEpoch === 0) return;
    setUnreadHistory(null);
    setUnreadFailure(null);
  }, [threadId, historyEpoch]);
  const allMessages = [
    ...persistedMessages,
    ...optimistic
      .filter((item) => item.threadId === threadId && !persistedIds.has(item.message.id))
      .map((item) =>
        item.message.replyToMessageId &&
        (hiddenMessageIds.current.has(item.message.replyToMessageId) ||
          replyNeedsValidation(item.message.replyToMessageId))
          ? { ...item.message, replyTo: undefined }
          : item.message,
      ),
  ];
  const live = state.activity ?? [];
  const working = live.some((item) => !item.background);
  const chatWork = connected ? live.find((item) => !item.background && !item.taskId) : undefined;
  const lastChatWork = useRef<{ threadId: string; item: Activity } | null>(null);
  if (chatWork) lastChatWork.current = { threadId, item: chatWork };
  const finishing = lastChatWork.current?.threadId === threadId ? lastChatWork.current.item : null;
  const finishingTurn = finishing && state.turns.find((turn) => turn.id === finishing.turnId);
  const [expiredTurn, setExpiredTurn] = useState<string | null>(null);
  const holding = Boolean(
    connected &&
    !stopping &&
    !chatWork &&
    finishing &&
    expiredTurn !== finishing.turnId &&
    (finishingTurn?.status === 'queued' || finishingTurn?.status === 'running') &&
    !allMessages.some(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === finishing.turnId &&
        Date.parse(message.createdAt) >= Date.parse(finishing.quietSince),
    ),
  );
  useLayoutEffect(() => {
    if (!chatWork && !holding) lastChatWork.current = null;
  });
  useEffect(() => {
    if (!holding || !finishing) return;
    const turnId = finishing.turnId;
    const timer = window.setTimeout(() => setExpiredTurn(turnId), 6000);
    return () => window.clearTimeout(timer);
  }, [holding, finishing?.turnId]);
  const [welcoming, setWelcoming] = useState(
    () => allMessages.length === 0 && !working && state.configuration.llmReady,
  );
  const introduction = usePageData<{ messageId: string | null }>('/api/onboarding/introduction');
  useEffect(() => {
    if (!welcoming) return;
    void post('/api/account/welcome', {})
      .then(() => {
        void introduction.refresh();
        return refresh();
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setWelcoming(false));
  }, []);
  const persistedStreams = new Set(allMessages.map((message) => message.streamId).filter(Boolean));
  const streamEntries = Object.entries(streams).filter(
    ([id, value]) => value && !persistedStreams.has(id),
  );
  const streamIds = new Set(streamEntries.map(([id]) => id));
  const arrivals = useRef({ threadId, keys: new Set<string>() });
  if (arrivals.current.threadId !== threadId) arrivals.current = { threadId, keys: new Set() };
  const arriving = (message: Message) => {
    const key = message.streamId ?? message.id;
    if (
      message.role === 'assistant' &&
      (streamIds.has(key) ||
        (finishing &&
          message.turnId === finishing.turnId &&
          Date.parse(message.createdAt) >= Date.parse(finishing.since)))
    )
      arrivals.current.keys.add(key);
    return arrivals.current.keys.has(key);
  };
  for (const id of streamTimes.current.keys())
    if (!streamIds.has(id)) streamTimes.current.delete(id);
  const displayMessages: Message[] = [
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
  ];
  const unreadIndex = displayMessages.findIndex((message) => message.id === unreadBoundary);
  const visibleMessages =
    unreadIndex > 0
      ? [
          ...collapseScreenshotMessages(displayMessages.slice(0, unreadIndex)),
          ...collapseScreenshotMessages(displayMessages.slice(unreadIndex)),
        ]
      : collapseScreenshotMessages(displayMessages);
  const fileKey = visibleMessages
    .map(
      (message) =>
        `${message.id}:${JSON.stringify(message.presentation ?? null)}:${message.attachments.map((file) => file.id).join(',')}`,
    )
    .join(';');
  const files = useMemo(() => conversationFiles(visibleMessages), [fileKey]);
  const planning =
    state.planningTasks === true && !allMessages.some((message) => message.suggestions);
  const unseen = away
    ? persistedMessages.filter(
        (message) => message.role === 'assistant' && Date.parse(message.createdAt) > away.since,
      ).length
    : 0;
  useLayoutEffect(() => {
    const element = scroll.current;
    const page = element?.parentElement;
    if (!element || !page) return;
    const update = () =>
      page.style.setProperty(
        '--chat-scrollbar-width',
        `${Math.max(0, element.offsetWidth - element.clientWidth)}px`,
      );
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [visible]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const element = scroll.current;
    historyAnchor.current = null;
    if (!anchor || !element || anchor.version !== historyVersion.current) return;
    if (anchor.following || returning.current) element.scrollTop = element.scrollHeight;
    else
      restoreScrollPosition(element, {
        ...anchor.position,
        top: anchor.position.top + element.scrollHeight - anchor.height,
      });
    scrollSize.current = { content: element.scrollHeight, viewport: element.clientHeight };
    updateAway();
  }, [historyPage]);
  useLayoutEffect(() => {
    if (!foreground) return;
    if (
      unreadVisit &&
      (readUnavailable || preserveUnreadPosition.current || unreadPositioned.current === 'target')
    ) {
      unreadPositioned.current = unreadVisit;
      return;
    }
    if (
      !unreadVisit ||
      unreadPending ||
      unreadPositioned.current === unreadVisit ||
      focusTarget ||
      focusLoading.current
    )
      return;
    unreadPositioned.current = unreadVisit;
    if (unreadBoundary && unreadDivider.current) {
      stickToBottom.current = false;
      unreadDivider.current.scrollIntoView({ block: 'start', behavior: 'instant' });
      updateAway();
    }
  }, [
    unreadVisit,
    unreadBoundary,
    unreadPending,
    historyPage,
    focusTarget,
    readUnavailable,
    foreground,
  ]);
  useLayoutEffect(() => {
    if (unreadPending && unreadPositioned.current !== unreadVisit) return;
    if (stickToBottom.current && !window.getSelection()?.toString())
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
    else updateAway();
    reportRead();
  }, [
    state.messages,
    state.activity,
    holding,
    streams,
    sending,
    optimistic,
    visible,
    focusTarget,
    unreadPending,
  ]);
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
    const retained = new Set(
      optimistic.flatMap((item) =>
        item.threadId === threadId && item.audio ? [item.audio.url] : [],
      ),
    );
    for (const [id, url] of audioPreviews.current) {
      if (retained.has(url)) continue;
      URL.revokeObjectURL(url);
      audioPreviews.current.delete(id);
    }
  }, [optimistic, threadId]);
  useEffect(
    () => () => {
      for (const url of audioPreviews.current.values()) URL.revokeObjectURL(url);
      audioPreviews.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (initializedThread.current === threadId) return;
    initializedThread.current = threadId;
    returnPosition.current = null;
    focusRequest.current++;
    setCanReturn(false);
    historyVersion.current++;
    cancelHistory();
    historyReload.current?.controller.abort();
    historyReload.current = null;
    historyCursor.current = null;
    focusLoading.current = false;
    setHistoryError('');
    setHistoryPage({ threadId, epoch: historyEpoch, messages: [] });
    setLoadingHistory(false);
    setAway(null);
    setReplyTo(null);
    setUnavailableQuestions(new Set());
    setOptimistic([]);
    sendQueue.current = Promise.resolve(true);
    pendingSends.current = 0;
    retry.current = null;
    requestedSends.current = [];
    setText('');
    setSending(false);
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
    const notice = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener('nod:file-notice', notice);
    return () => window.removeEventListener('nod:file-notice', notice);
  }, []);
  useEffect(() => {
    const focusMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: unknown; taskId?: unknown }>).detail;
      if (typeof detail?.messageId === 'string') {
        unreadPositioned.current = 'target';
        returnPosition.current = scrollPosition(scroll.current);
        cancelHistory();
        setFocusTarget(null);
        focusLoading.current = true;
        setCanReturn(true);
        const expectedThread = threadRef.current;
        const expectedEpoch = hiddenHistory.current.epoch;
        const version = ++focusRequest.current;
        const id = detail.messageId;
        const taskId = typeof detail.taskId === 'string' ? detail.taskId : undefined;
        void api<Message[]>(`/api/messages/around/${id}`)
          .then((messages) => {
            if (
              expectedThread !== threadRef.current ||
              expectedEpoch !== hiddenHistory.current.epoch ||
              version !== focusRequest.current
            )
              return;
            focusLoading.current = false;
            setHistoryPage((current) => ({
              threadId: expectedThread,
              epoch: expectedEpoch,
              messages: mergeMessages(
                current.threadId === expectedThread && current.epoch === expectedEpoch
                  ? current.messages
                  : [],
                messages,
                hiddenMessageIds.current,
              ),
              hasMore:
                current.threadId === expectedThread && current.epoch === expectedEpoch
                  ? current.hasMore
                  : undefined,
            }));
            setFocusTarget({ id, pages: 0, taskId });
          })
          .catch((cause) => {
            if (
              expectedThread === threadRef.current &&
              expectedEpoch === hiddenHistory.current.epoch &&
              version === focusRequest.current
            ) {
              focusLoading.current = false;
              setError(errorMessage(cause));
            }
          });
      }
    };
    window.addEventListener('nod:focus-message', focusMessage);
    return () => window.removeEventListener('nod:focus-message', focusMessage);
  }, []);
  useEffect(() => {
    const openTask = (event: Event) => {
      const id = (event as CustomEvent<{ taskId?: unknown }>).detail?.taskId;
      const element = scroll.current;
      const card = Array.from(element?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []).find(
        (item) => item.dataset.taskId === id,
      );
      if (!element || !card?.getClientRects().length) return;
      const view = element.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      if (box.top >= view.top && box.bottom <= view.bottom) return;
      stickToBottom.current = false;
      card.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    };
    window.addEventListener('nod:open-task', openTask);
    return () => window.removeEventListener('nod:open-task', openTask);
  }, []);
  useEffect(() => {
    if (!visible || !focusTarget || loadingHistory) return;
    if (hiddenIds.has(focusTarget.id)) {
      setFocusTarget(null);
      setCanReturn(false);
      returnPosition.current = null;
      return;
    }
    if (replyNeedsValidation(focusTarget.id)) return;
    if (focusTarget.pages && historyError) {
      setFocusTarget(null);
      return;
    }
    const target = Array.from(
      scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
    ).find((element) => element.dataset.messageId === focusTarget.id);
    if (target) {
      stickToBottom.current = false;
      const version = focusRequest.current;
      const { taskId } = focusTarget;
      requestAnimationFrame(() => {
        if (version !== focusRequest.current || !target.isConnected) return;
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.focus({ preventScroll: true });
        target.classList.add('message-focused');
        setTimeout(() => target.classList.remove('message-focused'), 1600);
        setFocusTarget(null);
        if (taskId)
          window.dispatchEvent(
            new CustomEvent('nod:open-task', { detail: { taskId }, cancelable: true }),
          );
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
  }, [focusTarget, loadingHistory, historyPage, hasEarlier, historyError, visible]);
  async function send(
    value: string,
    attachments: Artifact[],
    reply: ComposerReply | null | undefined = replyTo,
    source: 'composer' | 'task_card' | 'ask_nod' | 'task_reply' | 'answer_choice' = reply &&
    reply.id === taskReply.current
      ? 'task_reply'
      : 'composer',
    recording?: File,
    questionAnswer?: QuestionAnswer,
    displayText?: string,
  ): Promise<ComposerSendResult & { error?: string; questionUnavailable?: true }> {
    if (welcoming) return { sent: false, restoreText: true };
    unreadPositioned.current = currentUnreadVisit.current;
    const replyId = reply?.id;
    questionAnswer ??=
      reply &&
      !unavailableQuestions.has(reply.id) &&
      (reply.answerQuestion ||
        allMessages.some((message) => message.id === replyId && message.answerChoicesPending) ||
        state.pendingAnswerChoiceMessageIds?.includes(reply.id))
        ? { custom: true }
        : undefined;
    const directAnswer = source === 'answer_choice';
    const captureAnalytics = analyticsForCurrentSession();
    const sentThread = threadId;
    const activeReply = { retired: false };
    const replyRetired = () => activeReply.retired;
    const verificationRequests = (
      questionAnswer && 'choiceIds' in questionAnswer ? [] : (state.verificationRequests ?? [])
    ).filter(
      (request) =>
        !reply || request.turnId === allMessages.find((message) => message.id === replyId)?.turnId,
    );
    const explicitVerification =
      classifyVerificationReply(value).kind !== 'ordinary' || Boolean(securityCodeIn(value));
    let privateVerification =
      (classifyVerificationReply(value).kind !== 'ordinary' &&
        verificationRequests.some((request) => request.kind === 'otp')) ||
      (Boolean(securityCodeIn(value)) &&
        verificationRequests.some((request) => request.kind === 'payment'));
    const verificationRequestId =
      privateVerification && verificationRequests.length === 1
        ? verificationRequests[0].id
        : undefined;
    let verificationStatus: SubmitMessageResponse['verificationStatus'];
    const masked = verificationRequests.every((request) => request.kind === 'payment')
      ? 'Security code sent securely.'
      : 'Verification code sent securely.';
    const recordingKey = recording && recordingSource(recording);
    if (recordingKey && !recordingIds.current.has(recordingKey))
      recordingIds.current.set(recordingKey, crypto.randomUUID());
    const attachmentIds = attachments.map((item) => item.id);
    const recordingId = recordingKey ? recordingIds.current.get(recordingKey) : null;
    const plainSignature = privateVerification
      ? null
      : JSON.stringify([value, attachmentIds, null, null, false, recordingId, null, displayText]);
    const signature = privateVerification
      ? null
      : JSON.stringify([
          value,
          attachmentIds,
          reply?.id ?? null,
          reply?.text ?? null,
          reply?.isQuote === true,
          recordingId,
          questionAnswer ?? null,
          displayText,
        ]);
    if (privateVerification) retry.current = null;
    const unresolvedReply =
      !reply &&
      retry.current?.threadId === sentThread &&
      (retry.current.replyId || retry.current.retired)
        ? retry.current
        : null;
    if (unresolvedReply) {
      if (acknowledgedIds.current.has(unresolvedReply.id) || unresolvedReply.warned)
        retry.current = null;
      else {
        retry.current = { ...unresolvedReply, warned: true };
        setError(
          'The previous reply may have been sent. Check this chat before sending a new message.',
        );
        return { sent: false, restoreText: true, restoreRecording: true };
      }
    }
    const previousAttempt =
      signature !== null &&
      retry.current?.threadId === sentThread &&
      retry.current.retired !== true &&
      retry.current.signature === signature
        ? retry.current
        : null;
    const id = previousAttempt?.id ?? crypto.randomUUID();
    const submittedRecording = previousAttempt?.recording ?? recording;
    let audio: ImagePreview | undefined;
    if (submittedRecording && !privateVerification) {
      const previousUrl = audioPreviews.current.get(id);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      const url = URL.createObjectURL(submittedRecording);
      audioPreviews.current.set(id, url);
      audio = {
        id,
        name: submittedRecording.name,
        mimeType: submittedRecording.type,
        size: submittedRecording.size,
        url,
      };
    }
    const previous = sendQueue.current;
    let finished!: (sent: boolean) => void;
    sendQueue.current = new Promise<boolean>((resolve) => {
      finished = resolve;
    });
    const sequence = ++sendCount.current;
    pendingSends.current++;
    outstandingSends.current++;
    let failed = false;
    let retryableFailure = false;
    let questionUnavailable = false;
    let replyUnavailable = false;
    let responseConflict = false;
    let submittedBody = previousAttempt?.body;
    if (reply && !directAnswer) {
      taskReply.current = null;
      setReplyTo(null);
    }
    const message: Message = {
      id,
      role: 'user',
      text: privateVerification ? masked : value,
      ...(!privateVerification && displayText ? { displayText } : {}),
      attachments,
      turnId: null,
      createdAt: new Date().toISOString(),
      ...(reply
        ? {
            replyToMessageId: reply.id,
            replyTo: { id: reply.id, role: reply.role, text: reply.text, isQuote: reply.isQuote },
          }
        : {}),
    };
    setOptimistic((current) => [
      ...current.filter((item) => item.message.id !== id),
      { threadId: sentThread, message, audio },
    ]);
    historyVersion.current++;
    setLoadingHistory(false);
    setSending(true);
    if (!directAnswer) setError('');
    stickToBottom.current = true;
    const seenMessageId = persistedMessages.findLast((item) => item.role === 'assistant')?.id;
    if (replyId) {
      const sends = activeReplySends.current.get(replyId) ?? new Set<{ retired: boolean }>();
      sends.add(activeReply);
      activeReplySends.current.set(replyId, sends);
    }
    try {
      if (!(await previous)) {
        failed = true;
        setOptimistic((current) => current.filter((item) => item.message.id !== id));
        return {
          sent: false,
          restoreText: !privateVerification || !explicitVerification,
          restoreRecording: !privateVerification,
        };
      }
      if (replyId && (hiddenMessageIds.current.has(replyId) || replyRetired())) {
        failed = true;
        retry.current = previousAttempt
          ? { ...previousAttempt, replyId: undefined, body: undefined, retired: true }
          : null;
        setOptimistic((current) => current.filter((item) => item.message.id !== id));
        setError('The reply is unavailable in this conversation.');
        return {
          sent: false,
          restoreText: !privateVerification || !explicitVerification,
          restoreRecording: !privateVerification,
        };
      }
      if (replyId && replyNeedsValidation(replyId)) {
        const expectedEpoch = hiddenHistory.current.epoch;
        try {
          const nearby = await api<Message[]>(
            `/api/messages/around/${encodeURIComponent(replyId)}`,
            { signal: AbortSignal.timeout(15_000) },
          );
          if (threadRef.current !== sentThread) return { sent: true };
          if (hiddenHistory.current.epoch !== expectedEpoch) {
            failed = true;
            setOptimistic((current) => current.filter((item) => item.message.id !== id));
            setError('The reply changed while sending. Try again.');
            return { sent: false, restoreText: true, restoreRecording: true };
          }
          if (!nearby.some((message) => message.id === replyId)) {
            replyUnavailable = true;
            retireReplyTarget(replyId);
          } else confirmReplyTarget(replyId, expectedEpoch);
        } catch (cause) {
          if (threadRef.current !== sentThread) return { sent: true };
          if (cause instanceof ApiError && cause.status === 404) {
            replyUnavailable = true;
            retireReplyTarget(replyId);
          } else setError(errorMessage(cause));
          failed = true;
          setOptimistic((current) => current.filter((item) => item.message.id !== id));
          if (replyUnavailable) setError('The reply is unavailable in this conversation.');
          return { sent: false, restoreText: true, restoreRecording: true };
        }
        if (replyUnavailable) {
          failed = true;
          setOptimistic((current) => current.filter((item) => item.message.id !== id));
          setError('The reply is unavailable in this conversation.');
          return { sent: false, restoreText: true, restoreRecording: true };
        }
      }
      const messageBody =
        submittedBody ??
        JSON.stringify({
          threadId: sentThread,
          clientMessageId: id,
          text: value,
          ...(displayText ? { displayText } : {}),
          attachmentIds,
          ...(replyId
            ? {
                replyToMessageId: replyId,
                ...(reply?.isQuote ? { replyQuote: reply.text.slice(0, 4000) } : {}),
              }
            : {}),
          ...(seenMessageId ? { seenMessageId } : {}),
          ...(verificationRequestId ? { verificationRequestId } : {}),
          ...(questionAnswer ? { questionAnswer } : {}),
        });
      submittedBody = messageBody;
      let body: string | FormData = messageBody;
      if (submittedRecording) {
        body = new FormData();
        body.append('message', messageBody);
        body.append('file', submittedRecording);
      }
      const response = await apiResponse(recording ? '/api/messages/audio' : '/api/messages', {
        method: 'POST',
        credentials: 'same-origin',
        headers: recording ? undefined : { 'Content-Type': 'application/json' },
        body,
      });
      const result = (await response.json()) as Partial<SubmitMessageResponse> & {
        error?: string;
        attachments?: Artifact[];
        retryable?: boolean;
        code?: string;
      };
      verificationStatus = result.verificationStatus;
      privateVerification ||= verificationStatus !== undefined;
      if (!response.ok) {
        retryableFailure = result.retryable === true;
        responseConflict = response.status === 409;
        replyUnavailable =
          Boolean(replyId) &&
          (response.status === 404 ||
            (response.status === 400 &&
              result.error === 'The reply is unavailable in this conversation.'));
        questionUnavailable =
          response.status === 409 &&
          result.code === 'question_unavailable' &&
          Boolean(questionAnswer && replyId) &&
          !privateVerification;
        if (response.status === 409 && verificationStatus === undefined)
          void refresh().catch(() => {});
        throw new Error(result.error || 'The message could not be sent.');
      }
      if (threadRef.current !== sentThread) return { sent: true };
      if (result.messageId !== id || typeof result.turnId !== 'string')
        throw new Error('The message could not be confirmed. Try sending it again.');
      const turnId = result.turnId;
      if (!privateVerification)
        captureAnalytics('chat_message_sent', {
          has_attachments: attachments.length > 0 || Boolean(recording),
          input: recording ? 'voice' : 'text',
          is_reply: Boolean(replyId),
          source,
        });
      const messageText =
        typeof result.messageText === 'string'
          ? result.messageText
          : privateVerification
            ? masked
            : message.text;
      retry.current = null;
      setOptimistic((current) =>
        current.map((item) =>
          item.message.id === id
            ? {
                ...item,
                audio:
                  privateVerification ||
                  result.attachments?.some((attachment) => attachment.mimeType.startsWith('audio/'))
                    ? undefined
                    : item.audio,
                message: {
                  ...item.message,
                  turnId,
                  text: messageText,
                  ...(privateVerification
                    ? { displayText: undefined }
                    : typeof result.displayText === 'string'
                      ? { displayText: result.displayText }
                      : {}),
                  ...(typeof result.audioCaption === 'string'
                    ? { audioCaption: result.audioCaption }
                    : {}),
                  ...(result.attachments ? { attachments: result.attachments } : {}),
                },
              }
            : item,
        ),
      );
      if (verificationStatus === 'unavailable')
        setError(verificationFailure(verificationStatus, false));
      await refresh().catch(() => {});
      return { sent: true };
    } catch (cause) {
      if (threadRef.current !== sentThread) return { sent: true };
      const acknowledged = acknowledgedIds.current.has(id);
      if (acknowledged && !responseConflict) {
        retry.current = null;
        return { sent: true };
      }
      failed = true;
      const retiredReply = Boolean(
        replyId && (replyUnavailable || hiddenMessageIds.current.has(replyId) || replyRetired()),
      );
      if (questionUnavailable && replyId && !retiredReply) {
        retry.current = null;
        setOptimistic((current) => current.filter((item) => item.message.id !== id));
        setUnavailableQuestions((current) => new Set([...current, replyId]));
        if (reply) reply = { ...reply, answerQuestion: undefined };
        setReplyTo((current) =>
          current?.id === replyId ? { ...current, answerQuestion: undefined } : current,
        );
        return {
          sent: false,
          restoreText: true,
          restoreRecording: true,
          questionUnavailable: true,
        };
      }
      if (retryableFailure && recordingKey && !retiredReply)
        recordingIds.current.delete(recordingKey);
      if (retiredReply && replyId) retireReplyTarget(replyId);
      retry.current =
        responseConflict && acknowledged
          ? null
          : retiredReply &&
              !replyUnavailable &&
              !questionUnavailable &&
              !privateVerification &&
              signature !== null &&
              plainSignature !== null &&
              submittedBody
            ? {
                id,
                threadId: sentThread,
                signature,
                plainSignature,
                retired: true,
                recording: submittedRecording,
              }
            : !retiredReply &&
                !privateVerification &&
                !retryableFailure &&
                signature !== null &&
                plainSignature !== null &&
                submittedBody
              ? {
                  id,
                  threadId: sentThread,
                  signature,
                  plainSignature,
                  replyId,
                  recording: submittedRecording,
                  body: submittedBody,
                }
              : null;
      setOptimistic((current) => current.filter((item) => item.message.id !== id));
      const failure = privateVerification
        ? attachments.length
          ? 'Send the verification code by itself, without attachments.'
          : verificationFailure(verificationStatus, verificationRequests.length > 1)
        : errorMessage(cause);
      if (!directAnswer) setError(failure);
      captureAnalytics('ui_error', { area: 'chat', action: 'send' });
      return {
        sent: false,
        restoreText: !privateVerification || !explicitVerification,
        restoreRecording: !privateVerification,
        error: failure,
      };
    } finally {
      if (replyId) {
        const sends = activeReplySends.current.get(replyId);
        sends?.delete(activeReply);
        if (!sends?.size) activeReplySends.current.delete(replyId);
      }
      outstandingSends.current--;
      finished(!failed);
      if (
        failed &&
        reply &&
        !directAnswer &&
        !replyUnavailable &&
        !hiddenMessageIds.current.has(reply.id) &&
        !replyRetired() &&
        sequence === sendCount.current
      )
        setReplyTo((current) => current ?? reply);
      if (threadRef.current === sentThread && --pendingSends.current === 0) {
        sendQueue.current = Promise.resolve(true);
        setSending(false);
      }
    }
  }
  useEffect(() => {
    if (!requestedMessage || !state.configuration.llmReady || welcoming) return;
    if (handledRequest.current === requestedMessage.id) return;
    handledRequest.current = requestedMessage.id;
    onRequestHandled?.(requestedMessage.id);
    setReplyTo(null);
    const requestedThread = threadId;
    const request: { text: string; result?: ComposerSendResult } = {
      text: requestedMessage.text,
    };
    requestedSends.current.push(request);
    void send(requestedMessage.text, [], null, 'ask_nod').then((result) => {
      if (threadRef.current !== requestedThread) return;
      request.result = result;
      if (requestedSends.current.some((item) => !item.result)) return;
      const unsent = requestedSends.current
        .filter((item) => item.result && !item.result.sent && item.result.restoreText)
        .map((item) => item.text);
      requestedSends.current = [];
      if (unsent.length) {
        const restored = unsent.join('\n\n');
        if (!composer.current?.prependText(restored))
          setText((current) => [restored, current].filter(Boolean).join('\n\n'));
      }
      composer.current?.focus();
    });
  }, [requestedMessage, state.configuration.llmReady, welcoming]);
  function cancelHistory() {
    const request = historyRequest.current;
    if (!request) return;
    request.controller.abort();
    historyRequest.current = null;
    if (historyCursor.current === request.cursor) historyCursor.current = null;
    historyAnchor.current = null;
    setLoadingHistory(false);
  }
  useEffect(() => {
    if (historyEpoch === 0 || hiddenHistory.current.threadId !== threadId) return;
    historyVersion.current++;
    cancelHistory();
    historyReload.current?.controller.abort();
    historyReload.current = null;
    historyCursor.current = null;
    historyAnchor.current = null;
    focusRequest.current++;
    focusLoading.current = false;
    setHistoryError('');
    setHistoryPage({ threadId, epoch: historyEpoch, messages: [] });
    const oldest = hiddenHistory.current.oldest;
    if (!oldest) return;
    const controller = new AbortController();
    const request = { epoch: historyEpoch, controller };
    historyReload.current = request;
    setLoadingHistory(true);
    void (async () => {
      let before = state.messages[0];
      let messages: Message[] = [];
      let hasMore = false;
      for (let page = 0; before && page < 5; page++) {
        const query = new URLSearchParams({
          threadId,
          before: before.createdAt,
          beforeId: before.id,
        });
        const result = await api<MessageHistoryPage>(`/api/messages?${query}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || hiddenHistory.current.epoch !== historyEpoch) return;
        messages = mergeMessages(messages, result.messages, hiddenMessageIds.current);
        hasMore = result.hasMore;
        const first = messages[0];
        if (!first || !hasMore || atOrBefore(first, oldest) || atOrBefore(before, first)) break;
        before = first;
      }
      if (controller.signal.aborted || hiddenHistory.current.epoch !== historyEpoch) return;
      setHistoryPage((current) => ({
        threadId,
        epoch: historyEpoch,
        messages: mergeMessages(
          current.threadId === threadId && current.epoch === historyEpoch ? current.messages : [],
          messages,
          hiddenMessageIds.current,
        ),
        hasMore,
      }));
    })()
      .catch((cause) => {
        if (!controller.signal.aborted && hiddenHistory.current.epoch === historyEpoch)
          setHistoryError(errorMessage(cause));
      })
      .finally(() => {
        if (historyReload.current !== request) return;
        historyReload.current = null;
        if (hiddenHistory.current.epoch === historyEpoch) setLoadingHistory(false);
      });
    return () => controller.abort();
  }, [historyEpoch, threadId]);
  useEffect(() => {
    if (hiddenCount <= (state.hiddenMessageIds?.length ?? 0)) return;
    const targets = new Set([
      replyTo?.id,
      taskReply.current,
      retry.current?.replyId,
      focusTarget?.id,
      ...optimistic
        .filter((item) => item.threadId === threadId)
        .map((item) => item.message.replyTo?.id),
    ]);
    const unchecked = [...targets].filter((id): id is string =>
      Boolean(id && replyNeedsValidation(id) && !replyValidationFailed(id)),
    );
    if (!unchecked.length) return;
    const controller = new AbortController();
    const focusVersion = focusRequest.current;
    for (const id of unchecked)
      void api<Message[]>(`/api/messages/around/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      })
        .then((messages) => {
          if (
            controller.signal.aborted ||
            threadRef.current !== threadId ||
            hiddenHistory.current.epoch !== historyEpoch
          )
            return;
          if (!messages.some((message) => message.id === id)) {
            retireReplyTarget(id);
            return;
          }
          confirmReplyTarget(id, historyEpoch);
          if (
            (focusTarget?.id === id && focusRequest.current === focusVersion) ||
            replyTo?.id === id
          )
            setHistoryPage((current) => ({
              threadId,
              epoch: historyEpoch,
              messages: mergeMessages(
                current.threadId === threadId && current.epoch === historyEpoch
                  ? current.messages
                  : [],
                messages,
                hiddenMessageIds.current,
              ),
              hasMore:
                current.threadId === threadId && current.epoch === historyEpoch
                  ? current.hasMore
                  : undefined,
            }));
        })
        .catch((cause) => {
          if (
            controller.signal.aborted ||
            threadRef.current !== threadId ||
            hiddenHistory.current.epoch !== historyEpoch
          )
            return;
          if (cause instanceof ApiError && cause.status === 404) {
            retireReplyTarget(id);
            if (focusTarget?.id === id && focusRequest.current === focusVersion) {
              setFocusTarget((current) => (current?.id === id ? null : current));
              setCanReturn(false);
              returnPosition.current = null;
            }
          } else {
            if (replyTo?.id === id) setFailedReplyValidation({ threadId, epoch: historyEpoch, id });
            if (focusTarget?.id === id && focusRequest.current === focusVersion) {
              setFocusTarget((current) => (current?.id === id ? null : current));
              setError(errorMessage(cause));
            }
          }
        });
    return () => controller.abort();
  }, [
    threadId,
    hiddenCount,
    historyEpoch,
    replyTo?.id,
    failedReplyValidation,
    retry.current?.replyId,
    focusTarget?.id,
    optimistic,
  ]);
  useEffect(() => {
    if (!foreground || !unreadVisit?.cursor || !unreadPending || unreadError) return;
    cancelHistory();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const epoch = historyEpoch;
    void loadUnreadChatBoundary(
      unreadVisit.messages,
      unreadVisit.hasEarlier,
      unreadVisit.cursor,
      (before, signal) => {
        const query = new URLSearchParams({
          threadId,
          before: before.createdAt,
          beforeId: before.id,
        });
        return api<MessageHistoryPage>(`/api/messages?${query}`, { signal });
      },
      signal,
    )
      .then((result) => {
        if (
          controller.signal.aborted ||
          currentUnreadVisit.current !== unreadVisit ||
          hiddenHistory.current.epoch !== epoch
        )
          return;
        const element = scroll.current;
        if (element)
          historyAnchor.current = {
            version: historyVersion.current,
            position: scrollPosition(element),
            height: element.scrollHeight,
            following: stickToBottom.current,
          };
        flushSync(() => {
          setHistoryPage((current) => {
            const previous =
              current.threadId === threadId && current.epoch === epoch ? current.messages : [];
            const messages = mergeMessages(previous, result.messages, hiddenMessageIds.current);
            return {
              threadId,
              epoch,
              messages,
              hasMore:
                messages[0]?.id === result.messages[0]?.id
                  ? result.hasMore
                  : current.threadId === threadId && current.epoch === epoch
                    ? current.hasMore
                    : undefined,
            };
          });
          setUnreadHistory({ visit: unreadVisit, messageId: result.messageId });
        });
      })
      .catch((cause) => {
        if (
          !controller.signal.aborted &&
          currentUnreadVisit.current === unreadVisit &&
          hiddenHistory.current.epoch === epoch
        )
          setUnreadFailure({ visit: unreadVisit, error: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [
    unreadVisit,
    unreadVisit?.cursor,
    unreadPending,
    unreadError,
    unreadAttempt,
    foreground,
    historyEpoch,
  ]);
  useEffect(() => {
    if (!visible || historyRequest.current?.version !== historyVersion.current) cancelHistory();
  });
  useEffect(() => {
    const changed = () => {
      if (document.visibilityState !== 'visible') cancelHistory();
      else latestScrollUpdate.current();
    };
    document.addEventListener('visibilitychange', changed);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      historyRequest.current?.controller.abort();
      historyRequest.current = null;
    };
  }, []);
  async function history(retryHistory = false) {
    const first = persistedMessages[0];
    const element = scroll.current;
    if (
      !visible ||
      !hasEarlier ||
      !first ||
      !element?.clientHeight ||
      !element.getClientRects().length ||
      document.visibilityState !== 'visible' ||
      historyRequest.current ||
      historyReload.current ||
      historyPage.epoch !== historyEpoch
    )
      return;
    const cursor = `${threadId}:${first.createdAt}:${first.id}`;
    if (!retryHistory && (historyError || historyCursor.current === cursor)) return;
    const request = {
      version: ++historyVersion.current,
      cursor,
      controller: new AbortController(),
    };
    const epoch = historyEpoch;
    historyRequest.current = request;
    historyCursor.current = cursor;
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const query = new URLSearchParams({ threadId, before: first.createdAt, beforeId: first.id });
      const result = await api<MessageHistoryPage>(`/api/messages?${query}`, {
        signal: request.controller.signal,
      });
      if (
        request.controller.signal.aborted ||
        request.version !== historyVersion.current ||
        hiddenHistory.current.epoch !== epoch ||
        threadRef.current !== threadId
      )
        return;
      historyAnchor.current = {
        version: request.version,
        position: scrollPosition(element),
        height: element.scrollHeight,
        following: stickToBottom.current,
      };
      const progressed =
        mergeMessages(persistedMessages, result.messages, hiddenMessageIds.current)[0]?.id !==
        first.id;
      historyRequest.current = null;
      flushSync(() => {
        setHistoryPage((current) => ({
          threadId,
          epoch,
          messages: mergeMessages(
            current.threadId === threadId && current.epoch === epoch ? current.messages : [],
            result.messages,
            hiddenMessageIds.current,
          ),
          hasMore: result.hasMore && progressed,
        }));
        setLoadingHistory(false);
      });
    } catch (cause) {
      if (
        !request.controller.signal.aborted &&
        request.version === historyVersion.current &&
        hiddenHistory.current.epoch === epoch &&
        threadRef.current === threadId
      )
        setHistoryError(errorMessage(cause));
    } finally {
      if (historyRequest.current === request) {
        historyRequest.current = null;
        if (request.controller.signal.aborted || request.version !== historyVersion.current)
          historyCursor.current = null;
        if (hiddenHistory.current.epoch === epoch) setLoadingHistory(false);
      }
    }
  }
  function loadHistoryNearTop() {
    const element = scroll.current;
    if (
      !visible ||
      focusTarget ||
      focusLoading.current ||
      unreadPending ||
      returning.current ||
      historyError ||
      !hasEarlier ||
      !element ||
      element.scrollTop > 160
    )
      return;
    void history();
  }
  function cancelReturn() {
    returning.current = false;
    unreadPositioned.current = currentUnreadVisit.current;
  }
  function cancelFocusedMessage() {
    focusRequest.current++;
    focusLoading.current = false;
    setFocusTarget(null);
    cancelHistory();
    returnPosition.current = null;
    unreadPositioned.current = currentUnreadVisit.current;
    setCanReturn(false);
  }
  function reportRead() {
    const element = scroll.current;
    if (
      !visible ||
      focusTarget ||
      (readCursor === null && !readUnavailable) ||
      (unreadPending && unreadPositioned.current !== unreadVisit) ||
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
    if (!element || !visible || !element.clientHeight) return;
    if (unreadPending && unreadPositioned.current !== unreadVisit) return;
    if (
      stickToBottom.current &&
      !returning.current &&
      !window.getSelection()?.toString() &&
      (scrollSize.current.content !== element.scrollHeight ||
        scrollSize.current.viewport !== element.clientHeight)
    )
      element.scrollTop = element.scrollHeight;
    scrollSize.current = { content: element.scrollHeight, viewport: element.clientHeight };
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance > 2 && returning.current) return;
    returning.current = false;
    stickToBottom.current = distance <= 2;
    const since = Date.parse(allMessages.at(-1)?.createdAt ?? '') || Date.now();
    setAway((current) => (distance <= 2 ? null : (current ?? { since })));
    reportRead();
    loadHistoryNearTop();
  }
  useEffect(() => {
    const frame = requestAnimationFrame(updateAway);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateAway);
    if (scroll.current) observer?.observe(scroll.current);
    if (scroll.current?.firstElementChild) observer?.observe(scroll.current.firstElementChild);
    window.addEventListener('resize', updateAway);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateAway);
    };
  }, [
    state.messages,
    historyPage,
    streams,
    optimistic,
    visible,
    onReadLatest,
    focusTarget,
    loadingHistory,
    historyError,
    hasEarlier,
    unreadPending,
  ]);
  async function stop() {
    if (stopping) return;
    const captureAnalytics = analyticsForCurrentSession();
    const stoppedThread = threadId;
    setStopping(true);
    setError('');
    try {
      await post('/api/thread/stop');
      captureAnalytics('chat_stop_requested');
      await refresh();
    } catch (cause) {
      if (threadRef.current === stoppedThread) setError(errorMessage(cause));
      captureAnalytics('ui_error', { area: 'chat', action: 'stop' });
    } finally {
      if (threadRef.current === stoppedThread) setStopping(false);
    }
  }
  const chatActions = (
    <>
      <ChatTools files={files} tasks={state.tasks} />
      {onFeedback && (
        <FeedbackLauncher
          onFeedback={onFeedback}
          onDismissDiscovery={visible ? onDismissFeedbackDiscovery : undefined}
        />
      )}
    </>
  );
  return (
    <PrivateEntryWorkspace key={`${ownerId}.${threadId}`} active={visible}>
      <ArtifactWorkspace className="chat-page" files={files}>
        {toolbarActions || desktopSettingsAvailable() ? (
          <>
            <h1 className="sr-only">Chat</h1>
            {toolbarActions && createPortal(chatActions, toolbarActions)}
          </>
        ) : (
          <header className="chat-report-action">
            <h1 className="sr-only">Chat</h1>
            {chatActions}
          </header>
        )}
        <div
          className="conversation-scroll"
          ref={scroll}
          onDragOver={(event) => {
            if (
              event.dataTransfer.types.includes('Files') ||
              event.dataTransfer.types.includes('application/x-nod-artifact')
            ) {
              event.preventDefault();
              event.currentTarget.dataset.dropFiles = '';
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node))
              delete event.currentTarget.dataset.dropFiles;
          }}
          onDrop={(event) => {
            delete event.currentTarget.dataset.dropFiles;
            if ((event.target as HTMLElement).closest('.browser-handoff')) return;
            const artifact = event.dataTransfer.getData('application/x-nod-artifact');
            if (artifact) {
              event.preventDefault();
              try {
                const item = JSON.parse(artifact);
                if (item && ownedArtifactUrl(item.url)) reuseFile(item, 'composer');
              } catch {}
            } else if (event.dataTransfer.files.length) {
              event.preventDefault();
              composer.current?.upload(Array.from(event.dataTransfer.files));
            }
          }}
          onScroll={updateAway}
          onScrollEnd={() => {
            returning.current = false;
            updateAway();
          }}
          onWheel={cancelReturn}
          onTouchStart={cancelReturn}
          onPointerDown={cancelReturn}
          onKeyDown={cancelReturn}
        >
          <div className="conversation-column">
            {unreadError && (
              <div className="history-control">
                <Tooltip content={unreadError}>
                  <span className="history-error" role="alert">
                    Could not find the first unread message.
                  </span>
                </Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUnreadFailure(null);
                    setUnreadAttempt((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            {unreadPending && !unreadError && readCursor && (
              <div className="history-control" role="status">
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
                Finding new messages
              </div>
            )}
            {persistedMessages.length > 0 && (hasEarlier || loadingHistory || historyError) && (
              <div className="history-control" aria-busy={loadingHistory || undefined}>
                {historyError ? (
                  <>
                    <Tooltip content={historyError}>
                      <span className="history-error" role="alert">
                        {historyError}
                      </span>
                    </Tooltip>
                    <Button variant="ghost" size="sm" onClick={() => void history(true)}>
                      Retry
                    </Button>
                  </>
                ) : loadingHistory ? (
                  <span className="history-loading" role="status">
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                    Loading earlier messages
                  </span>
                ) : null}
              </div>
            )}
            {visibleMessages.length === 0 &&
              !welcoming &&
              !working &&
              !sending &&
              (state.configuration.llmReady ? <Welcome /> : modelSetup)}
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
                  {message.id === unreadBoundary && (
                    <div
                      className="unread-divider"
                      ref={unreadDivider}
                      role="separator"
                      aria-label="New messages"
                    >
                      <span aria-hidden="true">New messages</span>
                    </div>
                  )}
                  {message.suggestions ? (
                    <TaskCards
                      id={message.id}
                      grouped={
                        message.id !== unreadBoundary &&
                        messagesAreGrouped(visibleMessages[index - 1], message, dateFormat)
                      }
                      suggestions={message.suggestions}
                      connections={connections ?? []}
                      status={(task) =>
                        suggestedTaskStatus(
                          { messages: allMessages, tasks: state.tasks, turns: state.turns },
                          task.title,
                          allMessages.findIndex((item) => item.id === message.id),
                          persistedIds,
                        )
                      }
                      disabled={!state.configuration.llmReady || welcoming || spendingPaused}
                      onStart={(task, position) => {
                        captureAnalytics('task_card_started', {
                          ...(task.kind
                            ? { kind: task.kind === 'ongoing' ? 'ongoing' : 'immediate' }
                            : {}),
                          position,
                        });
                        void send(task.title, [], null, 'task_card');
                      }}
                    />
                  ) : state.tasks?.some((task) => task.messageId === message.id) ? (
                    state.tasks
                      ?.filter((task) => task.messageId === message.id)
                      .map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          live={live.find((item) => item.taskId === task.id)}
                          onReply={() => {
                            const target =
                              allMessages.find((item) => item.id === task.questionMessageId) ??
                              message;
                            taskReply.current = target.id;
                            setReplyTo(target);
                            composer.current?.focus();
                          }}
                        />
                      ))
                  ) : (
                    <MessageBubble
                      message={message}
                      answersDisabled={sending || !state.configuration.llmReady || welcoming}
                      onAnswer={async (value, answer) => {
                        if (replyTo?.id === message.id && composer.current?.hasDraft()) {
                          composer.current.focus();
                          throw new Error(
                            'Send your answer from the composer to include your edits.',
                          );
                        }
                        const result = await send(
                          value,
                          [],
                          { id: message.id, role: 'assistant', text: message.text },
                          'answer_choice',
                          undefined,
                          answer,
                        );
                        if (result.questionUnavailable) return 'unavailable';
                        if (!result.sent && result.error) throw new Error(result.error);
                        if (
                          result.sent &&
                          replyTo?.id === message.id &&
                          !composer.current?.hasDraft()
                        )
                          setReplyTo((current) => (current?.id === message.id ? null : current));
                        return result.sent;
                      }}
                      onWriteAnswer={(value) => {
                        const input = composer.current;
                        if (!input) return;
                        if (replyTo?.id === message.id) {
                          if (!input.hasDraft()) setText(value);
                          setReplyTo({ ...replyTo, answerQuestion: true });
                          setReplyNotice('');
                        } else if (replyTo || input.hasDraft()) {
                          setReplyNotice(
                            'Finish or clear your current draft before answering this question.',
                          );
                        } else {
                          taskReply.current = null;
                          setReplyTo({
                            id: message.id,
                            role: 'assistant',
                            text: message.text,
                            answerQuestion: true,
                          });
                          setText(value);
                        }
                        input.focus();
                      }}
                      pendingAudio={
                        optimistic.find((item) => item.message.id === message.id)?.audio
                      }
                      handoffPaused={spendingPaused}
                      connectedAppIds={connectedAppIds}
                      streaming={streamIds.has(message.streamId ?? '')}
                      arriving={arriving(message)}
                      grouped={
                        message.id !== unreadBoundary &&
                        messagesAreGrouped(visibleMessages[index - 1], message, dateFormat)
                      }
                      handoff={
                        message.role === 'assistant' &&
                        !sending &&
                        state.turns.some((turn) => turn.handoffMessageId === message.id)
                      }
                      onReply={
                        message.turnId || persistedIds.has(message.id)
                          ? (quote?: string) => {
                              taskReply.current = null;
                              const preview =
                                (message.role === 'user' ? message.displayText : undefined) ??
                                message.audioCaption ??
                                message.text;
                              const text =
                                preview.trim() || !message.presentation
                                  ? preview
                                  : presentationText(message.presentation);
                              setReplyTo({
                                ...message,
                                ...(message.answerChoicesPending
                                  ? { answerQuestion: true as const }
                                  : {}),
                                isQuote: Boolean(quote?.trim()),
                                text: quote?.trim() ? quote : text,
                              });
                              composer.current?.focus();
                            }
                          : undefined
                      }
                    />
                  )}
                  {message.id === introduction.data?.messageId && (
                    <ChatNotifications ownerId={ownerId} messageId={message.id} />
                  )}
                </Fragment>
              ))}
              {planning ? (
                <Working
                  label={
                    connected
                      ? state.planningStep || 'Pulling together a few ideas to get started'
                      : undefined
                  }
                />
              ) : (
                <Working
                  items={connected ? (holding && finishing ? [finishing, ...live] : live) : []}
                  sending={sending}
                  writing={Boolean(streamEntries.length) && finishing?.doing !== 'tool'}
                  quiet={!streamEntries.length}
                />
              )}
            </div>
            <div ref={bottom} />
          </div>
        </div>
        <div className="chat-bottom conversation-column">
          {connected && <TaskDots tasks={state.tasks ?? []} />}
          {(canReturn || away || onReturnToMemory) && (
            <div className="chat-jump-actions">
              {onReturnToMemory && (
                <Button
                  className="jump-latest"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    cancelFocusedMessage();
                    onReturnToMemory();
                  }}
                >
                  <CornerUpLeft size={16} />
                  Back to Memory
                </Button>
              )}
              {canReturn && !onReturnToMemory && (
                <Button
                  className="jump-latest"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (scroll.current && returnPosition.current !== null) {
                      stickToBottom.current = false;
                      restoreScrollPosition(scroll.current, returnPosition.current);
                    }
                    cancelFocusedMessage();
                  }}
                >
                  <CornerUpLeft size={16} />
                  Return to previous position
                </Button>
              )}
              {away && (
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
                    unreadPositioned.current = currentUnreadVisit.current;
                    stickToBottom.current = true;
                    returning.current = true;
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
            </div>
          )}
          <div
            className="chat-bottom-fade"
            data-away={Boolean(away) || undefined}
            aria-hidden="true"
          />
          {replyNotice && (
            <Notice kind="info" onDismiss={() => setReplyNotice('')}>
              {replyNotice}
            </Notice>
          )}
          {error && <Notice>{error}</Notice>}
          {connectionNotice && (
            <Notice kind={connectionNotice.kind} onDismiss={() => setConnectionNotice(null)}>
              {connectionNotice.text}
            </Notice>
          )}
          {spendingPaused && trust?.limit && (
            <Notice kind="info">
              You reached your {money(trust.limit.monthlyUsd)} monthly spending limit. Raise or
              remove it in <a href="/usage">Usage</a>, or ask Nod here.
            </Notice>
          )}
          <div
            hidden={!state.configuration.llmReady && !working && !sending}
            onInputCapture={() => {
              unreadPositioned.current = currentUnreadVisit.current;
            }}
          >
            <Composer
              key={`${ownerId}.${threadId}`}
              active={visible}
              ref={composer}
              draftKey={`nod.chat-draft.${ownerId}.${threadId}`}
              privateReply={Boolean(state.verificationRequests?.length)}
              restoreReply={(saved) => {
                if (!saved || !hiddenMessageIds.current.has(saved.id)) setReplyTo(saved);
              }}
              ready={state.configuration.llmReady && !welcoming}
              busy={connected && working}
              text={text}
              setText={setText}
              replyTo={replyTo}
              replyPreviewPending={Boolean(
                replyTo && replyNeedsValidation(replyTo.id) && !replyValidationFailed(replyTo.id),
              )}
              retryReplyPreview={
                replyTo && replyNeedsValidation(replyTo.id) && replyValidationFailed(replyTo.id)
                  ? () => setFailedReplyValidation(null)
                  : undefined
              }
              clearReply={() => {
                taskReply.current = null;
                setReplyTo(null);
              }}
              onSend={(value, attachments, recording, displayText) =>
                send(value, attachments, replyTo, undefined, recording, undefined, displayText)
              }
              onStop={
                working ||
                state.tasks?.some((task) =>
                  ['queued', 'working', 'needs_you'].includes(task.status),
                )
                  ? () => void stop()
                  : undefined
              }
              stopping={stopping}
            />
          </div>
          {!state.configuration.llmReady &&
            !working &&
            !sending &&
            visibleMessages.length > 0 &&
            modelSetup}
        </div>
      </ArtifactWorkspace>
    </PrivateEntryWorkspace>
  );
}
