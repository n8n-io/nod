---
title: Change analytics
description: Add, change or remove a product analytics event, keep session recordings private, and update the PostHog dashboards in the same change.
sidebar:
  order: 6
---

This page explains how to add, change or remove a product analytics event in Nod, and what else must change with it. It's written for contributors and coding agents.

What Nod sends and when is listed in [Analytics and recordings](/deploy/analytics/). That page is the contract with users. Update it in the same change as the code.

## The rules every event follows

- **Opt-in only.** Never call PostHog directly. Server events go through `capture` in [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts), UI events through `captureAnalytics` in [`src/web/lib/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics.ts). Both drop the event unless the deployment and the owner allow it.
- **No content.** Never send text the owner or Nod wrote, tool arguments or results, names, email addresses, account names, Nod's own owner, thread, turn or message IDs, URLs, paths or raw error text. The random `task_id` and `run_id` made only for analytics are allowed.
- **Bounded values only.** Use enums, booleans, non-negative integers, durations in milliseconds and normalized public domains from `analyticsDomain`. A free string is a leak waiting to happen.
- **Describe kinds, not instances.** Send `tool: 'browser'`, not the page Nod opened. Send `provider: 'compatible'` and `model: 'custom'`, not the name of a server the owner runs.
- **Count actual changes.** Fire after the change commits or the server answers 2xx, not when a button is clicked "to save".
- **Name events `nod_<noun>_<past verb>`**, such as `nod_tool_used`. Properties are `snake_case`. Reuse existing property names (`source`, `channel`, `outcome`, `operation`, `duration_ms`) with the same meaning.

## Add a server event

1. Add the event to the `analyticsEvent` union in [`src/server/analytics-events.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics-events.ts). Use `.strict()` objects and bounded types, like the events around it. The server drops the whole event if it has an unknown property or a value the schema doesn't allow.
2. Capture it where the change commits, with the owner's `CaptureAnalytics` (`analytics.forOwner(ownerId)`), passed in through [`src/server/composition.ts`](https://github.com/n8n-io/nod/blob/main/src/server/composition.ts).
3. For an event that only marks a successful API call, add the route to `analyticsRoutes` in `src/server/analytics.ts` instead. A test checks that every route in that map is registered, so a renamed route fails the tests.
4. Events captured inside a turn get the turn's `run_id` automatically, and a web turn's events get its recording `$session_id`. Don't pass Nod's own turn, session or message IDs.

## Add a UI event

1. Add the event to the `AnalyticsEvents` type and to the `eventProperties` allowlist in `src/web/lib/analytics.ts`. `sanitizeEvent` strips any property or value that isn't in the allowlist. For a list of enum values, allow `{ items: [...] }`; `sanitizeEvent` keeps only allowed, unique items.
2. Call `captureAnalytics(event, properties)`. In an async callback that can outlive the session, take `const capture = analyticsForCurrentSession()` first and call `capture` later.
3. Don't name a property `surface` or `route`. `sanitizeEvent` sets those itself.
4. Nothing is sent before the owner opts in, so an event fired before consent is lost. Onboarding asks for consent in the introduction, before connecting a model. The welcome screen and introduction aren't reported later.
5. For a new page, add its path to `routes` in [`src/web/lib/analytics-privacy.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics-privacy.ts). Map paths with IDs to one route, like `/credentials/:id` to `/credentials`. Unknown paths report `/not-found`.

## Count observed work

Use server and app events for tool use, model cost, turn timing and delivery. Keep their stated limits. A finished turn does not prove that the complete requested job is done.

Do not add a model call to infer analytics labels from private conversations. Older task and frustration events are historical data. Keep dashboard descriptions clear about their date range and limitations.

## Keep recordings private

Recordings mask all text and inputs by default and block the selectors listed in `blocked` in `src/web/lib/analytics-privacy.ts`.

- A new surface that shows content from the owner, Nod, an app or a website must be blocked. Add its class to `blocked`, or put `data-analytics-private` on its root.
- Put `data-analytics-public` only around static product labels. Never wrap a value that can come from the owner, a server or an error message, such as a hostname or a provider error.

## Change or remove an event

| Change                                                    | Do this                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Add an event, an optional property or a new enum value    | Keep `analytics_schema`. Dashboards keep working.                                                         |
| Rename an event or property, or change what a value means | Bump `schemaVersion` in `src/shared/analytics.ts`, such as `nod_v3` to `nod_v4`, and update every insight |
| Remove an event or property                               | Delete it from the schema and code, then remove or fix the insights that use it                           |

Prefer deleting an event nobody reads to keeping it "just in case". Dead events cost a schema entry, a docs row and a tile.

## Update the dashboards

The PostHog project is the Nod team's EU project. There are four dashboards: **Nod · Overview**, **Nod · Activation**, **Nod · Tasks & quality** and **Nod · Models, apps & websites**. Each tile is named after the question it answers, such as "Are tasks getting done?", and each dashboard has at most eight tiles. Each starts with a text tile whose agent context lists the events it uses.

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
A test can't prove an event carries no private data. Read every property you send and ask: could this value ever come from the owner, Nod, an app or a website?
:::

## Related resources

- [Contribute to Nod](/contribute/)
- [Analytics and recordings](/deploy/analytics/)
- [Your data and privacy](/trust/privacy/)
- [Checks and tests](/contribute/checks-and-tests/)
