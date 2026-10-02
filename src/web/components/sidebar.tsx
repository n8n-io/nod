import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  LayoutGrid,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Settings,
  Sun,
} from 'lucide-react';
import { BrandMark } from './brand';
import { AccountAvatar } from './account-avatar';
import { ConnectionMenu } from './connection-menu';
import { AccountMenu, AccountMenuItems, type AccountControls } from './account-menu';
import { currentTheme, setTheme, subscribeTheme } from '../lib/theme';
import {
  isEditingTarget,
  navigationItems,
  navigationShortcut,
  shortcutLabel,
} from '../lib/navigation';

export function Sidebar({
  path,
  collapsed,
  onToggle,
  onNavigate,
  onRestart,
  development = import.meta.env?.DEV === true,
  inspectorEnabled = false,
  inspectorOpen = false,
  onToggleInspector,
  account,
}: {
  path: string;
  collapsed: boolean;
  onToggle(): void;
  onNavigate(path: string): void;
  onRestart(): void;
  development?: boolean;
  inspectorEnabled?: boolean;
  inspectorOpen?: boolean;
  onToggleInspector?(): void;
  account?: AccountControls;
}) {
  const [hints, setHints] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const mobileSheet = useRef<HTMLDialogElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
  const ThemeIcon = theme === 'dark' ? Sun : Moon;
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const toggles = useRef({ onToggle, onToggleInspector, inspectorEnabled });
  toggles.current = { onToggle, onToggleInspector, inspectorEnabled };
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
    setAppMenuOpen(false);
  }, [path]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth > 640) setMobileMenuOpen(false);
      else setAppMenuOpen(false);
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
      if (
        action.type === 'inspector' &&
        (!toggles.current.inspectorEnabled || !toggles.current.onToggleInspector)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (action.type === 'sidebar') {
        if (window.innerWidth <= 640) setMobileMenuOpen((open) => !open);
        else toggles.current.onToggle();
        return;
      }
      if (action.type === 'inspector') {
        setMobileMenuOpen(false);
        toggles.current.onToggleInspector?.();
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
          <span>otto</span>
        </a>
        <button
          type="button"
          className="button button-ghost button-icon sidebar-toggle"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="sidebar-navigation"
          aria-keyshortcuts="Meta+B Control+B"
          title={`${collapsed ? 'Expand sidebar' : 'Collapse sidebar'} (${shortcutLabel('b', mac)})`}
          onClick={onToggle}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={18} aria-hidden="true" />
          )}
        </button>
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
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const label = item.key ? shortcutLabel(item.key, mac) : undefined;
            return (
              <li key={item.path}>
                <a
                  href={item.path}
                  aria-label={item.label}
                  aria-current={path === item.path ? 'page' : undefined}
                  aria-keyshortcuts={
                    item.key
                      ? `Meta+${item.key.toUpperCase()} Control+${item.key.toUpperCase()}`
                      : undefined
                  }
                  title={label ? `${item.label} (${label})` : item.label}
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
                  <Icon size={26} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-label">{item.label}</span>
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
          aria-label="Chat"
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
          {account ? (
            <AccountAvatar user={account.user} />
          ) : (
            <LayoutGrid size={22} aria-hidden="true" />
          )}
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
              {navigationItems.map((item) => {
                const Icon = item.icon;
                return (
                  <a
                    key={item.path}
                    href={item.path}
                    className="mobile-section"
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
                    <Icon size={24} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
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
                  <ThemeIcon size={18} aria-hidden="true" /> {themeLabel}
                </button>
              )}
              {inspectorEnabled && (
                <button
                  type="button"
                  aria-expanded={inspectorOpen}
                  aria-controls="developer-inspector"
                  onClick={() => {
                    closeMobileMenu();
                    onToggleInspector?.();
                  }}
                >
                  <Monitor size={18} aria-hidden="true" /> Inspector
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
            <ThemeIcon size={22} aria-hidden="true" />
            <span className="nav-label">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
          </button>
        )}
        {development && inspectorEnabled && (
          <button
            type="button"
            className={`nav-link ${inspectorOpen ? 'nav-link-active' : ''}`}
            aria-label="Inspector"
            aria-expanded={inspectorOpen}
            aria-controls="developer-inspector"
            aria-keyshortcuts="Meta+I Control+I"
            title={`Inspector (${shortcutLabel('i', mac)})`}
            onClick={onToggleInspector}
          >
            <Monitor size={22} aria-hidden="true" />
            <span className="nav-label">Inspector</span>
            <kbd className="nav-shortcut" aria-hidden="true">
              I
            </kbd>
          </button>
        )}
        {development ? (
          <button
            type="button"
            className="nav-link"
            aria-label="Get started"
            title="Get started"
            onClick={onRestart}
          >
            <RotateCcw size={22} aria-hidden="true" />
            <span className="nav-label">Get started</span>
          </button>
        ) : (
          inspectorEnabled && (
            <div className="sidebar-app-menu">
              <ConnectionMenu
                label="App menu"
                triggerClassName="nav-link"
                compact
                open={appMenuOpen}
                onOpenChange={setAppMenuOpen}
                trigger={
                  <>
                    <MoreHorizontal size={22} aria-hidden="true" />
                    <span className="nav-label">More</span>
                  </>
                }
              >
                {(close) => (
                  <button
                    type="button"
                    role="menuitem"
                    aria-expanded={inspectorOpen}
                    aria-controls="developer-inspector"
                    aria-keyshortcuts="Meta+I Control+I"
                    title={`Inspector (${shortcutLabel('i', mac)})`}
                    onClick={() => {
                      close();
                      onToggleInspector?.();
                    }}
                  >
                    <Monitor size={18} aria-hidden="true" /> Inspector
                  </button>
                )}
              </ConnectionMenu>
            </div>
          )
        )}
        {account &&
          (account.canLogout ? (
            <AccountMenu account={account} />
          ) : (
            <button
              type="button"
              className="nav-link"
              aria-label="Settings"
              aria-keyshortcuts="Meta+, Control+,"
              title="Settings"
              onClick={(event) => account.onSettings('Preferences', event.currentTarget)}
            >
              <Settings size={22} aria-hidden="true" />
            </button>
          ))}
      </div>
    </aside>
  );
}
