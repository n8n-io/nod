import { useEffect, useState } from 'react';
import type { CurrentBrowser } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';

type BrowserState = { currentBrowser: CurrentBrowser | null };

export function useBrowserState() {
  const [data, setData] = useState<BrowserState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<BrowserState>('/api/browser', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(errorMessage(cause));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2500);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  function browserStopped(threadId: string) {
    setData((current) =>
      current?.currentBrowser?.threadId === threadId
        ? { currentBrowser: { ...current.currentBrowser, status: 'cancelled' } }
        : current,
    );
  }
  return { data, error, browserStopped };
}
