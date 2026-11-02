const prefix = 'nod.onboarding.';
const stepCookie = 'nod_onboarding_step';

export function readStored<T>(key: string): T | undefined {
  try {
    const value = window.sessionStorage.getItem(prefix + key);
    return value === null ? undefined : (JSON.parse(value) as T);
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(prefix + key, JSON.stringify(value));
  } catch {}
}

export function clearStored() {
  try {
    for (const key of Object.keys(window.sessionStorage))
      if (key.startsWith(prefix)) window.sessionStorage.removeItem(key);
  } catch {}
  try {
    document.cookie = `${stepCookie}=; path=/; max-age=0; samesite=strict`;
  } catch {}
}

export function readStep<T>(): T | undefined {
  const stored = readStored<T>('step');
  if (stored) return stored;
  try {
    const value = document.cookie
      .split('; ')
      .find((entry) => entry.startsWith(`${stepCookie}=`))
      ?.slice(stepCookie.length + 1);
    return value ? (JSON.parse(decodeURIComponent(value)) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStep(value: unknown) {
  writeStored('step', value);
  try {
    document.cookie = `${stepCookie}=${encodeURIComponent(JSON.stringify(value))}; path=/; max-age=2592000; samesite=strict`;
  } catch {}
}
