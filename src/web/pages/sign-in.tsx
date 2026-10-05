import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/brand';
import { GoogleMark } from '../components/account-avatar';
import { Button, Notice } from '../components/ui';
import { api } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';

export function SignIn({
  available,
  error: sessionError,
  onRetry,
}: {
  available: boolean;
  error?: string;
  onRetry(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const visibleError = error || (!busy ? sessionError : '');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function login() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url: string }>('/api/login', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!controller.signal.aborted)
        window.location.assign(connectionUrl(result.url, window.location.origin));
    } catch {
      if (!controller.signal.aborted) {
        setError('Sign-in could not start. Try again.');
        setBusy(false);
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  return (
    <main className="sign-in-page">
      <div className="sign-in-main">
        <div className="sign-in-brand" data-analytics-public>
          <BrandMark />
          <span>otto</span>
        </div>
        <div className="sign-in-form">
          <span className="sign-in-mark">
            <BrandMark />
          </span>
          <h1 data-analytics-public>Sign in to Otto</h1>
          <p data-analytics-public>
            Hand off the work you keep putting off.
            <br />
            Otto gets it done while you sleep.
          </p>
          {visibleError && <Notice>{visibleError}</Notice>}
          {available ? (
            <Button
              variant="outline"
              className="google-sign-in"
              data-analytics-public
              disabled={busy}
              onClick={() => void login()}
            >
              <GoogleMark />
              {busy ? 'Opening Google…' : 'Continue with Google'}
            </Button>
          ) : (
            <div className="sign-in-unavailable">
              {!sessionError && <Notice>Sign-in is unavailable. Try again in a moment.</Notice>}
              <Button variant="outline" onClick={onRetry}>
                Try again
              </Button>
            </div>
          )}
        </div>
        <a className="sign-in-privacy" href="/privacy" data-analytics-public>
          Privacy
        </a>
      </div>
      <aside className="sign-in-story" aria-label="What Otto can help with" data-analytics-public>
        <div className="sign-in-note">
          <span className="sign-in-note-time">Today, 07:30</span>
          <h2>
            Ready when
            <br />
            you wake up.
          </h2>
          <div className="sign-in-examples">
            <div>
              <img src="/logos/googledocs.svg" alt="" />
              <span>
                <strong>Supplier comparison</strong>
                <small>Prices, trade-offs and a recommendation.</small>
              </span>
            </div>
            <div>
              <img src="/logos/gmail.svg" alt="" />
              <span>
                <strong>Follow-ups prepared</strong>
                <small>The replies you have been putting off, ready to review.</small>
              </span>
            </div>
          </div>
        </div>
      </aside>
    </main>
  );
}
