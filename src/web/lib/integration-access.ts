import type {
  IntegrationAccessAttempt as AccessStart,
  IntegrationAccessProgress,
  IntegrationManagedAccess,
} from '../../shared/integrations';
import { api } from './api';
import { connectionUrl } from './connection-url';
import { desktopLinksAvailable, openConnection } from './desktop';

export type IntegrationAccessAttempt = {
  done: Promise<void>;
  cancel(): Promise<void>;
};

function nativeAccessUrl(value: string) {
  try {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
    const url = new URL(value);
    if (!url.port || url.href !== value) throw new Error();
    return url.href;
  } catch {
    throw new Error('The sign-in address could not be verified.');
  }
}

export function startIntegrationAccess(): IntegrationAccessAttempt {
  const native = desktopLinksAvailable();
  const popup = native
    ? null
    : window.open('/connection-loading.html', '_blank', 'popup,width=520,height=720');
  const controller = new AbortController();
  let attempt: AccessStart | undefined;
  let finished = false;
  let cancelled = false;
  let cancellation: Promise<void> | undefined;
  let receive: ((event: MessageEvent) => void) | undefined;
  const abort = () => new DOMException('Sign-in cancelled.', 'AbortError');
  const current = () => {
    if (cancelled || controller.signal.aborted) throw abort();
  };
  const cleanup = () => {
    controller.abort();
    if (receive) window.removeEventListener('message', receive);
    popup?.close();
  };
  const cancelRemote = () => {
    if (!attempt || finished) return Promise.resolve();
    cancellation ??= api('/api/integrations/access/cancel', {
      method: 'POST',
      body: JSON.stringify({ id: attempt.id }),
    }).then(() => {});
    return cancellation;
  };
  const wait = () =>
    new Promise<void>((resolve, reject) => {
      const stop = () => {
        window.clearTimeout(timer);
        reject(abort());
      };
      const timer = window.setTimeout(() => {
        controller.signal.removeEventListener('abort', stop);
        resolve();
      }, 1500);
      controller.signal.addEventListener('abort', stop, { once: true });
    });
  const done = (async () => {
    try {
      if (!native && !popup)
        throw new Error('Allow pop-up windows for nod, then try signing in again.');
      const pair = native
        ? null
        : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
            'sign',
            'verify',
          ]);
      const browserKey = pair ? await crypto.subtle.exportKey('jwk', pair.publicKey) : undefined;
      current();
      attempt = await api<AccessStart>('/api/integrations/access/start', {
        method: 'POST',
        body: JSON.stringify(native ? { native: true } : { browserKey }),
      });
      if (cancelled) {
        await cancelRemote();
        throw abort();
      }
      const url = native
        ? nativeAccessUrl(attempt.url)
        : connectionUrl(attempt.url, window.location.origin);
      const origin = new URL(url).origin;
      const id = attempt.id;
      const expiresAt = attempt.expiresAt;
      if (!id || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
        throw new Error('This sign-in expired. Start again.');
      let signing = false;
      let proved = false;
      let proofError = false;
      if (popup && pair) {
        const prefix = `otto-proxy-access-v1\n${id}\n${window.location.origin}\n`;
        receive = (event: MessageEvent) => {
          const message = event.data;
          if (
            cancelled ||
            finished ||
            controller.signal.aborted ||
            signing ||
            proved ||
            event.source !== popup ||
            event.origin !== origin ||
            !message ||
            message.type !== 'otto:proxy-access:challenge' ||
            message.id !== id ||
            typeof message.challenge !== 'string' ||
            message.challenge.length > 512 ||
            !message.challenge.startsWith(prefix) ||
            message.challenge.length <= prefix.length
          )
            return;
          signing = true;
          void crypto.subtle
            .sign(
              { name: 'ECDSA', hash: 'SHA-256' },
              pair.privateKey,
              new TextEncoder().encode(message.challenge),
            )
            .then((value) => {
              if (cancelled || finished || controller.signal.aborted || Date.now() >= expiresAt)
                return;
              if (value.byteLength !== 64) throw new Error();
              const signature = btoa(String.fromCharCode(...new Uint8Array(value)))
                .replaceAll('+', '-')
                .replaceAll('/', '_')
                .replace(/=+$/, '');
              popup.postMessage({ type: 'otto:proxy-access:proof', id, signature }, origin);
              proved = true;
            })
            .catch(() => {
              proofError = true;
            })
            .finally(() => {
              signing = false;
            });
        };
        window.addEventListener('message', receive);
        popup.location.href = url;
      } else await openConnection(url);
      while (Date.now() < expiresAt) {
        current();
        if (proofError) throw new Error('This browser could not verify the sign-in. Try again.');
        const result = await api<IntegrationAccessProgress>(
          `/api/integrations/access/status?id=${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );
        current();
        if (result.status === 'authorized') {
          const access = await api<IntegrationManagedAccess>('/api/integrations/access/complete', {
            method: 'POST',
            body: JSON.stringify({ id }),
          });
          current();
          finished =
            access?.state === 'enabled' ||
            access?.state === 'denied' ||
            access?.state === 'revoked';
          if (access?.state !== 'enabled')
            throw new Error(
              access?.state === 'denied'
                ? 'Easy Connect is not enabled for this Google account. Use your own Composio key.'
                : access?.state === 'revoked'
                  ? 'Access for this nod installation was removed. Sign in again to check your access.'
                  : 'Easy Connect access could not be verified. Try signing in again.',
            );
          return;
        }
        if (result.status === 'completed') {
          finished = true;
          return;
        }
        if (result.status === 'denied') {
          finished = true;
          throw new Error(
            'Easy Connect is not enabled for this Google account. Use your own Composio key.',
          );
        }
        if (result.status === 'cancelled') {
          finished = true;
          throw abort();
        }
        if (result.status !== 'pending')
          throw new Error('The sign-in status could not be verified.');
        if (popup?.closed && !proved) {
          await cancelRemote();
          throw abort();
        }
        await wait();
      }
      throw new Error('This sign-in expired. Start again.');
    } finally {
      cleanup();
      await cancelRemote().catch(() => {});
    }
  })();
  return {
    done,
    cancel: async () => {
      cancelled = true;
      cleanup();
      await cancelRemote();
    },
  };
}
