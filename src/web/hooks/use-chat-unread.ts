import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, MessageHistoryPage } from '../../shared/contracts';
import { api } from '../lib/api';
import {
  hasUnreadHistory,
  latestChatReadCursor,
  mergeChatReadCursor,
  readChatReadCursor,
  reconcileUnreadChat,
  unreadChatMessageIds,
  writeChatReadCursor,
  type ChatReadCursor,
} from '../lib/chat-unread';

export function useChatUnread(ownerId: string, state: AppState | null) {
  const loaded = state?.messages;
  const messages = useMemo(
    () => state?.messages.filter((message) => !message.taskId),
    [state?.messages],
  );
  const scope = useMemo(
    () =>
      state
        ? {
            ownerId,
            threadId: state.threadId,
            initial: latestChatReadCursor(messages!),
            pending: null as ChatReadCursor | null,
            cursor: null as ChatReadCursor | null,
            writing: false,
          }
        : null,
    [ownerId, state?.threadId],
  );
  const current = useRef(scope);
  current.current = scope;
  const [read, setRead] = useState<{ scope: typeof scope; cursor: ChatReadCursor } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [unavailable, setUnavailable] = useState<typeof scope>(null);
  const [history, setHistory] = useState<{
    scope: typeof scope;
    messages: AppState['messages'];
    cursor: ChatReadCursor;
    count: number;
    pending: boolean;
  } | null>(null);
  const persist = useCallback(async () => {
    if (!scope || current.current !== scope || scope.writing || !scope.cursor) return;
    scope.writing = true;
    try {
      while (scope.pending && current.current === scope) {
        const next = scope.pending;
        await writeChatReadCursor(scope.ownerId, scope.threadId, next);
        if (current.current !== scope) return;
        scope.cursor = mergeChatReadCursor(scope.cursor, next);
        if (scope.pending === next) scope.pending = null;
        setRead({ scope, cursor: scope.cursor });
        setUnavailable(null);
      }
    } catch {
      if (current.current === scope) setUnavailable(scope);
    } finally {
      scope.writing = false;
    }
  }, [scope]);
  useEffect(() => {
    if (!scope) return;
    let active = true;
    void readChatReadCursor(scope.ownerId, scope.threadId)
      .then((saved) => {
        if (!active || current.current !== scope) return;
        const stored = saved ?? scope.initial;
        const baseline = scope.cursor ? mergeChatReadCursor(stored, scope.cursor) : stored;
        scope.cursor = baseline;
        if (scope.pending || !saved)
          scope.pending = mergeChatReadCursor(baseline, scope.pending ?? baseline);
        setUnavailable(null);
        setRead({ scope, cursor: baseline });
        void persist();
      })
      .catch(() => {
        if (active && current.current === scope) setUnavailable(scope);
      });
    return () => {
      active = false;
    };
  }, [scope, attempt, persist]);
  useEffect(() => {
    const retry = () => setAttempt((value) => value + 1);
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, []);
  const cursor = read?.scope === scope ? read.cursor : null;
  const earlier = state?.hasEarlierMessages === true;
  const count = cursor && messages ? Math.min(unreadChatMessageIds(messages, cursor).size, 100) : 0;
  const missing =
    !!cursor && !!messages && count < 100 && hasUnreadHistory(loaded!, earlier, cursor);
  useEffect(() => {
    if (!scope || !cursor || !messages || !missing) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const update = (count: number, pending: boolean) => {
      if (!controller.signal.aborted && current.current === scope)
        setHistory({ scope, cursor, messages, count, pending });
    };
    void reconcileUnreadChat(
      messages,
      earlier,
      cursor,
      (before, signal) => {
        const query = new URLSearchParams({
          threadId: scope.threadId,
          before: before.createdAt,
          beforeId: before.id,
          task: 'main',
        });
        return api<MessageHistoryPage>(`/api/messages?${query}`, { signal });
      },
      signal,
      (count) => update(count, count < 100),
      loaded,
    )
      .then((count) => update(count, false))
      .catch(() => {});
    return () => controller.abort();
  }, [scope, cursor, messages, loaded, earlier, missing, attempt]);
  const markRead = useCallback(
    (threadId: string) => {
      if (!scope || current.current !== scope || threadId !== scope.threadId || !messages) return;
      const next = latestChatReadCursor(messages);
      if (!scope.cursor) {
        scope.pending = scope.pending ? mergeChatReadCursor(scope.pending, next) : next;
        return;
      }
      const merged = mergeChatReadCursor(scope.cursor, next);
      if (JSON.stringify(merged) === JSON.stringify(scope.cursor)) return;
      scope.pending = mergeChatReadCursor(scope.pending ?? scope.cursor, merged);
      void persist();
    },
    [scope, messages, persist],
  );
  const taskCounts = useMemo(
    () =>
      Object.fromEntries(
        (state?.tasks ?? []).flatMap((task) => (task.unread ? [[task.id, task.unread]] : [])),
      ) as Record<string, number>,
    [state?.tasks],
  );
  const marking = useRef(new Set<string>());
  const markTaskRead = useCallback(
    (taskId: string) => {
      if (!taskCounts[taskId] || marking.current.has(taskId)) return;
      marking.current.add(taskId);
      void api(`/api/tasks/${encodeURIComponent(taskId)}/read`, { method: 'POST' })
        .catch(() => {})
        .finally(() => marking.current.delete(taskId));
    },
    [taskCounts],
  );
  const reconciled =
    history?.scope === scope && history.cursor === cursor && history.messages === messages;
  return {
    cursor,
    unavailable: unavailable === scope && !cursor,
    count: Math.min(
      (reconciled ? history.count : count) +
        Object.values(taskCounts).reduce((total, value) => total + value, 0),
      100,
    ),
    pending: (!!scope && unavailable === scope) || (reconciled ? history.pending : missing),
    markRead,
    taskCounts,
    markTaskRead,
  };
}
