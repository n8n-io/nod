import { CalendarClock, KeyRound, MessageCircle, PlugZap, Radio, Target } from 'lucide-react';

export const navigationItems = [
  { path: '/', label: 'Chat', key: 'j', icon: MessageCircle },
  { path: '/goals', label: 'Goals', key: 'g', icon: Target },
  { path: '/schedule', label: 'Schedule', key: 's', icon: CalendarClock },
  { path: '/apps', label: 'Apps', key: 'e', icon: PlugZap },
  { path: '/channels', label: 'Channels', key: 'd', icon: Radio },
  { path: '/vault', label: 'Vault', key: 'k', icon: KeyRound },
] as const;

export function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]',
      ),
    ) ||
      isEditingTarget(target.shadowRoot?.activeElement ?? null))
  );
}

export function navigationShortcut(
  event: Pick<
    KeyboardEvent,
    'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'repeat' | 'isComposing'
  >,
) {
  if (
    (!event.metaKey && !event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.repeat ||
    event.isComposing
  )
    return null;
  const key = event.key.toLowerCase();
  if (key === 'b') return { type: 'sidebar' } as const;
  if (key === 'i') return { type: 'inspector' } as const;
  const item = navigationItems.find((entry) => entry.key === key);
  return item ? ({ type: 'navigate', path: item.path } as const) : null;
}

export function shortcutLabel(key: string, mac = true) {
  return `${mac ? '⌘' : 'Ctrl+'}${key.toUpperCase()}`;
}

export function returnToChat(
  event?: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'preventDefault'
  >,
) {
  if (event && (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey))
    return;
  let canClose = false;
  try {
    if (
      window.opener &&
      !window.opener.closed &&
      window.opener.location.origin === window.location.origin
    ) {
      window.opener.focus();
      canClose = true;
    }
  } catch {}
  if (!canClose) {
    if (!event) window.location.replace('/');
    return;
  }
  event?.preventDefault();
  try {
    window.close();
  } catch {}
  window.setTimeout(() => {
    if (!window.closed) window.location.replace('/');
  }, 0);
}
