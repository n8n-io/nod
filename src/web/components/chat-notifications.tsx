import { useEffect, useRef } from 'react';
import { requestDesktopNotifications } from '../lib/desktop';

export function ChatNotifications({ messageId }: { messageId: string }) {
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (attempted.current === messageId) return;
    attempted.current = messageId;
    try {
      if (localStorage.getItem(`nod.notifications.dismissed.${messageId}`) === 'true') return;
    } catch {}
    void requestDesktopNotifications(messageId)?.catch(() => {});
  }, [messageId]);
  return null;
}
