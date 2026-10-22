import { useEffect, useState } from 'react';
import { telegramState } from '../hooks/use-channel-settings';
import { api } from '../lib/api';
import { telegramBotUrl, type ChannelSettings } from '../lib/secondary-pages';
import { ServiceLogo } from './service-logo';
import { Button } from './ui';

export function useTelegramChatUrl(text: string) {
  const candidate = text.includes('https://t.me/');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!candidate) return;
    let request: AbortController | undefined;
    const load = async () => {
      request?.abort();
      const current = new AbortController();
      request = current;
      setUrl(null);
      try {
        const settings = await api<ChannelSettings>('/api/channel-settings', {
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
          cache: 'no-store',
        });
        if (current.signal.aborted) return;
        const telegram = settings.channels.find((channel) => channel.provider === 'telegram');
        setUrl(
          settings.ready && telegramState(telegram).paired
            ? telegramBotUrl(telegram?.accountHandle)
            : null,
        );
      } catch {}
    };
    void load();
    window.addEventListener('focus', load);
    window.addEventListener('popstate', load);
    return () => {
      request?.abort();
      window.removeEventListener('focus', load);
      window.removeEventListener('popstate', load);
    };
  }, [candidate]);
  return candidate ? url : null;
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
