import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Activity, AppState } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { initialStreamState, streamReducer } from '../lib/streams';
import { pageDataCache } from '../lib/page-data-cache';
import { subscribeAppEvents } from '../lib/app-events';
import { feedbackClient } from '../lib/feedback-client';
import { recordFeedbackError } from '../lib/feedback-errors';

export function useAppState(accountId?: string) {
  const [state, setState] = useState<AppState | null>(null);
  const [streamState, dispatchStream] = useReducer(streamReducer, initialStreamState);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const requestVersion = useRef(0);
  const threadId = useRef('');
  const retiredThreads = useRef(new Set<string>());
  const resetRequest = useRef<Promise<string> | null>(null);
  const active = useRef(false);
  const stateRequest = useRef<AbortController | null>(null);
  const activitySeen = useRef(0);
  const stateRequestDone = useRef<Promise<void> | null>(null);
  const nextRefresh = useRef<Promise<void> | null>(null);
  const cancelStateRead = useCallback(() => {
    stateRequest.current?.abort();
    stateRequest.current = null;
    stateRequestDone.current = null;
    nextRefresh.current = null;
  }, []);
  const advanceThread = useCallback((next: string) => {
    if (next === threadId.current) return;
    if (threadId.current) {
      retiredThreads.current.add(threadId.current);
      const [oldest] = retiredThreads.current;
      if (retiredThreads.current.size > 20 && oldest) retiredThreads.current.delete(oldest);
      requestVersion.current++;
    }
    threadId.current = next;
    dispatchStream({ type: 'thread', threadId: next });
    setState((current) =>
      current && current.threadId !== next
        ? {
            ...current,
            threadId: next,
            messages: [],
            hiddenMessageCount: 0,
            hiddenMessageIds: [],
            turns: [],
            activity: [],
            chatRecovery: undefined,
          }
        : current,
    );
  }, []);
  const refresh = useCallback((): Promise<void> => {
    if (!active.current) return Promise.resolve();
    if (stateRequest.current) {
      if (!nextRefresh.current) {
        const queued = stateRequestDone.current!.then(() => {
          if (nextRefresh.current !== queued) return;
          nextRefresh.current = null;
          return refresh();
        });
        nextRefresh.current = queued;
      }
      return nextRefresh.current;
    }
    const version = ++requestVersion.current;
    const seen = activitySeen.current;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    stateRequest.current = controller;
    const request = (async () => {
      try {
        const next = await api<AppState>('/api/state', { signal });
        if (!active.current || controller.signal.aborted || version !== requestVersion.current)
          return;
        if (retiredThreads.current.has(next.threadId)) return;
        advanceThread(next.threadId);
        dispatchStream({
          type: 'persisted',
          threadId: next.threadId,
          streamIds: next.messages.flatMap((message) =>
            message.streamId ? [message.streamId] : [],
          ),
          discardedTurnIds: next.turns
            .filter((turn) => turn.status === 'failed' || turn.status === 'cancelled')
            .map((turn) => turn.id),
        });
        setState((current) =>
          current && activitySeen.current !== seen ? { ...next, activity: current.activity } : next,
        );
        setError('');
      } catch (cause) {
        if (active.current && !controller.signal.aborted && version === requestVersion.current)
          setError(
            signal.aborted && signal.reason?.name === 'TimeoutError'
              ? 'The chat update did not finish within 15 seconds.'
              : errorMessage(cause),
          );
      } finally {
        if (stateRequest.current === controller) stateRequest.current = null;
      }
    })();
    stateRequestDone.current = request;
    return request;
  }, [advanceThread]);

  const resetConversation = useCallback(
    (expectedThreadId: string) => {
      if (resetRequest.current) return resetRequest.current;
      const request = (async () => {
        requestVersion.current++;
        cancelStateRead();
        const result = await post<{ ok: true; threadId: string }>('/api/conversation/reset', {
          threadId: expectedThreadId,
        });
        if (typeof result.threadId !== 'string' || !result.threadId)
          throw new Error('The conversation could not be restarted. Try again.');
        if (!active.current) return result.threadId;
        advanceThread(result.threadId);
        setError('');
        return result.threadId;
      })();
      resetRequest.current = request;
      void request
        .finally(() => {
          if (resetRequest.current === request) resetRequest.current = null;
        })
        .catch(() => {});
      return request;
    },
    [advanceThread, cancelStateRead],
  );

  useEffect(() => {
    active.current = true;
    let subscribed = true;
    let activityWithoutScheduleRuns = '[]';
    void refresh();
    const closeEvents = subscribeAppEvents(accountId, {
      open() {
        if (!subscribed) return;
        setConnected(true);
        void refresh();
      },
      error() {
        if (!subscribed || !active.current) return;
        setConnected(false);
      },
      message(event) {
        if (!subscribed || !active.current) return;
        try {
          const data = JSON.parse(event.data) as {
            type: string;
            threadId?: string;
            turnId?: string;
            text?: string;
            streamId?: string;
            taskId?: string;
            done?: boolean;
            items?: Activity[];
          };
          if (data.type === 'activity' && Array.isArray(data.items)) {
            const activity = data.items;
            setState((current) => (current ? { ...current, activity } : current));
            activitySeen.current++;
            const taskRelatedActivity = JSON.stringify(
              activity.filter((item) => item.taskId || !item.runId),
            );
            if (taskRelatedActivity !== activityWithoutScheduleRuns) {
              activityWithoutScheduleRuns = taskRelatedActivity;
              pageDataCache.revalidateActive('/api/tasks');
            }
          }
          if (data.type === 'refresh') {
            pageDataCache.revalidateActive();
            void refresh();
          }
          if (
            data.type === 'delta' &&
            typeof data.threadId === 'string' &&
            typeof data.turnId === 'string' &&
            (typeof data.text === 'string' || data.done === true)
          ) {
            if (threadId.current && data.threadId !== threadId.current) {
              if (!retiredThreads.current.has(data.threadId)) void refresh();
              return;
            }
            dispatchStream({
              type: 'delta',
              threadId: data.threadId,
              turnId: data.turnId,
              text: typeof data.text === 'string' ? data.text : '',
              ...(typeof data.streamId === 'string' ? { streamId: data.streamId } : {}),
              ...(typeof data.taskId === 'string' ? { taskId: data.taskId } : {}),
              done: data.done === true,
            });
          }
        } catch {
          recordFeedbackError('error', 'stream message could not be read');
          setError('An update could not be read. Refresh the page to reconnect.');
        }
      },
    });
    return () => {
      active.current = false;
      subscribed = false;
      requestVersion.current++;
      cancelStateRead();
      closeEvents();
    };
  }, [refresh, advanceThread, cancelStateRead, accountId]);

  useEffect(() => {
    feedbackClient.savedMessages = state ? state.messages.length : null;
    feedbackClient.pendingTurn = state
      ? state.turns.some((turn) => turn.status === 'queued' || turn.status === 'running')
      : null;
    return () => {
      feedbackClient.savedMessages = null;
      feedbackClient.pendingTurn = null;
    };
  }, [state]);

  const streams = Object.fromEntries(
    Object.entries(streamState.active).map(([id, { text, taskId }]) => [id, { text, taskId }]),
  );
  return { state, streams, error, connected, refresh, resetConversation };
}
