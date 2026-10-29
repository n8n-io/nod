import type { HTMLAttributes, ReactNode } from 'react';
import type { useAppSignIn } from '../hooks/use-app-sign-in';
import { desktopLinksAvailable } from '../lib/desktop';
import { cn } from '../lib/utils';
import { Button } from './ui';

type SignIn = ReturnType<typeof useAppSignIn>;

export function ConnectRow({
  logo,
  name,
  details,
  error,
  actions,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  logo: ReactNode;
  name: ReactNode;
  details?: ReactNode[];
  error?: string;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn('connect-row', className)} {...props}>
      {logo}
      <div className="connect-row-identity">
        <span className="connect-row-name">{name}</span>
        {details?.map((detail, index) => (
          <span key={index} className="connect-row-detail">
            {detail}
          </span>
        ))}
        {error && (
          <p role="alert" className="connect-row-error" data-analytics-private>
            {error}
          </p>
        )}
      </div>
      {actions}
      {children}
    </div>
  );
}

export function signInIssue(signIn: SignIn) {
  return signIn.pending && signIn.pollFailing ? 'Can’t check sign-in right now.' : '';
}

export function SignInActions({ signIn, onRestart }: { signIn: SignIn; onRestart(): void }) {
  const recovery = signIn.stale || signIn.pollFailing;
  return (
    <div className="connect-row-actions" data-recovery={recovery ? true : undefined}>
      <span className="sr-only" role="status">
        {signIn.pending === 'opening' ? 'Opening sign-in…' : 'Waiting for sign-in…'}
      </span>
      <Button variant="ghost" size="sm" onClick={signIn.cancel}>
        Cancel
      </Button>
      {recovery ? (
        <Button variant="secondary" size="sm" onClick={onRestart}>
          Start again
        </Button>
      ) : signIn.pending === 'waiting' &&
        signIn.signInUrl &&
        !signIn.pairingConfirmed &&
        !signIn.signInOpened ? (
        <Button variant="secondary" size="sm" asChild>
          <a
            href={signIn.signInUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              if (desktopLinksAvailable()) {
                signIn.setSignInOpened(true);
                return;
              }
              event.preventDefault();
              signIn.openSignIn();
            }}
          >
            Open sign-in
          </a>
        </Button>
      ) : (
        <Button variant="secondary" size="sm" disabled>
          Connecting…
        </Button>
      )}
    </div>
  );
}
