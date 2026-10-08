import type { AccountUpdate, SessionResponse } from '../../shared/account';
import { api, ApiError, apiResponse, errorMessage, setRequestAccount } from './api';
import { pageDataCache } from './page-data-cache';
import { applyAccountTheme } from './theme';

export interface SessionSnapshot {
  session: SessionResponse | null;
  loading: boolean;
  signingOut: boolean;
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
    !session.auth ||
    !['local', 'google'].includes(session.auth.mode) ||
    typeof session.auth.googleAvailable !== 'boolean' ||
    typeof session.capabilities?.developer !== 'boolean'
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
    typeof session.settings.usageData === 'boolean'
  );
}

export function createSessionStore(
  request: SessionRequest,
  clearPrivate: () => void,
  applyTheme: (session: SessionResponse | null) => void = () => {},
) {
  let snapshot: SessionSnapshot = {
    session: null,
    loading: true,
    signingOut: false,
    mutating: false,
    locked: false,
    error: '',
    epoch: 0,
  };
  const listeners = new Set<() => void>();
  let version = 0;
  let read: AbortController | undefined;
  let mutation: AbortController | undefined;
  let logoutAccount: string | undefined;
  function publish(change: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  function accept(session: SessionResponse) {
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
      ? { ...snapshot.session, user: null, settings: null, capabilities: { developer: false } }
      : null;
    applyTheme(null);
    publish({
      session,
      loading: false,
      signingOut: false,
      mutating: false,
      locked,
      error,
      epoch: snapshot.epoch + 1,
    });
  }
  async function refresh({ conceal = false } = {}) {
    if (snapshot.signingOut) return;
    if (conceal) invalidate();
    read?.abort();
    const controller = new AbortController();
    read = controller;
    const current = ++version;
    if (!snapshot.session || conceal) publish({ loading: true, error: '' });
    try {
      const session = await request<SessionResponse>('/api/session', {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (controller.signal.aborted || current !== version) return;
      if (!validSession(session)) {
        invalidate('Your account could not be opened. Try again.');
        return;
      }
      accept(session);
    } catch (cause) {
      if (controller.signal.aborted || current !== version) return;
      if (cause instanceof ApiError && cause.status === 401) invalidate('', true);
      else publish({ loading: false, error: errorMessage(cause) });
    } finally {
      if (read === controller) read = undefined;
    }
  }
  async function update(change: AccountUpdate) {
    const user = snapshot.session?.user;
    if (!user || snapshot.signingOut) throw new Error('Sign in again to save your changes.');
    if (mutation) throw new Error('Wait for your changes to finish saving.');
    const controller = new AbortController();
    mutation = controller;
    const epoch = snapshot.epoch;
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
      accept(session);
    } finally {
      if (mutation === controller) {
        mutation = undefined;
        publish({ mutating: false });
      }
    }
  }
  async function logout() {
    if (snapshot.signingOut && !snapshot.error) return;
    logoutAccount = snapshot.session?.user?.id ?? logoutAccount;
    invalidate();
    publish({ signingOut: true, error: '' });
    const current = version;
    try {
      await request('/api/logout', {
        method: 'POST',
        body: '{}',
        cache: 'no-store',
        headers: logoutAccount ? { 'X-Otto-Account': logoutAccount } : undefined,
      });
      if (current === version) {
        logoutAccount = undefined;
        publish({ signingOut: false });
      }
    } catch {
      if (current === version) publish({ error: 'Sign-out could not be completed. Try again.' });
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
    update,
    logout,
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
  const response = await apiResponse('/api/access', {
    method: 'POST',
    body: JSON.stringify({ key }),
  }).catch(() => undefined);
  if (!response?.ok) return false;
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  return true;
}
