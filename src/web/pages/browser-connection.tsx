import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Globe2, LockKeyhole } from 'lucide-react';
import { BrowserControl } from '../components/browser-control';
import { BrandMark } from '../components/brand';
import { Button, Checkbox, Field, Input, Loading, Notice } from '../components/ui';
import { api, errorMessage } from '../lib/api';

type Inspection = {
  origin: string;
  canSubmit: boolean;
  fields: Array<{ kind: 'identifier' | 'password' | 'otp'; label: string }>;
  methods: Array<{ label: string; kind: string; supported: boolean }>;
  issue: string | null;
};
type Attempt = {
  name: string;
  label: string;
  origin: string;
  state: 'pending' | 'saved';
  fromTask: boolean;
  expiresAt: string;
  inspection: Inspection | null;
};

export function BrowserConnection({ token }: { token: string }) {
  const base = `/api/browser-connections/attempt/${encodeURIComponent(token)}`;
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [saveLogin, setSaveLogin] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saveWarning, setSaveWarning] = useState(false);
  const [complete, setComplete] = useState(false);
  const [privateActive, setPrivateActive] = useState(false);
  const [browserPhase, setBrowserPhase] = useState<'opening' | 'open' | 'checking' | 'closed'>(
    'closed',
  );
  const [activity, setActivity] = useState<'credentials' | 'finish' | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const returnTo = attempt?.fromTask ? '/' : '/apps';
  const controlChanged = useCallback(
    (active: boolean, _privateView: boolean, phase: typeof browserPhase) => {
      setPrivateActive(active);
      setBrowserPhase(phase);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const value = await api<Attempt>(base, { cache: 'no-store' });
    setAttempt(value);
    return value;
  }, [base]);

  useEffect(() => {
    let active = true;
    void api<Attempt>(base, { cache: 'no-store' })
      .then((value) => {
        if (active) setAttempt(value);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    const clear = () => {
      setPassword('');
      setCode('');
    };
    window.addEventListener('blur', clear);
    return () => {
      active = false;
      window.removeEventListener('blur', clear);
    };
  }, [base]);

  useEffect(() => {
    if (!complete) return;
    const timer = window.setTimeout(() => window.location.assign(returnTo), 1100);
    return () => window.clearTimeout(timer);
  }, [complete, returnTo]);

  useEffect(() => {
    if (!submitted || complete || privateActive) return;
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(errorMessage(cause)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [submitted, complete, privateActive, refresh]);

  const working =
    !attempt || activity !== null || browserPhase === 'opening' || browserPhase === 'checking';
  useEffect(() => {
    if (!working) {
      setWorkingSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setWorkingSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [working, activity, browserPhase]);

  const inspection = attempt?.inspection;
  const ownOrigin = inspection?.canSubmit === true;
  const hasUsername = Boolean(
    ownOrigin && inspection?.fields.some((field) => field.kind === 'identifier'),
  );
  const hasPassword = Boolean(
    ownOrigin && inspection?.fields.some((field) => field.kind === 'password'),
  );
  const hasCode = Boolean(ownOrigin && inspection?.fields.some((field) => field.kind === 'otp'));
  const canUseForm =
    (hasUsername || hasPassword || hasCode) && !(hasCode && (hasUsername || hasPassword));
  const formOrigin = inspection?.origin ?? attempt?.origin;
  const progress = !attempt
    ? error
      ? {
          step: 1,
          title: 'Could not open sign-in',
          detail: 'Return to Apps or chat and start a new connection.',
        }
      : { step: 1, title: 'Opening the website', detail: 'Otto is checking the sign-in page.' }
    : activity === 'finish' || browserPhase === 'checking'
      ? {
          step: 3,
          title: 'Checking your sign-in',
          detail:
            'Otto is checking the account page before it saves this browser session. The site may ask for another step.',
        }
      : activity === 'credentials'
        ? {
            step: 2,
            title: hasCode ? 'Checking your code' : 'Checking your details',
            detail:
              'Otto is waiting for the website. It may ask for a verification code or another sign-in step.',
          }
        : browserPhase === 'opening'
          ? {
              step: 1,
              title: 'Opening the private browser',
              detail: 'Otto is preparing the website view. Keep this page open.',
            }
          : browserPhase === 'open'
            ? {
                step: 2,
                title: 'Complete sign-in in the browser',
                detail:
                  'Use the browser below for any code or account check. Select Finish sign-in when you reach your account.',
              }
            : hasCode
              ? {
                  step: 2,
                  title: 'Enter your verification code',
                  detail:
                    'The website requested a code. Enter it below, then Otto will check the next page.',
                }
              : submitted
                ? {
                    step: 2,
                    title: canUseForm
                      ? 'The site still needs sign-in details'
                      : 'Check the next website step',
                    detail: canUseForm
                      ? 'Check the fields below or open the private browser to see what the site needs.'
                      : 'Open the private browser if the site asks for another step. You can try to finish once you reach your account.',
                  }
                : {
                    step: 2,
                    title: canUseForm ? 'Enter your sign-in details' : 'Sign in on the website',
                    detail: canUseForm
                      ? 'Use the private fields below. Otto will check what the website needs next.'
                      : 'Open the private browser to use the website sign-in page.',
                  };

  async function sendCredentials(event: FormEvent) {
    event.preventDefault();
    if (busy || !formOrigin) return;
    setBusy(true);
    setActivity('credentials');
    setError('');
    try {
      const result = await api<{
        status: 'submitted' | 'rejected';
        inspection: Inspection | null;
      }>(`${base}/credentials`, {
        method: 'POST',
        body: JSON.stringify({
          origin: formOrigin,
          ...(username ? { username } : {}),
          ...(password ? { password } : {}),
          ...(code ? { code } : {}),
          ...(saveLogin && hasPassword ? { saveLogin: true } : {}),
        }),
        cache: 'no-store',
      });
      setPassword('');
      setCode('');
      if (result.status === 'rejected') {
        setError('The website rejected these details. Check them and try again.');
        return;
      }
      setSubmitted(true);
      setAttempt((current) => (current ? { ...current, inspection: result.inspection } : current));
      window.setTimeout(() => void refresh().catch(() => {}), 1200);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPassword('');
      setCode('');
      setBusy(false);
      setActivity(null);
    }
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    setActivity('finish');
    setError('');
    try {
      const result = await api<{ loginSaved?: boolean }>(`${base}/finish`, {
        method: 'POST',
        body: '{}',
        cache: 'no-store',
      });
      setSaveWarning(result.loginSaved === false);
      setComplete(true);
    } catch (cause) {
      setError(errorMessage(cause));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  return (
    <main className="browser-connection-page">
      <header className="browser-connection-top">
        <a className="browser-connection-brand" href={returnTo}>
          <BrandMark small />
          Otto
        </a>
        <a className="browser-connection-back" href={returnTo}>
          <ArrowLeft size={16} />
          {attempt?.fromTask ? 'Back to chat' : 'Back to Apps'}
        </a>
      </header>
      <div className="browser-connection-layout">
        <section className="browser-connection-intro">
          <div className="browser-connection-icon">
            <Globe2 size={28} />
          </div>
          <h1>
            {complete || attempt?.state === 'saved'
              ? 'Website connected'
              : `Connect ${attempt?.name ?? 'website'}`}
          </h1>
          <p>
            Sign in on the website. Otto will keep this browser session for later tasks. You can
            remove it in Apps.
          </p>
          <div className="browser-connection-address">
            <LockKeyhole size={16} aria-hidden="true" />
            <span>{attempt?.origin ?? 'Checking website…'}</span>
          </div>
          <p className="browser-connection-note">
            Your password stays out of chat and Otto’s model. A saved session does not let Otto send
            or change things without your task instruction.
          </p>
        </section>
        <section className="browser-connection-stage" aria-label="Website sign-in">
          {!complete && attempt?.state !== 'saved' && (
            <div className="browser-connection-progress">
              <ol className="browser-connection-steps" aria-label="Connection steps">
                {['Open website', 'Sign in', 'Save session'].map((label, index) => (
                  <li
                    key={label}
                    className={
                      index + 1 < progress.step
                        ? 'done'
                        : index + 1 === progress.step
                          ? 'current'
                          : ''
                    }
                    aria-current={index + 1 === progress.step ? 'step' : undefined}
                  >
                    <span className="browser-connection-step-mark" aria-hidden="true">
                      {index + 1 < progress.step ? <Check size={12} /> : index + 1}
                    </span>
                    <span>{label}</span>
                  </li>
                ))}
              </ol>
              <div className="browser-connection-progress-message" role="status" aria-live="polite">
                <span
                  className={
                    working
                      ? 'browser-connection-progress-dot working'
                      : 'browser-connection-progress-dot'
                  }
                  aria-hidden="true"
                />
                <div>
                  <strong>{progress.title}</strong>
                  <p>{progress.detail}</p>
                </div>
              </div>
              {workingSeconds >= 10 && (
                <p className="browser-connection-working-time">Still working · {workingSeconds}s</p>
              )}
            </div>
          )}
          {!attempt && !error && <Loading label="Checking the website…" />}
          {error && <Notice>{error}</Notice>}
          {complete || attempt?.state === 'saved' ? (
            <div className="browser-connection-success">
              <span className="browser-connection-success-mark">
                <Check size={28} />
              </span>
              <h2>Session saved</h2>
              <p>Otto will check the website again when it uses this connection.</p>
              {saveWarning && (
                <Notice kind="info">
                  The browser session is saved, but Vault could not save the login.
                </Notice>
              )}
              <a href={returnTo}>Return to {attempt?.fromTask ? 'chat' : 'Apps'}</a>
            </div>
          ) : attempt ? (
            <>
              <div className="browser-connection-stage-heading">
                <div>
                  <h2>Sign in securely</h2>
                  <p>
                    {canUseForm
                      ? `Sign in at ${inspection?.origin}. Use the fields below or open the website browser.`
                      : 'Open the website browser to finish sign-in.'}
                  </p>
                </div>
              </div>
              {canUseForm && (
                <form
                  className="browser-connection-form"
                  onSubmit={(event) => void sendCredentials(event)}
                >
                  {(hasUsername || hasPassword) && (
                    <Field
                      label={
                        inspection?.fields.find((field) => field.kind === 'identifier')?.label ??
                        'Account email or username'
                      }
                    >
                      <Input
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                        autoFocus
                        required={hasUsername}
                        disabled={busy}
                      />
                    </Field>
                  )}
                  {hasPassword && (
                    <Field label="Password">
                      <Input
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        type="password"
                        autoComplete="current-password"
                        required
                        disabled={busy}
                      />
                    </Field>
                  )}
                  {hasCode && (
                    <Field label="Verification code">
                      <Input
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{4,8}"
                        required
                        disabled={busy}
                      />
                    </Field>
                  )}
                  {hasPassword && (
                    <label className="browser-connection-save">
                      <Checkbox
                        checked={saveLogin}
                        onChange={(event) => setSaveLogin(event.target.checked)}
                        disabled={busy}
                      />
                      Save this login in Vault for a later sign-in
                    </label>
                  )}
                  <Button type="submit" disabled={busy}>
                    {busy ? 'Checking…' : hasCode ? 'Send code' : 'Sign in'}
                  </Button>
                </form>
              )}
              {inspection?.methods.some(
                (method) => method.kind !== 'credentials' && method.supported,
              ) && (
                <p className="browser-connection-methods">
                  Other sign-in options are available on the website. Open the private browser to
                  use them.
                </p>
              )}
              <div className="browser-connection-browser">
                <BrowserControl
                  screen={null}
                  emptyMessage="The private browser opens here."
                  live={false}
                  onEnlarge={() => {}}
                  onControlChange={controlChanged}
                  controlPath={`${base}/control`}
                  startLabel="Open private browser"
                  finishLabel="Finish sign-in"
                  onCompleted={(result) => {
                    setSaveWarning(result.loginSaved === false);
                    setComplete(true);
                    void refresh().catch(() => {});
                  }}
                />
              </div>
              <Button
                variant="outline"
                onClick={() => void finish()}
                disabled={busy || privateActive}
              >
                {privateActive ? 'Finish in the private browser' : 'I finished signing in'}
              </Button>
            </>
          ) : null}
        </section>
      </div>
    </main>
  );
}
