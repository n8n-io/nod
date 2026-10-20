import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutGrid, Moon, Settings, Sun } from 'lucide-react';
import { BrandMark } from './brand';
import { AccountMenuItems, type AccountControls } from './account-menu';
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
  onToggle,
  onNavigate,
  account,
}: {
  path: string;
  unreadCount?: number;
  unreadPending?: boolean;
  onToggle(): void;
  onNavigate(path: string): void;
  account?: AccountControls;
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
  const chatLabel = unreadCount || unreadPending ? `Chat, ${unreadLabel}` : 'Chat';
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
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileSheet = useRef<HTMLDialogElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let focusFrame: number | undefined;
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(false);
    };
    const down = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.composedPath().some(isEditingTarget) ||
        event
          .composedPath()
          .some(
            (target) => target instanceof Element && Boolean(target.closest('[role="dialog"]')),
          ) ||
        isEditingTarget(document.activeElement)
      ) {
        clear();
        return;
      }
      if (event.key === (mac ? 'Meta' : 'Control')) {
        if (!event.repeat && !timer)
          timer = setTimeout(() => {
            if (!isEditingTarget(document.activeElement)) setHints(true);
          }, 650);
        return;
      }
      clear();
      const action = navigationShortcut(event);
      if (!action) return;
      if (action.type === 'memory' && !toggles.current.account) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'sidebar') {
        if (window.innerWidth <= 640) setMobileMenuOpen((open) => !open);
        else toggles.current.onToggle();
        return;
      }
      if (action.type === 'memory') {
        setMobileMenuOpen(false);
        toggles.current.account?.onSettings('Memory');
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
      if (isEditingTarget(document.activeElement)) clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('focusin', focus);
    document.addEventListener('visibilitychange', clear);
    return () => {
      clearTimeout(timer);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [mac]);
  return (
    <aside className={`sidebar ${hints ? 'show-shortcuts' : ''}`} aria-label="Sidebar">
      <div className="sidebar-header">
        <a
          href="/"
          className="brand"
          aria-label="Otto"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onNavigate('/');
          }}
        >
          <BrandMark />
          <span data-analytics-public>otto</span>
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
            const label = item.key ? shortcutLabel(item.key, mac) : undefined;
            return (
              <li key={item.path}>
                <a
                  href={item.path}
                  aria-label={item.path === '/' ? chatLabel : item.label}
                  aria-current={path === item.path ? 'page' : undefined}
                  aria-keyshortcuts={
                    item.key
                      ? `Meta+${item.key.toUpperCase()} Control+${item.key.toUpperCase()}`
                      : undefined
                  }
                  title={label ? `${item.label} (${label})` : item.label}
                  className={`nav-link ${path === item.path ? 'nav-link-active' : ''} ${item.path === '/' && unreadBadge ? 'has-chat-unread' : ''}`}
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
                  <Icon size={24} aria-hidden="true" />
                  <span className="nav-label" data-analytics-public>
                    {item.label}
                  </span>{' '}
                  {item.path === '/' && unreadBadge}
                  {item.key && (
                    <kbd className="nav-shortcut" aria-hidden="true">
                      {item.key.toUpperCase()}
                    </kbd>
                  )}
                </a>
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
          <BrandMark />
          {unreadBadge}
        </a>
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
                    <Icon size={24} aria-hidden="true" />
                    <span data-analytics-public>{item.label}</span>{' '}
                    {item.path === '/' && unreadBadge}
                  </a>
                );
              })}
            </nav>
            <div className="mobile-sheet-actions">
              {account ? (
                <AccountMenuItems
                  account={{
                    ...account,
                    onSettings: (tab) =>
                      account.onSettings(tab, mobileTrigger.current ?? undefined),
                  }}
                  close={closeMobileMenu}
                  shortcuts={false}
                  menu={false}
                />
              ) : (
                <button type="button" onClick={toggleTheme}>
                  <ThemeIcon size={16} aria-hidden="true" /> {themeLabel}
                </button>
              )}
            </div>
          </div>
        </dialog>
      </div>
      <div className="sidebar-bottom">
        {!account && (
          <button
            type="button"
            className="nav-link theme-toggle"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={toggleTheme}
          >
            <ThemeIcon size={24} aria-hidden="true" />
            <span className="nav-label">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
        )}
        {account && (
          <button
            type="button"
            className="nav-link"
            aria-label="Settings"
            aria-keyshortcuts="Meta+, Control+,"
            title="Settings"
            onClick={(event) => account.onSettings('General', event.currentTarget)}
          >
            <Settings size={24} aria-hidden="true" />
            <span className="nav-label" data-analytics-public>
              Settings
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
