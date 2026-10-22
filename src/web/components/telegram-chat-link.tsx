import { useSyncExternalStore } from 'react';
import { telegramState } from '../hooks/use-channel-settings';
import { api, requestAccountVersion } from '../lib/api';
import { telegramBotUrl, type ChannelSettings } from '../lib/secondary-pages';
import { ServiceLogo } from './service-logo';
import { Button } from './ui';

function createTelegramLinks(version: number) {
  let url: string | null = null;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();
  const load = async () => {
    if (version !== requestAccountVersion()) return;
    request?.abort();
    const current = new AbortController();
    request = current;
    try {
      const settings = await api<ChannelSettings>('/api/channel-settings', {
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
        cache: 'no-store',
      });
      if (current.signal.aborted || version !== requestAccountVersion()) return;
      const telegram = settings.channels.find((channel) => channel.provider === 'telegram');
      url =
        settings.ready && telegramState(telegram).paired
          ? telegramBotUrl(telegram?.accountHandle)
          : null;
      for (const listener of listeners) listener();
    } catch {
    } finally {
      if (request === current) request = undefined;
    }
  };
  return {
    version,
    getSnapshot: () => (version === requestAccountVersion() ? url : null),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void load();
        window.addEventListener('focus', load);
        window.addEventListener('popstate', load);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        request?.abort();
        request = undefined;
        url = null;
        window.removeEventListener('focus', load);
        window.removeEventListener('popstate', load);
      };
    },
  };
}

let telegramLinks: ReturnType<typeof createTelegramLinks> | undefined;
const noTelegramLinks = { subscribe: () => () => {}, getSnapshot: () => null };

export function useTelegramChatUrl(text: string) {
  const version = requestAccountVersion();
  if (telegramLinks?.version !== version) telegramLinks = createTelegramLinks(version);
  const store = text.includes('https://t.me/') ? telegramLinks : noTelegramLinks;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, noTelegramLinks.getSnapshot);
}

export function TelegramChatLink({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" className="telegram-chat-link">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-label="Open Telegram"
        data-setup="telegram"
      >
        <ServiceLogo slug="telegram" logoUrl="/logos/telegram.svg" size={24} />
        <span className="telegram-chat-name">Telegram</span>
        <span className="telegram-chat-open">Open</span>
      </a>
    </Button>
  );
}
