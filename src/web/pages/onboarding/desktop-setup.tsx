import { useEffect, useRef, useState } from 'react';
import type { AccountUpdate, SessionResponse } from '../../../shared/account';
import {
  onboardingSteps,
  onboardingVersion,
  type DesktopSetupState,
  type DesktopSetupUpdate,
} from '../../../shared/onboarding';
import { SetupProgress } from '../../components/setup-progress';
import { Button } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { Onboarding } from '.';
import { DesktopPreferencesSetup } from './steps/desktop-preferences';

function valid(value: DesktopSetupState) {
  return (
    value?.version === onboardingVersion &&
    onboardingSteps.includes(value.step) &&
    ['preparing', 'ready', 'error'].includes(value.runtime?.phase) &&
    typeof value.runtime.message === 'string' &&
    typeof value.completed === 'boolean' &&
    (value.completing === undefined || typeof value.completing === 'boolean')
  );
}

export function DesktopSetup({
  session,
  onAccountUpdate,
}: {
  session: SessionResponse;
  onAccountUpdate(change: AccountUpdate): Promise<void>;
}) {
  const [state, setState] = useState<DesktopSetupState | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const active = useRef(false);
  const revision = useRef(0);
  const writing = useRef(false);
  const request = useRef<AbortController | null>(null);
  const completion = useRef<{ resolve(): void; reject(cause: Error): void } | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const finishing = submitted || state?.completing || state?.completed;

  function completed(value: DesktopSetupState) {
    if (!completion.current) return;
    if (value.completed) completion.current.resolve();
    else if (value.runtime.phase === 'error')
      completion.current.reject(new Error(value.runtime.message));
    else return;
    completion.current = null;
  }

  useEffect(() => {
    active.current = true;
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const accepted = revision.current;
      const current = new AbortController();
      request.current = current;
      try {
        const result = await api<DesktopSetupState>('/api/desktop/setup', {
          signal: AbortSignal.any([lifetime.signal, current.signal]),
          cache: 'no-store',
        });
        if (!valid(result)) throw new Error('Your setup could not be loaded. Try again.');
        if (!lifetime.signal.aborted && !writing.current && accepted === revision.current) {
          setState(result);
          setError('');
          completed(result);
        }
      } catch (cause) {
        if (!lifetime.signal.aborted && !current.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (request.current === current) request.current = null;
        if (!lifetime.signal.aborted) timer = setTimeout(() => void load(), 1500);
      }
    }
    void load();
    return () => {
      active.current = false;
      lifetime.abort();
      clearTimeout(timer);
      request.current?.abort();
      completion.current?.reject(new Error('Setup was closed.'));
      completion.current = null;
    };
  }, [session.user!.id, retry]);

  async function save(change: DesktopSetupUpdate) {
    if (writing.current) throw new Error('Wait for your setup to finish saving.');
    writing.current = true;
    revision.current++;
    try {
      const result = await api<DesktopSetupState>('/api/desktop/setup', {
        method: 'PATCH',
        body: JSON.stringify(change),
      });
      if (!valid(result)) throw new Error('Your setup could not be saved. Try again.');
      if (active.current) {
        setState(result);
        setError('');
      }
    } finally {
      writing.current = false;
      revision.current++;
    }
  }

  async function retryRuntime() {
    await api('/api/desktop/setup/retry', { method: 'POST', body: '{}' });
    setRetry((value) => value + 1);
  }

  if (!state)
    return (
      <SetupProgress title={error ? 'Setup could not load.' : 'Opening setup…'} error={error}>
        {error && (
          <Button
            variant="outline"
            onClick={() => {
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </Button>
        )}
      </SetupProgress>
    );

  if (finishing) {
    const failure =
      error || (!state.completed && state.runtime.phase === 'error' ? state.runtime.message : '');
    return (
      <SetupProgress
        title={failure ? 'Setup needs another try.' : 'Finishing setting up your environment…'}
        description={failure ? 'Your progress is saved.' : undefined}
        error={failure}
      >
        {failure && (
          <Button
            variant="outline"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              setError('');
              try {
                if (state.runtime.phase === 'error' && !state.completed) await retryRuntime();
                else setRetry((value) => value + 1);
              } catch (cause) {
                if (active.current) setError(errorMessage(cause));
              } finally {
                if (active.current) setRetrying(false);
              }
            }}
          >
            Try again
          </Button>
        )}
      </SetupProgress>
    );
  }

  if (state.step === 'open' && !preferencesReady)
    return <DesktopPreferencesSetup onReady={() => setPreferencesReady(true)} />;

  return (
    <Onboarding
      user={session.user!}
      usageData={session.settings!.usageData}
      onUsageData={(usageData) => onAccountUpdate({ usageData })}
      desktop={{
        state,
        save,
        retry: retryRuntime,
      }}
      onComplete={async () => {
        const result = await api<{ ok: boolean; pending?: boolean }>(
          '/api/desktop/setup/complete',
          {
            method: 'POST',
            body: '{}',
          },
        );
        if (result.ok) return;
        if (!result.pending) throw new Error('Otto could not finish opening. Try again.');
        setSubmitted(true);
        await new Promise<void>((resolve, reject) => {
          completion.current = { resolve, reject };
          if (latest.current) completed(latest.current);
        });
      }}
    />
  );
}
