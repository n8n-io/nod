# Product analytics and recordings

Otto uses PostHog EU project `231804` for explicit product events and masked session recordings across the web app, hosted app and desktop setup. The public project token and ingestion host live in [`src/shared/analytics.ts`](../src/shared/analytics.ts); they reuse the token from `n8n-io/otto-grokbot-experiment`'s `.env.example`. This token accepts events; it is not a personal API key or an administrative credential.

The [production dashboard](https://eu.posthog.com/project/231804/dashboard/998342) separates this product from the previous experiment using `analytics_schema=otto_v2` and `environment=production`. It covers active chat use by platform, onboarding, feature and settings use, turns by channel and outcome, weekly retention, UI failures and desktop setup. The previous starter and experiment dashboards and their exclusive insights were removed through PostHog's recoverable deletion. Local validation does not establish that production events or recordings reached PostHog.

On 2026-10-05, permanent deletion was submitted for all 134 legacy profiles with their associated events and recordings, and the remaining recordings were deleted directly. An unfiltered SQL check returned zero profiles, zero recordings without a deletion marker and 5,789 historical events. The all-time replay list was empty. PostHog schedules associated event erasure during non-peak hours; complete event and storage erasure remains unverified. The project, public key and production dashboard are retained.

## Identity and environments

| Runtime               | Identity                                                                                            | Default collection                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local web             | `local:<installation UUID>` stored in `<OTTO_DATA_ROOT>/analytics-id`                               | Enabled with `npm start`; disabled with `npm run dev`                           |
| Desktop               | `local:<installation UUID>` stored in the desktop profile's `analytics-id` and passed to its server | Enabled for packaged apps; disabled for unpackaged development                  |
| Hosted                | `hosted:<authenticated owner UUID>` derived by the gateway and tenant server                        | Enabled for `OTTO_ENVIRONMENT=production`; disabled for development and staging |
| Hosted before sign-in | Temporary browser identity held in memory                                                           | Follows hosted collection settings                                              |

Local UUID creation is atomic and the identity survives restarts. The desktop setup renderer, main web renderer and server use the same installation identity. Hosted identity comes from the authenticated account, never a client-supplied owner or telemetry header. Browser recording stops and its identity resets when the account changes or signs out. Person-profile processing is disabled; names and email addresses are not sent.

Distinct-user metrics count installations or hosted accounts, not exact people. Multiple local installations count separately, and a shared installation counts as one. Anonymous visits are not merged with signed-in accounts. Server events share `distinctId` with the UI but carry no browser `$session_id`, so correlate them by owner and time rather than assuming they belong to one recording.

For self-hosted use, `npm start` builds the app and starts its server in production mode with analytics enabled by default. `npm run dev` runs with automatic reload and collection disabled by default. Enabling collection in development alone does not put those events on the production dashboard.

Set `OTTO_ANALYTICS_ENABLED=false` to disable both recordings and server events. `true` enables collection explicitly, including development. `OTTO_ANALYTICS_ENVIRONMENT=development` or `production` optionally changes the event label without changing the enabled setting. Desktop labels follow whether the app is packaged. Restart local processes after changing their environment; hosted operators put these settings in `GATEWAY_ENV` and apply a release rollout. The gateway passes the controls to each tenant. No PostHog configuration or provider key enters the agent workspace.

## Event contract

Every event includes `analytics_schema`, `deployment` (`local` or `hosted`) and `environment`. UI events and recordings also include `surface` (`web` or `desktop`) and a normalized `route`. Server events include `capture_source=server`. Application event properties are finite enums or booleans, apart from the numeric turn duration. Arbitrary properties and event names are rejected.

UI events retain the SDK's recording status, trigger states, boolean recorder diagnostics and buffer/upload sizes so PostHog can show recording links and explain missing capture. These fields accept only known states, booleans or nonnegative safe integers; arbitrary diagnostic strings and objects are rejected. Recordings use the masked hostname `otto.invalid`, so filter by `deployment` and `surface` rather than an installation's hostname.

| Event                            | When recorded                                            | Additional properties                                                                                                                   |
| -------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `$pageview`                      | A normalized application route becomes visible           | `route`                                                                                                                                 |
| `$snapshot`                      | Masked full or incremental DOM recording                 | PostHog replay metadata and masked snapshot data                                                                                        |
| `otto_onboarding_step_viewed`    | Model or app connection onboarding step appears          | `step`: `models`, `apps`                                                                                                                |
| `otto_onboarding_completed`      | The server persists the first completed onboarding state | None                                                                                                                                    |
| `otto_settings_viewed`           | A settings tab appears                                   | `tab`: `general`, `profile`, `appearance`, `preferences`, `models`                                                                      |
| `otto_settings_updated`          | A supported settings mutation succeeds                   | `section`: `account`, `preferences`, `connections`, `channels`, `models`; `operation`: `update`, `connect_started`, `disconnect`        |
| `otto_chat_message_sent`         | An ordinary UI message is accepted by the server         | `has_attachments`, `is_reply`; secure verification messages excluded                                                                    |
| `otto_chat_stop_requested`       | The user requests stop in the UI                         | None                                                                                                                                    |
| `otto_chat_stopped`              | The server accepts a stop request                        | None                                                                                                                                    |
| `otto_conversation_reset`        | The server completes a conversation reset                | None                                                                                                                                    |
| `otto_turn_started`              | A queued turn begins execution                           | `source`: `user`, `schedule`, `event`, `resume`; `channel`: `web`, `telegram`, `whatsapp`, `other`; `background`                        |
| `otto_turn_completed`            | An executing turn finishes or exits                      | Turn properties plus `outcome`: `succeeded`, `waiting_credentials`, `waiting_user`, `failed`, `cancelled`, `interrupted`; `duration_ms` |
| `otto_schedule_changed`          | A schedule mutation commits, from the UI or the agent    | `operation`: `create`, `update`, `delete`                                                                                               |
| `otto_ui_error`                  | An instrumented UI action or render fails                | Bounded `area` and `action`; no raw error                                                                                               |
| `otto_desktop_setup_step_viewed` | A native setup step appears                              | `step`: `preferences`, `preparing`, `ready`, `error`                                                                                    |
| `otto_desktop_setup_completed`   | First-time native setup completes                        | None                                                                                                                                    |

`connect_started` counts successful start or reopen actions, including returning to a pending sign-in flow. It does not count unique OAuth attempts or completed connections. Settings events cover the instrumented HTTP mutations; schedule events are emitted from the service after its transaction commits. Turn events also cover Telegram, WhatsApp and background work. Filter `source=user` for user-requested turns; the automatic welcome uses `source=event` and `background=true`. A process crash can leave a started turn without a completion event, and a turn may consume several queued messages. Do not interpret turn counts as exact message counts.

## Recording boundaries

Recordings show navigation, layout, controls, scrolling and interactions. Only explicitly marked product labels retain readable text. All input values and other text are masked. Chat message bodies, credential forms, model-key forms, Vault values, Inspector content, remote-browser views, images, media, iframes and canvases are blocked. This is a view of the product flow with private content excluded, not an unredacted screen recording.

URLs are replaced with fixed `https://otto.invalid` routes; query strings, fragments, credential-request IDs and external destinations are excluded. Arbitrary DOM attributes, console output, request headers, request bodies, network payloads, autocapture, automatic exceptions, feature-flag events and person profiles are not collected. Browser recording code is bundled with the app. The native setup CSP permits the EU ingestion and configuration hosts. Capture and shutdown failures must not interrupt product operations.

When adding UI, keep private content masked by default. Use `data-analytics-public` only around static product labels, never around a container that can include user content. Use `data-analytics-private` to block sensitive subtrees. Extend the existing privacy regression tests when adding a recording surface or changing these rules. Operators should describe analytics and masked recordings in their public privacy notice.

## Validation

Run the normal checks and isolated integration suite:

```sh
npm run check
npm run test:integration
npm run build
```

The existing account, thread and Vault tests exercise owner separation, rejected identity overrides, opaque installation IDs, private-property rejection, durable turn outcomes, real SDK configuration and snapshot uploads, replay diagnostics, recorder masking, account switching, disabling collection and telemetry failure isolation. They use disposable data and injected or intercepted analytics transports, with no live model or PostHog calls. Cloudflare tests additionally verify that startup preserves opt-out and keeps staging traffic separate despite production Node mode; run the [deployment checks and dry runs](../deployment/cloudflare/README.md#checks) for those changes.

After building the desktop UI with the [desktop build](../desktop/README.md), exercise the real Electron renderer and recorder:

```sh
node desktop/scripts/check-analytics.mjs
```

This check intercepts every request locally and checks full and incremental snapshots, setup events, masking and disabled collection. It does not prove live PostHog ingestion.

For a manual web walkthrough:

```sh
npx tsx scripts/analytics-fixture.ts
```

Open `http://127.0.0.1:4358`, complete the synthetic onboarding, navigate settings and send a synthetic chat message. The fixture substitutes a synthetic token and local collector; captured batches are written to the ignored `.local/analytics-fixture.json`. Check the emitted events and decoded snapshots for the expected paths and absence of the synthetic private markers; decompress any nested snapshot data before searching it. The fixture's `/__fixture__/summary` route performs that recursive decoding for its privacy check. Keep this evidence separate from authenticated production ingestion and replay verification.
