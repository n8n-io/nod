import { useRef, type ComponentProps } from 'react';
import { ExternalLink } from 'lucide-react';
import { NodGlyph } from './motion';
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
};

export function AppConnectionDialog({
  signIn,
  opening,
  error,
  onClose,
  onOpened,
  onCloseAutoFocus,
}: {
  signIn?: AppSignIn;
  opening: boolean;
  error?: string;
  onClose(): void;
  onOpened(): void;
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
                  <NodGlyph size={40} mode={!error && opening ? 'thinking' : 'still'} />
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
                {error
                  ? 'Sign-in could not continue.'
                  : !signIn.url
                    ? 'Your browser will open when sign-in is ready.'
                    : 'Sign in in your browser and review what nod can access.'}
              </DialogDescription>
            </div>
            {error ? (
              <Notice kind="error">{error}</Notice>
            ) : (
              <>
                <p className="app-connect-waiting" role="status">
                  {signIn.pairingConfirmed
                    ? 'Waiting for you to finish signing in.'
                    : signIn.reopened
                      ? 'Sign-in is already open in your browser. If you closed it, ask nod for a new sign-in link.'
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
