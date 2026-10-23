import { History, ListChecks, MessageCircle, PlugZap, Radio, Vault } from '../components/icons';

export const sidebarItems = [
  { path: '/', label: 'Chat', key: '1', icon: MessageCircle },
  { path: '/tasks', label: 'Tasks', key: '2', icon: ListChecks },
  { path: '/apps', label: 'Apps', key: '3', icon: PlugZap },
  { path: '/channels', label: 'Channels', key: '4', icon: Radio },
  { path: '/usage', label: 'Usage', key: '5', icon: History },
  { path: '/vault', label: 'Vault', key: '6', icon: Vault },
] as const;

export function navigate(path: string) {
  if (window.location.pathname + window.location.search + window.location.hash === path) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

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
  mac = /Mac|iPhone|iPad/.test(navigator.platform),
) {
  if (
    !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) ||
    event.shiftKey ||
    event.altKey ||
    event.repeat ||
    event.isComposing
  )
    return null;
  const key = event.key.toLowerCase();
  if (key === 'b') return { type: 'sidebar' } as const;
  const item = sidebarItems.find((entry) => entry.key === key);
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
