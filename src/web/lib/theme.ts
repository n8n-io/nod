export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

const storageKey = 'otto.theme';
const changeEvent = 'otto:theme';
let chosenTheme: Theme | undefined;
let accountTheme: ThemePreference | undefined;

function resolvedTheme(): Theme {
  const preference = accountTheme ?? chosenTheme;
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
    ?.setAttribute('content', theme === 'dark' ? '#1e1b21' : '#fdfcfe');
  window.dispatchEvent(new Event(changeEvent));
}

export function setTheme(theme: ThemePreference) {
  chosenTheme = theme === 'system' ? undefined : theme;
  try {
    window.localStorage.setItem(storageKey, theme);
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
  const update = () => applyTheme(resolvedTheme());
  chosenTheme = savedTheme();
  update();
  const storage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    chosenTheme = savedTheme();
    update();
  };
  system?.addEventListener('change', update);
  window.addEventListener('storage', storage);
  return () => {
    system?.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
