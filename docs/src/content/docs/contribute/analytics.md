---
title: Change analytics
description: Change product analytics, protect private content, and keep the PostHog dashboards accurate.
sidebar:
  order: 6
---

Change the event schema, collectors, privacy checks, and dashboards together.

[Analytics](/deploy/analytics/) is the collection contract with users. Update it in the same change as the implementation.

## Collection rules

- **Honor both switches.** New owners share usage by default; existing choices remain. The deployment gate and owner's saved preference must both allow capture.
- **Use the capture boundary.** Server events use `CaptureAnalytics` from [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts). UI events use `captureAnalytics`, and surveys use `captureSurvey`, from [`src/web/lib/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics.ts). Don't call PostHog directly.
- **Exclude private content.** No conversations, tool arguments/results, names, contact details, private IDs, URLs/domains, file names/paths, purchase amounts, or raw errors. Answers the owner chooses to submit in a [survey](#surveys) are the content exception. Survey text is sent as entered, so it can contain personal details. A separately consented onboarding email is the only contact detail Nod asks for; it goes on a PostHog person profile and through an internal workflow to Customer.io, never on an event.
- **Use bounded facts.** Prefer enums, booleans, counts, and milliseconds. Public model/app names require catalog validation; custom values become `custom`.
- **Count the observed result.** Save/change events follow committed writes or successful responses. Record clicks and requests separately when those are the actual measurement.
- **Use `<noun>_<past verb>`.** Properties use `snake_case`; reuse names with their existing meaning. Survey events retain PostHog's required names and properties.

Use `provider` for the model provider across onboarding, connection, selection, execution, and usage events. Keep the event's meaning: selected provider at setup/start, last observed agent provider at completion, and actual provider for each model request.

Don't infer completed tasks or frustration from conversations. Execution success, useful output, and user satisfaction are separate questions.

The bounded task classifier is the only analytics model inference. It assigns a fixed primary purpose while usage sharing is enabled; it doesn't infer personal characteristics, sensitive subject matter, satisfaction, or success. Keep its inputs and output within the [published contract](/deploy/analytics/#task-categories).

## Add an event

### Server events

1. Add a strict member to `analyticsEvent` in [`src/server/analytics-events.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics-events.ts).
2. Capture after the observed operation, using `analytics.forOwner(ownerId)` supplied through `src/server/composition.ts`.
3. For a simple successful API mutation, use the existing `analyticsRoutes` map when it fits.
4. Let the capture boundary attach schema, environment, version, and runtime context.

Server events captured within a turn carry `run_id`, `work_type`, and `owner_requested` for model, tool, service, source-read, and committed-output measurements. Resumes retain the origin's execution mode. `task_type` is a separate inferred purpose. Join these server events by analytics ID and `run_id`. UI presentation and artifact events don't carry `run_id` and can't be joined this way. Never send private turn or message IDs.

Wrap autonomous memory maintenance, onboarding preparation, and writing-style learning with `withSystemWork`. These operations carry `work_type=background`, `owner_requested=false`, and a bounded `system_activity`, without creating a run. An existing turn context takes precedence. Model usage without either context carries `work_type=unclassified`; keep it visible in cost reporting rather than guessing its origin from model purpose.

### Task classification

[`src/server/task-classification.ts`](https://github.com/n8n-io/nod/blob/main/src/server/task-classification.ts) runs after execution without delaying the response. It emits `task_classified` within the original analytics run. Its strict response accepts only `task_type` from the fixed taxonomy; the event adds `classification_status` and `task_taxonomy_version=1`. Starts and completions carry the same version marker so queries can identify supported segments.

Only the bounded original owner request, saved task brief, or schedule instruction reaches the classifier: redact known secrets, cap at 6,000 characters, and exclude assistant replies and tool history. Observer/event work, onboarding work, and cancelled, interrupted, or skipped segments produce `not_applicable`. An unusable empty request also produces `not_applicable`.

Use `hasClassificationModel()` and `resolveClassification()` from the model service. Both share the same selection policy: an approved small text model in the selected connection's catalog, known positive prices for both models, and classifier input/output rates no higher than the selected model. Free, missing-price, and variable-price selections are unavailable. Don't fall back to the main model, another connection, or a synthetic zero-price model. An unsupported provider is unavailable. The curator's `classify` operation is untraced, uses the lowest reasoning effort, a 10-second request deadline, 512 output tokens, and zero retries at both the application and provider-client layers. Record its usage once through the ledger as `task_classification`; include it in total spend.

Cache classification results by owned origin, taxonomy version, and consent revision. Reuse results for resumes and later task-session segments, but classify new chat requests separately. Preserve owner isolation, cancellation on opt-out, and rejection of callbacks from earlier sharing periods. A result may be `unavailable` or `failed`; don't repeatedly spend on retries for that origin.

### UI events

1. Add the event to `AnalyticsEvents` and `eventProperties` in `src/web/lib/analytics.ts`. The sanitizer keeps only allowlisted values.
2. Use `captureAnalytics`. For asynchronous work, capture `analyticsForCurrentSession()` before starting, then use it after success.
3. Let the sanitizer set `surface`, `route`, schema, environment, and version.
4. For impressions, use `observeAnalyticsView` through `useAnalyticsView`. It checks viewport intersection and document visibility and deduplicates within the capture period.
5. For a new page, add a normalized route to [`src/web/lib/analytics-privacy.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics-privacy.ts).

Events fired while sharing is off are lost. Don't replay them when sharing turns on. The native setup window has its own first-open event and does not emit web UI step views.

### Onboarding person properties and updates email

When an owner submits About you, set its bounded fixed choices on a PostHog person profile under the same analytics ID as the events. Do this whenever the deployment gate and **Share usage data** are enabled, whether or not the owner later volunteers an email.

Store one property per question: `onboarding_scope`, `onboarding_roles`, `onboarding_who_for`, `onboarding_company_size`, and `onboarding_jobs`. Roles and jobs are arrays of fixed choice IDs, with `other` for a typed **Something else** answer or `skipped` when unanswered. The single-choice properties use fixed `skipped` and `not_asked` markers. Set `onboarding_profile_completed=true`. Never send the text entered under **Something else**. The `onboarding_profile_answered` event keeps its per-option booleans for event-time analysis. A new About submission replaces any old per-option person properties; existing profiles are not changed until resubmitted.

If the person update fails while sharing is still enabled, return a retryable error rather than confirming submission. When sharing is off or the person provider is unavailable, local About you memory can still be saved. Ordinary events still do not create or update profiles. They use `$process_person_profile=false`, so their event-time person properties are empty even after the profile update. Filter linked events by **current** person properties instead. In PostHog Activity, choose **Property filters → SQL expression** and use `pdi.person.properties.onboarding_scope = 'work'` for a single answer or `has(pdi.person.properties.onboarding_roles, 'freelance')` for a selected role. PostHog also supports `hasAny` and `hasAll` for multi-select searches ([array filter guide](https://posthog.com/tutorials/array-filter-breakdown)). Earlier events then reflect the profile's current answers if those answers change.

Only after the owner enters an email address and ticks the consent checkbox for updates about Nod and other n8n products may Nod set its PostHog `email` person property. Store the `nod_updates_email_consent` flag, time, version, exact checkbox wording, and privacy policy link with it. Keep the wording and link in `updatesEmailConsent` in `src/shared/onboarding.ts`, which both the checkbox and saved record use. Raise the version whenever either changes.

Require the deployment gate, configured contact workflow, and **Share usage data** at submission time. Don't send an address when any gate is off. The address joins the existing PostHog onboarding profile under the same installation ID.

The public n8n webhook cannot verify control of an email address. It upserts an unverified Customer.io Labs profile by email with the checkbox claim, receipt time, version, exact wording, privacy policy link, and only the fixed About you choices shared successfully. It stamps its own receipt time, never sends typed **Something else** text, and never changes an existing unsubscribe state.

Submission sends no email. Do not send updates until a double opt-in flow confirms the address. Turning off **Share usage data** stops new sends, but a submission already in flight may still finish. Deleting an address or answers already stored in PostHog or Customer.io requires a request to the Nod team.

### Outputs

Use `presentation_action` for successful native presentation open/copy, with bounded `kind`, `action`, and message/drawer `location`; missing or invalid fields drop the event. Keep its impression identity shared across message and drawer, and don't emit file artifact views for presentations. Copy follows clipboard success and uses a capture snapshot from before the asynchronous operation.

Committed output delivery, visible presentation, artifact view, and artifact action are different events. `download_requested` means a browser request; `download` follows a successful native save. `open` and `reveal` follow native API success. `reuse_requested` means the app dispatched a reuse request, not that an attachment was accepted. Answer-choice collectors run in the question renderer and after server-accepted selection. They report `multiple`, `option_count`, and `selected_count`, with counts from one to six; missing or invalid required fields drop the whole event. The question ID is only a client-side impression key and never enters the event. Option toggles, custom composer answers, and failed, rejected, or unavailable submissions are not selections. Accepted choices also emit `chat_message_sent(source=answer_choice, input=text)`.

## Surveys

Surveys are defined in PostHog and drawn by Nod's own [`SurveyCard`](https://github.com/n8n-io/nod/blob/main/src/web/components/survey-card.tsx). PostHog's automatic popup is disabled. The bundled survey extension supplies eligibility checks. Create surveys as type `api` and check that their internal targeting flag is active after launch.

- The server enables surveys after the owner has sent messages on at least three different UTC calendar days. The count stays on the Nod installation and isn't sent to PostHog.
- `watchAnalyticsSurvey` selects the first eligible survey whose questions have UUID IDs and supported types: ratings with scales of 3, 5, 7, or 10, or open text. A survey with an unsupported question isn't shown.
- The card shows one question at a time. Choosing a score sends it immediately, even if the owner later closes the survey. Typed answers are sent only with **Next** or **Send**. Each `survey sent` includes submitted answers so far and a shared submission ID. `$survey_completed` is true only on the final question.
- Closing sends `survey dismissed` without answers. After any partial submission, it also includes the submission ID and `$survey_partially_completed`. Unsubmitted text never enters the event.
- The sanitizer accepts only UUID survey IDs, nonnegative iterations, UUID submission IDs, and the event's allowed completion markers. `survey sent` also carries question IDs and wording, integer scores from 0 to 10, and submitted text capped at 2,000 characters. Survey names, profile updates, and recording metadata are excluded.
- Eligible sessions can fetch survey definitions with the project token and evaluate survey-only targeting flags with the token and analytics ID. The SDK adds a request timestamp in the URL. General feature-flag and remote-configuration requests remain blocked.
- Keep survey impressions tied to visible cards. Preserve seen-survey markers when the same installation resumes sharing, while clearing draft answers and requests from the previous sharing period.
- Survey answers are sent as entered. Don't ask for conversations, credentials, names, account details, or other [excluded content](/deploy/analytics/#what-is-excluded).
- Keep `data-analytics-private` on the card to exclude it from user-triggered feedback screenshots. Session recording stays disabled.

## Keep capture bounded

Session recordings are disabled. Don't load a recorder, capture DOM snapshots, or forward recording identifiers or properties. The UI capture boundary rejects snapshot events and recording properties. Pseudonymous browser session/window IDs remain part of the documented SDK metadata; their presence doesn't indicate a recording.

Use normalized app routes for navigation. Keep the `https://app.example` placeholder host; real hosts, private IDs, query strings, and fragments must not enter analytics.

`data-analytics-private` still prevents user-triggered feedback screenshots on sensitive screens. Keep those markers when changing a private surface.

Opt-out must discard queued and retry events. Asynchronous callbacks from an earlier account or sharing period must not capture into the new one.

## Change or remove a contract

| Change                                                                | Action                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Add an optional property or bounded value without changing meaning    | Update schemas, collectors, docs, and relevant insights.                                |
| Rename an event/property or change its meaning in a released contract | Bump `schemaVersion` in `src/shared/analytics.ts` and replace affected insight queries. |
| Remove collection                                                     | Delete the collector and schema entry, then remove or replace dependent insights.       |

The current contract is `v4`. It starts fresh. There is no historical migration or requirement to preserve a one-to-one event mapping. Earlier events can remain in PostHog storage but aren't used by current dashboards.

## Read the dashboards

The team maintains an overview and focused analytics dashboards for the telemetry plan:

| Dashboard               | Questions                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                | Observed installs, the first-use funnel, first-week usage, first-day app connections, and connected service, channel, and model rankings. |
| Onboarding answers      | About you answer distributions for scope, who-for, company size, roles, and tasks.                                                        |
| Apps and connections    | First-day app connection by first-observed date and version, latest observed app inventory, paired-channel state, and service reach.      |
| Usage and retention     | Accepted-message volume and source, first-day depth, D3 and D0–D7 activity, conditional D0→D1 return, and aha associations.               |
| Product health          | Active analytics IDs, owner-requested work, execution outcomes, and return cohorts.                                                       |
| Reliability and cost    | Queue/execution latency, model cost and pricing coverage, integration/tool failures, UI errors, and uncertain confirmations.              |
| Outputs and interaction | Committed and shown output kinds, artifact actions, answer-choice use, explicit interaction reach, schedules, and source reads.           |
| Navigation and controls | Page and tab reach, committed settings, local choices, and memory/Vault changes.                                                          |

Task-category views answer five further questions: which purposes appear, how their execution duration and outcomes compare, what their known model costs are, how much classification coverage is missing or unavailable, and what the classifier itself costs. Keep purpose, execution mode, and outcome as separate dimensions.

All insights filter `analytics_schema=v4` and `environment=production` and include internal and external usage. New-event charts have no rows until their capturing release is used and any cohort window matures. Don't mix old schema history into them. The Onboarding answers board shows the five About you distributions, including skipped answers.

Internal/test exclusions are off for these dashboards. The production sample intentionally includes staff using release builds. A separate project for internal use is deferred; don't describe this mixed sample as external users.

### Denominators and limits

- **Observed installs:** Count each distinct analytics ID once, without a separate install event. First observation in production `v4` traffic is the cohort date. An ID represents a sharing runtime profile and can be observed after the software was installed or opened. It is not a verified device or person count. First-day charts require a complete 24-hour observation window; D3 message cohorts require the entire third UTC calendar day after first observation to finish.
- **First open:** A fresh packaged local profile can emit `app_opened(entry=native_setup)` when its first native setup window becomes visible. A desktop main process that supports server verification marks its native capture and same-UUID web retry with `server_connection_telemetry_available=true`; an older main process cannot add the marker. Returning desktop and web sessions emit `app_opened(entry=app_ui)` only after their saved sharing choice is known. Native startup-path observations belong to the local ID; a remote server uses a separate ID. Keep these entry types separate in conversion charts. A later opt-out or failed delivery can leave an opening without observed continuation.
- **Verified server connection:** The native desktop emits `server_connection_verified` under its local ID after an authenticated saved server reaches the ready state. Require the connected server's current usage-sharing choice and analytics gate as well as the desktop gate; the consent revision must match the initial authenticated check. An older server without a revision still connects, but its verification is not observed. Never include its URL, token, owner ID, or consent revision in the event. For `First-day verified server connection rate`, start with fresh native `app_opened` IDs marked `server_connection_telemetry_available=true` and a complete 24-hour observation window, group by their first-open UTC date, and count a same-ID verification within 24 elapsed hours. This is an observed fresh-desktop analytics-ID cohort, not verified signups or people. Repeated successful starts count once per ID in that cohort. Remote opt-out, disabled server analytics, and older server versions can hide a real successful connection, so absence is not confirmed failure. Server-side activity still has a different ID.
- **Active use:** An execution start rooted in an owner request: `owner_requested=true` and `source` equal to `user` or `task`. This includes agent-created child tasks from an existing request, so it doesn't establish a fresh owner message or visit. These saved charts exclude all `resume` starts, including genuine confirmation messages; inputs merged into a running turn create no separate start. Counts of distinct analytics IDs represent observed sharing runtime profiles, not all software installations or individual humans.
- **Execution:** Outcomes describe segments. Waiting isn't success or failure; a completed segment doesn't verify the whole task.
- **Task categories:** Join classification to execution using analytics ID and `run_id`. Count segments, not whole jobs or unique requests; resumed segments can reuse a category, so the mix is weighted by execution volume. Reach by distinct analytics ID shows breadth, but one analytics ID can appear in several categories. The coverage denominator includes all observed completed segments with usable run IDs, including `not instrumented`; the taxonomy marker distinguishes those older observations from instrumented work. Allow 60 seconds after completion for classification and keep pending results, missing events, and explicit statuses separate. Development inspection also preserves open segments. `classified` with `unknown` means the model couldn't choose one primary purpose; `unavailable`, `failed`, and `not_applicable` also use `unknown` but must not be folded into that group. Classification eligibility depends on the selected provider/model and work type, so inspect coverage by those contexts before generalizing the category mix. Categories are inferred intent, not validated outcomes.
- **First attempt after setup:** Cohorts start at the first observed onboarding completion for each analytics ID, calculated before date selection. Select its first owner-requested chat or Tasks execution start within seven elapsed days. Join only that analytics ID and `run_id` to the completion. Later retries and resumes don't replace the first result. Open start windows, elapsed windows without starts, missing run IDs, and starts without completions remain separate. All selected onboarding cohorts enter the denominator; incomplete observations aren't failures. The eventual-success funnel answers a different question.
- **Declared tasks and prepared work:** Task finish events measure committed `done` or `cancelled` transitions. Prepared-work events measure changed preparation, saved offer messages, and changed owner-requested controls, including usefulness feedback. These aren't verified task outcomes or satisfaction scores. No-op and rolled-back writes are excluded.
- **Return after first success:** The first observed `v4` successful owner-requested execution segment starts the cohort, including a resumed segment. A later execution start with `owner_requested=true` and `source=user|task` is the return proxy; it can be an agent-created child of an existing request, not a fresh owner message. All resume starts are excluded. D1, W1, W2, and W4 use elapsed windows of 1–2, 7–14, 14–21, and 28–35 days. An analytics ID enters each denominator only when its entire window has elapsed, as of the earlier of now and the selected end date. Find the first success globally before applying the selected cohort range, which defaults to 90 days. The 30% W4 reference is a target for this observed execution sample, not proof of human return, useful whole-job completion, or a forecast. Queue delays and later child starts can cross window boundaries without new owner input; messages merged into a running turn create no separate start.
- **Attempt retention:** The separate native retention charts start at the first observed execution start with `owner_requested=true` and `source=user|task`, including previously observed analytics IDs and failed attempts. D0 is cohort size; D1 and W1/W2/W4 measure another matching start in elapsed, noncumulative windows. They inherit the child-task, resume, and merged-input limits above and use a different denominator from return after first success.
- **Connection entry:** Connect clicks and confirmed completions retain their original `apps`, `chat`, `onboarding`, or `manage` entry. The counts don't join individual attempts and aren't a conversion rate.
- **Connected apps:** `connection_observed` measures app types seen in a snapshot and can include connections made before the selected period. `connection_changed(status=connected)` measures completed transitions, including reconnects. The historical first-day charts count those transitions in the 24 hours after each ID's global first observed event and include all mature IDs; one also groups results by that first-observed UTC date and entry runtime version. First observation is not a verified signup date. The separate launch-cohort chart requires an opening within that first day and excludes native IDs whose first-day path ends on the remote form; it will populate after release. After `connection_inventory_observed` ships, use its latest zero-inclusive snapshot per ID for the number of connected app types. It groups custom connections as `custom`, does not count accounts or continuously monitor live state, and should not be interpreted as an exact current inventory.
- **Connected channels:** Compare accepted-message senders with the latest observed state for each analytics ID and channel. Include message senders without a connected-channel observation in the denominator. `owner_message_accepted.channel` records where a message arrived and is a separate source measure. Telegram's connected state requires a paired owner and configured polling or registered webhook mode; linked WhatsApp requires a live connected link. A cloud webhook remains unverified until a stronger signal exists.
- **Model at setup:** `model_setup_completed` follows a server check of the usable selected model when the owner reaches Privacy, including a preconfigured-model skip. Successful final setup emits the same milestone as a fallback if the Privacy request was missed. Select the first valid milestone per analytics ID for the provider and public-model distribution; the same owner can revisit Privacy. `onboarding_completed` follows the final required-model check and its provider breakdown uses only IDs that finished all setup. Neither event alone measures conversion among everyone who entered Brain.
- **Costs:** Model estimates exclude unpriced usage, browser fees, and independent integration charges. Tool duration isn't billed browser runtime. Per-segment cost joins analytics ID and `run_id`, then groups actual usage by provider and model. Whole-segment estimates and each model's contribution are separate rows; multi-model segments overlap across model rows. Include `purpose=task_classification` in totals and report its overhead separately; these requests can arrive after completion. Subtotals include only observed requests in the selected date range. Segments spanning its boundaries can have incomplete costs even when every observed request has a price. Missing prices or missing usage records are not free usage. Standalone system and unclassified requests without a run stay outside per-segment estimates. Segments are not complete multi-turn jobs.
- **Outputs:** Committed delivery, visibility, copying, and saving are separate observations. Their totals aren't a per-output conversion funnel.
- **Navigation:** Page, Apps tab, and Settings section views measure observed reach, not time spent or intent. Settings sections (`general`, `notifications`, `models`, `voice`, `memory`, `privacy`) can be reached by scrolling; all their paths normalize to `/settings`. `/tasks` is Scheduled and emits no tab event. Apps keeps `all`/`connected`. An analytics ID can appear in several rows.
- **Settings:** `setting_changed` follows a committed value change, attributed to owner, agent, or system. System identifies app-reported automatic browser-timezone initialization; this telemetry hint grants no authority. `settings_updated` counts accepted requests and can include unchanged writes. Its operation names describe the request, not a confirmed connection or disconnection. Local browser notifications record `dismissed` when the owner saves **Not now**, not when a delivered notification closes.
- **Memory and Vault:** Changes and import batches measure writes. They don't establish inventory, reading, successful sign-in, or usefulness.
- **Interaction reach:** Distinct analytics IDs using reactions, copy/reply, task and browser controls, starter cards, feedback, browser notifications, or voice input. Rows overlap; reactions and feedback reports aren't satisfaction scores.

These events don't establish uptime, task quality, satisfaction, reasons for leaving, trust, security incidents, offline demand, or company-paid cost. About you collects fixed, self-reported role, company-size, and initial-task choices while sharing is enabled; AI experience and preferred tools are not collected here. Survey answers are separate, voluntary observations; they don't make usage events a measure of satisfaction or reasons for leaving. Use independent operational checks and user research for those questions.

The pre-mortem's named-group retention, NPS, and departure-reason questions need audience information and a sufficient response sample. Survey collection alone doesn't answer them. A fresh cohort needs 35 days before its complete W4 window can be read. Model costs exclude independent browser and integration bills, and execution duration isn't time to the first useful answer.

Use `owner_message_accepted` for fresh owner return across channels after its release. It records a newly committed message once, including explicit yes/no confirmation replies, and has no analytics run ID. The aha candidate is the number of accepted owner messages per analytics ID; no threshold is set before comparing real message counts with later return. Exclude the event's pre-release period from message-based cohorts. The first-day count starts at the ID's first observed event; D3 is the third UTC calendar date after that event; D0–D7 return starts at the first accepted message. `chat_message_sent` remains a web and desktop UI event and is not the cross-channel denominator. Message source does not prove that a channel was successfully paired.

First-week daily activity uses the UTC date of an ID's first observed production event as D0 and counts whether it sent at least one accepted owner message on each D0–D7. Each day's denominator includes only IDs whose whole UTC day has elapsed, including IDs with no messages. Restrict cohorts to IDs first observed after app-open and accepted-message collection began, with a native setup or consented app UI opening. Exclude native local IDs whose latest startup path observed within the first 24 hours is remote; keep native and app UI entry groups visible because later opt-out can censor native continuation. The separate D0–D7 return view begins at the first accepted message, so its denominator and dates differ.

Conditional D0→D1 retention divides D1-active IDs by IDs active on D0 whose entire D1 UTC date has elapsed. It has a smaller denominator than the first-week daily-activity chart, which includes eligible IDs without a D0 message.

### Maintain insights

Keep each dashboard focused on questions the team reads. Prefer native trend, funnel, and retention queries; use SQL only where the calculation requires it.

Run a query before saving it, then read back the saved definition and execute the dashboard. Keep descriptions clear about units and limits. Save canonical definitions in the Data Catalog when available; dashboard text isn't a governed metric definition.

Check property types against the capture schema. Enum properties such as `status` use String; token counts, durations, and costs use Numeric. Verify received values as well as query execution: a wrong property type can turn a stored value into a blank breakdown.

Use taxonomy version `1` explicitly for category queries. A taxonomy meaning change requires a new version; never let a model invent new labels. Deduplicate repeated observations by analytics ID and `run_id` before joining, retain missing classification and pricing coverage, and avoid multiplying cost rows when joining usage to completion.

For checks of one analytics ID, show event details from the application's property allowlist. Preserve zero and false values, omit absent properties, and exclude SDK metadata. Keep these development views separate from production dashboards.

Check pricing before rounding costs. Preserve explicitly reported API zero and positive plan estimates. A zero SDK estimate or a missing price is unavailable; omit `cost_usd` rather than treating it as free usage.

When retiring insights, preserve a recoverable definition snapshot outside the repository before removing their tiles. Remove unused saved insights too.

## Check a change

1. Run focused regression tests. For capture or consent changes shared across surfaces, also run `pnpm run check`, `pnpm run test:integration`, and `pnpm run build`; scope other checks to the affected behavior as described in [Checks and tests](/contribute/checks-and-tests/).
2. Run `pnpm exec tsx scripts/analytics-fixture.ts`. It selects an available port and prints its URL. Use synthetic data, exercise the changed UI, and inspect `/__fixture__/summary`.
3. Confirm the expected event/properties and that both `privateDataLeaked` and `generatedContentLeaked` stay `false`. `captureErrors`, `recordingEvents`, `recordingRequests`, and `remoteConfigurationRequests` must all be zero, with at least one captured event. Set `NOD_ANALYTICS_FIXTURE_OUTPUT` to save captured batches outside the repository.
4. To check surveys, prepare with `/__fixture__/prepare?sharing=on&surveys=on` and reload. Submit a score and reason, close another survey with an unsent draft, then turn sharing off and on. Inspect `surveyFlagRequests` for bodies containing only the token and analytics ID, and inspect `surveyDefinitionRequests`; neither request type should run before eligibility or while sharing is off. Completed or dismissed surveys should stay hidden for the same installation.
5. Check opt-out, account changes, stale callbacks, retries, hidden views, and private content. Tests must intercept transport rather than send synthetic production events.
6. Run `pnpm --dir docs build`. After release, separately verify aggregate PostHog ingestion and the relevant saved insights.

Fixture results prove controlled transport behavior, not live delivery or production retention. Read every property boundary as well as testing it.

For classification changes, test strict output parsing, fixed buckets, origin reuse, owner isolation, opt-out during a call, stale sharing periods, unsupported model catalogs, pricing guards, output/deadline/retry limits, and single-counted usage with synthetic data. Keep a frozen set of representative and ambiguous requests for a separate category-quality evaluation; deterministic transport tests don't establish classification accuracy.

## Related resources

- [Contribute to Nod](/contribute/)
- [Analytics](/deploy/analytics/)
- [Your data and privacy](/trust/privacy/)
- [Checks and tests](/contribute/checks-and-tests/)
