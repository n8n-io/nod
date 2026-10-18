import { useEffect, useRef, useState } from 'react';
import type { ModelConnection, ModelSelection, ModelsResponse } from '../../shared/models';
import { usePageData } from './use-page-data';
import { api, errorMessage, post } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';

export type Models = ReturnType<typeof useModels>;

export const localServerAddress = 'http://localhost:11434/v1';

export function useModels() {
  const page = usePageData<ModelsResponse>('/api/models');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function change(path: string, method: string, body?: unknown) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<ModelsResponse>(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      page.update(() => result);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { ...page, busy, error: error || page.error, setError, change };
}

export function modelReady(models: ModelsResponse | null | undefined) {
  return !!models?.connections.some(
    (connection) =>
      connection.id === models.selection?.connectionId &&
      connection.status === 'connected' &&
      connection.models.some(
        (model) =>
          model.id === models.selection?.modelId && model.efforts.includes(models.selection.effort),
      ),
  );
}

export function modelSelection(source: ModelConnection, modelId: string): ModelSelection {
  const efforts = source.models.find((item) => item.id === modelId)?.efforts ?? [];
  return {
    connectionId: source.id,
    modelId,
    effort: efforts.includes('high') ? 'high' : efforts[0],
  };
}

export function useModelSignIn(models: Models) {
  const [pending, setPending] = useState(false);
  const [signIn, setSignIn] = useState<{ url: string; attempt: string } | null>(null);
  const activeAttempt = useRef<string | null>(null);
  const mounted = useRef(true);
  function finish() {
    activeAttempt.current = null;
    setSignIn(null);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (activeAttempt.current)
        void api(`/api/models/oauth/${activeAttempt.current}`, { method: 'DELETE' }).catch(
          () => {},
        );
    };
  }, []);
  useEffect(() => {
    if (!signIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const expires = Date.now() + 600000;
    async function check() {
      try {
        const result = await api<{ status: 'waiting' | 'connected' | 'failed'; error?: string }>(
          `/api/models/oauth/status/${signIn!.attempt}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.status === 'connected') {
          await models.refresh();
          if (!controller.signal.aborted) {
            models.setError(result.error ?? '');
            finish();
          }
          return;
        }
        if (result.status === 'failed') {
          models.setError(result.error ?? 'Sign-in failed. Start a new connection.');
          finish();
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        models.setError(errorMessage(cause));
      }
      if (Date.now() >= expires) {
        models.setError('Sign-in expired. Start a new connection.');
        void api(`/api/models/oauth/${signIn!.attempt}`, { method: 'DELETE' }).catch(() => {});
        finish();
      } else timer = setTimeout(() => void check(), 2000);
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [signIn, models.refresh]);
  async function cancel() {
    if (!signIn) return false;
    setPending(true);
    try {
      await api(`/api/models/oauth/${signIn.attempt}`, { method: 'DELETE' });
      activeAttempt.current = null;
      if (mounted.current) setSignIn(null);
      return true;
    } catch (cause) {
      if (mounted.current) models.setError(errorMessage(cause));
      return false;
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function connect(provider: 'openai' | 'openrouter', connectionId?: string) {
    if (pending || signIn) return;
    const desktop = desktopLinksAvailable();
    const popup = desktop ? null : window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setPending(true);
    models.setError('');
    try {
      const response = await post<{ url: string; attempt: string }>('/api/models/oauth', {
        provider,
        connectionId,
      });
      activeAttempt.current = response.attempt;
      if (!mounted.current) {
        await api(`/api/models/oauth/${response.attempt}`, { method: 'DELETE' });
        activeAttempt.current = null;
        popup?.close();
        return;
      }
      const url = connectionUrl(response.url, window.location.origin);
      setSignIn({ url, attempt: response.attempt });
      if (desktop) await openConnection(url);
      else if (popup) popup.location.replace(url);
    } catch (cause) {
      popup?.close();
      if (activeAttempt.current) {
        await api(`/api/models/oauth/${activeAttempt.current}`, { method: 'DELETE' }).catch(
          () => {},
        );
        activeAttempt.current = null;
      }
      if (mounted.current) {
        setSignIn(null);
        models.setError(errorMessage(cause));
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  function reopen() {
    if (!signIn) return;
    if (desktopLinksAvailable())
      void openConnection(signIn.url).catch((cause) => models.setError(errorMessage(cause)));
    else window.open(signIn.url, '_blank', 'noopener,noreferrer');
  }
  async function complete(url: string) {
    const saved = await models.change('/api/models/oauth/complete', 'POST', { url });
    if (saved) finish();
    return saved;
  }
  return { signIn, pending, connect, cancel, reopen, complete };
}
