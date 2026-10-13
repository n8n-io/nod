import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AppState } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { initialStreamState, streamReducer } from '../lib/streams';
import { pageDataCache } from '../lib/page-data-cache';
import { subscribeAppEvents } from '../lib/app-events';

export function useAppState(accountId?: string, stateTimeout = 30_000) {
  const [state, setState] = useState<AppState | null>(null);
  const [streamState, dispatchStream] = useReducer(streamReducer, initialStreamState);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const requestVersion = useRef(0);
  const threadId = useRef('');
  const retiredThreads = useRef(new Set<string>());
  const resetRequest = useRef<Promise<string> | null>(null);
  const active = useRef(false);
  const stateRequest = useRef<Promise<void> | null>(null);
  const queuedStateRequest = useRef<Promise<void> | null>(null);
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
            turns: [],
          }
        : current,
    );
  }, []);
  const load = useCallback(async () => {
    const version = requestVersion.current;
    try {
      const next = await api<AppState>('/api/state', {
        signal: AbortSignal.timeout(stateTimeout),
      });
      if (!active.current || version !== requestVersion.current) return;
      if (retiredThreads.current.has(next.threadId)) return;
      advanceThread(next.threadId);
      dispatchStream({
        type: 'persisted',
        threadId: next.threadId,
        streamIds: next.messages.flatMap((message) => (message.streamId ? [message.streamId] : [])),
        discardedTurnIds: next.turns
          .filter((turn) => turn.status === 'failed' || turn.status === 'cancelled')
          .map((turn) => turn.id),
      });
      setState(next);
      setError('');
    } catch (cause) {
      if (active.current && version === requestVersion.current) setError(errorMessage(cause));
    }
  }, [advanceThread, stateTimeout]);
  const refresh = useCallback((): Promise<void> => {
    if (!active.current) return Promise.resolve();
    if (queuedStateRequest.current) return queuedStateRequest.current;
    const previous = stateRequest.current;
    const request: Promise<void> = (
      previous
        ? previous.then(() => {
            queuedStateRequest.current = null;
            return active.current ? load() : undefined;
          })
        : load()
    ).finally(() => {
      if (stateRequest.current === request) stateRequest.current = null;
    });
    stateRequest.current = request;
    if (previous) queuedStateRequest.current = request;
    return request;
  }, [load]);

  const resetConversation = useCallback(
    (expectedThreadId: string) => {
      if (resetRequest.current) return resetRequest.current;
      const request = (async () => {
        requestVersion.current++;
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
    [advanceThread],
  );

  useEffect(() => {
    active.current = true;
    let subscribed = true;
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
            done?: boolean;
          };
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
              done: data.done === true,
            });
          }
        } catch {
          setError('An update could not be read. Refresh the page to reconnect.');
        }
      },
    });
    return () => {
      active.current = false;
      subscribed = false;
      requestVersion.current++;
      closeEvents();
    };
  }, [refresh, advanceThread, accountId]);

  const streams = Object.fromEntries(
    Object.entries(streamState.active).map(([id, stream]) => [id, stream.text]),
  );
  return { state, streams, error, connected, refresh, resetConversation };
}
