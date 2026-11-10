import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from './components/icons';
import { Chat } from './pages/chat';
import { Usage } from './pages/usage';
import { Vault } from './pages/vault';
import { Apps } from './pages/apps';
import { Channels } from './pages/channels';
import { Credentials, Payment } from './pages/credentials';
import { Scheduled } from './pages/tasks';
import { PreparedWork } from './pages/prepared';
import { useAppState } from './hooks/use-app-state';
import { useChatUnread } from './hooks/use-chat-unread';
import { useBrowserNotifications } from './hooks/use-browser-notifications';
import { prefetchPageData } from './hooks/use-page-data';
import { Button, Notice } from './components/ui';
import { ChatSkeleton } from './components/startup';
import { SetupProgress } from './components/setup-progress';
import { ServerAccess } from './components/server-access';
import { Sidebar } from './components/sidebar';
import { DesktopToolbar } from './components/desktop-toolbar';
import { DesktopUpdateToast } from './components/desktop-update-toast';
import { SidebarToggle } from './components/sidebar-toggle';
import { FeedbackDialog } from './components/feedback';
import { createFeedbackCapture } from './lib/feedback-capture';
import { navigate, replaceNavigation, sidebarItems, subscribeNavigation } from './lib/navigation';
import { appPagePath, preparedWorkId } from '../shared/app-links';
import { BrowserWindow } from './pages/browser';
import { readUiPreference, writeUiPreference } from './lib/ui-preferences';
import type { AccountPreferences, AccountUpdate, SessionResponse } from '../shared/account';
import type { useSession } from './hooks/use-session';
import { Privacy } from './pages/privacy';
import { Onboarding } from './pages/onboarding';
import { SurveyCard } from './components/survey-card';
import { AccountSettings, isSettingsPage, settingsSections } from './components/account-settings';
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
  subscribeDesktopStatus,
  desktopStatus,
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
  return isSettingsPage(path);
}

function Workspace({
  path,
  session,
  account,
  onFeedback,
  onDismissFeedbackDiscovery,
  initialFocusMessageId,
  onFocusMessageHandled,
  settings,
  onReturnToMemory,
}: {
  path: string;
  session: SessionResponse;
  account: AccountControls;
  onFeedback(): void;
  onDismissFeedbackDiscovery?(): void;
  initialFocusMessageId?: string;
  onFocusMessageHandled(): void;
  settings: ReactNode;
  onReturnToMemory?(): void;
}) {
  const { state, streams, error, connected, refresh } = useAppState(session.user!.id);
  const unread = useChatUnread(session.user!.id, state);
  useBrowserNotifications(session.user!.id, state);
  useSavedDateFormat();
  useBrowserTimeZone();
  const [collapsed, setCollapsed] = useState(() => readUiPreference('nod.sidebar') !== 'expanded');
  const [toolbarActions, setToolbarActions] = useState<HTMLDivElement | null>(null);
  const [mobileActions, setMobileActions] = useState<HTMLDivElement | null>(null);
  const [mobileHeader, setMobileHeader] = useState(
    () => window.matchMedia?.('(max-width: 640px)').matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 640px)');
    const update = () => setMobileHeader(media?.matches ?? false);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  const [pendingMessageFocus, setPendingMessageFocus] = useState(initialFocusMessageId);
  useEffect(() => {
    if (initialFocusMessageId) onFocusMessageHandled();
  }, [initialFocusMessageId]);
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
  function toggleSidebar() {
    setCollapsed((value) => !value);
  }
  return (
    <div
      className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${entering ? 'shell-entering' : ''} ${settingsPage(path) ? 'settings-open' : ''}`}
    >
      <a href="#workspace" className="skip-link">
        Skip to content
      </a>
      {desktopSettingsAvailable() && <DesktopToolbar actionsRef={setToolbarActions} />}
      {!settingsPage(path) && (
        <Sidebar
          path={path}
          unreadCount={unread.count}
          unreadPending={unread.pending}
          presence={
            !connected
              ? undefined
              : state?.turns[0]?.status === 'waiting' ||
                  state?.tasks?.some((task) => task.status === 'needs_you')
                ? 'waiting'
                : state?.activity?.some((item) => !item.background)
                  ? 'working'
                  : undefined
          }
          onToggle={toggleSidebar}
          onNavigate={navigate}
          account={account}
          actionsRef={setMobileActions}
        />
      )}
      <div className="workspace-frame">
        {!settingsPage(path) && <SidebarToggle collapsed={collapsed} onToggle={toggleSidebar} />}
        <div className="workspace-body">
          <main id="workspace" className="main-workspace" tabIndex={-1}>
            <div className="chat-route" hidden={path !== '/'}>
              {state ? (
                <Chat
                  ownerId={session.user!.id}
                  state={state}
                  streams={streams}
                  connected={connected}
                  refresh={refresh}
                  initialFocusMessageId={pendingMessageFocus}
                  onReturnToMemory={onReturnToMemory}
                  toolbarActions={
                    path === '/'
                      ? !desktopSettingsAvailable() && mobileHeader
                        ? mobileActions
                        : toolbarActions
                      : null
                  }
                  visible={path === '/'}
                  readCursor={unread.cursor}
                  readUnavailable={unread.unavailable}
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
            {(path === '/usage' || path === '/vault') && (
              <>
                <Usage hidden={path !== '/usage'} />
                <Vault hidden={path !== '/vault'} onAsk={askInChat} />
              </>
            )}
            {path === '/apps' && <Apps configuration={state?.configuration} onAsk={askInChat} />}
            {path === '/channels' && <Channels />}
            {path === '/tasks' && (
              <Scheduled onAsk={askInChat} activity={connected ? state?.activity : undefined} />
            )}
            {preparedWorkId(path) && <PreparedWork key={path} id={preparedWorkId(path)!} />}
            {settings}
            {!settingsPage(path) &&
              !preparedWorkId(path) &&
              !sidebarItems.some((item) => item.path === path) && (
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
function BrowserNotificationWindow({
  ownerId,
  onFocusMessage,
}: {
  ownerId: string;
  onFocusMessage(messageId: string): void;
}) {
  const { state } = useAppState(ownerId);
  useBrowserNotifications(ownerId, state);
  useEffect(() => {
    const focusMessage = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: unknown }>).detail;
      if (typeof detail?.messageId === 'string') {
        onFocusMessage(detail.messageId);
        navigate('/');
      }
    };
    window.addEventListener('nod:focus-message', focusMessage);
    return () => window.removeEventListener('nod:focus-message', focusMessage);
  }, [onFocusMessage]);
  return <BrowserWindow />;
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
  const [feedbackDiscovery, setFeedbackDiscovery] = useState(
    () => readUiPreference(feedbackDiscoveryKey) === 'pending',
  );
  const dismissFeedbackDiscovery = () => {
    writeUiPreference(feedbackDiscoveryKey, 'dismissed');
    setFeedbackDiscovery(false);
  };
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackScreenshot, setFeedbackScreenshot] = useState<File | null>(null);
  const draftCapture = useMemo(() => createFeedbackCapture(session.user!.id), [session.user!.id]);
  const feedbackCapture = useRef<Promise<File | null> | null>(null);
  const feedbackTrigger = useRef<HTMLElement | null>(null);
  const openFeedback = async () => {
    if (feedbackOpen || feedbackCapture.current) return;
    dismissFeedbackDiscovery();
    feedbackTrigger.current =
      document.activeElement !== document.body ? (document.activeElement as HTMLElement) : null;
    const capture = draftCapture.capture();
    feedbackCapture.current = capture;
    const screenshot = await capture;
    if (feedbackCapture.current !== capture) return;
    feedbackCapture.current = null;
    setFeedbackScreenshot(screenshot);
    setFeedbackOpen(true);
  };
  useLayoutEffect(() => {
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
  const [browserNotificationTarget, setBrowserNotificationTarget] = useState<string>();
  const [memorySource, setMemorySource] = useState(false);
  useEffect(() => {
    if (path !== '/') setMemorySource(false);
  }, [path]);
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: unknown }>).detail;
      if (detail?.source !== 'memory') setMemorySource(false);
    };
    window.addEventListener('nod:focus-message', focus);
    return () => window.removeEventListener('nod:focus-message', focus);
  }, []);
  const [finishingOnboarding, setFinishingOnboarding] = useState(false);
  const onboarding =
    finishingOnboarding || !session.settings!.onboardingCompleted || replayingOnboarding(path);
  useEffect(() => {
    if (
      !onboarding ||
      path === '/browser' ||
      /^\/(vault|credentials|payments)\/[^/]+\/?$/.test(path)
    )
      desktopRendererReady();
  }, [onboarding, path]);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const settingsTab: AccountTab =
    settingsSections.find((section) => section.path === path)?.label ?? 'General';
  const settingsPath = (tab: AccountTab) =>
    settingsSections.find((section) => section.label === tab)?.path ?? '/settings';
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
        settingsSections.find((section) => section.path === destination)?.label ?? 'General',
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
  const pendingDesktopPage = useRef<string | null>(null);
  useEffect(() => {
    if (!onboarding && pendingDesktopPage.current) {
      const destination = pendingDesktopPage.current;
      pendingDesktopPage.current = null;
      openPage(destination);
    }
    return subscribeDesktopNavigation((path) => {
      const destination = appPagePath(path);
      if (!destination) return;
      if (onboarding) {
        if (destination !== '/apps') pendingDesktopPage.current = destination;
      } else openPage(destination);
    });
  }, [onboarding]);
  useEffect(() => {
    if (path !== '/memory' || !session.settings!.onboardingCompleted) return;
    replaceNavigation('/settings/memory');
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
        desktopSettingsAvailable() ? (
          <BrowserWindow />
        ) : (
          <BrowserNotificationWindow
            key={session.user!.id}
            ownerId={session.user!.id}
            onFocusMessage={setBrowserNotificationTarget}
          />
        )
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
          usageShared={Boolean(session.analytics?.enabled)}
          updatesEmail={session.capabilities.updatesEmail}
          traces={account.traces}
          onTraces={account.onTraces}
          onComplete={async () => {
            setFinishingOnboarding(true);
            if (!session.settings!.onboardingCompleted)
              await onAccountUpdate({ onboardingCompleted: true });
            if (desktopSettingsAvailable())
              await saveDesktopSettings({ onboardingCompleted: true });
            pendingDesktopPage.current = null;
            replaceNavigation('/');
            setFinishingOnboarding(false);
          }}
        />
      ) : (
        <>
          <SurveyCard />
          <Workspace
            path={path}
            session={session}
            account={account}
            initialFocusMessageId={browserNotificationTarget}
            onFocusMessageHandled={() => setBrowserNotificationTarget(undefined)}
            onReturnToMemory={memorySource ? () => openSettings('Memory') : undefined}
            settings={
              <AccountSettings
                account={account}
                open={settingsOpen}
                initialTab={settingsTab}
                openRequest={settingsRequest}
                onOpenSource={(messageId) => {
                  setMemorySource(true);
                  window.dispatchEvent(
                    new CustomEvent('nod:focus-message', {
                      detail: { messageId, source: 'memory' },
                    }),
                  );
                }}
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
                    replaceNavigation(settingsPath(tab));
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
        </>
      )}
      <FeedbackDialog
        key={session.user!.id}
        ownerId={session.user!.id}
        screenshot={feedbackScreenshot}
        onDraftCleared={draftCapture.reset}
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
  sessionState,
  path,
  setPath,
  feedbackRequest,
  onFeedbackHandled,
}: {
  sessionState: ReturnType<typeof useSession>;
  path: string;
  setPath(path: string): void;
  feedbackRequest: number;
  onFeedbackHandled(): void;
}) {
  const { session } = sessionState;
  useEffect(() => {
    if (!sessionState.loading && (!session?.user || !session.settings)) desktopRendererReady();
  }, [sessionState.loading, session?.user, session?.settings]);
  useLayoutEffect(() => {
    if (sessionState.loading || !session?.user) return;
    const secure = /^\/(?:vault|credentials|payments)\/[^/]+\/?$/.test(path) || path === '/browser';
    if (path === '/memory' && session.settings?.onboardingCompleted) return;
    capturePageview(
      (!session.settings?.onboardingCompleted || replayingOnboarding(path)) && !secure
        ? '/onboarding'
        : path === '/onboarding'
          ? '/'
          : (secure && (path !== '/browser' || session.capabilities.developer)) ||
              settingsPage(path) ||
              sidebarItems.some((item) => item.path === path) ||
              preparedWorkId(path)
            ? path
            : '/not-found',
    );
  }, [path, sessionState.loading, session]);
  useEffect(() => {
    if (sessionState.loading || !session?.user || !session.settings) return;
    const secure = /^\/(?:vault|credentials|payments)\/[^/]+\/?$/.test(path) || path === '/browser';
    const next =
      !session.settings.onboardingCompleted && !secure
        ? '/onboarding'
        : path === '/onboarding' && !replayingOnboarding(path)
          ? '/'
          : null;
    if (next && next !== path) {
      window.history.replaceState(null, '', next);
      setPath(next);
    }
  }, [sessionState.loading, session?.user?.id, session?.settings?.onboardingCompleted, path]);
  if (sessionState.locked)
    if (!desktopSettingsAvailable()) return <ServerAccess onConnected={sessionState.refresh} />;
    else
      return (
        <main className="empty-state">
          <p>Open Nod in the desktop app.</p>
        </main>
      );
  if (sessionState.loading) return <SetupProgress title="Opening Nod…" />;
  if (!session?.user || !session.settings)
    return (
      <main className="initial-loading">
        <Notice>{sessionState.error || 'Nod could not be opened.'}</Notice>
        <Button variant="outline" onClick={() => void sessionState.refresh()}>
          Try again
        </Button>
      </main>
    );
  const key = `${session.user.id}:${sessionState.epoch}`;
  return (
    <AuthenticatedApp
      key={key}
      path={path === '/onboarding' && !replayingOnboarding(path) ? '/' : path}
      session={session}
      saving={sessionState.mutating}
      onAccountUpdate={sessionState.update}
      feedbackRequest={feedbackRequest}
      onFeedbackHandled={onFeedbackHandled}
    />
  );
}

export function App({ sessionState }: { sessionState: ReturnType<typeof useSession> }) {
  const [path, setPath] = useState(window.location.pathname);
  const [feedbackRequest, setFeedbackRequest] = useState(0);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    let received = false;
    const stop = subscribeDesktopStatus((status) => {
      received = true;
      setUpdating(status.phase === 'updating');
    });
    void desktopStatus()
      ?.then((status) => {
        if (!received) setUpdating(status.phase === 'updating');
      })
      .catch(() => {});
    return stop;
  }, []);
  useEffect(() => {
    return subscribeNavigation(() => setPath(window.location.pathname));
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
      {updating ? (
        <SetupProgress title="Updating Nod…" description="Nod reopens when it’s done." />
      ) : /^\/privacy\/?$/.test(path) ? (
        <Privacy />
      ) : (
        <AccountApp
          sessionState={sessionState}
          path={path}
          setPath={setPath}
          feedbackRequest={feedbackRequest}
          onFeedbackHandled={() => setFeedbackRequest(0)}
        />
      )}
      {desktopSettingsAvailable() && !updating && <DesktopUpdateToast />}
    </>
  );
}
