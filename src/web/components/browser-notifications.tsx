import { useEffect, useMemo, useRef, useState } from 'react';
import {
  browserNotificationStatus,
  dismissBrowserNotifications,
  setBrowserNotifications,
  subscribeBrowserNotifications,
} from '../lib/browser-notifications';
import { errorMessage } from '../lib/api';
import { desktopSettingsAvailable } from '../lib/desktop';
import { sessionStore } from '../lib/session';
import { Bell } from './icons';
import { Button, Notice, Switch } from './ui';

function useNotificationChoice(ownerId: string) {
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scope = useMemo(
    () => ({
      active: true,
      pending: false,
      epoch: sessionStore.getSnapshot().epoch,
      confirmations: new Set<Notification>(),
    }),
    [ownerId],
  );
  const current = useRef(scope);
  current.current = scope;
  const isCurrent = () =>
    scope.active &&
    current.current === scope &&
    sessionStore.getSnapshot().epoch === scope.epoch &&
    sessionStore.getSnapshot().session?.user?.id === ownerId;
  useEffect(() => {
    scope.active = true;
    setBusy(false);
    setError('');
    const unsubscribe = subscribeBrowserNotifications(() => {
      if (!browserNotificationStatus(ownerId).enabled) {
        for (const notification of scope.confirmations) notification.close();
        scope.confirmations.clear();
      }
      refresh((value) => value + 1);
    });
    return () => {
      scope.active = false;
      for (const notification of scope.confirmations) notification.close();
      unsubscribe();
    };
  }, [scope]);
  async function change(enabled: boolean) {
    if (scope.pending || !isCurrent()) return;
    scope.pending = true;
    setBusy(true);
    setError('');
    try {
      const notification = await setBrowserNotifications(ownerId, enabled, isCurrent);
      if (notification) {
        if (!isCurrent()) notification.close();
        else {
          scope.confirmations.add(notification);
          notification.onclose = () => scope.confirmations.delete(notification);
        }
      }
      if (!enabled) {
        for (const notification of scope.confirmations) notification.close();
        scope.confirmations.clear();
      }
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause));
    } finally {
      scope.pending = false;
      if (isCurrent()) setBusy(false);
    }
  }
  function dismiss() {
    if (!isCurrent()) return;
    try {
      dismissBrowserNotifications(ownerId);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return { ...browserNotificationStatus(ownerId), busy, error, change, dismiss };
}

export function BrowserNotificationPrompt({ ownerId }: { ownerId: string }) {
  const choice = useNotificationChoice(ownerId);
  if (
    !choice.available ||
    (!choice.error && (choice.choice !== null || choice.permission === 'denied'))
  )
    return null;
  return (
    <aside className="notification-choice" aria-label="Notifications">
      <div className="notification-choice-copy">
        <strong>Get notified by Nod</strong>
        <p>Let Nod tell you when a reply is ready while you’re away. Keep this tab open.</p>
      </div>
      <div className="notification-choice-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={choice.busy || choice.permission === 'denied'}
          onClick={() => void choice.change(true)}
        >
          {choice.busy ? 'Enabling…' : 'Enable notifications'}
        </Button>
        <Button size="sm" variant="ghost" disabled={choice.busy} onClick={choice.dismiss}>
          Not now
        </Button>
      </div>
      {choice.error && <Notice>{choice.error}</Notice>}
    </aside>
  );
}

export function BrowserNotificationSettings({ ownerId }: { ownerId: string }) {
  const choice = useNotificationChoice(ownerId);
  const optedIn = choice.choice === 'enabled';
  if (desktopSettingsAvailable()) return null;
  return (
    <section className="account-region" aria-label="Browser notifications">
      <div className="account-preference-row">
        <span data-analytics-public>
          <Bell size={16} aria-hidden="true" />
          Browser notifications
        </span>
        <Switch
          checked={optedIn}
          disabled={
            choice.busy || (!optedIn && (!choice.available || choice.permission === 'denied'))
          }
          aria-label="Browser notifications"
          onCheckedChange={(enabled) => void choice.change(enabled)}
        />
      </div>
      <p className="field-hint">
        {!choice.available
          ? 'Notifications need a supported browser and a secure connection.'
          : choice.permission === 'denied'
            ? 'Allow notifications for this site in your browser settings to enable them.'
            : 'Get notified by Nod while you’re away. Keep this tab open to receive replies.'}
      </p>
      {choice.error && <Notice>{choice.error}</Notice>}
    </section>
  );
}
