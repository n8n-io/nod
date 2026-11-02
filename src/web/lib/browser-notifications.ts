import type { Message, Preferences } from '../../shared/contracts';
import { desktopSettingsAvailable } from './desktop';
import { captureAnalytics } from './analytics';

const changed = 'nod:browser-notifications';
const invalidatedChoices = new Set<string>();
const preferenceKey = (ownerId: string) => `nod.browser-notifications.${ownerId}`;
const foregroundKey = (ownerId: string) => `nod.browser-notifications.foreground.${ownerId}`;

export function browserNotificationStatus(ownerId: string) {
  const available =
    !desktopSettingsAvailable() &&
    window.isSecureContext &&
    typeof window.navigator.locks?.request === 'function' &&
    typeof window.Notification === 'function';
  let choice: string | null = null;
  try {
    choice = window.localStorage.getItem(preferenceKey(ownerId));
  } catch {}
  if (choice === 'enabled' && invalidatedChoices.has(ownerId)) choice = 'disabled';
  const permission = available ? window.Notification.permission : 'default';
  return {
    available,
    permission,
    choice,
    enabled: available && choice === 'enabled' && permission === 'granted',
  };
}

function saveChoice(ownerId: string, value: string) {
  window.localStorage.setItem(preferenceKey(ownerId), value);
  invalidatedChoices.delete(ownerId);
  window.dispatchEvent(new Event(changed));
}

export function subscribeBrowserNotifications(
  ownerId: string,
  listener: (revoked: boolean) => void,
) {
  const update = (event?: Event) => {
    const storage = event?.type === 'storage' ? (event as StorageEvent) : undefined;
    const owned = storage && (storage.key === preferenceKey(ownerId) || storage.key === null);
    const status = browserNotificationStatus(ownerId);
    if (
      !desktopSettingsAvailable() &&
      status.choice === 'enabled' &&
      status.permission !== 'granted'
    ) {
      invalidatedChoices.add(ownerId);
      try {
        saveChoice(ownerId, 'disabled');
      } catch {
        window.dispatchEvent(new Event(changed));
      }
      return;
    }
    listener(Boolean(owned && storage.newValue !== 'enabled'));
  };
  window.addEventListener(changed, update);
  window.addEventListener('storage', update);
  window.addEventListener('focus', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener('storage', update);
    window.removeEventListener('focus', update);
    document.removeEventListener('visibilitychange', update);
  };
}

export function watchBrowserNotificationFocus(ownerId: string) {
  const locks = window.navigator.locks;
  if (!locks || desktopSettingsAvailable()) return () => {};
  let controller: AbortController | undefined;
  let release: (() => void) | undefined;
  const clear = () => {
    controller?.abort();
    release?.();
    release = undefined;
  };
  const update = () => {
    clear();
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const request = new AbortController();
    controller = request;
    void locks
      .request(foregroundKey(ownerId), { signal: request.signal }, () => {
        if (request.signal.aborted) return;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {});
  };
  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', update);
  return () => {
    clear();
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    window.removeEventListener('pagehide', clear);
    document.removeEventListener('visibilitychange', update);
  };
}

export async function setBrowserNotifications(
  ownerId: string,
  enabled: boolean,
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent() || desktopSettingsAvailable()) return;
  if (!enabled) return saveChoice(ownerId, 'disabled');
  const status = browserNotificationStatus(ownerId);
  if (!status.available) throw new Error('Browser notifications are unavailable here.');
  const permission =
    status.permission === 'default'
      ? await window.Notification.requestPermission()
      : status.permission;
  if (!isCurrent() || desktopSettingsAvailable()) return;
  if (permission !== 'granted') {
    window.dispatchEvent(new Event(changed));
    throw new Error(
      permission === 'denied'
        ? 'Allow notifications for this site in your browser settings to enable them.'
        : 'Notifications remain off. You can enable them when you are ready.',
    );
  }
  const key = preferenceKey(ownerId);
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, 'enabled');
  let notification;
  try {
    notification = new window.Notification('Nod', {
      body: 'Notifications are on.',
      icon: new URL('/nod-logo.png', window.location.origin).href,
      tag: key,
    });
  } catch {
    if (previous === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, previous === 'enabled' ? 'disabled' : previous);
    window.dispatchEvent(new Event(changed));
    throw new Error('This browser cannot show notifications here. Use Nod’s desktop app.');
  }
  notification.onshow = () => {
    if (!isCurrent() || !browserNotificationStatus(ownerId).enabled) notification.close();
  };
  invalidatedChoices.delete(ownerId);
  window.dispatchEvent(new Event(changed));
  return notification;
}

export function dismissBrowserNotifications(ownerId: string) {
  if (!desktopSettingsAvailable()) saveChoice(ownerId, 'dismissed');
}

export function browserNotificationQuietTime(preferences: Preferences, now = new Date()) {
  if (!preferences.quietHoursEnabled) return false;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const { quietStart, quietEnd } = preferences;
  return (
    quietStart !== quietEnd &&
    (quietStart < quietEnd
      ? current >= quietStart && current < quietEnd
      : current >= quietStart || current < quietEnd)
  );
}

export async function deliverBrowserNotification(
  ownerId: string,
  threadId: string,
  message: Pick<Message, 'id' | 'createdAt'>,
  isCurrent: () => boolean,
  canDeliver: () => boolean = () => true,
) {
  const key = `nod.browser-notifications.last.${JSON.stringify([ownerId, threadId])}`;
  const eligible = () =>
    isCurrent() &&
    canDeliver() &&
    browserNotificationStatus(ownerId).enabled &&
    !(document.visibilityState === 'visible' && document.hasFocus());
  const deliver = () => {
    if (!eligible()) return null;
    let previous: { createdAt: string; ids: string[] } | null = null;
    try {
      previous = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    } catch {}
    const ids =
      previous?.createdAt === message.createdAt && Array.isArray(previous.ids) ? previous.ids : [];
    if ((previous && previous.createdAt > message.createdAt) || ids.includes(message.id))
      return null;
    window.localStorage.setItem(
      key,
      JSON.stringify({ createdAt: message.createdAt, ids: [...ids, message.id] }),
    );
    const notification = new window.Notification('Nod', {
      body: 'Nod has a new reply for you.',
      icon: new URL('/nod-logo.png', window.location.origin).href,
      tag: key,
    });
    notification.onshow = () => {
      if (!eligible()) notification.close();
    };
    notification.onclick = () => {
      notification.close();
      if (!isCurrent()) return;
      window.focus();
      captureAnalytics('notification_opened', { kind: 'reply' });
      window.dispatchEvent(
        new CustomEvent('nod:focus-message', { detail: { messageId: message.id } }),
      );
    };
    return notification;
  };
  const locks = window.navigator.locks;
  if (!locks) return null;
  return locks.request(key, () =>
    locks.request(foregroundKey(ownerId), { ifAvailable: true }, (lock) =>
      lock ? deliver() : null,
    ),
  );
}
