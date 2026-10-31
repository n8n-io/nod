---
title: Change analytics
description: Change product analytics, protect private content, and keep the PostHog dashboards accurate.
sidebar:
  order: 6
---

Change the event schema, collectors, privacy checks, and dashboards together.

[Analytics and recordings](/deploy/analytics/) is the collection contract with users. Update it in the same change as the implementation.

## Collection rules

- **Honor both switches.** New owners share usage by default; existing choices remain. The deployment gate and owner's saved preference must both allow capture.
- **Use the capture boundary.** Server events use `CaptureAnalytics` from [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts). UI events use `captureAnalytics` from [`src/web/lib/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics.ts). Don't call PostHog directly.
- **Exclude private content.** No conversations, tool arguments/results, names, contact details, private IDs, URLs/domains, file names/paths, purchase amounts, or raw errors.
- **Use bounded facts.** Prefer enums, booleans, counts, and milliseconds. Public model/app names require catalog validation; custom values become `custom`.
- **Count the observed result.** Save/change events follow committed writes or successful responses. Record clicks and requests separately when those are the actual measurement.
- **Use `nod_<noun>_<past verb>`.** Properties use `snake_case`; reuse names with their existing meaning.

Don't infer completed tasks or frustration from conversations. Execution success, useful output, and user satisfaction are separate questions.

## Add an event

### Server events

1. Add a strict member to `analyticsEvent` in [`src/server/analytics-events.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics-events.ts).
2. Capture after the observed operation, using `analytics.forOwner(ownerId)` supplied through `src/server/composition.ts`.
3. For a simple successful API mutation, use the existing `analyticsRoutes` map when it fits.
4. Let the capture boundary attach schema, environment, version, and runtime context.

Server events captured within a turn carry `run_id`, `work_type`, and `owner_requested` for model, tool, service, source-read, and committed-output measurements. Resumes retain the origin's category. Use installation identity plus analytics `run_id` to join these server events. UI presentation and artifact events don't carry `run_id` and can't be joined this way. Never send private turn or message IDs.

Wrap autonomous memory maintenance, onboarding preparation, and writing-style learning with `withSystemWork`. These operations carry `work_type=background`, `owner_requested=false`, and a bounded `system_activity`, without creating a run. An existing turn context takes precedence. Model usage without either context carries `work_type=unclassified`; keep it visible in cost reporting rather than guessing its origin from model purpose.

### UI events

1. Add the event to `AnalyticsEvents` and `eventProperties` in `src/web/lib/analytics.ts`. The sanitizer keeps only allowlisted values.
2. Use `captureAnalytics`. For asynchronous work, capture `analyticsForCurrentSession()` before starting, then use it after success.
3. Let the sanitizer set `surface`, `route`, schema, environment, and version.
4. For impressions, use `observeAnalyticsView` through `useAnalyticsView`. It checks viewport intersection and document visibility and deduplicates within the capture period.
5. For a new page, add a normalized route to [`src/web/lib/analytics-privacy.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics-privacy.ts).

Events fired while sharing is off are lost. Don't replay them when sharing turns on. Native Welcome is outside app analytics.

### Outputs

Committed output delivery, visible presentation, artifact view, and artifact action are different events. `download_requested` means a browser request; `download` follows a successful native save. Answer-choice collectors report mode and bounded option/selection counts; they still require integration with that feature's actual renderer and successful submission.

## Keep recordings private

Recordings mask text and inputs by default. Block any surface that shows owner, model, app, or website content using `data-analytics-private` or the `blocked` selectors in `analytics-privacy.ts`.

Use `data-analytics-public` only for static product labels. Answer text, artifacts, account labels, and errors remain private.

Opt-out must discard queued/retry events and recordings. Asynchronous callbacks from an earlier account or sharing period must not capture into the new one.

## Change or remove a contract

| Change                                                             | Action                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Add an optional property or bounded value without changing meaning | Update schemas, collectors, docs, and relevant insights.                                |
| Rename an event/property or change its meaning                     | Bump `schemaVersion` in `src/shared/analytics.ts` and replace affected insight queries. |
| Remove collection                                                  | Delete the collector and schema entry, then remove or replace dependent insights.       |

The current contract is `nod_v4`. It starts fresh. There is no historical migration or requirement to preserve a one-to-one event mapping. Earlier events can remain in PostHog storage but aren't used by current dashboards.

## Read the dashboards

The [Nod PostHog project](https://eu.posthog.com/project/231804) has four dashboards:

| Dashboard                                                                                   | Questions                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Nod · Product health](https://eu.posthog.com/project/231804/dashboard/1036780)             | Active installations, owner-requested work, execution outcomes, and return cohorts.                                          |
| [Nod · Activation and connections](https://eu.posthog.com/project/231804/dashboard/1036781) | Existing setup progress and skips, first successful execution, app/model connections, and connection entry.                  |
| [Nod · Reliability and cost](https://eu.posthog.com/project/231804/dashboard/1037782)       | Queue/execution latency, model cost and pricing coverage, integration/tool failures, UI errors, and uncertain confirmations. |
| [Nod · Outputs and interaction](https://eu.posthog.com/project/231804/dashboard/1036782)    | Committed and shown output kinds, artifact actions, answer-choice use, schedules, and source-read outcomes.                  |

All insights filter `analytics_schema=nod_v4` and `environment=production`, enable internal/test exclusions, and carry the schema tag. Empty charts before release are expected. Don't mix old schema history into them.

### Denominators and limits

- **Active use:** An owner-authored message in chat or Tasks: `owner_requested=true` and `source` equal to `user` or `task`. These saved charts exclude all `resume` events, including genuine confirmation messages. Identity counts represent sharing installations, not all installations or individual humans.
- **Execution:** Outcomes describe segments. Waiting isn't success or failure; a completed segment doesn't verify the whole task.
- **Retention:** The first observed owner-authored message in chat or Tasks under `nod_v4` starts the cohort, including for existing installations. D0 is cohort size. D1 and W1/W2/W4 measure another owner-authored message in elapsed, noncumulative windows, using the same `user`/`task` source filter as active use. Wait until each window matures; W4 needs the full fourth return window. The 30% W4 reference is a target, not a forecast.
- **Connection entry:** Connect clicks and confirmed completions retain their original `apps`, `chat`, `onboarding`, or `manage` entry. The counts don't join individual attempts and aren't a conversion rate.
- **Costs:** Model estimates exclude unpriced usage, browser fees, and independent integration charges. Tool duration isn't billed browser runtime.
- **Outputs:** Committed delivery, visibility, copying, and saving are separate observations. Their totals aren't a per-output conversion funnel.

These events don't establish uptime, task quality, satisfaction, reasons for leaving, trust, security incidents, offline demand, or company-paid cost. Audience characteristics such as role, company size, AI experience, and preferred tools are not collected. NPS and stopped-use surveys are outside this instrumentation. Use independent operational checks and separate user research for those questions.

### Maintain insights

Keep each dashboard focused on questions the team reads. Prefer native trend, funnel, and retention queries; use SQL only where the calculation requires it.

Run a query before saving it, then read back the saved definition and execute the dashboard. Keep descriptions clear about units and limits. Save canonical definitions in the Data Catalog when available; dashboard text isn't a governed metric definition.

When retiring insights, preserve a recoverable definition snapshot outside the repository before removing their tiles. Remove unused saved insights too.

## Check a change

1. Run focused regression tests, then `pnpm run check`, `pnpm run test:integration`, and `pnpm run build`.
2. Run `pnpm exec tsx scripts/analytics-fixture.ts`. It selects an available port and prints its URL. Use synthetic data, exercise the changed UI, and inspect `/__fixture__/summary`.
3. Confirm the expected event/properties and that both `privateDataLeaked` and `generatedContentLeaked` stay `false`. Set `NOD_ANALYTICS_FIXTURE_OUTPUT` to save captured batches outside the repository.
4. Check opt-out, account changes, stale callbacks, retries, hidden views, and private content. Tests must intercept transport rather than send synthetic production events.
5. Run `pnpm --dir docs build`. After release, separately verify aggregate PostHog ingestion and the relevant saved insights.

Fixture results prove controlled transport behavior, not live delivery or production retention. Read every property boundary as well as testing it.

## Related resources

- [Contribute to Nod](/contribute/)
- [Analytics and recordings](/deploy/analytics/)
- [Your data and privacy](/trust/privacy/)
- [Checks and tests](/contribute/checks-and-tests/)
