import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { pageDataCache } from '../lib/page-data-cache';

export function usePageData<T>(path: string) {
  const subscribe = useCallback(
    (listener: () => void) => pageDataCache.subscribe(path, listener),
    [path],
  );
  const snapshot = useCallback(() => pageDataCache.getSnapshot<T>(path), [path]);
  const data = useSyncExternalStore(subscribe, snapshot, snapshot);
  const refresh = useCallback(() => pageDataCache.refresh(path, true), [path]);
  const update = useCallback(
    (change: (current: T | null) => T | null) => pageDataCache.update(path, change),
    [path],
  );
  useEffect(() => {
    void pageDataCache.refresh(path);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      window.removeEventListener('focus', focus);
    };
  }, [path, refresh]);
  return { ...data, refresh, update };
}

export function prefetchPageData(paths: string[]) {
  for (const path of paths) void pageDataCache.refresh(path);
}
