import { useEffect, useRef, type ComponentProps } from 'react';
import { ExternalLink } from './icons';
import { NodGlyph } from './motion';
import { ServiceLogo } from './service-logo';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui';

export type AppSignIn = {
  service: string;
  name: string;
  logoUrl?: string;
  accountLabel?: string;
  url?: string;
  opened: boolean;
  reopened?: boolean;
  pairingConfirmed?: boolean;
  broker?: boolean;
  outcome?: 'connected' | 'cancelled' | 'failed' | 'unavailable';
};

export function AppConnectionDialog({
  signIn,
  opening,
  error,
  onClose,
  onOpened,
  onRetry,
  onCloseAutoFocus,
  fallbackOnly = false,
}: {
  signIn?: AppSignIn;
  opening: boolean;
  error?: string;
  onClose(): void;
  onOpened(): void;
  onRetry?(): void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  fallbackOnly?: boolean;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  const outcome = signIn?.outcome ?? (error ? 'failed' : undefined);
  const connected = outcome === 'connected';
  const recovery = Boolean(outcome && !connected);
  const canOpen = !outcome && signIn?.url && !signIn.opened && !signIn.pairingConfirmed && !opening;
  useEffect(() => {
    if (connected) onClose();
  }, [connected, onClose]);
  const heading =
    outcome === 'unavailable'
      ? 'Use a new sign-in link'
      : outcome === 'cancelled'
        ? 'Sign-in cancelled'
        : outcome === 'failed'
          ? 'Sign-in didn’t finish'
          : `Connect ${signIn?.name}`;
  const description =
    error ||
    (outcome === 'unavailable'
      ? onRetry
        ? 'This sign-in is no longer active. Try again to open a new window.'
        : 'This link is no longer available. Ask Nod for a new sign-in link.'
      : outcome === 'cancelled'
        ? 'You can try again when you’re ready to connect this account.'
        : outcome === 'failed'
          ? onRetry
            ? 'Sign-in couldn’t be confirmed. Try again with a new window.'
            : 'Ask Nod for a new sign-in link to try again.'
          : signIn?.reopened && !onRetry
            ? 'Sign-in is already open in your browser. If you closed it, ask Nod for a new sign-in link.'
            : signIn?.broker
              ? `${signIn.name} will ask you to allow Composio, the service Nod uses to connect apps. Review what it can access, then allow it.`
              : opening || !signIn?.url
                ? 'Your browser will open when sign-in is ready.'
                : 'Review what Nod can access in your browser.');
  return (
    <Dialog
      open={Boolean(
        signIn && !connected && (!fallbackOnly || (signIn.url && !signIn.opened && !opening)),
      )}
      onOpenChange={(open) => !open && onClose()}
    >
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
            <div className="app-connect-heading" role={recovery ? 'alert' : undefined}>
              <div className="app-connect-flow" aria-hidden="true">
                <span className="app-connect-logo">
                  <NodGlyph size={40} mode={!outcome && opening ? 'bounce' : 'still'} />
                </span>
                <span className="app-connect-route" data-pending={!outcome || undefined}>
                  <span />
                  <span />
                  <span />
                </span>
                <span className="app-connect-logo">
                  <ServiceLogo slug={signIn.service} logoUrl={signIn.logoUrl} size={36} />
                </span>
              </div>
              <DialogTitle ref={title} tabIndex={-1}>
                {heading}
              </DialogTitle>
              {(signIn.accountLabel || recovery) && (
                <p className="app-connect-account" data-analytics-private>
                  {recovery ? `${signIn.name}${signIn.accountLabel ? ' · ' : ''}` : ''}
                  {signIn.accountLabel}
                </p>
              )}
              <DialogDescription>{description}</DialogDescription>
            </div>
            {!outcome && (
              <p className="app-connect-waiting" role="status">
                {opening || !signIn.url
                  ? 'Preparing sign-in…'
                  : signIn.opened || signIn.pairingConfirmed
                    ? 'Waiting for sign-in'
                    : 'Ready to open sign-in'}
              </p>
            )}
            <div className="app-connect-actions">
              <Button variant="ghost" onClick={onClose}>
                {recovery ? 'Not now' : 'Close'}
              </Button>
              {recovery && onRetry ? (
                <Button onClick={onRetry}>Try again</Button>
              ) : canOpen ? (
                <Button asChild>
                  <a href={signIn.url} target="_blank" rel="noreferrer" onClick={onOpened}>
                    Open sign-in window <ExternalLink size={16} aria-hidden="true" />
                  </a>
                </Button>
              ) : !outcome && onRetry && !opening ? (
                <Button variant="outline" onClick={onRetry}>
                  Start again
                </Button>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
