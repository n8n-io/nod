import { useEffect, useRef, useState } from 'react';
import type {
  ModelConnection,
  ModelProvider,
  ModelSelection,
  ModelsResponse,
  ModelWorkspace,
} from '../../shared/models';
import { usePageData } from './use-page-data';
import { defaultEffort, defaultModel } from '../../shared/model-defaults';
import { ApiError, api, errorMessage, post } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';

type Models = ReturnType<typeof useModels>;

export const localServerAddress = 'http://localhost:11434/v1';

export interface KeySettings {
  workspaceId: string;
  region: string;
  url: string;
  model: string;
  deployment: string;
  accountId: string;
  gatewayId: string;
}

export const noKeySettings: KeySettings = {
  workspaceId: '',
  region: '',
  url: '',
  model: '',
  deployment: '',
  accountId: '',
  gatewayId: '',
};

export function keySettingsReady(provider: ModelProvider, settings: KeySettings) {
  if (provider === 'amazon-bedrock') return !!settings.region.trim();
  if (provider === 'azure')
    return !!(settings.url.trim() && settings.deployment.trim() && settings.model);
  if (provider === 'cloudflare-workers-ai') return !!settings.accountId.trim();
  if (provider === 'cloudflare-ai-gateway')
    return !!(settings.accountId.trim() && settings.gatewayId.trim());
  return true;
}

export function keyConnection(provider: ModelProvider, key: string, settings: KeySettings) {
  return {
    provider,
    key,
    ...(provider === 'anthropic' && settings.workspaceId.trim()
      ? { workspaceId: settings.workspaceId.trim() }
      : {}),
    ...(provider === 'amazon-bedrock' ? { region: settings.region.trim() } : {}),
    ...(provider === 'azure'
      ? {
          url: settings.url.trim(),
          model: settings.model,
          ...(settings.deployment.trim() ? { deployment: settings.deployment.trim() } : {}),
        }
      : {}),
    ...(provider === 'cloudflare-workers-ai' || provider === 'cloudflare-ai-gateway'
      ? { accountId: settings.accountId.trim() }
      : {}),
    ...(provider === 'cloudflare-ai-gateway' ? { gatewayId: settings.gatewayId.trim() } : {}),
  };
}

export function useModels() {
  const page = usePageData<ModelsResponse>('/api/models');
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; path?: string }>({ message: '' });
  const [workspaces, setWorkspaces] = useState<ModelWorkspace[]>([]);
  function setError(message: string) {
    setFailure({ message });
  }
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
      if (path === '/api/models/keys') setWorkspaces([]);
      return true;
    } catch (cause) {
      setFailure({
        message:
          cause instanceof ApiError
            ? errorMessage(cause)
            : 'The change couldn’t be saved. Check your connection and try again.',
        path,
      });
      if (path === '/api/models/keys' && cause instanceof ApiError && cause.workspaces)
        setWorkspaces(cause.workspaces);
      void page.refresh();
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return {
    ...page,
    busy,
    error: failure.message || page.error,
    errorPath: failure.message ? failure.path : undefined,
    workspaces,
    setWorkspaces,
    setError,
    change,
  };
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
  const model = source.models.find((item) => item.id === modelId);
  return {
    connectionId: source.id,
    modelId,
    effort: model ? defaultEffort(source.provider, model) : 'off',
  };
}

export function recommendedModel(source: ModelConnection) {
  return defaultModel(source.provider, source.models, source.method);
}

export function useModelSignIn(
  models: Models,
  connected?: (provider: 'openai' | 'openrouter') => void,
) {
  const [pending, setPending] = useState(false);
  const [signIn, setSignIn] = useState<{
    url: string;
    attempt: string;
    provider: 'openai' | 'openrouter';
  } | null>(null);
  const activeAttempt = useRef<string | null>(null);
  const mounted = useRef(true);
  const onConnected = useRef(connected);
  onConnected.current = connected;
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
            onConnected.current?.(signIn!.provider);
          }
          return;
        }
        if (result.status === 'failed') {
          models.setError(result.error ?? 'Sign-in failed. Start a new connection.');
          void models.refresh();
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
      setSignIn({ url, attempt: response.attempt, provider });
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
    const provider = signIn?.provider;
    const saved = await models.change('/api/models/oauth/complete', 'POST', { url });
    if (saved) {
      finish();
      if (provider) onConnected.current?.(provider);
    }
    return saved;
  }
  return { signIn, pending, connect, cancel, reopen, complete };
}
