import {
  desktopPreferences,
  desktopSettingsAvailable,
  setDesktopTheme,
  subscribeDesktopPreferences,
  type DesktopPreferences,
} from './desktop';
import { analyticsForCurrentSession } from './analytics';

type Theme = 'light' | 'dark';
type ThemePreference = Theme | 'system';

const storageKey = 'nod.theme';
const changeEvent = 'nod:theme';
let chosenTheme: Theme | undefined;
let accountTheme: ThemePreference | undefined;
let desktopTheme: Theme | undefined;
let desktopPreference: ThemePreference | undefined;
let desktopPreferencesReady: Promise<DesktopPreferences | undefined> | undefined;

function resolvedTheme(): Theme {
  const preference = desktopSettingsAvailable()
    ? (desktopTheme ?? chosenTheme)
    : (accountTheme ?? chosenTheme);
  return preference === 'light' || preference === 'dark'
    ? preference
    : window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
}

function savedTheme(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', window.getComputedStyle(document.documentElement).backgroundColor);
  window.dispatchEvent(new Event(changeEvent));
}

function applyDesktopPreferences(preferences: DesktopPreferences) {
  desktopPreference = preferences.theme;
  desktopTheme = preferences.resolvedTheme;
  chosenTheme = preferences.theme === 'system' ? undefined : preferences.theme;
  try {
    window.localStorage.setItem(storageKey, preferences.theme);
  } catch {}
  applyTheme(resolvedTheme());
}

export async function setTheme(theme: ThemePreference) {
  const capture = analyticsForCurrentSession();
  if (desktopSettingsAvailable()) {
    let previous = desktopPreference;
    if (previous === undefined) {
      const initial = await (desktopPreferencesReady ??
        desktopPreferences()?.catch(() => undefined));
      previous = desktopPreference ?? initial?.theme;
    }
    const preferences = await setDesktopTheme(theme);
    if (preferences) {
      applyDesktopPreferences(preferences);
      if (previous !== undefined && previous !== theme && preferences.theme === theme)
        capture('local_setting_changed', { setting: 'theme', value: theme });
    }
    return;
  }
  chosenTheme = theme === 'system' ? undefined : theme;
  try {
    const previous = window.localStorage.getItem(storageKey);
    window.localStorage.setItem(storageKey, theme);
    if (previous !== theme && window.localStorage.getItem(storageKey) === theme)
      capture('local_setting_changed', { setting: 'theme', value: theme });
  } catch {}
  applyTheme(resolvedTheme());
}

export function applyAccountTheme(theme?: ThemePreference) {
  accountTheme = theme;
  applyTheme(resolvedTheme());
}

export function subscribeTheme(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  return () => window.removeEventListener(changeEvent, listener);
}

export function initializeTheme() {
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  accountTheme = undefined;
  desktopTheme = undefined;
  desktopPreference = undefined;
  if (desktopSettingsAvailable()) document.documentElement.dataset.desktop = 'true';
  const update = () => applyTheme(resolvedTheme());
  chosenTheme = savedTheme();
  update();
  let active = true;
  let revision = 0;
  const unsubscribe = subscribeDesktopPreferences((preferences) => {
    revision++;
    if (active) applyDesktopPreferences(preferences);
  });
  desktopPreferencesReady = desktopPreferences()?.catch(() => undefined);
  void desktopPreferencesReady
    ?.then((preferences) => {
      if (preferences && active && revision === 0) applyDesktopPreferences(preferences);
    })
    .catch(() => {});
  const storage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    if (desktopSettingsAvailable()) return;
    chosenTheme = savedTheme();
    update();
  };
  system?.addEventListener('change', update);
  window.addEventListener('storage', storage);
  return () => {
    active = false;
    unsubscribe();
    system?.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
