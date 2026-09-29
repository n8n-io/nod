import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AppState } from '../../shared/contracts';
import { api, errorMessage, post } from '../lib/api';
import { initialStreamState, streamReducer } from '../lib/streams';
import { pageDataCache } from '../lib/page-data-cache';
import { subscribeAppEvents } from '../lib/app-events';

export function useAppState(accountId?: string) {
  const [state, setState] = useState<AppState | null>(null);
  const [streamState, dispatchStream] = useReducer(streamReducer, initialStreamState);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const requestVersion = useRef(0);
  const conversationRevision = useRef(0);
  const resetRequest = useRef<Promise<number> | null>(null);
  const active = useRef(false);
  const stateRequest = useRef<AbortController | null>(null);
  const refreshAfterRequest = useRef(false);
  const advanceConversation = useCallback((revision: number) => {
    if (revision <= conversationRevision.current) return;
    conversationRevision.current = revision;
    requestVersion.current++;
    dispatchStream({ type: 'conversation', conversationRevision: revision });
    setState((current) =>
      current
        ? {
            ...current,
            conversationRevision: revision,
            messages: [],
            tasks: current.tasks.map((task) => ({ ...task, showTyping: false })),
          }
        : current,
    );
  }, []);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    const version = ++requestVersion.current;
    refreshAfterRequest.current = false;
    stateRequest.current?.abort();
    const controller = new AbortController();
    stateRequest.current = controller;
    try {
      const next = await api<AppState>('/api/state', { signal: controller.signal });
      if (!active.current || controller.signal.aborted || version !== requestVersion.current)
        return;
      const revision = next.conversationRevision ?? 0;
      if (revision < conversationRevision.current) return;
      advanceConversation(revision);
      dispatchStream({
        type: 'persisted',
        conversationRevision: revision,
        streamIds: next.messages.flatMap((message) => (message.streamId ? [message.streamId] : [])),
        discardedTaskIds: next.tasks
          .filter((task) => task.status === 'failed' || task.status === 'cancelled')
          .map((task) => task.id),
      });
      setState(next);
      setError('');
    } catch (cause) {
      if (active.current && !controller.signal.aborted && version === requestVersion.current)
        setError(errorMessage(cause));
    } finally {
      if (stateRequest.current === controller) {
        stateRequest.current = null;
        if (refreshAfterRequest.current) void refresh();
      }
    }
  }, [advanceConversation]);

  const resetConversation = useCallback(() => {
    if (resetRequest.current) return resetRequest.current;
    const request = (async () => {
      requestVersion.current++;
      const result = await post<{ ok: true; conversationRevision: number }>(
        '/api/conversation/reset',
      );
      if (!Number.isSafeInteger(result.conversationRevision) || result.conversationRevision < 0)
        throw new Error('The conversation could not be restarted. Try again.');
      if (!active.current) return result.conversationRevision;
      advanceConversation(result.conversationRevision);
      setError('');
      return result.conversationRevision;
    })();
    resetRequest.current = request;
    void request
      .finally(() => {
        if (resetRequest.current === request) resetRequest.current = null;
      })
      .catch(() => {});
    return request;
  }, [advanceConversation]);

  useEffect(() => {
    active.current = true;
    let subscribed = true;
    void refresh();
    const closeEvents = subscribeAppEvents(accountId, {
      open() {
        if (!subscribed) return;
        setConnected(true);
        if (stateRequest.current) refreshAfterRequest.current = true;
        else void refresh();
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
            taskId?: string;
            text?: string;
            streamId?: string;
            done?: boolean;
            conversationRevision?: number;
          };
          if (data.type === 'refresh') {
            pageDataCache.revalidateActive();
            void refresh();
          }
          if (
            data.type === 'delta' &&
            typeof data.taskId === 'string' &&
            (typeof data.text === 'string' || data.done === true)
          ) {
            const revision = data.conversationRevision ?? 0;
            if (revision < conversationRevision.current) return;
            if (revision > conversationRevision.current) {
              advanceConversation(revision);
              void refresh();
            }
            dispatchStream({
              type: 'delta',
              conversationRevision: revision,
              taskId: data.taskId,
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
      stateRequest.current?.abort();
      closeEvents();
    };
  }, [refresh, advanceConversation, accountId]);

  const streams = Object.fromEntries(
    Object.entries(streamState.active).map(([id, stream]) => [id, stream.text]),
  );
  return { state, streams, error, connected, refresh, resetConversation };
}
