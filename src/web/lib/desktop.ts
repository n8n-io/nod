import type { ChatReadCursor } from './chat-unread';

export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark';
  resolvedTheme: 'light' | 'dark';
  notifications: boolean;
  launchAtLogin: boolean;
};

export type DesktopSettings = DesktopPreferences & {
  hasComposioKey: boolean;
  keys: { composioApiKey: { suffix: string | null } };
  restartRequired: boolean;
};

export type DesktopSettingsChange = Partial<
  Pick<DesktopPreferences, 'theme' | 'notifications' | 'launchAtLogin'>
> & { composioApiKey?: string | null };

export type DesktopSettingsSection = 'general' | 'models' | 'preferences';

type DesktopWindow = Window & {
  ottoDesktop?: {
    onPrepareUpdate?(check: () => boolean): () => void;
    getSettings(): Promise<DesktopSettings>;
    saveSettings(input: DesktopSettingsChange): Promise<DesktopSettings>;
    revealComposioKey(): Promise<string>;
    applySettings(): Promise<void>;
    onOpenSettings(listener: (section: DesktopSettingsSection) => void): () => void;
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
  return typeof (window as DesktopWindow).ottoDesktop?.getSettings === 'function';
}

export function openDesktopSettings(section: DesktopSettingsSection = 'general') {
  window.dispatchEvent(new window.CustomEvent('otto:open-settings', { detail: section }));
}

export function subscribeDesktopSettings(listener: (section: DesktopSettingsSection) => void) {
  const receive = (event: Event) => {
    const section = (event as CustomEvent<unknown>).detail;
    if (section === 'general' || section === 'models' || section === 'preferences')
      listener(section);
  };
  window.addEventListener('otto:open-settings', receive);
  const unsubscribe = (window as DesktopWindow).ottoDesktop?.onOpenSettings(listener);
  return () => {
    window.removeEventListener('otto:open-settings', receive);
    unsubscribe?.();
  };
}

function settingsBridge() {
  const bridge = (window as DesktopWindow).ottoDesktop;
  if (!bridge) throw new Error('Desktop settings are unavailable.');
  return bridge;
}

export function getDesktopSettings() {
  return settingsBridge().getSettings();
}

export function saveDesktopSettings(change: DesktopSettingsChange) {
  return settingsBridge().saveSettings(change);
}

export function revealDesktopComposioKey() {
  return settingsBridge().revealComposioKey();
}

export async function applyDesktopSettings() {
  window.dispatchEvent(new window.Event('otto:apply-settings'));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  try {
    await settingsBridge().applySettings();
  } catch (cause) {
    window.dispatchEvent(
      new window.CustomEvent('otto:settings-error', {
        detail:
          'Your key change is saved but could not be applied yet. Finish your current work, then try again in Settings → Models.',
      }),
    );
    throw cause;
  }
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
