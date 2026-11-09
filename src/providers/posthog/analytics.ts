import { PostHog } from 'posthog-node';
import type { ProductAnalytics } from '../../ports/analytics.ts';
import { posthogConfig } from '../../shared/analytics.ts';

export function createPostHogAnalytics(): ProductAnalytics {
  const clients = new Map<
    AbortSignal,
    { distinctId: string; revision?: string; client: PostHog }
  >();
  const pending = new Set<Promise<unknown>>();
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
    setPersonProperties(input, signal) {
      if (closing || signal.aborted || !input.distinctId || !Object.keys(input.properties).length)
        return Promise.resolve(false);
      const operation = (async () => {
        try {
          const response = await fetch(`${posthogConfig.host}/i/v0/e/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
            body: JSON.stringify({
              api_key: posthogConfig.key,
              event: '$set',
              distinct_id: input.distinctId,
              properties: {
                $set: input.properties,
                ...(input.unset?.length ? { $unset: input.unset } : {}),
                $geoip_disable: true,
              },
            }),
          });
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            return false;
          }
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
          const result = body as Record<string, unknown>;
          const limited = result.quota_limited;
          const quotaAvailable =
            limited == null ||
            limited === '' ||
            (Array.isArray(limited) && limited.length === 0) ||
            (typeof limited === 'object' && Object.keys(limited).length === 0);
          return result.status === 'Ok' && quotaAvailable && !signal.aborted;
        } catch {
          return false;
        }
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
      return operation;
    },
    shutdown: () =>
      (closing ??= Promise.all([...clients.values()].map(({ client }) => shutdown(client)))
        .then(() => Promise.all([...pending]))
        .then(() => {
          clients.clear();
        })),
  };
}
