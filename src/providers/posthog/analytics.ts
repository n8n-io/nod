import { PostHog } from 'posthog-node';
import type { ProductAnalytics } from '../../ports/analytics.ts';
import { posthogConfig } from '../../shared/analytics.ts';

export function createPostHogAnalytics(): ProductAnalytics {
  const client = new PostHog(posthogConfig.key, {
    host: posthogConfig.host,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
    fetchRetryCount: 0,
    requestTimeout: 3_000,
    flushInterval: 10_000,
  });
  client.on('error', () => {});
  return {
    capture: (input) =>
      client.capture({
        ...input,
        properties: { ...input.properties, $process_person_profile: false },
        sendFeatureFlags: false,
      }),
    shutdown: () => client.shutdown(3_000),
  };
}
