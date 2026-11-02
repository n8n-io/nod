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
import { Button, Notice, Switch } from './ui';
import { analyticsForCurrentSession } from '../lib/analytics';

function useNotificationChoice(ownerId: string) {
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scope = useMemo(
    () => ({
      active: true,
      pending: false,
      epoch: sessionStore.getSnapshot().epoch,
      consent: browserNotificationStatus(ownerId),
      consentGeneration: 0,
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
    const unsubscribe = subscribeBrowserNotifications(ownerId, (revoked) => {
      const consent = browserNotificationStatus(ownerId);
      if (revoked || !consent.enabled) {
        if (revoked || scope.consent.enabled || scope.consent.choice !== consent.choice)
          scope.consentGeneration++;
        for (const notification of scope.confirmations) notification.close();
        scope.confirmations.clear();
      }
      scope.consent = consent;
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
    const previous = browserNotificationStatus(ownerId).choice;
    const capture = analyticsForCurrentSession();
    scope.pending = true;
    setBusy(true);
    setError('');
    const consentGeneration = scope.consentGeneration;
    const isAllowed = () => isCurrent() && scope.consentGeneration === consentGeneration;
    try {
      const notification = await setBrowserNotifications(ownerId, enabled, isAllowed);
      const saved = browserNotificationStatus(ownerId).choice;
      if (isCurrent() && saved !== previous && saved === (enabled ? 'enabled' : 'disabled'))
        capture('local_setting_changed', { setting: 'browser_notifications', value: saved });
      if (notification) {
        if (!isAllowed()) notification.close();
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
    const previous = browserNotificationStatus(ownerId).choice;
    const capture = analyticsForCurrentSession();
    try {
      dismissBrowserNotifications(ownerId);
      if (previous !== 'dismissed' && browserNotificationStatus(ownerId).choice === 'dismissed')
        capture('local_setting_changed', {
          setting: 'browser_notifications',
          value: 'dismissed',
        });
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
  if (desktopSettingsAvailable()) return null;
  return (
    <section className="account-region" aria-label="Notifications">
      <div className="account-preference-row">
        <span>Notifications</span>
        <Switch
          checked={choice.enabled}
          disabled={choice.busy || !choice.available || choice.permission === 'denied'}
          aria-label="Notifications"
          onCheckedChange={(enabled) => void choice.change(enabled)}
        />
      </div>
      <p className="field-hint">
        {!choice.available
          ? 'Notifications need a supported browser and a secure connection.'
          : choice.permission === 'denied'
            ? 'Blocked by your browser. Allow notifications for this site in your browser settings.'
            : choice.permission === 'default'
              ? 'Allow notifications for new replies.'
              : choice.enabled
                ? 'New replies appear while you’re away. Keep this tab open.'
                : 'Get notified about new replies. Keep this tab open.'}
      </p>
      {choice.enabled && (
        <div className="account-settings-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={choice.busy}
            onClick={() => void choice.change(true)}
          >
            Send test notification
          </Button>
        </div>
      )}
      {choice.error && <Notice>{choice.error}</Notice>}
    </section>
  );
}
