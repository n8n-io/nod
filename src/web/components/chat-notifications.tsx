import { useState } from 'react';
import { desktopSettingsAvailable } from '../lib/desktop';
import { useDesktopSettings } from './desktop-settings';
import { BrowserNotificationPrompt } from './browser-notifications';
import { Button, Notice } from './ui';

function DesktopNotificationPrompt({ ownerId, messageId }: { ownerId: string; messageId: string }) {
  const key = `nod.notifications.dismissed.${ownerId}.${messageId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return (
        localStorage.getItem(key) === 'true' ||
        localStorage.getItem(`nod.notifications.dismissed.${messageId}`) === 'true'
      );
    } catch {}
    return false;
  });
  const native = useDesktopSettings(!dismissed);
  if (dismissed || native.settings?.notifications) return null;
  function dismiss() {
    try {
      localStorage.setItem(key, 'true');
    } catch {}
    setDismissed(true);
  }
  return (
    <aside className="notification-choice" aria-label="Notifications">
      <div className="notification-choice-copy">
        <strong>Get notified by Nod</strong>
        <p>Let Nod tell you when a reply is ready while you’re away.</p>
      </div>
      <div className="notification-choice-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={native.busy || native.loading}
          onClick={() =>
            native.settings
              ? void native
                  .save({ notifications: true })
                  .then(dismiss)
                  .catch(() => {})
              : void native.refresh()
          }
        >
          {native.loading ? 'Loading…' : native.settings ? 'Enable notifications' : 'Try again'}
        </Button>
        <Button size="sm" variant="ghost" disabled={native.busy} onClick={dismiss}>
          Not now
        </Button>
      </div>
      {native.error && <Notice>{native.error}</Notice>}
    </aside>
  );
}

export function ChatNotifications({ ownerId, messageId }: { ownerId: string; messageId: string }) {
  return desktopSettingsAvailable() ? (
    <DesktopNotificationPrompt
      key={`${ownerId}.${messageId}`}
      ownerId={ownerId}
      messageId={messageId}
    />
  ) : (
    <BrowserNotificationPrompt key={ownerId} ownerId={ownerId} />
  );
}
