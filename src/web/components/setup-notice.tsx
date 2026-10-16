import type { Configuration } from '../../shared/contracts';
import { Notice } from './ui';

export function SetupNotice({ configuration }: { configuration: Configuration }) {
  if (configuration.integrationsReady) return null;
  return <Notice kind="info">App connections are unavailable. Try again later.</Notice>;
}
