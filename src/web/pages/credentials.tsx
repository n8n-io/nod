import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, LockKeyhole, ArrowUpRight } from 'lucide-react';
import type { CredentialRequest, PaymentRequest } from '../../shared/contracts';
import { api } from '../lib/api';
import { originLabel, suggestLoginName } from '../lib/vault-name';
import { returnToChat } from '../lib/navigation';
import { subscribeAppEvents } from '../lib/app-events';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { BrandMark } from '../components/brand';

export function Credentials({ id }: { id: string }) {
  return <CredentialForm key={id} id={id} />;
}

export function Payment({ id }: { id: string }) {
  const [request, setRequest] = useState<PaymentRequest>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const action = useRef<AbortController | null>(null);
  const path = `/api/payment-requests/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<PaymentRequest>(path, { signal: controller.signal, cache: 'no-store' })
      .then(setRequest)
      .catch(() => {
        if (!controller.signal.aborted)
          setError('This payment request is unavailable. Ask Otto to check the checkout.');
      });
    return () => {
      controller.abort();
      action.current?.abort();
    };
  }, [path]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || action.current) return;
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    form.reset();
    const controller = new AbortController();
    action.current = controller;
    setSaving(true);
    setError('');
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({ code }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setSubmitted(true);
    } catch {
      if (!controller.signal.aborted)
        setError(
          'The result is not confirmed. Ask Otto to check the order before another attempt.',
        );
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      action.current = null;
    }
  }
  return (
    <main className="credential-page">
      <a href="/" onClick={returnToChat} className="credential-brand" aria-label="Otto home">
        <BrandMark />
        <span>otto</span>
      </a>
      <div className="credential-card" data-analytics-private aria-busy={saving}>
        <h1>{submitted ? 'Card submitted' : 'Approve payment'}</h1>
        {submitted ? (
          <p>Otto will check the result and continue your task in the same conversation.</p>
        ) : request && !error ? (
          <form onSubmit={(event) => void submit(event)}>
            <p>
              {request.amount} at {originLabel(request.origin)} with {request.card}
            </p>
            <p>Card details go to {request.destinations.map(originLabel).join(' and ')}.</p>
            <Field label="Security code">
              <Input
                name="code"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{3,4}"
                minLength={3}
                maxLength={4}
                required
                autoFocus
                disabled={saving}
              />
            </Field>
            <Button type="submit" disabled={saving}>
              {saving ? 'Submitting…' : `Pay ${request.amount}`}
            </Button>
          </form>
        ) : (
          !error && <Loading label="Opening secure payment…" />
        )}
        {error && <Notice>{error}</Notice>}
        <Button variant="outline" asChild>
          <a href="/" onClick={returnToChat}>
            Back to Otto
          </a>
        </Button>
      </div>
    </main>
  );
}

function CredentialForm({ id }: { id: string }) {
  const [activeId, setActiveId] = useState(id);
  const generation = useRef(0);
  const action = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<CredentialRequest | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retried, setRetried] = useState(false);
  const [enterNew, setEnterNew] = useState(false);
  const [loginName, setLoginName] = useState<string>();
  useEffect(() => {
    if (request?.status !== 'entering') return;
    const controller = new AbortController();
    let latest = 0;
    const refresh = () => {
      const version = ++latest;
      void api<CredentialRequest>(`/api/credential-requests/${encodeURIComponent(activeId)}`, {
        signal: controller.signal,
        cache: 'no-store',
      })
        .then((value) => {
          if (!controller.signal.aborted && version === latest) setRequest(value);
        })
        .catch(() => {});
    };
    const unsubscribe = subscribeAppEvents(undefined, {
      open: refresh,
      error() {},
      message: (event) => {
        if (JSON.parse(event.data).type === 'refresh') refresh();
      },
    });
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, [activeId, request?.status]);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    if (window.location.search || window.location.hash)
      window.history.replaceState(null, '', window.location.pathname);
    void api<CredentialRequest>(`/api/credential-requests/${encodeURIComponent(activeId)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((value) => {
        if (generation.current !== current) return;
        setRequest(value);
      })
      .catch(() => {
        if (generation.current === current)
          setError('This sign-in request is unavailable. Return to chat for a new link.');
      });
    return () => {
      generation.current++;
      controller.abort();
      action.current?.abort();
      action.current = null;
    };
  }, [activeId]);
  const uncertain = request?.status === 'uncertain';
  const expired = uncertain || request?.status === 'expired';
  const filled = request?.status === 'filled';
  const fields = request?.fields ?? [];
  const username =
    request?.kind === 'identifier' || fields.some((field) => field.kind === 'identifier');
  const password = request?.kind === 'password';
  const savedEntries = request?.kind === 'otp' ? [] : (request?.savedEntries ?? []);
  const choosingSaved = savedEntries.length > 0 && !enterNew;
  async function perform<T>(
    suffix: string,
    input: unknown,
    accepted: (result: T) => void,
    failure: string,
  ) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    const current = generation.current;
    setSaving(true);
    setError('');
    try {
      const result = await api<T>(
        `/api/credential-requests/${encodeURIComponent(activeId)}${suffix}`,
        {
          method: 'POST',
          body: JSON.stringify(input),
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (generation.current === current && !controller.signal.aborted) accepted(result);
    } catch {
      if (generation.current === current && !controller.signal.aborted) setError(failure);
    } finally {
      if (action.current === controller) action.current = null;
      if (generation.current === current) setSaving(false);
    }
  }
  function retry() {
    return perform(
      '/retry',
      {},
      () => setRetried(true),
      'A new sign-in step could not be requested. Return to chat to check this task.',
    );
  }
  function submitted(result: { ok: boolean; retryUrl?: string; error?: string }) {
    if (result.ok === true) {
      setRequest((current) => (current ? { ...current, status: 'filled' } : current));
      returnToChat();
      return;
    }
    const retry = new URL(result.retryUrl || '', window.location.origin);
    const match = /^\/vault\/([A-Za-z0-9_-]{20,100})$/.exec(retry.pathname);
    if (
      retry.origin !== window.location.origin ||
      retry.username ||
      retry.password ||
      retry.search ||
      retry.hash ||
      !match
    ) {
      setError('A new Vault form could not be opened. Return to chat for a new link.');
      return;
    }
    window.history.replaceState(null, '', retry.pathname);
    setRequest(null);
    setRetried(false);
    setEnterNew(true);
    setError(result.error ?? '');
    setActiveId(match[1]);
  }
  function useSaved(entryId: string) {
    return perform(
      '/saved',
      { entryId },
      submitted,
      'This saved login could not be used. Try again or choose another login.',
    );
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || saving) return;
    const form = event.currentTarget,
      data = new FormData(form);
    if (password) setLoginName(String(data.get('label') || ''));
    const input =
      request.kind === 'otp'
        ? { code: data.get('code') }
        : {
            ...(password
              ? {
                  label:
                    String(data.get('label') || '').trim() ||
                    suggestLoginName(
                      request.origin,
                      savedEntries.map((entry) => entry.label),
                    ),
                  password: data.get('password'),
                }
              : {}),
            ...(username ? { username: data.get('username') } : {}),
          };
    form.reset();
    return perform(
      '',
      input,
      submitted,
      'Sign-in could not continue. Try again or return to chat for a new link.',
    );
  }
  return (
    <main className="credential-page">
      <a href="/" onClick={returnToChat} className="credential-brand" aria-label="Otto home">
        <BrandMark />
        <span>otto</span>
      </a>
      <div
        className="credential-card"
        aria-busy={saving || (!request && !error)}
        data-analytics-private
      >
        {saving ? (
          <div className="credential-complete" role="status" aria-live="polite">
            <h1>{request?.kind === 'otp' ? 'Checking your code…' : 'Continuing sign-in…'}</h1>
            {request && <p>{originLabel(request.origin)}</p>}
            <Loading label="Waiting for the website…" />
          </div>
        ) : !request && !error ? (
          <div className="credential-complete" role="status">
            <h1>Secure sign-in</h1>
            <Loading label="Opening your form…" />
          </div>
        ) : filled ? (
          <div className="credential-complete" role="status">
            <div className="success-mark">
              <Check size={24} />
            </div>
            <h1>Details submitted</h1>
            <p>Otto will continue from the website’s response.</p>
            <Button asChild>
              <a href="/" onClick={returnToChat}>
                Back to chat
              </a>
            </Button>
          </div>
        ) : request?.status === 'entering' ? (
          <div className="credential-complete">
            <h1>Private entry is in progress.</h1>
            <p>Wait for this operation to finish.</p>
          </div>
        ) : expired ? (
          <div className="credential-complete">
            <LockKeyhole size={32} />
            <h1>
              {retried
                ? 'A new step is on its way.'
                : uncertain
                  ? 'The result is unknown.'
                  : 'This link has expired.'}
            </h1>
            <p>
              {retried
                ? 'Return to chat for the next step.'
                : uncertain
                  ? 'The sign-in may have reached the website. Ask Otto to check its result before another attempt.'
                  : 'Ask Otto to check the sign-in page again.'}
            </p>
            {!retried && (
              <Button disabled={saving} onClick={() => void retry()}>
                {saving ? 'Requesting…' : 'Get a new Vault link'}
              </Button>
            )}
            <Button variant="outline" asChild>
              <a href="/" onClick={returnToChat}>
                Back to chat
              </a>
            </Button>
          </div>
        ) : (
          <>
            <header className="credential-heading">
              <div className="credential-symbol">
                <LockKeyhole size={24} />
              </div>
              <div>
                <h1>{request?.kind === 'otp' ? 'Enter verification code' : 'Sign in'}</h1>
                <p className="credential-intro">
                  {request
                    ? originLabel(request.origin)
                    : 'Return to chat to request a new sign-in link.'}
                </p>
              </div>
            </header>
            {request && choosingSaved && (
              <div className="credential-accounts">
                <h2>Choose a login</h2>
                {savedEntries.map((entry) => (
                  <Button
                    key={entry.id}
                    variant="outline"
                    disabled={saving}
                    onClick={() => void useSaved(entry.id)}
                  >
                    <KeyRound size={16} />
                    <span>
                      <strong>{entry.label}</strong>
                      {entry.usernameHint && <small>{entry.usernameHint}</small>}
                    </span>
                    <ArrowUpRight size={16} />
                  </Button>
                ))}
                <Button variant="ghost" disabled={saving} onClick={() => setEnterNew(true)}>
                  Use another login
                </Button>
              </div>
            )}
            {request && !choosingSaved && (
              <form
                className="form-stack"
                autoComplete="off"
                onSubmit={(event) => void submit(event)}
              >
                {request.kind === 'otp' ? (
                  <Field
                    label={
                      fields.find((field) => field.kind === 'otp')?.label || 'Verification code'
                    }
                  >
                    <Input
                      name="code"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      maxLength={100}
                    />
                  </Field>
                ) : (
                  <>
                    {password && (
                      <Field label="Name">
                        <Input
                          name="label"
                          defaultValue={
                            loginName ??
                            suggestLoginName(
                              request.origin,
                              savedEntries.map((entry) => entry.label),
                            )
                          }
                          onInput={(event) => setLoginName(event.currentTarget.value)}
                          placeholder="For example, my work account"
                          maxLength={100}
                        />
                      </Field>
                    )}
                    {username && (
                      <Field
                        label={
                          fields.find((field) => field.kind === 'identifier')?.label ||
                          'Username or email'
                        }
                      >
                        <Input
                          name="username"
                          autoComplete="username"
                          autoFocus
                          required
                          maxLength={320}
                        />
                      </Field>
                    )}
                    {password && (
                      <Field label="Password">
                        <Input
                          name="password"
                          type="password"
                          autoComplete="current-password"
                          autoFocus={!username}
                          required
                          maxLength={8192}
                        />
                      </Field>
                    )}
                  </>
                )}
                {request.kind === 'identifier' && (
                  <p>Your username or email will be saved in Vault for this website.</p>
                )}
                <Button className="credential-submit" type="submit" disabled={saving}>
                  {saving
                    ? 'Continuing…'
                    : request.kind === 'otp'
                      ? 'Continue'
                      : 'Save and continue'}
                </Button>
                {savedEntries.length > 0 && (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={saving}
                    onClick={() => setEnterNew(false)}
                  >
                    Choose a saved login
                  </Button>
                )}
              </form>
            )}
          </>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </main>
  );
}
