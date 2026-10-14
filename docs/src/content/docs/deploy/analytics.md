---
title: Analytics and recordings
description: What usage data Otto collects when you opt in, how to turn it off, and the rules for masked session recordings.
sidebar:
  order: 4
---

This page explains what usage data Otto collects, how to turn it on or off, and what session recordings never show.

Usage data is opt-in for each owner and off by default. Otto sends product events and masked session recordings to PostHog in the EU. Raw conversation and form content are excluded. Connected services are identified by normalized public domains.

## Turn usage data on or off

You turn on **Share usage data** in the last onboarding step, or later in **Settings → General** in the desktop app and **Settings → Appearance** on the web. Nothing is collected before you sign in or opt in.

The deployment has a switch too. Otto collects only when both are on, and `OTTO_ANALYTICS_ENABLED=false` always wins.

```mermaid
flowchart LR
  deploy{{Deployment<br/>allows it?}} -- yes --> owner{{You turned on<br/>Share usage data?}}
  deploy -- no --> off[Nothing sent]:::stop
  owner -- no --> off
  owner -- yes --> on[Events and<br/>masked recordings]:::go
```

| Setting                      | Effect                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `OTTO_ANALYTICS_ENABLED`     | `false` turns off events and recordings. `true` turns them on, even in development.       |
| `OTTO_ANALYTICS_ENVIRONMENT` | Sets the event label to `production` or `development` without turning anything on or off. |

Restart Otto after you change either one. Hosted operators set them in `GATEWAY_ENV` and roll out a new release. See [Hosted on Cloudflare](/deploy/cloudflare/).

## Identity

Otto counts installations and hosted accounts, not people. Two installations count as two, and a shared one counts as one.

| Runtime                | Identity                                                       | Available by default                               |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Source install         | `local:<installation UUID>` in `<OTTO_DATA_ROOT>/analytics-id` | With `pnpm start`, not with `pnpm run dev`         |
| Desktop app            | `local:<installation UUID>` in the desktop profile             | In packaged apps, not in development               |
| Hosted                 | `hosted:<owner UUID>` from the signed-in account               | When `OTTO_ENVIRONMENT=production`, not in staging |
| Hosted, before sign-in | None                                                           | Never                                              |

"Available" still needs the owner's opt-in. A hosted identity always comes from the signed-in account, never from a header the client sends. Recording stops and the identity resets when the account changes or signs out.

## Events

Every event carries `analytics_schema=otto_v3`, `deployment` (`local` or `hosted`) and `environment`. UI events and recordings add `surface` (`web` or `desktop`) and a normalized `route`. Server events add `capture_source=server`. Events within a turn also carry a random `run_id`, separate from Otto's private turn and conversation IDs. Packaged releases also include `app_version`. Properties use an explicit schema: short task labels, bounded execution states, booleans, counts, durations, opaque analytics IDs and normalized service domains. Unknown properties are rejected.

| Event                            | When                                                                                    | Properties                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$pageview`                      | A normalized route becomes visible                                                      | `route`                                                                                                                                                                                                                            |
| `$snapshot`                      | Masked full or incremental recording                                                    | PostHog replay metadata and masked snapshot data                                                                                                                                                                                   |
| `otto_onboarding_step_viewed`    | An onboarding step appears                                                              | `step`: `welcome`, `brain`, `about`, `email`, `telegram`, `open_source`                                                                                                                                                            |
| `otto_onboarding_completed`      | The server saves the first completed onboarding                                         | None                                                                                                                                                                                                                               |
| `otto_settings_viewed`           | A settings tab appears                                                                  | `tab`: `general`, `profile`, `appearance`, `preferences`, `models`, `memory`, `trust`                                                                                                                                              |
| `otto_settings_updated`          | A settings change succeeds                                                              | `section`: `account`, `preferences`, `connections`, `channels`, `models`; `operation`: `update`, `connect_started`, `disconnect`                                                                                                   |
| `otto_chat_message_sent`         | The server accepts a message from the UI                                                | `has_attachments`, `is_reply`                                                                                                                                                                                                      |
| `otto_chat_stop_requested`       | You select stop                                                                         | None                                                                                                                                                                                                                               |
| `otto_chat_stopped`              | The server accepts a stop                                                               | None                                                                                                                                                                                                                               |
| `otto_conversation_reset`        | The server finishes a conversation reset                                                | None                                                                                                                                                                                                                               |
| `otto_turn_started`              | A queued turn starts                                                                    | `source`: `user`, `schedule`, `event`, `resume`; `channel`: `web`, `telegram`, `whatsapp`, `other`; `background`                                                                                                                   |
| `otto_turn_completed`            | A turn finishes or exits                                                                | Turn properties plus `outcome`: `succeeded`, `waiting_credentials`, `waiting_user`, `failed`, `cancelled`, `interrupted`; `duration_ms`, `queue_duration_ms`; `waiting_reason`: `question`, `approval`, `credentials` when waiting |
| `otto_schedule_changed`          | A schedule change commits, from the UI or Otto                                          | `operation`: `create`, `update`, `delete`; `schedule_kind`: `once`, `recurring`; bounded `cadence`                                                                                                                                 |
| `otto_connection_changed`        | An instrumented connection starts, succeeds, fails or is removed                        | Reviewed app name or `custom`, public service `domain` when available, `connection_method`, `status`, bounded `failure_reason`                                                                                                     |
| `otto_service_used`              | A managed app, HTTP, MCP or CLI operation finishes                                      | App, public service domain when available, connection method, outcome, `duration_ms`; no arguments, action names or results                                                                                                        |
| `otto_vault_changed`             | A Vault item is actually created, changed or removed                                    | `item_type`: `login`, `card`; `operation`; `source` when known; normalized public `domain` for logins. No values, labels, account names or card details                                                                            |
| `otto_task_started`              | The post-turn analyzer identifies a new request                                         | Opaque `task_id`, short `task_type`, `task_action`, `task_subject`, bounded `task_activities`, originating `source` and `channel`                                                                                                  |
| `otto_task_linked`               | An analyzed turn is associated with a task                                              | Task properties, including originating `source` and `channel`; the common `run_id` links its service activity                                                                                                                      |
| `otto_task_updated`              | An identified task progresses                                                           | Task properties, `outcome`: `active`, `waiting`, `completed`, `failed`, `cancelled`; `completion_evidence`, `elapsed_ms`, `turn_count`                                                                                             |
| `otto_frustration_signal`        | The analyzer identifies an explicit complaint or repeated unresolved correction/request | Bounded `signal`, `reason`, `task_type` and `channel`                                                                                                                                                                              |
| `otto_task_analysis`             | A post-turn analysis finishes or is unavailable                                         | `source`, `outcome`: `analyzed`, `unavailable`, `invalid`, `failed`; `task_count` for analyzed turns                                                                                                                               |
| `otto_ui_error`                  | An instrumented UI action or render fails                                               | `area` and `action` from a fixed list, never the raw error                                                                                                                                                                         |
| `otto_desktop_setup_step_viewed` | A desktop setup step appears                                                            | `step`: `preferences`, `preparing`, `ready`, `error`                                                                                                                                                                               |
| `otto_desktop_setup_completed`   | First-time desktop setup completes                                                      | None                                                                                                                                                                                                                               |

A crash can leave a started turn without a completion event, and one turn can take several queued messages. Don't read turn counts as message counts.

## Request analysis and timing

With usage data enabled, a tool-free call to your selected model at its lowest supported reasoning effort analyzes a bounded portion of the finished conversation and previously associated requests. This uses your model account and its spending limit. Tool payloads, attachments, screenshots and Vault values are excluded. The model returns short generated labels and references to supplied messages; references stay in Otto's private database. No conversation excerpts, summaries or explanations go to PostHog. There is no separate taxonomy version or classification status property.

The model generates categories rather than choosing from a fixed catalog. Labels use English lowercase snake_case, at most three words and 48 characters. The instructions ask for a broad functional goal, a base-form action and a generic singular subject, with the same wording for equivalent requests. They exclude names, private topics, brands, domains, identifiers and quoted content. `unknown` remains available when a safe abstraction is unclear.

Format validation rejects URLs, email addresses, numbers, sentences and extra fields. It cannot prove that a syntactically valid label contains no personal name or sensitive topic; privacy also depends on the model following the abstraction instructions. Likewise, instructions cannot guarantee identical categories across models or releases. The eval harness measures repeated and paraphrased requests to expose naming drift, separately from task lifecycle correctness. Label agreement is not proof of semantic accuracy.

Existing labels are supplied with known tasks for reuse on continuations. Associations can span turns and restarts within the same session. A new consent period or conversation reset prevents linking back to previous requests. Analysis is asynchronous, has a bounded queue and does not retry a failed model request. A crash can miss an analysis; these measurements are not an exhaustive record of every request.

For example, `communication` can split into `summarize` / `email`, `draft` / `email`, and `send` / `message`. Creating a recurring reminder is `schedule` / `automation`; its later run uses the actual requested action and subject. Unknown dimensions remain visible. App and domain labels come from actual connection or service events, not from model guesses.

One goal can contain several requested activities. For example, finding records, totaling them, and emailing the total stays one task, with one outcome and elapsed time. `task_action` and `task_subject` describe its primary goal. `task_activities` stores up to eight unique `action:subject` pairs, such as `find:document`, `analyze:document`, and `send:email`. Only requested components qualify; the model must not invent intermediate tool steps.

Activities accumulate as that goal is clarified across turns. The primary pair is kept first; older known activities precede newly identified ones when the eight-entry cap is reached. Independent requested results get separate task IDs. Completed means the whole goal is inferred complete, not that one component finished. No per-activity outcome, duration, order or service attribution is claimed.

To count tasks requesting an activity, take the latest snapshot per owner and task in the selected period, expand the activity list, and count distinct tasks. One task can appear under several activities, so these counts must not be added to calculate total tasks. The bounded analysis can miss components; it is not a complete workflow trace.

The shared `run_id` connects a turn's service attempts, timing, frustration signals and inferred tasks. It covers approved actions and delegated work within that turn; parallel turns get different IDs. External connection callbacks and UI changes have no run ID unless they happen within the turn. Revocation invalidates the whole run, including work that finishes after sharing is turned back on.

Count each service attempt once. Attribute its category only when the run has one inferred task; show multiple-task, no-task and unavailable-analysis coverage separately. A link means the service was used in the same turn, not that it caused a task's failure. Repeated completion can add a link and newly requested activities without another completion or a longer completion time. Join on both the pseudonymous owner and `run_id`.

Completion is **inferred**, not independently verified delivery. A successful runtime turn does not establish that the user's goal was achieved. Corrections can reopen a task; no reply does not mean cancellation. Frustration describes an interaction, not a person's mood or personality. It requires an explicit complaint or repeated unresolved request/correction; routine edits and negative text quoted for a task should not qualify. Model classification can still be wrong and needs evaluation before treating it as a dependable success measure.

`elapsed_ms` runs from the first associated request to the observed turn finish, including queueing and time between turns. `duration_ms` on turn completion measures that execution segment, excluding the classifier call. `queue_duration_ms` measures the queued turn's wait to execute. Scheduled-run timing begins with that run's queued request, not when the schedule was created. A turn that pauses includes the runtime's bounded `waiting_reason`: `question`, `approval` or `credentials`. This is observed execution state, not an inferred blocker. These timings do not yet separate active work, user waiting and provider latency within a task. Compare percentiles by task category, source and app version, and show unfinished requests alongside completed ones to avoid hiding slow or failed work.

For example, a request to summarize email can produce `task_type=communication`, `task_action=summarize`, `task_subject=email`, `outcome=completed`, `completion_evidence=inferred`, `elapsed_ms=42000`. A later explicit complaint can produce `signal=explicit_complaint`, `reason=output_quality`. Neither event contains the request or complaint text.

## Connections and consent

Connection and Vault login domains identify public services: `team.example.com/private?token=...` becomes `example.com`. Paths, queries, account subdomains, local hosts and IP addresses are omitted. Managed apps use a reviewed service mapping; unknown apps use `custom`. CLI install links are not treated as service domains. Cards have no associated website domain. Connection and Vault events describe actual changes, not a request returning HTTP 200. Browser session connections are covered; service-use events do not enumerate every browser visit or arbitrary shell network call.

`connected` means an access path was durably saved; saved CLI credentials do not prove a command works. A connection supporting both HTTP and MCP emits one event per method. `otto_service_used` success means that the instrumented provider call returned successfully, not that the user's task succeeded. Background Gmail polling, verification-mail lookup and writing-style reads are outside that metric.

Opt-out cancels pending analysis and drops unsent events and recordings. Hosted server events pass through the authenticated gateway, which checks the current stored preference and consent period again before dispatch. Turning sharing back on cannot revive queued server events or task associations from an earlier consent period. A failed hosted consent sync is reported instead of acknowledging that every client has updated. Browser tabs revoke capture when notified of a preference change and refresh their session. A local opt-out stays latched until an explicit opt-in in that tab; a delayed peer opt-in cannot clear it. This cannot recall an event already transmitted or instantly stop another device before its session refreshes. Historical data in PostHog is not deleted by the switch.

These are pseudonymous, opt-in measurements. Installation/account IDs and service domains are not anonymous, and opted-in users may not represent the whole user base.

## What recordings show

Recordings show navigation, layout, controls, scrolling and clicks, with private content removed.

- **Masked:** all input values and all text, except product labels marked as public.
- **Blocked:** chat messages, credential and model-key forms, Vault values, the remote browser view, images, media, iframes and canvases.
- **Replaced:** every URL becomes a fixed `https://otto.invalid` route, without query strings, fragments or external destinations.
- **Never collected:** console output, request headers and bodies, network payloads, autocapture, automatic exceptions, feature-flag events and person profiles.

Capture failures never interrupt Otto. Model keys and PostHog settings never enter the workspace.

## Add UI without leaking content

- Content is masked by default. Keep it that way.
- Put `data-analytics-public` only around static product labels, never around a container that can hold user content.
- Put `data-analytics-private` on a subtree to block it from recordings.
- Extend the existing privacy regression tests when you add a recording surface or change these rules.

## Validate changes

Run the normal checks. The tests use synthetic data and intercepted transports, and never call PostHog.

```sh title="Terminal"
pnpm run check
pnpm run test:integration
pnpm run build
```

After a desktop UI build, check the real Electron renderer and recorder:

```sh title="Terminal"
node desktop/scripts/check-analytics.mjs
```

For a manual web walkthrough, run `pnpm exec tsx scripts/analytics-fixture.ts` and open `http://127.0.0.1:4358`. It uses a synthetic token and a local collector, and writes captured batches to `.local/analytics-fixture.json`. None of these checks prove that live events reach PostHog.

## Related resources

- [Configuration reference](/deploy/configuration/)
- [Hosted on Cloudflare](/deploy/cloudflare/)
- [Your data and privacy](/trust/privacy/)
- [Desktop app internals](/deploy/desktop-app/)
