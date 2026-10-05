import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AccountPreparationResponse, AccountUser } from '../../shared/account';
import type { Configuration, Connection } from '../../shared/contracts';
import { ModelPicker, ModelSettings } from '../components/models';
import type { ModelsResponse } from '../../shared/models';
import { SetupNotice } from '../components/setup-notice';
import {
  integrationServiceIds,
  integrationServices,
  type IntegrationService,
} from '../../shared/integrations';
import { AccountAvatar } from '../components/account-avatar';
import { BrandMark } from '../components/brand';
import { Button, Notice } from '../components/ui';
import { useBrowserTimeZone } from '../hooks/use-browser-time-zone';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { connectionUrl } from '../lib/connection-url';
import { desktopLinksAvailable, openConnection } from '../lib/desktop';

type Pending = 'opening' | 'waiting';

function connectionMessage(result: string | null) {
  if (result === 'cancelled') return 'Connection cancelled. You can try again.';
  if (result === 'failed' || result === 'expired') return 'The app could not connect. Try again.';
  return '';
}

export function Onboarding({
  user,
  onComplete,
  onLogout,
  canLogout,
}: {
  user: AccountUser;
  onComplete(): Promise<void>;
  onLogout(): void;
  canLogout: boolean;
}) {
  useBrowserTimeZone();
  const { data, error: loadError, loading, refresh } = usePageData<Connection[]>('/api/apps');
  const { data: configuration } = usePageData<Configuration>('/api/configuration');
  const { data: models } = usePageData<ModelsResponse>('/api/models');
  const [step, setStep] = useState<'models' | 'apps'>('models');
  const modelReady = models?.connections.some(
    (connection) =>
      connection.id === models.selection?.connectionId &&
      connection.status === 'connected' &&
      connection.models.some(
        (model) =>
          model.id === models.selection?.modelId && model.efforts.includes(models.selection.effort),
      ),
  );
  const [pending, setPending] = useState<Partial<Record<IntegrationService, Pending>>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [preparation, setPreparation] = useState<'pending' | 'ready' | 'failed'>('pending');
  const preparationRequest = useRef<AbortController | null>(null);
  const actions = useRef(new Map<IntegrationService, AbortController>());
  const attempts = useRef(new Map<IntegrationService, string>());
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const result = new URLSearchParams(window.location.search).get('connection');
    setError(connectionMessage(result));
    if (result) window.history.replaceState(null, '', window.location.pathname);
    const settle = (service?: string | null) =>
      setPending((current) => {
        const next = { ...current };
        for (const slug of integrationServiceIds)
          if (next[slug] === 'waiting' && (!service || slug === service)) delete next[slug];
        return next;
      });
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('otto.apps');
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{
          connection?: string;
          service?: string | null;
          attempt?: string;
        } | null>,
      ) => {
        const { connection, service, attempt } = event.data ?? {};
        if (
          !service ||
          !integrationServiceIds.includes(service as IntegrationService) ||
          !attempt ||
          attempts.current.get(service as IntegrationService) !== attempt ||
          !['connected', 'cancelled', 'failed', 'expired'].includes(connection ?? '')
        )
          return;
        attempts.current.delete(service as IntegrationService);
        setError(connectionMessage(connection ?? null));
        settle(service);
        void refresh();
      };
    const focus = () => settle();
    window.addEventListener('focus', focus);
    void prepare();
    return () => {
      active.current = false;
      channel?.close();
      window.removeEventListener('focus', focus);
      for (const request of actions.current.values()) request.abort();
      actions.current.clear();
      attempts.current.clear();
      preparationRequest.current?.abort();
    };
  }, [user.id]);
  async function prepare() {
    preparationRequest.current?.abort();
    const request = new AbortController();
    preparationRequest.current = request;
    setPreparation('pending');
    try {
      const response = await api<AccountPreparationResponse>('/api/account/prepare', {
        method: 'POST',
        body: '{}',
        signal: request.signal,
      });
      if (response.ok !== true) throw new Error('Setup could not be completed.');
      if (!request.signal.aborted) setPreparation('ready');
    } catch {
      if (!request.signal.aborted) setPreparation('failed');
    } finally {
      if (preparationRequest.current === request) preparationRequest.current = null;
    }
  }
  function track(slug: IntegrationService, state?: Pending) {
    setPending((current) => {
      const next = { ...current };
      if (state) next[slug] = state;
      else delete next[slug];
      return next;
    });
  }
  async function connect(slug: IntegrationService) {
    if (actions.current.has(slug) || saving) return;
    const desktop = desktopLinksAvailable();
    const popup = desktop
      ? null
      : window.open('', `otto-connect-${slug}`, 'popup,width=520,height=720');
    try {
      if (popup) popup.opener = null;
    } catch {}
    const request = new AbortController();
    actions.current.set(slug, request);
    attempts.current.delete(slug);
    track(slug, 'opening');
    setError('');
    let next: Pending | undefined;
    try {
      const response = await api<{ url: string; attempt?: string }>(`/api/apps/${slug}/connect`, {
        method: 'POST',
        body: JSON.stringify({ returnTo: popup || desktop ? 'window' : 'onboarding' }),
        signal: request.signal,
      });
      if (request.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
      const url = connectionUrl(response.url, window.location.origin);
      if (desktop || popup) {
        if (!response.attempt || !/^[A-Za-z0-9_-]{43}$/.test(response.attempt))
          throw new Error('The app could not connect. Try again.');
        attempts.current.set(slug, response.attempt);
      }
      if (desktop) {
        await openConnection(url);
        next = 'waiting';
      } else if (!popup) {
        next = 'opening';
        window.location.assign(url);
      } else if (!popup.closed) {
        next = 'waiting';
        popup.location.href = url;
      }
    } catch (cause) {
      popup?.close();
      if (!request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (next !== 'opening' && actions.current.get(slug) === request) {
        actions.current.delete(slug);
        if (active.current) track(slug, next);
      }
    }
  }
  async function complete() {
    if (saving || preparation !== 'ready') return;
    setSaving(true);
    setError('');
    try {
      await onComplete();
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      if (active.current) setSaving(false);
    }
  }
  return (
    <main className="account-onboarding">
      <header>
        <div className="sign-in-brand">
          <BrandMark />
          <span>otto</span>
        </div>
        {canLogout && (
          <Button variant="ghost" onClick={onLogout}>
            Sign out
          </Button>
        )}
      </header>
      <div className="account-onboarding-content">
        {canLogout && <AccountAvatar user={user} large />}
        <h1>
          Welcome{canLogout && user.name.trim() ? `, ${user.name.trim().split(/\s+/)[0]}` : ''}.
        </h1>
        <p>{step === 'models' ? 'Connect your models.' : 'Connect your apps.'}</p>
        {step === 'models' ? (
          <>
            <ModelSettings />
            <div className="account-onboarding-actions">
              <Button disabled={!modelReady} onClick={() => setStep('apps')}>
                Continue
              </Button>
              <Button variant="ghost" onClick={() => setStep('apps')}>
                Skip for now
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="onboarding-model">
              <Button variant="ghost" size="sm" onClick={() => setStep('models')}>
                Back to models
              </Button>
              {modelReady && <ModelPicker />}
            </div>
            {configuration && <SetupNotice configuration={configuration} />}
            {(error || loadError) && <Notice>{error || loadError}</Notice>}
            {loadError && (
              <Button variant="outline" onClick={() => void refresh()}>
                Try again
              </Button>
            )}
            <div className="onboarding-integrations" aria-busy={loading}>
              {integrationServiceIds.map((slug) => {
                const service = integrationServices[slug];
                const rows = data?.filter((connection) => connection.slug === slug) ?? [];
                const connected = rows.some((connection) => connection.status === 'connected');
                const unavailable =
                  !rows.length ||
                  rows.every((connection) => connection.status === 'not_configured');
                const label =
                  rows.some((connection) => connection.connectionId) && !connected
                    ? 'Reconnect'
                    : 'Connect';
                const state = pending[slug];
                return (
                  <article
                    key={slug}
                    className={`onboarding-integration${connected ? ' connected' : ''}${state ? ` ${state}` : ''}`}
                    aria-labelledby={`onboarding-${slug}`}
                  >
                    <span className="onboarding-logo">
                      <img src={`/logos/${slug}.svg`} alt="" width={24} height={24} />
                    </span>
                    <div className="onboarding-integration-copy">
                      <h2 id={`onboarding-${slug}`}>{service.name}</h2>
                      <p>
                        {state === 'waiting' ? 'Continue in the new window.' : service.description}
                      </p>
                    </div>
                    {connected ? (
                      <span className="onboarding-connected">
                        <Check size={16} aria-hidden="true" />
                        Connected
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="onboarding-connect"
                        aria-label={`${label} ${service.name}`}
                        disabled={!data || unavailable || state === 'opening' || saving}
                        onClick={() => void connect(slug)}
                      >
                        {state === 'opening' ? (
                          <>
                            <LoaderCircle className="spin" size={14} aria-hidden="true" />
                            Opening…
                          </>
                        ) : (
                          label
                        )}
                      </Button>
                    )}
                  </article>
                );
              })}
            </div>
            {preparation === 'failed' && (
              <Notice>
                Setup could not be completed.{' '}
                <Button variant="ghost" onClick={() => void prepare()}>
                  Try again
                </Button>
              </Notice>
            )}
            <div className="account-onboarding-actions">
              <Button disabled={saving || preparation !== 'ready'} onClick={() => void complete()}>
                {preparation === 'pending'
                  ? 'Preparing…'
                  : saving
                    ? 'Opening Otto…'
                    : 'Continue to Otto'}
              </Button>
              <Button
                variant="ghost"
                disabled={saving || preparation !== 'ready'}
                onClick={() => void complete()}
              >
                I’ll do this later
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
