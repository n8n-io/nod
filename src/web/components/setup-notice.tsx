import { useState } from 'react';
import type { Configuration } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { desktopSettingsAvailable, openDesktopSettings } from '../lib/desktop';
import { Button, Field, Input, Notice } from './ui';

function KeyForm() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="composio-key-form"
      onSubmit={(event) => {
        event.preventDefault();
        const value = key.trim();
        setKey('');
        setBusy(true);
        setError('');
        api('/api/integrations/key', { method: 'PUT', body: JSON.stringify({ key: value }) })
          .then(() =>
            Promise.all([
              pageDataCache.refresh('/api/configuration', true),
              pageDataCache.refresh('/api/apps', true),
              pageDataCache.refresh('/api/apps/catalog', true),
            ]),
          )
          .catch((cause) => setError(errorMessage(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <Field
        label="Composio API key"
        hint="Paste the key your team shared with you. It connects Google apps and Slack."
      >
        <Input
          type="password"
          value={key}
          required
          minLength={8}
          maxLength={16384}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
        />
      </Field>
      <Button type="submit" size="sm" disabled={busy || !key.trim()}>
        {busy ? 'Saving…' : 'Save key'}
      </Button>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}

export function SetupNotice({ configuration }: { configuration: Configuration }) {
  if (configuration.integrationsReady) return null;
  if (configuration.localOnly && !desktopSettingsAvailable())
    return (
      <Notice kind="info">
        <KeyForm />
      </Notice>
    );
  return (
    <Notice kind="info">
      {desktopSettingsAvailable() ? (
        <>
          Composio key is missing.{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openDesktopSettings('models')}
          >
            Open Models
          </Button>
        </>
      ) : (
        <>Google apps and Slack aren’t configured. Contact your Otto administrator.</>
      )}
    </Notice>
  );
}
