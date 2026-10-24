---
title: Change analytics
description: Add, change or remove a product analytics event, keep session recordings private, and update the PostHog dashboards in the same change.
sidebar:
  order: 6
---

This page explains how to add, change or remove a product analytics event in nod, and what else must change with it. It's written for contributors and coding agents.

What nod sends and when is listed in [Analytics and recordings](/deploy/analytics/). That page is the contract with users. Update it in the same change as the code.

## The rules every event follows

- **Opt-in only.** Never call PostHog directly. Server events go through `capture` in [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts), UI events through `captureAnalytics` in [`src/web/lib/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics.ts). Both drop the event unless the deployment and the owner allow it.
- **No content.** Never send text the owner or nod wrote, tool arguments or results, names, email addresses, account names, nod's own owner, thread, turn or message IDs, URLs, paths or raw error text. The random `task_id` and `run_id` made only for analytics are allowed.
- **Bounded values only.** Use enums, booleans, non-negative integers, durations in milliseconds and normalized public domains from `analyticsDomain`. A free string is a leak waiting to happen.
- **Describe kinds, not instances.** Send `tool: 'browser'`, not the page nod opened. Send `provider: 'compatible'` and `model: 'custom'`, not the name of a server the owner runs.
- **Count actual changes.** Fire after the change commits or the server answers 2xx, not when a button is clicked "to save".
- **Name events `nod_<noun>_<past verb>`**, such as `nod_tool_used`. Properties are `snake_case`. Reuse existing property names (`source`, `channel`, `outcome`, `operation`, `duration_ms`) with the same meaning.

## Add a server event

1. Add the event to the `analyticsEvent` union in [`src/server/analytics-events.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics-events.ts). Use `.strict()` objects and bounded types, like the events around it. The server drops the whole event if it has an unknown property or a value the schema doesn't allow.
2. Capture it where the change commits, with the owner's `CaptureAnalytics` (`analytics.forOwner(ownerId)`), passed in through [`src/server/composition.ts`](https://github.com/n8n-io/nod/blob/main/src/server/composition.ts).
3. For an event that only marks a successful API call, add the route to `analyticsRoutes` in `src/server/analytics.ts` instead. A test checks that every route in that map is registered, so a renamed route fails the tests.
4. Events captured inside a turn get the turn's `run_id` automatically, and a web turn's events get its recording `$session_id`. Don't pass nod's own turn, session or message IDs.

## Add a UI event

1. Add the event to the `AnalyticsEvents` type and to the `eventProperties` allowlist in `src/web/lib/analytics.ts`. `sanitizeEvent` strips any property or value that isn't in the allowlist. For a list of enum values, allow `{ items: [...] }`; `sanitizeEvent` keeps only allowed, unique items.
2. Call `captureAnalytics(event, properties)`. In an async callback that can outlive the session, take `const capture = analyticsForCurrentSession()` first and call `capture` later.
3. Don't name a property `surface` or `route`. `sanitizeEvent` sets those itself.
4. Nothing is sent before the owner opts in, so an event fired before consent is lost. Onboarding asks for consent in the introduction, before connecting a model. The welcome screen and introduction aren't reported later.
5. For a new page, add its path to `routes` in [`src/web/lib/analytics-privacy.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics-privacy.ts). Map paths with IDs to one route, like `/credentials/:id` to `/credentials`. Unknown paths report `/not-found`.

## Count real jobs

A real job is the product's main measure: the latest `nod_task_updated` of an owner-started task (`source` `user` or `task`, `starter=false`) with `outcome=completed` and `completion_evidence=action_succeeded`. Only app actions, confirmed browser steps and payments set `action_succeeded`; nod's own settings, memory and schedules set `settings_changed` only when the turn had no successful app action, browser step or payment. Keep that split when you add a new kind of action. The full definition is in [Analytics and recordings](/deploy/analytics/#real-jobs).

## Evolve the task vocabulary

The task labels, `use_case`, `context` and `collaboration` values are one list each in [`src/server/analytics-events.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics-events.ts). The event schema and the classifier prompt in `src/server/conversation-analytics.ts` both read them, so a value exists in one place.

1. Watch `unknown_label_count` and `other_label_count` on `nod_task_analysis`. A rising share of `unknown`, `other` or `unclear` shows a gap.
2. Add a value only when it names a reusable category across many requests: an action, subject or task type, or for `use_case` a product need. Never add one for a single template, brand or private topic, and never add sensitive topics such as health, religion or politics.
3. Add one line to the prompt rules only when the value is easy to confuse with an existing one, such as `order` and `pay`.
4. Add a reference case in `evals/src/analytics.ts`, then run `pnpm --dir evals run check` and `pnpm --dir evals test`. Run the live analytics eval by hand to compare agreement before and after.

Renaming a value changes its meaning, so it needs a schema bump. Adding one doesn't.

## Keep recordings private

Recordings mask all text and inputs by default and block the selectors listed in `blocked` in `src/web/lib/analytics-privacy.ts`.

- A new surface that shows content from the owner, nod, an app or a website must be blocked. Add its class to `blocked`, or put `data-analytics-private` on its root.
- Put `data-analytics-public` only around static product labels. Never wrap a value that can come from the owner, a server or an error message, such as a hostname or a provider error.
- Extend the replay privacy test in `tests/vault.test.ts` when you add a blocked surface. It renders real components with synthetic private text and checks the recording.

## Change or remove an event

| Change                                                    | Do this                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Add an event, an optional property or a new enum value    | Keep `analytics_schema`. Dashboards keep working.                                                         |
| Rename an event or property, or change what a value means | Bump `schemaVersion` in `src/shared/analytics.ts`, such as `nod_v3` to `nod_v4`, and update every insight |
| Remove an event or property                               | Delete it from the schema and code, then remove or fix the insights that use it                           |

Prefer deleting an event nobody reads to keeping it "just in case". Dead events cost a schema entry, a docs row and a tile.

## Update the dashboards

The PostHog project is the nod team's EU project. There are four dashboards: **nod · Overview**, **nod · Activation**, **nod · Tasks & quality** and **nod · Models, apps & websites**. Each tile is named after the question it answers, such as "Are tasks getting done?", and each dashboard has at most eight tiles. Each starts with a text tile whose agent context lists the events it uses.

Add a tile only when it answers a question the team reads. If a new event doesn't change an answer, leave the dashboards alone.

Every insight:

- filters `analytics_schema` to the current version and `environment` to `production`, and filters out test accounts;
- is tagged with the schema version, such as `nod_v3`;
- has a description that says what it counts and its main caveat, such as "installations, not people" or "inferred, not verified".

When you bump the schema, update the filters and tags on every insight and remove dashboards for the old version. Use the PostHog MCP server (`dashboard-*` and `insight-*` tools) or the PostHog app.

## Check your change

1. Run the focused tests for the files you touched, then `pnpm run check`, `pnpm run test:integration` and `pnpm run build`.
2. For a UI change, run `pnpm exec tsx scripts/analytics-fixture.ts` and open `http://127.0.0.1:4358`. Turn **Share usage data** on, use the feature, then open `http://127.0.0.1:4358/__fixture__/summary`. `privateDataLeaked` must stay `false`. Captured batches are in `.local/analytics-fixture.json`.
3. Tests and the fixture use intercepted transports and never call PostHog. They don't prove live delivery. After release, confirm the event arrives in PostHog with the expected properties.

:::caution
A test can't prove an event carries no private data. Read every property you send and ask: could this value ever come from the owner, nod, an app or a website?
:::

## Related resources

- [Contribute to nod](/contribute/)
- [Analytics and recordings](/deploy/analytics/)
- [Your data and privacy](/trust/privacy/)
- [Checks and tests](/contribute/checks-and-tests/)
