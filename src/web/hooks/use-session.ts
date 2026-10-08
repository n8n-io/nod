import { useEffect, useSyncExternalStore } from 'react';
import { sessionStore } from '../lib/session';

export function useSession() {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  useEffect(() => {
    void sessionStore.refresh();
    const unauthorized = () => void sessionStore.refresh({ conceal: true });
    const focus = () => void sessionStore.refresh();
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('otto.auth');
    if (channel) channel.onmessage = () => void sessionStore.refresh({ conceal: true });
    const changed = () => channel?.postMessage('changed');
    window.addEventListener('otto:unauthorized', unauthorized);
    window.addEventListener('otto:session-changed', changed);
    window.addEventListener('focus', focus);
    return () => {
      channel?.close();
      window.removeEventListener('otto:unauthorized', unauthorized);
      window.removeEventListener('otto:session-changed', changed);
      window.removeEventListener('focus', focus);
      sessionStore.invalidate();
    };
  }, []);
  return {
    ...state,
    refresh: sessionStore.refresh,
    update: sessionStore.update,
    logout: async () => {
      await sessionStore.logout();
      window.dispatchEvent(new Event('otto:session-changed'));
    },
  };
}
