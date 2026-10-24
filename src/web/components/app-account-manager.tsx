import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Connection } from '../../shared/contracts';
import { errorMessage } from '../lib/api';
import { connectionIdentity, connectionIssue } from '../lib/secondary-pages';
import { LoaderCircle, Plus } from './icons';
import { ServiceLogo } from './service-logo';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Notice } from './ui';

function accountLabel(account: Connection) {
  const identity = connectionIdentity(account);
  return account.slug === 'notion' && identity.secondary
    ? `${identity.primary} · ${identity.secondary}`
    : (identity.secondary ?? identity.primary);
}

export function AppAccountManager({
  group,
  suspended = false,
  busy,
  error,
  titleRef,
  onDismissError,
  onClose,
  onConnect,
  onDisconnect,
  onRestoreFocus,
  onKeyboard,
}: {
  group?: { key: string; service: Connection; accounts: Connection[] };
  suspended?: boolean;
  busy: boolean;
  error?: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  onDismissError(): void;
  onClose(): void;
  onConnect(account: Connection, addAccount: boolean): void;
  onDisconnect(account: Connection): Promise<void>;
  onRestoreFocus(): void;
  onKeyboard?(): void;
}) {
  const ownTitle = useRef<HTMLHeadingElement>(null);
  const title = titleRef ?? ownTitle;
  const accountTrigger = useRef<HTMLButtonElement | null>(null);
  const keepAccount = useRef<HTMLButtonElement>(null);
  const removing = useRef(false);
  const [selected, setSelected] = useState<Connection>();
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState('');
  const addAccount =
    group?.accounts.find(
      (account) => account.slug === group.service.slug && account.status !== 'not_configured',
    ) ??
    group?.accounts.find((account) => account.status !== 'not_configured') ??
    group?.service;

  useEffect(() => {
    setSelected(undefined);
    setDisconnectError('');
    accountTrigger.current = null;
  }, [group?.key]);

  function restoreAccountFocus() {
    const id = accountTrigger.current?.dataset.disconnectAccount;
    const previous = Array.from(
      title.current
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLButtonElement>('[data-disconnect-account]') ?? [],
    ).find((button) => button.dataset.disconnectAccount === id);
    const target = previous ?? title.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    else onRestoreFocus();
  }

  async function disconnect() {
    if (!selected || removing.current || busy) return;
    removing.current = true;
    setDisconnecting(true);
    setDisconnectError('');
    try {
      await onDisconnect(selected);
      setSelected(undefined);
    } catch (cause) {
      setDisconnectError(errorMessage(cause));
    } finally {
      removing.current = false;
      setDisconnecting(false);
    }
  }

  return (
    <>
      <Dialog
        open={Boolean(group?.accounts.length) && !suspended && !selected}
        onOpenChange={(open) => {
          if (!open && !selected) onClose();
        }}
      >
        <DialogContent
          className="app-manage-dialog"
          aria-describedby={undefined}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') onKeyboard?.();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            restoreAccountFocus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!suspended && !selected) onRestoreFocus();
          }}
        >
          <div className="dialog-heading app-manage-heading">
            {group && <ServiceLogo {...group.service} />}
            <div>
              <DialogTitle ref={title} tabIndex={-1}>
                {group?.service.name} accounts
              </DialogTitle>
            </div>
          </div>
          {error && (
            <div data-analytics-private>
              <Notice onDismiss={onDismissError}>{error}</Notice>
            </div>
          )}
          <div className="app-manage-accounts">
            {group?.accounts.map((account) => {
              const identity = connectionIdentity(account);
              const issue = connectionIssue(account);
              const label = accountLabel(account);
              return (
                <div className="compact-account" key={account.connectionId}>
                  <div className="compact-account-details" data-analytics-private>
                    <span className="compact-account-name">{identity.primary}</span>
                    {identity.secondary && (
                      <span className="compact-account-email">{identity.secondary}</span>
                    )}
                    {issue && <p className="app-account-issue">{issue}</p>}
                  </div>
                  <div className="app-account-actions">
                    {account.canReconnect &&
                      (account.status === 'disconnected' || account.reconnectRequired) && (
                        <Button
                          size="sm"
                          aria-label={`Reconnect ${label} to ${account.name}`}
                          disabled={busy}
                          onClick={() => onConnect(account, false)}
                        >
                          Reconnect
                        </Button>
                      )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="account-disconnect"
                      data-disconnect-account={account.connectionId}
                      aria-label={`Disconnect ${label} from ${account.name}`}
                      disabled={busy}
                      onClick={(event) => {
                        accountTrigger.current = event.currentTarget;
                        setDisconnectError('');
                        setSelected(account);
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="dialog-actions app-manage-actions">
            {!addAccount?.browserUrl && (
              <Button
                size="sm"
                data-add-account
                disabled={busy || addAccount?.status === 'not_configured'}
                onClick={() => addAccount && onConnect(addAccount, true)}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                Add account
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !disconnecting) setSelected(undefined);
        }}
      >
        <DialogContent
          className="app-disconnect-dialog"
          aria-busy={disconnecting}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') onKeyboard?.();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            keepAccount.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreAccountFocus();
          }}
        >
          <DialogTitle>Disconnect from {selected?.name.replace(/\s+MCP$/i, '')}?</DialogTitle>
          <DialogDescription data-analytics-private>
            {selected && accountLabel(selected)}
            <span>nod will lose access to this account. You can connect it again later.</span>
          </DialogDescription>
          {disconnectError && (
            <div data-analytics-private>
              <Notice>{disconnectError}</Notice>
            </div>
          )}
          <div className="app-disconnect-actions">
            <Button
              ref={keepAccount}
              data-keep-account
              variant="outline"
              disabled={disconnecting}
              onClick={() => setSelected(undefined)}
            >
              Keep account
            </Button>
            <Button
              variant="destructive"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
