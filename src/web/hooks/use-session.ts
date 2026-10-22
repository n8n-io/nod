import { useEffect, useSyncExternalStore } from 'react';
import { sessionStore } from '../lib/session';

export function useSession() {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  useEffect(() => {
    void sessionStore.refresh();
    const unauthorized = () => void sessionStore.refresh({ conceal: true });
    const focus = () => void sessionStore.refresh();
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('nod.auth');
    if (channel)
      channel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (
          data &&
          typeof data === 'object' &&
          'type' in data &&
          data.type === 'usage-data' &&
          'owner' in data &&
          typeof data.owner === 'string' &&
          'enabled' in data &&
          typeof data.enabled === 'boolean'
        ) {
          if (!data.enabled) {
            sessionStore.revokeUsageData(data.owner, false);
            void sessionStore.refresh();
          } else void sessionStore.refresh({ grantUsageData: data.owner });
        } else void sessionStore.refresh({ conceal: true });
      };
    const changed = (event: Event) =>
      channel?.postMessage(event instanceof CustomEvent ? event.detail : 'changed');
    window.addEventListener('nod:unauthorized', unauthorized);
    window.addEventListener('nod:session-changed', changed);
    window.addEventListener('focus', focus);
    return () => {
      channel?.close();
      window.removeEventListener('nod:unauthorized', unauthorized);
      window.removeEventListener('nod:session-changed', changed);
      window.removeEventListener('focus', focus);
      sessionStore.invalidate();
    };
  }, []);
  return {
    ...state,
    refresh: sessionStore.refresh,
    update: async (...args: Parameters<typeof sessionStore.update>) => {
      const owner = sessionStore.getSnapshot().session?.user?.id;
      if (owner && args[0].usageData === false) {
        sessionStore.revokeUsageData(owner);
        window.dispatchEvent(
          new CustomEvent('nod:session-changed', {
            detail: { type: 'usage-data', owner, enabled: false },
          }),
        );
      }
      await sessionStore.update(...args);
      const accepted = sessionStore.getSnapshot().session;
      if (
        owner &&
        args[0].usageData === true &&
        accepted?.user?.id === owner &&
        accepted.settings?.usageData
      )
        window.dispatchEvent(
          new CustomEvent('nod:session-changed', {
            detail: { type: 'usage-data', owner, enabled: true },
          }),
        );
    },
  };
}
