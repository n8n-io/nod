import type { Connection } from '../../shared/contracts';
import { integrationMetadata } from '../../shared/integrations';
import type { Presentation } from '../../shared/presentation';
import { useAppSignIn } from '../hooks/use-app-sign-in';
import { usePageData } from '../hooks/use-page-data';
import { navigate } from '../lib/navigation';
import { ConnectRow, SignInActions, signInIssue } from './connect-row';
import { ServiceLogo } from './service-logo';
import { Button } from './ui';

export function ConnectApps({ visual }: { visual: Extract<Presentation, { type: 'apps' }> }) {
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
  const shown = visual.services.filter((slug) => entry(slug));
  if (!shown.length) return null;
  return (
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
                <SignInActions
                  signIn={signIn}
                  onRestart={() => void signIn.connect({ service: slug })}
                />
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Connect ${name(slug)}`}
                  disabled={Boolean(signIn.pending)}
                  onClick={() => void signIn.connect({ service: slug })}
                >
                  {mine && signIn.error ? 'Try again' : 'Connect'}
                </Button>
              )
            }
          />
        );
      })}
    </div>
  );
}
