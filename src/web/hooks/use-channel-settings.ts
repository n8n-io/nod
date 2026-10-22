import { useEffect, useRef, useState } from 'react';
import type { ChannelProvider, ChannelSetupSummary } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import type { ChannelResponse, ChannelSettings } from '../lib/secondary-pages';

type SetupResult = { channel: ChannelSetupSummary; pairingUrl?: string };

export function telegramState(setup: ChannelSetupSummary | undefined) {
  const saved = Boolean(setup?.enabled);
  const needsDelivery = saved && setup?.webhookStatus === 'registration_pending';
  const ready = saved && !needsDelivery;
  const paired = Boolean(ready && setup?.allowedUserId && !setup.pairingExpiresAt);
  const expiry = saved && !paired ? setup?.pairingExpiresAt : undefined;
  const expired = Boolean(expiry && Date.parse(expiry) <= Date.now());
  return {
    saved,
    needsDelivery,
    ready,
    paired,
    expired,
    waiting: Boolean(ready && expiry && !expired),
    candidate: ready && !paired && !expired ? setup?.pairingCandidate : undefined,
  };
}

export function useChannelSettings({
  watchTelegram,
  watchWhatsApp = false,
}: {
  watchTelegram: boolean;
  watchWhatsApp?: boolean;
}) {
  const [data, setData] = useState<ChannelResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const action = useRef<AbortController | null>(null);
  const telegram = settings?.channels.find((item) => item.provider === 'telegram');
  const whatsapp = settings?.channels.find((item) => item.provider === 'whatsapp');
  const waiting =
    (watchTelegram && telegramState(telegram).waiting) ||
    (watchWhatsApp && whatsapp?.enabled && whatsapp.mode === 'linked');

  async function load() {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(true);
    try {
      const [status, setup] = await Promise.all([
        api<ChannelResponse>('/api/channels', { signal: current.signal }),
        api<ChannelSettings>('/api/channel-settings', { signal: current.signal }),
      ]);
      if (!current.signal.aborted) {
        setData(status);
        setSettings(setup);
        setLoadError('');
        return setup;
      }
    } catch (cause) {
      if (!current.signal.aborted) setLoadError(errorMessage(cause));
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      request.current?.abort();
      action.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [waiting]);

  function accept(channel: ChannelSetupSummary) {
    request.current?.abort();
    setLoadError('');
    setLoading(false);
    const others = <T extends { provider: string }>(items: T[]) =>
      items.filter((item) => item.provider !== channel.provider);
    setSettings((current) =>
      current ? { ...current, channels: [...others(current.channels), channel] } : current,
    );
    setData((current) =>
      current
        ? {
            ...current,
            error: null,
            channels: [
              ...others(current.channels),
              {
                provider: channel.provider,
                status: channel.enabled ? 'configured' : 'disabled',
                missing: [],
              },
            ],
          }
        : current,
    );
  }

  async function perform(
    path: string,
    init: RequestInit,
    failed: (message: string, signal: AbortSignal) => Promise<unknown> | void,
  ) {
    if (action.current) return;
    const current = new AbortController();
    action.current = current;
    setBusy(true);
    try {
      const result = await api<SetupResult>(path, {
        ...init,
        signal: AbortSignal.any([current.signal, ...(init.signal ? [init.signal] : [])]),
      });
      if (current.signal.aborted) return;
      accept(result.channel);
      return result;
    } catch (cause) {
      if (!current.signal.aborted) await failed(errorMessage(cause), current.signal);
    } finally {
      if (action.current === current) action.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }

  async function save(provider: ChannelProvider, body: object) {
    if (action.current) return { ok: false };
    setError('');
    let latest: ChannelSetupSummary | undefined;
    const result = await perform(
      `/api/channel-settings/${provider}`,
      { method: 'PUT', body: JSON.stringify(body) },
      async (message, signal) => {
        latest = (await load())?.channels.find((item) => item.provider === provider);
        if (!signal.aborted) setError(message);
      },
    );
    if (result) {
      if (provider === 'telegram') setPairingUrl(result.pairingUrl ?? null);
      void load();
    }
    return { ok: Boolean(result), channel: result?.channel ?? latest };
  }

  async function telegramAction(kind: 'pairing' | 'confirm' | 'user', body: object = {}) {
    if (action.current) return false;
    setError('');
    const result = await perform(
      `/api/channel-settings/telegram/${kind}`,
      { method: 'POST', body: JSON.stringify(body) },
      async (message, signal) => {
        await load();
        if (!signal.aborted) setError(message);
      },
    );
    if (result) setPairingUrl(result.pairingUrl ?? null);
    return Boolean(result);
  }

  async function remove(provider: ChannelProvider) {
    let failure = '';
    const result = await perform(
      `/api/channel-settings/${provider}`,
      { method: 'DELETE', signal: AbortSignal.timeout(15000) },
      (message) => {
        failure = message;
      },
    );
    if (result) void load();
    return result ? '' : failure || null;
  }

  return {
    data,
    settings,
    telegram,
    error,
    setError,
    loadError,
    loading,
    busy,
    pairingUrl,
    setPairingUrl,
    load,
    save,
    telegramAction,
    remove,
  };
}
