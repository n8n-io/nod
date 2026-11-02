import type { Connection } from '../../shared/contracts';
import { integrationMetadata } from '../../shared/integrations';
import { reconnectable } from '../../shared/onboarding';
import type { Presentation } from '../../shared/presentation';
import { useAppSignIn } from '../hooks/use-app-sign-in';
import { usePageData } from '../hooks/use-page-data';
import { navigate } from '../lib/navigation';
import { ConnectRow, SignInActions, signInIssue } from './connect-row';
import { ServiceLogo } from './service-logo';
import { Button, Notice } from './ui';
import type { Ref } from 'react';

export function ConnectApps({
  visual,
  analyticsRef,
}: {
  visual: Extract<Presentation, { type: 'apps' }>;
  analyticsRef?: Ref<HTMLElement>;
}) {
  const apps = usePageData<Connection[]>('/api/apps');
  const catalog = usePageData<Connection[]>('/api/apps/catalog');
  const entry = (slug: string) =>
    apps.data?.find((item) => item.slug === slug) ??
    catalog.data?.find((item) => item.slug === slug);
  const name = (slug: string) => integrationMetadata(slug, entry(slug)).name;
  const linked = (slug: string) =>
    Boolean(apps.data?.some((item) => item.slug === slug && item.status === 'connected'));
  const signIn = useAppSignIn({
    entry: 'chat',
    name,
    onSettled: () => void apps.refresh(),
    onSetup: (url) => navigate(url),
  });
  const reconnect = (slug: string) =>
    apps.data?.find((item) => item.slug === slug && reconnectable(item))?.connectionId;
  const start = (slug: string) =>
    void signIn.connect({ service: slug, connectionId: reconnect(slug) });
  const shown = visual.services.filter((slug) => entry(slug));
  const error = apps.error || (catalog.status === 403 ? '' : catalog.error);
  const unavailable = catalog.status === 403 && shown.length < visual.services.length;
  if (!shown.length && !error && !unavailable) return null;
  return (
    <section
      ref={analyticsRef}
      className="message-presentation presentation-apps"
      aria-label={visual.title}
      data-analytics-private
    >
      <div className="connect-rows">
        {shown.map((slug) => {
          const connection = entry(slug);
          const mine = signIn.service === slug;
          return (
            <ConnectRow
              key={slug}
              logo={<ServiceLogo slug={slug} logoUrl={connection?.logoUrl} size={28} />}
              name={name(slug)}
              details={[integrationMetadata(slug, connection).description]}
              error={mine ? signInIssue(signIn) || signIn.error : ''}
              actions={
                linked(slug) ? (
                  <span className="connect-row-done">Connected</span>
                ) : mine && signIn.pending ? (
                  <SignInActions signIn={signIn} onRestart={() => start(slug)} />
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`${mine && signIn.error ? 'Try again' : 'Connect'} ${name(slug)}`}
                    disabled={Boolean(signIn.pending)}
                    onClick={() => start(slug)}
                  >
                    {mine && signIn.error ? 'Try again' : 'Connect'}
                  </Button>
                )
              }
            />
          );
        })}
      </div>
      {error && (
        <Notice>
          {error}{' '}
          <Button
            variant="ghost"
            disabled={apps.refreshing || catalog.refreshing}
            onClick={() => {
              void apps.refresh();
              void catalog.refresh();
            }}
          >
            Try again
          </Button>
        </Notice>
      )}
      {unavailable && (
        <Notice kind="info">
          Open Apps to see the available connections.{' '}
          <Button variant="ghost" onClick={() => navigate('/apps')}>
            Open Apps
          </Button>
        </Notice>
      )}
    </section>
  );
}
