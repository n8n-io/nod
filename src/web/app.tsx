import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft } from './components/icons';
import { Chat } from './pages/chat';
import { Usage } from './pages/usage';
import { Vault } from './pages/vault';
import { Apps } from './pages/apps';
import { Channels } from './pages/channels';
import { Credentials, Payment } from './pages/credentials';
import { Tasks } from './pages/tasks';
import { useAppState } from './hooks/use-app-state';
import { useChatUnread } from './hooks/use-chat-unread';
import { prefetchPageData } from './hooks/use-page-data';
import { Button, Notice } from './components/ui';
import { ChatSkeleton } from './components/startup';
import { SetupProgress } from './components/setup-progress';
import { Sidebar } from './components/sidebar';
import { DesktopToolbar } from './components/desktop-toolbar';
import { SidebarToggle } from './components/sidebar-toggle';
import { FeedbackDialog } from './components/feedback';
import { captureFeedbackScreenshot } from './lib/feedback-capture';
import { navigate, sidebarItems } from './lib/navigation';
import { appPagePath } from '../shared/app-links';
import { BrowserWindow } from './pages/browser';
import { readUiPreference, writeUiPreference } from './lib/ui-preferences';
import type { AccountPreferences, AccountUpdate, SessionResponse } from '../shared/account';
import { useSession } from './hooks/use-session';
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
  desktopRendererReady,
  saveDesktopSettings,
  onFeedbackRequested,
  subscribeDesktopFocusMessage,
  subscribeDesktopSettings,
  subscribeDesktopNavigation,
} from './lib/desktop';

function replayingOnboarding(path: string) {
  return (import.meta.env?.DEV === true || desktopSettingsAvailable()) && path === '/onboarding';
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

function settingsPage(path: string) {
  return ['/settings', '/settings/models', '/settings/memory'].includes(path);
}

function Workspace({
  path,
  session,
  account,
  onFeedback,
  onDismissFeedbackDiscovery,
  settings,
}: {
  path: string;
  session: SessionResponse;
  account: AccountControls;
  onFeedback(): void;
  onDismissFeedbackDiscovery?(): void;
  settings: ReactNode;
}) {
  const { state, streams, error, connected, refresh, resetConversation } = useAppState(
    session.user!.id,
  );
  const unread = useChatUnread(session.user!.id, state);
  useSavedDateFormat();
  useBrowserTimeZone();
  const [collapsed, setCollapsed] = useState(() => readUiPreference('nod.sidebar') !== 'expanded');
  const [sidebarMotion, setSidebarMotion] = useState(false);
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
  useEffect(() => subscribeDesktopFocusMessage(setNotificationTarget), []);
  useEffect(() => {
    if (notificationTarget === undefined || (notificationTarget && !state)) return;
    setNotificationTarget(undefined);
    if (notificationTarget && notificationTarget.threadId !== state?.threadId) return;
    navigate('/');
    if (notificationTarget)
      window.dispatchEvent(
        new CustomEvent('nod:focus-message', {
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
    window.addEventListener('nod:focus-message', focusMessage);
    return () => window.removeEventListener('nod:focus-message', focusMessage);
  }, [state]);
  const currentPath = path === '/you' ? '/' : path;
  const hasMessages = state ? state.messages.length > 0 : null;
  useEffect(() => {
    if (hasMessages !== null)
      writeUiPreference('nod.chat-layout', hasMessages ? 'conversation' : 'welcome');
  }, [hasMessages]);
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), 600);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    prefetchPageData([
      '/api/vault',
      '/api/vault/activity',
      '/api/trust',
      '/api/tasks',
      '/api/schedules',
      '/api/apps',
      '/api/apps/catalog',
      '/api/memory',
    ]);
  }, []);
  useEffect(() => {
    writeUiPreference('nod.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);
  function toggleSidebar(animate: boolean) {
    setSidebarMotion(animate);
    setCollapsed((value) => !value);
  }
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${sidebarMotion ? 'sidebar-motion' : ''} ${entering ? 'shell-entering' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      {desktopSettingsAvailable() && (
        <DesktopToolbar
          collapsed={collapsed}
          onToggle={() => toggleSidebar(true)}
          actionsRef={setToolbarActions}
        />
      )}
      <Sidebar
        path={currentPath}
        unreadCount={unread.count}
        unreadPending={unread.pending}
        onToggle={() => toggleSidebar(false)}
        onNavigate={navigate}
        account={account}
      />
      <div className="workspace-frame">
        {!desktopSettingsAvailable() && (
          <SidebarToggle collapsed={collapsed} onToggle={() => toggleSidebar(true)} />
        )}
        <div className="workspace-body">
          <main id="workspace" className="main-workspace" tabIndex={-1}>
            <div className="chat-route" hidden={currentPath !== '/'}>
              {state ? (
                <Chat
                  ownerId={session.user!.id}
                  state={state}
                  streams={streams}
                  refresh={refresh}
                  resetConversation={resetConversation}
                  initialFocusMessageId={pendingMessageFocus}
                  toolbarActions={currentPath === '/' ? toolbarActions : null}
                  visible={currentPath === '/'}
                  onReadLatest={unread.markRead}
                  onFeedback={onFeedback}
                  onDismissFeedbackDiscovery={onDismissFeedbackDiscovery}
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
            </div>
            {(currentPath === '/usage' || currentPath === '/vault') && (
              <>
                <Usage hidden={currentPath !== '/usage'} />
                <Vault hidden={currentPath !== '/vault'} onAsk={askInChat} />
              </>
            )}
            {currentPath === '/apps' && (
              <Apps configuration={state?.configuration} onAsk={askInChat} />
            )}
            {currentPath === '/channels' && <Channels />}
            {currentPath === '/tasks' && <Tasks onAsk={askInChat} activity={state?.activity} />}
            {settings}
            {!settingsPage(currentPath) &&
              !sidebarItems.some((item) => item.path === currentPath) && (
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
  feedbackRequest,
  onFeedbackHandled,
}: {
  path: string;
  session: SessionResponse;
  saving: boolean;
  onAccountUpdate(change: AccountUpdate): Promise<void>;
  feedbackRequest: number;
  onFeedbackHandled(): void;
}) {
  const feedbackDiscoveryKey = `nod.feedback.discovery.${session.user!.id}` as const;
  const firstOnboarding = useRef(!session.settings!.onboardingCompleted);
  const [feedbackDiscovery, setFeedbackDiscovery] = useState(
    () => readUiPreference(feedbackDiscoveryKey) === 'pending',
  );
  const dismissFeedbackDiscovery = () => {
    writeUiPreference(feedbackDiscoveryKey, 'dismissed');
    setFeedbackDiscovery(false);
  };
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackScreenshot, setFeedbackScreenshot] = useState<File | null>(null);
  const feedbackCapture = useRef<Promise<File | null> | null>(null);
  const feedbackTrigger = useRef<HTMLElement | null>(null);
  const openFeedback = async () => {
    if (feedbackOpen || feedbackCapture.current) return;
    dismissFeedbackDiscovery();
    feedbackTrigger.current =
      document.activeElement !== document.body ? (document.activeElement as HTMLElement) : null;
    const capture = captureFeedbackScreenshot().catch(() => null);
    feedbackCapture.current = capture;
    const screenshot = await capture;
    if (feedbackCapture.current !== capture) return;
    feedbackCapture.current = null;
    setFeedbackScreenshot(screenshot);
    setFeedbackOpen(true);
  };
  useEffect(() => {
    setFeedbackOpen(false);
    setFeedbackScreenshot(null);
    return () => {
      feedbackCapture.current = null;
    };
  }, [session.user!.id]);
  useEffect(() => {
    if (!feedbackRequest) return;
    openFeedback();
    onFeedbackHandled();
  }, [feedbackRequest, onFeedbackHandled]);
  const settingsOpen = settingsPage(path);
  const settingsReturn = useRef<{ path: string; trigger: HTMLElement | null }>({
    path: settingsOpen || path === '/memory' ? '/' : path,
    trigger: null,
  });
  useEffect(() => {
    if (!settingsOpen && path !== '/memory') settingsReturn.current = { path, trigger: null };
  }, [path, settingsOpen]);
  const [finishingOnboarding, setFinishingOnboarding] = useState(false);
  const onboarding =
    finishingOnboarding || !session.settings!.onboardingCompleted || replayingOnboarding(path);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const settingsTab: AccountTab =
    path === '/settings/models' ? 'Models' : path === '/settings/memory' ? 'Memory' : 'General';
  const settingsPath = (tab: AccountTab) =>
    tab === 'General' ? '/settings' : `/settings/${tab.toLowerCase()}`;
  const openSettings = (tab: AccountTab, trigger?: HTMLElement) => {
    const current = window.location.pathname;
    if (!settingsPage(current) && current !== '/memory')
      settingsReturn.current = {
        path: current,
        trigger:
          trigger ??
          (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : null),
      };
    setSettingsRequest((current) => current + 1);
    navigate(settingsPath(tab));
  };
  const openPage = (value: string, trigger?: HTMLElement) => {
    const destination = appPagePath(value);
    if (!destination) return;
    if (settingsPage(destination))
      openSettings(
        destination === '/settings/models'
          ? 'Models'
          : destination === '/settings/memory'
            ? 'Memory'
            : 'General',
        trigger,
      );
    else {
      navigate(destination);
      window.requestAnimationFrame(() => document.getElementById('workspace')?.focus());
    }
  };
  useEffect(
    () =>
      subscribeDesktopSettings((section) =>
        openSettings(section === 'models' ? 'Models' : 'General'),
      ),
    [],
  );
  useEffect(() => (onboarding ? undefined : subscribeDesktopNavigation(openPage)), [onboarding]);
  useEffect(() => {
    if (path !== '/memory' || !session.settings!.onboardingCompleted) return;
    window.history.replaceState(null, '', '/settings/memory');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [path, session.settings!.onboardingCompleted]);
  useEffect(() => {
    const openAppLink = (event: MouseEvent) => {
      const link =
        event.target instanceof Element && event.target.closest<HTMLAnchorElement>('a[href]');
      if (
        !link ||
        event.defaultPrevented ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.hasAttribute('download') ||
        (link.target && link.target !== '_self')
      )
        return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin || url.search || url.hash) return;
      const destination = appPagePath(url.pathname);
      if (!destination) return;
      event.preventDefault();
      openPage(destination, link);
    };
    document.addEventListener('click', openAppLink);
    return () => document.removeEventListener('click', openAppLink);
  }, []);
  useEffect(() => {
    if (!desktopSettingsAvailable()) return;
    const shortcut = (event: KeyboardEvent) => {
      const modifier = /Mac|iPhone|iPad/.test(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
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
      if (!settingsOpen) openSettings('General');
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [settingsOpen]);
  const account: AccountControls = {
    user: session.user!,
    theme: session.settings!.theme,
    usageData: session.settings!.usageData,
    traces: session.capabilities.traces ? session.settings!.traces : undefined,
    saving,
    onSettings: openSettings,
    onTheme: (theme) => onAccountUpdate({ theme }),
    onUsageData: (usageData) => onAccountUpdate({ usageData }),
    onTraces: (traces) => onAccountUpdate({ traces }),
  };
  const allowed = path !== '/browser' || session.capabilities.developer;
  const match = /^\/(vault|credentials|payments)\/([^/]+)\/?$/.exec(path);
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
        match[1] === 'payments' ? (
          <Payment key={match[2]} id={match[2]} />
        ) : (
          <Credentials key={match[2]} id={match[2]} />
        )
      ) : onboarding ? (
        <Onboarding
          user={session.user!}
          onFeedback={openFeedback}
          usageData={account.usageData}
          onUsageData={account.onUsageData}
          onComplete={async () => {
            setFinishingOnboarding(true);
            if (!session.settings!.onboardingCompleted)
              await onAccountUpdate({ onboardingCompleted: true });
            if (desktopSettingsAvailable())
              await saveDesktopSettings({ onboardingCompleted: true });
            if (firstOnboarding.current && readUiPreference(feedbackDiscoveryKey) !== 'dismissed') {
              writeUiPreference(feedbackDiscoveryKey, 'pending');
              setFeedbackDiscovery(true);
            }
            firstOnboarding.current = false;
            setFinishingOnboarding(false);
            if (replayingOnboarding(path)) navigate('/');
          }}
        />
      ) : (
        <Workspace
          path={path}
          session={session}
          account={account}
          settings={
            <AccountSettings
              account={account}
              open={settingsOpen}
              initialTab={settingsTab}
              openRequest={settingsRequest}
              onOpenChange={(open) => {
                if (!open) {
                  const previous = settingsReturn.current;
                  navigate(previous.path);
                  window.requestAnimationFrame(() => {
                    if (window.location.pathname !== previous.path) return;
                    if (
                      previous.trigger?.isConnected &&
                      !previous.trigger.closest('[hidden], [inert]')
                    ) {
                      previous.trigger.focus({ preventScroll: true });
                      if (document.activeElement === previous.trigger) return;
                    }
                    const composer =
                      previous.path === '/'
                        ? document.querySelector<HTMLElement>(
                            '.composer-editor[contenteditable="true"]',
                          )
                        : null;
                    (composer ?? document.getElementById('workspace'))?.focus({
                      preventScroll: true,
                    });
                  });
                }
              }}
              onTabChange={(tab, replace) => {
                if (replace) {
                  window.history.replaceState(null, '', settingsPath(tab));
                  window.dispatchEvent(new PopStateEvent('popstate'));
                } else navigate(settingsPath(tab));
              }}
              onReplayOnboarding={
                import.meta.env?.DEV === true && !desktopSettingsAvailable()
                  ? () => navigate('/onboarding?replay=1')
                  : undefined
              }
            />
          }
          onFeedback={openFeedback}
          onDismissFeedbackDiscovery={
            feedbackDiscovery && !feedbackOpen && !settingsOpen
              ? dismissFeedbackDiscovery
              : undefined
          }
        />
      )}
      <FeedbackDialog
        key={session.user!.id}
        ownerId={session.user!.id}
        screenshot={feedbackScreenshot}
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        returnFocus={() =>
          feedbackTrigger.current?.isConnected
            ? feedbackTrigger.current
            : document.getElementById('feedback-launcher')
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
  useEffect(() => {
    if (!sessionState.loading) desktopRendererReady();
  }, [sessionState.loading]);
  const legacyBrowserLink = /^\/browser-connect\/[A-Za-z0-9_-]{43}\/?$/.test(path);
  useLayoutEffect(() => {
    if (sessionState.loading || !session?.user) return;
    const secure = /^\/(?:vault|credentials|payments)\/[^/]+\/?$/.test(path) || path === '/browser';
    if (path === '/memory' && session.settings?.onboardingCompleted) return;
    capturePageview(
      !session.settings?.onboardingCompleted && !secure
        ? '/onboarding'
        : legacyBrowserLink
          ? '/apps'
          : path === '/onboarding'
            ? '/'
            : (path === '/browser' && !session.capabilities.developer) ||
                /^\/(?:vault|credentials|payments)\/?$/.test(path)
              ? '/not-found'
              : path,
    );
  }, [path, sessionState.loading, session, legacyBrowserLink]);
  useEffect(() => {
    if (sessionState.loading || !session?.user || !session.settings) return;
    const secure = /^\/(?:vault|credentials|payments)\/[^/]+\/?$/.test(path) || path === '/browser';
    const next =
      !session.settings.onboardingCompleted && !secure
        ? '/onboarding'
        : legacyBrowserLink
          ? '/apps'
          : path === '/onboarding' && !replayingOnboarding(path)
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
  if (sessionState.locked)
    return (
      <main className="empty-state">
        <p>
          {desktopSettingsAvailable()
            ? 'Open nod in the desktop app.'
            : 'Open nod from the link in your terminal.'}
        </p>
      </main>
    );
  if (sessionState.loading) return <SetupProgress title="Opening nod…" />;
  if (!session?.user || !session.settings)
    return (
      <main className="initial-loading">
        <Notice>{sessionState.error || 'nod could not be opened.'}</Notice>
        <Button variant="outline" onClick={() => void sessionState.refresh()}>
          Try again
        </Button>
      </main>
    );
  const key = `${session.user.id}:${sessionState.epoch}`;
  return (
    <AuthenticatedApp
      key={key}
      path={
        legacyBrowserLink
          ? '/apps'
          : path === '/onboarding' && !replayingOnboarding(path)
            ? '/'
            : path
      }
      session={session}
      saving={sessionState.mutating}
      onAccountUpdate={sessionState.update}
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
