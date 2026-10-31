import { PostHog } from 'posthog-node';
import type { ProductAnalytics } from '../../ports/analytics.ts';
import { posthogConfig } from '../../shared/analytics.ts';

export function createPostHogAnalytics(): ProductAnalytics {
  const clients = new Map<
    AbortSignal,
    { distinctId: string; revision?: string; client: PostHog }
  >();
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  function shutdown(client: PostHog) {
    const operation = client.shutdown(3_000).catch(() => {});
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
    return operation;
  }
  return {
    capture(input, signal) {
      if (closing || signal.aborted) return;
      let binding = clients.get(signal);
      if (
        binding &&
        (binding.distinctId !== input.distinctId || binding.revision !== input.consentRevision)
      )
        return;
      if (!binding) {
        const client = new PostHog(posthogConfig.key, {
          host: posthogConfig.host,
          disableGeoip: true,
          enableExceptionAutocapture: false,
          enableLocalEvaluation: false,
          fetchRetryCount: 0,
          requestTimeout: 3_000,
          flushInterval: 10_000,
          before_send: (event) => (signal.aborted ? null : event),
          fetch: async (url, request) => {
            if (signal.aborted) return Response.json({ status: 1 });
            return fetch(url, {
              ...request,
              signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
            });
          },
        });
        client.on('error', () => {});
        binding = { distinctId: input.distinctId, revision: input.consentRevision, client };
        clients.set(signal, binding);
        signal.addEventListener(
          'abort',
          () => {
            clients.delete(signal);
            void shutdown(client);
          },
          { once: true },
        );
      }
      const { consentRevision: _revision, ...event } = input;
      binding.client.capture({
        ...event,
        properties: { ...input.properties, $process_person_profile: false },
        sendFeatureFlags: false,
      });
    },
    shutdown: () =>
      (closing ??= Promise.all([...clients.values()].map(({ client }) => shutdown(client)))
        .then(() => Promise.all([...pending]))
        .then(() => {
          clients.clear();
        })),
  };
}
