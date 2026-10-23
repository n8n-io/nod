---
title: Your data and privacy
description: Where nod keeps your data, what leaves your computer and to whom, and how to delete it.
sidebar:
  order: 11
---

This page explains where nod keeps your data, what leaves your computer and to whom, and how to delete it.

Desktop and source installs keep nod's database, workspace and browser on your computer. Requests go to your model and decision providers, and the apps you choose. Composio app requests and results pass through the configured connection service and Composio. The default service is hosted by n8n; source installs can [select another trusted service](/deploy/configuration/#apps-and-composio).

The desktop app checks n8n's update service for new versions, which sees your IP address, app version and platform. Feedback, usage analytics and conversation traces are optional. An operator can configure a different feedback collector; the feedback dialog names its recipient before you send.

## Where your data lives

|                              | Desktop app                                                                                                                      | From source                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| nod server                   | Your computer                                                                                                                    | Your computer                                  |
| Database, workspace, browser | A private virtual machine on your computer                                                                                       | Docker containers on your computer             |
| Data folder                  | `~/Library/Application Support/nod/` and `~/.nod-desktop/` on a Mac. `%APPDATA%\nod\` and the `nod-` WSL distribution on Windows | `.local/` (`NOD_DATA_ROOT`) and Docker volumes |
| Who can read it              | You                                                                                                                              | You                                            |

Unfinished setup interviews are encrypted in your installation’s private storage. Continuing saves your answers to memory and removes the draft text; **Change my answers** discards it without saving. An encrypted completion marker contains only a random interview identifier and expiry, so returning through setup does not save old answers again. Drafts and completion markers expire after 30 days and are discarded the next time nod reads them. A completed interview can remain in the current tab while you go back through setup; that temporary copy is shown only while its completion marker is current and is cleared when onboarding finishes.

For what nod stores and how long it keeps it, see the [Security review guide](/trust/security-review/#what-nod-stores).

## What leaves your computer

```mermaid
flowchart LR
  nod[nod on your computer]:::accent
  nod -- prompts and results --> model[Model and decision providers]
  nod -- app actions with nod's connection --> managed["Configured connection service"]
  managed --> apps[Composio and<br/>your apps]
  nod -- direct MCP actions --> mcp[Connected MCP services]
  nod -- your chats --> chat[Telegram, WhatsApp]
  nod -- browsing --> web[Websites]
  nod -- searches --> search[Web search]
  nod -- update checks and downloads --> n8n[n8n]:::muted
  nod -. opt-in analytics .-> n8n[n8n]:::muted
  nod -. opt-in traces .-> n8n[n8n]:::muted
  nod -. feedback you send .-> feedback[Configured feedback recipient]:::muted
```

| Goes to                                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model provider you choose             | Your conversation, tool results and screenshots. With Gmail connected: your text from recent sent emails for writing style, plus inbox subjects and snippets for first tasks. Desktop and personal web installs can instead use the latest-message text from up to 40 recent inbox conversations for a setup summary. When an action needs your yes, the proposed action with its arguments and details is also sent to write and check the question, plus the page’s visible text for a browser step. Without a decision service, your replies to confirmations are read here too, and so are the sender, subject and text of each email nod reads through your apps (up to 8,000 characters, the start and end of a longer one), to check whether it gives access to an account |
| Decision services                         | When one is set up (an OpenAI API or OpenRouter connection, or `TYPESAFE_API_KEY`), your replies to confirmations and the sender, subject and text of each email nod reads through your apps, each checked on its own, instead of your model provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Apps and services you connect             | The actions nod runs in them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Composio, if you connect apps through it  | Those app connections, the actions nod sends and files attached to them, in the connection service operator's project. An attached file is uploaded only when its action runs, never for an action you decline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Telegram and WhatsApp, if you set them up | The messages in those chats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Websites nod visits                       | Whatever nod browses, fills in or submits there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Linked websites                           | nod's server reads the start of each page linked in a reply and its preview image. Playing a video loads that site's player in your app, without the site's cookies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Exa, for web search                       | nod's search queries. With a ChatGPT plan, OpenAI runs the search instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| n8n                                       | Composio app requests and results when you use the default connection service. Desktop update checks and downloads, which show your IP address, app version and platform. Masked usage analytics and scrubbed conversation traces if you opt in, and feedback when using the default collector                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Your configured feedback recipient        | Feedback and attachments you choose to send, including an optional diagnostic report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Preview pages and images are fetched without your browser's cookies. After you select play, the embedded player receives nod's origin as its referrer and runs without the site's cookies, in storage that is discarded when it closes. nod checks that the player's address resolves to a public address when it prepares the preview, but those checks don't cover the player's later DNS answers, redirects or requests to other addresses.

OpenAI API connections use GPT Decisions at OpenAI. OpenRouter sends decision checks to TypeSafe. An optional `TYPESAFE_API_KEY` selects TypeSafe directly, regardless of your chat connection. See [Decision checks](/connect/models/#decision-checks) for routing and billing.

nod creates a random cryptographic identity for each installation and encrypts its private signing key with the installation's Vault key. On desktop, the operating system protects that Vault key. Source installs use a [configured or locally stored Vault key](/deploy/configuration/#vault). The connection service stores the public identity, admitted account references, usage counters and expiring connection state. It verifies signed requests and account ownership; knowing an identifier alone does not grant access.

You authorize each app, such as Gmail, with its provider. The Composio project key stays on the connection service. Your model keys stay encrypted on your installation. Provider keys never enter a prompt, nod's workspace or its browser.

When the selected chat model cannot read an attached image, nod can send the image and your current request to an image model on another connected service. It first checks the selected connection, then the other connected connections. It keeps your chat selection. The selected chat model receives the image description as untrusted data. No image request is sent if no connected image model is available.

Telegram TGS stickers are decoded and played locally in a sandbox with no network access. Static and video stickers use local artifact files. Contact previews do not fetch websites. A shared map loads from OpenStreetMap only after you select **View map**.

Incoming voice messages go to OpenAI when its API key is available, or to OpenRouter and the provider it routes to when only an OpenRouter key is available. This can differ from your chat provider. nod selects one service before sending the audio and does not switch services after a failed request. Text for a voice reply goes to OpenAI. Playback and waveform processing run in your browser without a model. The audio and transcript follow the same owned file and message rules as other channel content. See [Files and voice messages](/use/channels/#files-and-voice-messages).

The WhatsApp QR connection links nod as a device on the account you select. nod stores its device credentials and Signal keys encrypted on your installation. The QR code stays in the private setup panel. Session recordings exclude that panel. Disconnect removes the saved device keys. Group messages and other chats do not enter the nod conversation.

## Your own telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send model request metadata to your own OpenTelemetry collector. Export is off when the variable is empty.

The export includes provider and model names, request timing, status, token counts, and available cost. It includes custom model names. Requests from one turn share an ID that changes when nod restarts. Internal execution IDs, messages, tool content, keys, and raw errors are excluded.

This export is separate from the sharing switches in Settings. Your collector controls access, storage, and retention. See [OpenTelemetry configuration](/deploy/configuration/#opentelemetry) for setup and limits.

## Usage analytics

Usage analytics are off until you turn on **Share usage data** in the first onboarding step or in **Settings → General**. They record which screens you open, how you move through them, and product events such as a task starting or a setting changing.

The recipient is the nod team at n8n, through its EU PostHog project. This also applies to source installations. Operators can disable collection for everyone with `NOD_ANALYTICS_ENABLED=false`.

Analytics have no fields for raw messages, nod's replies, tool arguments or results, Vault values, card details, full page addresses, names or email addresses. Recordings block chat messages, attachments, task details, connected account names, credential-entry and model-key forms, the remote browser view and images. Events can include normalized public domains for connections, Vault logins and the websites nod visits, signs in to or buys from and the ones you open from a reply, the amount and currency of purchases, Vault item types, which kinds of tools nod used, when it asked for your yes and how you answered, model token counts and cost, task categories, inferred outcomes, timing and signs of friction. Your selected model analyzes bounded chat text using your model account. Only allowed generic labels can leave nod as task categories: type, action, subject, a use-case family, work or personal context, and how you worked with nod. Raw text and invented labels are rejected. No family names a sensitive topic such as health or religion, and the classifier is instructed to label those requests `other` or a generic family; the server doesn't check that choice. These classifications can still be wrong. Website domains can reveal what kind of sites you use, which is why analytics are opt-in. Events from a message you send in the app link to that session's masked recording. Measurements are associated with a pseudonymous installation ID. Turn off **Share usage data** in **Settings → General** to stop sending, and ask for past data to be deleted with **Send feedback**. See [Analytics](/deploy/analytics/#stop-sharing-or-delete-past-data) for the full list, limitations and deployment switch.

## Conversation traces

Conversation traces are off until you turn on **Share conversation traces** in **Settings**. While it's on, each request nod makes to your model is sent with the model's reply to the nod team at n8n, through n8n's nod Traces service to n8n's LangSmith project in the EU. Traces are deleted after 14 days, and n8n doesn't use them to train AI models.

Before a trace leaves your computer, nod removes known secrets, your name, email addresses, phone numbers, card numbers, IBANs, crypto wallets, common ID numbers, IP addresses, personal fields in app data and images. A trace carries no account or device identifier, its conversation ID changes every day and whenever nod restarts, and your saved memory is left out. Removal is automatic and can miss details written in other forms, such as another person's name in a sentence, so traces are pseudonymised, not anonymous. See [Conversation traces](/trust/conversation-traces/) for every layer, an example and where traces go.

## Feedback

The feedback dialog shows who receives your submission. The default is the nod team at n8n; an operator can set a different HTTPS collector. To help the team investigate, you can tick **Include diagnostic report** to add your recent chat, actions and their results. It's off by default. Select **Review** to read the report first. Before you see it, nod removes known secret values and the personal details it removes from [conversation traces](/trust/conversation-traces/#what-nod-removes-first), such as your name, email addresses, phone numbers and card numbers. Removal is automatic and can miss details written in other forms, such as another person's name in a sentence. From the desktop app, feedback also includes the app version and your platform. Feedback is a separate, deliberate submission and does not turn on usage analytics.

If nod can't read the history or prepare its privacy checks, it leaves conversation and action details out of the report. The dialog tells you before you send. You can still send that limited report, or continue without a report if preparation fails.

Operators can disable submission and status checks with `NOD_FEEDBACK_ENABLED=false`. See the [configuration reference](/deploy/configuration/#analytics-and-feedback) for custom collectors and operation without either upstream collector.

## What memory learns from

Memory notes come only from your own messages and the notes you add or import in **Settings → Memory**, never from nod's replies, tool results or web pages. nod also writes learned skills, the steps of a flow it did, from what it did and read; your model is told to replace names, contact details, account and order numbers, amounts and message content with placeholders, and nod removes known secrets and refuses card numbers, keys and links with logins before it saves one. When you connect Gmail, your model also reads your recent sent email and writes one short note on your writing style. During setup, it can also summarise the latest-message text from up to 40 recent inbox conversations to suggest first tasks. That summary is never saved to memory and is deleted once the cards are posted. When no summary is available, task suggestions use recent subjects and snippets instead. The model is told to leave out facts, names and quotes, and nod drops a note with an email address or link. See [Memory](/use/memory/).

## Delete your data

- **Memories.** Open **Settings → Memory**, select a note and choose **Forget**. This deletes the note and its earlier versions. You can also ask nod to forget something.
- **Vault items.** Open the item in **Vault** and delete it. For a saved browser session, select **Sign out**.
- **Apps.** Disconnect an app in **Apps**.
- **Everything.** In the desktop app, select **Remove all data** in **Settings → General**. nod deletes your profile and private computer from the folders above, then quits. From source, stop nod and delete its `NOD_DATA_ROOT` folder (`.local/` by default) and its Docker volumes. Uninstalling the app alone keeps your data. A service you signed in to through nod may still list nod as a connected app until you remove it there.

Disconnecting an app does not erase the connection service's installation or revocation records. **Remove all data** deletes local data, not those records. To request their removal from n8n's service, use **Send feedback**; for a custom service, contact its operator.

:::caution
There's no button to clear only your chat history yet. **Remove all data** deletes it along with everything else.
:::

## Where this is enforced

[`src/server/memory-learning.ts`](https://github.com/n8n-io/nod/blob/main/src/server/memory-learning.ts) (memory sources) · [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts) (analytics opt-in and events) · [`src/server/traces.ts`](https://github.com/n8n-io/nod/blob/main/src/server/traces.ts) and [`src/server/personal-data.ts`](https://github.com/n8n-io/nod/blob/main/src/server/personal-data.ts) (trace opt-in and scrubbing) · [`src/web/lib/analytics-privacy.ts`](https://github.com/n8n-io/nod/blob/main/src/web/lib/analytics-privacy.ts) (recording masks) · [`src/server/bug-report.ts`](https://github.com/n8n-io/nod/blob/main/src/server/bug-report.ts) (report scrubbing)

## Related resources

- [Trust and Vault](/trust/)
- [Security review guide](/trust/security-review/)
- [Security model and limits](/trust/security-model/)
- [Memory](/use/memory/)
