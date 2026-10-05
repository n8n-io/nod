import { useState } from 'react';
import type { Configuration } from '../../shared/contracts';
import { desktopSettingsAvailable, openDesktopSettings } from '../lib/desktop';
import { Button, Notice } from './ui';

export function SetupNotice({ configuration }: { configuration: Configuration }) {
  const [error, setError] = useState('');
  if (configuration.integrationsReady) return null;
  const provider = 'Composio';
  const key = `${provider.toUpperCase()}_API_KEY`;
  return (
    <Notice kind="info">
      {desktopSettingsAvailable() ? (
        <>
          {provider} key is missing.{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setError('');
              void openDesktopSettings('providers').catch(() =>
                setError('Settings could not be opened. Try again.'),
              );
            }}
          >
            Open Providers
          </Button>
          {error && <span role="alert">{error}</span>}
        </>
      ) : configuration.localOnly ? (
        <>
          <code>{key}</code> is missing. Add it to <code>.env</code> and restart Otto to connect
          Google apps and Slack.
        </>
      ) : (
        <>Google apps and Slack aren’t configured. Contact your Otto administrator.</>
      )}
    </Notice>
  );
}
