type UiPreference =
  'nod.sidebar' | 'nod.chat-layout' | 'nod.artifact-width' | `nod.feedback.discovery.${string}`;

export function readUiPreference(key: UiPreference) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeUiPreference(key: UiPreference, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}
