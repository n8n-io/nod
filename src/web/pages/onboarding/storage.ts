import type { Connection } from '../../../shared/contracts';
import { api, post } from '../../lib/api';
import type { ChannelSettings } from '../../lib/secondary-pages';

const prefix = 'otto.onboarding.';
const stepCookie = 'otto_onboarding_step';

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
    document.cookie = `${stepCookie}=${encodeURIComponent(JSON.stringify(value))}; path=/; samesite=strict`;
  } catch {}
}

type Requested = { gmail: boolean; telegram: boolean };

async function connected(): Promise<Requested> {
  const [apps, settings] = await Promise.all([
    api<Connection[]>('/api/apps').catch((): Connection[] => []),
    api<ChannelSettings>('/api/channel-settings').catch((): ChannelSettings => ({
      ready: false,
      channels: [],
    })),
  ]);
  return {
    gmail: apps.some((app) => app.slug === 'gmail' && app.status === 'connected'),
    telegram: settings.channels.some(
      (channel) => channel.provider === 'telegram' && channel.enabled && !!channel.allowedUserId,
    ),
  };
}

let preparing = Promise.resolve();

export function prepareSuggestions(rebuild = false) {
  preparing = preparing
    .then(async () => {
      const requested = readStored<Requested | false>('suggestions');
      if (requested && !rebuild) return;
      const state = await connected();
      if (requested && requested.gmail === state.gmail && requested.telegram === state.telegram)
        return;
      writeStored('suggestions', state);
      await post('/api/onboarding/suggestions').catch(() => writeStored('suggestions', false));
    })
    .catch(() => {});
  return preparing;
}
