import type { ChatReadCursor } from './chat-unread';
import type { StartupStage } from '../../shared/desktop-startup';

export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  notifications: boolean;
  launchAtLogin: boolean;
};

export type DesktopSettings = DesktopPreferences;

type LocalSetup = {
  preferenceStep: 'launchAtLogin' | 'complete';
  launchAtLogin?: boolean;
  loginItemError?: string;
};

type LocalRuntime = {
  status(): Promise<DesktopStatus>;
  subscribeStatus(listener: (status: DesktopStatus) => void): () => void;
  prepare(options?: { retry: boolean }): Promise<DesktopStatus>;
  setup(): Promise<LocalSetup>;
  completePreferences(): Promise<LocalSetup>;
  reconcileSetup(): Promise<void>;
};

type ClientPlatform =
  | { kind: 'browser' }
  | { kind: 'desktop-remote' }
  | { kind: 'desktop-local'; runtime: LocalRuntime };

export type DesktopStatus = {
  phase?: string;
  stage?: StartupStage;
  message?: string;
  error?: string;
  progress?: number;
  secondsLeft?: number;
  runtime?: {
    phase?: string;
    stage?: StartupStage;
    message?: string;
    error?: string;
    progress?: number;
    secondsLeft?: number;
  };
};

export type DesktopUpdateStatus = {
  phase: 'idle' | 'checking' | 'preparing' | 'downloading' | 'ready';
  checking: boolean;
  progress?: number;
  readyVersion?: string;
  dismissedVersion?: string;
  failure?: {
    id: number;
    phase: 'checking' | 'preparing' | 'downloading' | 'restart';
    message: string;
    dismissed?: boolean;
  };
};

export type DesktopSettingsChange = Partial<
  Pick<DesktopPreferences, 'theme' | 'notifications' | 'launchAtLogin'>
>;

type DesktopSettingsSection = 'general' | 'models' | 'preferences';

type DesktopFeedbackContext = {
  appVersion: string;
  appRelease: string | null;
  appModified: boolean | null;
  development: boolean;
  source: 'desktop';
  platform: string | null;
};

type DesktopAppOpening = {
  openedAt: number;
  uuid: string;
  entry: 'native_setup' | 'app_ui';
  serverConnectionTelemetryAvailable?: true;
  loginItem?: 'registered' | 'not_registered' | 'failed' | 'unknown';
  sinceBoot?: 'under_5m' | 'under_1h' | 'over_1h';
};

type DesktopWindow = Window & {
  nodDesktop?: {
    protocolVersion?: number;
    mode?: 'local' | 'remote';
    localRuntime?: LocalRuntime;
    remote?: boolean;
    ready?(): Promise<void>;
    getSettings(): Promise<
      DesktopSettings & { onboardingPreferenceStep?: LocalSetup['preferenceStep'] }
    >;
    status?(): Promise<DesktopStatus>;
    onStatus?(listener: (status: DesktopStatus) => void): () => void;
    updateStatus?(): Promise<DesktopUpdateStatus>;
    onUpdateStatus?(listener: (status: DesktopUpdateStatus) => void): () => void;
    dismissUpdate?(version: string | number): Promise<void>;
    retryUpdate?(id: number): Promise<void>;
    downloadUpdate?(): Promise<void>;
    restartUpdate?(): Promise<void>;
    prepare?(options?: { retry: boolean }): Promise<DesktopStatus>;
    savePreferences?(input: DesktopSettingsChange): Promise<DesktopSettings>;
    saveSettings(
      input:
        | DesktopSettingsChange
        | { onboardingCompleted: true }
        | { launchAtLogin: true; onboardingPreferenceStep: 'complete' },
    ): Promise<
      DesktopSettings & {
        onboardingPreferenceStep?: LocalSetup['preferenceStep'];
        loginItemError?: string;
      }
    >;
    getZoomFactor?(): Promise<number>;
    setZoomFactor?(factor: number): Promise<number>;
    removeAllData(): Promise<void>;
    onOpenSettings(listener: (section: DesktopSettingsSection) => void): () => void;
    onNavigate?(listener: (path: string) => void): () => void;
    openExternal(url: string): Promise<void>;
    getPreferences(): Promise<DesktopPreferences>;
    takeAppOpening?(
      consented: boolean,
      distinctId: string | null,
    ): Promise<DesktopAppOpening | null>;
    getFeedbackContext?(): Promise<DesktopFeedbackContext>;
    captureFeedbackScreenshot?(): Promise<Uint8Array | null>;
    onFeedbackRequested?(listener: () => void): () => void;
    setTheme(theme: DesktopPreferences['theme']): Promise<DesktopPreferences>;
    onPreferences(listener: (preferences: DesktopPreferences) => void): () => void;
    onFocusMessage?(
      listener: (target: { threadId: string; messageId: string } | null) => void,
    ): () => void;
    getChatReadCursor?(ownerId: string, threadId: string): Promise<ChatReadCursor | null>;
    setChatReadCursor?(ownerId: string, threadId: string, cursor: ChatReadCursor): Promise<void>;
  };
};

export function desktopRendererReady() {
  void (window as DesktopWindow).nodDesktop?.ready?.();
}

export function clientPlatform(): ClientPlatform {
  const bridge = (window as DesktopWindow).nodDesktop;
  if (!bridge) return { kind: 'browser' };
  if (bridge.protocolVersion !== undefined) {
    if (bridge.protocolVersion !== 1 || !['local', 'remote'].includes(bridge.mode ?? ''))
      throw new Error('This desktop connection is not supported. Update Nod, then try again.');
    if (bridge.mode === 'remote') return { kind: 'desktop-remote' };
    if (!bridge.localRuntime)
      throw new Error('Local setup is unavailable. Update Nod, then try again.');
    return { kind: 'desktop-local', runtime: bridge.localRuntime };
  }
  if (typeof bridge.getSettings !== 'function') return { kind: 'browser' };
  if (bridge.remote) return { kind: 'desktop-remote' };
  return {
    kind: 'desktop-local',
    runtime: {
      status: () => {
        if (!bridge.status) throw new Error('Local setup is unavailable.');
        return bridge.status();
      },
      subscribeStatus: (listener) => bridge.onStatus?.(listener) ?? (() => {}),
      prepare: (options) => {
        if (!bridge.prepare) throw new Error('Restart Nod to try setting up your workspace again.');
        return bridge.prepare(options);
      },
      setup: async () => ({
        preferenceStep: (await bridge.getSettings()).onboardingPreferenceStep ?? 'launchAtLogin',
      }),
      completePreferences: async () => {
        const saved = await bridge.saveSettings({
          launchAtLogin: true,
          onboardingPreferenceStep: 'complete',
        });
        if (saved.onboardingPreferenceStep !== 'complete')
          throw new Error('Nod could not finish device setup. Try again.');
        return {
          preferenceStep: 'complete',
          launchAtLogin: saved.launchAtLogin,
          ...(saved.loginItemError ? { loginItemError: saved.loginItemError } : {}),
        };
      },
      reconcileSetup: async () => {
        await bridge.saveSettings({ onboardingCompleted: true });
      },
    },
  };
}

function localRuntime() {
  const platform = clientPlatform();
  if (platform.kind !== 'desktop-local') throw new Error('Local setup is unavailable.');
  return platform.runtime;
}

export function desktopRuntimeAvailable() {
  return clientPlatform().kind === 'desktop-local';
}

export function desktopSetup() {
  return localRuntime().setup();
}

export function completeDesktopPreferences() {
  return localRuntime().completePreferences();
}

export function desktopSettingsAvailable() {
  return typeof (window as DesktopWindow).nodDesktop?.getSettings === 'function';
}

export function desktopZoomAvailable() {
  const bridge = (window as DesktopWindow).nodDesktop;
  return typeof bridge?.getZoomFactor === 'function' && typeof bridge.setZoomFactor === 'function';
}

export function subscribeDesktopNavigation(listener: (path: string) => void) {
  return (window as DesktopWindow).nodDesktop?.onNavigate?.(listener);
}

export function subscribeDesktopSettings(listener: (section: DesktopSettingsSection) => void) {
  const receive = (event: Event) => {
    const section = (event as CustomEvent<unknown>).detail;
    if (section === 'general' || section === 'models' || section === 'preferences')
      listener(section);
  };
  window.addEventListener('nod:open-settings', receive);
  const unsubscribe = (window as DesktopWindow).nodDesktop?.onOpenSettings(listener);
  return () => {
    window.removeEventListener('nod:open-settings', receive);
    unsubscribe?.();
  };
}

function settingsBridge() {
  const bridge = (window as DesktopWindow).nodDesktop;
  if (!bridge) throw new Error('Desktop settings are unavailable.');
  return bridge;
}

export function getDesktopSettings() {
  const bridge = settingsBridge();
  return bridge.protocolVersion === 1 ? bridge.getPreferences() : bridge.getSettings();
}

export function saveDesktopSettings(change: DesktopSettingsChange) {
  const bridge = settingsBridge();
  return bridge.savePreferences ? bridge.savePreferences(change) : bridge.saveSettings(change);
}

export function getDesktopZoomFactor() {
  const bridge = settingsBridge();
  return bridge.getZoomFactor?.() ?? Promise.reject(new Error('Desktop zoom is unavailable.'));
}

export function setDesktopZoomFactor(factor: number) {
  const bridge = settingsBridge();
  return (
    bridge.setZoomFactor?.(factor) ?? Promise.reject(new Error('Desktop zoom is unavailable.'))
  );
}

export function removeDesktopData() {
  return settingsBridge().removeAllData();
}

export function desktopPreferences() {
  return (window as DesktopWindow).nodDesktop?.getPreferences();
}

export function setDesktopTheme(theme: DesktopPreferences['theme']) {
  return (window as DesktopWindow).nodDesktop?.setTheme(theme);
}

export function subscribeDesktopPreferences(listener: (preferences: DesktopPreferences) => void) {
  return (window as DesktopWindow).nodDesktop?.onPreferences(listener) ?? (() => {});
}

export function desktopChatReadCursor(ownerId: string, threadId: string) {
  return (window as DesktopWindow).nodDesktop?.getChatReadCursor?.(ownerId, threadId);
}

export function subscribeDesktopFocusMessage(
  listener: (target: { threadId: string; messageId: string } | null) => void,
) {
  return (window as DesktopWindow).nodDesktop?.onFocusMessage?.(listener) ?? (() => {});
}

export function saveDesktopChatReadCursor(
  ownerId: string,
  threadId: string,
  cursor: ChatReadCursor,
) {
  return (window as DesktopWindow).nodDesktop?.setChatReadCursor?.(ownerId, threadId, cursor);
}

export function desktopLinksAvailable() {
  return typeof (window as DesktopWindow).nodDesktop?.openExternal === 'function';
}

export function desktopAppOpeningAvailable() {
  return typeof (window as DesktopWindow).nodDesktop?.takeAppOpening === 'function';
}

export function takeDesktopAppOpening(consented: boolean, distinctId: string | null) {
  return (window as DesktopWindow).nodDesktop?.takeAppOpening?.(consented, distinctId);
}

export async function openConnection(url: string) {
  if (desktopLinksAvailable()) await (window as DesktopWindow).nodDesktop!.openExternal(url);
  else window.location.assign(url);
}

export function desktopFeedbackContext() {
  return (window as DesktopWindow).nodDesktop?.getFeedbackContext?.();
}

export function desktopFeedbackScreenshot() {
  return (window as DesktopWindow).nodDesktop?.captureFeedbackScreenshot?.();
}

export function desktopFeedbackScreenshotAvailable() {
  return typeof (window as DesktopWindow).nodDesktop?.captureFeedbackScreenshot === 'function';
}

export function onFeedbackRequested(listener: () => void) {
  return (window as DesktopWindow).nodDesktop?.onFeedbackRequested?.(listener) ?? (() => {});
}

export function desktopStatus() {
  const platform = clientPlatform();
  return platform.kind === 'desktop-local' ? platform.runtime.status() : undefined;
}

export function subscribeDesktopStatus(listener: (status: DesktopStatus) => void) {
  const platform = clientPlatform();
  return platform.kind === 'desktop-local' ? platform.runtime.subscribeStatus(listener) : () => {};
}

export function desktopUpdateStatus() {
  return (window as DesktopWindow).nodDesktop?.updateStatus?.();
}

export function subscribeDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void) {
  return (window as DesktopWindow).nodDesktop?.onUpdateStatus?.(listener) ?? (() => {});
}

export function dismissDesktopUpdate(version: string | number) {
  const dismiss = (window as DesktopWindow).nodDesktop?.dismissUpdate;
  if (!dismiss) return Promise.reject(new Error('Desktop updates are unavailable.'));
  return dismiss(version);
}

export function retryDesktopUpdate(id: number) {
  const retry = (window as DesktopWindow).nodDesktop?.retryUpdate;
  if (!retry) return Promise.reject(new Error('Desktop updates are unavailable.'));
  return retry(id);
}

export function downloadDesktopUpdate() {
  const download = (window as DesktopWindow).nodDesktop?.downloadUpdate;
  if (!download) return Promise.reject(new Error('Desktop updates are unavailable.'));
  return download();
}

export function restartDesktopUpdate() {
  const restart = (window as DesktopWindow).nodDesktop?.restartUpdate;
  if (!restart) return Promise.reject(new Error('Desktop updates are unavailable.'));
  return restart();
}

export async function retryDesktopRuntime() {
  const status = await localRuntime().prepare({ retry: true });
  const failure =
    status.error ||
    (status.phase === 'error' ? status.message : undefined) ||
    status.runtime?.error ||
    (status.runtime?.phase === 'error' ? status.runtime.message : undefined);
  if (failure || status.phase !== 'ready' || status.runtime?.phase !== 'ready')
    throw new Error(failure || 'Your workspace is not ready yet. Try again.');
}

export function desktopFilesAvailable() {
  return (
    typeof (window as DesktopWindow & { nodDesktop?: { fileAction?: unknown } }).nodDesktop
      ?.fileAction === 'function'
  );
}

export function desktopFileAction(
  id: string,
  action: 'prepare' | 'drag' | 'save' | 'open' | 'show',
) {
  const bridge = (
    window as unknown as { nodDesktop?: { fileAction(id: string, action: string): Promise<void> } }
  ).nodDesktop;
  if (!bridge?.fileAction)
    return Promise.reject(new Error('This file action needs the desktop app.'));
  return bridge.fileAction(id, action);
}

export function nativeFileMenu(id: string, image: boolean): Promise<string | null> {
  return (
    window as unknown as {
      nodDesktop: { fileMenu(id: string, image: boolean): Promise<string | null> };
    }
  ).nodDesktop.fileMenu(id, image);
}
