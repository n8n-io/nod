import { type Ref, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutGrid, Moon, Settings, Sun } from './icons';
import { BrandMark } from './brand';
import { Tooltip } from './tooltip';
import { desktopSettingsAvailable } from '../lib/desktop';
import type { AccountControls } from './account-menu';
import { currentTheme, setTheme, subscribeTheme } from '../lib/theme';
import {
  isEditingTarget,
  navigationShortcut,
  shortcutLabel,
  sidebarItems,
} from '../lib/navigation';

export function Sidebar({
  path,
  unreadCount = 0,
  unreadPending = false,
  presence,
  onToggle,
  onNavigate,
  account,
  actionsRef,
}: {
  path: string;
  unreadCount?: number;
  unreadPending?: boolean;
  presence?: 'working' | 'waiting';
  onToggle(): void;
  onNavigate(path: string): void;
  account?: AccountControls;
  actionsRef?: Ref<HTMLDivElement>;
}) {
  const [hints, setHints] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const unreadLabel =
    unreadCount > 99
      ? 'More than 99 unread messages'
      : unreadPending
        ? unreadCount
          ? `${unreadCount} or more unread messages`
          : 'Checking unread messages'
        : `${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`;
  const chatLabel = [
    'Chat',
    unreadCount || unreadPending ? unreadLabel : null,
    presence === 'waiting' ? 'waiting for you' : presence === 'working' ? 'Nod is working' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const unreadBadge =
    unreadCount || unreadPending ? (
      <span className="chat-unread-badge" aria-hidden="true">
        {unreadCount > 99
          ? '99+'
          : unreadPending
            ? unreadCount
              ? `${unreadCount}+`
              : '…'
            : unreadCount}
      </span>
    ) : null;
  const statusDot = presence ? (
    <span className="chat-status-dot" data-state={presence} aria-hidden="true" />
  ) : null;
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileSheet = useRef<HTMLDialogElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const desktop = desktopSettingsAvailable();
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const toggles = useRef({ onToggle, account });
  toggles.current = { onToggle, account };
  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
    (window.innerWidth <= 640
      ? mobileTrigger.current
      : document.getElementById('workspace')
    )?.focus();
  };
  useEffect(() => {
    const sheet = mobileSheet.current;
    if (!sheet) return;
    if (mobileMenuOpen && !sheet.open) {
      sheet.showModal();
      sheet.querySelector<HTMLElement>('.mobile-sheet-body')?.focus();
    }
    if (!mobileMenuOpen && sheet.open) sheet.close();
  }, [mobileMenuOpen]);
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [path]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth > 640) setMobileMenuOpen(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focusFrame: number | undefined;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(false);
    };
    const hintsBlocked = () =>
      document.hidden ||
      window.innerWidth <= 640 ||
      isEditingTarget(document.activeElement) ||
      Boolean(
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [role="listbox"]',
        ),
      );
    const down = (event: KeyboardEvent) => {
      const eventPath = event.composedPath();
      const action = navigationShortcut(event, mac);
      const composerNavigation =
        action?.type === 'navigate' &&
        event.target instanceof Element &&
        event.target.closest('.composer .composer-editor[contenteditable="true"]') ===
          document.activeElement;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        ((eventPath.some(isEditingTarget) || isEditingTarget(document.activeElement)) &&
          !composerNavigation) ||
        eventPath.some(
          (target) => target instanceof Element && Boolean(target.closest('[role="dialog"]')),
        )
      ) {
        clear();
        return;
      }
      if (
        event.key === (mac ? 'Meta' : 'Control') &&
        !event.altKey &&
        !event.shiftKey &&
        !(mac ? event.ctrlKey : event.metaKey)
      ) {
        if (!event.repeat && !timer)
          timer = setTimeout(() => {
            if (!hintsBlocked()) setHints(true);
          }, 650);
        return;
      }
      clear();
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'sidebar') {
        if (window.innerWidth <= 640) setMobileMenuOpen((open) => !open);
        else toggles.current.onToggle();
        return;
      }
      navigate.current(action.path);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = undefined;
        const target =
          action.path === '/'
            ? document.querySelector<HTMLElement>('.composer-editor[contenteditable="true"]')
            : document.getElementById('workspace');
        target?.focus();
      });
    };
    const up = (event: KeyboardEvent) => {
      if (!(mac ? event.metaKey : event.ctrlKey)) clear();
    };
    const focus = () => {
      if (hintsBlocked()) clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('resize', clear);
    document.addEventListener('focusin', focus);
    document.addEventListener('scroll', clear, true);
    document.addEventListener('visibilitychange', clear);
    return () => {
      clearTimeout(timer);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('resize', clear);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('scroll', clear, true);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [mac, desktop]);
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-header">
        <a
          href="/"
          className="brand"
          aria-label="Nod"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate('/');
          }}
        >
          <BrandMark />
          <span>Nod</span>
        </a>
      </div>
      <nav className="main-nav" aria-label="Main navigation" id="sidebar-navigation">
        <ul
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const links = Array.from(event.currentTarget.querySelectorAll('a'));
            const index = links.indexOf(document.activeElement as HTMLAnchorElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? links.length - 1
                  : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                    ? (index + 1) % links.length
                    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                      ? (index - 1 + links.length) % links.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            links[next]?.focus();
          }}
        >
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            const label = desktop ? shortcutLabel(item.key, mac) : undefined;
            return (
              <li key={item.path}>
                <Tooltip content={item.label} shortcut={label} side="right" forceOpen={hints}>
                  <a
                    href={item.path}
                    aria-label={item.path === '/' ? chatLabel : item.label}
                    aria-current={path === item.path ? 'page' : undefined}
                    aria-keyshortcuts={
                      desktop ? `${mac ? 'Meta' : 'Control'}+${item.key}` : undefined
                    }
                    className={`nav-link ${path === item.path ? 'nav-link-active' : ''}`}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        event.button !== 0
                      )
                        return;
                      event.preventDefault();
                      onNavigate(item.path);
                    }}
                  >
                    <span className="nav-icon">
                      <Icon size={20} solid={path === item.path} aria-hidden="true" />
                      {item.path === '/' && unreadBadge}
                      {item.path === '/' && statusDot}
                    </span>
                    <span className="nav-label">{item.label}</span>
                  </a>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mobile-top-bar">
        <a
          href="/"
          className="mobile-chat-link"
          aria-label={chatLabel}
          aria-current={path === '/' ? 'page' : undefined}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            setMobileMenuOpen(false);
            onNavigate('/');
          }}
        >
          <span className="nav-icon">
            <BrandMark />
            {unreadBadge}
            {statusDot}
          </span>
        </a>
        <div className="mobile-toolbar-actions" ref={actionsRef} />
        <button
          type="button"
          ref={mobileTrigger}
          className="mobile-menu-trigger"
          aria-label="Navigation menu"
          aria-haspopup="dialog"
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen(true)}
        >
          <LayoutGrid size={24} aria-hidden="true" />
        </button>
        <dialog
          ref={mobileSheet}
          className="mobile-sheet"
          aria-label="Navigation menu"
          onClose={closeMobileMenu}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeMobileMenu();
          }}
        >
          <div className="mobile-sheet-body" tabIndex={-1}>
            <nav className="mobile-sections" aria-label="Sections">
              {sidebarItems.map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.path}
                    href={item.path}
                    className="mobile-section"
                    aria-label={item.path === '/' ? chatLabel : item.label}
                    aria-current={path === item.path ? 'page' : undefined}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        event.button !== 0
                      )
                        return;
                      event.preventDefault();
                      closeMobileMenu();
                      onNavigate(item.path);
                    }}
                  >
                    <span className="nav-icon">
                      <Icon size={20} solid={path === item.path} aria-hidden="true" />
                    </span>
                    <span>{item.label}</span>
                    {item.path === '/' && unreadBadge}
                  </a>
                );
              })}
            </nav>
            {account && (
              <div className="mobile-sheet-actions">
                <button
                  type="button"
                  onClick={() => {
                    closeMobileMenu();
                    queueMicrotask(() =>
                      account.onSettings('General', mobileTrigger.current ?? undefined),
                    );
                  }}
                >
                  <Settings size={20} aria-hidden="true" />
                  <span>Settings</span>
                </button>
              </div>
            )}
          </div>
        </dialog>
      </div>
      <div className="sidebar-bottom">
        {!account && (
          <Tooltip content={themeLabel} side="right">
            <button
              type="button"
              className="nav-link theme-toggle"
              aria-label={themeLabel}
              onClick={toggleTheme}
            >
              <ThemeIcon size={20} aria-hidden="true" />
              <span className="nav-label">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
            </button>
          </Tooltip>
        )}
        {account && (
          <Tooltip
            content="Settings"
            shortcut={desktop ? shortcutLabel(',', mac) : undefined}
            side="right"
            forceOpen={hints}
          >
            <button
              type="button"
              className={`nav-link ${path.startsWith('/settings') ? 'nav-link-active' : ''}`}
              aria-label="Settings"
              aria-current={path.startsWith('/settings') ? 'page' : undefined}
              aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+,` : undefined}
              onClick={(event) => account.onSettings('General', event.currentTarget)}
            >
              <Settings size={20} solid={path.startsWith('/settings')} aria-hidden="true" />
              <span className="nav-label">Settings</span>
            </button>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}
