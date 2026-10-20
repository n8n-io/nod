---
title: Troubleshooting
description: Fix common problems with a source install, the desktop app, model and app connections, channels and scheduled tasks.
sidebar:
  order: 5
---

This page lists common problems, why they happen and how to fix them. Headings match the error message where Otto shows one.

If your problem isn't here, [send feedback with a diagnostic report](#send-feedback-with-a-diagnostic-report).

## Install from source

### Use Node.js 24.21.0 or newer.

`pnpm start` checks your Node.js version first. Install Node.js 24.21.0 or newer, then run `pnpm start` again.

### Docker errors on start

Docker isn't running, or Compose is too old. Start Docker (on a Mac, open Docker Desktop) and check that `docker compose version` reports v2.

### Run npm run dev to prepare the local database

You ran `docker compose` yourself before Otto created the database password. Run `pnpm start` once. It generates `OTTO_POSTGRES_PASSWORD` and starts the containers for you.

### Configure OTTO_VAULT_KEY in server settings before saving a connection.

Otto has no key to encrypt saved credentials. Local macOS and Linux web installs normally create a protected key automatically. Other server configurations need an explicit key. If saved encrypted data exists, restore its original key instead of generating a new one. For a fresh server only, add a key to `.env`, then restart Otto.

```sh title="Terminal"
sed -i.bak "s|^OTTO_VAULT_KEY=.*|OTTO_VAULT_KEY=$(openssl rand -base64 32)|" .env && rm .env.bak
```

Keep a copy of the key somewhere safe. Saved credentials can't be read without it.

### Missing modules after git pull

The update changed dependencies. Run `pnpm install --frozen-lockfile`, then `pnpm start`.

### The port is in use

Another program uses port `4310`. Set another `PORT` in `.env` and restart. Otto's database container also needs port `54329` on `127.0.0.1`.

### You lost the access link

Otto prints a link with `#access=` when it starts, and your browser keeps the cookie. To get a new link, delete `access-key` in your data folder (`.local/` by default) and restart.

## Desktop app

### macOS blocks the first launch

Install the newest release, which Apple notarizes. Builds 0.1.12 and earlier aren't notarized: open **System Settings → Privacy & Security** and select **Open Anyway**. A managed Mac may need approval from your IT team.

### Otto 0.1.12 or earlier doesn't update

Those builds were signed with an internal certificate, so macOS refuses an update signed with n8n's Developer ID. Download the newest release and replace Otto in Applications, or run the Terminal installer. Your data is kept.

### macOS asks for Keychain access after an update

macOS can ask again after Otto is re-signed. Approve it in the macOS dialog. Never type your Mac password into the Otto chat.

### Not enough free space to install the runtime

On a Mac, the message says how much free space Otto needs and how much more to free. Otto needs room for the extracted runtime plus 512 MiB, and for the archive while it downloads. Free that space, then retry. Your conversations and settings are kept.

On Windows, the message reads "Otto needs more free disk space to prepare its private computer." Allow at least 20 GB, then select **Try again**.

### Setup fails or stops partway

Retry first. Don't delete the profile, VM, database or runtime cache to fix it. If it still fails, [send feedback](#send-feedback-with-a-diagnostic-report). If the chat can't open, send the setup error you see instead.

### Windows says WSL is missing

Select **Install WSL** in Otto, approve the administrator request, restart the PC and open Otto again. A device policy can block WSL installation.

## Models and apps

### Port 1455 is already in use

ChatGPT sign-in receives its callback on port 1455. Another Otto app or another sign-in is using it. Close it, then try again.

### Composio says "Invalid API key"

If you use your own Composio key, a valid key without the right permissions can show this error. Composio's [permission troubleshooting](https://docs.composio.dev/kb/guide/platform-project-api-key-permissions) explains why. Saving a key in Otto doesn't verify every permission needed to connect Gmail.

For Gmail sign-in, check **Auth configs → Read only** and **Session management → Read and write**. Keep the other permissions listed in [Apps](/connect/apps/), including **Connected accounts** and **Session tool execution**.

You can't edit a key's permissions. Create a replacement in the same Composio project and save it in **Settings → App connections → My Composio key**. If your server sets `COMPOSIO_API_KEY`, replace the environment value and restart Otto. Then select **Connect Gmail** again. Your existing connected accounts belong to that project.

Otto's connection doesn't need a personal Composio key. If the error persists there, [send feedback](/deploy/troubleshooting/#send-feedback-with-a-diagnostic-report).

### Apps disconnected after switching connection

Switching between Otto's connection and your own Composio key disconnects the apps connected through the one you left, because their accounts belong to that project. Connect them again in **Apps**.

If Otto says it couldn't disconnect an app, it kept your current connection. Apps it disconnected before that stay disconnected, so connect them again if you don't switch. Check your network and try again.

## Channels

### WhatsApp needs a public HTTPS callback

Meta delivers WhatsApp messages to a public HTTPS address. Otto on your computer has none, and the desktop app doesn't relay webhooks. Expose only the `/api/webhooks/whatsapp` route and keep the rest of Otto private.

Telegram doesn't need one. Leave **Public HTTPS callback** blank and Otto receives Telegram messages locally.

### This Telegram bot already uses a webhook

The bot was set up with a webhook elsewhere. Remove that webhook to use local polling, or enter a public URL in **Public HTTPS callback** to have Otto use a webhook.

## Tasks and actions

### A scheduled task didn't run

Scheduled tasks run only while Otto is open and your computer is awake. Closing the window keeps Otto running in the menu bar or tray, but **Quit Otto** stops it. Turn on **Open at login** in **Settings → General** if you rely on schedules.

### An action shows as uncertain

An action Otto started failed or was interrupted, so Otto can't tell whether it ran. Otto never runs it again on its own. For a sign-in or payment, **Trust → Activity** shows "Result unknown".

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Running: approved
  Running --> Done: result known
  Running --> Uncertain: failed or interrupted
  Uncertain --> Checked: Otto checks the result
```

Ask Otto to check the result in the app or website before you try again. See [One use, one result](/trust/outcomes/).

## Get help

### Send feedback with a diagnostic report

Select **Send feedback** in the chat. In the desktop app, it's also in the menu bar menu. The dialog names the recipient before you send: the Otto team at n8n by default, or your operator's configured collector.

By default it includes a diagnostic report of your recent chat, actions and their results. Review it, or clear **Include diagnostic report** before you send. Never add API keys, passwords or your settings file.

To report a bug, use the [bug report form](https://github.com/n8n-io/otto/issues/new/choose). Report a vulnerability privately, as the [security policy](https://github.com/n8n-io/otto/blob/main/SECURITY.md) describes.

## Related resources

- [Configuration reference](/deploy/configuration/)
- [Desktop app internals](/deploy/desktop-app/)
- [Install from source](/get-started/install-from-source/)
- [Install the desktop app](/get-started/install-desktop/)
