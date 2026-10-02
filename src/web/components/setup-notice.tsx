import type { Configuration } from '../../shared/contracts';
import { Notice } from './ui';

export function SetupNotice({
  configuration,
  capability,
}: {
  configuration: Configuration;
  capability: 'assistant' | 'apps';
}) {
  const assistant = capability === 'assistant';
  if (assistant ? configuration.llmReady : configuration.integrationsReady) return null;
  const key = assistant
    ? configuration.provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : 'OPENAI_API_KEY'
    : 'COMPOSIO_API_KEY';
  return (
    <Notice kind="info">
      {configuration.localOnly ? (
        <>
          <code>{key}</code> is missing. Add it to <code>.env</code> and restart Otto
          {assistant ? ' to start chatting.' : ' to connect Google apps and Slack.'}
        </>
      ) : (
        <>
          {assistant ? 'Chat isn’t configured.' : 'Google apps and Slack aren’t configured.'}{' '}
          Contact your Otto administrator.
        </>
      )}
    </Notice>
  );
}
