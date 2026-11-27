import { useState } from 'react';
import type { ChannelProvider } from '../../shared/contracts';
import { analyticsForCurrentSession } from '../lib/analytics';
import { errorMessage, post } from '../lib/api';
import { navigate } from '../lib/navigation';
import { Button, Notice } from './ui';

const names: Record<ChannelProvider, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' };

export function PhoneOffer({
  channels,
  path,
  onAnswered,
}: {
  channels: ChannelProvider[];
  path: 'chat' | 'form';
  onAnswered?(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function answer(choice: ChannelProvider | 'not_now') {
    const capture = analyticsForCurrentSession();
    setBusy(true);
    setError('');
    try {
      await post('/api/phone-offer', { choice });
      capture('phone_offer_answered', { choice, path });
      onAnswered?.();
      if (choice !== 'not_now') navigate(`/channels?connect=${choice}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="notification-choice phone-offer" aria-label="Phone channel">
      <div className="notification-choice-copy">
        <strong>Get the result on your phone too?</strong>
      </div>
      <div className="notification-choice-actions">
        {channels.map((channel) => (
          <Button
            key={channel}
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void answer(channel)}
          >
            {names[channel]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer('not_now')}>
          Not now
        </Button>
      </div>
      {error && <Notice>{error}</Notice>}
    </aside>
  );
}
