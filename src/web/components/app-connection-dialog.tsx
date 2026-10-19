import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ExternalLink } from 'lucide-react';
import type { IntegrationKeyStatus } from '../../shared/integrations';
import { errorMessage } from '../lib/api';
import { startIntegrationAccess, type IntegrationAccessAttempt } from '../lib/integration-access';
import { pageDataCache } from '../lib/page-data-cache';
import { GoogleMark } from './google-mark';
import { OttoGlyph } from './motion';
import { ServiceLogo } from './service-logo';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Notice } from './ui';

export type AppSignIn = {
  service: string;
  name: string;
  logoUrl?: string;
  url?: string;
  opened: boolean;
  reopened?: boolean;
  pairingConfirmed?: boolean;
  signInRequired?: boolean;
};

export function AppAccessRecovery({
  onRenewed,
  onCancel,
}: {
  onRenewed(): void;
  onCancel?(): void;
}) {
  const attempt = useRef<IntegrationAccessAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => () => {
      const current = attempt.current;
      attempt.current = null;
      void current?.cancel().catch(() => {});
    },
    [],
  );
  async function reload(current = attempt.current) {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      await pageDataCache.refresh('/api/integrations/key', true);
      if (attempt.current !== current) return;
      const status = pageDataCache.getSnapshot<IntegrationKeyStatus>('/api/integrations/key');
      if (
        status.error ||
        status.loading ||
        status.refreshing ||
        status.data?.managed?.state !== 'enabled'
      )
        throw new Error(status.error || 'The connection status is not ready. Try reloading it.');
      attempt.current = null;
      setBusy(false);
      onRenewed();
    } catch (cause) {
      if (attempt.current !== current) return;
      setBusy(false);
      setError(errorMessage(cause));
    }
  }
  function signIn() {
    if (attempt.current) return;
    const current = startIntegrationAccess();
    attempt.current = current;
    setBusy(true);
    setError('');
    void current.done
      .then(() => {
        if (attempt.current !== current) return;
        setAuthenticated(true);
        return reload(current);
      })
      .catch((cause) => {
        if (attempt.current !== current) return;
        attempt.current = null;
        setBusy(false);
        if (!(cause instanceof DOMException && cause.name === 'AbortError'))
          setError(errorMessage(cause));
      });
  }
  function cancel() {
    const current = attempt.current;
    attempt.current = null;
    setBusy(false);
    setAuthenticated(false);
    void current?.cancel().catch(() => {});
    onCancel?.();
  }
  return (
    <div>
      <p className="app-connect-waiting" role="status">
        {authenticated
          ? busy
            ? 'Updating connection status…'
            : 'Google sign-in succeeded. Reload the connection status to continue.'
          : busy
            ? 'Finish Google sign-in in your browser.'
            : 'Continue with Google in this browser, then connect this app again.'}
      </p>
      <div className="app-connect-actions connection-row">
        <Button
          variant="outline"
          disabled={busy}
          onClick={authenticated ? () => void reload() : signIn}
        >
          {!authenticated && <GoogleMark />}
          {authenticated ? 'Reload connection status' : 'Continue with Google'}
        </Button>
        {(busy || onCancel) && (
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
      </div>
      {error && (
        <Notice>
          <span data-analytics-private>{error}</span>
        </Notice>
      )}
    </div>
  );
}

export function AppConnectionDialog({
  signIn,
  opening,
  error,
  onClose,
  onOpened,
  onAccessRenewed,
  onCloseAutoFocus,
}: {
  signIn?: AppSignIn;
  opening: boolean;
  error?: string;
  onClose(): void;
  onOpened(): void;
  onAccessRenewed(): void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open={Boolean(signIn)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="app-connect-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        {signIn && (
          <>
            <div className="app-connect-heading">
              <div className="app-connect-flow" aria-hidden="true">
                <span className="app-connect-logo">
                  <OttoGlyph size={40} mode={!error && opening ? 'thinking' : 'still'} />
                </span>
                <span
                  className="app-connect-route"
                  data-pending={(!opening && !error) || undefined}
                >
                  <span />
                  <span />
                  <span />
                </span>
                <span className="app-connect-logo">
                  <ServiceLogo slug={signIn.service} logoUrl={signIn.logoUrl} size={36} />
                </span>
              </div>
              <DialogTitle ref={title} tabIndex={-1}>
                Connect {signIn.name}
              </DialogTitle>
              <DialogDescription>
                {signIn.signInRequired
                  ? 'Renew your browser sign-in to continue.'
                  : error
                    ? 'Sign-in could not continue.'
                    : !signIn.url
                      ? 'Your browser will open when sign-in is ready.'
                      : 'Sign in in your browser and review what Otto can access.'}
              </DialogDescription>
            </div>
            {signIn.signInRequired ? (
              <AppAccessRecovery key={signIn.url} onRenewed={onAccessRenewed} />
            ) : error ? (
              <Notice kind="error">{error}</Notice>
            ) : (
              <>
                <p className="app-connect-waiting" role="status">
                  {signIn.pairingConfirmed
                    ? 'Waiting for you to finish signing in.'
                    : signIn.reopened
                      ? 'Sign-in is already open in your browser. If you closed it, ask Otto for a new sign-in link.'
                      : signIn.url
                        ? 'Finish signing in in your browser.'
                        : 'Preparing secure sign-in…'}
                </p>
                {signIn.url && !signIn.opened && !opening && !signIn.pairingConfirmed && (
                  <div className="app-connect-actions">
                    <Button variant="outline" asChild>
                      <a href={signIn.url} target="_blank" rel="noreferrer" onClick={onOpened}>
                        Open sign-in window <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
