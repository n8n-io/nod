import type { ChatReadCursor } from './chat-unread';

export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  notifications: boolean;
  launchAtLogin: boolean;
};

type DesktopWindow = Window & {
  ottoDesktop?: {
    onPrepareUpdate?(check: () => boolean): () => void;
    openSettings(section?: 'general' | 'providers' | 'preferences'): Promise<void>;
    openExternal(url: string): Promise<void>;
    getPreferences(): Promise<DesktopPreferences>;
    getBuildInfo?(): Promise<{
      version: string;
      electron: string;
      platform: string;
      arch: string;
      source?: string;
      builtAt?: string;
      modified?: boolean;
      runtime?: string;
    }>;
    setTheme(theme: DesktopPreferences['theme']): Promise<DesktopPreferences>;
    onPreferences(listener: (preferences: DesktopPreferences) => void): () => void;
    onFocusMessage?(
      listener: (target: { threadId: string; messageId: string } | null) => void,
    ): () => void;
    getChatReadCursor?(ownerId: string, threadId: string): Promise<ChatReadCursor | null>;
    setChatReadCursor?(ownerId: string, threadId: string, cursor: ChatReadCursor): Promise<void>;
  };
};

export function onPrepareDesktopUpdate(check: () => boolean) {
  return (window as DesktopWindow).ottoDesktop?.onPrepareUpdate?.(check) ?? (() => {});
}

export function desktopSettingsAvailable() {
  return typeof (window as DesktopWindow).ottoDesktop?.openSettings === 'function';
}

export async function openDesktopSettings(
  section: 'general' | 'providers' | 'preferences' = 'general',
) {
  await (window as DesktopWindow).ottoDesktop?.openSettings(section);
}

export function desktopPreferences() {
  return (window as DesktopWindow).ottoDesktop?.getPreferences();
}

export function setDesktopTheme(theme: DesktopPreferences['theme']) {
  return (window as DesktopWindow).ottoDesktop?.setTheme(theme);
}

export function subscribeDesktopPreferences(listener: (preferences: DesktopPreferences) => void) {
  return (window as DesktopWindow).ottoDesktop?.onPreferences(listener) ?? (() => {});
}

export function desktopChatReadCursor(ownerId: string, threadId: string) {
  return (window as DesktopWindow).ottoDesktop?.getChatReadCursor?.(ownerId, threadId);
}

export function subscribeDesktopFocusMessage(
  listener: (target: { threadId: string; messageId: string } | null) => void,
) {
  return (window as DesktopWindow).ottoDesktop?.onFocusMessage?.(listener) ?? (() => {});
}

export function saveDesktopChatReadCursor(
  ownerId: string,
  threadId: string,
  cursor: ChatReadCursor,
) {
  return (window as DesktopWindow).ottoDesktop?.setChatReadCursor?.(ownerId, threadId, cursor);
}

export function desktopLinksAvailable() {
  return typeof (window as DesktopWindow).ottoDesktop?.openExternal === 'function';
}

export async function openConnection(url: string) {
  if (desktopLinksAvailable()) await (window as DesktopWindow).ottoDesktop!.openExternal(url);
  else window.location.assign(url);
}

export function desktopBuildInfo() {
  return (window as DesktopWindow).ottoDesktop?.getBuildInfo?.();
}
