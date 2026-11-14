---
title: Mobile setup and notification settings
description: Set up the paired Nod server from Flutter and understand the gates for phone alerts and incoming links.
---

The Flutter setup screen can finish the paired server's onboarding without a browser preflight. Phone push notifications are not available yet.

Pairing still uses **Server address**, **Access token**, and **Connect to Nod**. Use the existing private token field, never a token in a link, chat, command, or screenshot. HTTPS and certificate checks stay unchanged. See [Mobile client evaluation](/contribute/mobile-evaluation/) for device networking requirements.

## Set up the paired server

After pairing, the app reads the authenticated session. A server with unfinished onboarding opens setup before chat. An already configured server opens chat. Finishing setup refreshes the session before entering the conversation.

1. Review **Share usage data** and select **Get started**. Nod starts preparing its workspace and browser on the paired server. Reading connected apps in the background uses your model and counts as model usage.
2. Select **Connect apps** to connect Gmail, Outlook, or another app through the existing account manager. You can skip this step.
3. Fill in **About you**, or select **Skip for now**. Multiple roles and tasks are allowed. Business roles show who the help is for. Personal scope hides company size. Typed answers are capped at 200 characters each. Never include secrets.
4. Connect a model if none works. **Models** opens the same private provider configuration as Settings. Keys go directly to the paired server, never through chat.
5. Select **Share traces** or **Not now** where traces are available. This saves an explicit choice. Traces include conversations and what Nod reads and does. They are pseudonymised, not anonymous, retained for 14 days, and never used to train AI.
6. Optionally enter an email for updates and tick the separate consent box. **Start chatting** submits it only when usage sharing and the server's email capability are available. **Continue without email** skips submission.

About you uses the server's existing profile route. With memory on, it saves one stated note. With usage sharing on, only fixed choices reach the installation's analytics profile. Typed answers stay out of analytics. An optional updates email requires consent to n8n GmbH linking it to usage data and sending updates about Nod and other n8n products. You can withdraw through each email's unsubscribe link or privacy@n8n.io.

After About you, confirmed email connections can start the existing first-idea discovery. This does not block setup. Discovery failure does not mean Nod found nothing. Preparation and completion failures keep setup open for an explicit retry. The server checks its own completion prerequisites before saving completion.

Returning from an app or model sign-in refreshes server state. Foregrounding refreshes it too. Unsaved answers live only in this screen's memory, not device storage. Restarting setup keeps saved server connections and preferences, but starts the optional questions again. An observed owner change clears unsaved answers before any new save.

## Change preparation and quiet hours

Open **Notifications** from the menu to change existing server preferences:

- **Pause preparation** stops background preparation, Gmail inbox polling, and planned checks of tasks Nod started. Your own tasks and schedules keep running.
- **Quiet hours**, **From**, and **Until** use the server preference time zone, not the phone clock. Enter 24-hour `HH:mm` times. Equal times mean no quiet interval. An empty time zone uses the server fallback, UTC.
- **Notification rule** is your standing instruction for background work. Nod reads connected apps even with no rule. Outside actions still pass Trust. A notification rule does not authorize changes to Nod's own settings.

Quiet hours hold nudges until they end, except high-impact findings with strong evidence and an earlier deadline. Snooze is specific to a finding: reply to its nudge in chat, such as “Remind me tonight”. There is no invented global snooze preference.

These settings do not request operating-system permission or enable phone alerts. Existing web and desktop notification choices remain unchanged.

## Incoming links and platform gates

`NodMobileRoute.parse` accepts the established desktop `nod://open/<path>` syntax after authentication. Known paths match the shared app page list: chat, `/tasks`, `/apps`, `/channels`, `/usage`, `/vault`, `/settings`, and its notifications, models, voice, memory, and privacy pages. `/prepared/<uuid>` opens a prepared result. For example, `nod://open/settings/models` opens model settings. These links select a page, never pair an account or approve an action.

Relative known paths and absolute URLs on the exact paired origin also work. Existing private sign-in and payment request links and `/browser` remain limited to this authenticated same-origin path, not the `nod` scheme. Private sign-in IDs use the existing server request-token format, not a new pairing credential. Never generate links containing the connection access token.

The parser rejects other origins, embedded credentials, queries, fragments, encoded paths, traversal, control characters, and unknown routes. Parsing is not authorization. The caller must use the current authenticated transport, fetch the exact referenced request or result, and let the server reject removed, expired, replaced, or other-owner data. `/browser` must resolve the currently pending server handoff, never assume a turn from the link. No task-detail URL is invented.

`NodMobileLinkSource` supplies an `initialUri()` and a `uris` stream. `NodPlatformMobileLinkSource` uses `app_links` to receive platform events. It checks the raw text before parsing, so URI normalization cannot hide traversal or encoded paths. It does not authenticate, queue a destination, navigate, or submit anything. The shared shell owns those decisions and handles stream errors and cancellation.

The app dispatches links only with a current authenticated pairing. A startup URI opens only after restoring the same stored pairing. Launching unpaired drops that destination instead of deferring it to a new pairing. Disconnect stops dispatch and closes private routes. Finishing onboarding opens chat, not a deferred link.

The plugin can replay its startup URI as the first stream event. The shell reads it before subscribing, suppresses that first replay even after a new pairing, and deduplicates adjacent repeated delivery. The source itself has no owner identity and makes no authorization decision.

The iOS URL scheme registration accepts `nod`; its parser enforces the `open` host and exact path. Android registers only the `nod` scheme and `open` host. Flutter's built-in deep-link routing is disabled on both platforms so the plugin, rather than a second router, receives these links. This is custom-scheme registration, not iOS Universal Links or verified Android HTTPS App Links. Other apps can claim a custom scheme too, so links never carry pairing credentials.

Synthetic bridge and shell checks verify exact routing, authentication, startup replay, and logout fencing. They do not prove cold-start, foreground, or background URL delivery from the operating system. Device URL delivery remains a separate runtime gate. The optional [foreground check](/contribute/mobile-validation/) must reach the authenticated page after any iOS **Open in “Nod”?** prompt is accepted; registering a scheme or a successful `simctl` command alone doesn't prove delivery.

:::caution[Remote push is blocked]
There is no APNs or FCM device registration or delivery infrastructure in this client. Push needs an owner-approved architecture and credentials decision, followed by platform permission, delivery, and device checks. No permission toggle pretends that this exists.
:::

## Check the package

From `clients/flutter`, run:

```sh
flutter pub get
flutter test test/api/onboarding_repository_test.dart
flutter analyze lib/core/onboarding.dart lib/core/mobile_links.dart lib/api/onboarding_repository.dart lib/features/onboarding test/api/onboarding_repository_test.dart
```

These are synthetic HTTP-contract and widget checks. They cover authentication headers, consent gates, optional steps, model prerequisites, preparation failure, single-flight completion, owner-change clearing, pause writes, foreground refresh, unsafe route rejection, and plugin channel delivery, errors, and cancellation. They do not prove full server database isolation, native URL delivery, phone permissions, push delivery, live models, or real sign-ins.

## Related resources

- [Mobile client evaluation](/contribute/mobile-evaluation/)
- [Your first conversation](/get-started/first-conversation/)
- [Mobile settings](/contribute/mobile-settings/)
- [Mobile connections](/contribute/mobile-connections/)
- [Mobile private entry](/contribute/mobile-private-entry/)
- [Nudges](/use/nudges/)
