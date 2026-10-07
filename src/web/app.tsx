import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Chat } from './pages/chat';
import { Vault } from './pages/vault';
import { Apps } from './pages/apps';
import { Channels } from './pages/channels';
import { Credentials } from './pages/credentials';
import { Inspector } from './pages/inspector';
import { Tasks } from './pages/tasks';
import { useAppState } from './hooks/use-app-state';
import { useChatUnread } from './hooks/use-chat-unread';
import { prefetchPageData } from './hooks/use-page-data';
import { Button, Loading, Notice } from './components/ui';
import { ChatSkeleton, Splash } from './components/startup';
import { Sidebar } from './components/sidebar';
import { DesktopToolbar } from './components/desktop-toolbar';
import { FeedbackDialog } from './components/feedback';
import { navigationItems } from './lib/navigation';
import { BrowserWindow } from './pages/browser';
import { readUiPreference, writeUiPreference } from './lib/ui-preferences';
import type { AccountPreferences, AccountUpdate, SessionResponse } from '../shared/account';
import { useSession } from './hooks/use-session';
import { SignIn } from './pages/sign-in';
import { Privacy } from './pages/privacy';
import { Onboarding } from './pages/onboarding';
import { AccountSettings } from './components/account-settings';
import { capturePageview } from './lib/analytics';
import type { AccountControls, AccountTab } from './components/account-menu';
import { usePageData } from './hooks/use-page-data';
import { resolveBrowserRegion, setDateFormat } from './lib/date-format';
import { useBrowserTimeZone } from './hooks/use-browser-time-zone';
import {
  desktopSettingsAvailable,
  onFeedbackRequested,
  subscribeDesktopFocusMessage,
  subscribeDesktopSettings,
} from './lib/desktop';

function navigate(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
function useSavedDateFormat() {
  const { data } = usePageData<AccountPreferences>('/api/preferences');
  useEffect(() => {
    if (!data) return;
    let cancel = () => {};
    const update = () => {
      cancel();
      setDateFormat(data);
      const resolve = () => {
        resolveBrowserRegion();
        setDateFormat(data);
      };
      if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(resolve, { timeout: 1000 });
        cancel = () => window.cancelIdleCallback(handle);
      } else {
        const handle = window.setTimeout(resolve, 0);
        cancel = () => window.clearTimeout(handle);
      }
    };
    update();
    window.addEventListener('focus', update);
    window.addEventListener('languagechange', update);
    return () => {
      cancel();
      window.removeEventListener('focus', update);
      window.removeEventListener('languagechange', update);
    };
  }, [data]);
}

function Workspace({
  path,
  session,
  account,
  settingsError,
  onFeedback,
}: {
  path: string;
  session: SessionResponse;
  account: AccountControls;
  settingsError: string;
  onFeedback(): void;
}) {
  const { state, streams, error, connected, refresh, resetConversation } = useAppState(
    session.user!.id,
  );
  const unread = useChatUnread(session.user!.id, state);
  useSavedDateFormat();
  useBrowserTimeZone();
  const [inspector, setInspector] = useState(
    () =>
      path === '/dev' || (window.innerWidth > 720 && readUiPreference('otto.inspector') === 'open'),
  );
  const [collapsed, setCollapsed] = useState(() => readUiPreference('otto.sidebar') !== 'expanded');
  const [toolbarActions, setToolbarActions] = useState<HTMLDivElement | null>(null);
  const [pendingMessageFocus, setPendingMessageFocus] = useState<string>();
  const [notificationTarget, setNotificationTarget] = useState<{
    threadId: string;
    messageId: string;
  } | null>();
  const [chatRequests, setChatRequests] = useState<Array<{ id: string; text: string }>>([]);
  const askInChat = (text: string) => {
    setChatRequests((current) => [...current, { id: crypto.randomUUID(), text }]);
    navigate('/');
  };
  const [inspectionFocus, setInspectionFocus] = useState<{ messageId: string; turnId: string }>();
  const developer = session.capabilities.developer;
  useEffect(() => subscribeDesktopFocusMessage(setNotificationTarget), []);
  useEffect(() => {
    if (notificationTarget === undefined || (notificationTarget && !state)) return;
    setNotificationTarget(undefined);
    if (notificationTarget && notificationTarget.threadId !== state?.threadId) return;
    navigate('/');
    if (notificationTarget)
      window.dispatchEvent(
        new CustomEvent('otto:focus-message', {
          detail: { messageId: notificationTarget.messageId },
        }),
      );
  }, [notificationTarget, state]);
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
      const detail = (event as CustomEvent<{ messageId: string; turnId: string }>).detail;
      if (!detail?.turnId) return;
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
    prefetchPageData(['/api/vault', '/api/tasks', '/api/schedules', '/api/apps']);
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
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${inspectorOpen ? 'with-inspector' : ''} ${entering ? 'shell-entering' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      {desktopSettingsAvailable() && (
        <DesktopToolbar
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          actionsRef={setToolbarActions}
        />
      )}
      <Sidebar
        path={currentPath}
        unreadCount={unread.count}
        unreadPending={unread.pending}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        inspectorEnabled={inspectorEnabled}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspector((value) => !value)}
        onNavigate={navigate}
        account={account}
      />
      <div className="workspace-frame">
        <div className="workspace-body">
          <main id="workspace" className="main-workspace" tabIndex={-1}>
            {settingsError && <Notice>{settingsError}</Notice>}
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
                  toolbarActions={currentPath === '/' ? toolbarActions : null}
                  visible={currentPath === '/'}
                  onReadLatest={unread.markRead}
                  onFeedback={onFeedback}
                  requestedMessage={chatRequests[0]}
                  onRequestHandled={(id) =>
                    setChatRequests((current) => current.filter((request) => request.id !== id))
                  }
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
            {currentPath === '/apps' && <Apps configuration={state?.configuration} />}
            {currentPath === '/channels' && <Channels hosted={session.auth.mode === 'google'} />}
            {currentPath === '/tasks' && <Tasks onAsk={askInChat} />}
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
    </div>
  );
}
function AuthenticatedApp({
  path,
  session,
  saving,
  onAccountUpdate,
  onLogout,
  feedbackRequest,
  onFeedbackHandled,
}: {
  path: string;
  session: SessionResponse;
  saving: boolean;
  onAccountUpdate(change: AccountUpdate): Promise<void>;
  onLogout(): void;
  feedbackRequest: number;
  onFeedbackHandled(): void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackTrigger = useRef<HTMLElement | null>(null);
  const openFeedback = () => {
    feedbackTrigger.current =
      document.activeElement !== document.body ? (document.activeElement as HTMLElement) : null;
    setFeedbackOpen(true);
  };
  useEffect(() => {
    if (!feedbackRequest) return;
    openFeedback();
    onFeedbackHandled();
  }, [feedbackRequest, onFeedbackHandled]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const [settingsTab, setSettingsTab] = useState<AccountTab>(
    desktopSettingsAvailable()
      ? 'General'
      : session.auth.mode === 'local'
        ? 'Appearance'
        : 'Profile',
  );
  const [settingsError, setSettingsError] = useState('');
  const settingsTrigger = useRef<HTMLElement | null>(null);
  const openSettings = (tab: AccountTab, trigger?: HTMLElement) => {
    setSettingsError('');
    setSettingsRequest((current) => current + 1);
    settingsTrigger.current = trigger ?? (document.activeElement as HTMLElement);
    setSettingsTab(
      desktopSettingsAvailable() && (tab === 'Appearance' || tab === 'Profile')
        ? 'General'
        : tab === 'Profile' && session.auth.mode === 'local'
          ? 'Appearance'
          : tab,
    );
    setSettingsOpen(true);
  };
  useEffect(
    () =>
      subscribeDesktopSettings((section) =>
        openSettings(
          section === 'models' ? 'Models' : section === 'preferences' ? 'Preferences' : 'General',
        ),
      ),
    [session.auth.mode],
  );
  useEffect(() => {
    const apply = () => {
      setSettingsError('');
      setSettingsOpen(false);
    };
    const failed = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail;
      if (typeof message === 'string') setSettingsError(message);
    };
    window.addEventListener('otto:apply-settings', apply);
    window.addEventListener('otto:settings-error', failed);
    return () => {
      window.removeEventListener('otto:apply-settings', apply);
      window.removeEventListener('otto:settings-error', failed);
    };
  }, []);
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
      if (
        document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') &&
        !settingsOpen
      )
        return;
      event.preventDefault();
      if (!settingsOpen) openSettings(session.auth.mode === 'local' ? 'Appearance' : 'Profile');
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [settingsOpen, session.auth.mode]);
  const account: AccountControls = {
    user: session.user!,
    local: session.auth.mode === 'local',
    theme: session.settings!.theme,
    saving,
    canLogout: session.auth.mode === 'google',
    onSettings: openSettings,
    onTheme: (theme) => onAccountUpdate({ theme }),
    onLogout,
  };
  const allowed = !['/browser', '/dev'].includes(path) || session.capabilities.developer;
  const match = /^\/(?:vault|credentials)\/([^/]+)\/?$/.exec(path);
  const workspace =
    allowed && path !== '/browser' && !match && session.settings!.onboardingCompleted;
  return (
    <>
      {!allowed ? (
        <main className="empty-state">
          <h1>This page isn’t here.</h1>
          <Button variant="outline" onClick={() => navigate('/')}>
            Back to chat
          </Button>
        </main>
      ) : path === '/browser' ? (
        <BrowserWindow />
      ) : match ? (
        <Credentials key={match[1]} id={match[1]} />
      ) : !session.settings!.onboardingCompleted ? (
        <Onboarding
          user={session.user!}
          canLogout={account.canLogout}
          onLogout={onLogout}
          onComplete={() => onAccountUpdate({ onboardingCompleted: true })}
        />
      ) : (
        <Workspace
          path={path}
          session={session}
          account={account}
          settingsError={settingsError}
          onFeedback={openFeedback}
        />
      )}
      {settingsError && !workspace && <Notice>{settingsError}</Notice>}
      <FeedbackDialog
        ownerId={session.user!.id}
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        returnFocus={() =>
          feedbackTrigger.current?.isConnected
            ? feedbackTrigger.current
            : document.getElementById('feedback-launcher')
        }
      />
      <AccountSettings
        account={account}
        open={settingsOpen}
        initialTab={settingsTab}
        openRequest={settingsRequest}
        onOpenChange={setSettingsOpen}
        onName={(name) => onAccountUpdate({ name })}
        returnFocus={() =>
          settingsTrigger.current?.isConnected
            ? settingsTrigger.current
            : document.querySelector<HTMLElement>(
                window.innerWidth <= 640
                  ? '.mobile-menu-trigger'
                  : account.local
                    ? '[aria-label="Settings"]'
                    : '.account-menu-trigger',
              )
        }
      />
    </>
  );
}
function AccountApp({
  path,
  setPath,
  feedbackRequest,
  onFeedbackHandled,
}: {
  path: string;
  setPath(path: string): void;
  feedbackRequest: number;
  onFeedbackHandled(): void;
}) {
  const sessionState = useSession();
  const { session } = sessionState;
  const legacyBrowserLink = /^\/browser-connect\/[A-Za-z0-9_-]{43}\/?$/.test(path);
  useEffect(() => {
    if (sessionState.loading || sessionState.signingOut) return;
    const secure = /^\/(?:vault|credentials)\/[^/]+\/?$/.test(path) || path === '/browser';
    capturePageview(
      !session?.user
        ? '/login'
        : !session.settings?.onboardingCompleted && !secure
          ? '/onboarding'
          : legacyBrowserLink
            ? '/apps'
            : path === '/login' || path === '/onboarding'
              ? '/'
              : path,
    );
  }, [path, sessionState.loading, sessionState.signingOut, session, legacyBrowserLink]);
  useEffect(() => {
    if (sessionState.loading || !session?.user || !session.settings) return;
    const secure = /^\/(?:vault|credentials)\/[^/]+\/?$/.test(path) || path === '/browser';
    const next =
      !session.settings.onboardingCompleted && !secure
        ? '/onboarding'
        : legacyBrowserLink
          ? '/apps'
          : path === '/login' || path === '/onboarding'
            ? '/'
            : null;
    if (next && next !== path) {
      window.history.replaceState(null, '', next);
      setPath(next);
    }
  }, [
    sessionState.loading,
    session?.user?.id,
    session?.settings?.onboardingCompleted,
    path,
    legacyBrowserLink,
  ]);
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
  return (
    <AuthenticatedApp
      key={key}
      path={legacyBrowserLink ? '/apps' : path === '/login' || path === '/onboarding' ? '/' : path}
      session={session}
      saving={sessionState.mutating}
      onAccountUpdate={sessionState.update}
      onLogout={logout}
      feedbackRequest={feedbackRequest}
      onFeedbackHandled={onFeedbackHandled}
    />
  );
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [feedbackRequest, setFeedbackRequest] = useState(0);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  useEffect(
    () =>
      onFeedbackRequested(() => {
        if (/^\/privacy\/?$/.test(window.location.pathname)) navigate('/');
        setFeedbackRequest((value) => value + 1);
      }),
    [],
  );
  return (
    <>
      {desktopSettingsAvailable() && <div className="desktop-titlebar" aria-hidden="true" />}
      {/^\/privacy\/?$/.test(path) ? (
        <Privacy />
      ) : (
        <AccountApp
          path={path}
          setPath={setPath}
          feedbackRequest={feedbackRequest}
          onFeedbackHandled={() => setFeedbackRequest(0)}
        />
      )}
    </>
  );
}
