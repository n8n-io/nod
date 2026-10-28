import { useEffect, useMemo, useRef } from 'react';
import type { AccountPreferences } from '../../shared/account';
import type { AppState, Message } from '../../shared/contracts';
import {
  browserNotificationQuietTime,
  browserNotificationStatus,
  deliverBrowserNotification,
  subscribeBrowserNotifications,
  watchBrowserNotificationFocus,
} from '../lib/browser-notifications';
import { desktopSettingsAvailable } from '../lib/desktop';
import { sessionStore } from '../lib/session';
import { usePageData } from './use-page-data';

export function useBrowserNotifications(ownerId: string, state: AppState | null) {
  const { data: preferences } = usePageData<AccountPreferences>('/api/preferences');
  const scope = useMemo(
    () => ({
      ownerId,
      threadId: state?.threadId,
      active: true,
      initialized: false,
      epoch: sessionStore.getSnapshot().epoch,
      consent: browserNotificationStatus(ownerId),
      consentGeneration: 0,
      pending: undefined as Message | undefined,
      seen: new Set<string>(),
      displayed: new Set<Notification>(),
    }),
    [ownerId, state?.threadId],
  );
  const current = useRef({ scope, preferences });
  current.current = { scope, preferences };
  useEffect(() => {
    scope.active = true;
    const stopFocus = watchBrowserNotificationFocus(ownerId);
    const clear = () => {
      for (const notification of scope.displayed) notification.close();
      scope.displayed.clear();
    };
    const unsubscribe = subscribeBrowserNotifications(ownerId, (revoked) => {
      const consent = browserNotificationStatus(ownerId);
      if (revoked || !consent.enabled) {
        if (revoked || scope.consent.enabled || scope.consent.choice !== consent.choice)
          scope.consentGeneration++;
        scope.pending = undefined;
        clear();
      }
      scope.consent = consent;
    });
    return () => {
      scope.active = false;
      stopFocus();
      unsubscribe();
      clear();
    };
  }, [scope, ownerId]);
  useEffect(() => {
    if (!state || desktopSettingsAvailable()) return;
    let newest;
    for (const message of state.messages) {
      if (scope.initialized && !scope.seen.has(message.id) && message.role === 'assistant')
        newest = message;
      scope.seen.add(message.id);
    }
    scope.initialized = true;
    while (scope.seen.size > 1000) scope.seen.delete(scope.seen.values().next().value!);
    if (!browserNotificationStatus(ownerId).enabled) scope.pending = undefined;
    else if (newest) scope.pending = newest;
    if (!scope.pending || !preferences) return;
    const message = scope.pending;
    scope.pending = undefined;
    const consentGeneration = scope.consentGeneration;
    const isCurrent = () =>
      scope.active &&
      current.current.scope === scope &&
      scope.consentGeneration === consentGeneration &&
      sessionStore.getSnapshot().epoch === scope.epoch &&
      sessionStore.getSnapshot().session?.user?.id === ownerId;
    const canDeliver = () =>
      !!current.current.preferences && !browserNotificationQuietTime(current.current.preferences);
    void deliverBrowserNotification(ownerId, state.threadId, message, isCurrent, canDeliver)
      .then((notification) => {
        if (!notification) return;
        if (!isCurrent() || !browserNotificationStatus(ownerId).enabled)
          return notification.close();
        scope.displayed.add(notification);
        notification.onclose = () => scope.displayed.delete(notification);
      })
      .catch(() => {});
  }, [scope, state?.messages, ownerId, preferences]);
}
