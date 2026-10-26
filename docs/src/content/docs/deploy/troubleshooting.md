---
title: Troubleshooting
description: Fix common problems with a source install, the desktop app, model and app connections, channels and scheduled tasks.
sidebar:
  order: 5
---

This page lists common problems, why they happen and how to fix them. Headings match the error message where Nod shows one.

If your problem isn't here, [send feedback with a diagnostic report](#send-feedback-with-a-diagnostic-report).

## Install from source

### Use Node.js 24.21.0 or newer.

`pnpm start` checks your Node.js version first. Install Node.js 24.21.0 or newer, then run `pnpm start` again.

### Docker errors on start

Docker isn't running, or Compose is too old. Start Docker (on a Mac, open Docker Desktop) and check that `docker compose version` reports v2.

### Run npm run dev to prepare the local database

You ran `docker compose` yourself before Nod created the database password. Run `pnpm start` once. It generates `NOD_POSTGRES_PASSWORD` and starts the containers for you.

### Configure NOD_VAULT_KEY in server settings before saving a connection.

Nod has no key to encrypt saved credentials. Local macOS and Linux web installs normally create a protected key automatically. Other server configurations need an explicit key. If saved encrypted data exists, restore its original key instead of generating a new one. For a fresh server only, add a key to `.env`, then [apply the configuration](/deploy/configuration/#apply-configuration-changes).

```sh title="Terminal"
sed -i.bak "s|^NOD_VAULT_KEY=.*|NOD_VAULT_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
```

Keep a copy of the key somewhere safe. Saved credentials can't be read without it.

### The port is in use

Another program uses port `4310`. Set another `PORT` in `.env` and [apply the configuration](/deploy/configuration/#apply-configuration-changes). Update your browser address and any SSH tunnel to match. A direct source install also needs database port `54329` on `127.0.0.1`; the self-hosting stack keeps its database port private.

### You lost the access link

For a local source install without `NOD_AUTH_TOKEN`, Nod prints a link with `#access=` when it starts, and your browser keeps the cookie. To get a new link, delete `access-key` in your data folder (`.local/` by default) and restart. A server configured with `NOD_AUTH_TOKEN` prints its address without that link; use its configured token, or follow [Rotate access](/deploy/server-operations/#rotate-access).

## Desktop app

### macOS blocks the first launch

Every release is notarized by Apple. If macOS still blocks it, open **System Settings → Privacy & Security** and select **Open Anyway**. A managed Mac may need approval from your IT team.

### macOS asks for Keychain access after an update

macOS can ask again after Nod is re-signed. Approve it in the macOS dialog. Never type your Mac password into the Nod chat.

While the keychain unlocks, Nod keeps the startup screen and **Server connection** available. If it keeps waiting, check for a macOS prompt, unlock your keychain, then quit and reopen Nod.

### Nod could not unlock your saved server token

Select **Reconnect to server** and enter the same server address and `NOD_AUTH_TOKEN`. The app checks the connection before saving the token again in your computer's secure storage. If macOS asks for Keychain access, allow it there.

Your assistant, chats, files and connected accounts are on the server. Reconnecting keeps them and your separate local assistant. Do not delete your local profile or reset the server to fix this error.

On macOS, unlock your Mac keychain, then quit and reopen Nod. On Windows, sign in to the same Windows account that saved the token and retry. Your saved token stays in place.

### Not enough free space to install the runtime

On a Mac, the message says how much free space Nod needs and how much more to free. Nod needs room for the extracted runtime plus 512 MiB. Free that space, then retry. Your conversations and settings are kept.

On Windows, the message reads "Nod needs more free disk space to prepare its private computer." Allow at least 20 GB, then select **Try again**.

### Setup fails or stops partway

Retry first. Don't delete the profile, VM, database or runtime cache by hand to fix it. If it still fails, [send feedback](#send-feedback-with-a-diagnostic-report). If the chat can't open, send a screenshot of the setup error instead. When a setup command exits with an error, the message ends with the last lines it printed, which show the cause. When Nod can't connect to its local storage, the message names the connection error.

To start over, select **Remove all data…** in the **Nod** menu. Nod deletes your profile and private computer, then restarts and opens setup. See [Remove Nod](/get-started/install-desktop/#remove-nod) for what it keeps.

### Windows says WSL is missing

Select **Install WSL** in Nod, approve the administrator request, restart the PC and open Nod again. A device policy can block WSL installation.

## Models and apps

### Port 1455 is already in use

ChatGPT sign-in receives its callback on port 1455. Another Nod app or another sign-in is using it. Close it, then try again.

### An app connection fails

Return to **Apps** and select **Connect** again. Complete the authorization in the same browser tab; a copied, expired or already used link cannot finish a connection. If the system's encrypted storage is locked, unlock it and restart Nod.

If the connection service is unavailable or reports a limit, try again later. If the problem persists, [send feedback with a diagnostic report](/deploy/troubleshooting/#send-feedback-with-a-diagnostic-report).

## Channels

### WhatsApp Cloud API needs a public HTTPS callback

Meta's WhatsApp Cloud API delivers messages to a public HTTPS address. A local desktop assistant has no public callback, and the desktop app doesn't relay webhooks. Expose only the `/api/webhooks/whatsapp` route if you need that mode. The WhatsApp QR connection uses an outbound connection and does not need a public URL.

Telegram doesn't need one. Leave **Public HTTPS callback** blank and Nod receives Telegram messages locally.

### This Telegram bot already uses a webhook

The bot was set up with a webhook elsewhere. Remove that webhook to use local polling, or enter a public URL in **Public HTTPS callback** to have Nod use a webhook.

## Tasks and actions

### A scheduled task didn't run

For a local desktop assistant, scheduled tasks run only while Nod is open and your computer is awake. Closing the window keeps Nod running in the menu bar or tray, but **Quit Nod** stops it. Turn on **Open at login** in **Settings → General** if you rely on schedules. For a remote assistant, check that the server is running; closing a desktop client does not stop its schedules.

### An action shows as uncertain

An action Nod started failed or was interrupted, so Nod can't tell whether it ran. Nod never runs it again on its own. For a sign-in or payment, **Usage** shows "Result unknown".

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Running: approved
  Running --> Done: result known
  Running --> Uncertain: failed or interrupted
  Uncertain --> Checked: Nod checks the result
```

Ask Nod to check the result in the app or website before you try again. See [One use, one result](/trust/outcomes/).

## Get help

### Send feedback with a diagnostic report

Select **Send feedback** in the chat. In the desktop app, it's also in the menu bar menu. The dialog names the recipient before you send: the Nod team at n8n by default, or your operator's configured collector.

If the workspace crashes, use **Send feedback** on the error screen before **Reload Nod** to include the captured error.

Choose a feedback category and describe what happened. Include what you expected, what actually happened, and the steps that trigger the problem. **Include diagnostic report** starts selected for every category until you change it. Nod remembers your choice for your account on this device after sending or discarding a draft.

Select **Review** to inspect the exact attachment, or untick the checkbox to omit it. The report masks known secrets and recognized personal details, but can miss information. If preparation fails, select **Continue without report**. Your Nod runtime prepares the report from recent messages, logs, and app activity. Only **Send feedback** sends it to the configured feedback recipient.

A new desktop draft includes a screenshot when capture is available. Private screens, embedded browsers, open dialogs, and unsent text or files prevent capture. Review, annotate, or remove the screenshot before sending. Check your feedback text and attachments for personal information. Never add API keys, passwords, or your settings file.

To report a bug, use the [bug report form](https://github.com/n8n-io/nod/issues/new/choose). Report a vulnerability privately, as the [security policy](https://github.com/n8n-io/nod/blob/main/SECURITY.md) describes.

### Report contents and limits

The `nod-feedback-report-v3` JSON attachment connects the steps before a failure with the affected chat, agent work, app usage, and connections. It helps with support, debugging, and product improvement. It combines technical metadata with recent content after best-effort redaction.

| Section                 | What it shows                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Runtime                 | App version, release, platform, known model provider, and model family.                                                   |
| Chat                    | Recent user and assistant message text, roles, character and attachment counts, and reply metadata.                       |
| Turns and agent work    | Request source, channel, outcome, waiting state, queue and run duration, tool category, and parent-child relationships.   |
| Model usage             | Request outcomes, duration, token counts, recorded cost and estimates, and known model categories.                        |
| Tasks and schedules     | State, progress counts, enabled state, overdue work, and recent run and failure counts.                                   |
| Connections             | Managed app, browser, direct connection, and model connection state, plus reconnect and event-delivery health.            |
| Channels                | Receiving and delivery states, with a permitted failure reason.                                                           |
| Runtime logs            | Recent tool inputs and results, application and background failures, error messages and stacks, and connection activity.  |
| App activity and errors | Recent screen categories, API failure categories and status codes, UI errors, and captured app error messages and stacks. |

Database activity covers the latest 24 hours for your account across its conversations and background work. Each database section includes at most 200 entries, or 400 for agent execution events. Connection and schedule sections show current state. Report-local labels preserve execution relationships without exporting their original IDs. Activity uses relative ages and durations.

The runtime journal uses three rotating files of at most 1 MiB each in Nod's private data folder. Data is redacted before it is written and again when it is exported. Reports include up to 200 journal entries from the latest 24 hours. An entry larger than 64 KiB is replaced with an omission marker. Expired records are removed on startup, report preparation, subsequent journal writes, and a one-minute cleanup timer. Files can remain while Nod is stopped. Dropped entries and unavailable journal data are identified in the report.

The separate app activity buffer holds up to 100 recent entries for 30 minutes in the current runtime and app window. The app window also keeps up to 10 recent error messages and stacks for 30 minutes. These buffers don't depend on usage analytics being enabled. Closing the app window or restarting the runtime clears that source's buffer. Dropped or expired activity entries aren't marked. Activity categories contain no raw request URLs or response bodies. App error messages and stacks reach the runtime for redaction when a report is prepared and aren't written to its journal. After an account change, error capture pauses until the app window reloads, and the report marks that source unavailable.

The redactor omits individual strings longer than 32,000 characters before scanning them. Database reads separately omit message and error text larger than 64 KiB. App error messages and stacks each have an 8,192-character capture limit. Structured values also have depth, entry-count, and size limits. These limits can remove details from long messages and tool results.

The report includes a coverage record for each database section and the runtime journal: collection status, entry count, and omitted-entry indicators. These markers do not count entries dropped or expired from the app activity and error buffers. The final attachment is capped at 512 KiB. Older entries are removed if needed, and their sections mark that truncation. An empty or incomplete section doesn't prove that no problem occurred.

The report excludes credential fields, screenshots, binary data, system prompts, and model thinking. Text returned by a file, browser, or app tool can be included after redaction. Redaction can miss personal details, so review the complete attachment and leave it out if needed. A report also cannot recover details outside its time or size limits.

The report setting does not enable [usage analytics or conversation traces](/trust/privacy/).

## Related resources

- [Configuration reference](/deploy/configuration/)
- [Desktop app internals](/deploy/desktop-app/)
- [Install from source](/get-started/install-from-source/)
- [Install the desktop app](/get-started/install-desktop/)
