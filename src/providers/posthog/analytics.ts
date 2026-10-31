import { PostHog } from 'posthog-node';
import type { ProductAnalytics } from '../../ports/analytics.ts';
import { posthogConfig } from '../../shared/analytics.ts';
import {
  analyticsProfileProperties,
  analyticsProfileSchema,
} from '../../shared/analytics-profile.ts';
import {
  churnLabels,
  productSurveys,
  productSurveyEventSchema,
} from '../../shared/product-surveys.ts';

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
      const profile =
        input.event === 'nod_profile_updated'
          ? analyticsProfileSchema.safeParse(
              Object.fromEntries(
                ['role', 'company_size', 'ai_experience', 'ai_tools']
                  .filter((key) => input.properties[key] !== undefined)
                  .map((key) => [key, input.properties[key]]),
              ),
            )
          : undefined;
      const properties = profile?.success ? analyticsProfileProperties(profile.data) : undefined;
      const survey =
        input.event === 'nod_survey_changed'
          ? productSurveyEventSchema.safeParse(
              Object.fromEntries(
                ['survey', 'submission_id', 'status', 'score', 'reason']
                  .filter((key) => input.properties[key] !== undefined)
                  .map((key) => [key, input.properties[key]]),
              ),
            )
          : undefined;
      if (input.event === 'nod_survey_changed' && !survey?.success) return;
      const response = survey?.success ? survey.data : undefined;
      const definition = response ? productSurveys[response.survey] : undefined;
      binding.client.capture({
        ...event,
        ...(response ? { event: `survey ${response.status}` } : {}),
        properties: {
          ...input.properties,
          $process_person_profile: Boolean(properties || response),
          ...(response && definition
            ? {
                $survey_id: definition.id,
                $survey_iteration: 0,
                $set:
                  response.status === 'shown'
                    ? { $survey_last_seen_date: new Date().toISOString() }
                    : {
                        [`$survey_${response.status === 'sent' ? 'responded' : 'dismissed'}/${definition.id}`]: true,
                      },
                ...(response.status === 'sent'
                  ? {
                      $survey_submission_id: response.submission_id,
                      $survey_completed: true,
                      $survey_questions: [
                        { id: definition.questionId, question: definition.question },
                      ],
                      [`$survey_response_${definition.questionId}`]:
                        response.survey === 'nps' ? response.score : churnLabels[response.reason],
                    }
                  : {}),
              }
            : {}),
          ...(properties
            ? {
                $set: properties,
                $unset: [
                  'profile_role',
                  'profile_company_size',
                  'profile_ai_experience',
                  'profile_ai_tools',
                ].filter((key) => properties[key] === undefined),
              }
            : {}),
        },
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
