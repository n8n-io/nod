import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Chat } from './pages/chat';
import { Vault } from './pages/vault';
import { Apps } from './pages/apps';
import { Channels } from './pages/channels';
import { Credentials } from './pages/credentials';
import { Inspector } from './pages/inspector';
import { Goals } from './pages/goals';
import { SchedulePage } from './pages/schedule';
import { useAppState } from './hooks/use-app-state';
import { prefetchPageData } from './hooks/use-page-data';
import { Button, Loading, Notice } from './components/ui';
import { ChatSkeleton, Splash } from './components/startup';
import { Sidebar } from './components/sidebar';
import { navigationItems } from './lib/navigation';
import { BrowserWindow } from './pages/browser';
import { BrowserConnection } from './pages/browser-connection';
import { readUiPreference, writeUiPreference } from './lib/ui-preferences';
import type { AccountPreferences, AccountUpdate, SessionResponse } from '../shared/account';
import { useSession } from './hooks/use-session';
import { SignIn } from './pages/sign-in';
import { Privacy } from './pages/privacy';
import { Onboarding } from './pages/onboarding';
import { AccountSettings } from './components/account-settings';
import type { AccountControls, AccountTab } from './components/account-menu';
import { usePageData } from './hooks/use-page-data';
import { setDateFormat } from './lib/date-format';
import { saveBrowserLocale } from './lib/preferences';

function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function useSavedDateFormat() {
  const { data } = usePageData<AccountPreferences>('/api/preferences');
  useEffect(() => {
    if (!data) return;
    setDateFormat(data);
    if (data.locale) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const save = () => {
      void saveBrowserLocale(controller.signal).catch(() => {
        if (controller.signal.aborted) return;
        timer = setTimeout(save, delay);
        delay = Math.min(delay * 2, 30_000);
      });
    };
    save();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [data]);
}

function Workspace({
  path,
  session,
  saving,
  onAccountUpdate,
  onLogout,
}: {
  path: string;
  session: SessionResponse;
  saving: boolean;
  onAccountUpdate(change: AccountUpdate): Promise<void>;
  onLogout(): void;
}) {
  const { state, streams, error, connected, refresh, resetConversation } = useAppState(
    session.user!.id,
  );
  useSavedDateFormat();
  const [inspector, setInspector] = useState(
    () =>
      path === '/dev' || (window.innerWidth > 720 && readUiPreference('otto.inspector') === 'open'),
  );
  const [collapsed, setCollapsed] = useState(
    () => readUiPreference('otto.sidebar') === 'collapsed',
  );
  const [pendingMessageFocus, setPendingMessageFocus] = useState<string>();
  const [inspectionFocus, setInspectionFocus] = useState<{ messageId: string; taskId: string }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<AccountTab>('Profile');
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const developer = session.capabilities.developer;
  const openSettings = (tab: AccountTab, trigger?: HTMLElement) => {
    settingsTrigger.current = trigger ?? (document.activeElement as HTMLElement);
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (
        !modifier ||
        event.key !== ',' ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        event.defaultPrevented
      )
        return;
      if (document.querySelector('[role="dialog"]') && !settingsOpen) return;
      event.preventDefault();
      if (!settingsOpen) openSettings('Profile');
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [settingsOpen]);
  useEffect(() => {
    const focusMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: unknown }>).detail;
      if (typeof detail?.messageId === 'string') {
        if (!state) setPendingMessageFocus(detail.messageId);
        navigate('/');
      }
    };
    const inspect = (event: Event) => {
      if (!developer) return;
      const detail = (event as CustomEvent<{ messageId: string; taskId: string }>).detail;
      if (!detail?.taskId) return;
      setInspectionFocus(detail);
      setInspector(true);
    };
    window.addEventListener('otto:focus-message', focusMessage);
    window.addEventListener('otto:inspect-message', inspect);
    return () => {
      window.removeEventListener('otto:focus-message', focusMessage);
      window.removeEventListener('otto:inspect-message', inspect);
    };
  }, [developer, state]);
  const currentPath = path === '/dev' || path === '/you' ? '/' : path;
  const loaded = !!state;
  const hasMessages = state ? state.messages.length > 0 : null;
  useEffect(() => {
    if (hasMessages !== null)
      writeUiPreference('otto.chat-layout', hasMessages ? 'conversation' : 'welcome');
  }, [hasMessages]);
  const [handoff, setHandoff] = useState(false);
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), 600);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    setHandoff(true);
    const timer = setTimeout(() => setHandoff(false), 700);
    return () => clearTimeout(timer);
  }, [loaded]);
  useEffect(() => {
    prefetchPageData(['/api/vault', '/api/goals', '/api/schedules', '/api/apps']);
  }, []);
  useEffect(() => {
    if (path === '/dev') setInspector(true);
  }, [path]);
  useEffect(() => {
    const closeOnNavigation = () => {
      if (window.innerWidth <= 720 && window.location.pathname !== '/dev') setInspector(false);
    };
    window.addEventListener('popstate', closeOnNavigation);
    return () => window.removeEventListener('popstate', closeOnNavigation);
  }, []);
  useEffect(() => {
    writeUiPreference('otto.inspector', inspector ? 'open' : 'closed');
  }, [inspector]);
  useEffect(() => {
    writeUiPreference('otto.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);
  const inspectorEnabled = developer && !!state?.configuration.inspectorEnabled;
  const inspectorOpen = inspectorEnabled && inspector;
  const visibleState = state
    ? { ...state, configuration: { ...state.configuration, inspectorEnabled } }
    : null;
  const account: AccountControls = {
    user: session.user!,
    theme: session.settings!.theme,
    saving,
    canLogout: session.auth.mode === 'google',
    onSettings: openSettings,
    onTheme: (theme) => onAccountUpdate({ theme }),
    onLogout,
  };
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${inspectorOpen ? 'with-inspector' : ''} ${entering ? 'shell-entering' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      <Sidebar
        path={currentPath}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        inspectorEnabled={inspectorEnabled}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspector((value) => !value)}
        onNavigate={navigate}
        account={account}
        onRestart={() => {
          navigate('/');
          setInspectionFocus(undefined);
          window.dispatchEvent(new CustomEvent('otto:restart-setup'));
        }}
      />
      <div className="workspace-frame">
        <div className="workspace-body">
          <main id="workspace" className="main-workspace" tabIndex={-1}>
            <div
              className={`chat-route ${handoff ? 'chat-entering' : ''}`}
              hidden={currentPath !== '/'}
            >
              {visibleState ? (
                <Chat
                  state={visibleState}
                  streams={streams}
                  refresh={refresh}
                  resetConversation={resetConversation}
                  initialFocusMessageId={pendingMessageFocus}
                />
              ) : error ? (
                <div className="initial-loading">
                  <Notice>{error}</Notice>
                  <Button variant="outline" onClick={() => void refresh()}>
                    Try again
                  </Button>
                </div>
              ) : (
                <ChatSkeleton />
              )}
              {handoff && (
                <div className="startup-leaving" aria-hidden="true">
                  <ChatSkeleton />
                </div>
              )}
            </div>
            {currentPath === '/vault' && <Vault />}
            {currentPath === '/apps' && <Apps />}
            {currentPath === '/channels' && <Channels hosted={session.auth.mode === 'google'} />}
            {currentPath === '/goals' && <Goals conversation={visibleState} />}
            {currentPath === '/schedule' && <SchedulePage conversation={visibleState} />}
            {!navigationItems.some((item) => item.path === currentPath) && (
              <div className="empty-state">
                <h1>This page isn’t here.</h1>
                <Button variant="outline" onClick={() => navigate('/')}>
                  <ArrowLeft size={16} />
                  Back to chat
                </Button>
              </div>
            )}
            {state && (error || !connected) && (
              <div className="connection-notice">
                <Notice kind={error ? 'error' : 'info'}>{error || 'Reconnecting…'}</Notice>
              </div>
            )}
          </main>
          {inspectorOpen && (
            <Inspector focus={inspectionFocus} onClose={() => setInspector(false)} />
          )}
        </div>
      </div>
      <AccountSettings
        account={account}
        open={settingsOpen}
        initialTab={settingsTab}
        onOpenChange={setSettingsOpen}
        onName={(name) => onAccountUpdate({ name })}
        returnFocus={() =>
          settingsTrigger.current?.isConnected
            ? settingsTrigger.current
            : document.querySelector<HTMLElement>(
                window.innerWidth <= 640
                  ? '[aria-label="Navigation menu"]'
                  : '[aria-label="Account menu"]',
              )
        }
      />
    </div>
  );
}
function AccountApp({ path, setPath }: { path: string; setPath(path: string): void }) {
  const sessionState = useSession();
  const { session } = sessionState;
  useEffect(() => {
    if (sessionState.loading || !session?.user || !session.settings) return;
    const secure =
      /^\/(?:vault|credentials|browser-connect)\/[^/]+\/?$/.test(path) || path === '/browser';
    const next =
      !session.settings.onboardingCompleted && !secure
        ? '/onboarding'
        : path === '/login' || path === '/onboarding'
          ? '/'
          : null;
    if (next && next !== path) {
      window.history.replaceState(null, '', next);
      setPath(next);
    }
  }, [sessionState.loading, session?.user?.id, session?.settings?.onboardingCompleted, path]);
  if (sessionState.signingOut)
    return (
      <main className="initial-loading">
        {sessionState.error ? (
          <>
            <Notice>{sessionState.error}</Notice>
            <Button variant="outline" onClick={() => void sessionState.logout()}>
              Try again
            </Button>
          </>
        ) : (
          <Loading label="Signing out…" />
        )}
      </main>
    );
  if (sessionState.loading) return <Splash />;
  if (!session?.user)
    return (
      <SignIn
        available={session?.auth.googleAvailable ?? false}
        error={
          sessionState.error ||
          (new URLSearchParams(window.location.search).has('error')
            ? 'Sign-in did not finish. Try again.'
            : '')
        }
        onRetry={() => void sessionState.refresh()}
      />
    );
  if (!session.settings)
    return (
      <main className="initial-loading">
        <Notice>Your account could not be opened.</Notice>
        <Button variant="outline" onClick={() => void sessionState.refresh()}>
          Try again
        </Button>
      </main>
    );
  const key = `${session.user.id}:${sessionState.epoch}`;
  const logout = () => {
    void sessionState.logout().then(() => {
      window.history.replaceState(null, '', '/login');
      setPath('/login');
    });
  };
  if (path === '/browser' || path === '/dev') {
    if (!session.capabilities.developer)
      return (
        <main className="empty-state">
          <h1>This page isn’t here.</h1>
          <Button variant="outline" onClick={() => navigate('/')}>
            Back to chat
          </Button>
        </main>
      );
    if (path === '/browser') return <BrowserWindow key={key} />;
  }
  const match = /^\/(?:vault|credentials)\/([^/]+)\/?$/.exec(path);
  if (match) return <Credentials key={`${key}:${match[1]}`} id={match[1]} />;
  const browserConnection = /^\/browser-connect\/([A-Za-z0-9_-]{43})\/?$/.exec(path);
  if (browserConnection)
    return (
      <BrowserConnection key={`${key}:${browserConnection[1]}`} token={browserConnection[1]} />
    );
  if (!session.settings.onboardingCompleted)
    return (
      <Onboarding
        key={key}
        user={session.user}
        canLogout={session.auth.mode === 'google'}
        onLogout={logout}
        onComplete={() => sessionState.update({ onboardingCompleted: true })}
      />
    );
  return (
    <Workspace
      key={key}
      path={path === '/login' || path === '/onboarding' ? '/' : path}
      session={session}
      saving={sessionState.mutating}
      onAccountUpdate={sessionState.update}
      onLogout={logout}
    />
  );
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return /^\/privacy\/?$/.test(path) ? <Privacy /> : <AccountApp path={path} setPath={setPath} />;
}
