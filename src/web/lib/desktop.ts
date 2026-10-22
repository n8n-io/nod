import type { ChatReadCursor } from './chat-unread';

export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  notifications: boolean;
  launchAtLogin: boolean;
};

export type DesktopSettings = DesktopPreferences & {
  onboardingPreferenceStep: 'notifications' | 'launchAtLogin' | 'complete';
};

export type DesktopStatus = {
  phase?: string;
  message?: string;
  error?: string;
  runtime?: { phase?: string; message?: string; error?: string };
};

export type DesktopSettingsChange = { onboardingCompleted?: true } & Partial<
  Pick<DesktopSettings, 'theme' | 'notifications' | 'launchAtLogin' | 'onboardingPreferenceStep'>
>;

export type DesktopSettingsSection = 'general' | 'models' | 'preferences';

export type DesktopFeedbackContext = {
  computerName: string | null;
  appVersion: string;
  appRelease: string | null;
  appModified: boolean | null;
  development: boolean;
  source: 'desktop';
  platform: string | null;
};

type DesktopWindow = Window & {
  nodDesktop?: {
    ready?(): Promise<void>;
    getSettings(): Promise<DesktopSettings>;
    status?(): Promise<DesktopStatus>;
    onStatus?(listener: (status: DesktopStatus) => void): () => void;
    prepare?(options?: { retry: boolean }): Promise<DesktopStatus>;
    saveSettings(input: DesktopSettingsChange): Promise<DesktopSettings>;
    removeAllData(): Promise<void>;
    onOpenSettings(listener: (section: DesktopSettingsSection) => void): () => void;
    openExternal(url: string): Promise<void>;
    getPreferences(): Promise<DesktopPreferences>;
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

export function desktopSettingsAvailable() {
  return typeof (window as DesktopWindow).nodDesktop?.getSettings === 'function';
}

export function openDesktopSettings(section: DesktopSettingsSection = 'general') {
  window.dispatchEvent(new window.CustomEvent('nod:open-settings', { detail: section }));
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
  return settingsBridge().getSettings();
}

export function saveDesktopSettings(change: DesktopSettingsChange) {
  return settingsBridge().saveSettings(change);
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

export function onFeedbackRequested(listener: () => void) {
  return (window as DesktopWindow).nodDesktop?.onFeedbackRequested?.(listener) ?? (() => {});
}

export function desktopStatus() {
  return (window as DesktopWindow).nodDesktop?.status?.();
}

export function subscribeDesktopStatus(listener: (status: DesktopStatus) => void) {
  return (window as DesktopWindow).nodDesktop?.onStatus?.(listener) ?? (() => {});
}

export async function retryDesktopRuntime() {
  const bridge = (window as DesktopWindow).nodDesktop;
  if (!bridge?.prepare) throw new Error('Restart nod to try setting up your workspace again.');
  const status = await bridge.prepare({ retry: true });
  const failure =
    status.error ||
    (status.phase === 'error' ? status.message : undefined) ||
    status.runtime?.error ||
    (status.runtime?.phase === 'error' ? status.runtime.message : undefined);
  if (failure || status.phase !== 'ready' || status.runtime?.phase !== 'ready')
    throw new Error(failure || 'Your workspace is not ready yet. Try again.');
}
