import { Blocks, CalendarClock, Gauge, MessageCircle, Send, Vault } from '../components/icons';

export const sidebarItems = [
  { path: '/', label: 'Chat', key: '1', icon: MessageCircle },
  { path: '/tasks', label: 'Scheduled', key: '2', icon: CalendarClock },
  { path: '/apps', label: 'Apps', key: '3', icon: Blocks },
  { path: '/channels', label: 'Channels', key: '4', icon: Send },
  { path: '/usage', label: 'Usage', key: '5', icon: Gauge },
  { path: '/vault', label: 'Vault', key: '6', icon: Vault },
] as const;

type NavigationGuard = (path: string, proceed: () => void) => boolean;
let navigationGuard: NavigationGuard | null = null;
let committedNavigation = false;
const historyObservers = new WeakMap<History, { listeners: Set<() => void>; stop(): void }>();

export function guardNavigation(guard: NavigationGuard) {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = null;
  };
}

function navigationIndex() {
  return typeof window.history.state?.nodNavigationIndex === 'number'
    ? (window.history.state.nodNavigationIndex as number)
    : 0;
}

function observeHistory(listener: () => void) {
  const history = window.history;
  let observers = historyObservers.get(history);
  if (!observers) {
    const listeners = new Set<() => void>();
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    const push: History['pushState'] = (state, unused, url) => {
      pushState.call(history, { ...state, nodNavigationIndex: navigationIndex() + 1 }, unused, url);
      for (const observer of listeners) observer();
    };
    const replace: History['replaceState'] = (state, unused, url) => {
      replaceState.call(
        history,
        {
          ...state,
          nodNavigationIndex:
            typeof state?.nodNavigationIndex === 'number'
              ? state.nodNavigationIndex
              : navigationIndex(),
        },
        unused,
        url,
      );
      for (const observer of listeners) observer();
    };
    history.pushState = push;
    history.replaceState = replace;
    observers = {
      listeners,
      stop() {
        if (history.pushState === push) history.pushState = pushState;
        if (history.replaceState === replace) history.replaceState = replaceState;
        historyObservers.delete(history);
      },
    };
    historyObservers.set(history, observers);
  }
  observers.listeners.add(listener);
  return () => {
    if (!observers.listeners.delete(listener)) return;
    if (!observers.listeners.size) observers.stop();
  };
}

export function replaceNavigation(path: string) {
  window.history.replaceState(
    { ...window.history.state, nodNavigationIndex: navigationIndex() },
    '',
    path,
  );
  committedNavigation = true;
  window.dispatchEvent(new PopStateEvent('popstate'));
  committedNavigation = false;
}

export function subscribeNavigation(listener: () => void) {
  let index = navigationIndex();
  let restoring = false;
  let accepted = false;
  let current = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState({ ...window.history.state, nodNavigationIndex: index }, '');
  const stopObserving = observeHistory(() => {
    index = navigationIndex();
    current = window.location.pathname + window.location.search + window.location.hash;
  });
  const update = () => {
    const next = window.location.pathname + window.location.search + window.location.hash;
    const nextIndex = navigationIndex();
    if (restoring) {
      restoring = false;
      return;
    }
    if (!accepted && !committedNavigation && next !== current && navigationGuard) {
      const distance = nextIndex - index;
      const proceed = () => {
        accepted = true;
        if (distance) window.history.go(distance);
        else replaceNavigation(next);
      };
      if (!navigationGuard(next, proceed)) {
        if (distance) {
          restoring = true;
          window.history.go(-distance);
        } else {
          window.history.replaceState(
            { ...window.history.state, nodNavigationIndex: index },
            '',
            current,
          );
        }
        return;
      }
    }
    accepted = false;
    index = nextIndex;
    current = next;
    listener();
  };
  window.addEventListener('popstate', update);
  return () => {
    window.removeEventListener('popstate', update);
    stopObserving();
  };
}

export function navigate(path: string) {
  if (window.location.pathname + window.location.search + window.location.hash === path) return;
  const proceed = () => {
    window.history.pushState({ nodNavigationIndex: navigationIndex() + 1 }, '', path);
    committedNavigation = true;
    window.dispatchEvent(new PopStateEvent('popstate'));
    committedNavigation = false;
  };
  if (!navigationGuard || navigationGuard(path, proceed)) proceed();
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

export function isPrimaryModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>,
  mac = /Mac|iPhone|iPad/.test(navigator.platform),
) {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function navigationShortcut(
  event: Pick<
    KeyboardEvent,
    'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'repeat' | 'isComposing'
  >,
  mac = /Mac|iPhone|iPad/.test(navigator.platform),
) {
  if (
    !isPrimaryModifier(event, mac) ||
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

export function shortcutLabel(key: string, mac = /Mac|iPhone|iPad/.test(navigator.platform)) {
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
