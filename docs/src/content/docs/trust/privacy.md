---
title: Your data and privacy
description: What Nod shares with n8n, with an example, where your data lives, and how to delete it.
sidebar:
  order: 11
---

Nod keeps your data on your computer, or on your server if you self-host. This page shows what Nod sends to n8n and other services, and how to delete your data.

## At a glance

- **Usage sharing starts on for new owners.** Existing owners keep their saved choice. It sends feature use, task types, failures, fixed **About you** choices and survey answers to n8n. Survey answers are sent as entered and may contain personal details. Browser details, screen sizes, and analytics session and window IDs are included. Chat messages, saved memory, screen recordings and session replays stay out of usage data. Your email needs separate consent to updates. You can turn sharing off in **Settings → Privacy & data**.
- **Conversation traces start off for new owners.** Existing owners keep their saved choice. If you turn them on with n8n's default trace service, the Nod team can review your conversations and app results. A custom trace service sends them to its operator. Nod removes personal details it recognizes before sending them. Traces can still identify you. n8n's default trace service keeps them for 14 days and never uses them to train AI models. Custom trace services use their operator's storage and retention rules. See [what each switch shares](#what-each-switch-shares).
- **Connected services process content.** Your model services receive the conversation and what Nod reads for your work. By default, managed app calls pass through n8n's connection service and Composio. This includes email content when Nod reads or sends mail through a managed Gmail connection. Connecting an account grants access; the [trust check](/trust/approvals/) controls each app action.
- **Zero Data Retention has a defined scope.** When Composio ZDR is on for the project, covered calls keep request arguments, response data and error text out of execution logs. Calls through Composio Managed OAuth apps also need Enterprise for this coverage. Composio still processes the call and keeps metadata. Tool search queries, files and trigger events have separate rules. Composio can cache tool search queries to improve results, as its [ZDR scope](https://docs.composio.dev/docs/security/zero-data-retention#what-zdr-does-not-cover) explains. See [Composio Zero Data Retention](#composio-zero-data-retention) for Nod's default service.
- **Storage location depends on the service.** n8n's default services store usage data and traces in the EU. With usage sharing on and your consent to updates, n8n's default services link your email address and consent record to usage data in EU PostHog. The default signup service also sends the address and signup data to Customer.io in the US. The signup also includes fixed **About you** choices only if you shared them successfully. A failed signup can leave data in either service. Other services use their own storage and retention rules. Turning a switch off stops new sends for that setting. A send already in progress can finish. [Request deletion](#what-each-switch-shares) for data sent to n8n. For data sent to a custom trace service, contact its operator.
- **Saved passwords and cards are in Vault.** They are encrypted on the computer or server that runs Nod. A login selected from 1Password is copied to Vault. Nod can fill secret values on a website for a sign-in or payment you allow. Saved logins fill only on their saved origin, or the matching root or `www` host with the same protocol and port. See [website matching](/trust/vault/#website-matching). Tools that fill saved values do not return them to the model. Private content visible in screenshots can still reach your model services. See [how Vault stores secrets](/trust/vault/#how-vault-stores-secrets).

## What Nod shares with n8n

Nod can share two kinds of data with the Nod team at n8n. Both help the team find where Nod gets stuck.

- **Usage data** is on by default. It records the screens and features you use, and your onboarding and survey answers. Onboarding answers are your fixed About you choices, never what you type under **Something else**. They also appear on a PostHog profile tied to a pseudonymous analytics ID so the team can filter events by those answers. It excludes your messages to Nod and Nod's replies. If you give your email in onboarding and tick its consent box, it is linked to the same profile.
- **Conversation traces** are off by default. They include the conversation, with personal details removed on your computer first.

### Example: one request

Say your name is Marta Puig, and you send Nod this message:

> Reply to Jordi's email about invoice 2026-114. Say I paid it today and he can call me on 612 345 678.

Nod reads Jordi's email in Gmail and sends your reply. Here's what n8n receives.

**Usage data** is a list of events with counts, timings, and costs. No event contains your message, Jordi's email, or the reply:

```text title="Usage data (shortened)"
turn_started      channel: web, work_type: immediate, owner_requested: true
tool_used         tool: apps, outcome: succeeded, duration_ms: 1840
service_used      app: gmail, connection_method: managed_app, outcome: succeeded
model_used        provider: anthropic, model: claude-sonnet-5-5,
                  input_tokens: 5210, output_tokens: 180, cost_usd: 0.02
turn_completed    outcome: succeeded, duration_ms: 9800
task_classified   task_type: communication
```

Each event also carries a pseudonymous analytics ID. Nod includes its release version or source revision when available. The task label comes from a small model on your own model connection. Only the label, here `communication`, reaches n8n. When you submit About you while sharing usage, Nod stores its fixed choices on a PostHog person profile under that analytics ID. The team can filter later events by those choices and use PostHog's current person properties to filter earlier events. If you give your email in onboarding and tick its consent box, the address joins that profile.

**A conversation trace** includes the conversation. Nod replaces the personal details it recognizes before the trace leaves your computer. This is the scrubber's real output for this request:

```text title="Conversation trace"
You:    Reply to Jordi's email about invoice 2026-114. Say I paid it today
        and he can call me on [phone].

Gmail:  From: [name] <[email]>
        Hi [owner], invoice 2026-114 is still open. Please pay to [iban].

Nod:    Sends to [email]:
        Hi Jordi, I paid invoice 2026-114 today. Call me on [phone] if
        anything is missing. [owner]
```

The trace also includes Nod's instructions, the model name, token counts, cost, and fixed error classes. For a saved chat, task, or background session, its pseudonymous conversation ID stays the same across idle gaps, days, and restarts. This ID links traces from that saved session over time. Nod keeps its private hashing key in the runtime profile. If that key cannot load, Nod uses a temporary key and conversation IDs change on restart. Work without a saved session gets a new auxiliary ID for each job.

Traces carry the same analytics ID as usage analytics, even when usage sharing is off. This ID stays the same across conversations, days, and restarts. It links traces from the same runtime profile. This ID can link traces to earlier usage data, About you choices, and an email submitted for updates. Server usage events and traces also share pseudonymous conversation and work IDs. One work ID is a request, schedule fire, background batch, or continuation, not a user-message count.

"Jordi" is still there. Nod spots details by their shape, such as email addresses, phone numbers, and bank accounts. It also knows your name from your connected accounts. It can't spot every name in a sentence, so traces are pseudonymised, not anonymous.

### What each switch shares

|            | Usage data                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default    | On                                                                                                                                                                                                                                           |
| Includes   | Screens and features you use, kinds of tasks, timings, costs, failures, basic device details such as browser, OS, screen and viewport size, pseudonymous session, window, conversation, and turn IDs, and your onboarding and survey answers |
| Excludes   | Your messages to Nod, Nod's replies, what Nod reads, saved passwords and cards, and screen recordings or session replays. Survey answers may contain personal details because Nod sends them as typed                                        |
| Your email | If you submit it in onboarding with consent to updates and usage sharing on, it is linked to your usage data. Unsubscribe via the link in each email. To unlink or delete it, write to privacy@n8n.io.                                       |
| Stored in  | n8n's PostHog project in the EU. A consented signup also sends the email address and any successfully shared fixed About you choices to n8n's Customer.io Labs workspace in the US.                                                          |
| Switch     | **Share usage data**                                                                                                                                                                                                                         |
| Details    | [Analytics](/deploy/analytics/)                                                                                                                                                                                                              |

|           | Conversation traces                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default   | Off                                                                                                                                                                                                     |
| Includes  | Your conversations with Nod, including what it reads and does, minus recognized personal details; the analytics ID and pseudonymous conversation and turn IDs                                           |
| Redaction | Nod masks known secret values of at least eight characters, known secret formats and recognized personal details. Short secrets and other private content, including account or device IDs, can remain. |
| Stored in | n8n's LangSmith project in the EU for 14 days. Never used to train AI models.                                                                                                                           |
| Switch    | **Share conversation traces**                                                                                                                                                                           |
| Details   | [Conversation traces](/trust/conversation-traces/)                                                                                                                                                      |

Nod replaces turn and run IDs in traces with keyed hashes. Repeated hashes can link traces within the same runtime and UTC day. Other content can also identify you. See [trace privacy limits](/trust/conversation-traces/#how-traces-are-pseudonymised).

Both switches are in **Settings → Privacy & data**. Turning one off stops subsequent sends, though a send already in flight may finish. It does not delete data already sent, including About you answers and a consented email. To request deletion, write to privacy@n8n.io. A server operator can turn either switch off for everyone.

On a fresh packaged desktop profile, the default-on usage setting can send the first native setup-window open before you reach this switch. Turning sharing off later stops new sends but cannot recall that opening event.

Select **How Nod uses your data** next to the **Privacy & data** heading to see this summary in Nod.

## Where your data lives

|                 | Desktop app                                                                                                                                                                                          | Source install                     | Self-hosted server                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| Runs on         | A private virtual machine on your computer                                                                                                                                                           | Docker containers on your computer | Your server                        |
| Data folder     | Mac: `~/Library/Application Support/nod/` and `~/.nod-desktop/`. Windows: `%APPDATA%\nod\` and the `nod-` WSL distribution. Linux Flatpak: `~/.var/app/io.n8n.Nod/config/nod/` and `~/.nod-desktop/` | `.local/` and Docker volumes       | Docker volumes and its `.env` file |
| Who can read it | You                                                                                                                                                                                                  | You                                | Anyone who administers the server  |

For what Nod stores and for how long, see the [Security review guide](/trust/security-review/#what-nod-stores).

## What Nod sends to other services

| Service                             | What it receives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your model services                 | Your conversation, what Nod reads for you, including app windows it reads with [computer use](/connect/computer-use/), and screenshots, including pictures of app windows. To write and check a confirmation question, the action Nod proposes, its arguments, target details (for computer use, the app, window and control labels and current accessible window content), task or schedule context, your recent messages for their language, and for a browser step the page's visible text. Image reading and [trust checks](/connect/models/#decision-checks) can use another service you connected. |
| Decision services, if you add them  | Each action Nod checks, with your messages and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The apps you connect                | The actions Nod runs in them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Composio and the connection service | Your app connections and the actions Nod sends. n8n hosts the [default service](/deploy/configuration/#apps-and-composio). A server or source install can [use its own OpenConnector](/deploy/configuration/#use-your-own-openconnector) instead, and then neither receives them.                                                                                                                                                                                                                                                                                                                        |
| Telegram and WhatsApp               | The messages in those chats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Websites                            | What Nod browses, fills in, or submits. Nod also fetches the icons of your apps and logins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Search provider                     | Built-in web searches. Exa is the default. A selected ChatGPT plan can use OpenAI search instead. Server search settings can select another service.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Google Flights                      | Flight searches: airports, dates, traveller counts, cabin, stop limit, currency and language. The Nod server sends them from your network, without a Google account.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Your voice service                  | [Voice messages](/use/channels/#files-and-voice-messages) you send, and the text of voice replies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| n8n                                 | Desktop update checks, which show your IP address, app version, and platform. Usage data, traces, and feedback, if you allow them. A consented onboarding email and fixed About you choices pass through an internal n8n workflow while usage sharing is on.                                                                                                                                                                                                                                                                                                                                             |
| Customer.io                         | An unverified onboarding email signup, the checkbox claim and receipt time, and fixed About you choices. n8n uses its Labs workspace in the US. Typed **Something else** answers do not go there.                                                                                                                                                                                                                                                                                                                                                                                                        |

Model keys Nod saves are encrypted at rest. Keys you set in a shell or `.env` file use that configuration's storage protections. Nod does not add model keys to prompts, its workspace or its browser.

### Composio Zero Data Retention

**Nod's default app connection service uses Composio with Zero Data Retention (ZDR) enabled.** For covered calls, Composio does not write request arguments, response data, or error text to its execution logs. It still stores call metadata, such as the tool name, time, and status. It also stores the access tokens needed to keep your apps connected.

ZDR covers eligible tool calls and proxy requests. Files, trigger events, and tool-search queries have separate retention rules. Composio removes staged upload and download files after 24 hours. Nod disables Composio's session sandbox. Model services, destination apps, and Nod's local data follow their own rules.

ZDR applies to new covered calls and does not delete older logs. Calls through Composio Managed OAuth apps require Enterprise for ZDR coverage. See [Composio's ZDR coverage](https://docs.composio.dev/docs/security/zero-data-retention) for the full scope.

The default connection service's policy applies to desktop and self-hosted Nod. ZDR coverage follows that service's project and plan, not where Nod runs. A custom connection service has its own settings. Ask its operator to confirm the current coverage.

ZDR does not limit the permissions you grant to an app. Nod's [trust check](/trust/approvals/) checks each app action against your words. If you use another connection service, its operator controls the Composio project and retention settings.

For the other controls, see [How Nod protects app connections](/connect/apps/#how-nod-protects-app-connections).

## Built-in web search and retention

Nod runs built-in web search through its Pi web extension in the Nod server, outside the workspace. With the default search configuration, it uses Exa. A selected ChatGPT plan can use OpenAI search instead. A server operator can configure another supported search provider.

The search provider receives the query and search options. Without an Exa key, the extension uses Exa's public MCP service. With an Exa key, it uses the Exa API. Fetching a result page also contacts that website. These web requests do not pass through Nod's managed app connection service or Composio.

Search data can be kept in several places:

| Place                        | What can be kept                                                                        | Retention                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your Nod runtime             | Search queries and results in saved session transcripts and turn logs                   | No automatic expiry. See [local storage](/trust/security-review/#what-nod-stores).                                                                      |
| Local page cache             | Fetched page content                                                                    | One-hour cache validity. Cleanup runs when the extension uses the cache, so expired files can remain until then. Saved session and turn records remain. |
| Usage analytics              | Tool names, timings and bounded technical values                                        | Query text and results stay out. See [Analytics](/deploy/analytics/).                                                                                   |
| Conversation traces, when on | Queries and results included in model requests and replies, after best-effort redaction | The default trace service keeps traces for 14 days. Custom services set their own rules.                                                                |
| Search provider and websites | Queries, search options, requests and returned content                                  | Their own terms apply. Composio ZDR does not cover them.                                                                                                |

Exa offers [Zero Data Retention](https://exa.ai/docs/admin/security/zero-data-retention) on Enterprise plans, enabled per team. Nod does not enable or verify Exa ZDR. Use of Exa's public MCP service does not establish that your searches have ZDR coverage. Nod does not promise a fixed storage period or region for that service. For an Exa API key or another search provider, check the account's current agreement and settings.

These rules apply to desktop and self-hosted Nod. Self-hosting keeps Nod's local records on your server; it does not make outside search requests local.

## Feedback

A report sent with **Report bug** goes to the recipient the dialog names, which is the Nod team at n8n by default. It includes a diagnostic report unless you untick it. The report can include recent messages and tool results, with known secrets and recognized personal details masked. It also includes technical details about your setup: operating system version, memory, time zone, the selected model, settings such as quiet hours and spending limits, recent failures, and the desktop startup and update log. Select **Review** to check it before you send. On desktop, the draft also includes a screenshot of the Nod window, which you can remove.

A bug report Nod drafts in chat sends Nod's written summary as you see it, without masking, plus the app version and platform. From the card in Nod it also sends the diagnostic report unless you untick it, and you can review it first. A reply in Telegram or WhatsApp sends the summary and those technical details, without the diagnostic report. Nothing goes until you select **Send report** or reply to send it.

Your Nod runtime redacts the report before it goes to the recipient the dialog names. It masks the names, addresses, account identifiers, file paths and links it recognizes, and keeps technical values such as versions, error types and status codes. Redaction can miss personal details, so review the report before you send it.

Nod checks the original text and field names before it masks them. It omits encoded or structured text when it cannot keep that text safe.

See [Report contents and limits](/deploy/troubleshooting/#report-contents-and-limits).

## Email updates

The last onboarding step lets you leave your email address for updates about Nod and other n8n products. Its consent checkbox starts unchecked. Ticking it means you agree that n8n GmbH links your email to your Nod usage data and emails you about Nod and other n8n products, including invitations to research. A line under the box says how to unsubscribe and how to unlink your email from your usage data.

Nod sends the address only when you enter it, tick that box, and select **Start chatting**, or **Continue** in the desktop app, while **Share usage data** is on and the contact workflow is configured. It stores the address as the `email` property on this installation's PostHog person profile, with the consent flag, time, version, exact checkbox wording, and privacy policy link. An internal n8n workflow creates or updates an unverified Customer.io Labs profile with the address, consent flag, receipt time, version, exact checkbox wording, and privacy policy link. Customer.io also receives the fixed About you choices if you shared them successfully. Neither service receives words typed under **Something else**.

The checkbox controls the email, not the fixed About you answers. Ordinary usage events do not carry the address. If you leave the address blank or sharing is off, Nod does not send it.

Submitting the form sends no email immediately. Updates require a later email confirmation flow before they are sent. If submission fails partway through, your address may already be in PostHog or Customer.io; you can retry or request deletion. After updates begin, the unsubscribe link in each email stops future emails; it does not unlink your address from usage data. To unlink your address or request deletion of stored answers and contact data, write to privacy@n8n.io. Turning off **Share usage data** stops new analytics and profile updates, but a submission already in flight may still finish. It does not delete data already in PostHog or Customer.io. See n8n's [privacy policy](https://n8n.io/legal/privacy/).

## What memory learns from

Memory notes come only from your own messages, your answers in setup's About you step, and the notes you add. Nod never learns them from its replies, websites, or app data. When you connect Gmail, Nod also reads your recent sent email to learn your writing style, without facts or names. See [Memory](/use/memory/).

## Delete your data

- **A memory:** open **Settings → Memory**, select the note, and choose **Forget**. You can also ask Nod to forget something.
- **A Vault item:** open it in **Vault** and delete it. For a saved browser session, select **Sign out**.
- **An app:** disconnect it in **Apps**.
- **Everything in the desktop app:** select **Remove all data** in **Settings → Privacy & data**. Nod deletes your profile, its private computer, and unsent drafts, then opens setup again. The app stays installed, and no server data is deleted.
- **A source install or server:** stop it, then remove its data folder and Docker volumes. See [Server operations](/deploy/server-operations/).

Uninstalling the desktop app keeps its data. A connected service may still list Nod until you remove it there. To remove n8n's connection service records, write to privacy@n8n.io.

:::caution
You can't clear only your chat history yet. **Remove all data** deletes it along with everything else.
:::

## Where this is enforced

[`src/server/traces.ts`](https://github.com/n8n-io/nod/blob/main/src/server/traces.ts) and [`src/server/personal-data.ts`](https://github.com/n8n-io/nod/blob/main/src/server/personal-data.ts) (traces) · [`src/server/analytics.ts`](https://github.com/n8n-io/nod/blob/main/src/server/analytics.ts) (usage data) · [`src/server/memory-learning.ts`](https://github.com/n8n-io/nod/blob/main/src/server/memory-learning.ts) (memory) · [`src/server/feedback-redaction.ts`](https://github.com/n8n-io/nod/blob/main/src/server/feedback-redaction.ts) (feedback reports)

## Related resources

- [Trust and Vault](/trust/)
- [Conversation traces](/trust/conversation-traces/)
- [Security review guide](/trust/security-review/)
- [Security model and limits](/trust/security-model/)
- [n8n privacy policy](https://n8n.io/legal/privacy/)
- [Nod Terms of Use](https://n8n.io/legal/nod-terms-of-use/)
