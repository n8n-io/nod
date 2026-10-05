import { PostHog } from 'posthog-node';
import type { ProductAnalytics } from '../../ports/analytics.ts';
import { posthogConfig } from '../../shared/analytics.ts';

export function createPostHogAnalytics(): ProductAnalytics {
  let client: PostHog | undefined;
  let closing: Promise<void> | undefined;
  return {
    capture(input) {
      if (closing) return;
      if (!client) {
        client = new PostHog(posthogConfig.key, {
          host: posthogConfig.host,
          disableGeoip: true,
          enableExceptionAutocapture: false,
          enableLocalEvaluation: false,
          fetchRetryCount: 0,
          requestTimeout: 3_000,
          flushInterval: 10_000,
        });
        client.on('error', () => {});
      }
      client.capture({
        ...input,
        properties: { ...input.properties, $process_person_profile: false },
        sendFeatureFlags: false,
      });
    },
    shutdown: () => (closing ??= client?.shutdown(3_000) ?? Promise.resolve()),
  };
}
