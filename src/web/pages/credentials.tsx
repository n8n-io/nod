import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  ArrowUpRight,
} from '../components/icons';
import type {
  CredentialRequest,
  PasswordManagerLogin,
  PaymentRequest,
} from '../../shared/contracts';
import { api, ApiError } from '../lib/api';
import { originLabel } from '../lib/vault-name';
import { returnToChat } from '../lib/navigation';
import { subscribeAppEvents } from '../lib/app-events';
import { Button, Field, Input, Loading, Notice } from '../components/ui';
import { BrandMark } from '../components/brand';

type ManagerState =
  | { stage: 'account'; account?: string }
  | { stage: 'waiting'; account: string }
  | { stage: 'list'; account: string; logins: PasswordManagerLogin[] };

type PrivateFormProps = {
  id: string;
  embedded?: boolean;
  onClose?(): void;
  onRequestChange?(id: string): void;
};

function PrivateFormFrame({
  embedded,
  children,
}: {
  embedded?: boolean;
  children: React.ReactNode;
}) {
  const Element = embedded ? 'div' : 'main';
  return (
    <Element className={embedded ? 'credential-embedded' : 'credential-page'}>
      {!embedded && (
        <a href="/" onClick={returnToChat} className="credential-brand" aria-label="nod home">
          <BrandMark />
          <span>nod</span>
        </a>
      )}
      {children}
    </Element>
  );
}

function BackToChat({ onClose }: { onClose?(): void }) {
  return (
    <Button variant="outline" asChild>
      <a
        href="/"
        onClick={(event) => {
          if (onClose) {
            event.preventDefault();
            onClose();
          } else returnToChat(event);
        }}
      >
        Back to chat
      </a>
    </Button>
  );
}

export function Credentials(props: PrivateFormProps) {
  return <CredentialForm key={props.id} {...props} />;
}

export function Payment(props: PrivateFormProps) {
  return <PaymentForm key={props.id} {...props} />;
}

type PaymentStatus = 'pending' | 'entering' | 'submitted' | 'uncertain' | 'expired';

function PaymentForm({ id, embedded, onClose }: PrivateFormProps) {
  const card = useRef<HTMLDivElement>(null);
  const [request, setRequest] = useState<PaymentRequest>();
  const [status, setStatus] = useState<PaymentStatus>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const action = useRef<AbortController | null>(null);
  const updates = useRef(0);
  const path = `/api/payment-requests/${encodeURIComponent(id)}`;
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (action.current) return;
      const version = ++updates.current;
      try {
        const result = await api<{ status: PaymentStatus }>(`${path}/status`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted || version !== updates.current) return;
        setStatus(result.status);
        if (result.status !== 'pending') setError('');
        if (result.status === 'pending') {
          const value = await api<PaymentRequest>(path, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!controller.signal.aborted && version === updates.current) setRequest(value);
        }
      } catch {
        if (!controller.signal.aborted && version === updates.current)
          setError('This payment request is unavailable. Ask nod to check the checkout.');
      }
    };
    void refresh();
    const unsubscribe = subscribeAppEvents(undefined, {
      open: () => void refresh(),
      error() {},
      message: (event) => {
        if (JSON.parse(event.data).type === 'refresh') void refresh();
      },
    });
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      action.current?.abort();
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [path]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || action.current || status !== 'pending') return;
    updates.current++;
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    form.reset();
    const controller = new AbortController();
    action.current = controller;
    if (embedded && card.current?.contains(document.activeElement)) card.current.focus();
    setSaving(true);
    setError('');
    try {
      const result = await api<{ ok: boolean }>(path, {
        method: 'POST',
        body: JSON.stringify({ code }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (result.ok !== true) throw new Error('Unconfirmed payment submission');
      if (!controller.signal.aborted) setStatus('submitted');
    } catch {
      if (!controller.signal.aborted) {
        setStatus('uncertain');
        setError('The result is not confirmed. Ask nod to check the order before another attempt.');
        try {
          const result = await api<{ status: PaymentStatus }>(`${path}/status`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (!controller.signal.aborted) {
            setStatus(result.status);
            if (result.status === 'submitted' || result.status === 'entering') setError('');
          }
        } catch {}
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (action.current === controller) action.current = null;
    }
  }
  return (
    <PrivateFormFrame embedded={embedded}>
      <div
        className="credential-card credential-payment"
        ref={card}
        tabIndex={embedded ? -1 : undefined}
        data-analytics-private
        aria-busy={saving}
      >
        <h1>
          {status === 'submitted'
            ? 'Card submitted'
            : status === 'uncertain'
              ? 'The result is unknown.'
              : status === 'expired'
                ? 'This payment request has expired.'
                : 'Approve payment'}
        </h1>
        {saving || status === 'entering' ? (
          <Loading label="Submitting your card…" />
        ) : status === 'submitted' ? (
          <p>nod will check the result and continue your task in the same conversation.</p>
        ) : status === 'uncertain' ? (
          <p>
            The card may have reached the website. Ask nod to check the order before another
            attempt.
          </p>
        ) : status === 'expired' ? (
          <p>Return to chat to check the checkout and request a new approval.</p>
        ) : request && status === 'pending' ? (
          <form className="form-stack" autoComplete="off" onSubmit={(event) => void submit(event)}>
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
              Pay {request.amount}
            </Button>
          </form>
        ) : (
          !error && <Loading label="Opening secure payment…" />
        )}
        {error && <Notice>{error}</Notice>}
        <BackToChat onClose={onClose} />
      </div>
    </PrivateFormFrame>
  );
}

function CredentialForm({ id, embedded, onClose, onRequestChange }: PrivateFormProps) {
  const card = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState(id);
  const generation = useRef(0);
  const updates = useRef(0);
  const action = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<CredentialRequest | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retried, setRetried] = useState(false);
  const [enterNew, setEnterNew] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [manager, setManager] = useState<ManagerState | null>(null);
  useEffect(() => {
    if (!request || (request.status === 'uncertain' && !retried)) return;
    const controller = new AbortController();
    const refresh = async () => {
      if (action.current) return;
      const version = ++updates.current;
      const path = `/api/credential-requests/${encodeURIComponent(activeId)}`;
      try {
        const value = await api<CredentialRequest>(path, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted || version !== updates.current) return;
        setRequest(value);
        if (value.status === 'filled' || value.status === 'expired' || retried) {
          const flow = await api<{ nextId?: string }>(`${path}/flow`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          if (
            !controller.signal.aborted &&
            version === updates.current &&
            flow.nextId &&
            /^[A-Za-z0-9_-]{43}$/.test(flow.nextId) &&
            flow.nextId !== activeId
          ) {
            if (!embedded) window.history.replaceState(null, '', `/vault/${flow.nextId}`);
            onRequestChange?.(flow.nextId);
            setRequest(null);
            setError('');
            setEnterNew(false);
            setRevealed(false);
            setRetried(false);
            setManager(null);
            setActiveId(flow.nextId);
          }
        }
      } catch {}
    };
    void refresh();
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
  }, [activeId, request?.status, retried, embedded]);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    if (!embedded && (window.location.search || window.location.hash))
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
  }, [activeId, embedded]);
  const uncertain = request?.status === 'uncertain';
  const expired = uncertain || request?.status === 'expired';
  const filled = request?.status === 'filled';
  const fields = request?.fields ?? [];
  const username = request?.kind === 'identifier' || request?.kind === 'password';
  const password = request?.kind === 'password';
  const savedEntries = request?.kind === 'otp' ? [] : (request?.savedEntries ?? []);
  const choosingSaved = savedEntries.length > 0 && !enterNew && !manager;
  const managerName = request?.passwordManager?.name;
  async function perform<T>(
    suffix: string,
    input: unknown,
    accepted: (result: T) => void,
    failure: string,
    explained = false,
  ) {
    if (action.current) return;
    updates.current++;
    const controller = new AbortController();
    action.current = controller;
    const current = generation.current;
    if (embedded && card.current?.contains(document.activeElement)) card.current.focus();
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
    } catch (cause) {
      if (generation.current === current && !controller.signal.aborted) {
        setError(explained && cause instanceof ApiError ? cause.message : failure);
        try {
          const value = await api<CredentialRequest>(
            `/api/credential-requests/${encodeURIComponent(activeId)}`,
            { signal: controller.signal, cache: 'no-store' },
          );
          if (generation.current === current && !controller.signal.aborted) setRequest(value);
        } catch {}
      }
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
    if (!embedded) window.history.replaceState(null, '', retry.pathname);
    onRequestChange?.(match[1]);
    setRequest(null);
    setRetried(false);
    setManager(null);
    setEnterNew(true);
    setError(result.error ?? '');
    setActiveId(match[1]);
  }
  function useMethod(methodId: string) {
    return perform(
      '/method',
      { methodId },
      submitted,
      'This method could not continue. Ask nod to check the sign-in page.',
    );
  }
  function useSaved(entryId: string) {
    return perform(
      '/saved',
      { entryId },
      submitted,
      'This saved login could not be used. Try again or choose another login.',
    );
  }
  async function listManaged(account: string) {
    let listed = false;
    setManager({ stage: 'waiting', account });
    await perform<{ logins: PasswordManagerLogin[] }>(
      '/password-manager',
      { account },
      (result) => {
        listed = true;
        setManager({ stage: 'list', account, logins: result.logins });
      },
      `nod couldn’t open ${managerName}. Try again.`,
      true,
    );
    if (!listed)
      setManager((current) =>
        current?.stage === 'waiting' ? { stage: 'account', account } : current,
      );
  }
  function useManaged(account: string, id: string) {
    return perform(
      '/password-manager/use',
      { account, id },
      submitted,
      'This login could not be used. Try again or choose another login.',
      true,
    );
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || saving) return;
    const form = event.currentTarget,
      data = new FormData(form);
    const input =
      request.kind === 'otp'
        ? { code: data.get('code') }
        : {
            ...(password ? { password: data.get('password') } : {}),
            ...(username ? { username: data.get('username') } : {}),
          };
    form.reset();
    setRevealed(false);
    return perform(
      '',
      input,
      submitted,
      'Sign-in could not continue. Try again or return to chat for a new link.',
    );
  }
  return (
    <PrivateFormFrame embedded={embedded}>
      <div
        className="credential-card"
        ref={card}
        tabIndex={embedded ? -1 : undefined}
        aria-busy={saving || (!request && !error)}
        data-analytics-private
      >
        {saving && manager?.stage === 'waiting' ? (
          <div className="credential-complete" role="status" aria-live="polite">
            <h1>Approve in {managerName}</h1>
            <p>{managerName} asks before nod can read your logins.</p>
            <Loading label={`Waiting for ${managerName}…`} />
          </div>
        ) : saving ? (
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
            <h1>{request?.kind === 'method' ? 'Continuing sign-in' : 'Details submitted'}</h1>
            <p>nod will continue from the website’s response.</p>
            <BackToChat onClose={onClose} />
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
                  ? 'The sign-in may have reached the website. Ask nod to check its result before another attempt.'
                  : 'Ask nod to check the sign-in page again.'}
            </p>
            {!retried && (
              <Button disabled={saving} onClick={() => void retry()}>
                {saving ? 'Requesting…' : 'Get a new Vault link'}
              </Button>
            )}
            <BackToChat onClose={onClose} />
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
            {request?.kind === 'method' && (
              <div className="credential-accounts">
                <h2>Choose how to sign in</h2>
                {request.methods?.map((method) => (
                  <Button
                    key={method.id}
                    variant="outline"
                    disabled={saving}
                    onClick={() => void useMethod(method.id)}
                  >
                    <span>{method.label}</span>
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </Button>
                ))}
              </div>
            )}
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
                      {entry.username && <small>{entry.username}</small>}
                    </span>
                    <ArrowUpRight size={16} />
                  </Button>
                ))}
                <Button variant="ghost" disabled={saving} onClick={() => setEnterNew(true)}>
                  Use another login
                </Button>
              </div>
            )}
            {request && manager && (
              <Button
                variant="ghost"
                size="sm"
                className="credential-method-back"
                disabled={saving}
                onClick={() => setManager(null)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Back
              </Button>
            )}
            {request && manager?.stage === 'account' && (
              <form
                className="form-stack"
                autoComplete="off"
                onSubmit={(event) => {
                  event.preventDefault();
                  const account = String(new FormData(event.currentTarget).get('account') ?? '');
                  if (account.trim()) void listManaged(account.trim());
                }}
              >
                <Field
                  label={`${managerName} account`}
                  hint={`The name at the top of the ${managerName} sidebar.`}
                >
                  <Input
                    name="account"
                    defaultValue={manager.account ?? request.passwordManager?.account}
                    autoComplete="off"
                    autoFocus
                    required
                    maxLength={200}
                  />
                </Field>
                <Button className="credential-submit" type="submit" disabled={saving}>
                  Continue
                </Button>
              </form>
            )}
            {request && manager?.stage === 'list' && (
              <div className="credential-accounts">
                <h2>Choose a login from {managerName}</h2>
                {manager.logins.length ? (
                  manager.logins.map((login) => (
                    <Button
                      key={login.id}
                      variant="outline"
                      disabled={saving}
                      onClick={() => void useManaged(manager.account, login.id)}
                    >
                      <KeyRound size={16} />
                      <span>
                        <strong>{login.title}</strong>
                        {login.username && <small>{login.username}</small>}
                      </span>
                      <ArrowUpRight size={16} />
                    </Button>
                  ))
                ) : (
                  <p>
                    No {managerName} logins for {originLabel(request.origin)}.
                  </p>
                )}
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setManager({ stage: 'account' })}
                >
                  Use another account
                </Button>
              </div>
            )}
            {request && !manager && !choosingSaved && savedEntries.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="credential-method-back"
                disabled={saving}
                onClick={() => {
                  setEnterNew(false);
                  setRevealed(false);
                }}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                Choose a saved login
              </Button>
            )}
            {request && request.kind !== 'method' && !choosingSaved && !manager && (
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
                          defaultValue={request.username}
                          autoFocus={!request.username}
                          required
                          maxLength={320}
                        />
                      </Field>
                    )}
                    {password && (
                      <Field
                        label={
                          fields.find((field) => field.kind === 'password')?.label || 'Password'
                        }
                      >
                        <span className="credential-secret">
                          <Input
                            name="password"
                            type={revealed ? 'text' : 'password'}
                            autoComplete="current-password"
                            autoFocus={Boolean(request.username)}
                            required
                            maxLength={8192}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={revealed ? 'Hide password' : 'Show password'}
                            aria-pressed={revealed}
                            onClick={() => setRevealed((value) => !value)}
                          >
                            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                          </Button>
                        </span>
                      </Field>
                    )}
                  </>
                )}
                <Button className="credential-submit" type="submit" disabled={saving}>
                  {saving
                    ? 'Continuing…'
                    : request.kind === 'otp'
                      ? 'Continue'
                      : 'Save and continue'}
                </Button>
              </form>
            )}
            {request?.passwordManager && !manager && (
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setError('');
                  const account = request.passwordManager?.account;
                  if (account) void listManaged(account);
                  else setManager({ stage: 'account' });
                }}
              >
                <KeyRound size={16} aria-hidden="true" />
                Use {request.passwordManager.name}
              </Button>
            )}
          </>
        )}
        {error && <Notice>{error}</Notice>}
      </div>
    </PrivateFormFrame>
  );
}
