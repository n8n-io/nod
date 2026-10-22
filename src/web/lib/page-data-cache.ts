import { api, ApiError, errorMessage } from './api';

export interface PageDataSnapshot<T> {
  data: T | null;
  error: string;
  status?: number;
  loading: boolean;
  refreshing: boolean;
}

type Entry = {
  snapshot: PageDataSnapshot<unknown>;
  listeners: Set<() => void>;
  generation: number;
  controller?: AbortController;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  lastStarted: number;
  needsRefresh: boolean;
  visited: boolean;
  fetchedAt?: number;
};

export function createPageDataCache(
  fetcher: (path: string, signal: AbortSignal) => Promise<unknown>,
  refreshIntervalMs = 2000,
) {
  const entries = new Map<string, Entry>();
  function entry(path: string) {
    let value = entries.get(path);
    if (!value) {
      value = {
        snapshot: { data: null, error: '', loading: true, refreshing: false },
        listeners: new Set(),
        generation: 0,
        lastStarted: 0,
        needsRefresh: false,
        visited: false,
      };
      entries.set(path, value);
    }
    return value;
  }
  function publish(value: Entry, snapshot: PageDataSnapshot<unknown>) {
    value.snapshot = snapshot;
    for (const listener of value.listeners) listener();
  }
  function schedule(path: string, value: Entry) {
    if (!value.listeners.size || value.timer || value.pending) return;
    value.timer = setTimeout(
      () => {
        value.timer = undefined;
        if (value.listeners.size && value.needsRefresh) void refresh(path);
      },
      Math.max(0, value.lastStarted + refreshIntervalMs - Date.now()),
    );
  }
  function refresh(path: string, replace = false): Promise<void> {
    const value = entry(path);
    if (value.pending && !replace) return value.pending;
    clearTimeout(value.timer);
    value.timer = undefined;
    value.needsRefresh = false;
    value.controller?.abort();
    const controller = new AbortController();
    value.controller = controller;
    const generation = ++value.generation;
    value.lastStarted = Date.now();
    publish(value, {
      ...value.snapshot,
      loading: value.snapshot.data === null,
      refreshing: true,
    });
    const pending = Promise.resolve()
      .then(() => fetcher(path, controller.signal))
      .then((data) => {
        if (generation !== value.generation || controller.signal.aborted) return;
        value.fetchedAt = Date.now();
        publish(value, { data, error: '', loading: false, refreshing: false });
      })
      .catch((cause) => {
        if (generation !== value.generation || controller.signal.aborted) return;
        publish(value, {
          ...value.snapshot,
          error: errorMessage(cause),
          status: cause instanceof ApiError ? cause.status : undefined,
          loading: false,
          refreshing: false,
        });
      })
      .finally(() => {
        if (generation !== value.generation) return;
        value.pending = undefined;
        value.controller = undefined;
        if (value.needsRefresh) schedule(path, value);
      });
    value.pending = pending;
    return pending;
  }
  function expirePrefetch(value: Entry) {
    if (!value.visited && value.fetchedAt !== undefined && Date.now() - value.fetchedAt >= 30_000) {
      value.fetchedAt = undefined;
      value.snapshot = { data: null, error: '', loading: true, refreshing: !!value.pending };
    }
  }
  return {
    getSnapshot<T>(path: string) {
      const value = entry(path);
      expirePrefetch(value);
      return value.snapshot as PageDataSnapshot<T>;
    },
    subscribe(path: string, listener: () => void) {
      const value = entry(path);
      expirePrefetch(value);
      value.visited = true;
      value.listeners.add(listener);
      return () => {
        value.listeners.delete(listener);
        if (!value.listeners.size) {
          clearTimeout(value.timer);
          value.timer = undefined;
        }
      };
    },
    refresh,
    clear() {
      for (const value of entries.values()) {
        value.generation++;
        value.controller?.abort();
        clearTimeout(value.timer);
        value.controller = undefined;
        value.pending = undefined;
        value.timer = undefined;
        value.needsRefresh = false;
        publish(value, { data: null, error: '', loading: true, refreshing: false });
      }
      entries.clear();
    },
    revalidateActive(prefix = '') {
      for (const [path, value] of entries) {
        if (!path.startsWith(prefix)) continue;
        if (!value.listeners.size) {
          if (!value.visited) {
            value.generation++;
            value.controller?.abort();
            value.controller = undefined;
            value.pending = undefined;
            value.fetchedAt = undefined;
            publish(value, { data: null, error: '', loading: true, refreshing: false });
          }
          continue;
        }
        value.needsRefresh = true;
        schedule(path, value);
      }
    },
    update<T>(path: string, update: (current: T | null) => T | null) {
      const value = entry(path);
      value.generation++;
      value.controller?.abort();
      value.controller = undefined;
      value.pending = undefined;
      clearTimeout(value.timer);
      value.timer = undefined;
      value.needsRefresh = false;
      const data = update(value.snapshot.data as T | null);
      value.fetchedAt = Date.now();
      publish(value, { data, error: '', loading: false, refreshing: false });
    },
  };
}

export const pageDataCache = createPageDataCache((path, signal) => api(path, { signal }));
