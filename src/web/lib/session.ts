import type { AccountUpdate, SessionResponse } from '../../shared/account';
import { api, ApiError, apiResponse, errorMessage, setRequestAccount } from './api';
import { pageDataCache } from './page-data-cache';
import { applyAccountTheme } from './theme';

interface SessionSnapshot {
  session: SessionResponse | null;
  loading: boolean;
  mutating: boolean;
  locked: boolean;
  error: string;
  epoch: number;
}

type SessionRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

function validSession(value: unknown): value is SessionResponse {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<SessionResponse>;
  if (
    typeof session.capabilities?.developer !== 'boolean' ||
    typeof session.capabilities.traces !== 'boolean'
  )
    return false;
  if (session.user === null) return session.settings === null && !session.capabilities.developer;
  const user = session.user;
  return (
    !!user &&
    typeof user.id === 'string' &&
    !!user.id &&
    typeof user.name === 'string' &&
    (user.email === null || typeof user.email === 'string') &&
    (user.avatarUrl === null || typeof user.avatarUrl === 'string') &&
    !!session.settings &&
    ['system', 'light', 'dark'].includes(session.settings.theme) &&
    typeof session.settings.onboardingCompleted === 'boolean' &&
    typeof session.settings.usageData === 'boolean' &&
    typeof session.settings.traces === 'boolean'
  );
}

function createSessionStore(
  request: SessionRequest,
  clearPrivate: () => void,
  applyTheme: (session: SessionResponse | null) => void = () => {},
) {
  let snapshot: SessionSnapshot = {
    session: null,
    loading: true,
    mutating: false,
    locked: false,
    error: '',
    epoch: 0,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  let read: AbortController | undefined;
  let mutation: AbortController | undefined;
  const usageRevoked = new Set<string>();
  const usageLocallyRevoked = new Set<string>();
  const usageVersions = new Map<string, number>();
  function publish(change: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  function accept(session: SessionResponse) {
    if (session.user && session.settings && usageRevoked.has(session.user.id))
      session = {
        ...session,
        settings: { ...session.settings, usageData: false },
        ...(session.analytics && {
          analytics: { ...session.analytics, enabled: false, distinctId: null },
        }),
      };
    const changed = snapshot.session?.user?.id !== session.user?.id;
    if (changed) {
      mutation?.abort();
      mutation = undefined;
      clearPrivate();
    }
    applyTheme(session);
    publish({
      session,
      loading: false,
      locked: false,
      error: '',
      mutating: Boolean(mutation),
      epoch: snapshot.epoch + Number(changed),
    });
  }
  function invalidate(error = '', locked = false) {
    version++;
    read?.abort();
    mutation?.abort();
    read = undefined;
    mutation = undefined;
    clearPrivate();
    const session = snapshot.session
      ? {
          ...snapshot.session,
          user: null,
          settings: null,
          capabilities: { developer: false, traces: false, updatesEmail: false },
        }
      : null;
    applyTheme(null);
    publish({
      session,
      loading: false,
      mutating: false,
      locked,
      error,
      epoch: snapshot.epoch + 1,
    });
  }
  function revokeUsageData(owner = snapshot.session?.user?.id, local = true) {
    if (!owner) return;
    usageRevoked.add(owner);
    if (local) usageLocallyRevoked.add(owner);
    usageVersions.set(owner, (usageVersions.get(owner) ?? 0) + 1);
    if (snapshot.session?.user?.id !== owner) return;
    version++;
    read?.abort();
    read = undefined;
    accept(snapshot.session);
  }
  async function refresh({
    conceal = false,
    grantUsageData,
  }: { conceal?: boolean; grantUsageData?: string } = {}) {
    if (conceal) invalidate();
    read?.abort();
    const controller = new AbortController();
    read = controller;
    const current = ++version;
    const usageVersion = grantUsageData ? usageVersions.get(grantUsageData) : undefined;
    if (!snapshot.session || conceal) publish({ loading: true, error: '' });
    try {
      const session = await request<SessionResponse>('/api/session', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted || current !== version) return false;
      if (!validSession(session) || (snapshot.locked && !session.user)) {
        invalidate('Your account could not be opened. Try again.', snapshot.locked);
        return false;
      }
      if (
        grantUsageData &&
        session.user?.id === grantUsageData &&
        session.settings?.usageData &&
        !usageLocallyRevoked.has(grantUsageData) &&
        usageVersions.get(grantUsageData) === usageVersion
      )
        usageRevoked.delete(grantUsageData);
      accept(session);
      return true;
    } catch (cause) {
      if (controller.signal.aborted || current !== version) return false;
      if (cause instanceof ApiError && cause.status === 401) invalidate('', true);
      else publish({ loading: false, error: errorMessage(cause) });
      return false;
    } finally {
      if (read === controller) read = undefined;
    }
  }
  async function update(change: AccountUpdate) {
    const user = snapshot.session?.user;
    if (!user) throw new Error('Sign in again to save your changes.');
    if (mutation) throw new Error('Wait for your changes to finish saving.');
    if (change.usageData === false) revokeUsageData(user.id);
    const controller = new AbortController();
    mutation = controller;
    const epoch = snapshot.epoch;
    const usageVersion = usageVersions.get(user.id);
    publish({ mutating: true });
    try {
      const session = await request<SessionResponse>('/api/account', {
        method: 'PATCH',
        body: JSON.stringify(change),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted || epoch !== snapshot.epoch) return;
      if (!validSession(session) || session.user?.id !== user.id) {
        invalidate();
        throw new Error('Sign in again to save your changes.');
      }
      read?.abort();
      version++;
      if (
        change.usageData === true &&
        session.settings?.usageData &&
        usageVersions.get(user.id) === usageVersion
      ) {
        usageRevoked.delete(user.id);
        usageLocallyRevoked.delete(user.id);
      }
      accept(session);
    } catch (cause) {
      if (change.usageData === false) void refresh();
      throw cause;
    } finally {
      if (mutation === controller) {
        mutation = undefined;
        publish({ mutating: false });
      }
    }
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    revokeUsageData,
    update,
    invalidate,
  };
}

export const sessionStore = createSessionStore(
  api,
  () => {
    setRequestAccount(null);
    pageDataCache.clear();
  },
  (session) => {
    setRequestAccount(session?.user?.id ?? null);
    applyAccountTheme(session?.settings?.theme);
  },
);

export async function claimAccess() {
  const key = new URLSearchParams(window.location.hash.slice(1)).get('access');
  if (!key) return false;
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  const response = await apiResponse('/api/access', {
    method: 'POST',
    redirect: 'error',
    body: JSON.stringify({ key }),
  }).catch(() => undefined);
  if (!response?.ok) return false;
  return true;
}
