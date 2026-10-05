import type { Configuration } from '../../shared/contracts';
import { desktopSettingsAvailable, openDesktopSettings } from '../lib/desktop';
import { Button, Notice } from './ui';

export function SetupNotice({ configuration }: { configuration: Configuration }) {
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
            onClick={() => openDesktopSettings('models')}
          >
            Open Models
          </Button>
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
